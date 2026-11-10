import { z } from 'zod';
import {
  emailSchema,
  localizedField,
  mediaSchema,
  objectIdSchema,
  requiredLocalized,
} from '../../common/validation.js';

const locationSchema = z
  .object({
    venue: z.string().trim().max(160).default(''),
    city: z.string().trim().max(120).default(''),
    address: z.string().trim().max(300).default(''),
  })
  .default({ venue: '', city: '', address: '' });

const contactSchema = z
  .object({
    name: z.string().trim().max(120).default(''),
    email: z.string().trim().toLowerCase().max(180).default(''),
    phone: z.string().trim().max(30).default(''),
  })
  .default({ name: '', email: '', phone: '' })
  .refine((value) => !value.email || z.string().email().safeParse(value.email).success, {
    message: 'Invalid contact email',
    path: ['email'],
  });

const registrationSettingsSchema = z
  .object({
    requiresApproval: z.boolean().default(true),
    allowGuestRegistration: z.boolean().default(true),
    allowWaitlist: z.boolean().default(true),
    allowSelfCancellation: z.boolean().default(true),
  })
  .default({
    requiresApproval: true,
    allowGuestRegistration: true,
    allowWaitlist: true,
    allowSelfCancellation: true,
  });

export const tournamentInputSchema = z
  .object({
    title: requiredLocalized(160),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug')
      .max(100)
      .optional(),
    description: localizedField(12000).default({ ka: '', en: '', ru: '' }),
    categoryId: objectIdSchema,
    coverImage: mediaSchema,
    tournamentType: z.string().trim().min(1).max(60),
    format: z.string().trim().min(1).max(60),
    startDate: z.coerce.date(),
    endDate: z.coerce.date().nullable().optional().default(null),
    registrationDeadline: z.coerce.date(),
    location: locationSchema,
    isOnline: z.boolean().default(false),
    participantLimit: z.coerce.number().int().min(2).max(100000),
    entryFee: z.coerce.number().min(0).max(1000000).default(0),
    currency: z.enum(['GEL', 'USD', 'EUR']).default('GEL'),
    prizePool: z.union([z.coerce.number().min(0).max(100000000), z.null()]).optional().default(null),
    prizes: localizedField(3000).default({ ka: '', en: '', ru: '' }),
    rules: localizedField(12000).default({ ka: '', en: '', ru: '' }),
    contact: contactSchema,
    gameSettings: z.record(z.string(), z.unknown()).default({}),
    registrationSettings: registrationSettingsSchema,
    seo: z
      .object({
        metaTitle: localizedField(80).default({ ka: '', en: '', ru: '' }),
        metaDescription: localizedField(180).default({ ka: '', en: '', ru: '' }),
      })
      .optional(),
    isFeatured: z.boolean().default(false),
    publish: z.boolean().default(false),
    organizerId: objectIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.endDate && value.endDate.getTime() < value.startDate.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must be after start date' });
    }
    if (value.registrationDeadline.getTime() > value.startDate.getTime()) {
      ctx.addIssue({
        code: 'custom',
        path: ['registrationDeadline'],
        message: 'Registration deadline must be before the tournament starts',
      });
    }
    if (!value.isOnline) {
      if (!value.location.venue) {
        ctx.addIssue({ code: 'custom', path: ['location', 'venue'], message: 'Venue is required' });
      }
      if (!value.location.city) {
        ctx.addIssue({ code: 'custom', path: ['location', 'city'], message: 'City is required' });
      }
    }
  });

export type TournamentInput = z.infer<typeof tournamentInputSchema>;

export const tournamentStatusSchema = z.object({
  status: z.enum(['draft', 'published', 'ongoing', 'completed', 'cancelled']),
});

export const tournamentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  status: z.enum(['published', 'ongoing', 'completed']).optional(),
  registrationStatus: z.enum(['open', 'closing_soon', 'full', 'closed']).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  online: z.enum(['true', 'false']).optional(),
  city: z.string().trim().max(120).optional(),
  fee: z.enum(['free', 'paid']).optional(),
  featured: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'oldest', 'upcoming', 'deadline', 'popular']).default('newest'),
});

export const adminTournamentQuerySchema = tournamentListQuerySchema.extend({
  status: z.enum(['draft', 'published', 'ongoing', 'completed', 'cancelled']).optional(),
});

export type TournamentListQuery = z.infer<typeof tournamentListQuerySchema>;
export type AdminTournamentQuery = z.infer<typeof adminTournamentQuerySchema>;

export const slugParamSchema = z.object({ slug: z.string().trim().min(1).max(120) });
export const idParamSchema = z.object({ id: objectIdSchema });

export { emailSchema };
