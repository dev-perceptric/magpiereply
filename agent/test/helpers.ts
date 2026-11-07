import { createHmac, randomBytes } from 'node:crypto';
import { createDb, migrate, type Db } from '../src/db.js';
import { encrypt, hashHookId, newHookId } from '../src/crypto.js';
import { enableInbox, upsertTeam } from '../src/repo.js';
import { TEST_DATABASE_URL } from './global-setup.js';

export const ENCRYPTION_KEY = randomBytes(32).toString('base64');

export async function freshDb(): Promise<Db> {
  const db = createDb(TEST_DATABASE_URL);
  await migrate(db);
  await db.query('truncate agent.teams restart identity cascade');
  return db;
}

export async function createTestTeam(db: Db, options: { accountId?: number; inboxId?: number } = {}) {
  const hookId = newHookId();
  const secret = 'bot-signing-secret';
  const teamId = await upsertTeam(db, {
    accountId: options.accountId ?? 1,
    name: 'Acme',
    hookIdHash: hashHookId(hookId),
    botId: 7,
    botTokenEnc: encrypt('bot-api-key', ENCRYPTION_KEY),
    botSecretEnc: encrypt(secret, ENCRYPTION_KEY),
  });
  await enableInbox(db, teamId, options.inboxId ?? 3);
  return { teamId, hookId, secret };
}

export function signedHeaders(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-chatwoot-timestamp': String(timestamp),
    'x-chatwoot-signature': `sha256=${signature}`,
  };
}

export function customerMessageEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    id: 101,
    message_type: 'incoming',
    private: false,
    content: 'I was charged twice for March',
    account: { id: 1 },
    inbox: { id: 3 },
    conversation: { id: 55 },
    ...overrides,
  };
}
