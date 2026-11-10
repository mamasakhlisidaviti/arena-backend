import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { isTest: true, mongodbUri: 'mongodb://application.invalid/live' },
  connect: vi.fn(),
  disconnect: vi.fn(),
  command: vi.fn(),
  create: vi.fn(),
  mkdir: vi.fn(),
  stop: vi.fn(),
  getUri: vi.fn(),
}));

vi.mock('../src/config/env.js', () => ({ env: mocks.env }));
vi.mock('mongoose', () => ({
  default: {
    set: vi.fn(), connect: mocks.connect, disconnect: mocks.disconnect,
    connection: { readyState: 1, db: { admin: () => ({ command: mocks.command }) } },
  },
}));
vi.mock('mongodb-memory-server', () => ({ MongoMemoryReplSet: { create: mocks.create } }));
vi.mock('node:fs/promises', () => ({ default: { mkdir: mocks.mkdir } }));

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.isTest = true;
  mocks.env.mongodbUri = 'mongodb://application.invalid/live';
  mocks.getUri.mockReturnValue('mongodb://127.0.0.1:12345/tournament_platform_test');
  mocks.create.mockResolvedValue({ getUri: mocks.getUri, stop: mocks.stop });
  mocks.command.mockResolvedValue({ setName: 'rs0' });
});

describe('database isolation and transaction requirements', () => {
  it('never selects the application URI in test mode', async () => {
    await connectDatabase();
    expect(mocks.create).toHaveBeenCalledWith({
      replSet: { count: 1, dbName: 'tournament_platform_test', storageEngine: 'wiredTiger' },
      instanceOpts: [],
    });
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith('mongodb://127.0.0.1:12345/tournament_platform_test');
    expect(mocks.mkdir).not.toHaveBeenCalled();
    await disconnectDatabase();
    expect(mocks.stop).toHaveBeenCalledWith({ doCleanup: true, force: false });
  });

  it('rejects an external standalone MongoDB before serving traffic', async () => {
    mocks.env.isTest = false;
    mocks.command.mockResolvedValue({ isWritablePrimary: true });
    await expect(connectDatabase()).rejects.toThrow('replica set or sharded cluster');
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([{ setName: 'production' }, { msg: 'isdbgrid' }])('accepts transaction-capable topology %j', async (topology) => {
    mocks.env.isTest = false;
    mocks.command.mockResolvedValue(topology);
    await connectDatabase();
    expect(mocks.connect).toHaveBeenCalledWith(mocks.env.mongodbUri, { serverSelectionTimeoutMS: 8000 });
    expect(mocks.create).not.toHaveBeenCalled();
    await disconnectDatabase();
  });
});
