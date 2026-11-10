import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs/promises';
import { env } from './env.js';

let memoryServer: import('mongodb-memory-server').MongoMemoryServer | null = null;

export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true);

  if (env.mongodbUri) {
    await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 8000 });
    console.log('[db] connected to MongoDB');
    return;
  }

  // Local-first development: an embedded MongoDB keeps data in server/data/mongo.
  // Production deployments must set MONGODB_URI (enforced in config/env.ts).
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const dbPath = path.resolve(process.cwd(), 'data', 'mongo');
  if (env.isTest) {
    memoryServer = await MongoMemoryServer.create({
      instance: { dbName: 'tournament_platform_test' },
    });
  } else {
    await fs.mkdir(dbPath, { recursive: true });
    memoryServer = await MongoMemoryServer.create({
      instance: { dbName: 'tournament_platform', dbPath, storageEngine: 'wiredTiger' },
    });
  }
  await mongoose.connect(memoryServer.getUri(env.isTest ? 'tournament_platform_test' : 'tournament_platform'));
  console.log('[db] connected to embedded MongoDB');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop({ doCleanup: false, force: false });
    memoryServer = null;
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
