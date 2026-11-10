import express, { type Express } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { initModels } from '../src/config/init.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { GameCategory } from '../src/modules/categories/category.model.js';
import { Tournament, type ITournament } from '../src/modules/tournaments/tournament.model.js';
import { tournamentsRouter } from '../src/modules/tournaments/tournament.routes.js';
import {
  listAdminTournaments,
  listPublicTournaments,
} from '../src/modules/tournaments/tournament.service.js';
import {
  adminTournamentQuerySchema,
  tournamentListQuerySchema,
  type TournamentListQuery,
} from '../src/modules/tournaments/tournament.validation.js';
import { User, type UserDocument } from '../src/modules/users/user.model.js';

// Test fixtures must never use a database URI loaded from the developer's environment.
vi.mock('../src/config/env.js', () => ({
  env: { nodeEnv: 'test', isTest: true, isProduction: false, mongodbUri: '' },
  cloudinaryEnabled: false,
}));

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 86400000;
const after = (milliseconds: number) => new Date(NOW.getTime() + milliseconds);
let app: Express;
let organizer: UserDocument;
let otherOrganizer: UserDocument;
let chessId: Types.ObjectId;
let goId: Types.ObjectId;

function fixture(slug: string, overrides: Partial<ITournament> = {}): Partial<ITournament> {
  return {
    slug,
    title: { ka: '', en: slug, ru: '' },
    categoryId: chessId,
    organizerId: organizer._id,
    tournamentType: 'classical',
    format: 'swiss',
    status: 'published',
    publishedAt: after(-DAY),
    startDate: after(10 * DAY),
    registrationDeadline: after(5 * DAY),
    participantLimit: 2,
    currentParticipants: 0,
    location: { venue: 'Main Hall', city: 'Tbilisi', address: '' },
    entryFee: 0,
    isOnline: false,
    ...overrides,
  };
}

async function expectPublic(query: Record<string, unknown>, expected: string[]) {
  const result = await listPublicTournaments(
    tournamentListQuerySchema.parse({ limit: 48, ...query }),
  );
  expect(result.items.map((item) => item.slug).sort()).toEqual([...expected].sort());
  expect(result.total).toBe(expected.length);
  return result;
}

beforeAll(async () => {
  await connectDatabase();
  await initModels();
  [organizer, otherOrganizer] = await User.create([
    {
      firstName: 'Nino',
      lastName: 'Gambit',
      email: 'nino@filter.test',
      passwordHash: 'unused',
      role: 'admin',
    },
    {
      firstName: 'Giorgi',
      lastName: 'Rook',
      email: 'giorgi@filter.test',
      passwordHash: 'unused',
      role: 'admin',
    },
  ]);
  const categories = await GameCategory.create([
    { slug: 'chess', name: { ka: 'ჭადრაკი', en: 'Chess', ru: 'Шахматы' } },
    { slug: 'go', name: { ka: 'გო', en: 'Go', ru: 'Го' } },
  ]);
  chessId = categories[0]._id;
  goId = categories[1]._id;
  app = express();
  app.use('/api/tournaments', tournamentsRouter);
  app.use(errorHandler);
});

beforeEach(async () => {
  await Tournament.deleteMany({});
  // Keep MongoDB/network timers real while making millisecond boundaries exact.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await disconnectDatabase();
});

