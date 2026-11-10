import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { initModels } from '../src/config/init.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { GameCategory } from '../src/modules/categories/category.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Registration } from '../src/modules/registrations/registration.model.js';
import { Setting } from '../src/modules/settings/setting.model.js';
import { Tournament } from '../src/modules/tournaments/tournament.model.js';
import { RefreshToken } from '../src/modules/auth/refresh-token.model.js';
import { User, type UserDocument } from '../src/modules/users/user.model.js';

const DAY = 86400000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

let app: Express;
let admin: UserDocument;
let organizer: UserDocument;
let adminToken = '';
let organizerToken = '';
let participantToken = '';
let chessId = '';

async function createUser(
  email: string,
  role: 'super_admin' | 'admin' | 'participant',
  password = 'Password123',
): Promise<UserDocument> {
  return User.create({
    firstName: role === 'participant' ? 'Test' : 'Admin',
    lastName: 'User',
    email,
    passwordHash: await hashPassword(password),
    role,
    isActive: true,
  });
}

async function login(email: string, password = 'Password123'): Promise<string> {
  const response = await request(app).post('/api/auth/login').send({ email, password });
  expect(response.status).toBe(200);
  return response.body.data.accessToken as string;
}

function tournamentPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: { ka: 'ტესტ ტურნირი', en: 'Test Open', ru: 'Тестовый турнир' },
    description: { ka: 'აღწერა', en: 'Description', ru: 'Описание' },
    categoryId: chessId,
    tournamentType: 'classical',
    format: 'swiss',
    startDate: iso(10),
    endDate: iso(11),
    registrationDeadline: iso(5),
    location: { venue: 'Chess Hall', city: 'Tbilisi', address: 'Main street 1' },
    isOnline: false,
    participantLimit: 8,
    entryFee: 0,
    publish: true,
    gameSettings: { rounds: 7, timeControl: { initialMinutes: 15, incrementSeconds: 10 } },
    ...overrides,
  };
}

function registrationPayload(email: string, overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Player',
    lastName: 'One',
    email,
    phone: '+995555000000',
    ...overrides,
  };
}

beforeAll(async () => {
  await connectDatabase();
  await initModels();
  app = createApp();
});

afterAll(async () => {
  await disconnectDatabase();
});

beforeEach(async () => {
  if (process.env['NODE_ENV'] !== 'test' || mongoose.connection.name !== 'tournament_platform_test') {
    throw new Error('Refusing cleanup outside the isolated test database');
  }
  await Promise.all([
    User.deleteMany({}),
    GameCategory.deleteMany({}),
    Tournament.deleteMany({}),
    Registration.deleteMany({}),
    Notification.deleteMany({}),
    RefreshToken.deleteMany({}),
    Setting.deleteMany({}),
  ]);
  admin = await createUser('admin@test.ge', 'super_admin');
  organizer = await createUser('organizer@test.ge', 'admin');
  await createUser('participant@test.ge', 'participant');
  adminToken = await login('admin@test.ge');
  organizerToken = await login('organizer@test.ge');
  participantToken = await login('participant@test.ge');

  const category = await GameCategory.create({
    name: { ka: 'ჭადრაკი', en: 'Chess', ru: 'Шахматы' },
    slug: 'chess',
    icon: 'pi pi-crown',
    isActive: true,
    configuration: {
      tournamentTypes: [{ value: 'classical', label: { ka: '', en: 'Classical', ru: '' } }],
      formats: [{ value: 'swiss', label: { ka: '', en: 'Swiss', ru: '' } }],
    },
    registrationFields: [],
  });
  chessId = String(category._id);
});

