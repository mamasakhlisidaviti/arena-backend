import { randomBytes } from 'node:crypto';
import mongoose, { Types, type ClientSession } from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { escapeRegex } from '../../common/regex.js';
import type { IUser } from '../users/user.model.js';
import type { LocalizedString } from '../../common/localized.js';
import { GameCategory, type GameCategoryDocument } from '../categories/category.model.js';
import { getGameModule } from '../tournaments/games/chess.js';
import { registrationPrefixFor } from '../tournaments/tournament.service.js';
import { PUBLIC_STATUSES, Tournament, type ITournament } from '../tournaments/tournament.model.js';
import { Notification, type NotificationType } from '../notifications/notification.model.js';
import {
  Registration,
  SEAT_HOLDING_STATUSES,
  type IRegistration,
  type ParticipantInformation,
  type RegistrationStatus,
  type RegistrationDocument,
} from './registration.model.js';
import type {
  RegistrationInput,
  RegistrationListQuery,
  StatusUpdateInput,
} from './registration.validation.js';

const CORE_FIELD_KEYS = new Set(['firstName', 'lastName', 'email', 'phone', 'fideId', 'rating', 'club', 'notes']);

export interface RegistrationActorContext {
  user?: IUser;
  manualBy?: IUser;
}

function isAdminActor(actor?: IUser): boolean {
  return actor?.role === 'admin' || actor?.role === 'super_admin';
}

function assertCanManage(actor: IUser, organizerId: unknown): void {
  if (actor.role === 'super_admin') {
    return;
  }
  if (actor.role !== 'admin' || String(organizerId) !== String(actor._id)) {
    throw ApiError.forbidden();
  }
}

const PARTICIPANT_FIELDS = 'tournamentId userId participantInformation status registrationNumber createdAt updatedAt';

