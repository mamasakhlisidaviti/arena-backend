import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { LocalizedOption, LocalizedString } from '../../common/localized.js';
import { localizedSchema, mediaSchema, schemaJsonOptions, type MediaAsset } from '../../common/schema.js';

export interface RegistrationField {
  key: string;
  label: LocalizedString;
  type: 'text' | 'email' | 'tel' | 'number' | 'textarea' | 'select';
  required: boolean;
  options?: string[];
  enabled: boolean;
}

export interface CategoryConfiguration {
  tournamentTypes: LocalizedOption[];
  formats: LocalizedOption[];
  features?: Record<string, boolean>;
  defaults?: Record<string, unknown>;
}

export interface IGameCategory {
  _id: Types.ObjectId;
  name: LocalizedString;
  slug: string;
  description: LocalizedString;
  icon: string;
  image?: MediaAsset | null;
  isActive: boolean;
  displayOrder: number;
  configuration: CategoryConfiguration;
  registrationFields: RegistrationField[];
  createdAt: Date;
  updatedAt: Date;
}

export type GameCategoryDocument = HydratedDocument<IGameCategory>;

const registrationFieldSchema = new Schema<RegistrationField>(
  {
    key: { type: String, required: true, trim: true },
    label: { type: localizedSchema, required: true },
    type: {
      type: String,
      enum: ['text', 'email', 'tel', 'number', 'textarea', 'select'],
      default: 'text',
    },
    required: { type: Boolean, default: false },
    options: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const categorySchema = new Schema<IGameCategory>(
  {
    name: { type: localizedSchema, required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: localizedSchema, default: () => ({ ka: '', en: '', ru: '' }) },
    icon: { type: String, default: 'pi pi-flag', trim: true },
    image: { type: mediaSchema, default: null },
    isActive: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },
    configuration: { type: Schema.Types.Mixed, default: {} },
    registrationFields: { type: [registrationFieldSchema], default: [] },
  },
  { timestamps: true, toJSON: schemaJsonOptions() },
);

categorySchema.index({ isActive: 1, displayOrder: 1 });
categorySchema.index({ 'name.ka': 'text', 'name.en': 'text', 'name.ru': 'text' });

export const GameCategory = model<IGameCategory>('GameCategory', categorySchema);

export function categoryRef(category: GameCategoryDocument | Types.ObjectId | string): string {
  return typeof category === 'string' ? category : String((category as GameCategoryDocument)._id ?? category);
}
