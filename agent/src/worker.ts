import { loadConfig } from './config.js';
import { createAppClient } from './chatwoot.js';
import { createDb, migrate } from './db.js';
import { handleTurn } from './jobs/turn.js';
import { startQueue, TURN_QUEUE, type TurnJob } from './queue.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);
const boss = await startQueue(config.DATABASE_URL);

await boss.work<TurnJob>(TURN_QUEUE, { localConcurrency: 4 }, async jobs => {
  for (const job of jobs) {
    await handleTurn(
      { db, encryptionKey: config.ENCRYPTION_KEY, appClientFor: token => createAppClient(config.APP_URL, token) },
      job,
    );
  }
});
console.log('[worker] waiting for turns');

async function shutdown(): Promise<void> {
  await boss.stop({ graceful: true });
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
