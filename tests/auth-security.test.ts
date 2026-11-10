import crypto from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { optionalAuth, optionalUser } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { sanitizeRequest } from '../src/middleware/sanitize.js';
import { authRouter } from '../src/modules/auth/auth.routes.js';
import * as authService from '../src/modules/auth/auth.service.js';
import { RefreshToken } from '../src/modules/auth/refresh-token.model.js';
import { User, type UserDocument } from '../src/modules/users/user.model.js';
import { usersRouter } from '../src/modules/users/users.routes.js';

// Hoisted mock prevents dotenv loading and excludes inherited database credentials.
vi.mock('../src/config/env.js', () => ({
  env: {
    nodeEnv: 'test', isTest: true, isProduction: false, mongodbUri: '',
    accessSecret: 'isolated-auth-test-access-secret-at-least-32-bytes',
    refreshSecret: 'isolated-auth-test-refresh-secret-at-least-32-bytes',
    accessTtl: '15m', refreshTtl: '7d',
  },
}));

const PASSWORD = 'Password123';
const NEW_PASSWORD = 'ChangedPassword456';
let app: Express;
let passwordHash: string;
let user: UserDocument;
let admin: UserDocument;
let adminToken: string;

type Session = { accessToken: string; cookie: string };
const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const refreshToken = (session: Session) => session.cookie.slice('refresh_token='.length);
const claims = (token: string) => jwt.decode(token) as JwtPayload;

function sessionFrom(response: Response): Session {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies?.find((value) => value.startsWith('refresh_token='))?.split(';')[0];
  expect(cookie).toBeTruthy();
  expect(response.body.data.accessToken).toEqual(expect.any(String));
  return { accessToken: response.body.data.accessToken, cookie: cookie! };
}

async function login(password = PASSWORD): Promise<Session> {
  return sessionFrom(await request(app).post('/api/auth/login').send({ email: user.email, password }).expect(200));
}

const refresh = (session: Session) => request(app).post('/api/auth/refresh').set('Cookie', session.cookie);
const me = (session: Session) => request(app).get('/api/auth/me').auth(session.accessToken, { type: 'bearer' });
const updateUser = (body: Record<string, unknown>) => request(app).patch(`/api/users/${user._id}`)
  .auth(adminToken, { type: 'bearer' }).send(body);
const changePassword = (session: Session, newPassword = NEW_PASSWORD, currentPassword = PASSWORD) =>
  request(app).post('/api/auth/change-password').auth(session.accessToken, { type: 'bearer' })
    .set('Cookie', session.cookie).send({ currentPassword, newPassword });
const registration = (password: string) => ({
  firstName: 'New', lastName: 'Player', email: 'new@auth.test', password,
});

async function expectRetired(session: Session): Promise<void> {
  await me(session).expect(401);
  await refresh(session).expect(401);
  // Version validation must independently reject an otherwise live database record.
  await RefreshToken.updateOne({ tokenHash: tokenHash(refreshToken(session)) }, { $set: { revokedAt: null } });
  await refresh(session).expect(401);
  const optional = await request(app).get('/optional-auth').auth(session.accessToken, { type: 'bearer' }).expect(200);
  expect(optional.body.authenticated).toBe(false);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pausePasswordVerification() {
  const paused = deferred();
  const release = deferred();
  const original = authService.verifyPassword;
  vi.spyOn(authService, 'verifyPassword').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    paused.resolve();
    await release.promise;
    return result;
  });
  return { paused, release };
}

beforeAll(async () => {
  if (!env.isTest || env.mongodbUri || process.env['NODE_ENV'] !== 'test') {
    throw new Error('Auth tests require the isolated test environment');
  }
  await connectDatabase();
  if (mongoose.connection.name !== 'tournament_platform_test') {
    throw new Error('Refusing to use a non-test database');
  }
  await Promise.all([User.init(), RefreshToken.init()]);
  passwordHash = await authService.hashPassword(PASSWORD);
  app = express();
  app.use(express.json({ limit: '1mb' }), cookieParser(), sanitizeRequest);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.get('/optional-auth', optionalAuth, (req, res) => res.json({ authenticated: Boolean(optionalUser(req)) }));
  app.use(errorHandler);
});

