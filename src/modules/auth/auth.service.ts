import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { ApiError } from '../../common/errors.js';
import { RefreshToken } from './refresh-token.model.js';
import { User, type UserDocument } from '../users/user.model.js';

const BCRYPT_ROUNDS = 12;
export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/api/auth';

interface RefreshPayload {
  sub: string;
  jti: string;
  type: 'refresh';
  authVersion: number;
  exp: number;
}

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw ApiError.unprocessable('Password must not exceed 72 UTF-8 bytes');
  }
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function sessionVersion(user: UserDocument): number {
  if (!Number.isSafeInteger(user.authVersion) || user.authVersion < 0) {
    throw ApiError.unauthorized('Invalid session version');
  }
  return user.authVersion;
}

export function signAccessToken(user: UserDocument): string {
  return jwt.sign({ sub: String(user._id), role: user.role, type: 'access', authVersion: sessionVersion(user) }, env.accessSecret, {
    algorithm: 'HS256',
    expiresIn: env.accessTtl as SignOptions['expiresIn'],
  });
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshCookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'lax' as const,
    path: REFRESH_PATH,
    ...(maxAge ? { maxAge } : {}),
  };
}

export async function createSession(user: UserDocument, req: Request, res: Response): Promise<string> {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: String(user._id), jti, type: 'refresh', authVersion: sessionVersion(user) }, env.refreshSecret, {
    algorithm: 'HS256',
    expiresIn: env.refreshTtl as SignOptions['expiresIn'],
  });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 86400000);

  await RefreshToken.create({
    jti,
    userId: user._id,
    tokenHash: hashToken(token),
    expiresAt,
    createdByIp: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
  });

  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(Math.max(0, expiresAt.getTime() - Date.now())));
  return token;
}

function verifyRefreshToken(token: string): RefreshPayload {
  const payload = jwt.verify(token, env.refreshSecret, { algorithms: ['HS256'] }) as RefreshPayload;
  if (
    payload.type !== 'refresh' ||
    typeof payload.sub !== 'string' || !/^[a-f\d]{24}$/i.test(payload.sub) ||
    typeof payload.jti !== 'string' || !payload.jti ||
    !Number.isSafeInteger(payload.authVersion) || payload.authVersion < 0 ||
    typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
  ) {
    throw ApiError.unauthorized('Invalid session');
  }
  return payload;
}

export async function rotateSession(req: Request, res: Response): Promise<{ accessToken: string; user: UserDocument }> {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== 'string' || !token) {
    throw ApiError.unauthorized('No active session');
  }
  let payload: RefreshPayload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Session expired');
  }

  const user = await User.findById(payload.sub).select('+authVersion');
  if (!user || !user.isActive || user.authVersion !== payload.authVersion) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Account is not available');
  }

  // Consume in one write: only the winner of concurrent requests can mint a successor.
  const record = await RefreshToken.findOneAndUpdate(
    {
      jti: payload.jti,
      userId: user._id,
      tokenHash: hashToken(token),
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { revokedAt: new Date() } },
    { new: true },
  );
  if (!record) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Session is no longer valid');
  }

  // Keep the verified version snapshot; a concurrent reset must not upgrade this session.
  const accessToken = signAccessToken(user);
  await createSession(user, req, res);
  return { accessToken, user };
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token === 'string' && token) {
    try {
      const payload = verifyRefreshToken(token);
      await RefreshToken.updateOne(
        { jti: payload.jti, userId: payload.sub, tokenHash: hashToken(token), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
    } catch {
      // expired or malformed tokens are simply cleared
    }
  }
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}
