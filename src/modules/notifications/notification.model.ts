import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { schemaJsonOptions } from '../../common/schema.js';

export type NotificationType =
  | 'registration_created'
  | 'registration_approved'
  | 'registration_rejected'
  | 'registration_waitlisted'
  | 'registration_cancelled';

export interface INotification {
  userId?: Types.ObjectId | null;
  email: string;
  type: NotificationType;
  data: Record<string, unknown>;
  readAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<INotification>;

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    email: { type: String, lowercase: true, trim: true, default: '' },
    type: {
      type: String,
      enum: [
        'registration_created',
        'registration_approved',
        'registration_rejected',
        'registration_waitlisted',
        'registration_cancelled',
      ],
      required: true,
    },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: schemaJsonOptions() },
);

notificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification = model<INotification>('Notification', notificationSchema);
