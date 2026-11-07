import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { createHttpApp } from './http.js';
import { enqueueTurn, startQueue } from './queue.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);
const boss = await startQueue(config.DATABASE_URL);

const app = createHttpApp({
  db,
  encryptionKey: config.ENCRYPTION_KEY,
  enqueueTurn: job => enqueueTurn(boss, job, config.TURN_DELAY_SECONDS),
  healthCheck: async () => {
    await db.query('select 1');
  },
});

const server = serve({ fetch: app.fetch, port: config.PORT }, info => {
  console.log(`[api] listening on ${info.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await boss.stop({ graceful: true });
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