beforeEach(async () => {
  if (!env.isTest || mongoose.connection.name !== 'tournament_platform_test') {
    throw new Error('Refusing cleanup outside the isolated test database');
  }
  await Promise.all([User.deleteMany({}), RefreshToken.deleteMany({})]);
  [user, admin] = await User.create([
    { firstName: 'Player', lastName: 'One', email: 'player@auth.test', passwordHash, role: 'participant' },
    { firstName: 'Root', lastName: 'Admin', email: 'admin@auth.test', passwordHash, role: 'super_admin' },
  ]);
  adminToken = authService.signAccessToken(admin);
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await disconnectDatabase(); });

const invalidCases = [
  'malformed', 'forged', 'tampered', 'unsigned', 'HS384', 'HS512', 'expired', 'future',
  'wrong type', 'missing version', 'string version', 'negative version', 'fractional version',
  'unsafe version', 'wrong version', 'missing subject', 'invalid subject', 'no expiry', 'string payload',
] as const;

function invalidToken(type: 'access' | 'refresh', scenario: typeof invalidCases[number]): string {
  const payload: Record<string, unknown> = {
    sub: String(user._id), type, authVersion: 0, ...(type === 'refresh' ? { jti: crypto.randomUUID() } : {}),
  };
  const options: SignOptions = { algorithm: 'HS256', expiresIn: 300 };
  let secret: string | null = type === 'access' ? env.accessSecret : env.refreshSecret;
  switch (scenario) {
    case 'malformed': return 'not.a.jwt';
    case 'forged': secret = 'attacker-secret'; break;
    case 'unsigned': options.algorithm = 'none'; secret = null; break;
    case 'HS384': case 'HS512': options.algorithm = scenario; break;
    case 'expired': options.expiresIn = -1; break;
    case 'future': payload.nbf = Math.floor(Date.now() / 1000) + 3600; break;
    case 'wrong type': payload.type = type === 'access' ? 'refresh' : 'access'; break;
    case 'missing version': delete payload.authVersion; break;
    case 'string version': payload.authVersion = '0'; break;
    case 'negative version': payload.authVersion = -1; break;
    case 'fractional version': payload.authVersion = 0.5; break;
    case 'unsafe version': payload.authVersion = Number.MAX_SAFE_INTEGER + 1; break;
    case 'wrong version': payload.authVersion = 1; break;
    case 'missing subject': delete payload.sub; break;
    case 'invalid subject': payload.sub = 'not-an-object-id'; break;
    case 'no expiry': delete options.expiresIn; break;
    case 'string payload': return jwt.sign('not an object', secret, { algorithm: 'HS256' });
  }
  const token = secret === null
    ? jwt.sign(payload, null, { ...options, algorithm: 'none' })
    : jwt.sign(payload, secret, options);
  return scenario === 'tampered' ? `${token}x` : token;
}