describe('public tournament filters', () => {
  beforeEach(async () => {
    await Tournament.create([
      fixture('chess-free', {
        title: { ka: 'თბილისის ღია', en: 'Open [A+B]', ru: 'Открытый кубок' },
        isFeatured: true,
      }),
      fixture('chess-paid', {
        title: { ka: 'ბათუმის თასი', en: 'Night Blitz', ru: 'Ночной блиц' },
        organizerId: otherOrganizer._id,
        entryFee: 25,
        isOnline: true,
        location: { venue: 'Coastal Hall', city: 'Batumi', address: '' },
      }),
      fixture('go-free', {
        title: { ka: 'სტრატეგია', en: 'Strategy Cup', ru: 'Стратегия' },
        categoryId: goId,
        location: { venue: 'River Hall', city: 'New Tbilisi', address: '' },
      }),
      fixture('draft', { status: 'draft' }),
      fixture('cancelled', { status: 'cancelled' }),
      fixture('unpublished', { publishedAt: null }),
    ]);
  });

  it('lists only public, published records and returns pagination metadata', async () => {
    const response = await request(app).get('/api/tournaments').expect(200);
    expect(response.body.data.map((item: { slug: string }) => item.slug).sort()).toEqual([
      'chess-free',
      'chess-paid',
      'go-free',
    ]);
    expect(response.body.meta).toEqual({ page: 1, limit: 12, total: 3, totalPages: 1 });
  });

  it.each([
    [{ category: 'chess' }, ['chess-free', 'chess-paid']],
    [{ category: 'go' }, ['go-free']],
    [{ category: 'missing' }, []],
    [{ fee: 'free' }, ['chess-free', 'go-free']],
    [{ fee: 'paid' }, ['chess-paid']],
    [{ online: 'true' }, ['chess-paid']],
    [{ online: 'false' }, ['chess-free', 'go-free']],
    [{ city: '  tBiLiSi  ' }, ['chess-free']],
    [{ featured: 'true' }, ['chess-free']],
    [
      {
        category: 'chess',
        fee: 'free',
        online: 'false',
        city: 'Tbilisi',
        q: 'თბილისის',
        registrationStatus: 'open',
      },
      ['chess-free'],
    ],
    [{ category: 'chess', fee: 'paid', online: 'false' }, []],
  ] as const)('intersects filters %j', async (query, expected) => {
    await expectPublic(query, [...expected]);
  });

  it.each([
    ['  oPeN  ', ['chess-free']],
    ['თბილისის', ['chess-free']],
    ['ბათუმის', ['chess-paid']],
    ['открытый', ['chess-free']],
    ['coastal', ['chess-paid']],
    ['Batumi', ['chess-paid']],
    ['Giorgi', ['chess-paid']],
    ['Rook', ['chess-paid']],
    ['giorgi@filter.test', ['chess-paid']],
    ['[A+B]', ['chess-free']],
    ['.*', []],
  ] as const)(
    'searches localized titles, venue, city and organizer literally: %s',
    async (q, expected) => {
      await expectPublic({ q }, [...expected]);
    },
  );

  it('matches the complete city name and escapes regex metacharacters', async () => {
    await Tournament.create([
      fixture('literal-city', { location: { venue: '', city: 'City (West)', address: '' } }),
      fixture('regex-decoy', { location: { venue: '', city: 'City West', address: '' } }),
    ]);
    await expectPublic({ city: 'city (west)' }, ['literal-city']);
    await expectPublic({ city: '.*' }, []);
  });
});

const publicStatuses = ['published', 'ongoing', 'completed'] as const;
const registrationStatuses = ['open', 'closing_soon', 'full', 'closed'] as const;
const deadlines = { expired: -1, now: 0, soon: 3 * DAY - 1, boundary: 3 * DAY, future: 4 * DAY };
const capacities = { available: 1, full: 2, overfull: 3 };
const names = (statuses: readonly string[], times: readonly string[], seats: readonly string[]) =>
  statuses.flatMap((status) =>
    times.flatMap((time) => seats.map((seat) => `${status}-${time}-${seat}`)),
  );
const expectedRegistration = {
  open: names(['published', 'ongoing'], ['soon', 'boundary', 'future'], ['available']),
  closing_soon: names(['published', 'ongoing'], ['soon'], ['available']),
  full: names(['published', 'ongoing'], ['soon', 'boundary', 'future'], ['full', 'overfull']),
  closed: [
    ...names(['published', 'ongoing'], ['expired', 'now'], Object.keys(capacities)),
    ...names(['completed'], Object.keys(deadlines), Object.keys(capacities)),
  ],
};

