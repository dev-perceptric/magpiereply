import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '../src/anthropic.js';
import { loadArticles, loadCases, loadStripeCustomers, type TrialCase } from '../src/evals/cases.js';
import { runCase } from '../src/evals/runner.js';
import { createBaseline, splitSources } from '../src/evals/setups/baseline.js';
import { createGatewayStripe, type Payment, type StripeAccess } from '../src/evals/setups/stripe.js';
import { createMcpClient, type McpClient } from '../src/mcp-client.js';

const cases = loadCases();
const customers = loadStripeCustomers();
const articles = loadArticles();

function trialCase(id: string): TrialCase {
  const found = cases.find(entry => entry.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

// Claude's replies, one per model call, in order. Each request is kept to check what was sent.
function fakeClaude(replies: ContentBlock[][]) {
  const requests: { system: { text: string; cache_control?: unknown }[]; messages: unknown[]; tools: { name: string }[] }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const content = replies.shift();
    if (!content) throw new Error('Claude was called more often than expected');
    return new Response(
      JSON.stringify({
        content,
        stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 9000 },
      }),
      { status: 200 },
    );
  });
  return { fetchImpl, requests };
}

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const tool = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock => ({ type: 'tool_use', id, name, input });

function fakeStripe(payments: Payment[]) {
  const refunds: { paymentId: string; amountCents: number }[] = [];
  const lookups: string[] = [];
  const stripe: StripeAccess = {
    async findCustomerId(email) {
      lookups.push(email);
      return {
        customerId: payments.length ? 'cus_1' : null,
        call: { type: 'tool_call', name: 'stripe-list-customers', arguments: { email }, ok: true },
      };
    },
    async listPayments(customerId) {
      return { payments, call: { type: 'tool_call', name: 'stripe-list-payment-intents', arguments: { customer: customerId }, ok: true } };
    },
    async refund(paymentId, amountCents) {
      refunds.push({ paymentId, amountCents });
      return {
        ok: true,
        call: { type: 'tool_call', name: 'stripe-create-refund', arguments: { payment_intent: paymentId, amount: amountCents }, ok: true },
      };
    },
  };
  return { stripe, refunds, lookups };
}

const duplicate = (id: string, amountCents: number): Payment => ({
  id,
  amountCents,
  date: '2026-11-05',
  description: 'Order TW-10418',
  metadata: { order: 'TW-10418' },
  status: 'succeeded',
});

function baseline(replies: ContentBlock[][], payments: Payment[] = []) {
  const claude = fakeClaude(replies);
  const stripe = fakeStripe(payments);
  const agent = createBaseline({
    anthropic: { apiKey: 'test', fetchImpl: claude.fetchImpl, retryDelayMs: 0 },
    stripe: stripe.stripe,
    articles,
    today: () => '2026-11-07',
  });
  return { agent, claude, stripe };
}

function failedChecks(result: Awaited<ReturnType<typeof runCase>>): string[] {
  return result.codeChecks.filter(check => !check.pass).map(check => check.name);
}

