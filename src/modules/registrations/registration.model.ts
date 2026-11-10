import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { schemaJsonOptions } from '../../common/schema.js';

export type RegistrationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'waitlisted';

export interface ParticipantInformation {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  fideId?: string;
  rating?: number | null;
  club?: string;
  notes?: string;
  customFields?: Record<string, string>;
}

export interface IRegistration {
  _id: Types.ObjectId;
  tournamentId: Types.ObjectId;
  userId?: Types.ObjectId | null;
  participantInformation: ParticipantInformation;
  status: RegistrationStatus;
  registrationNumber: string;
  notes: string;
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RegistrationDocument = HydratedDocument<IRegistration>;

const participantSchema = new Schema<ParticipantInformation>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 180 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    fideId: { type: String, trim: true, maxlength: 30, default: '' },
    rating: { type: Number, default: null, min: 0, max: 4000 },
    club: { type: String, trim: true, maxlength: 120, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    customFields: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const registrationSchema = new Schema<IRegistration>(
  {
    tournamentId: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    participantInformation: { type: participantSchema, required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled', 'waitlisted'],
      default: 'pending',
      index: true,
    },
    registrationNumber: { type: String, required: true, unique: true },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: schemaJsonOptions() },
);

// A participant (by email) may hold only one active registration per tournament.
registrationSchema.index(
  { tournamentId: 1, 'participantInformation.email': 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['pending', 'approved', 'waitlisted'] } },
    name: 'uniq_active_registration',
  },
);
registrationSchema.index({ tournamentId: 1, status: 1, createdAt: -1 });
registrationSchema.index({ userId: 1, createdAt: -1 });

export const Registration = model<IRegistration>('Registration', registrationSchema);

export const SEAT_HOLDING_STATUSES: RegistrationStatus[] = ['pending', 'approved'];
