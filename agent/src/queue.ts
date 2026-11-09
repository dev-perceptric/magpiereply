import { PgBoss } from 'pg-boss';

export const TURN_QUEUE = 'turn';
export const SYNC_QUEUE = 'sync_knowledge';
// Help center changes reach the brain within 15 minutes.
export const SYNC_SCHEDULE = '*/15 * * * *';

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
