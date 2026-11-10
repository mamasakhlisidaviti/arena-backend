import { Schema } from 'mongoose';
import type { LocalizedString } from './localized.js';

export const localizedSchema = new Schema<LocalizedString>(
  {
    ka: { type: String, trim: true, default: '' },
    en: { type: String, trim: true, default: '' },
    ru: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

export interface MediaAsset {
  url: string;
  publicId?: string;
}

export const mediaSchema = new Schema<MediaAsset>(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

/** Removes Mongo internals and hidden fields and exposes a string `id`. */
export function schemaJsonOptions(hidden: string[] = []) {
  return {
    versionKey: false,
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
      const id = ret['_id'];
      delete ret['_id'];
      for (const key of hidden) {
        delete ret[key];
      }
      return { ...ret, id: id ? String(id) : undefined };
    },
  };
}
