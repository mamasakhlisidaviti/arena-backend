import { Schema, model, type HydratedDocument } from 'mongoose';
import type { LocalizedString } from '../../common/localized.js';
import { localizedSchema, schemaJsonOptions } from '../../common/schema.js';

export interface ISetting {
  key: string;
  siteName: LocalizedString;
  tagline: LocalizedString;
  contactEmail: string;
  socialLinks: {
    facebook: string;
    instagram: string;
    youtube: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export type SettingDocument = HydratedDocument<ISetting>;

const settingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true, default: 'platform' },
    siteName: {
      type: localizedSchema,
      default: () => ({ ka: 'ჭადრაკის არენა', en: 'Chess Arena', ru: 'Шахматная арена' }),
    },
    tagline: { type: localizedSchema, default: () => ({ ka: '', en: '', ru: '' }) },
    contactEmail: { type: String, lowercase: true, trim: true, default: '' },
    socialLinks: {
      facebook: { type: String, trim: true, default: '' },
      instagram: { type: String, trim: true, default: '' },
      youtube: { type: String, trim: true, default: '' },
    },
  },
  { timestamps: true, toJSON: schemaJsonOptions() },
);

export const Setting = model<ISetting>('Setting', settingSchema);
