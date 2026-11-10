import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { ApiError } from '../../common/errors.js';
import { sendSuccess } from '../../common/response.js';
import { emailSchema, languageSchema, passwordSchema } from '../../common/validation.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import { User, toPublicUser, type UserDocument } from '../users/user.model.js';
import {
  createSession,
  hashPassword,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  signAccessToken,
  verifyPassword,
} from './auth.service.js';

const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: emailSchema,
  phone: z.string().trim().max(30).optional().default(''),
  password: passwordSchema,
  preferredLanguage: languageSchema.optional().default('ka'),
});

// Existing bcrypt hashes may have accepted >72 UTF-8 bytes; keep verification compatible.
const existingPasswordSchema = z.string().min(1).max(200);
const loginSchema = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
});

const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(30).optional(),
  preferredLanguage: languageSchema.optional(),
});

const passwordChangeSchema = z.object({
  currentPassword: existingPasswordSchema,
  newPassword: passwordSchema,
});

function credentialsFilter(user: UserDocument) {
  return {
    _id: user._id,
    isActive: true,
    passwordHash: user.passwordHash,
    // Legacy documents have no stored version until their first security update.
    ...(user.authVersion === 0
      ? { $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }] }
      : { authVersion: user.authVersion }),
  };
}

export const authRouter = Router();

authRouter.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const input = validated<z.infer<typeof registerSchema>>(req, 'body');
    const existing = await User.findOne({ email: input.email });
    if (existing) {
      throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    const user = await User.create({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      passwordHash: await hashPassword(input.password),
      role: 'participant',
      preferredLanguage: input.preferredLanguage,
    });
    const accessToken = signAccessToken(user);
    await createSession(user, req, res);
    sendSuccess(res, { accessToken, user: toPublicUser(user) }, 201);
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const input = validated<z.infer<typeof loginSchema>>(req, 'body');
    const user = await User.findOne({ email: input.email }).select('+passwordHash +authVersion');
    if (!user || !user.isActive || !(await verifyPassword(input.password, user.passwordHash))) {
      throw ApiError.unauthorized('Incorrect email or password');
    }
    // Do not promote a password verified before a concurrent reset to the new version.
    const authenticatedUser = await User.findOneAndUpdate(
      credentialsFilter(user),
      { $set: { lastLoginAt: new Date() } },
      { new: true },
    ).select('+authVersion');
    if (!authenticatedUser) {
      throw ApiError.unauthorized('Credentials changed; please log in again');
    }
    const accessToken = signAccessToken(authenticatedUser);
    await createSession(authenticatedUser, req, res);
    sendSuccess(res, { accessToken, user: toPublicUser(authenticatedUser) });
  }),
);

authRouter.post(
  '/refresh',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { accessToken, user } = await rotateSession(req, res);
    sendSuccess(res, { accessToken, user: toPublicUser(user) });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await revokeSession(req, res);
    res.status(204).send();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    sendSuccess(res, { user: toPublicUser(currentUser(req)) });
  }),
);

authRouter.patch(
  '/me',
  authenticate,
  validate(profileSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const input = validated<z.infer<typeof profileSchema>>(req, 'body');
    Object.assign(user, input);
    await user.save();
    sendSuccess(res, { user: toPublicUser(user) });
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate(passwordChangeSchema),
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);
    const user = await User.findById(actor._id).select('+passwordHash +authVersion');
    if (!user || !user.isActive || user.authVersion !== actor.authVersion) {
      throw ApiError.unauthorized();
    }
    const input = validated<z.infer<typeof passwordChangeSchema>>(req, 'body');
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw ApiError.badRequest('Current password is incorrect');
    }
    const updated = await User.findOneAndUpdate(
      credentialsFilter(user),
      { $set: { passwordHash: await hashPassword(input.newPassword) }, $inc: { authVersion: 1 } },
      { new: true, runValidators: true },
    );
    if (!updated) {
      throw ApiError.unauthorized('Credentials changed; please log in again');
    }
    await revokeAllSessions(String(user._id));
    await revokeSession(req, res);
    sendSuccess(res, { message: 'Password updated', requiresLogin: true });
  }),
);
