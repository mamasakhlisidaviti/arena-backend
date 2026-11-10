import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { initModels } from '../src/config/init.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { GameCategory } from '../src/modules/categories/category.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Registration, SEAT_HOLDING_STATUSES } from '../src/modules/registrations/registration.model.js';
import { registrationsRouter } from '../src/modules/registrations/registration.routes.js';
import { Tournament, type ITournament } from '../src/modules/tournaments/tournament.model.js';
import { User, type UserDocument } from '../src/modules/users/user.model.js';

// Do not load dotenv or connect to any configured/persistent database.
vi.mock('../src/config/env.js', () => ({
  env: {
    nodeEnv: 'test', isTest: true, isProduction: false, mongodbUri: '',
    accessSecret: 'registration-security-test-secret',
  },
  cloudinaryEnabled: false,
}));

const DAY = 86400000;
const future = (days: number) => new Date(Date.now() + days * DAY);
let app: Express;
let organizer: UserDocument;
let participant: UserDocument;
let otherOrganizer: UserDocument;
let categoryId: mongoose.Types.ObjectId;
let organizerToken: string;
let participantToken: string;
let otherOrganizerToken: string;

function token(user: UserDocument): string {
  return jwt.sign({ sub: String(user._id), type: 'access' }, 'registration-security-test-secret');
}

async function tournament(overrides: Partial<ITournament> = {}) {
  return Tournament.create({
    title: { ka: 'თბილისის ღია', en: 'Security Open', ru: '' },
    slug: 'security-open', categoryId, organizerId: organizer._id,
    tournamentType: 'classical', format: 'swiss',
    status: 'published', publishedAt: new Date(),
    startDate: future(10), endDate: future(11), registrationDeadline: future(5),
    participantLimit: 2, currentParticipants: 0,
    registrationSettings: {
      requiresApproval: true, allowGuestRegistration: true,
      allowWaitlist: true, allowSelfCancellation: true,
    },
    ...overrides,
  });
}

function register(id: unknown, email: string, overrides: Record<string, unknown> = {}, auth?: string) {
  const req = request(app).post(`/api/tournaments/${String(id)}/register`);
  if (auth) req.set('Authorization', `Bearer ${auth}`);
  return req.send({ firstName: 'ნინო', lastName: 'Player', email, phone: '+995555000000', ...overrides });
}

function cancel(id: string) {
  return request(app).delete(`/api/registrations/${id}`).set('Authorization', `Bearer ${participantToken}`);
}

function update(id: string, status: string, notes?: string) {
  return request(app).patch(`/api/registrations/${id}/status`)
    .set('Authorization', `Bearer ${organizerToken}`).send({ status, notes });
}

async function expectSeats(id: mongoose.Types.ObjectId, expected: number) {
  const stored = await Tournament.findById(id).orFail();
  const actual = await Registration.countDocuments({ tournamentId: id, status: { $in: SEAT_HOLDING_STATUSES } });
  expect(stored.currentParticipants).toBe(actual);
  expect(actual).toBe(expected);
  expect(actual).toBeLessThanOrEqual(stored.participantLimit);
  expect(actual).toBeGreaterThanOrEqual(0);
}

function expectParticipantSafe(data: Record<string, unknown>) {
  for (const key of ['notes', 'reviewedBy', 'reviewedAt']) expect(data).not.toHaveProperty(key);
  expect(JSON.stringify(data)).not.toContain('INTERNAL_REVIEW_SENTINEL');
}

beforeAll(async () => {
  // Only cached MongoDB binaries may be used: this suite makes no external requests.
  vi.stubEnv('MONGOMS_RUNTIME_DOWNLOAD', 'false');
  await connectDatabase();
  if (mongoose.connection.name !== 'tournament_platform_test') {
    throw new Error('Refusing to use a non-isolated database');
  }
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error('Registration security tests require MongoMemoryReplSet');
  await initModels();
  [organizer, participant, otherOrganizer] = await User.create([
    { firstName: 'Owner', lastName: 'Organizer', email: 'owner@security.test', passwordHash: 'unused', role: 'admin' },
    { firstName: 'Self', lastName: 'Participant', email: 'self@security.test', passwordHash: 'unused', role: 'participant' },
    { firstName: 'Other', lastName: 'Organizer', email: 'other@security.test', passwordHash: 'unused', role: 'admin' },
  ]);
  const category = await GameCategory.create({
    slug: 'chess', name: { ka: 'ჭადრაკი', en: 'Chess', ru: '' }, registrationFields: [],
  });
  categoryId = category._id;
  organizerToken = token(organizer);
  participantToken = token(participant);
  otherOrganizerToken = token(otherOrganizer);
  app = express();
  app.use(express.json());
  app.use('/api', registrationsRouter);
  app.use(errorHandler);
});

