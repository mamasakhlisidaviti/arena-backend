import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { cloudinaryEnabled, env } from '../../config/env.js';
import { ApiError } from '../../common/errors.js';
import type { MediaAsset } from '../../common/schema.js';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
}

export function isSupportedImage(mimetype: string): boolean {
  return Boolean(MIME_EXTENSIONS[mimetype]);
}

export async function uploadImage(
  buffer: Buffer,
  mimetype: string,
  folder = 'general',
): Promise<MediaAsset> {
  if (!isSupportedImage(mimetype)) {
    throw ApiError.badRequest('Only JPEG, PNG and WebP images are supported');
  }

  if (cloudinaryEnabled) {
    return new Promise<MediaAsset>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${env.cloudinary.folder}/${folder}`,
          resource_type: 'image',
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        },
        (error, result) => {
          if (error || !result) {
            reject(ApiError.badRequest('Image upload failed'));
            return;
          }
          resolve({ url: result.secure_url, publicId: result.public_id });
        },
      );
      stream.end(buffer);
    });
  }

  await fs.mkdir(env.uploads.dir, { recursive: true });
  const extension = MIME_EXTENSIONS[mimetype] ?? 'bin';
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
  await fs.writeFile(path.join(env.uploads.dir, filename), buffer);
  return { url: `/uploads/${filename}`, publicId: `local:${filename}` };
}

export async function deleteImage(publicId?: string | null): Promise<void> {
  if (!publicId) {
    return;
  }
  try {
    if (publicId.startsWith('local:')) {
      const filename = path.basename(publicId.slice('local:'.length));
      await fs.rm(path.join(env.uploads.dir, filename), { force: true });
      return;
    }
    if (cloudinaryEnabled) {
      await cloudinary.uploader.destroy(publicId);
    }
  } catch (error) {
    console.warn('[uploads] failed to delete image', publicId, error);
  }
}