describe('registration availability intersections', () => {
  beforeEach(async () => {
    await Tournament.create(
      publicStatuses.flatMap((status) =>
        Object.entries(deadlines).flatMap(([time, offset]) =>
          Object.entries(capacities).map(([seat, currentParticipants]) =>
            fixture(`${status}-${time}-${seat}`, {
              status,
              currentParticipants,
              registrationDeadline: after(offset),
            }),
          ),
        ),
      ),
    );
  });

  it.each(registrationStatuses)(
    'filters %s across deadline, lifecycle and capacity boundaries',
    async (registrationStatus) => {
      await expectPublic({ registrationStatus }, expectedRegistration[registrationStatus]);
    },
  );

  it.each(
    publicStatuses.flatMap((status) =>
      registrationStatuses.map((registrationStatus) => ({ status, registrationStatus })),
    ),
  )(
    'intersects explicit $status with $registrationStatus instead of replacing it',
    async ({ status, registrationStatus }) => {
      await expectPublic(
        { status, registrationStatus },
        expectedRegistration[registrationStatus].filter((slug) => slug.startsWith(`${status}-`)),
      );
    },
  );

  it('keeps search $or separate from closed-status $or', async () => {
    await expectPublic(
      { q: 'soon', registrationStatus: 'closed' },
      names(['completed'], ['soon'], Object.keys(capacities)),
    );
    await expectPublic(
      { q: 'now', status: 'published', registrationStatus: 'closed' },
      names(['published'], ['now'], Object.keys(capacities)),
    );
    await expectPublic({ q: 'soon', status: 'published', registrationStatus: 'closed' }, []);
  });

  it('keeps search and status constraints for open, closing_soon and full', async () => {
    await expectPublic({ q: 'boundary', status: 'ongoing', registrationStatus: 'open' }, [
      'ongoing-boundary-available',
    ]);
    await expectPublic({ q: 'boundary', registrationStatus: 'closing_soon' }, []);
    await expectPublic({ q: 'soon', status: 'ongoing', registrationStatus: 'full' }, [
      'ongoing-soon-full',
      'ongoing-soon-overfull',
    ]);
  });

  it.each(registrationStatuses)(
    'never exposes non-public or unpublished records through %s',
    async (registrationStatus) => {
      await Tournament.create([
        fixture('hidden-draft', { status: 'draft', registrationDeadline: after(-1) }),
        fixture('hidden-cancelled', { status: 'cancelled', registrationDeadline: after(DAY) }),
        fixture('hidden-unpublished', { publishedAt: null, registrationDeadline: after(DAY) }),
        fixture('hidden-completed', { status: 'completed', publishedAt: null }),
        fixture('hidden-full', { publishedAt: null, currentParticipants: 2 }),
      ]);
      await expectPublic({ registrationStatus }, expectedRegistration[registrationStatus]);
    },
  );
});

describe('UTC date bounds shared by public and admin filtering', () => {
  beforeEach(async () => {
    vi.stubEnv('TZ', 'Asia/Tbilisi');
    await Tournament.create([
      fixture('before', { startDate: new Date('2026-11-19T23:59:59.999Z') }),
      fixture('from', { startDate: new Date('2026-11-20T00:00:00.000Z') }),
      fixture('midday', { startDate: new Date('2026-11-20T12:00:00.000Z') }),
      fixture('to', { startDate: new Date('2026-11-21T23:59:59.999Z') }),
      fixture('after', { startDate: new Date('2026-11-22T00:00:00.000Z') }),
    ]);
  });

  it.each([
    [{ dateFrom: '2026-11-20', dateTo: '2026-11-21' }, ['from', 'midday', 'to']],
    [{ dateFrom: '2026-11-20', dateTo: '2026-11-20' }, ['from', 'midday']],
    [{ dateTo: '2026-11-21' }, ['before', 'from', 'midday', 'to']],
    [{ dateFrom: '2026-11-20' }, ['from', 'midday', 'to', 'after']],
  ] as const)(
    'includes whole UTC days for %j without mutating the query',
    async (raw, expected) => {
      const query = tournamentListQuerySchema.parse(raw);
      const originalTo = query.dateTo?.toISOString();
      for (const result of [
        await listPublicTournaments(query),
        await listAdminTournaments(organizer, query),
      ]) {
        expect(result.items.map((item) => item.slug).sort()).toEqual([...expected].sort());
        expect(result.total).toBe(expected.length);
      }
      expect(query.dateTo?.toISOString()).toBe(originalTo);
    },
  );
});

