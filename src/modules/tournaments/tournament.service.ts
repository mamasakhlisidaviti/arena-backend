import { Types, type QueryFilter } from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { escapeRegex } from '../../common/regex.js';
import { slugify } from '../../common/slug.js';
import type { IUser } from '../users/user.model.js';
import { User } from '../users/user.model.js';
import { GameCategory, type GameCategoryDocument } from '../categories/category.model.js';
import { Notification } from '../notifications/notification.model.js';
import { Registration } from '../registrations/registration.model.js';
import { deleteImage } from '../uploads/storage.service.js';
import { getGameModule } from './games/chess.js';
import {
  PUBLIC_STATUSES,
  Tournament,
  type ITournament,
  type TournamentStatus,
} from './tournament.model.js';
import type {
  AdminTournamentQuery,
  TournamentInput,
  TournamentListQuery,
} from './tournament.validation.js';

const DAY = 86400000;

function idOf(value: unknown): string {
  if (value && typeof value === 'object' && '_id' in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value ?? '');
}

async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  const cleaned = base.slice(0, 90) || 'tournament';
  let candidate = cleaned;
  let suffix = 1;
  while (
    await Tournament.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
  ) {
    suffix += 1;
    candidate = `${cleaned}-${suffix}`;
  }
  return candidate;
}

function slugBase(input: TournamentInput): string {
  if (input.slug) {
    return input.slug;
  }
  return (
    slugify(input.title.en || input.title.ka || input.title.ru) ||
    `tournament-${Math.random().toString(36).slice(2, 8)}`
  );
}

async function loadCategory(categoryId: string): Promise<GameCategoryDocument> {
  const category = await GameCategory.findById(categoryId);
  if (!category) {
    throw ApiError.unprocessable('Game category not found');
  }
  return category;
}

function validateCategoryChoice(
  category: GameCategoryDocument,
  tournamentType: string,
  format: string,
): void {
  const types = category.configuration?.tournamentTypes ?? [];
  const formats = category.configuration?.formats ?? [];
  if (types.length > 0 && !types.some((item) => item.value === tournamentType)) {
    throw ApiError.unprocessable('Unsupported tournament type for this category');
  }
  if (formats.length > 0 && !formats.some((item) => item.value === format)) {
    throw ApiError.unprocessable('Unsupported tournament format for this category');
  }
}

export function registrationPrefixFor(category: GameCategoryDocument): string {
  return getGameModule(category.slug).registrationPrefix;
}

export async function createTournament(
  actor: IUser,
  input: TournamentInput,
): Promise<ITournament> {
  const category = await loadCategory(input.categoryId);
  if (!category.isActive && actor.role !== 'super_admin') {
    throw ApiError.unprocessable('This game category is not active');
  }
  validateCategoryChoice(category, input.tournamentType, input.format);
  const gameSettings = getGameModule(category.slug).validateGameSettings(input);

  let organizerId = actor._id;
  if (input.organizerId && actor.role === 'super_admin') {
    const organizer = await User.findOne({ _id: input.organizerId, role: { $in: ['admin', 'super_admin'] } });
    if (!organizer) {
      throw ApiError.unprocessable('Organizer not found');
    }
    organizerId = organizer._id;
  }

  const slug = await uniqueSlug(slugBase(input));
  const status: TournamentStatus = input.publish ? 'published' : 'draft';

  const tournament = await Tournament.create({
    title: input.title,
    slug,
    description: input.description,
    categoryId: category._id,
    organizerId,
    coverImage: input.coverImage ?? null,
    tournamentType: input.tournamentType,
    format: input.format,
    status,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    registrationDeadline: input.registrationDeadline,
    location: input.location,
    isOnline: input.isOnline,
    participantLimit: input.participantLimit,
    currentParticipants: 0,
    entryFee: input.entryFee,
    currency: input.currency,
    prizePool: input.prizePool ?? null,
    prizes: input.prizes,
    rules: input.rules,
    contact: input.contact,
    gameSettings,
    registrationSettings: input.registrationSettings,
    seo: input.seo,
    isFeatured: input.isFeatured,
    publishedAt: status === 'published' ? new Date() : null,
  });

  return tournament;
}

