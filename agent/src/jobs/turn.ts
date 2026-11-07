import type { Db } from '../db.js';
import type { AppClient } from '../chatwoot.js';
import { decrypt } from '../crypto.js';
import { finishRun, findTeam, recordStep, startRun } from '../repo.js';
import type { TurnJob } from '../queue.js';

const HISTORY_LIMIT = 20;

export interface TurnDeps {
  db: Db;
  encryptionKey: string;
  appClientFor: (botToken: string) => AppClient;
}

// Phase 0 turn: read the conversation and leave a private note proving the round trip works.
// Later phases replace the note with understanding, search, playbooks, tools and a reply.
export async function handleTurn(deps: TurnDeps, job: { id: string; data: TurnJob; retryCount?: number }): Promise<void> {
  const team = await findTeam(deps.db, job.data.teamId);
  if (!team || team.mode === 'off') return;

  const runId = await startRun(deps.db, {
    teamId: team.id,
    conversationId: job.data.conversationId,
    jobId: job.id,
    attempt: (job.retryCount ?? 0) + 1,
  });

  try {
    const app = deps.appClientFor(decrypt(team.botTokenEnc, deps.encryptionKey));

    const loadStart = Date.now();
    const messages = (await app.listMessages(team.accountId, job.data.conversationId)).slice(-HISTORY_LIMIT);
    const lastCustomerMessage = [...messages].reverse().find(message => isIncoming(message.message_type) && !message.private);
    await recordStep(deps.db, {
      runId,
      name: 'load_messages',
      input: { conversationId: job.data.conversationId },
      output: { count: messages.length, lastCustomerMessageId: lastCustomerMessage?.id ?? null },
      durationMs: Date.now() - loadStart,
    });

    const noteStart = Date.now();
    await app.createPrivateNote(team.accountId, job.data.conversationId, `Magpie received this (run #${runId}).`);
    await recordStep(deps.db, { runId, name: 'post_note', durationMs: Date.now() - noteStart });

    await finishRun(deps.db, runId, { status: 'done' });
  } catch (error) {
    await finishRun(deps.db, runId, { status: 'failed', error: (error as Error).message });
    throw error; // the queue retries with growing waits, then gives up and leaves it to people
  }
}

// The messages API returns message_type as a number (0 = incoming) and the webhook as a string.
function isIncoming(messageType: number | string): boolean {
  return messageType === 0 || messageType === 'incoming';
}
