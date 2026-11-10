import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { LocalizedString } from '../../common/localized.js';
import { localizedSchema, mediaSchema, schemaJsonOptions, type MediaAsset } from '../../common/schema.js';

export type TournamentStatus = 'draft' | 'published' | 'ongoing' | 'completed' | 'cancelled';

export interface TournamentLocation {
  venue: string;
  city: string;
  address: string;
}

export interface TournamentContact {
  name: string;
  email: string;
  phone: string;
}

export interface RegistrationSettings {
  requiresApproval: boolean;
  allowGuestRegistration: boolean;
  allowWaitlist: boolean;
  allowSelfCancellation: boolean;
}

export interface TournamentSeo {
  metaTitle: LocalizedString;
  metaDescription: LocalizedString;
}

export interface ITournament {
  _id: Types.ObjectId;
  title: LocalizedString;
  slug: string;
  description: LocalizedString;
  categoryId: Types.ObjectId;
  organizerId: Types.ObjectId;
  coverImage?: MediaAsset | null;
  tournamentType: string;
  format: string;
  status: TournamentStatus;
  startDate: Date;
  endDate?: Date | null;
  registrationDeadline: Date;
  location: TournamentLocation;
  isOnline: boolean;
  participantLimit: number;
  currentParticipants: number;
  entryFee: number;
  currency: string;
  prizePool?: number | null;
  prizes?: LocalizedString;
  rules?: LocalizedString;
  contact?: TournamentContact;
  gameSettings: Record<string, unknown>;
  registrationSettings: RegistrationSettings;
  seo?: TournamentSeo;
  isFeatured: boolean;
  publishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TournamentDocument = HydratedDocument<ITournament>;

const locationSchema = new Schema<TournamentLocation>(
  {
    venue: { type: String, trim: true, maxlength: 160, default: '' },
    city: { type: String, trim: true, maxlength: 120, default: '' },
    address: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: false },
);

const contactSchema = new Schema<TournamentContact>(
  {
    name: { type: String, trim: true, maxlength: 120, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 180, default: '' },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
  },
  { _id: false },
);

const registrationSettingsSchema = new Schema<RegistrationSettings>(
  {
    requiresApproval: { type: Boolean, default: true },
    allowGuestRegistration: { type: Boolean, default: true },
    allowWaitlist: { type: Boolean, default: true },
    allowSelfCancellation: { type: Boolean, default: true },
  },
  { _id: false },
);

const seoSchema = new Schema<TournamentSeo>(
  {
    metaTitle: { type: localizedSchema, default: () => ({ ka: '', en: '', ru: '' }) },
    metaDescription: { type: localizedSchema, default: () => ({ ka: '', en: '', ru: '' }) },
  },
  { _id: false },
);

const tournamentSchema = new Schema<ITournament>(
  {
    title: { type: localizedSchema, required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: localizedSchema, default: () => ({ ka: '', en: '', ru: '' }) },
    categoryId: { type: Schema.Types.ObjectId, ref: 'GameCategory', required: true, index: true },
    organizerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    coverImage: { type: mediaSchema, default: null },
    tournamentType: { type: String, required: true, trim: true },
    format: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['draft', 'published', 'ongoing', 'completed', 'cancelled'],
      default: 'draft',
      index: true,
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    registrationDeadline: { type: Date, required: true },
    location: { type: locationSchema, default: () => ({ venue: '', city: '', address: '' }) },
    isOnline: { type: Boolean, default: false },
    participantLimit: { type: Number, required: true, min: 2, max: 100000 },
    currentParticipants: { type: Number, default: 0, min: 0 },
    entryFee: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'GEL', enum: ['GEL', 'USD', 'EUR'] },
    prizePool: { type: Number, default: null, min: 0 },
    prizes: { type: localizedSchema, default: () => ({ ka: '', en: '', ru: '' }) },
    rules: { type: localizedSchema, default: () => ({ ka: '', en: '', ru: '' }) },
    contact: { type: contactSchema, default: () => ({ name: '', email: '', phone: '' }) },
    gameSettings: { type: Schema.Types.Mixed, default: {} },
    registrationSettings: {
      type: registrationSettingsSchema,
      default: () => ({
        requiresApproval: true,
        allowGuestRegistration: true,
        allowWaitlist: true,
        allowSelfCancellation: true,
      }),
    },
    seo: { type: seoSchema, default: () => ({}) },
    isFeatured: { type: Boolean, default: false },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: schemaJsonOptions() },
);

tournamentSchema.index({ status: 1, startDate: 1 });
tournamentSchema.index({ status: 1, createdAt: -1 });
tournamentSchema.index({ categoryId: 1, status: 1 });
tournamentSchema.index({ 'title.ka': 'text', 'title.en': 'text', 'title.ru': 'text' });

export const Tournament = model<ITournament>('Tournament', tournamentSchema);

export const PUBLIC_STATUSES: TournamentStatus[] = ['published', 'ongoing', 'completed'];
export const ACTIVE_REGISTRATION_STATUSES = ['pending', 'approved', 'waitlisted'] as const;