export async function updateTournament(
  actor: IUser,
  id: string,
  input: TournamentInput,
): Promise<ITournament> {
  const tournament = await Tournament.findById(id);
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  if (actor.role !== 'super_admin' && String(tournament.organizerId) !== String(actor._id)) {
    throw ApiError.forbidden();
  }

  const category = await loadCategory(input.categoryId);
  if (String(category._id) !== String(tournament.categoryId)) {
    const activeRegistrations = await Registration.countDocuments({ tournamentId: tournament._id });
    if (activeRegistrations > 0) {
      throw ApiError.conflict(
        'CATEGORY_CHANGE_NOT_ALLOWED',
        'Game category cannot be changed after participants have registered',
      );
    }
  }
  validateCategoryChoice(category, input.tournamentType, input.format);
  const gameSettings = getGameModule(category.slug).validateGameSettings(input);

  if (input.slug && input.slug !== tournament.slug) {
    tournament.slug = await uniqueSlug(input.slug, id);
  }
  if (input.organizerId && actor.role === 'super_admin') {
    const organizer = await User.findOne({ _id: input.organizerId, role: { $in: ['admin', 'super_admin'] } });
    if (!organizer) {
      throw ApiError.unprocessable('Organizer not found');
    }
    tournament.organizerId = organizer._id;
  }

  tournament.title = input.title;
  tournament.description = input.description;
  tournament.categoryId = category._id;
  tournament.coverImage = input.coverImage ?? null;
  tournament.tournamentType = input.tournamentType;
  tournament.format = input.format;
  tournament.startDate = input.startDate;
  tournament.endDate = input.endDate ?? null;
  tournament.registrationDeadline = input.registrationDeadline;
  tournament.location = input.location;
  tournament.isOnline = input.isOnline;
  tournament.participantLimit = input.participantLimit;
  tournament.entryFee = input.entryFee;
  tournament.currency = input.currency;
  tournament.prizePool = input.prizePool ?? null;
  tournament.prizes = input.prizes;
  tournament.rules = input.rules;
  tournament.contact = input.contact;
  tournament.gameSettings = gameSettings;
  tournament.registrationSettings = input.registrationSettings;
  if (input.seo) {
    tournament.seo = input.seo;
  }
  tournament.isFeatured = input.isFeatured;
  await tournament.save();
  return tournament;
}

export async function setTournamentStatus(
  actor: IUser,
  id: string,
  status: TournamentStatus,
): Promise<ITournament> {
  const tournament = await Tournament.findById(id);
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  if (actor.role !== 'super_admin' && String(tournament.organizerId) !== String(actor._id)) {
    throw ApiError.forbidden();
  }
  tournament.status = status;
  if (status === 'published' && !tournament.publishedAt) {
    tournament.publishedAt = new Date();
  }
  if (status === 'draft') {
    tournament.publishedAt = null;
  }
  await tournament.save();
  return tournament;
}

export async function deleteTournament(actor: IUser, id: string): Promise<void> {
  const tournament = await Tournament.findById(id);
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  if (actor.role !== 'super_admin' && String(tournament.organizerId) !== String(actor._id)) {
    throw ApiError.forbidden();
  }
  await Promise.all([
    Registration.deleteMany({ tournamentId: tournament._id }),
    Notification.deleteMany({ 'data.tournamentId': String(tournament._id) }),
  ]);
  await deleteImage(tournament.coverImage?.publicId);
  await tournament.deleteOne();
}

export async function duplicateTournament(actor: IUser, id: string): Promise<ITournament> {
  const source = await Tournament.findById(id);
  if (!source) {
    throw ApiError.notFound('Tournament not found');
  }
  if (actor.role !== 'super_admin' && String(source.organizerId) !== String(actor._id)) {
    throw ApiError.forbidden();
  }
  const title = {
    ka: `${source.title.ka} (ასლი)`.trim(),
    en: `${source.title.en} (Copy)`.trim(),
    ru: `${source.title.ru} (Копия)`.trim(),
  };
  const slug = await uniqueSlug(
    slugify(title.en || title.ka || title.ru) || `tournament-copy-${Math.random().toString(36).slice(2, 8)}`,
  );
  const copy = new Tournament({
    title,
    slug,
    description: source.description,
    categoryId: source.categoryId,
    organizerId: actor._id,
    coverImage: source.coverImage,
    tournamentType: source.tournamentType,
    format: source.format,
    status: 'draft',
    startDate: source.startDate,
    endDate: source.endDate,
    registrationDeadline: source.registrationDeadline,
    location: source.location,
    isOnline: source.isOnline,
    participantLimit: source.participantLimit,
    currentParticipants: 0,
    entryFee: source.entryFee,
    currency: source.currency,
    prizePool: source.prizePool,
    prizes: source.prizes,
    rules: source.rules,
    contact: source.contact,
    gameSettings: source.gameSettings,
    registrationSettings: source.registrationSettings,
    seo: source.seo,
    isFeatured: false,
    publishedAt: null,
  });
  await copy.save();
  return copy;
}

export async function getTournamentForAdmin(actor: IUser, id: string): Promise<ITournament> {
  const tournament = await Tournament.findById(id)
    .populate('categoryId', 'name slug icon')
    .populate('organizerId', 'firstName lastName email');
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  if (actor.role !== 'super_admin' && String(tournament.organizerId) !== String(actor._id)) {
    throw ApiError.forbidden();
  }
  return tournament;
}

export async function getPublicTournament(slug: string, actor?: IUser): Promise<ITournament> {
  const tournament = await Tournament.findOne({ slug })
    .populate('categoryId', 'name slug icon configuration registrationFields')
    .populate('organizerId', 'firstName lastName email avatar');
  if (!tournament) {
    throw ApiError.notFound('Tournament not found');
  }
  const isPublic = PUBLIC_STATUSES.includes(tournament.status);
  const organizerRef = tournament.organizerId as unknown as { _id?: unknown };
  const isOwner =
    actor &&
    (actor.role === 'super_admin' ||
      String(organizerRef?._id ?? tournament.organizerId) === String(actor._id));
  if (!isPublic && !isOwner) {
    throw ApiError.notFound('Tournament not found');
  }
  return tournament;
}

