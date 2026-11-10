import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs/promises';
import { env } from './env.js';

let memoryServer: import('mongodb-memory-server').MongoMemoryReplSet | null = null;

export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true);

  if (env.mongodbUri && !env.isTest) {
    await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 8000 });
    const topology = await mongoose.connection.db!.admin().command({ hello: 1 });
    if (!topology['setName'] && topology['msg'] !== 'isdbgrid') {
      await mongoose.disconnect();
      throw new Error('MongoDB must be a replica set or sharded cluster to support atomic registrations');
    }
    console.log('[db] connected to MongoDB');
    return;
  }

  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const dbName = env.isTest ? 'tournament_platform_test' : 'tournament_platform';
  const dbPath = path.resolve(process.cwd(), 'data', 'mongo');
  if (!env.isTest) {
    await fs.mkdir(dbPath, { recursive: true });
  }
  memoryServer = await MongoMemoryReplSet.create({
    replSet: { count: 1, dbName, storageEngine: 'wiredTiger' },
    instanceOpts: env.isTest ? [] : [{ dbPath }],
  });
  await mongoose.connect(memoryServer.getUri(dbName));
  console.log('[db] connected to embedded MongoDB replica set');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop({ doCleanup: env.isTest, force: false });
    memoryServer = null;
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
