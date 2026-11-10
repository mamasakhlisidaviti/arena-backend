import 'dotenv/config';
import path from 'node:path';
import { isIP } from 'node:net';

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

function positiveInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function trustedProxies(value: string): string[] {
  const proxies = list(value);
  for (const proxy of proxies) {
    const [ip, bits, extra] = proxy.split('/');
    const version = isIP(ip);
    if (!version || extra !== undefined || (bits !== undefined &&
        (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (version === 4 ? 32 : 128)))) {
      throw new Error('API_TRUSTED_PROXIES must contain explicit IP addresses or nonzero CIDRs');
    }
  }
  return proxies;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';

function origin(value: string, name: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*') ||
      (isProduction && url.protocol !== 'https:')) {
    throw new Error(`${name} must be an HTTP origin (HTTPS in production), without a path or credentials`);
  }
  return url.origin;
}

const publicSiteUrl = origin(process.env.PUBLIC_SITE_URL ?? 'http://localhost:4200', 'PUBLIC_SITE_URL');
const clientOrigins = list(process.env.CLIENT_ORIGINS ?? 'http://localhost:4200,http://localhost:4000')
  .map((value) => origin(value, 'CLIENT_ORIGINS'));
const maxUploadBytes = positiveInt('MAX_UPLOAD_MB', 5) * 1024 * 1024;

export const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === 'test',
  port: int(process.env.PORT, 3000),
  publicSiteUrl,
  clientOrigins,
  http: {
    // Only the local SSR process is trusted by default, never an arbitrary hop count.
    trustedProxies: trustedProxies(process.env.API_TRUSTED_PROXIES ?? '127.0.0.1/32,::1/128'),
    jsonMaxBytes: positiveInt('JSON_BODY_LIMIT_BYTES', 256 * 1024),
    uploadBodyMaxBytes: maxUploadBytes + 64 * 1024,
    rateWindowMs: positiveInt('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    apiRateLimit: positiveInt('API_RATE_LIMIT', isProduction ? 900 : 5000),
    authRateLimit: positiveInt('AUTH_RATE_LIMIT', isProduction ? 30 : 1000),
    registrationRateLimit: positiveInt('REGISTRATION_RATE_LIMIT', isProduction ? 25 : 1000),
    uploadRateLimit: positiveInt('UPLOAD_RATE_LIMIT', isProduction ? 60 : 1000),
  },
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
    maxBytes: maxUploadBytes,
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
  const placeholder = /dev[-_]|test[-_]|change[-_ ]?me|replace[-_ ]?me|your[-_ ]|placeholder|example|default|please|password|secret[-_ ]?(?:here|key)/i;
  if ([env.accessSecret, env.refreshSecret].some((secret) =>
    Buffer.byteLength(secret, 'utf8') < 32 || placeholder.test(secret) ||
    new Set(secret).size < 8 || secret !== secret.trim()) || env.accessSecret === env.refreshSecret) {
    throw new Error('Production JWT secrets must be distinct, random values of at least 32 bytes, not placeholders');
  }
  if (!clientOrigins.length || !clientOrigins.includes(publicSiteUrl)) {
    throw new Error('CLIENT_ORIGINS must include PUBLIC_SITE_URL in production');
  }
  if (!env.mongodbUri) {
    throw new Error('MONGODB_URI is required in production');
  }
}
