import { loadConfig } from './config.js';
import { createAppClient } from './chatwoot.js';
import { createBrainClient } from './brain.js';
import { createDb, migrate } from './db.js';
import { createReaderClient } from './reader.js';
import { readSource } from './jobs/read-source.js';
import { runReplay } from './jobs/replay.js';
import { syncKnowledge } from './jobs/sync-knowledge.js';
import { handleTurn } from './jobs/turn.js';
import { websitesDueForRead } from './sources.js';
import {
  enqueueRead,
  enqueueSync,
  READ_QUEUE,
  READ_RETRY_LIMIT,
  REFRESH_QUEUE,
  REFRESH_SCHEDULE,
  REPLAY_QUEUE,
  startQueue,
  SYNC_QUEUE,
  SYNC_SCHEDULE,
  TURN_QUEUE,
  type ReadJob,
  type ReplayJob,
  type SyncJob,
  type TurnJob,
} from './queue.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
await migrate(db);
const boss = await startQueue(config.DATABASE_URL);
const brain = config.BRAIN_URL && config.BRAIN_API_KEY ? createBrainClient(config.BRAIN_URL, config.BRAIN_API_KEY) : undefined;

await boss.work<TurnJob>(TURN_QUEUE, { localConcurrency: 4 }, async jobs => {
  for (const job of jobs) {
    await handleTurn(
      {
        db,
        encryptionKey: config.ENCRYPTION_KEY,
        appClientFor: token => createAppClient(config.APP_URL, token),
        brain,
        apps: { publicUrl: config.PUBLIC_URL, env: process.env },
        verificationEmails: config.VERIFICATION_EMAILS === 'on',
      },
      job,
    );
  }
});
if (brain) {
  const appClientFor = (token: string) => createAppClient(config.APP_URL, token);
  await boss.work<SyncJob>(SYNC_QUEUE, async jobs => {
    for (const job of jobs) {
      const results = await syncKnowledge(
        { db, encryptionKey: config.ENCRYPTION_KEY, appClientFor, brain, publicAppUrl: config.APP_PUBLIC_URL ?? config.APP_URL },
        job.data.teamId,
      );
      for (const result of results.filter(team => team.changed)) {
        console.log(`[sync] team ${result.teamId}: ${result.articles} articles and pages sent to the brain`);
      }
    }
  });
  await boss.schedule(SYNC_QUEUE, SYNC_SCHEDULE);
  await boss.work<ReplayJob>(REPLAY_QUEUE, async jobs => {
    for (const job of jobs) {
      await runReplay(
        { db, encryptionKey: config.ENCRYPTION_KEY, appClientFor, brain, apps: { publicUrl: config.PUBLIC_URL, env: process.env } },
        job.data.evalRunId,
      );
    }
  });
  await boss.send(SYNC_QUEUE, {}); // once now, so a fresh start doesn't wait 15 minutes
}
if (config.READER_URL && config.READER_API_KEY) {
  const reader = createReaderClient(config.READER_URL, config.READER_API_KEY);
  // One read at a time: Docling can use a lot of memory on a long PDF.
  await boss.work<ReadJob>(READ_QUEUE, { localConcurrency: 1 }, async jobs => {
    for (const job of jobs) {
      const finalTry = job.retryCount >= READ_RETRY_LIMIT;
      await readSource({ db, reader, syncTeam: teamId => enqueueSync(boss, { teamId }) }, job.data.sourceId, finalTry);
    }
  });
  await boss.work(REFRESH_QUEUE, async () => {
    for (const website of await websitesDueForRead(db)) await enqueueRead(boss, { sourceId: website.id });
  });
  await boss.schedule(REFRESH_QUEUE, REFRESH_SCHEDULE);
}

console.log(
  `[worker] waiting for turns${brain ? ', drafting with the brain, syncing help centers' : ''}${config.READER_URL ? ', reading websites and files' : ''}`,
);

async function shutdown(): Promise<void> {
  await boss.stop({ graceful: true });
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