describe('token verification', () => {
  it('requires credentials and rejects incorrect passwords', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).post('/api/auth/refresh').expect(401);
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'WrongPassword123' }).expect(401);
  });

  it.each(invalidCases)('rejects %s access tokens', async (scenario) => {
    await request(app).get('/api/auth/me').auth(invalidToken('access', scenario), { type: 'bearer' }).expect(401);
  });

  it.each(invalidCases)('rejects %s refresh tokens even with a live record', async (scenario) => {
    const token = invalidToken('refresh', scenario);
    const payload = claims(token);
    await RefreshToken.create({
      jti: payload?.jti ?? crypto.randomUUID(), userId: user._id, tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    });
    const response = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${token}`).expect(401);
    expect(response.headers['set-cookie']?.[0]).toContain('refresh_token=;');
    expect(await RefreshToken.countDocuments()).toBe(1);
  });

  it('rejects refresh claims without a jti', async () => {
    const token = jwt.sign({ sub: String(user._id), type: 'refresh', authVersion: 0 }, env.refreshSecret, { expiresIn: 300 });
    await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${token}`).expect(401);
  });

  it('signs HS256 versions but does not expose internal fields in user JSON', async () => {
    const session = await login();
    for (const token of [session.accessToken, refreshToken(session)]) {
      expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256');
      expect(claims(token).authVersion).toBe(0);
    }
    const response = await me(session).expect(200);
    expect(response.body.data.user).not.toHaveProperty('authVersion');
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    const defaultSelection = await User.findById(user._id);
    expect(defaultSelection?.authVersion).toBeUndefined();
    const internal = await User.findById(user._id).select('+authVersion +passwordHash');
    expect(internal?.toJSON()).not.toHaveProperty('authVersion');
    expect(internal?.toJSON()).not.toHaveProperty('passwordHash');
  });

  it('uses the current database role rather than the access claim', async () => {
    const token = jwt.sign({ sub: String(user._id), type: 'access', role: 'super_admin', authVersion: 0 }, env.accessSecret, { expiresIn: 300 });
    await request(app).get('/api/users').auth(token, { type: 'bearer' }).expect(403);
    const session = await login();
    const response = await updateUser({ role: 'admin' }).expect(200);
    expect(response.body.data).not.toHaveProperty('authVersion');
    await me(session).expect(401);
    const fresh = await login();
    expect((await me(fresh).expect(200)).body.data.user.role).toBe('admin');
    await request(app).get('/api/users').auth(fresh.accessToken, { type: 'bearer' }).expect(403);
  });

  it('keeps registration participant-only despite privileged fields', async () => {
    const response = await request(app).post('/api/auth/register').send({
      ...registration(PASSWORD), role: 'super_admin', authVersion: 99, isActive: false, passwordHash: 'injected',
    }).expect(201);
    expect(response.body.data.user.role).toBe('participant');
    const registered = await User.findById(response.body.data.user.id).select('+authVersion');
    expect(registered?.authVersion).toBe(0);
    expect(registered?.isActive).toBe(true);
    await request(app).get('/api/users').auth(response.body.data.accessToken, { type: 'bearer' }).expect(403);
  });

  it('supports fresh login for legacy documents but rejects pre-version tokens', async () => {
    await User.collection.updateOne({ _id: user._id }, { $unset: { authVersion: '' } });
    const session = await login();
    await me(session).expect(200);
    const preVersion = jwt.sign({ sub: String(user._id), type: 'access' }, env.accessSecret, { expiresIn: 300 });
    await request(app).get('/api/auth/me').auth(preVersion, { type: 'bearer' }).expect(401);
    await changePassword(session).expect(200);
    expect((await User.findById(user._id).select('+authVersion'))?.authVersion).toBe(1);
    await expectRetired(session);
    await login(NEW_PASSWORD);
  });
});

