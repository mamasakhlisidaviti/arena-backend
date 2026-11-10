import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { ApiError } from '../../common/errors.js';
import { sendSuccess } from '../../common/response.js';
import { slugify } from '../../common/slug.js';
import {
  localizedField,
  mediaSchema,
  objectIdSchema,
  requiredLocalized,
} from '../../common/validation.js';
import { authenticate, requireSuperAdmin } from '../../middleware/auth.js';
import { validate, validated } from '../../middleware/validate.js';
import { GameCategory, type RegistrationField } from './category.model.js';
import { Tournament } from '../tournaments/tournament.model.js';

const optionSchema = z.object({
  value: z.string().trim().regex(/^[a-z0-9_]+$/, 'Use lowercase letters, digits and underscores'),
  label: requiredLocalized(80),
});

const registrationFieldSchema = z.object({
  key: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Invalid field key'),
  label: requiredLocalized(120),
  type: z.enum(['text', 'email', 'tel', 'number', 'textarea', 'select']).default('text'),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().max(80)).max(30).default([]),
  enabled: z.boolean().default(true),
});

const categorySchema = z.object({
  name: requiredLocalized(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug')
    .max(80)
    .optional(),
  description: localizedField(3000).default({ ka: '', en: '', ru: '' }),
  icon: z.string().trim().max(120).default('pi pi-flag'),
  image: mediaSchema,
  isActive: z.boolean().default(true),
  displayOrder: z.coerce.number().int().min(0).max(999).default(0),
  configuration: z
    .object({
      tournamentTypes: z.array(optionSchema).max(30).default([]),
      formats: z.array(optionSchema).max(30).default([]),
      features: z.record(z.string(), z.boolean()).default({}),
      defaults: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ tournamentTypes: [], formats: [], features: {}, defaults: {} }),
  registrationFields: z.array(registrationFieldSchema).max(40).default([]),
});

const idParam = z.object({ id: objectIdSchema });

type CategoryInput = z.infer<typeof categorySchema>;

async function uniqueCategorySlug(base: string, excludeId?: string): Promise<string> {
  let candidate = base || 'category';
  let suffix = 1;
  while (
    await GameCategory.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })
  ) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function assertUniqueFieldKeys(fields: RegistrationField[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) {
      throw ApiError.unprocessable(`Duplicate registration field key: ${field.key}`);
    }
    seen.add(field.key);
  }
}

export const categoriesRouter = Router();

categoriesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const items = await GameCategory.find({ isActive: true }).sort({ displayOrder: 1, 'name.en': 1 });
    sendSuccess(res, items);
  }),
);

categoriesRouter.get(
  '/admin/all',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const items = await GameCategory.find().sort({ displayOrder: 1, createdAt: 1 });
    sendSuccess(res, items);
  }),
);

categoriesRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const category = await GameCategory.findOne({ slug: req.params['slug'], isActive: true });
    if (!category) {
      throw ApiError.notFound('Category not found');
    }
    sendSuccess(res, category);
  }),
);

categoriesRouter.post(
  '/',
  authenticate,
  requireSuperAdmin,
  validate(categorySchema),
  asyncHandler(async (req, res) => {
    const input = validated<CategoryInput>(req, 'body');
    assertUniqueFieldKeys(input.registrationFields);
    const slug = await uniqueCategorySlug(input.slug || slugify(input.name.en || input.name.ka));
    const category = await GameCategory.create({ ...input, slug });
    sendSuccess(res, category, 201);
  }),
);

categoriesRouter.put(
  '/:id',
  authenticate,
  requireSuperAdmin,
  validate(idParam, 'params'),
  validate(categorySchema),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParam>>(req, 'params');
    const input = validated<CategoryInput>(req, 'body');
    assertUniqueFieldKeys(input.registrationFields);
    const category = await GameCategory.findById(id);
    if (!category) {
      throw ApiError.notFound('Category not found');
    }
    if (input.slug && input.slug !== category.slug) {
      category.slug = await uniqueCategorySlug(input.slug, id);
    }
    const { slug: _ignored, ...rest } = input;
    Object.assign(category, rest);
    await category.save();
    sendSuccess(res, category);
  }),
);

categoriesRouter.delete(
  '/:id',
  authenticate,
  requireSuperAdmin,
  validate(idParam, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = validated<z.infer<typeof idParam>>(req, 'params');
    const inUse = await Tournament.exists({ categoryId: id });
    if (inUse) {
      throw ApiError.conflict('CATEGORY_IN_USE', 'This category is used by existing tournaments');
    }
    const category = await GameCategory.findByIdAndDelete(id);
    if (!category) {
      throw ApiError.notFound('Category not found');
    }
    res.status(204).send();
  }),
);
