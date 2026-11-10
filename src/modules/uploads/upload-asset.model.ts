import { Schema, model, type Types } from 'mongoose';

export interface IUploadAsset {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  provider: 'local' | 'cloudinary';
  publicId: string;
  url: string;
  state: 'uploading' | 'upload_failed' | 'active' | 'deleting' | 'delete_failed' | 'deleted';
  attachmentVersion: number;
  deletionStartedAt?: Date | null;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const uploadAssetSchema = new Schema<IUploadAsset>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
    provider: { type: String, enum: ['local', 'cloudinary'], required: true, immutable: true },
    publicId: { type: String, required: true, immutable: true, unique: true },
    url: { type: String, required: true, immutable: true, unique: true },
    state: {
      type: String,
      enum: ['uploading', 'upload_failed', 'active', 'deleting', 'delete_failed', 'deleted'],
      required: true,
      default: 'uploading',
    },
    // A real write, not a read/no-op, serializes attachment transactions with deletion.
    attachmentVersion: { type: Number, required: true, default: 0 },
    deletionStartedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Keep tombstones: an old ID must never become an untracked legacy attachment.
export const UploadAsset = model<IUploadAsset>('UploadAsset', uploadAssetSchema);
