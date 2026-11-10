import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { ApiError } from '../../common/errors.js';
import { RefreshToken } from './refresh-token.model.js';
import type { UserDocument } from '../users/user.model.js';

const BCRYPT_ROUNDS = 12;
export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/api/auth';

interface RefreshPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(user: UserDocument): string {
  return jwt.sign({ sub: String(user._id), role: user.role, type: 'access' }, env.accessSecret, {
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
  const token = jwt.sign({ sub: String(user._id), jti, type: 'refresh' }, env.refreshSecret, {
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

export async function rotateSession(req: Request, res: Response): Promise<{ accessToken: string; user: UserDocument }> {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) {
    throw ApiError.unauthorized('No active session');
  }
  let payload: RefreshPayload;
  try {
    payload = jwt.verify(token, env.refreshSecret) as RefreshPayload;
  } catch {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Session expired');
  }
  if (payload.type !== 'refresh' || !payload.jti) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Invalid session');
  }

  const record = await RefreshToken.findOne({ jti: payload.jti });
  if (
    !record ||
    record.revokedAt ||
    record.expiresAt.getTime() < Date.now() ||
    record.tokenHash !== hashToken(token) ||
    String(record.userId) !== String(payload.sub)
  ) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Session is no longer valid');
  }

  const { User } = await import('../users/user.model.js');
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Account is not available');
  }

  record.revokedAt = new Date();
  await record.save();
  const accessToken = signAccessToken(user);
  await createSession(user, req, res);
  return { accessToken, user };
}

export async function revokeSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (token) {
    try {
      const payload = jwt.verify(token, env.refreshSecret) as RefreshPayload;
      await RefreshToken.updateOne({ jti: payload.jti }, { $set: { revokedAt: new Date() } });
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
