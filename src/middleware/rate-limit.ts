import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const skip = () => env.isTest;

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 900 : 5000,
  skip,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 30 : 1000,
  skip,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' } },
});

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.isProduction ? 25 : 1000,
  skip,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many registration attempts' } },
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.isProduction ? 60 : 1000,
  skip,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many uploads' } },
});
