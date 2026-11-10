import 'dotenv/config';
import path from 'node:path';

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

export const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: int(process.env.PORT, 3000),
  publicSiteUrl: (process.env.PUBLIC_SITE_URL ?? 'http://localhost:4200').replace(/\/$/, ''),
  clientOrigins: list(process.env.CLIENT_ORIGINS ?? 'http://localhost:4200,http://localhost:4000'),
  mongodbUri: process.env.MONGODB_URI?.trim() ?? '',
  accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me-please-32chars',
  refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me-please-32chars',
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    folder: process.env.CLOUDINARY_FOLDER ?? 'tournament-platform',
  },
  uploads: {
    maxBytes: int(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
    dir: process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.resolve(process.cwd(), 'uploads'),
  },
  seed: {
    adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@arena.ge',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!',
    organizerEmail: process.env.SEED_ORGANIZER_EMAIL ?? 'organizer@arena.ge',
    organizerPassword: process.env.SEED_ORGANIZER_PASSWORD ?? 'Organizer123!',
  },
} as const;

export const cloudinaryEnabled = Boolean(
  env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret,
);

if (isProduction) {
  if (env.accessSecret.includes('dev-') || env.refreshSecret.includes('dev-')) {
    throw new Error('JWT secrets must be configured in production');
  }
  if (!env.mongodbUri) {
    throw new Error('MONGODB_URI is required in production');
  }
}
