import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { sendSuccess } from '../../common/response.js';
import { authenticate, currentUser, optionalAuth, optionalUser, requireAdmin } from '../../middleware/auth.js';
import { registrationLimiter } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import {
  cancelRegistration,
  exportTournamentRegistrations,
  getRegistrationForActor,
  listTournamentRegistrations,
  lookupRegistration,
  myRegistrations,
  registerParticipant,
  updateRegistrationStatus,
} from './registration.service.js';
import {
  exportQuerySchema,
  lookupQuerySchema,
  registrationIdParam,
  registrationInputSchema,
  registrationListQuerySchema,
  statusUpdateSchema,
  tournamentIdParam,
} from './registration.validation.js';

export const registrationsRouter = Router();

registrationsRouter.post(
  '/tournaments/:id/register',
  optionalAuth,
  registrationLimiter,
  validate(tournamentIdParam, 'params'),
  validate(registrationInputSchema),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof tournamentIdParam>>(req, 'params');
    const input = validated<z.infer<typeof registrationInputSchema>>(req, 'body');
    const registration = await registerParticipant(id, input, { user: optionalUser(req) });
    sendSuccess(res, registration, 201);
  }),
);

registrationsRouter.post(
  '/tournaments/:id/registrations',
  authenticate,
  requireAdmin,
  validate(tournamentIdParam, 'params'),
  validate(registrationInputSchema),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof tournamentIdParam>>(req, 'params');
    const input = validated<z.infer<typeof registrationInputSchema>>(req, 'body');
    const registration = await registerParticipant(id, input, { manualBy: currentUser(req) });
    sendSuccess(res, registration, 201);
  }),
);

registrationsRouter.get(
  '/tournaments/:id/registrations/export',
  authenticate,
  requireAdmin,
  validate(tournamentIdParam, 'params'),
  validate(exportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof tournamentIdParam>>(req, 'params');
    const query = validated<z.infer<typeof exportQuerySchema>>(req, 'query');
    const { csv, filename } = await exportTournamentRegistrations(currentUser(req), id, query.status);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }),
);

registrationsRouter.get(
  '/tournaments/:id/registrations',
  authenticate,
  requireAdmin,
  validate(tournamentIdParam, 'params'),
  validate(registrationListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof tournamentIdParam>>(req, 'params');
    const query = validated<z.infer<typeof registrationListQuerySchema>>(req, 'query');
    const result = await listTournamentRegistrations(currentUser(req), id, query);
    sendSuccess(res, result.items, 200, {
      page: query.page,
      limit: query.limit,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / query.limit)),
      counts: result.counts,
    });
  }),
);

registrationsRouter.get(
  '/registrations/lookup',
  registrationLimiter,
  validate(lookupQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = validated<z.infer<typeof lookupQuerySchema>>(req, 'query');
    const registration = await lookupRegistration(query.number, query.email);
    sendSuccess(res, registration);
  }),
);

registrationsRouter.get(
  '/registrations/my',
  authenticate,
  asyncHandler(async (req, res) => {
    const registrations = await myRegistrations(currentUser(req));
    sendSuccess(res, registrations);
  }),
);

registrationsRouter.get(
  '/registrations/:id',
  authenticate,
  validate(registrationIdParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof registrationIdParam>>(req, 'params');
    const registration = await getRegistrationForActor(currentUser(req), id);
    sendSuccess(res, registration);
  }),
);

registrationsRouter.patch(
  '/registrations/:id/status',
  authenticate,
  requireAdmin,
  validate(registrationIdParam, 'params'),
  validate(statusUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof registrationIdParam>>(req, 'params');
    const input = validated<z.infer<typeof statusUpdateSchema>>(req, 'body');
    const registration = await updateRegistrationStatus(currentUser(req), id, input);
    sendSuccess(res, registration);
  }),
);

registrationsRouter.delete(
  '/registrations/:id',
  authenticate,
  validate(registrationIdParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof registrationIdParam>>(req, 'params');
    await cancelRegistration(currentUser(req), id);
    res.status(204).send();
  }),
);
