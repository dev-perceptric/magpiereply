import { describe, expect, it } from 'vitest';
import { loadCases, loadStripeCustomers, type TrialCase } from '../src/evals/cases.js';
import { runCase } from '../src/evals/runner.js';
import { createParlant } from '../src/evals/setups/parlant.js';
import type { StripeAccess } from '../src/evals/setups/stripe.js';

const cases = loadCases();
const customers = loadStripeCustomers();

function trialCase(id: string): TrialCase {
  const found = cases.find(entry => entry.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

type Reply = { message?: string; tools?: Record<string, unknown>[]; error?: boolean };

// A stand-in for magpie-brain's HTTP API. Each customer message gets the next scripted reply: a
// tool event (with the brain's metadata) and an agent message, then a ready status.
function fakeParlant(replies: Reply[], utterance = 'No problem, nothing was refunded.') {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const events: { id: string; kind: string; source: string; offset: number; trace_id: string; data: Record<string, unknown> }[] = [];
  let traces = 0;
  let firstPoll = true;
  const add = (kind: string, source: string, traceId: string, data: Record<string, unknown>) => {
    const event = { id: `evt_${events.length}`, kind, source, offset: events.length, trace_id: traceId, data };
    events.push(event);
    return event;
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname + url.search, body });

    if (method === 'POST' && url.pathname === '/customers') return json({ id: 'cust_1' });
    if (method === 'POST' && url.pathname === '/sessions') return json({ id: 'sess_1' });
    if (method === 'PATCH') return json({ id: 'sess_1' });
    if (method === 'GET' && url.pathname === '/sessions/sess_1') {
      const usage = Object.fromEntries(
        Array.from({ length: traces }, (_, index) => [
          `trace_${index + 1}`,
          { requests: { 'anthropic:claude-sonnet-5-5': { input_tokens: 10000, output_tokens: 200, cached_input_tokens: 9000 } } },
        ]),
      );
      return json({ id: 'sess_1', usage });
    }
    if (method === 'GET' && url.pathname === '/sessions/sess_1/events') {
      // The first long poll times out, as Parlant's does when nothing is new yet.
      if (firstPoll) {
        firstPoll = false;
        return new Response('', { status: 504 });
      }
      const minOffset = Number(url.searchParams.get('min_offset'));
      return json(events.filter(event => event.offset >= minOffset));
    }
    if (method === 'POST' && url.pathname === '/sessions/sess_1/events') {
      if (body.source === 'customer') {
        const traceId = `trace_${++traces}`;
        const posted = add('message', 'customer', traceId, { message: body.message });
        const reply = replies.shift() ?? {};
        if (reply.tools) add('tool', 'ai_agent', traceId, { tool_calls: reply.tools });
        if (reply.message) add('message', 'ai_agent', traceId, { message: reply.message });
        add('status', 'ai_agent', traceId, reply.error ? { status: 'error', data: { exception: 'boom' } } : { status: 'ready' });
        return json(posted);
      }
      if (body.source === 'ai_agent') {
        const traceId = `trace_${++traces}`;
        return json(add('message', 'ai_agent', traceId, { message: utterance }));
      }
      return json(add('message', body.source, 'trace_bridge', { message: body.message }));
    }
    return json({ detail: 'not found' }, 404);
  };
  return { fetchImpl, requests };
}

function fakeStripe() {
  const refunds: { paymentId: string; amountCents: number }[] = [];
  const stripe: StripeAccess = {
    findCustomerId: async () => {
      throw new Error('the Parlant setup looks up through the brain');
    },
    listPayments: async () => {
      throw new Error('the Parlant setup looks up through the brain');
    },
    async refund(paymentId, amountCents) {
      refunds.push({ paymentId, amountCents });
      return { ok: true, call: { type: 'tool_call', name: 'stripe-create-refund', arguments: { payment_intent: paymentId, amount: amountCents }, ok: true } };
    },
  };
  return { stripe, refunds };
}

const lookupTool = {
  tool_id: 'local:lookup_charges',
  arguments: {},
  result: {
    data: '[...]',
    metadata: {
      gateway_calls: [
        { name: 'stripe-list-customers', arguments: { email: 'maya.alvarez@example.com', limit: 1 }, ok: true, result: '[]' },
        { name: 'stripe-list-payment-intents', arguments: { customer: 'cus_1', limit: 20 }, ok: true, result: '[]' },
      ],
    },
  },
};
const refundTool = (amountCents: number, gate: string) => ({
  tool_id: 'local:request_refund',
  arguments: { payment_id: 'pi_2', reason: 'duplicate' },
  result: {
    data: 'Confirm and Cancel buttons are now shown.',
    metadata: { refund_request: { payment_id: 'pi_2', amount_cents: amountCents, gate, label: `$${amountCents / 100} for Order TW-1 on 2026-11-05`, reason: 'duplicate' } },
  },
});

function setup(replies: Reply[]) {
  const parlant = fakeParlant(replies);
  const stripe = fakeStripe();
  const agent = createParlant({ url: 'https://brain.test', adminKey: 'admin', stripe: stripe.stripe, fetchImpl: parlant.fetchImpl, retryDelayMs: 0 });
  return { agent, parlant, stripe };
}

