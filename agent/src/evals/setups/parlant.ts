// The trial's Parlant setup: drives magpie-brain (brain/) over Parlant's HTTP API. Parlant decides
// what to say and which tools to run. This adapter plays the bridge's part, like the baseline's code:
// it makes the Parlant customer from the session's identity, shows the Confirm buttons or staff card a
// refund request asks for, makes the refund through the gateway, and sends the approved wording.
import type { AgentUnderTest, SessionCustomer, TrialEvent, TrialSession } from '../agent-under-test.js';
import type { CaseTurn } from '../cases.js';
import { APPROVED_REPLIES } from './baseline.js';
import type { StripeAccess } from './stripe.js';

export type ParlantOptions = {
  url: string;
  adminKey: string;
  agentId?: string;
  stripe: StripeAccess;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
};

type ParlantEvent = {
  id: string;
  kind: 'message' | 'tool' | 'status' | 'custom';
  source: string;
  offset: number;
  trace_id: string;
  data: Record<string, unknown>;
};

type RefundRequest = { payment_id: string; amount_cents: number; gate: 'customer_confirm' | 'staff_approval'; label: string };
type ToolCallData = { tool_id: string; arguments: Record<string, unknown>; result: { data: unknown; metadata?: Record<string, unknown> } };
type GatewayCallData = { name: string; arguments: Record<string, unknown>; ok: boolean; result: string };
type UsageEntry = { requests: Record<string, { input_tokens: number; output_tokens: number; cached_input_tokens?: number }> };

