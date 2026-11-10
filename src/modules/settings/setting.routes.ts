import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { sendSuccess } from '../../common/response.js';
import { localizedField, requiredLocalized } from '../../common/validation.js';
import { authenticate, requireSuperAdmin } from '../../middleware/auth.js';
import { validate, validated } from '../../middleware/validate.js';
import { Setting } from './setting.model.js';

const socialUrl = z
  .string()
  .trim()
  .max(300)
  .default('')
  .refine((value) => !value || /^https?:\/\//i.test(value), 'Invalid URL');

const settingsSchema = z.object({
  siteName: requiredLocalized(120),
  tagline: localizedField(300).default({ ka: '', en: '', ru: '' }),
  contactEmail: z.string().trim().toLowerCase().max(180).default(''),
  socialLinks: z
    .object({
      facebook: socialUrl,
      instagram: socialUrl,
      youtube: socialUrl,
    })
    .default({ facebook: '', instagram: '', youtube: '' }),
});

async function getPlatformSettings() {
  return Setting.findOneAndUpdate(
    { key: 'platform' },
    { $setOnInsert: { key: 'platform' } },
    { new: true, upsert: true },
  );
}

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const settings = await getPlatformSettings();
    sendSuccess(res, settings);
  }),
);

settingsRouter.put(
  '/',
  authenticate,
  requireSuperAdmin,
  validate(settingsSchema),
  asyncHandler(async (req, res) => {
    const input = validated<z.infer<typeof settingsSchema>>(req, 'body');
    const settings = await Setting.findOneAndUpdate(
      { key: 'platform' },
      { $set: input, $setOnInsert: { key: 'platform' } },
      { new: true, upsert: true },
    );
    sendSuccess(res, settings);
  }),
);
