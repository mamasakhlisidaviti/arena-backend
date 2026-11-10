import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../common/errors.js';
import { User, type UserDocument } from '../modules/users/user.model.js';

interface AccessPayload {
  sub: string;
  type: 'access';
  authVersion: number;
  exp: number;
}

type RequestWithUser = Request & { user?: UserDocument };

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

async function resolveUser(token: string): Promise<UserDocument> {
  let payload: AccessPayload;
  try {
    payload = jwt.verify(token, env.accessSecret, { algorithms: ['HS256'] }) as AccessPayload;
  } catch {
    throw ApiError.unauthorized('Session expired');
  }
  if (
    payload.type !== 'access' ||
    typeof payload.sub !== 'string' || !/^[a-f\d]{24}$/i.test(payload.sub) ||
    !Number.isSafeInteger(payload.authVersion) || payload.authVersion < 0 ||
    typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
  ) {
    throw ApiError.unauthorized('Invalid token');
  }
  const user = await User.findById(payload.sub).select('+authVersion');
  if (!user || !user.isActive || user.authVersion !== payload.authVersion) {
    throw ApiError.unauthorized('Account is not available');
  }
  return user;
}

export const authenticate = (async (req: Request, _res: Response, next: NextFunction) => {
  const token = extractToken(req);
  if (!token) {
    throw ApiError.unauthorized();
  }
  (req as RequestWithUser).user = await resolveUser(token);
  next();
}) as RequestHandler;

export const optionalAuth = (async (req: Request, _res: Response, next: NextFunction) => {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    (req as RequestWithUser).user = await resolveUser(token);
  } catch {
    /* public endpoints ignore invalid sessions */
  }
  next();
}) as RequestHandler;

export function requireRole(...roles: UserDocument['role'][]): RequestHandler {
  return (req, _res, next) => {
    const user = (req as RequestWithUser).user;
    if (!user) {
      next(ApiError.unauthorized());
      return;
    }
    if (!roles.includes(user.role)) {
      next(ApiError.forbidden());
      return;
    }
    next();
  };
}

export const requireAdmin = requireRole('admin', 'super_admin');
export const requireSuperAdmin = requireRole('super_admin');

export function currentUser(req: Request): UserDocument {
  const user = (req as RequestWithUser).user;
  if (!user) {
    throw ApiError.unauthorized();
  }
  return user;
}

export function optionalUser(req: Request): UserDocument | undefined {
  return (req as RequestWithUser).user;
}

export function assertResourceOwner(req: Request, organizerId: unknown): void {
  const user = currentUser(req);
  if (user.role === 'super_admin') {
    return;
  }
  const value =
    organizerId && typeof organizerId === 'object' && '_id' in organizerId
      ? (organizerId as { _id: unknown })._id
      : organizerId;
  if (user.role !== 'admin' || String(value ?? '') !== String(user._id)) {
    throw ApiError.forbidden();
  }
}
