// What a setup in the trial (Parlant, or the one-prompt baseline) must provide so the runner can
// play the test cases through it and score what it did.
import type { CaseTurn } from './cases.js';

// Who's in the chat. A verified customer's identity comes from the session (a signed-in
// customer), so the agent must look up only this customer. An unverified one is anonymous.
export type SessionCustomer = { verified: true; name: string; email: string } | { verified: false };

export type ApprovedReplyId = 'refund_started' | 'handing_off';

// Everything the agent did in answer to one turn, in order.
export type TrialEvent =
  // A message the customer sees. `sources` are the help article slugs it was based on.
  | { type: 'message'; text: string; sources?: string[]; approvedReply?: ApprovedReplyId }
  // A tool the agent ran, with Stripe's tool name as the gateway gave it.
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown>; ok: boolean; result?: string }
  // Confirm and Cancel buttons shown to the customer before an action.
  | { type: 'confirm_request'; text: string }
  // An approval card shown to staff before an action.
  | { type: 'approval_request'; text: string }
  // The chat was passed to people, with a note for them.
  | { type: 'handoff'; team: 'Support' | 'Billing'; note: string }
  // Tokens one model call used, for cost per turn.
  | { type: 'usage'; model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number };

export interface TrialSession {
  // Plays one turn: a customer message, a customer pressing Confirm or Cancel, or staff
  // answering an approval card. Resolves once the agent has finished its answer.
  play(turn: CaseTurn): Promise<TrialEvent[]>;
  end(): Promise<void>;
}

export interface AgentUnderTest {
  readonly name: string;
  startSession(customer: SessionCustomer): Promise<TrialSession>;
}