function periodFilter(query: {
  dateFrom?: Date;
  dateTo?: Date;
  online?: 'true' | 'false';
  city?: string;
  fee?: 'free' | 'paid';
  featured?: 'true' | 'false';
}): QueryFilter<ITournament> {
  const filter: QueryFilter<ITournament> = {};
  if (query.dateFrom) {
    filter['startDate'] = { $gte: query.dateFrom };
  }
  if (query.dateTo) {
    const end = new Date(query.dateTo);
    end.setHours(23, 59, 59, 999);
    filter['startDate'] = { ...(filter['startDate'] as object), $lte: end };
  }
  if (query.online) {
    filter['isOnline'] = query.online === 'true';
  }
  if (query.city) {
    filter['location.city'] = new RegExp(`^${escapeRegex(query.city)}$`, 'i');
  }
  if (query.fee === 'free') {
    filter['entryFee'] = 0;
  } else if (query.fee === 'paid') {
    filter['entryFee'] = { $gt: 0 };
  }
  if (query.featured === 'true') {
    filter['isFeatured'] = true;
  }
  return filter;
}

function registrationStatusFilter(status: TournamentListQuery['registrationStatus']): QueryFilter<ITournament> {
  if (!status) {
    return {};
  }
  const now = new Date();
  if (status === 'open') {
    return {
      registrationDeadline: { $gt: now },
      $expr: { $lt: ['$currentParticipants', '$participantLimit'] },
    };
  }
  if (status === 'full') {
    return { $expr: { $gte: ['$currentParticipants', '$participantLimit'] } };
  }
  if (status === 'closed') {
    return { registrationDeadline: { $lte: now } };
  }
  return {
    registrationDeadline: { $gt: now, $lte: new Date(now.getTime() + 7 * DAY) },
    $expr: { $lt: ['$currentParticipants', '$participantLimit'] },
  };
}

async function searchFilter(q: string): Promise<QueryFilter<ITournament>> {
  const rx = new RegExp(escapeRegex(q), 'i');
  const organizers = await User.find({
    $or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
  })
    .limit(100)
    .distinct('_id');
  return {
    $or: [
      { 'title.ka': rx },
      { 'title.en': rx },
      { 'title.ru': rx },
      { 'location.venue': rx },
      { 'location.city': rx },
      { organizerId: { $in: organizers } },
    ],
  };
}

function applySort(sort: TournamentListQuery['sort']): Record<string, 1 | -1> {
  switch (sort) {
    case 'oldest':
      return { createdAt: 1 };
    case 'upcoming':
      return { startDate: 1 };
    case 'deadline':
      return { registrationDeadline: 1 };
    case 'popular':
      return { currentParticipants: -1, createdAt: -1 };
    case 'newest':
    default:
      return { createdAt: -1 };
  }
}

export async function listPublicTournaments(query: TournamentListQuery) {
  const filter: QueryFilter<ITournament> = {
    status: query.status ?? { $in: PUBLIC_STATUSES },
    publishedAt: { $ne: null },
    ...periodFilter(query),
  };

  if (query.category) {
    const category = await GameCategory.findOne({ slug: query.category }).select('_id');
    if (!category) {
      return { items: [], total: 0 };
    }
    filter['categoryId'] = category._id;
  }
  if (query.q) {
    Object.assign(filter, await searchFilter(query.q));
  }
  Object.assign(filter, registrationStatusFilter(query.registrationStatus));

  const [items, total] = await Promise.all([
    Tournament.find(filter)
      .select('-description -rules -prizes -seo -contact -gameSettings')
      .populate('categoryId', 'name slug icon')
      .populate('organizerId', 'firstName lastName')
      .sort(applySort(query.sort))
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Tournament.countDocuments(filter),
  ]);
  return { items, total };
}

export async function listAdminTournaments(actor: IUser, query: AdminTournamentQuery) {
  const filter: QueryFilter<ITournament> = { ...periodFilter(query) };
  if (actor.role !== 'super_admin') {
    filter['organizerId'] = new Types.ObjectId(String(actor._id));
  }
  if (query.status) {
    filter['status'] = query.status;
  }
  if (query.category) {
    const category = await GameCategory.findOne({ slug: query.category }).select('_id');
    if (!category) {
      return { items: [], total: 0 };
    }
    filter['categoryId'] = category._id;
  }
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter['$or'] = [
      { 'title.ka': rx },
      { 'title.en': rx },
      { 'title.ru': rx },
      { 'location.city': rx },
      { slug: rx },
    ];
  }

  const [items, total] = await Promise.all([
    Tournament.find(filter)
      .select('-description -rules -prizes -seo -contact')
      .populate('categoryId', 'name slug icon')
      .populate('organizerId', 'firstName lastName email')
      .sort(applySort(query.sort))
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Tournament.countDocuments(filter),
  ]);
  return { items, total };
}

export function tournamentOwnerId(tournament: ITournament): string {
  return idOf(tournament.organizerId);
}
