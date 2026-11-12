import { createHash, randomInt } from 'node:crypto';
import type { AppClient } from './chatwoot.js';
import type { Db } from './db.js';

// Email verification for customers who chat without signing in: Magpie emails a 6-digit code to the address they
// give, and once they type it back, this conversation counts as theirs for account lookups.

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
// Codes one conversation can ask for, so nobody uses Magpie to flood an inbox.
export const MAX_CODES_PER_CONVERSATION = 3;
const SIX_DIGITS = /(?<!\d)(\d{6})(?!\d)/;

function hashCode(teamId: number, conversationId: number, code: string): string {
  return createHash('sha256').update(`${teamId}:${conversationId}:${code}`).digest('hex');
}

export interface VerificationState {
  pendingEmail: string | null;
  verifiedEmail: string | null;
  codesSent: number;
}

export async function verificationState(db: Db, teamId: number, conversationId: number): Promise<VerificationState> {
  const result = await db.query<{ verify_email: string | null; verify_code_hash: string | null; verified_email: string | null; verify_sent: number }>(
    'select verify_email, verify_code_hash, verified_email, verify_sent from agent.conversations where team_id = $1 and conversation_id = $2',
    [teamId, conversationId],
  );
  const row = result.rows[0];
  return {
    pendingEmail: row?.verify_code_hash ? row.verify_email : null,
    verifiedEmail: row?.verified_email ?? null,
    codesSent: row?.verify_sent ?? 0,
  };
}

// Checks a 6-digit number in the customer's new messages against the code waiting for this conversation.
export async function checkCode(db: Db, teamId: number, conversationId: number, texts: string[]): Promise<'passed' | 'failed' | null> {
  const typed = texts.map(text => SIX_DIGITS.exec(text)?.[1]).find(Boolean);
  if (!typed) return null;
  const result = await db.query<{ verify_email: string; verify_code_hash: string; verify_expires_at: Date; verify_attempts: number }>(
    `select verify_email, verify_code_hash, verify_expires_at, verify_attempts from agent.conversations
     where team_id = $1 and conversation_id = $2 and verify_code_hash is not null`,
    [teamId, conversationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const fresh = row.verify_expires_at.getTime() > Date.now() && row.verify_attempts < MAX_ATTEMPTS;
  if (fresh && hashCode(teamId, conversationId, typed) === row.verify_code_hash) {
    await db.query(
      `update agent.conversations set verified_email = verify_email, verify_code_hash = null, verify_expires_at = null, verify_attempts = 0
       where team_id = $1 and conversation_id = $2`,
      [teamId, conversationId],
    );
    return 'passed';
  }
  const attempts = row.verify_attempts + 1;
  await db.query(
    `update agent.conversations set verify_attempts = $3::int,
       verify_code_hash = case when $3::int >= $4::int or verify_expires_at <= now() then null else verify_code_hash end
     where team_id = $1 and conversation_id = $2`,
    [teamId, conversationId, attempts, MAX_ATTEMPTS],
  );
  return 'failed';
}

// Emails a new code to the address the customer gave. Returns false when this conversation has asked for too many.
export async function sendCode(
  db: Db,
  app: AppClient,
  ids: { teamId: number; accountId: number },
  conversationId: number,
  email: string,
): Promise<boolean> {
  const state = await verificationState(db, ids.teamId, conversationId);
  if (state.codesSent >= MAX_CODES_PER_CONVERSATION) return false;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    `update agent.conversations set verify_email = $3, verify_code_hash = $4, verify_expires_at = now() + make_interval(mins => $5::int),
       verify_attempts = 0, verify_sent = verify_sent + 1
     where team_id = $1 and conversation_id = $2`,
    [ids.teamId, conversationId, email.toLowerCase(), hashCode(ids.teamId, conversationId, code), CODE_MINUTES],
  );
  await app.sendVerificationEmail(ids.accountId, email, code);
  return true;
}
