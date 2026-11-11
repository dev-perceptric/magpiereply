import type { Db } from '../db.js';
import type { AppClient, AppConversation, AppMessage } from '../chatwoot.js';
import type { BrainClient, BrainTurnResult } from '../brain.js';
import { decrypt } from '../crypto.js';
import {
  closeDraft,
  finishRun,
  findTeam,
  getConversationState,
  recordStep,
  saveConversationState,
  saveDraft,
  startRun,
  type ConversationState,
  type Team,
} from '../repo.js';
import type { TurnJob } from '../queue.js';
import { addRunCost, countAutoReply, getFlag, MAX_AUTO_REPLIES, monthSpend } from '../trust.js';

const HISTORY_LIMIT = 20;
const EMAIL_CHANNEL = 'Channel::Email';

export interface TurnDeps {
  db: Db;
  encryptionKey: string;
  appClientFor: (botToken: string) => AppClient;
  // Without a brain, a turn only posts a "received" note (week 1).
  brain?: BrainClient;
}

// One turn: read the conversation and, when the customer wrote something new, ask the brain. In Draft mode the reply
// becomes a draft for a teammate. In Auto mode Magpie sends it itself, but only when the fact check passed, nothing
// looked like an attack and no money is involved; everything else stays a draft and goes to people.
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

    if (await getFlag(deps.db, 'all_paused')) {
      await recordStep(deps.db, { runId, name: 'skip', output: { reason: 'paused' }, durationMs: 0 });
      // In Auto mode the conversation may be waiting in Pending; people need to see it.
      if (team.mode === 'auto') await app.openConversation(team.accountId, job.data.conversationId);
    } else if (deps.brain) {
      await answerWithBrain(deps, deps.brain, app, { team, runId }, job.data.conversationId, messages);
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

async function answerWithBrain(
  deps: TurnDeps,
  brain: BrainClient,
  app: AppClient,
  ctx: { team: Team; runId: number },
  conversationId: number,
  messages: AppMessage[],
): Promise<void> {
  const { team, runId } = ctx;
  const ids = { teamId: team.id, accountId: team.accountId, runId };
  let state = await getConversationState(deps.db, team.id, conversationId);

  // Work an earlier try saved but didn't finish: a reply to send, then a note to post. Each goes out once.
  if (state.pendingReply) {
    await sendAutoReply(deps, app, ids, conversationId, state.pendingReply, state.pendingReplyDraftId ?? null);
    state = { ...state, pendingReply: null, pendingReplyDraftId: null, autoReplies: (state.autoReplies ?? 0) + 1 };
    await saveConversationState(deps.db, team.id, conversationId, state);
  }
  if (state.pendingNote) {
    await postNote(deps, app, ids, conversationId, state.pendingNote);
    state = { ...state, pendingNote: null };
    await saveConversationState(deps.db, team.id, conversationId, state);
  }

  const fresh = messages.filter(message => isCustomerMessage(message) && message.id > state.lastMessageId && message.content);
  if (state.handedOff || fresh.length === 0) {
    await recordStep(deps.db, { runId, name: 'skip', output: { reason: state.handedOff ? 'with_people' : 'no_new_messages' }, durationMs: 0 });
    return;
  }
  const lastMessageId = Math.max(...fresh.map(message => message.id));
  const auto = team.mode === 'auto' && !(await getFlag(deps.db, 'auto_paused'));

  if ((await monthSpend(deps.db, team.id)) >= team.monthlyCapUsd) {
    await recordStep(deps.db, { runId, name: 'skip', output: { reason: 'monthly_limit', capUsd: team.monthlyCapUsd }, durationMs: 0 });
    await saveConversationState(deps.db, team.id, conversationId, { ...state, lastMessageId });
    if (team.mode === 'auto') {
      await handToPeople(deps, app, ids, conversationId, `Magpie reached this month's limit of $${team.monthlyCapUsd}, so a person needs to answer.`);
    }
    return;
  }

  // Two answers of its own and the customer is still writing: that's for a person.
  if (auto && (state.autoReplies ?? 0) >= MAX_AUTO_REPLIES) {
    await recordStep(deps.db, { runId, name: 'skip', output: { reason: 'two_tries' }, durationMs: 0 });
    await saveConversationState(deps.db, team.id, conversationId, { ...state, lastMessageId, handedOff: true });
    await handToPeople(deps, app, ids, conversationId, `Magpie answered ${MAX_AUTO_REPLIES} times and the customer is still writing. Over to you.`);
    return;
  }

  const conversation = await app.getConversation(team.accountId, conversationId);
  const brainStart = Date.now();
  const result = await brain.runTurn({
    team_id: String(team.id),
    customer: customerOf(conversation),
    history: historyOf(messages),
  });
  await recordStep(deps.db, {
    runId,
    name: 'brain',
    input: { messageIds: fresh.map(message => message.id) },
    output: {
      reply: result.reply,
      sources: (result.sources ?? []).map(source => source.id),
      check: result.check ?? null,
      guard: result.guard ?? null,
      maskedMessages: result.masked_messages ?? 0,
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
  await addRunCost(deps.db, runId, Number(result.cost_usd ?? 0));

  // Save first, so a retry never sends these messages to the brain twice.
  const draftId = await saveDraft(deps.db, {
    teamId: team.id,
    conversationId,
    runId,
    reply: result.reply,
    proposals: result.proposals,
    handoff: result.handoff,
    sources: result.sources ?? [],
    factCheck: result.check ?? null,
    handoffNote: result.handoff_note ?? null,
    guard: result.guard ?? null,
  });
  const holdBack = auto ? reasonToHoldBack(result) : null;
  const sends = auto && holdBack === null;
  state = {
    ...state,
    lastMessageId,
    handedOff: Boolean(result.handoff),
    pendingReply: sends ? result.reply : null,
    pendingReplyDraftId: sends ? draftId : null,
    pendingNote: sends ? (result.handoff ? handoffNote(result) : null) : draftNote(result, runId, holdBack),
  };
  await saveConversationState(deps.db, team.id, conversationId, state);

  if (sends) {
    await sendAutoReply(deps, app, ids, conversationId, result.reply!, draftId);
    state = { ...state, pendingReply: null, pendingReplyDraftId: null, autoReplies: (state.autoReplies ?? 0) + 1 };
    await saveConversationState(deps.db, team.id, conversationId, state);
  }
  if (state.pendingNote) {
    await postNote(deps, app, ids, conversationId, state.pendingNote);
    await saveConversationState(deps.db, team.id, conversationId, { ...state, pendingNote: null });
  }
  // People answer drafts and handoffs, so those belong in their Open view. An answer Magpie sent stays where it is.
  if ((!sends || result.handoff) && conversation.status === 'pending') await app.openConversation(team.accountId, conversationId);
}

// Why Magpie won't send this reply on its own, or null when it may.
export function reasonToHoldBack(result: BrainTurnResult): string | null {
  if (!result.reply) return 'there is no reply';
  if (!result.check) return "the reply wasn't checked";
  if (!result.check.passed) return "the fact check found something that isn't in your knowledge";
  if (result.guard?.flagged) return 'the message looks like an attempt to steer Magpie';
  if (result.proposals.length > 0) return 'it involves a refund';
  return null;
}

async function sendAutoReply(
  deps: TurnDeps,
  app: AppClient,
  ids: { teamId: number; accountId: number; runId: number },
  conversationId: number,
  reply: string,
  draftId: number | null,
): Promise<void> {
  const sendStart = Date.now();
  await app.sendReply(ids.accountId, conversationId, reply);
  if (draftId !== null) {
    await closeDraft(deps.db, { teamId: ids.teamId, draftId, status: 'sent', sentContent: reply, actedBy: 'Magpie', sentBy: 'magpie' });
  }
  await countAutoReply(deps.db, ids.teamId, conversationId);
  await recordStep(deps.db, { runId: ids.runId, name: 'auto_send', durationMs: Date.now() - sendStart });
}

async function handToPeople(
  deps: TurnDeps,
  app: AppClient,
  ids: { teamId: number; accountId: number; runId: number },
  conversationId: number,
  note: string,
): Promise<void> {
  await postNote(deps, app, ids, conversationId, note);
  await app.openConversation(ids.accountId, conversationId);
}

function handoffNote(result: BrainTurnResult): string {
  const lines = [`Magpie answered and suggests handing off to ${result.handoff!.team}: ${result.handoff!.reason}`];
  if (result.handoff_note) lines.push('', `For the person taking over: ${result.handoff_note}`);
  return lines.join('\n');
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

export function draftNote(result: BrainTurnResult, runId: number, heldBack: string | null = null): string {
  const lines = [`Magpie draft (run #${runId}):`, '', result.reply ?? '(no reply)'];
  if (heldBack) lines.push('', `Not sent on its own because ${heldBack}.`);
  if (result.check && !result.check.passed) {
    lines.push('', 'Check before sending. Not found in your knowledge:', ...result.check.unsupported.map(claim => `- ${claim}`));
  }
  if (result.sources?.length) {
    lines.push('', 'Sources:', ...result.sources.map(source => `- ${source.title}${source.url ? ` (${source.url})` : ''}`));
  }
  for (const proposal of result.proposals) {
    const who = proposal.approval === 'staff_approves' ? 'needs a teammate to approve' : 'needs the customer to confirm';
    lines.push('', `Proposed refund: ${proposal.amount} for ${proposal.charge_id}, ${who}.`);
  }
  if (result.handoff) {
    lines.push('', `Suggested handoff to ${result.handoff.team}: ${result.handoff.reason}`);
    if (result.handoff_note) lines.push('', `For the person taking over: ${result.handoff_note}`);
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
