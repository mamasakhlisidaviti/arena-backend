import { Router } from 'express';
import type { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { paginationMeta, sendSuccess } from '../../common/response.js';
import { authenticate, currentUser, optionalAuth, optionalUser, requireAdmin } from '../../middleware/auth.js';
import { validate, validated } from '../../middleware/validate.js';
import {
  createTournament,
  deleteTournament,
  duplicateTournament,
  getPublicTournament,
  getTournamentForAdmin,
  listAdminTournaments,
  listPublicTournaments,
  setTournamentStatus,
  updateTournament,
} from './tournament.service.js';
import {
  adminTournamentQuerySchema,
  idParamSchema,
  slugParamSchema,
  tournamentInputSchema,
  tournamentListQuerySchema,
  tournamentStatusSchema,
  type AdminTournamentQuery,
  type TournamentInput,
  type TournamentListQuery,
} from './tournament.validation.js';

export const tournamentsRouter = Router();

tournamentsRouter.get(
  '/',
  validate(tournamentListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = validated<TournamentListQuery>(req, 'query');
    const { items, total } = await listPublicTournaments(query);
    sendSuccess(res, items, 200, paginationMeta(query.page, query.limit, total));
  }),
);

tournamentsRouter.get(
  '/:slug',
  optionalAuth,
  validate(slugParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { slug } = validated<z.infer<typeof slugParamSchema>>(req, 'params');
    const tournament = await getPublicTournament(slug, optionalUser(req));
    sendSuccess(res, tournament);
  }),
);

tournamentsRouter.post(
  '/',
  authenticate,
  requireAdmin,
  validate(tournamentInputSchema),
  asyncHandler(async (req, res) => {
    const input = validated<TournamentInput>(req, 'body');
    const tournament = await createTournament(currentUser(req), input);
    sendSuccess(res, tournament, 201);
  }),
);

tournamentsRouter.put(
  '/:id',
  authenticate,
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(tournamentInputSchema),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
    const input = validated<TournamentInput>(req, 'body');
    const tournament = await updateTournament(currentUser(req), id, input);
    sendSuccess(res, tournament);
  }),
);

tournamentsRouter.delete(
  '/:id',
  authenticate,
  requireAdmin,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
    await deleteTournament(currentUser(req), id);
    res.status(204).send();
  }),
);

tournamentsRouter.patch(
  '/:id/status',
  authenticate,
  requireAdmin,
  validate(idParamSchema, 'params'),
  validate(tournamentStatusSchema),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
    const { status } = validated<z.infer<typeof tournamentStatusSchema>>(req, 'body');
    const tournament = await setTournamentStatus(currentUser(req), id, status);
    sendSuccess(res, tournament);
  }),
);

tournamentsRouter.post(
  '/:id/duplicate',
  authenticate,
  requireAdmin,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
    const tournament = await duplicateTournament(currentUser(req), id);
    sendSuccess(res, tournament, 201);
  }),
);

export const adminTournamentsRouter = Router();

adminTournamentsRouter.use(authenticate, requireAdmin);

adminTournamentsRouter.get(
  '/',
  validate(adminTournamentQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = validated<AdminTournamentQuery>(req, 'query');
    const { items, total } = await listAdminTournaments(currentUser(req), query);
    sendSuccess(res, items, 200, paginationMeta(query.page, query.limit, total));
  }),
);

adminTournamentsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
    const tournament = await getTournamentForAdmin(currentUser(req), id);
    sendSuccess(res, tournament);
  }),
);