describe('session invalidation', () => {
  it('invalidates every session on self password change and explicitly requires login', async () => {
    const sessions = [await login(), await login()];
    const response = await changePassword(sessions[0]).expect(200);
    expect(response.body).toEqual({ success: true, data: { message: 'Password updated', requiresLogin: true } });
    expect(response.headers['set-cookie']?.[0]).toContain('refresh_token=;');
    expect(response.headers['set-cookie']?.[0]).toContain('Path=/api/auth');
    for (const session of sessions) await expectRetired(session);
    await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
    const fresh = await login(NEW_PASSWORD);
    expect(claims(fresh.accessToken).authVersion).toBe(1);
    await me(fresh).expect(200);
    await refresh(fresh).expect(200);
  });

  it('invalidates access and refresh sessions on administrator password reset', async () => {
    const session = await login();
    await updateUser({ password: NEW_PASSWORD }).expect(200);
    await expectRetired(session);
    const fresh = await login(NEW_PASSWORD);
    expect(claims(fresh.accessToken).authVersion).toBe(1);
    await refresh(fresh).expect(200);
  });

  it.each(['patch', 'delete'] as const)('does not resurrect sessions after %s disable and reactivation', async (method) => {
    const session = await login();
    if (method === 'patch') {
      await updateUser({ isActive: false }).expect(200);
    } else {
      await request(app).delete(`/api/users/${user._id}`).auth(adminToken, { type: 'bearer' }).expect(204);
    }
    await expectRetired(session);
    await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
    await updateUser({ isActive: true }).expect(200);
    await expectRetired(session);
    const fresh = await login();
    expect(claims(fresh.accessToken).authVersion).toBe(2);
    await refresh(fresh).expect(200);
  });

  it('invalidates tokens on both role promotion and demotion', async () => {
    const original = await login();
    await updateUser({ role: 'super_admin' }).expect(200);
    await expectRetired(original);
    const elevated = await login();
    await request(app).get('/api/users').auth(elevated.accessToken, { type: 'bearer' }).expect(200);
    await updateUser({ role: 'participant' }).expect(200);
    await expectRetired(elevated);
    const fresh = await login();
    await request(app).get('/api/users').auth(fresh.accessToken, { type: 'bearer' }).expect(403);
  });

  it('leaves sessions valid for ordinary profile changes', async () => {
    const session = await login();
    await updateUser({ firstName: 'Renamed' }).expect(200);
    await request(app).patch('/api/auth/me').auth(session.accessToken, { type: 'bearer' })
      .send({ lastName: 'Changed', authVersion: 100, role: 'super_admin' }).expect(200);
    const result = await me(session).expect(200);
    expect(result.body.data.user.role).toBe('participant');
    expect(result.body.data.user.lastName).toBe('Changed');
    await refresh(session).expect(200);
  });

  it('rejects login when a reset completes after old password verification', async () => {
    const { paused, release } = pausePasswordVerification();
    const pending = request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).then((res) => res);
    await paused.promise;
    try {
      await updateUser({ password: NEW_PASSWORD }).expect(200);
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    await login(NEW_PASSWORD);
  });

  it('cannot issue usable tokens if session insertion happens after reset and revocation', async () => {
    const paused = deferred();
    const release = deferred();
    const original = authService.createSession;
    vi.spyOn(authService, 'createSession').mockImplementationOnce(async (...args) => {
      paused.resolve();
      await release.promise;
      return original(...args);
    });
    const pending = request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).then((res) => res);
    await paused.promise;
    try {
      await updateUser({ password: NEW_PASSWORD }).expect(200);
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.status).toBe(200);
    const stale = sessionFrom(response);
    expect(claims(stale.accessToken).authVersion).toBe(0);
    expect(claims(refreshToken(stale)).authVersion).toBe(0);
    await expectRetired(stale);
    await login(NEW_PASSWORD);
  });

  it('does not overwrite an administrator reset with a concurrent self change', async () => {
    const session = await login();
    const { paused, release } = pausePasswordVerification();
    const pending = changePassword(session, 'SelfChanged789').then((res) => res);
    await paused.promise;
    try {
      await updateUser({ password: NEW_PASSWORD }).expect(200);
    } finally {
      release.resolve();
    }
    expect((await pending).status).toBe(401);
    expect((await User.findById(user._id).select('+authVersion'))?.authVersion).toBe(1);
    await login(NEW_PASSWORD);
    await expectRetired(session);
  });
});

describe('single-use refresh rotation', () => {
  it('allows exactly one concurrent winner and only one successor', async () => {
    const session = await login();
    const responses = await Promise.all(Array.from({ length: 8 }, () => refresh(session)));
    expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
    expect(responses.filter((res) => res.status === 401)).toHaveLength(7);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(2);
    expect(await RefreshToken.countDocuments({ userId: user._id, revokedAt: null })).toBe(1);
    const successor = sessionFrom(responses.find((res) => res.status === 200)!);
    expect(successor.cookie).not.toBe(session.cookie);
    await me(successor).expect(200);
    await refresh(session).expect(401);
    const next = sessionFrom(await refresh(successor).expect(200));
    await refresh(successor).expect(401);
    await refresh(next).expect(200);
  });

  it.each(['hash', 'jti', 'user', 'revocation', 'expiry'] as const)('matches %s atomically before rotating', async (field) => {
    const session = await login();
    const changes = {
      hash: { tokenHash: tokenHash('different') },
      jti: { jti: crypto.randomUUID() },
      user: { userId: admin._id },
      revocation: { revokedAt: new Date() },
      expiry: { expiresAt: new Date(Date.now() - 1000) },
    };
    await RefreshToken.updateOne({ tokenHash: tokenHash(refreshToken(session)) }, { $set: changes[field] });
    await refresh(session).expect(401);
    expect(await RefreshToken.countDocuments({ revokedAt: null, expiresAt: { $gt: new Date() }, userId: user._id }))
      .toBe(field === 'hash' || field === 'jti' ? 1 : 0);
  });

  it('revokes the logged-out refresh token and clears invalid cookies safely', async () => {
    const session = await login();
    await request(app).post('/api/auth/logout').set('Cookie', session.cookie).expect(204);
    await refresh(session).expect(401);
    const response = await request(app).post('/api/auth/logout').set('Cookie', 'refresh_token=bad').expect(204);
    expect(response.headers['set-cookie']?.[0]).toContain('refresh_token=;');
  });
});

