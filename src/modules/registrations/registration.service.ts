import { Types } from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { escapeRegex } from '../../common/regex.js';
import { registrationNumber } from '../../common/slug.js';
import type { IUser } from '../users/user.model.js';
import type { LocalizedString } from '../../common/localized.js';
import { GameCategory, type GameCategoryDocument } from '../categories/category.model.js';
import { getGameModule } from '../tournaments/games/chess.js';
import { registrationPrefixFor } from '../tournaments/tournament.service.js';
import { PUBLIC_STATUSES, Tournament } from '../tournaments/tournament.model.js';
import { Notification, type NotificationType } from '../notifications/notification.model.js';
import {
  Registration,
  SEAT_HOLDING_STATUSES,
  type IRegistration,
  type ParticipantInformation,
  type RegistrationStatus,
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

async function loadContext(tournamentId: string) {
  const tournament = await Tournament.findById(tournamentId);
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  const category = await GameCategory.findById(tournament.categoryId);
  if (!category) {
    throw ApiError.unprocessable('Tournament category is missing');
  }
  return { tournament, category };
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

async function reserveSeat(tournamentId: Types.ObjectId): Promise<boolean> {
  const updated = await Tournament.findOneAndUpdate(
    {
      _id: tournamentId,
      $expr: { $lt: ['$currentParticipants', '$participantLimit'] },
    },
    { $inc: { currentParticipants: 1 } },
    { new: true },
  );
  return Boolean(updated);
}

async function releaseSeat(tournamentId: Types.ObjectId): Promise<void> {
  await Tournament.updateOne(
    { _id: tournamentId, currentParticipants: { $gt: 0 } },
    { $inc: { currentParticipants: -1 } },
  );
}

async function notify(
  registration: IRegistration,
  tournamentTitle: LocalizedString,
  tournamentSlug: string,
  status: RegistrationStatus,
): Promise<void> {
  const typeByStatus: Record<RegistrationStatus, NotificationType> = {
    pending: 'registration_created',
    approved: 'registration_approved',
    rejected: 'registration_rejected',
    waitlisted: 'registration_waitlisted',
    cancelled: 'registration_cancelled',
  };
  await Notification.create({
    userId: registration.userId ?? null,
    email: registration.participantInformation.email,
    type: typeByStatus[status] ?? 'registration_created',    data: {
      tournamentId: String(registration.tournamentId),
      tournamentSlug,
      tournamentTitle,
      registrationNumber: registration.registrationNumber,
      registrationId: String(registration._id),
      status,
    },
  });
}

export async function registerParticipant(
  tournamentId: string,
  input: RegistrationInput,
  context: RegistrationActorContext,
) {
  const { tournament, category } = await loadContext(tournamentId);
  const isManual = Boolean(context.manualBy);

  if (isManual) {
    assertCanManage(context.manualBy as IUser, tournament.organizerId);
    if (tournament.status === 'cancelled' || tournament.status === 'completed') {
      throw ApiError.conflict('REGISTRATION_CLOSED', 'This tournament no longer accepts registrations');
    }
  } else {
    if (!PUBLIC_STATUSES.includes(tournament.status) || tournament.status === 'completed') {
      throw ApiError.conflict('REGISTRATION_CLOSED', 'This tournament is not accepting registrations');
    }
    if (tournament.registrationDeadline.getTime() <= Date.now()) {
      throw ApiError.conflict('REGISTRATION_CLOSED', 'Registration is closed for this tournament');
    }
    if (!context.user && !tournament.registrationSettings.allowGuestRegistration) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Please sign in to register for this tournament');
    }
  }

  const email = input.email.toLowerCase();
  const existing = await Registration.exists({
    tournamentId: tournament._id,
    'participantInformation.email': email,
    status: { $in: ['pending', 'approved', 'waitlisted'] },
  });
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

  const hasSeat = await reserveSeat(tournament._id);
  let status: RegistrationStatus;
  if (isManual) {
    if (hasSeat) {
      status = 'approved';
    } else if (tournament.registrationSettings.allowWaitlist) {
      status = 'waitlisted';
    } else {
      throw ApiError.conflict('TOURNAMENT_FULL', 'This tournament is full');
    }
  } else if (!hasSeat) {
    if (tournament.registrationSettings.allowWaitlist) {
      status = 'waitlisted';
    } else {
      throw ApiError.conflict('TOURNAMENT_FULL', 'This tournament is full');
    }
  } else {
    status = tournament.registrationSettings.requiresApproval ? 'pending' : 'approved';
  }

  let registration: IRegistration;
  try {
    registration = await Registration.create({
      tournamentId: tournament._id,
      userId: context.user?._id ?? null,
      participantInformation: info,
      status,
      registrationNumber: `${registrationPrefixFor(category)}-${new Date().getFullYear()}-${Math.random()
        .toString(36)
        .slice(2, 9)
        .toUpperCase()}`,
      reviewedBy: status === 'approved' && isManual ? context.manualBy?._id : null,
      reviewedAt: status === 'approved' && isManual ? new Date() : null,
    });
  } catch (error) {
    if (hasSeat) {
      await releaseSeat(tournament._id);
    }
    const duplicate = error as { code?: number };
    if (duplicate?.code === 11000) {
      throw ApiError.conflict('DUPLICATE_REGISTRATION', 'This email is already registered for the tournament');
    }
    throw error;
  }

  await notify(registration, tournament.title, tournament.slug, status);
  return registration;
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
  const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
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
    .select('-reviewedBy -userId')
    .populate('tournamentId', 'title slug startDate status coverImage location isOnline');
  if (!registration) {
    throw ApiError.notFound('Registration not found');
  }
  return registration;
}

async function loadRegistrationForActor(actor: IUser, id: string) {
  const registration = await Registration.findById(id);
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
  const registration = await loadRegistrationForActor(actor, id);
  const tournament = await Tournament.findById(registration.tournamentId);
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  assertCanManage(actor, tournament.organizerId);

  const previous = registration.status;
  const next = input.status;
  if (previous === next) {
    if (input.notes !== undefined) {
      registration.notes = input.notes;
      await registration.save();
    }
    return registration;
  }

  const heldSeat = SEAT_HOLDING_STATUSES.includes(previous);
  const willHoldSeat = SEAT_HOLDING_STATUSES.includes(next);

  if (willHoldSeat && !heldSeat) {
    const granted = await reserveSeat(tournament._id);
    if (!granted) {
      throw ApiError.conflict('TOURNAMENT_FULL', 'No seats are available for this registration');
    }
  } else if (!willHoldSeat && heldSeat) {
    await releaseSeat(tournament._id);
  }

  registration.status = next;
  if (next === 'approved' || next === 'rejected') {
    registration.reviewedBy = actor._id;
    registration.reviewedAt = new Date();
  }
  if (input.notes !== undefined) {
    registration.notes = input.notes;
  }
  await registration.save();
  await notify(registration, tournament.title, tournament.slug, next);
  return registration;
}

export async function getRegistrationForActor(actor: IUser, id: string) {
  const registration = await loadRegistrationForActor(actor, id);
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
  return registration;
}

export async function cancelRegistration(actor: IUser, id: string) {
  const registration = await loadRegistrationForActor(actor, id);
  const tournament = await Tournament.findById(registration.tournamentId);
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }

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
    return registration;
  }
  if (SEAT_HOLDING_STATUSES.includes(registration.status)) {
    await releaseSeat(tournament._id);
  }
  registration.status = 'cancelled';
  if (admin) {
    registration.reviewedBy = actor._id;
    registration.reviewedAt = new Date();
  }
  await registration.save();
  await notify(registration, tournament.title, tournament.slug, 'cancelled');
  return registration;
}