describe('Auth', () => {
  it('registers, logs in and returns the current user', async () => {
    const registration = await request(app).post('/api/auth/register').send({
      firstName: 'Nino',
      lastName: 'Test',
      email: 'nino@test.ge',
      password: 'Password123',
      phone: '+995555111222',
    });
    expect(registration.status).toBe(201);
    expect(registration.body.data.user.role).toBe('participant');

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${registration.body.data.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe('nino@test.ge');
  });

  it('rejects duplicate emails and wrong passwords', async () => {
    const duplicate = await request(app).post('/api/auth/register').send({
      firstName: 'A',
      lastName: 'B',
      email: 'admin@test.ge',
      password: 'Password123',
    });
    expect(duplicate.status).toBe(409);

    const badLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.ge', password: 'WrongPass123' });
    expect(badLogin.status).toBe(401);
  });

  it('rotates refresh tokens and invalidates them on logout', async () => {
    const agent = request.agent(app);
    const loginResponse = await agent
      .post('/api/auth/login')
      .send({ email: 'admin@test.ge', password: 'Password123' });
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers['set-cookie']?.[0]).toContain('refresh_token=');

    const refreshed = await agent.post('/api/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toBeTruthy();

    await agent.post('/api/auth/logout').expect(204);
    const afterLogout = await agent.post('/api/auth/refresh');
    expect(afterLogout.status).toBe(401);
  });

  it('records and exposes the last login timestamp to super admins', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.ge', password: 'Password123' });
    expect(response.status).toBe(200);
    expect(typeof response.body.data.user.lastLoginAt).toBe('string');

    const users = await request(app)
      .get('/api/users?limit=10')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(users.status).toBe(200);
    const adminRow = users.body.data.find(
      (user: { email: string }) => user.email === 'admin@test.ge',
    );
    expect(adminRow.lastLoginAt).toBeTruthy();
  });

  it('enforces RBAC on admin endpoints', async () => {
    const forbidden = await request(app)
      .get('/api/admin/dashboard/stats')
      .set('Authorization', `Bearer ${participantToken}`);
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .get('/api/admin/dashboard/stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(allowed.status).toBe(200);
  });
});

describe('Tournaments', () => {
  it('creates a published tournament and exposes it publicly', async () => {
    const created = await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(tournamentPayload());
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('published');
    expect(created.body.data.slug).toBeTruthy();

    const list = await request(app).get('/api/tournaments');
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].title.en).toBe('Test Open');

    const detail = await request(app).get(`/api/tournaments/${created.body.data.slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.gameSettings.timeControl.initialMinutes).toBe(15);
  });

  it('hides drafts from the public but shows them to the owner', async () => {
    const created = await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(tournamentPayload({ publish: false }));
    expect(created.status).toBe(201);

    const publicDetail = await request(app).get(`/api/tournaments/${created.body.data.slug}`);
    expect(publicDetail.status).toBe(404);

    const ownerDetail = await request(app)
      .get(`/api/tournaments/${created.body.data.slug}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(ownerDetail.status).toBe(200);
  });

  it('validates game settings through the chess module', async () => {
    const invalid = await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(tournamentPayload({ gameSettings: { rounds: 99 } }));
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('filters, sorts and paginates public tournaments', async () => {
    await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(tournamentPayload({ title: { ka: 'ა', en: 'Alpha Open', ru: 'Альфа' } }));
    await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(
        tournamentPayload({
          title: { ka: 'ბ', en: 'Beta Online', ru: 'Бета' },
          isOnline: true,
          location: { venue: '', city: '', address: '' },
          startDate: iso(20),
          endDate: iso(21),
          registrationDeadline: iso(10),
        }),
      );

    const search = await request(app).get('/api/tournaments?q=Alpha');
    expect(search.body.meta.total).toBe(1);

    const online = await request(app).get('/api/tournaments?online=true');
    expect(online.body.data[0].title.en).toBe('Beta Online');

    const paged = await request(app).get('/api/tournaments?limit=1&page=2&sort=upcoming');
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.meta.totalPages).toBe(2);

    const free = await request(app).get('/api/tournaments?fee=free');
    expect(free.body.meta.total).toBe(2);
  });

  it('prevents organizers from editing another organizer’s tournament', async () => {
    const created = await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(tournamentPayload());

    const response = await request(app)
      .patch(`/api/tournaments/${created.body.data.id}/status`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ status: 'cancelled' });
    expect(response.status).toBe(403);
  });

  it('duplicates and deletes tournaments', async () => {
    const created = await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(tournamentPayload());

    const duplicate = await request(app)
      .post(`/api/tournaments/${created.body.data.id}/duplicate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.data.status).toBe('draft');
    expect(duplicate.body.data.title.en).toContain('Copy');

    const removed = await request(app)
      .delete(`/api/tournaments/${created.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(removed.status).toBe(204);
  });
});

describe('Registrations', () => {
  async function createTournament(overrides: Record<string, unknown> = {}) {
    const response = await request(app)
      .post('/api/tournaments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(
        tournamentPayload({
          participantLimit: 2,
          registrationSettings: {
            requiresApproval: false,
            allowGuestRegistration: true,
            allowWaitlist: false,
            allowSelfCancellation: true,
          },
          ...overrides,
        }),
      );
    expect(response.status).toBe(201);
    return response.body.data;
  }

  it('accepts guest registrations and blocks duplicates', async () => {
    const tournament = await createTournament();
    const first = await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('guest1@test.ge'));
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('approved');

    const duplicate = await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('guest1@test.ge'));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_REGISTRATION');

    const refreshed = await Tournament.findById(tournament.id);
    expect(refreshed?.currentParticipants).toBe(1);
  });

  it('enforces capacity atomically and supports waitlisting', async () => {
    const tournament = await createTournament();
    await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('a@test.ge'));
    await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('b@test.ge'));

    const full = await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('c@test.ge'));
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('TOURNAMENT_FULL');

    const waitlistTournament = await createTournament({
      registrationSettings: {
        requiresApproval: false,
        allowGuestRegistration: true,
        allowWaitlist: true,
        allowSelfCancellation: true,
      },
    });
    for (const email of ['d@test.ge', 'e@test.ge']) {
      await request(app)
        .post(`/api/tournaments/${waitlistTournament.id}/register`)
        .send(registrationPayload(email));
    }
    const waitlisted = await request(app)
      .post(`/api/tournaments/${waitlistTournament.id}/register`)
      .send(registrationPayload('f@test.ge'));
    expect(waitlisted.status).toBe(201);
    expect(waitlisted.body.data.status).toBe('waitlisted');

    const stored = await Tournament.findById(waitlistTournament.id);
    expect(stored?.currentParticipants).toBe(2);
  });

  it('lets organizers approve and reject registrations with seat accounting', async () => {
    const tournament = await createTournament({
      registrationSettings: {
        requiresApproval: true,
        allowGuestRegistration: true,
        allowWaitlist: true,
        allowSelfCancellation: true,
      },
    });
    const registration = await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('pending@test.ge'));
    expect(registration.body.data.status).toBe('pending');

    let stored = await Tournament.findById(tournament.id);
    expect(stored?.currentParticipants).toBe(1);

    const approved = await request(app)
      .patch(`/api/registrations/${registration.body.data.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.reviewedAt).toBeTruthy();

    const rejected = await request(app)
      .patch(`/api/registrations/${registration.body.data.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'rejected' });
    expect(rejected.status).toBe(200);

    stored = await Tournament.findById(tournament.id);
    expect(stored?.currentParticipants).toBe(0);
  });

  it('supports participant self-cancellation and re-registration', async () => {
    const tournament = await createTournament();
    const first = await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .set('Authorization', `Bearer ${participantToken}`)
      .send(registrationPayload('participant@test.ge'));
    expect(first.status).toBe(201);

    const cancel = await request(app)
      .delete(`/api/registrations/${first.body.data.id}`)
      .set('Authorization', `Bearer ${participantToken}`);
    expect(cancel.status).toBe(204);

    const again = await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .set('Authorization', `Bearer ${participantToken}`)
      .send(registrationPayload('participant@test.ge'));
    expect(again.status).toBe(201);
  });

  it('lists, filters and exports participants', async () => {
    const tournament = await createTournament();
    await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('list1@test.ge', { firstName: 'Alpha' }));
    await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('list2@test.ge', { firstName: 'Beta' }));

    const listed = await request(app)
      .get(`/api/tournaments/${tournament.id}/registrations?q=Alpha`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listed.status).toBe(200);
    expect(listed.body.meta.total).toBe(1);
    expect(listed.body.meta.counts.all).toBe(2);
    expect(listed.body.meta.counts.approved).toBe(2);

    const exportResponse = await request(app)
      .get(`/api/tournaments/${tournament.id}/registrations/export`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers['content-type']).toContain('text/csv');
    expect(exportResponse.text).toContain('Registration number');
    expect(exportResponse.text).toContain('list1@test.ge');
  });

  it('exposes the participant’s own registrations and notifications', async () => {
    const tournament = await createTournament();
    await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .set('Authorization', `Bearer ${participantToken}`)
      .send(registrationPayload('participant@test.ge'));

    const mine = await request(app)
      .get('/api/registrations/my')
      .set('Authorization', `Bearer ${participantToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].tournamentId.title.en).toBe('Test Open');

    const notifications = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${participantToken}`);
    expect(notifications.status).toBe(200);
    expect(notifications.body.data.length).toBeGreaterThan(0);
    expect(notifications.body.meta.unreadCount).toBeGreaterThan(0);
  });

  it('looks up a guest registration by number and email', async () => {
    const tournament = await createTournament();
    const registration = await request(app)
      .post(`/api/tournaments/${tournament.id}/register`)
      .send(registrationPayload('lookup@test.ge'));

    const found = await request(app).get(
      `/api/registrations/lookup?number=${registration.body.data.registrationNumber}&email=lookup@test.ge`,
    );
    expect(found.status).toBe(200);
    expect(found.body.data.status).toBe('approved');

    const notFound = await request(app).get(
      `/api/registrations/lookup?number=WRONG&email=lookup@test.ge`,
    );
    expect(notFound.status).toBe(404);
  });
});