describe('password byte limits', () => {
  const byteCases = [
    ['ASCII 71', `${'a'.repeat(70)}1`, 71], ['ASCII 72', `${'a'.repeat(71)}1`, 72], ['ASCII 73', `${'a'.repeat(72)}1`, 73],
    ['two-byte 71', `${'é'.repeat(34)}Ab1`, 71], ['two-byte 72', `${'é'.repeat(34)}Ab12`, 72], ['two-byte 73', `${'é'.repeat(35)}Ab1`, 73],
    ['three-byte 71', `${'ა'.repeat(23)}A1`, 71], ['three-byte 72', `${'ა'.repeat(23)}Ab1`, 72], ['three-byte 73', `${'ა'.repeat(23)}Ab12`, 73],
    ['four-byte 71', `${'\u{1F600}'.repeat(17)}Ab1`, 71], ['four-byte 72', `${'\u{1F600}'.repeat(17)}Ab12`, 72], ['four-byte 73', `${'\u{1F600}'.repeat(17)}Ab123`, 73],
  ] as const;

  it.each(byteCases)('checks registration at %s UTF-8 bytes', async (_label, password, bytes) => {
    expect(Buffer.byteLength(password, 'utf8')).toBe(bytes);
    const response = await request(app).post('/api/auth/register').send(registration(password)).expect(bytes <= 72 ? 201 : 422);
    if (bytes <= 72) {
      expect(response.body.data.user.role).toBe('participant');
    } else {
      expect(await User.countDocuments({ email: 'new@auth.test' })).toBe(0);
    }
  });

  it.each(['self change', 'admin reset', 'admin create'] as const)('applies the byte limit to %s', async (operation) => {
    const session = await login();
    const tooLong = `${'ა'.repeat(23)}Ab12`;
    const boundary = `${'ა'.repeat(23)}Ab1`;
    const perform = (password: string) => {
      if (operation === 'self change') return changePassword(session, password);
      if (operation === 'admin reset') return updateUser({ password });
      return request(app).post('/api/users').auth(adminToken, { type: 'bearer' }).send(registration(password));
    };
    await perform(tooLong).expect(422);
    expect((await User.findById(user._id).select('+authVersion'))?.authVersion).toBe(0);
    await me(session).expect(200);
    await perform(boundary).expect(operation === 'admin create' ? 201 : 200);
  });

  it('also prevents truncation for direct password hashing', async () => {
    await expect(authService.hashPassword(`${'é'.repeat(35)}Ab1`)).rejects.toMatchObject({ status: 422 });
  });

  it('preserves legacy long multibyte verification for login and current password', async () => {
    const legacyPassword = `${'ა'.repeat(23)}Ab12`;
    // Deliberately emulate the pre-fix stored hash, bypassing the new setter guard.
    await User.updateOne({ _id: user._id }, { $set: { passwordHash: await bcrypt.hash(legacyPassword, 4) } });
    const session = await login(legacyPassword);
    await changePassword(session, NEW_PASSWORD, legacyPassword).expect(200);
    await login(NEW_PASSWORD);
  });

  it('bounds login and current-password input without running bcrypt', async () => {
    const session = await login();
    const verify = vi.spyOn(authService, 'verifyPassword');
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'x'.repeat(201) }).expect(422);
    await changePassword(session, NEW_PASSWORD, 'x'.repeat(201)).expect(422);
    expect(verify).not.toHaveBeenCalled();
  });
});
