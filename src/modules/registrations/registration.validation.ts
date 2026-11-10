import { z } from 'zod';
import { objectIdSchema, paginationSchema } from '../../common/validation.js';

export const registrationInputSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(180),
  phone: z
    .string()
    .trim()
    .min(5)
    .max(30)
    .regex(/^[+\d\s()-]+$/, 'Invalid phone number'),
  fideId: z
    .string()
    .trim()
    .max(30)
    .regex(/^[0-9]*$/, 'FIDE ID must contain digits only')
    .optional()
    .default(''),
  rating: z.coerce.number().int().min(0).max(4000).nullable().optional().default(null),
  club: z.string().trim().max(120).optional().default(''),
  notes: z.string().trim().max(1000).optional().default(''),
  customFields: z.record(z.string(), z.string().trim().max(500)).optional().default({}),
});

export type RegistrationInput = z.infer<typeof registrationInputSchema>;

export const registrationListQuerySchema = paginationSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'waitlisted']).optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});

export type RegistrationListQuery = z.infer<typeof registrationListQuerySchema>;

export const statusUpdateSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'waitlisted']),
  notes: z.string().trim().max(1000).optional(),
});

export type StatusUpdateInput = z.infer<typeof statusUpdateSchema>;

export const registrationIdParam = z.object({ id: objectIdSchema });
export const tournamentIdParam = z.object({ id: objectIdSchema });

export const exportQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'waitlisted']).optional(),
});

export const lookupQuerySchema = z.object({
  number: z.string().trim().min(3).max(40),
  email: z.string().trim().toLowerCase().email().max(180),
});
