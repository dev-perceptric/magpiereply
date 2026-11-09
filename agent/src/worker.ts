import { loadConfig } from './config.js';
import { createAppClient } from './chatwoot.js';
import { createBrainClient } from './brain.js';
import { createDb, migrate } from './db.js';
import { syncKnowledge } from './jobs/sync-knowledge.js';
import { handleTurn } from './jobs/turn.js';
import { startQueue, SYNC_QUEUE, SYNC_SCHEDULE, TURN_QUEUE, type TurnJob } from './queue.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);
const boss = await startQueue(config.DATABASE_URL);
const brain = config.BRAIN_URL && config.BRAIN_API_KEY ? createBrainClient(config.BRAIN_URL, config.BRAIN_API_KEY) : undefined;

await boss.work<TurnJob>(TURN_QUEUE, { localConcurrency: 4 }, async jobs => {
  for (const job of jobs) {
    await handleTurn(
      { db, encryptionKey: config.ENCRYPTION_KEY, appClientFor: token => createAppClient(config.APP_URL, token), brain },
      job,
    );
  }
});
if (brain) {
  const appClientFor = (token: string) => createAppClient(config.APP_URL, token);
  await boss.work(SYNC_QUEUE, async () => {
    const results = await syncKnowledge({
      db,
      encryptionKey: config.ENCRYPTION_KEY,
      appClientFor,
      brain,
      publicAppUrl: config.APP_PUBLIC_URL ?? config.APP_URL,
    });
    for (const result of results.filter(team => team.changed)) {
      console.log(`[sync] team ${result.teamId}: ${result.articles} help articles sent to the brain`);
    }
  });
  await boss.schedule(SYNC_QUEUE, SYNC_SCHEDULE);
  await boss.send(SYNC_QUEUE, {}); // once now, so a fresh start doesn't wait 15 minutes
}

console.log(`[worker] waiting for turns${brain ? ', drafting with the brain, syncing help centers' : ''}`);

async function shutdown(): Promise<void> {
  await boss.stop({ graceful: true });
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
