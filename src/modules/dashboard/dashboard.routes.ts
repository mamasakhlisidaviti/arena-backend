import { Router } from 'express';
import { asyncHandler } from '../../common/async-handler.js';
import { sendSuccess } from '../../common/response.js';
import { authenticate, currentUser, requireAdmin } from '../../middleware/auth.js';
import { dashboardRecentRegistrations, dashboardStats } from './dashboard.service.js';

export const dashboardRouter = Router();

dashboardRouter.use(authenticate, requireAdmin);

dashboardRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const stats = await dashboardStats(currentUser(req));
    sendSuccess(res, stats);
  }),
);

dashboardRouter.get(
  '/recent-registrations',
  asyncHandler(async (req, res) => {
    const items = await dashboardRecentRegistrations(currentUser(req));
    sendSuccess(res, items);
  }),
);