function failedChecks(result: Awaited<ReturnType<typeof runCase>>): string[] {
  return result.codeChecks.filter(check => !check.pass).map(check => check.name);
}

describe('the Parlant setup', () => {
  it('makes a Parlant customer with the signed-in email, and reads tools, the reply and token use', async () => {
    const { agent, parlant, stripe } = setup([
      { tools: [lookupTool, refundTool(2400, 'customer_confirm')], message: 'I found two $24 charges. Press Confirm to refund one.' },
    ]);
    const result = await runCase(agent, trialCase('dc-01'), customers);

    expect(parlant.requests[0]).toMatchObject({ method: 'POST', path: '/customers', body: { name: 'Maya Alvarez', metadata: { email: 'maya.alvarez@example.com' } } });
    expect(parlant.requests[1]).toMatchObject({ path: '/sessions?allow_greeting=false', body: { agent_id: 'tidewell', customer_id: 'cust_1' } });
    expect(result.played[0]?.events).toEqual([
      { type: 'tool_call', name: 'stripe-list-customers', arguments: { email: 'maya.alvarez@example.com', limit: 1 }, ok: true, result: '[]' },
      { type: 'tool_call', name: 'stripe-list-payment-intents', arguments: { customer: 'cus_1', limit: 20 }, ok: true, result: '[]' },
      { type: 'confirm_request', text: 'Refund $24 for Order TW-1 on 2026-11-05?' },
      { type: 'message', text: 'I found two $24 charges. Press Confirm to refund one.' },
      { type: 'usage', model: 'anthropic:claude-sonnet-5-5', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 9000 },
    ]);

    // Confirm: the bridge refunds through the gateway, tells Parlant, and sends the approved wording.
    expect(stripe.refunds).toEqual([{ paymentId: 'pi_2', amountCents: 2400 }]);
    expect(parlant.requests).toContainEqual(
      expect.objectContaining({ method: 'PATCH', body: { metadata: { set: { pending_refund: null, refunded: ['pi_2'] } } } }),
    );
    expect(parlant.requests).toContainEqual(
      expect.objectContaining({ body: expect.objectContaining({ source: 'human_agent_on_behalf_of_ai_agent', message: expect.stringContaining('$24.00 has started') }) }),
    );
    expect(failedChecks(result)).toEqual([]);
  });

  it('uses a guest session for someone who is not signed in', async () => {
    const { agent, parlant } = setup([{ message: 'Please sign in first.' }]);
    await runCase(agent, trialCase('dc-09'), customers);
    expect(parlant.requests.some(request => request.path === '/customers')).toBe(false);
    expect(parlant.requests[0]?.body).toEqual({ agent_id: 'tidewell', title: 'Parlant trial' });
  });

  it('sends a refund of $50 or more to staff and refunds only after approval', async () => {
    const { agent, stripe } = setup([{ tools: [lookupTool, refundTool(8900, 'staff_approval')], message: 'The team will review this.' }]);
    const result = await runCase(agent, trialCase('dc-04'), customers);

    expect(result.played[0]?.events.some(event => event.type === 'approval_request')).toBe(true);
    expect(stripe.refunds).toEqual([{ paymentId: 'pi_2', amountCents: 8900 }]);
    expect(failedChecks(result)).toEqual([]);
  });

  it('asks Parlant to answer a Cancel, and refunds nothing', async () => {
    const { agent, parlant, stripe } = setup([{ tools: [lookupTool, refundTool(1600, 'customer_confirm')], message: 'Press Confirm.' }]);
    const result = await runCase(agent, trialCase('dc-03'), customers);

    expect(stripe.refunds).toEqual([]);
    const utterance = parlant.requests.find(request => (request.body as { source?: string } | undefined)?.source === 'ai_agent');
    expect(JSON.stringify(utterance?.body)).toContain('The customer pressed Cancel on the refund of $16.00');
    expect(result.played[1]?.events[0]).toEqual({ type: 'message', text: 'No problem, nothing was refunded.' });
    expect(failedChecks(result)).toEqual([]);
  });

  it('hands off: puts the session in manual mode, sends the approved wording, then stays quiet', async () => {
    const handOffTool = {
      tool_id: 'local:hand_off',
      arguments: { team: 'Billing', note: 'Threatens a chargeback.' },
      result: { data: 'Handed off.', metadata: { handoff: { team: 'Billing', note: 'Threatens a chargeback.' } } },
    };
    const { agent, parlant } = setup([{ tools: [handOffTool] }]);
    const result = await runCase(agent, trialCase('rh-04'), customers);

    expect(parlant.requests).toContainEqual(expect.objectContaining({ method: 'PATCH', body: { mode: 'manual' } }));
    expect(result.played[0]?.events.slice(-2)).toEqual([
      { type: 'handoff', team: 'Billing', note: 'Threatens a chargeback.' },
      { type: 'message', text: "I'm passing this to our team now. Someone will reply here as soon as they can.", approvedReply: 'handing_off' },
    ]);
    expect(failedChecks(result)).toEqual([]);
  });

  it('records a failed Parlant turn as an error', async () => {
    const { agent } = setup([{ error: true }]);
    const result = await runCase(agent, trialCase('kb-01'), customers);
    expect(result.error).toContain('Parlant failed the turn');
  });
});
