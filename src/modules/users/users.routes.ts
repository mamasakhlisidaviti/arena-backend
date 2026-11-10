import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { ApiError } from '../../common/errors.js';
import { escapeRegex } from '../../common/regex.js';
import { paginationMeta, sendSuccess } from '../../common/response.js';
import { emailSchema, objectIdSchema, paginationSchema, passwordSchema } from '../../common/validation.js';
import { authenticate, currentUser, requireSuperAdmin } from '../../middleware/auth.js';
import { validate, validated } from '../../middleware/validate.js';
import { User, toPublicUser } from './user.model.js';
import { hashPassword, revokeAllSessions } from '../auth/auth.service.js';

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  role: z.enum(['super_admin', 'admin', 'participant']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

const createUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: emailSchema,
  phone: z.string().trim().max(30).optional().default(''),
  password: passwordSchema,
  role: z.enum(['super_admin', 'admin']).default('admin'),
  preferredLanguage: z.enum(['ka', 'en', 'ru']).default('ka'),
});

const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(30).optional(),
  role: z.enum(['super_admin', 'admin', 'participant']).optional(),
  isActive: z.boolean().optional(),
  preferredLanguage: z.enum(['ka', 'en', 'ru']).optional(),
  password: passwordSchema.optional(),
});

const idParamSchema = z.object({ id: objectIdSchema });

export const usersRouter = Router();

usersRouter.use(authenticate, requireSuperAdmin);

usersRouter.get(
  '/',
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof listQuerySchema>>(req, 'query');
    const filter: Record<string, unknown> = {};
    if (query.role) {
      filter['role'] = query.role;
    }
    if (query.isActive) {
      filter['isActive'] = query.isActive === 'true';
    }
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      filter['$or'] = [{ firstName: rx }, { lastName: rx }, { email: rx }];
    }
    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      User.countDocuments(filter),
    ]);
    sendSuccess(res, items.map(toPublicUser), 200, paginationMeta(query.page, query.limit, total));
  }),
);

usersRouter.post(
  '/',
  validate(createUserSchema),
  asyncHandler(async (req, res) => {
    const input = validated<z.infer<typeof createUserSchema>>(req, 'body');
    const exists = await User.findOne({ email: input.email });
    if (exists) {
      throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    }
    const user = await User.create({
      ...input,
      passwordHash: await hashPassword(input.password),
    });
    sendSuccess(res, toPublicUser(user), 201);
  }),
);

usersRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateUserSchema),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
    const input = validated<z.infer<typeof updateUserSchema>>(req, 'body');
    const actor = currentUser(req);
    if (String(actor._id) === id && input.isActive === false) {
      throw ApiError.badRequest('You cannot deactivate your own account');
    }
    if (String(actor._id) === id && input.role && input.role !== 'super_admin') {
      throw ApiError.badRequest('You cannot change your own role');
    }
    const user = await User.findById(id);
    if (!user) {
      throw ApiError.notFound('User not found');
    }
    const { password, ...rest } = input;
    Object.assign(user, rest);
    if (password) {
      user.passwordHash = await hashPassword(password);
      await revokeAllSessions(String(user._id));
    }
    await user.save();
    sendSuccess(res, toPublicUser(user));
  }),
);

usersRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
    const actor = currentUser(req);
    if (String(actor._id) === id) {
      throw ApiError.badRequest('You cannot deactivate your own account');
    }
    const user = await User.findById(id);
    if (!user) {
      throw ApiError.notFound('User not found');
    }
    user.isActive = false;
    await user.save();
    await revokeAllSessions(String(user._id));
    res.status(204).send();
  }),
);