describe('stable pagination with tied sort fields', () => {
  beforeEach(async () => {
    // Deliberately insert out of ObjectId order; every primary sort field ties.
    await Tournament.insertMany(
      [6, 2, 5, 1, 4, 3].map((number) =>
        fixture(`tie-${number}`, {
          _id: new Types.ObjectId(number.toString(16).padStart(24, '0')),
          createdAt: after(-DAY),
          updatedAt: after(-DAY),
        }),
      ),
    );
  });

  it.each([
    ['newest', [6, 5, 4, 3, 2, 1]],
    ['oldest', [1, 2, 3, 4, 5, 6]],
    ['upcoming', [1, 2, 3, 4, 5, 6]],
    ['deadline', [1, 2, 3, 4, 5, 6]],
    ['popular', [6, 5, 4, 3, 2, 1]],
  ] satisfies [TournamentListQuery['sort'], number[]][])(
    'uses _id as the final %s sort key for public and admin pages',
    async (sort, expected) => {
      for (const list of [
        listPublicTournaments,
        (query: TournamentListQuery) => listAdminTournaments(organizer, query),
      ]) {
        const slugs: string[] = [];
        for (let page = 1; page <= 3; page += 1) {
          const query = tournamentListQuerySchema.parse({ sort, limit: 2, page });
          const result = await list(query);
          expect(result.total).toBe(6);
          expect(result.items).toHaveLength(2);
          slugs.push(...result.items.map((item) => item.slug));
          const repeated = await list(query);
          expect(repeated.items.map((item) => item.slug)).toEqual(
            result.items.map((item) => item.slug),
          );
        }
        expect(slugs).toEqual(expected.map((number) => `tie-${number}`));
        expect(new Set(slugs).size).toBe(6);
        const beyond = await list(tournamentListQuerySchema.parse({ sort, limit: 2, page: 4 }));
        expect(beyond.items).toEqual([]);
        expect(beyond.total).toBe(6);
      }
    },
  );
});

describe('list query validation', () => {
  it.each([
    ['page', '0'],
    ['page', '-1'],
    ['page', '1.5'],
    ['page', '10001'],
    ['page', 'NaN'],
    ['limit', '0'],
    ['limit', '49'],
    ['limit', '2.5'],
    ['status', 'draft'],
    ['status', 'cancelled'],
    ['registrationStatus', 'unknown'],
    ['online', 'yes'],
    ['fee', 'all'],
    ['featured', 'yes'],
    ['sort', 'random'],
    ['q', 'x'.repeat(121)],
    ['category', 'x'.repeat(81)],
    ['city', 'x'.repeat(121)],
    ['dateFrom', '2026-02-29'],
    ['dateTo', '2026-02-30'],
    ['dateFrom', '2100-02-29'],
    ['dateTo', '2026-04-31'],
    ['dateFrom', '2026-13-01'],
    ['dateTo', '2026-11-00'],
    ['dateFrom', '2026-1-01'],
    ['dateTo', '2026-11-20T12:00:00Z'],
    ['dateTo', 'invalid'],
  ])('rejects invalid %s query input %s with a validation response', async (key, value) => {
    const response = await request(app)
      .get('/api/tournaments')
      .query({ [key]: value })
      .expect(422);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: key })]),
    );
  });

  it('rejects reversed API intervals rather than silently swapping them', async () => {
    const response = await request(app)
      .get('/api/tournaments')
      .query({ dateFrom: '2026-11-21', dateTo: '2026-11-20' })
      .expect(422);
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'dateTo' })]),
    );
  });

  it.each(['2024-02-29', '2000-02-29', '2026-12-31'])(
    'accepts real calendar dates and same-day intervals: %s',
    async (date) => {
      const query = tournamentListQuerySchema.parse({ dateFrom: date, dateTo: date });
      expect(query.dateFrom?.toISOString()).toBe(`${date}T00:00:00.000Z`);
      expect(query.dateTo?.toISOString()).toBe(`${date}T00:00:00.000Z`);
      await request(app)
        .get('/api/tournaments')
        .query({ dateFrom: date, dateTo: date })
        .expect(200);
    },
  );

  it.each(['draft', 'cancelled'])(
    'admin safeExtend accepts %s while retaining the date refinement',
    (status) => {
      expect(adminTournamentQuerySchema.parse({ status }).status).toBe(status);
      const reversed = adminTournamentQuerySchema.safeParse({
        status,
        dateFrom: '2026-11-21',
        dateTo: '2026-11-20',
      });
      expect(reversed.success).toBe(false);
      if (!reversed.success) {
        expect(reversed.error.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: ['dateTo'] })]),
        );
      }
      expect(adminTournamentQuerySchema.safeParse({ status, dateTo: '2026-02-29' }).success).toBe(
        false,
      );
    },
  );
});
