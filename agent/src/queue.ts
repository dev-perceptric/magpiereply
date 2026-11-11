import { PgBoss } from 'pg-boss';

export const TURN_QUEUE = 'turn';
export const SYNC_QUEUE = 'sync_knowledge';
// Help center changes reach the brain within 15 minutes.
export const SYNC_SCHEDULE = '*/15 * * * *';

export const READ_QUEUE = 'read_source';
export const REFRESH_QUEUE = 'refresh_websites';
export const READ_RETRY_LIMIT = 2;
// Websites are read again once a day.
export const REFRESH_SCHEDULE = '17 3 * * *';

export interface SyncJob {
  // One team after its websites or files changed; all teams on the schedule.
  teamId?: number;
}

export interface ReadJob {
  sourceId: number;
}

export interface TurnJob {
  teamId: number;
  conversationId: number;
}

export async function startQueue(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', error => console.error('[queue]', error));
  await boss.start();
  // "stately" with a key per conversation: at most one waiting and one running turn per
  // conversation, so a burst of customer messages becomes a single turn.
  await boss.createQueue(TURN_QUEUE, {
    policy: 'stately',
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    expireInSeconds: 120,
  });
  // One sync at a time; a slow one simply delays the next.
  await boss.createQueue(SYNC_QUEUE, { policy: 'singleton', retryLimit: 2, retryDelay: 60, expireInSeconds: 600 });
  // At most one waiting and one running read per website or file. A crawl can take several minutes.
  await boss.createQueue(READ_QUEUE, { policy: 'stately', retryLimit: READ_RETRY_LIMIT, retryDelay: 120, retryBackoff: true, expireInSeconds: 1200 });
  await boss.createQueue(REFRESH_QUEUE, { policy: 'singleton', retryLimit: 1, expireInSeconds: 300 });
  return boss;
}

export function turnKey(job: TurnJob): string {
  return `${job.teamId}:${job.conversationId}`;
}

// Returns false when a turn for this conversation is already waiting; that turn will read the new message too.
export async function enqueueTurn(boss: PgBoss, job: TurnJob, delaySeconds: number): Promise<boolean> {
  const id = await boss.send(TURN_QUEUE, job, { singletonKey: turnKey(job), startAfter: delaySeconds });
  return id !== null;
}

export async function enqueueRead(boss: PgBoss, job: ReadJob): Promise<void> {
  await boss.send(READ_QUEUE, job, { singletonKey: String(job.sourceId) });
}

export async function enqueueSync(boss: PgBoss, job: SyncJob): Promise<void> {
  await boss.send(SYNC_QUEUE, job);
}