function participantRegistration(registration: RegistrationDocument) {
  const data = registration.toJSON();
  return {
    id: String(registration._id),
    tournamentId: data.tournamentId,
    userId: data.userId,
    participantInformation: data.participantInformation,
    status: data.status,
    registrationNumber: data.registrationNumber,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

async function registrationTransaction<T>(callback: (session: ClientSession) => Promise<T>): Promise<T> {
  try {
    return await mongoose.connection.transaction(callback, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
  } catch (error) {
    // Translate only after the transaction has rolled back its seat and notification writes.
    if ((error as { code?: number })?.code === 11000) {
      throw ApiError.conflict('DUPLICATE_REGISTRATION', 'This email is already registered for the tournament');
    }
    throw error;
  }
}

async function loadTournamentForTransition(tournamentId: string | Types.ObjectId, session: ClientSession) {
  // A real transactional write also serializes waitlisting and transitions that keep
  // the same seat count. Concurrent settings/ownership changes force a fresh retry.
  const tournament = await Tournament.findOneAndUpdate(
    { _id: tournamentId },
    { $inc: { __v: 1 } },
    { new: true, session },
  );
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  return tournament;
}

function assertAcceptingRegistrations(tournament: ITournament, isManual: boolean): void {
  if (isManual) {
    if (tournament.status === 'cancelled' || tournament.status === 'completed') {
      throw ApiError.conflict('REGISTRATION_CLOSED', 'This tournament no longer accepts registrations');
    }
  } else {
    if (!PUBLIC_STATUSES.includes(tournament.status) || tournament.status === 'completed' || !tournament.publishedAt) {
      throw ApiError.conflict('REGISTRATION_CLOSED', 'This tournament is not accepting registrations');
    }
    if (tournament.registrationDeadline.getTime() <= Date.now()) {
      throw ApiError.conflict('REGISTRATION_CLOSED', 'Registration is closed for this tournament');
    }
  }
}

function validateConfiguredFields(category: GameCategoryDocument, info: ParticipantInformation): void {
  const missing: { path: string; message: string }[] = [];
  for (const field of category.registrationFields ?? []) {
    if (!field.enabled) {
      continue;
    }
    if (CORE_FIELD_KEYS.has(field.key)) {
      if (field.required) {
        const value = (info as unknown as Record<string, unknown>)[field.key];
        if (value === undefined || value === null || String(value).trim() === '') {
          missing.push({ path: field.key, message: `${field.key} is required` });
        }
      }
      continue;
    }
    if (field.required && !String(info.customFields?.[field.key] ?? '').trim()) {
      missing.push({ path: `customFields.${field.key}`, message: `${field.key} is required` });
    }
  }
  if (missing.length > 0) {
    throw ApiError.unprocessable('Required registration fields are missing', missing);
  }
}

async function reserveSeat(tournament: ITournament, session: ClientSession, isManual: boolean): Promise<boolean> {
  assertAcceptingRegistrations(tournament, isManual);
  const updated = await Tournament.findOneAndUpdate(
    {
      _id: tournament._id,
      status: isManual ? { $nin: ['cancelled', 'completed'] } : { $in: ['published', 'ongoing'] },
      ...(!isManual ? { registrationDeadline: { $gt: new Date() }, publishedAt: { $ne: null } } : {}),
      $expr: { $lt: ['$currentParticipants', '$participantLimit'] },
    },
    { $inc: { currentParticipants: 1 } },
    { new: true, session },
  );
  if (!updated) {
    // Do not turn an expired deadline into a waitlist placement.
    assertAcceptingRegistrations(tournament, isManual);
  }
  return Boolean(updated);
}

async function releaseSeat(tournamentId: Types.ObjectId, session: ClientSession): Promise<void> {
  const result = await Tournament.updateOne(
    { _id: tournamentId, currentParticipants: { $gt: 0 } },
    { $inc: { currentParticipants: -1 } },
    { session },
  );
  if (result.matchedCount !== 1) {
    throw ApiError.conflict('SEAT_COUNT_MISMATCH', 'Tournament participant count is inconsistent');
  }
}

async function notify(
  registration: IRegistration,
  tournamentTitle: LocalizedString,
  tournamentSlug: string,
  status: RegistrationStatus,
  session: ClientSession,
): Promise<void> {
  const typeByStatus: Record<RegistrationStatus, NotificationType> = {
    pending: 'registration_created',
    approved: 'registration_approved',
    rejected: 'registration_rejected',
    waitlisted: 'registration_waitlisted',
    cancelled: 'registration_cancelled',
  };
  await Notification.create([{
    userId: registration.userId ?? null,
    email: registration.participantInformation.email,
    type: typeByStatus[status],
    data: {
      tournamentId: String(registration.tournamentId),
      tournamentSlug,
      tournamentTitle,
      registrationNumber: registration.registrationNumber,
      registrationId: String(registration._id),
      status,
    },
  }], { session });
}

export async function registerParticipant(
  tournamentId: string,
  input: RegistrationInput,
  context: RegistrationActorContext,
) {
  return registrationTransaction(async (session) => {
    const tournament = await loadTournamentForTransition(tournamentId, session);
    const category = await GameCategory.findById(tournament.categoryId).session(session);
    if (!category) {
      throw ApiError.unprocessable('Tournament category is missing');
    }
    const isManual = Boolean(context.manualBy);
    if (context.manualBy) {
      assertCanManage(context.manualBy, tournament.organizerId);
    }
    assertAcceptingRegistrations(tournament, isManual);
    if (!isManual && !context.user && !tournament.registrationSettings.allowGuestRegistration) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in to register for this tournament');
    }

    const email = input.email.trim().toLowerCase();
    const existing = await Registration.exists({
      tournamentId: tournament._id,
      'participantInformation.email': email,
      status: { $in: ['pending', 'approved', 'waitlisted'] },
    }).session(session);
    if (existing) {
      throw ApiError.conflict('DUPLICATE_REGISTRATION', 'This email is already registered for the tournament');
    }

    const info: ParticipantInformation = {
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      phone: input.phone,
      fideId: input.fideId ?? '',
      rating: input.rating ?? null,
      club: input.club ?? '',
      notes: input.notes ?? '',
      customFields: input.customFields ?? {},
    };
    validateConfiguredFields(category, info);
    getGameModule(category.slug).validateParticipant(info);

    const hasSeat = await reserveSeat(tournament, session, isManual);
    if (!hasSeat && !tournament.registrationSettings.allowWaitlist) {
      throw ApiError.conflict('TOURNAMENT_FULL', 'This tournament is full');
    }
    const status: RegistrationStatus = !hasSeat
      ? 'waitlisted'
      : isManual || !tournament.registrationSettings.requiresApproval ? 'approved' : 'pending';

    const registration = new Registration({
      tournamentId: tournament._id,
      userId: context.user?._id ?? null,
      participantInformation: info,
      status,
      registrationNumber: `${registrationPrefixFor(category)}-${new Date().getFullYear()}-${randomBytes(8).toString('hex').toUpperCase()}`,
      reviewedBy: status === 'approved' && isManual ? context.manualBy?._id : null,
      reviewedAt: status === 'approved' && isManual ? new Date() : null,
    });
    await registration.save({ session });
    await notify(registration, tournament.title, tournament.slug, status, session);
    return isManual ? registration : participantRegistration(registration);
  });
}

export async function listTournamentRegistrations(
  actor: IUser,
  tournamentId: string,
  query: RegistrationListQuery,
) {
  const tournament = await Tournament.findById(tournamentId).select('organizerId');
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  assertCanManage(actor, tournament.organizerId);

  const filter: Record<string, unknown> = { tournamentId: tournament._id };
  if (query.status) {
    filter['status'] = query.status;
  }
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter['$or'] = [
      { 'participantInformation.firstName': rx },
      { 'participantInformation.lastName': rx },
      { 'participantInformation.email': rx },
      { 'participantInformation.phone': rx },
      { 'participantInformation.club': rx },
      { registrationNumber: rx },
    ];
  }

  const [items, total, countsRaw] = await Promise.all([
    Registration.find(filter)
      .sort(query.sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Registration.countDocuments(filter),
    Registration.aggregate([
      { $match: { tournamentId: new Types.ObjectId(tournamentId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const counts: Record<string, number> = { all: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0, waitlisted: 0 };
  for (const row of countsRaw as { _id: string; count: number }[]) {
    counts[row._id] = row.count;
    counts['all'] += row.count;
  }
  return { items, total, counts };
}

export async function exportTournamentRegistrations(
  actor: IUser,
  tournamentId: string,
  status?: RegistrationStatus,
): Promise<{ csv: string; filename: string }> {
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  assertCanManage(actor, tournament.organizerId);

  const filter: Record<string, unknown> = { tournamentId: tournament._id };
  if (status) {
    filter['status'] = status;
  }
  const registrations = await Registration.find(filter).sort({ createdAt: 1 });
  const header = [
    'Registration number',
    'First name',
    'Last name',
    'Email',
    'Phone',
    'FIDE ID',
    'Rating',
    'Club',
    'Status',
    'Registered at',
    'Notes',
  ];
  const escape = (value: unknown): string => {
    let text = String(value ?? '');
    // Quoting alone does not stop spreadsheet formulas. Inspect past whitespace,
    // control and format characters, without modifying ordinary text or numbers.
    if (typeof value === 'string' && (/^[\t\r\n]/.test(value) || /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(value))) {
      text = `'${text}`;
    }
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = registrations.map((item) =>
    [
      item.registrationNumber,
      item.participantInformation.firstName,
      item.participantInformation.lastName,
      item.participantInformation.email,
      item.participantInformation.phone,
      item.participantInformation.fideId ?? '',
      item.participantInformation.rating ?? '',
      item.participantInformation.club ?? '',
      item.status,
      item.createdAt.toISOString(),
      item.notes ?? '',
    ]
      .map(escape)
      .join(','),
  );
  const csv = `\uFEFF${header.map(escape).join(',')}\r\n${rows.join('\r\n')}`;
  return { csv, filename: `${tournament.slug}-participants.csv` };
}

export async function myRegistrations(user: IUser) {
  return Registration.find({ userId: user._id })
    .select(PARTICIPANT_FIELDS)
    .sort({ createdAt: -1 })
    .populate({
      path: 'tournamentId',
      select: 'title slug startDate endDate status coverImage location isOnline categoryId',
      populate: { path: 'categoryId', select: 'name slug icon' },
    });
}

export async function lookupRegistration(number: string, email: string) {
  const registration = await Registration.findOne({
    registrationNumber: number,
    'participantInformation.email': email.toLowerCase(),
  })
    .select(PARTICIPANT_FIELDS.split(' ').filter((field) => field !== 'userId').join(' '))
    .populate('tournamentId', 'title slug startDate status coverImage location isOnline');
  if (!registration) {
    throw ApiError.notFound('Registration not found');
  }
  return registration;
}

async function loadRegistration(id: string, session: ClientSession | null = null) {
  const registration = await Registration.findById(id).session(session);
  if (!registration) {
    throw ApiError.notFound('Registration not found');
  }
  return registration;
}

export async function updateRegistrationStatus(
  actor: IUser,
  id: string,
  input: StatusUpdateInput,
) {
  return registrationTransaction(async (session) => {
    const registration = await loadRegistration(id, session);
    const tournament = await loadTournamentForTransition(registration.tournamentId, session);
    assertCanManage(actor, tournament.organizerId);

    const previous = registration.status;
    const next = input.status;
    if (previous === next) {
      if (input.notes !== undefined) {
        registration.notes = input.notes;
        await registration.save({ session });
      }
      return registration;
    }

    const heldSeat = SEAT_HOLDING_STATUSES.includes(previous);
    const willHoldSeat = SEAT_HOLDING_STATUSES.includes(next);

    if (willHoldSeat && !heldSeat) {
      const granted = await reserveSeat(tournament, session, true);
      if (!granted) {
        throw ApiError.conflict('TOURNAMENT_FULL', 'No seats are available for this registration');
      }
    } else if (!willHoldSeat && heldSeat) {
      await releaseSeat(tournament._id, session);
    }

    registration.status = next;
    if (next === 'approved' || next === 'rejected') {
      registration.reviewedBy = actor._id;
      registration.reviewedAt = new Date();
    }
    if (input.notes !== undefined) {
      registration.notes = input.notes;
    }
    await registration.save({ session });
    await notify(registration, tournament.title, tournament.slug, next, session);
    return registration;
  });
}

export async function getRegistrationForActor(actor: IUser, id: string) {
  const registration = await loadRegistration(id);
  if (isAdminActor(actor)) {
    const tournament = await Tournament.findById(registration.tournamentId).select('organizerId');
    if (!tournament) {
      throw ApiError.notFound('Tournament not found');
    }
    assertCanManage(actor, tournament.organizerId);
  } else if (!registration.userId || String(registration.userId) !== String(actor._id)) {
    throw ApiError.forbidden();
  }
  await registration.populate('tournamentId', 'title slug startDate endDate status coverImage location isOnline');
  return isAdminActor(actor) ? registration : participantRegistration(registration);
}

export async function cancelRegistration(actor: IUser, id: string) {
  return registrationTransaction(async (session) => {
    const registration = await loadRegistration(id, session);
    const tournament = await loadTournamentForTransition(registration.tournamentId, session);

    const isOwner = registration.userId && String(registration.userId) === String(actor._id);
    const admin = isAdminActor(actor);
    if (admin) {
      assertCanManage(actor, tournament.organizerId);
    } else if (!isOwner) {
      throw ApiError.forbidden();
    } else {
      if (!tournament.registrationSettings.allowSelfCancellation) {
        throw ApiError.forbidden('Self-cancellation is disabled for this tournament');
      }
      if (tournament.startDate.getTime() <= Date.now()) {
        throw ApiError.forbidden('Registration can no longer be cancelled');
      }
    }

    if (registration.status === 'cancelled') {
      return admin ? registration : participantRegistration(registration);
    }
    if (SEAT_HOLDING_STATUSES.includes(registration.status)) {
      await releaseSeat(tournament._id, session);
    }
    registration.status = 'cancelled';
    if (admin) {
      registration.reviewedBy = actor._id;
      registration.reviewedAt = new Date();
    }
    await registration.save({ session });
    await notify(registration, tournament.title, tournament.slug, 'cancelled', session);
    return admin ? registration : participantRegistration(registration);
  });
}
