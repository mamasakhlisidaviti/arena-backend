import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { enforceRequestPolicy, sanitizeRequest } from './middleware/sanitize.js';
import { apiLimiter } from './middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { categoriesRouter } from './modules/categories/category.routes.js';
import { registrationsRouter } from './modules/registrations/registration.routes.js';
import {
  adminTournamentsRouter,
  tournamentsRouter,
} from './modules/tournaments/tournament.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { notificationsRouter } from './modules/notifications/notification.routes.js';
import { settingsRouter } from './modules/settings/setting.routes.js';
import { homeRouter, seoRouter } from './modules/home/home.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.clientOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(sanitizeRequest);

  app.use(
    '/uploads',
    express.static(env.uploads.dir, {
      maxAge: '7d',
      fallthrough: true,
      index: false,
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } });
  });

  app.use('/api', apiLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api', registrationsRouter);
  app.use('/api/tournaments', tournamentsRouter);
  app.use('/api/admin/tournaments', adminTournamentsRouter);
  app.use('/api/admin/dashboard', dashboardRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api', homeRouter);
  app.use('/', seoRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