const LONG_POLL_SECONDS = 30;
const MAX_TRIES = 4;

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function createParlantClient(options: ParlantOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  return async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, options.url), {
          method,
          headers: { authorization: `Bearer ${options.adminKey}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt >= MAX_TRIES) throw error;
        await new Promise(resolve => setTimeout(resolve, 2 ** attempt * retryDelayMs));
        continue;
      }
      // 504 is Parlant's long-poll timeout, not a failure: the caller polls again.
      const busy = response.status === 429 || (response.status >= 500 && response.status !== 504);
      if (busy && attempt < MAX_TRIES) {
        await new Promise(resolve => setTimeout(resolve, 2 ** attempt * retryDelayMs));
        continue;
      }
      const text = await response.text();
      if (!response.ok && response.status !== 504) throw new Error(`Parlant ${method} ${path} answered ${response.status}: ${text}`);
      return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
    }
  };
}

class ParlantSession implements TrialSession {
  private nextOffset = 0;
  private pending: RefundRequest | null = null;
  private refunded: string[] = [];
  private handedOff = false;

  constructor(
    private readonly options: ParlantOptions,
    private readonly call: ReturnType<typeof createParlantClient>,
    private readonly sessionId: string,
  ) {}

  async play(turn: CaseTurn): Promise<TrialEvent[]> {
    if (this.handedOff) return [];
    if ('text' in turn) {
      const posted = await this.call<ParlantEvent>('POST', `/sessions/${this.sessionId}/events`, {
        kind: 'message',
        source: 'customer',
        message: turn.text,
      });
      return this.finishTurn(posted.data.trace_id);
    }

    const pending = this.pending;
    const expectedGate = turn.from === 'staff' ? 'staff_approval' : 'customer_confirm';
    if (!pending || pending.gate !== expectedGate) return [];
    this.pending = null;

    if (turn.action === 'confirm' || turn.action === 'approve') return this.makeRefund(pending);

    await this.setMetadata({ pending_refund: null });
    const who = turn.from === 'staff' ? 'Staff turned down' : 'The customer pressed Cancel on';
    const posted = await this.call<ParlantEvent>('POST', `/sessions/${this.sessionId}/events`, {
      kind: 'message',
      source: 'ai_agent',
      rules: [
        {
          action: `${who} the refund of ${dollars(pending.amount_cents)}. Nothing was refunded. Tell the customer, and say they can ask again any time.`,
          rationale: 'follow_up',
        },
      ],
    });
    // With rules, Parlant writes that one message and answers with it.
    this.nextOffset = Math.max(this.nextOffset, posted.data.offset + 1);
    const events: TrialEvent[] = [];
    if (typeof posted.data.data.message === 'string') events.push({ type: 'message', text: posted.data.data.message });
    events.push(...(await this.usage(posted.data.trace_id)));
    return events;
  }

  async end(): Promise<void> {}

  private async setMetadata(values: Record<string, unknown>): Promise<void> {
    await this.call('PATCH', `/sessions/${this.sessionId}`, { metadata: { set: values } });
  }

  private async sendApproved(text: string): Promise<void> {
    await this.call('POST', `/sessions/${this.sessionId}/events`, {
      kind: 'message',
      source: 'human_agent_on_behalf_of_ai_agent',
      message: text,
    });
  }

  private async handOff(team: 'Support' | 'Billing', note: string, events: TrialEvent[]): Promise<void> {
    this.handedOff = true;
    await this.call('PATCH', `/sessions/${this.sessionId}`, { mode: 'manual' });
    await this.sendApproved(APPROVED_REPLIES.handingOff);
    events.push({ type: 'handoff', team, note });
    events.push({ type: 'message', text: APPROVED_REPLIES.handingOff, approvedReply: 'handing_off' });
  }

  private async makeRefund(pending: RefundRequest): Promise<TrialEvent[]> {
    const events: TrialEvent[] = [];
    const { ok, call } = await this.options.stripe.refund(pending.payment_id, pending.amount_cents);
    events.push(call);
    if (!ok) {
      await this.handOff('Billing', `The refund of ${dollars(pending.amount_cents)} for ${pending.payment_id} failed in Stripe.`, events);
      return events;
    }
    this.refunded.push(pending.payment_id);
    await this.setMetadata({ pending_refund: null, refunded: this.refunded });
    const reply = APPROVED_REPLIES.refundStarted(dollars(pending.amount_cents));
    await this.sendApproved(reply);
    events.push({ type: 'message', text: reply, approvedReply: 'refund_started' });
    return events;
  }

  // Reads the turn's events until Parlant says it's ready, then turns them into trial events.
  private async finishTurn(traceId: string): Promise<TrialEvent[]> {
    const turnEvents: ParlantEvent[] = [];
    for (;;) {
      const { status, data } = await this.call<ParlantEvent[]>(
        'GET',
        `/sessions/${this.sessionId}/events?min_offset=${this.nextOffset}&wait_for_data=${LONG_POLL_SECONDS}`,
      );
      if (status === 504) continue;
      for (const event of data) this.nextOffset = Math.max(this.nextOffset, event.offset + 1);
      turnEvents.push(...data.filter(event => event.trace_id === traceId));
      const end = turnEvents.find(event => event.kind === 'status' && ['ready', 'error'].includes(String(event.data.status)));
      if (end?.data.status === 'error') throw new Error(`Parlant failed the turn: ${JSON.stringify(end.data)}`);
      if (end) break;
    }

    const events: TrialEvent[] = [];
    let handoff: { team: 'Support' | 'Billing'; note: string } | null = null;
    for (const event of turnEvents.sort((a, b) => a.offset - b.offset)) {
      if (event.kind === 'message' && event.source === 'ai_agent' && typeof event.data.message === 'string') {
        events.push({ type: 'message', text: event.data.message });
      }
      if (event.kind !== 'tool') continue;
      for (const toolCall of (event.data.tool_calls ?? []) as ToolCallData[]) {
        const metadata = toolCall.result.metadata ?? {};
        for (const gatewayCall of (metadata.gateway_calls ?? []) as GatewayCallData[]) {
          events.push({ type: 'tool_call', ...gatewayCall });
        }
        const request = metadata.refund_request as (RefundRequest & { reason?: string }) | null | undefined;
        if (request) {
          this.pending = request;
          events.push(
            request.gate === 'staff_approval'
              ? { type: 'approval_request', text: `Refund ${request.label}.${request.reason ? ` Reason: ${request.reason}` : ''}` }
              : { type: 'confirm_request', text: `Refund ${request.label}?` },
          );
        }
        const handoffData = metadata.handoff as { team?: string; note?: string } | undefined;
        if (handoffData) handoff = { team: handoffData.team === 'Billing' ? 'Billing' : 'Support', note: handoffData.note ?? '' };
      }
    }

    events.push(...(await this.usage(traceId)));
    if (handoff) await this.handOff(handoff.team, handoff.note, events);
    return events;
  }

  private async usage(traceId: string): Promise<TrialEvent[]> {
    const { data } = await this.call<{ usage?: Record<string, UsageEntry> }>('GET', `/sessions/${this.sessionId}`);
    const requests = data.usage?.[traceId]?.requests ?? {};
    return Object.entries(requests).map(([model, entry]) => ({
      type: 'usage' as const,
      model,
      inputTokens: entry.input_tokens - (entry.cached_input_tokens ?? 0),
      outputTokens: entry.output_tokens,
      cacheReadTokens: entry.cached_input_tokens ?? 0,
    }));
  }
}

export function createParlant(options: ParlantOptions): AgentUnderTest {
  const call = createParlantClient(options);
  const agentId = options.agentId ?? 'tidewell';

  return {
    name: 'parlant',
    async startSession(customer: SessionCustomer) {
      // A signed-in customer becomes a Parlant customer carrying the email; nobody signed in is a guest.
      let customerId: string | undefined;
      if (customer.verified) {
        const created = await call<{ id: string }>('POST', '/customers', { name: customer.name, metadata: { email: customer.email } });
        customerId = created.data.id;
      }
      const session = await call<{ id: string }>('POST', '/sessions?allow_greeting=false', {
        agent_id: agentId,
        ...(customerId ? { customer_id: customerId } : {}),
        title: 'Parlant trial',
      });
      return new ParlantSession(options, call, session.data.id);
    },
  };
}
