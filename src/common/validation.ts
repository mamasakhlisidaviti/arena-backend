import { z } from 'zod';
import { LANGUAGES } from './localized.js';

export const languageSchema = z.enum(LANGUAGES);

const text = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim())
    .pipe(z.string().max(max));

export const localizedField = (max = 2000) =>
  z.object({
    ka: text(max).default(''),
    en: text(max).default(''),
    ru: text(max).default(''),
  });

export const requiredLocalized = (max = 200) =>
  localizedField(max).refine((value) => Boolean(value.ka || value.en || value.ru), {
    message: 'At least one language must be provided',
  });

export const optionalPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[+\d\s()-]+$/, 'Invalid phone number')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const emailSchema = z.string().trim().toLowerCase().email().max(180);

export const passwordSchema = z
  .string()
  .min(8, 'Password must contain at least 8 characters')
  .max(72)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must not exceed 72 UTF-8 bytes');

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');

export const urlOrPath = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => value.startsWith('/') || /^https?:\/\//i.test(value), 'Invalid URL');

export const mediaSchema = z
  .object({
    url: urlOrPath,
    publicId: z.string().trim().max(300).optional().default(''),
  })
  .nullable()
  .optional();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(12),
});

export function booleanQuery() {
  return z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'));
}

export type LocalizedInput = z.infer<ReturnType<typeof localizedField>>;