beforeEach(async () => {
  if (process.env['NODE_ENV'] !== 'test' || mongoose.connection.name !== 'tournament_platform_test') {
    throw new Error('Refusing cleanup outside the isolated test database');
  }
  await Registration.deleteMany({});
  await Notification.deleteMany({});
  await Tournament.deleteMany({});
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await disconnectDatabase();
  vi.unstubAllEnvs();
});

describe('transactional registration capacity', () => {
  it('retries two simultaneous cancellations without releasing another participant’s seat', async () => {
    const event = await tournament();
    const first = await register(event._id, participant.email, {}, participantToken).expect(201);
    await register(event._id, 'second@security.test').expect(201);
    const responses = await Promise.all([cancel(first.body.data.id), cancel(first.body.data.id)]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    await expectSeats(event._id, 1);
    expect((await Registration.findById(first.body.data.id))?.status).toBe('cancelled');
    expect(await Notification.countDocuments({
      'data.registrationId': first.body.data.id, type: 'registration_cancelled',
    })).toBe(1);
  });

  it('re-evaluates seat ownership when cancellation races approval', async () => {
    const event = await tournament();
    const first = await register(event._id, participant.email, {}, participantToken).expect(201);
    await register(event._id, 'second@security.test').expect(201);
    const responses = await Promise.all([cancel(first.body.data.id), update(first.body.data.id, 'approved')]);
    expect(responses.map((response) => response.status)).toEqual([204, 200]);
    const stored = await Registration.findById(first.body.data.id).orFail();
    expect(['approved', 'cancelled']).toContain(stored.status);
    await expectSeats(event._id, stored.status === 'approved' ? 2 : 1);
    expect(await Notification.countDocuments({ 'data.registrationId': first.body.data.id })).toBe(3);
  });

  it.each(['pending', 'approved', 'waitlisted'])('rolls back duplicate-email restoration to %s after re-registration', async (status) => {
    const event = await tournament();
    const first = await register(event._id, participant.email, {}, participantToken).expect(201);
    await cancel(first.body.data.id).expect(204);
    await register(event._id, participant.email, {}, participantToken).expect(201);
    const before = await Notification.countDocuments({});
    const conflict = await update(first.body.data.id, status, 'must roll back').expect(409);
    expect(conflict.body.error.code).toBe('DUPLICATE_REGISTRATION');
    await expectSeats(event._id, 1);
    const original = await Registration.findById(first.body.data.id).orFail();
    expect(original.status).toBe('cancelled');
    expect(original.notes).toBe('');
    expect(original.reviewedAt).toBeNull();
    expect(await Notification.countDocuments({})).toBe(before);
  });

  it.each([false, true])('does not overbook concurrent creates (waitlist=%s)', async (allowWaitlist) => {
    const event = await tournament({
      registrationSettings: { requiresApproval: true, allowGuestRegistration: true, allowWaitlist, allowSelfCancellation: true },
    });
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => register(event._id, `player${index}@security.test`)));
    const accepted = responses.filter((response) => response.status === 201);
    expect(accepted.filter((response) => response.body.data.status === 'pending')).toHaveLength(2);
    expect(accepted.filter((response) => response.body.data.status === 'waitlisted')).toHaveLength(allowWaitlist ? 6 : 0);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(allowWaitlist ? 0 : 6);
    expect(responses.every((response) => response.status === 201 || response.body.error.code === 'TOURNAMENT_FULL')).toBe(true);
    await expectSeats(event._id, 2);
    expect(await Registration.countDocuments({})).toBe(allowWaitlist ? 8 : 2);
    expect(await Notification.countDocuments({})).toBe(allowWaitlist ? 8 : 2);
  });

  it('handles concurrent duplicate creates without a leaked seat or notification', async () => {
    const event = await tournament();
    const responses = await Promise.all([register(event._id, 'duplicate@security.test'), register(event._id, 'DUPLICATE@security.test')]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code).toBe('DUPLICATE_REGISTRATION');
    await expectSeats(event._id, 1);
    expect(await Registration.countDocuments({})).toBe(1);
    expect(await Notification.countDocuments({})).toBe(1);
  });

  it('approves pending entries without incrementing twice and serializes waitlist promotion', async () => {
    const event = await tournament();
    const a = await register(event._id, 'a@security.test').expect(201);
    const b = await register(event._id, 'b@security.test').expect(201);
    const c = await register(event._id, 'c@security.test').expect(201);
    const d = await register(event._id, 'd@security.test').expect(201);
    expect(c.body.data.status).toBe('waitlisted');
    const approvals = await Promise.all([update(a.body.data.id, 'approved'), update(a.body.data.id, 'approved')]);
    expect(approvals.map((response) => response.status)).toEqual([200, 200]);
    await expectSeats(event._id, 2);
    expect(await Notification.countDocuments({ 'data.registrationId': a.body.data.id, type: 'registration_approved' })).toBe(1);
    await update(b.body.data.id, 'rejected').expect(200);
    const promotions = await Promise.all([update(c.body.data.id, 'approved'), update(d.body.data.id, 'approved')]);
    expect(promotions.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(promotions.find((response) => response.status === 409)?.body.error.code).toBe('TOURNAMENT_FULL');
    await expectSeats(event._id, 2);
  });

  it('rolls back creation if notification persistence fails', async () => {
    const event = await tournament();
    vi.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('notification persistence failed'));
    await register(event._id, 'rollback@security.test').expect(500);
    await expectSeats(event._id, 0);
    expect(await Registration.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('rolls back cancellation and review if notification persistence fails', async () => {
    const event = await tournament();
    const first = await register(event._id, participant.email, {}, participantToken).expect(201);
    for (const change of [() => cancel(first.body.data.id), () => update(first.body.data.id, 'rejected', 'not committed')]) {
      vi.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('notification persistence failed'));
      await change().expect(500);
      await expectSeats(event._id, 1);
      const stored = await Registration.findById(first.body.data.id).orFail();
      expect(stored.status).toBe('pending');
      expect(stored.notes).toBe('');
      expect(stored.reviewedAt).toBeNull();
      expect(await Notification.countDocuments({})).toBe(1);
    }
  });
});

describe('registration eligibility and permissions', () => {
  it.each([
    { status: 'draft' }, { status: 'cancelled' }, { status: 'completed' },
    { publishedAt: null }, { registrationDeadline: new Date(0) },
  ] satisfies Partial<ITournament>[])('rejects public registration for %j without writes', async (overrides) => {
    const event = await tournament(overrides);
    const response = await register(event._id, 'closed@security.test').expect(409);
    expect(response.body.error.code).toBe('REGISTRATION_CLOSED');
    await expectSeats(event._id, 0);
    expect(await Registration.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('retains manual registration privileges without allowing other organizers to use them', async () => {
    const event = await tournament({ status: 'draft', publishedAt: null, registrationDeadline: new Date(0) });
    const payload = { firstName: 'Manual', lastName: 'Player', email: 'manual@security.test', phone: '+995555000000' };
    await request(app).post(`/api/tournaments/${event._id}/registrations`)
      .set('Authorization', `Bearer ${otherOrganizerToken}`).send(payload).expect(403);
    await expectSeats(event._id, 0);
    const response = await request(app).post(`/api/tournaments/${event._id}/registrations`)
      .set('Authorization', `Bearer ${organizerToken}`).send(payload).expect(201);
    expect(response.body.data.status).toBe('approved');
    expect(response.body.data.reviewedBy).toBe(String(organizer._id));
    expect(response.body.data.reviewedAt).toBeTruthy();
    await expectSeats(event._id, 1);
  });

  it('checks guest policy, self-cancellation policy and ownership without side effects', async () => {
    const event = await tournament({
      registrationSettings: { requiresApproval: false, allowGuestRegistration: false, allowWaitlist: true, allowSelfCancellation: false },
    });
    await register(event._id, 'guest@security.test').expect(401);
    const first = await register(event._id, participant.email, {}, participantToken).expect(201);
    expect(first.body.data.status).toBe('approved');
    await cancel(first.body.data.id).expect(403);
    await request(app).delete(`/api/registrations/${first.body.data.id}`)
      .set('Authorization', `Bearer ${otherOrganizerToken}`).expect(403);
    await request(app).patch(`/api/registrations/${first.body.data.id}/status`)
      .set('Authorization', `Bearer ${otherOrganizerToken}`).send({ status: 'rejected' }).expect(403);
    await Tournament.updateOne({ _id: event._id }, { $set: { 'registrationSettings.allowSelfCancellation': true, startDate: new Date(0) } });
    await cancel(first.body.data.id).expect(403);
    await expectSeats(event._id, 1);
    expect(await Notification.countDocuments({})).toBe(1);
  });

  it('will not allocate a restored seat in a completed tournament', async () => {
    const event = await tournament();
    const first = await register(event._id, participant.email, {}, participantToken).expect(201);
    await cancel(first.body.data.id).expect(204);
    await Tournament.updateOne({ _id: event._id }, { $set: { status: 'completed' } });
    const response = await update(first.body.data.id, 'approved').expect(409);
    expect(response.body.error.code).toBe('REGISTRATION_CLOSED');
    await expectSeats(event._id, 0);
  });
});

describe('participant response privacy', () => {
  it('omits internal fields from direct registration, public lookup, self list and self detail', async () => {
    const event = await tournament();
    const created = await register(event._id, participant.email, { notes: 'Participant’s own note' }, participantToken).expect(201);
    expectParticipantSafe(created.body.data);
    expect(created.body.data.registrationNumber).toMatch(/^[A-Z]+-\d{4}-[A-F0-9]{16}$/);
    const id = created.body.data.id;
    await update(id, 'approved', 'INTERNAL_REVIEW_SENTINEL').expect(200);
    const lookup = await request(app).get('/api/registrations/lookup')
      .query({ number: created.body.data.registrationNumber, email: participant.email.toUpperCase() }).expect(200);
    const mine = await request(app).get('/api/registrations/my').set('Authorization', `Bearer ${participantToken}`).expect(200);
    const detail = await request(app).get(`/api/registrations/${id}`).set('Authorization', `Bearer ${participantToken}`).expect(200);
    expect(mine.body.data).toHaveLength(1);
    for (const data of [lookup.body.data, mine.body.data[0], detail.body.data]) {
      expectParticipantSafe(data);
      expect(data.participantInformation.notes).toBe('Participant’s own note');
      expect(data.tournamentId.title.ka).toBe('თბილისის ღია');
      expect(data.id).toBe(id);
    }
    expect(lookup.body.data).not.toHaveProperty('userId');
    for (const path of [`/api/registrations/${id}`, `/api/tournaments/${event._id}/registrations`]) {
      const response = await request(app).get(path).set('Authorization', `Bearer ${organizerToken}`).expect(200);
      const data = Array.isArray(response.body.data) ? response.body.data[0] : response.body.data;
      expect(data.notes).toBe('INTERNAL_REVIEW_SENTINEL');
      expect(data.reviewedBy).toBe(String(organizer._id));
      expect(data.reviewedAt).toBeTruthy();
    }
    const guest = await register(event._id, 'guest@security.test').expect(201);
    expectParticipantSafe(guest.body.data);
  });
});

describe('spreadsheet-safe CSV exports', () => {
  it('preserves Georgian, escaped quotes/commas and numeric ratings while protecting phone strings', async () => {
    const event = await tournament();
    const first = await register(event._id, 'csv@security.test', { firstName: 'ნინო', lastName: 'Name, "Quoted"', rating: 2100 }).expect(201);
    await update(first.body.data.id, 'approved', 'შენიშვნა, "ტექსტი"').expect(200);
    const response = await request(app).get(`/api/tournaments/${event._id}/registrations/export`)
      .set('Authorization', `Bearer ${organizerToken}`).expect(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('security-open-participants.csv');
    expect(response.text).toContain('"ნინო"');
    expect(response.text).toContain('"Name, ""Quoted"""');
    expect(response.text).toContain('"შენიშვნა, ""ტექსტი"""');
    expect(response.text).toContain('"\'+995555000000"');
    expect(response.text).toContain('"2100"');
    expect(response.text).not.toContain("'2100");
  });

  it.each([
    '=HYPERLINK("https://example.invalid","Click")', '+SUM(1,2)', '-1+2', '@SUM(1,2)',
    '   =1+1', '\u00a0+1+1', '\u0000\u001f-1+1', '\u200b@SUM(1,2)',
    '\tPlain text', '\nPlain text', '\rPlain text', ' \t\n=1+1',
  ])('prefixes dangerous strings before CSV escaping: %j', async (value) => {
    const event = await tournament();
    const first = await register(event._id, 'formula@security.test').expect(201);
    // Raw collection updates preserve whitespace/control bytes in legacy stored data.
    await Registration.collection.updateOne({ _id: new mongoose.Types.ObjectId(first.body.data.id) }, {
      $set: { 'participantInformation.club': value, notes: value },
    });
    const response = await request(app).get(`/api/tournaments/${event._id}/registrations/export`)
      .set('Authorization', `Bearer ${organizerToken}`).expect(200);
    const escaped = `"'${value.replace(/"/g, '""')}"`;
    expect(response.text.split(escaped)).toHaveLength(3);
  });
});
