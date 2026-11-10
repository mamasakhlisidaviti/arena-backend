import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../../common/async-handler.js';
import { ApiError } from '../../common/errors.js';
import { sendSuccess } from '../../common/response.js';
import { env } from '../../config/env.js';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/rate-limit.js';
import { validate, validated } from '../../middleware/validate.js';
import { deleteImage, isSupportedImage, uploadImage } from './storage.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploads.maxBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!isSupportedImage(file.mimetype)) {
      callback(ApiError.badRequest('Only JPEG, PNG and WebP images are supported'));
      return;
    }
    callback(null, true);
  },
});

const deleteQuerySchema = z.object({ publicId: z.string().trim().min(1).max(400) });

export const uploadsRouter = Router();

uploadsRouter.post(
  '/image',
  authenticate,
  requireAdmin,
  uploadLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw ApiError.badRequest('Image file is required');
    }
    const folder = typeof req.body?.folder === 'string' ? req.body.folder.slice(0, 40) : 'general';
    const asset = await uploadImage(req.file.buffer, req.file.mimetype, folder);
    sendSuccess(res, asset, 201);
  }),
);

uploadsRouter.delete(
  '/',
  authenticate,
  requireAdmin,
  validate(deleteQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { publicId } = validated<z.infer<typeof deleteQuerySchema>>(req, 'query');
    await deleteImage(publicId);
    res.status(204).send();
  }),
);
