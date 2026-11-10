import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { ApiError } from '../../common/errors.js';
import { sendSuccess } from '../../common/response.js';
import { objectIdSchema } from '../../common/validation.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { validate, validated } from '../../middleware/validate.js';
import { Notification } from './notification.model.js';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUser(req)._id;
    const [items, unreadCount] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).limit(40),
      Notification.countDocuments({ userId, readAt: null }),
    ]);
    sendSuccess(res, items, 200, { unreadCount });
  }),
);

notificationsRouter.patch(
  '/:id/read',
  validate(z.object({ id: objectIdSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<{ id: string }>(req, 'params');
    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId: currentUser(req)._id },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    if (!notification) {
      throw ApiError.notFound('Notification not found');
    }
    sendSuccess(res, notification);
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await Notification.updateMany(
      { userId: currentUser(req)._id, readAt: null },
      { $set: { readAt: new Date() } },
    );
    res.status(204).send();
  }),
);
