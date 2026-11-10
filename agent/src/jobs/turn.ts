import type { Db } from '../db.js';
import type { AppClient, AppConversation, AppMessage } from '../chatwoot.js';
import type { BrainClient, BrainTurnResult } from '../brain.js';
import { decrypt } from '../crypto.js';
import { finishRun, findTeam, getConversationState, recordStep, saveConversationState, saveDraft, startRun } from '../repo.js';
import type { TurnJob } from '../queue.js';

const HISTORY_LIMIT = 20;
const EMAIL_CHANNEL = 'Channel::Email';

export interface TurnDeps {
  db: Db;
  encryptionKey: string;
  appClientFor: (botToken: string) => AppClient;
  // Without a brain, a turn only posts a "received" note (week 1).
  brain?: BrainClient;
}

// One turn: read the conversation, send it to the brain when the customer wrote something new, and post its draft
// as a private note (Draft mode). Nothing reaches the customer in phase 0.
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
    const lastCustomerMessage = [...messages].reverse().find(isCustomerMessage);
    await recordStep(deps.db, {
      runId,
      name: 'load_messages',
      input: { conversationId: job.data.conversationId },
      output: { count: messages.length, lastCustomerMessageId: lastCustomerMessage?.id ?? null },
      durationMs: Date.now() - loadStart,
    });

    if (deps.brain) {
      await draftWithBrain(deps, deps.brain, app, { teamId: team.id, accountId: team.accountId, runId }, job.data.conversationId, messages);
    } else {
      const noteStart = Date.now();
      await app.createPrivateNote(team.accountId, job.data.conversationId, `Magpie received this (run #${runId}).`);
      await recordStep(deps.db, { runId, name: 'post_note', durationMs: Date.now() - noteStart });
    }

    await finishRun(deps.db, runId, { status: 'done' });
  } catch (error) {
    await finishRun(deps.db, runId, { status: 'failed', error: (error as Error).message });
    throw error; // the queue retries with growing waits, then gives up and leaves it to people
  }
}

async function draftWithBrain(
  deps: TurnDeps,
  brain: BrainClient,
  app: AppClient,
  ids: { teamId: number; accountId: number; runId: number },
  conversationId: number,
  messages: AppMessage[],
): Promise<void> {
  let state = await getConversationState(deps.db, ids.teamId, conversationId);

  // A draft from an earlier try that didn't get posted: post it before anything new.
  if (state.pendingNote) {
    await postNote(deps, app, ids, conversationId, state.pendingNote);
    state = { ...state, pendingNote: null };
    await saveConversationState(deps.db, ids.teamId, conversationId, state);
  }

  const fresh = messages.filter(message => isCustomerMessage(message) && message.id > state.lastMessageId && message.content);
  if (state.handedOff || fresh.length === 0) {
    await recordStep(deps.db, {
      runId: ids.runId,
      name: 'skip',
      output: { reason: state.handedOff ? 'with_people' : 'no_new_messages' },
      durationMs: 0,
    });
    return;
  }

  const conversation = await app.getConversation(ids.accountId, conversationId);
  const brainStart = Date.now();
  const result = await brain.runTurn({
    team_id: String(ids.teamId),
    customer: customerOf(conversation),
    history: historyOf(messages),
  });
  await recordStep(deps.db, {
    runId: ids.runId,
    name: 'brain',
    input: { messageIds: fresh.map(message => message.id) },
    output: {
      reply: result.reply,
      tools: result.tools.map(tool => tool.name),
      proposals: result.proposals,
      handoff: result.handoff,
      seconds: result.seconds,
      costUsd: result.cost_usd,
    },
    durationMs: Date.now() - brainStart,
    tokensIn: (result.tokens.input_tokens ?? 0) + (result.tokens.cached_input_tokens ?? 0),
    tokensOut: result.tokens.output_tokens ?? 0,
  });

  // Save first, so a retry never sends these messages to the brain twice.
  await saveDraft(deps.db, {
    teamId: ids.teamId,
    conversationId,
    runId: ids.runId,
    reply: result.reply,
    proposals: result.proposals,
    handoff: result.handoff,
  });
  const note = draftNote(result, ids.runId);
  state = {
    lastMessageId: Math.max(...fresh.map(message => message.id)),
    pendingNote: note,
    handedOff: Boolean(result.handoff),
  };
  await saveConversationState(deps.db, ids.teamId, conversationId, state);

  await postNote(deps, app, ids, conversationId, note);
  await saveConversationState(deps.db, ids.teamId, conversationId, { ...state, pendingNote: null });
  // Draft mode: people answer, so the conversation belongs in their Open view, not Pending.
  if (conversation.status === 'pending') await app.openConversation(ids.accountId, conversationId);
}

async function postNote(
  deps: TurnDeps,
  app: AppClient,
  ids: { accountId: number; runId: number },
  conversationId: number,
  note: string,
): Promise<void> {
  const noteStart = Date.now();
  await app.createPrivateNote(ids.accountId, conversationId, note);
  await recordStep(deps.db, { runId: ids.runId, name: 'post_note', durationMs: Date.now() - noteStart });
}

// Only a widget identity check or the email channel's sender counts as verified. Never the message text.
export function customerOf(conversation: AppConversation): {
  id: string;
  name: string;
  email: string | null;
  verified: boolean;
} {
  const sender = conversation.meta.sender ?? {};
  const email = sender.email ?? null;
  const verified = Boolean(email) && (conversation.meta.hmac_verified === true || conversation.meta.channel === EMAIL_CHANNEL);
  return { id: String(sender.id ?? `conversation-${conversation.id}`), name: sender.name || 'Customer', email, verified };
}

export function draftNote(result: BrainTurnResult, runId: number): string {
  const lines = [`Magpie draft (run #${runId}):`, '', result.reply ?? '(no reply)'];
  for (const proposal of result.proposals) {
    const who = proposal.approval === 'staff_approves' ? 'needs a teammate to approve' : 'needs the customer to confirm';
    lines.push('', `Proposed refund: ${proposal.amount} for ${proposal.charge_id}, ${who}.`);
  }
  if (result.handoff) {
    lines.push('', `Suggested handoff to ${result.handoff.team}: ${result.handoff.reason}`);
  }
  return lines.join('\n');
}

// The conversation as the customer saw it, for the engine: customer messages and replies sent to them, oldest
// first. Private notes (Magpie's own drafts included) and activity messages stay out. The engine needs the
// history to end on the customer, so a trailing reply is dropped.
export function historyOf(messages: AppMessage[]): Array<{ role: 'customer' | 'agent'; content: string }> {
  const history = messages
    .filter(message => !message.private && message.content && (isCustomerMessage(message) || isOutgoing(message)))
    .map(message => ({ role: isCustomerMessage(message) ? ('customer' as const) : ('agent' as const), content: message.content ?? '' }));
  while (history.length > 0 && history[history.length - 1]!.role === 'agent') history.pop();
  return history;
}

// The messages API returns message_type as a number (0 = incoming, 1 = outgoing) and the webhook as a string.
function isCustomerMessage(message: AppMessage): boolean {
  return (message.message_type === 0 || message.message_type === 'incoming') && !message.private;
}

function isOutgoing(message: AppMessage): boolean {
  return message.message_type === 1 || message.message_type === 'outgoing';
}