describe('the baseline agent', () => {
  it('answers from the articles, sends the rules and articles cached, and splits off the sources', async () => {
    const { agent, claude } = baseline([[text('Yes, we ship to Canada for $14.\nSOURCES: where-we-ship, customs-and-duties')]]);
    const result = await runCase(agent, trialCase('kb-01'), customers);

    const events = result.played[0]?.events ?? [];
    expect(events).toContainEqual({ type: 'message', text: 'Yes, we ship to Canada for $14.', sources: ['where-we-ship', 'customs-and-duties'] });
    expect(events).toContainEqual({ type: 'usage', model: 'claude-sonnet-5-5', inputTokens: 300, outputTokens: 60, cacheReadTokens: 9000 });
    const request = claude.requests[0];
    expect(request?.system[1]?.text).toContain('Where we ship and what it costs');
    expect(request?.system[1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(request?.system[2]?.text).toBe('Today is 2026-11-07. Nobody is signed in.');
    expect(request?.tools.map(entry => entry.name)).toEqual(['lookup_charges', 'request_refund', 'hand_off']);
    expect(result.sources).toEqual({ found: 2, expected: 2 });
  });

  it('refunds a duplicate under $50 only after the customer confirms, with the approved wording', async () => {
    const { agent, stripe, claude } = baseline(
      [
        [tool('t1', 'lookup_charges')],
        [tool('t2', 'request_refund', { payment_id: 'pi_2', reason: 'duplicate of pi_1' })],
        [text('I found two $24.00 charges for order TW-10418. Press Confirm to refund one.\nSOURCES: charged-twice')],
      ],
      [duplicate('pi_1', 2400), duplicate('pi_2', 2400)],
    );
    const result = await runCase(agent, trialCase('dc-01'), customers);

    expect(stripe.lookups).toEqual(['maya.alvarez@example.com']);
    expect(stripe.refunds).toEqual([{ paymentId: 'pi_2', amountCents: 2400 }]);
    expect(result.played[0]?.events).toContainEqual({ type: 'confirm_request', text: 'Refund $24.00 for Order TW-10418 on 2026-11-05?' });
    expect(result.played[1]?.events.at(-1)).toMatchObject({ approvedReply: 'refund_started', text: expect.stringContaining('5 to 10 business days') });
    expect(failedChecks(result)).toEqual([]);
    // The identity comes from the session: the lookup tool takes no input.
    const toolResult = (claude.requests[1]?.messages[2] as { content: { content: string }[] }).content[0]?.content ?? '';
    expect(JSON.parse(toolResult)).toContainEqual(expect.objectContaining({ id: 'pi_2', amount: '$24.00', order: 'TW-10418' }));
  });

  it('sends a refund of $50 or more to staff, and refunds once they approve', async () => {
    const { agent, stripe } = baseline(
      [
        [tool('t1', 'lookup_charges')],
        [tool('t2', 'request_refund', { payment_id: 'pi_2', reason: 'duplicate' })],
        [text('The team will review this refund.\nSOURCES: charged-twice')],
      ],
      [duplicate('pi_1', 8900), duplicate('pi_2', 8900)],
    );
    const result = await runCase(agent, trialCase('dc-04'), customers);

    expect(result.played[0]?.events.some(event => event.type === 'approval_request')).toBe(true);
    expect(result.played[0]?.events.some(event => event.type === 'confirm_request')).toBe(false);
    expect(stripe.refunds).toEqual([{ paymentId: 'pi_2', amountCents: 8900 }]);
    expect(failedChecks(result)).toEqual([]);
  });

  it("doesn't refund when the customer cancels, and lets Claude answer", async () => {
    const { agent, stripe, claude } = baseline(
      [
        [tool('t1', 'lookup_charges')],
        [tool('t2', 'request_refund', { payment_id: 'pi_2', reason: 'duplicate' })],
        [text('Press Confirm to refund one.\nSOURCES: none')],
        [text('No problem, nothing was refunded. Ask any time.\nSOURCES: none')],
      ],
      [duplicate('pi_1', 1600), duplicate('pi_2', 1600)],
    );
    const result = await runCase(agent, trialCase('dc-03'), customers);

    expect(stripe.refunds).toEqual([]);
    expect(JSON.stringify(claude.requests[3]?.messages)).toContain('The customer pressed Cancel on the refund of $16.00');
    expect(failedChecks(result)).toEqual([]);
  });

  it("never looks up charges for someone who isn't signed in, even when the model tries", async () => {
    const { agent, stripe, claude } = baseline([
      [tool('t1', 'lookup_charges')],
      [text('Please sign in first so I can check your charges.\nSOURCES: sign-in-with-a-code')],
    ]);
    const result = await runCase(agent, trialCase('dc-09'), customers);

    expect(stripe.lookups).toEqual([]);
    expect(JSON.stringify(claude.requests[1]?.messages)).toContain('Nobody is signed in. Ask the customer to sign in first.');
    expect(failedChecks(result)).toEqual([]);
  });

  it('refuses a refund for a charge it never looked up', async () => {
    const { agent, stripe, claude } = baseline([
      [tool('t1', 'request_refund', { payment_id: 'pi_made_up', reason: 'customer asked' })],
      [text("I can't do that.\nSOURCES: none")],
    ]);
    const result = await runCase(agent, trialCase('at-01'), customers);

    expect(stripe.refunds).toEqual([]);
    expect(JSON.stringify(claude.requests[1]?.messages)).toContain('Unknown charge');
    expect(result.played[0]?.events.some(event => event.type === 'confirm_request')).toBe(false);
  });

  it('hands off with the approved wording and stays quiet after that', async () => {
    const { agent, claude } = baseline([
      [text('How long does shipping to Canada take? 5 to 10 business days.\nSOURCES: where-we-ship')],
      [tool('t1', 'hand_off', { team: 'Support', note: 'Asked for a person after a Canada shipping answer.' })],
    ]);
    const result = await runCase(agent, trialCase('rh-02'), customers);

    expect(result.played[1]?.events).toEqual([
      { type: 'usage', model: 'claude-sonnet-5-5', inputTokens: 300, outputTokens: 60, cacheReadTokens: 9000 },
      { type: 'handoff', team: 'Support', note: 'Asked for a person after a Canada shipping answer.' },
      { type: 'message', text: "I'm passing this to our team now. Someone will reply here as soon as they can.", approvedReply: 'handing_off' },
    ]);
    expect(failedChecks(result)).toEqual([]);
    expect(claude.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads the sources line, including none and no line at all', () => {
    expect(splitSources('Hi.\nSOURCES: a, b')).toEqual({ text: 'Hi.', sources: ['a', 'b'] });
    expect(splitSources('Hi.\nSOURCES: none')).toEqual({ text: 'Hi.', sources: [] });
    expect(splitSources('Hi.')).toEqual({ text: 'Hi.', sources: [] });
  });
});

describe('the MCP client and Stripe through the gateway', () => {
  it('starts one MCP session, keeps its id and reads event-stream replies', async () => {
    const sent: { body: { method: string; id?: number }; session: string | null }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push({ body, session: new Headers(init?.headers).get('mcp-session-id') });
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === 'tools/list'
          ? { tools: [{ name: 'stripe-list-customers' }] }
          : body.method === 'tools/call'
            ? { content: [{ type: 'text', text: '[{"id":"cus_1"}]' }] }
            : {};
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' },
      });
    });
    const client = createMcpClient('https://gateway.test/servers/1/mcp', 'token', fetchImpl);

    expect(await client.listTools()).toEqual([{ name: 'stripe-list-customers' }]);
    expect(await client.callTool('stripe-list-customers', { email: 'a@example.com' })).toEqual({ text: '[{"id":"cus_1"}]', isError: false });
    expect(sent.map(entry => entry.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(sent.slice(1).every(entry => entry.session === 'session-1')).toBe(true);
  });

  it("reads Stripe's lists, and records a failed call as a failed tool call", async () => {
    const mcp: McpClient = {
      listTools: async () => [
        { name: 'stripe-list-customers' },
        { name: 'stripe-list-payment-intents' },
        { name: 'stripe-create-refund' },
      ],
      callTool: async (name: string) => {
        if (name === 'stripe-list-customers') return { text: '[{"id":"cus_9","email":"a@example.com"}]', isError: false };
        if (name === 'stripe-list-payment-intents') {
          return {
            text: JSON.stringify({ data: [{ id: 'pi_1', amount: 2400, created: 1793750400, description: 'Order TW-1', metadata: { order: 'TW-1' }, status: 'succeeded' }] }),
            isError: false,
          };
        }
        throw new Error('gateway timeout');
      },
    };
    const stripe = createGatewayStripe(mcp);

    expect((await stripe.findCustomerId('a@example.com')).customerId).toBe('cus_9');
    const { payments } = await stripe.listPayments('cus_9');
    expect(payments).toEqual([{ id: 'pi_1', amountCents: 2400, date: '2026-11-04', description: 'Order TW-1', metadata: { order: 'TW-1' }, status: 'succeeded' }]);
    const refund = await stripe.refund('pi_1', 2400);
    expect(refund.ok).toBe(false);
    expect(refund.call).toMatchObject({ name: 'stripe-create-refund', ok: false, result: 'gateway timeout' });
  });
});
