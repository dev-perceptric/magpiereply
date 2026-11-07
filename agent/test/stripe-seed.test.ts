import { describe, expect, it } from 'vitest';
import { loadStripeCustomers, type StripeCustomer } from '../src/evals/cases.js';
import {
  checkCustomer,
  createStripeApi,
  datesWarning,
  removeCustomer,
  resetIfChanged,
  seedCustomer,
  TRIAL_TAG,
} from '../src/evals/stripe-seed.js';

const fixtures = loadStripeCustomers();
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0) / 1000;

function fixture(id: string): StripeCustomer {
  const found = fixtures.find(entry => entry.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
}

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

type Stored = { id: string; [key: string]: unknown; metadata: Record<string, string> };

// An in-memory Stripe test mode. `dating` says whether payments take the test clock's time or the
// real time, since Stripe's docs don't say which.
function fakeStripe(dating: 'clock' | 'real' = 'clock', realNow = NOW) {
  const clocks = new Map<string, { id: string; frozen_time: number; status: string; target?: number }>();
  const customers = new Map<string, Stored & { email: string; test_clock: string | null }>();
  const intents: (Stored & { customer: string; amount: number; created: number; status: string })[] = [];
  const refundedIntents = new Set<string>();
  const calls: string[] = [];
  let ids = 0;
  let failNext = 0;

  const form = (body: string) => {
    const params = new URLSearchParams(body);
    const metadata: Record<string, string> = {};
    const fields: Record<string, string> = {};
    for (const [key, value] of params) {
      const match = key.match(/^metadata\[(.+)\]$/);
      if (match?.[1]) metadata[match[1]] = value;
      else fields[key] = value;
    }
    return { fields, metadata };
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (failNext > 0) {
      failNext -= 1;
      return json({ error: { message: 'rate limited' } }, 429);
    }
    const { fields, metadata } = form(String(init?.body ?? ''));
    const path = url.pathname;

    if (method === 'POST' && path === '/v1/test_helpers/test_clocks') {
      const clock = { id: `clock_${++ids}`, frozen_time: Number(fields.frozen_time), status: 'ready' };
      clocks.set(clock.id, clock);
      return json(clock);
    }
    const advance = path.match(/^\/v1\/test_helpers\/test_clocks\/(.+)\/advance$/);
    if (method === 'POST' && advance?.[1]) {
      const clock = clocks.get(advance[1])!;
      clock.status = 'advancing';
      clock.target = Number(fields.frozen_time);
      return json(clock);
    }
    const clockPath = path.match(/^\/v1\/test_helpers\/test_clocks\/([^/]+)$/);
    if (clockPath?.[1] && method === 'GET') {
      const clock = clocks.get(clockPath[1])!;
      if (clock.status === 'advancing') Object.assign(clock, { status: 'ready', frozen_time: clock.target });
      return json(clock);
    }
    if (clockPath?.[1] && method === 'DELETE') {
      clocks.delete(clockPath[1]);
      for (const [id, customer] of customers) if (customer.test_clock === clockPath[1]) customers.delete(id);
      return json({ deleted: true });
    }
    if (method === 'POST' && path === '/v1/customers') {
      const customer = { id: `cus_${++ids}`, email: fields.email ?? '', test_clock: fields.test_clock ?? null, metadata };
      customers.set(customer.id, customer);
      return json(customer);
    }
    if (method === 'GET' && path === '/v1/customers') {
      return json({ data: [...customers.values()].filter(customer => customer.email === url.searchParams.get('email')) });
    }
    if (method === 'POST' && path === '/v1/payment_intents') {
      const customer = customers.get(fields.customer ?? '')!;
      const clock = customer.test_clock ? clocks.get(customer.test_clock) : undefined;
      const intent = {
        id: `pi_${++ids}`,
        customer: customer.id,
        amount: Number(fields.amount),
        created: dating === 'clock' && clock ? clock.frozen_time : realNow,
        status: 'succeeded',
        metadata,
      };
      intents.push(intent);
      return json(intent);
    }
    const customerId = url.searchParams.get('customer');
    const live = intents.filter(intent => intent.customer === customerId && customers.has(intent.customer));
    if (method === 'GET' && path === '/v1/payment_intents') return json({ data: live });
    if (method === 'GET' && path === '/v1/charges') {
      return json({ data: live.map(intent => ({ refunded: refundedIntents.has(intent.id), amount_refunded: refundedIntents.has(intent.id) ? intent.amount : 0 })) });
    }
    return json({ error: { message: `no route ${method} ${path}` } }, 404);
  };

  return {
    api: createStripeApi({ secretKey: 'sk_test_fake', fetchImpl, retryDelayMs: 0, pollDelayMs: 0 }),
    clocks,
    customers,
    intents,
    calls,
    refund: (intentId: string) => refundedIntents.add(intentId),
    failNextRequests: (count: number) => {
      failNext = count;
    },
  };
}

describe('the Stripe test data', () => {
  it('refuses a live key', () => {
    expect(() => createStripeApi({ secretKey: 'sk_live_123' })).toThrow('test-mode key');
    expect(() => createStripeApi({ secretKey: 'rk_test_123' })).not.toThrow();
  });

  it('puts each charge on its day with a test clock, and the check finds nothing wrong', async () => {
    const stripe = fakeStripe('clock');
    const sam = fixture('sam');
    const seeded = await seedCustomer(stripe.api, sam, NOW, 0);

    expect(seeded.paymentIntents.map(intent => utcDate(intent.created))).toEqual(['2026-10-24', '2026-11-07']);
    expect(seeded.paymentIntents.map(intent => intent.metadata)).toEqual([
      { subscription: 'SUB-1980', trial_charge: 'sam-renewal-1' },
      { subscription: 'SUB-1980', trial_charge: 'sam-renewal-2' },
    ]);
    const customer = [...stripe.customers.values()][0];
    expect(customer?.metadata).toEqual({ trial: TRIAL_TAG, fixture: 'sam', seeded_at: String(NOW) });
    expect(stripe.calls.filter(call => call.endsWith('/advance'))).toHaveLength(2);

    expect(await checkCustomer(stripe.api, sam)).toEqual({ fixture: 'sam', problems: [], refunded: false });
  });

  it('seeds duplicates together on one day and all 8 customers check clean', async () => {
    const stripe = fakeStripe('clock');
    for (const entry of fixtures) await seedCustomer(stripe.api, entry, NOW, 0);
    const checks = [];
    for (const entry of fixtures) checks.push(await checkCustomer(stripe.api, entry));
    expect(checks.flatMap(check => check.problems)).toEqual([]);

    const maya = stripe.intents.filter(intent => intent.metadata.trial_charge?.startsWith('maya-dup'));
    expect(new Set(maya.map(intent => utcDate(intent.created)))).toEqual(new Set(['2026-11-05']));
    expect(stripe.customers.size).toBe(8);
    expect(datesWarning(checks)).toBeNull();
  });

  it('says plainly when Stripe dates the charges with the real time', async () => {
    const stripe = fakeStripe('real');
    const ana = fixture('ana');
    await seedCustomer(stripe.api, ana, NOW, 0);
    const check = await checkCustomer(stripe.api, ana);

    expect(check.problems).toEqual(['ana-order-1 is dated 2026-11-07, expected 2026-11-02', 'ana-order-2 is dated 2026-11-07, expected 2026-11-04']);
    expect(datesWarning([check])).toContain('dc-06, dc-07, at-04');
  });

  it('replaces an earlier seed instead of adding a second customer', async () => {
    const stripe = fakeStripe('clock');
    const maya = fixture('maya');
    await seedCustomer(stripe.api, maya, NOW, 0);
    await seedCustomer(stripe.api, maya, NOW, 0);

    expect(stripe.customers.size).toBe(1);
    expect(stripe.clocks.size).toBe(1);
    expect((await checkCustomer(stripe.api, maya)).problems).toEqual([]);
    expect(await removeCustomer(stripe.api, maya)).toBe(1);
    expect(stripe.customers.size).toBe(0);
  });

  it('recreates a customer only after a refund, not for date problems alone', async () => {
    const stripe = fakeStripe('clock');
    const jonah = fixture('jonah');
    await seedCustomer(stripe.api, jonah, NOW, 0);
    expect(await resetIfChanged(stripe.api, jonah, NOW)).toBe(false);

    stripe.refund(stripe.intents[0]!.id);
    expect((await checkCustomer(stripe.api, jonah)).refunded).toBe(true);
    expect(await resetIfChanged(stripe.api, jonah, NOW)).toBe(true);
    expect(await checkCustomer(stripe.api, jonah)).toEqual({ fixture: 'jonah', problems: [], refunded: false });

    const realTime = fakeStripe('real');
    const ana = fixture('ana');
    await seedCustomer(realTime.api, ana, NOW, 0);
    expect(await resetIfChanged(realTime.api, ana, NOW)).toBe(false);
  });

  it('tries again when Stripe is busy', async () => {
    const stripe = fakeStripe('clock');
    stripe.failNextRequests(2);
    await seedCustomer(stripe.api, fixture('chris'), NOW, 0);
    expect(stripe.customers.size).toBe(1);
  });
});
