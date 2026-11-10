import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { LocalizedString } from '../../common/localized.js';
import { localizedSchema, mediaSchema, schemaJsonOptions, type MediaAsset } from '../../common/schema.js';

export type UserRole = 'super_admin' | 'admin' | 'participant';

export interface IUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  passwordHash: string;
  authVersion: number;
  role: UserRole;
  avatar?: MediaAsset | null;
  preferredLanguage: keyof LocalizedString;
  isActive: boolean;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 80 },
    lastName: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 180 },
    phone: { type: String, trim: true, maxlength: 30 },
    passwordHash: { type: String, required: true, select: false },
    authVersion: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger, select: false },
    role: { type: String, enum: ['super_admin', 'admin', 'participant'], default: 'participant', index: true },
    avatar: { type: mediaSchema, default: null },
    preferredLanguage: { type: String, enum: ['ka', 'en', 'ru'], default: 'ka' },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: schemaJsonOptions(['passwordHash', 'authVersion']) },
);

userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ firstName: 1, lastName: 1 });

export const User = model<IUser>('User', userSchema);

export interface PublicUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  avatar?: MediaAsset | null;
  preferredLanguage: keyof LocalizedString;
  isActive?: boolean;
  lastLoginAt?: Date | null;
  createdAt?: Date;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: String(user._id),
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    avatar: user.avatar ?? null,
    preferredLanguage: user.preferredLanguage,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
  };
}
