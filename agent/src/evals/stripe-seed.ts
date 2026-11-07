// Creates the trial's Stripe test customers (evals/trial/stripe-customers.json) in Stripe test mode,
// checks them, and recreates a customer whose charges a case refunded.
// Charges on past days need a Stripe test clock: each customer gets its own clock, set to its
// earliest charge, and the clock is moved forward before each later charge. Stripe's docs don't say
// whether one-off payments take the clock's date, so `check` reads the dates back.
import type { StripeCustomer } from './cases.js';

const API = 'https://api.stripe.com';
const MAX_TRIES = 4;
const DAY_SECONDS = 86_400;
// Charges are placed an hour before "N days ago", so a charge from today never lands in the future.
const CHARGE_OFFSET_SECONDS = 3_600;
export const TRIAL_TAG = 'tidewell-trial';

export type StripeApiOptions = { secretKey: string; fetchImpl?: typeof fetch; retryDelayMs?: number; pollDelayMs?: number };

type Params = Record<string, string | number | boolean | undefined>;

export function assertTestKey(secretKey: string): void {
  if (!/^(sk|rk)_test_/.test(secretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_). The trial never touches live data.');
  }
}

export function createStripeApi(options: StripeApiOptions) {
  assertTestKey(options.secretKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  return async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) form.append(key, String(value));
    const url = method === 'GET' && form.size ? `${API}${path}?${form}` : `${API}${path}`;

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${options.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: method === 'GET' ? undefined : form.toString(),
        });
      } catch (error) {
        if (attempt >= MAX_TRIES) throw error;
        await new Promise(resolve => setTimeout(resolve, 2 ** attempt * retryDelayMs));
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_TRIES) {
        await new Promise(resolve => setTimeout(resolve, 2 ** attempt * retryDelayMs));
        continue;
      }
      const data = (await response.json()) as T & { error?: { message?: string } };
      if (!response.ok) throw new Error(`Stripe ${method} ${path}: ${data.error?.message ?? response.status}`);
      return data;
    }
  };
}

export type StripeApi = ReturnType<typeof createStripeApi>;
type Clock = { id: string; frozen_time: number; status: string };
type PaymentIntent = { id: string; amount: number; created: number; metadata: Record<string, string>; status: string };
type Charge = { amount_refunded: number; refunded: boolean };

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function chargeTime(daysAgo: number, now: number, index: number): number {
  return now - daysAgo * DAY_SECONDS - CHARGE_OFFSET_SECONDS + index * 60;
}

async function advanceClock(api: StripeApi, clock: Clock, to: number, pollDelayMs: number): Promise<Clock> {
  let current = await api<Clock>('POST', `/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: to });
  for (let polls = 0; current.status === 'advancing'; polls += 1) {
    if (polls > 60) throw new Error(`Stripe test clock ${clock.id} is still advancing`);
    await new Promise(resolve => setTimeout(resolve, pollDelayMs));
    current = await api<Clock>('GET', `/v1/test_helpers/test_clocks/${clock.id}`);
  }
  if (current.status !== 'ready') throw new Error(`Stripe test clock ${clock.id} failed to advance (${current.status})`);
  return current;
}

// Deletes a fixture customer, and its test clock, wherever an earlier seed left them.
export async function removeCustomer(api: StripeApi, fixture: StripeCustomer): Promise<number> {
  const found = await api<{ data: { id: string; test_clock: string | null; metadata: Record<string, string> }[] }>('GET', '/v1/customers', {
    email: fixture.email,
    limit: 20,
  });
  const ours = found.data.filter(customer => customer.metadata.trial === TRIAL_TAG);
  for (const customer of ours) {
    // Deleting a test clock deletes its customers too.
    if (customer.test_clock) await api('DELETE', `/v1/test_helpers/test_clocks/${customer.test_clock}`);
    else await api('DELETE', `/v1/customers/${customer.id}`);
  }
  return ours.length;
}

export async function seedCustomer(
  api: StripeApi,
  fixture: StripeCustomer,
  now: number,
  pollDelayMs = 2000,
): Promise<{ customerId: string; paymentIntents: PaymentIntent[] }> {
  await removeCustomer(api, fixture);
  const ordered = [...fixture.charges].sort((a, b) => b.days_ago - a.days_ago);
  const times = ordered.map((charge, index) => chargeTime(charge.days_ago, now, index));
  const start = Math.min(now - CHARGE_OFFSET_SECONDS * 2, ...times.map(time => time - 60));

  let clock = await api<Clock>('POST', '/v1/test_helpers/test_clocks', { frozen_time: start, name: `${TRIAL_TAG} ${fixture.id}` });
  const customer = await api<{ id: string }>('POST', '/v1/customers', {
    name: fixture.name,
    email: fixture.email,
    test_clock: clock.id,
    'metadata[trial]': TRIAL_TAG,
    'metadata[fixture]': fixture.id,
    'metadata[seeded_at]': now,
  });

  const paymentIntents: PaymentIntent[] = [];
  for (const [index, charge] of ordered.entries()) {
    const time = times[index] ?? now;
    if (time > clock.frozen_time) clock = await advanceClock(api, clock, time, pollDelayMs);
    const metadata = Object.fromEntries(Object.entries(charge.metadata).map(([key, value]) => [`metadata[${key}]`, value]));
    paymentIntents.push(
      await api<PaymentIntent>('POST', '/v1/payment_intents', {
        amount: charge.amount_cents,
        currency: 'usd',
        customer: customer.id,
        description: charge.description,
        ...metadata,
        'metadata[trial_charge]': charge.id,
        payment_method: 'pm_card_visa',
        'payment_method_types[0]': 'card',
        confirm: true,
      }),
    );
  }
  return { customerId: customer.id, paymentIntents };
}

export type CustomerCheck = { fixture: string; problems: string[]; refunded: boolean };

// Reads a fixture customer back from Stripe: one customer, every charge paid, on the right day, none refunded.
export async function checkCustomer(api: StripeApi, fixture: StripeCustomer): Promise<CustomerCheck> {
  const problems: string[] = [];
  const found = await api<{ data: { id: string; metadata: Record<string, string> }[] }>('GET', '/v1/customers', { email: fixture.email, limit: 20 });
  const ours = found.data.filter(customer => customer.metadata.trial === TRIAL_TAG);
  if (ours.length !== 1) return { fixture: fixture.id, problems: [`${ours.length} Stripe customers with ${fixture.email}, expected 1`], refunded: false };
  const customerId = ours[0]?.id ?? '';
  const seededAt = Number(ours[0]?.metadata.seeded_at);

  const intents = await api<{ data: PaymentIntent[] }>('GET', '/v1/payment_intents', { customer: customerId, limit: 100 });
  const charges = await api<{ data: Charge[] }>('GET', '/v1/charges', { customer: customerId, limit: 100 });
  const refunded = charges.data.some(charge => charge.refunded || charge.amount_refunded > 0);
  if (refunded) problems.push('a charge was refunded');

  const ordered = [...fixture.charges].sort((a, b) => b.days_ago - a.days_ago);
  for (const [index, charge] of ordered.entries()) {
    const intent = intents.data.find(entry => entry.metadata.trial_charge === charge.id);
    if (!intent) {
      problems.push(`${charge.id} is missing`);
      continue;
    }
    if (intent.status !== 'succeeded') problems.push(`${charge.id} is ${intent.status}`);
    if (intent.amount !== charge.amount_cents) problems.push(`${charge.id} is ${intent.amount} cents, expected ${charge.amount_cents}`);
    if (Number.isFinite(seededAt)) {
      const expected = utcDate(chargeTime(charge.days_ago, seededAt, index));
      if (utcDate(intent.created) !== expected) {
        problems.push(`${charge.id} is dated ${utcDate(intent.created)}, expected ${expected}`);
      }
    }
  }
  if (intents.data.length !== fixture.charges.length) problems.push(`${intents.data.length} payments, expected ${fixture.charges.length}`);
  return { fixture: fixture.id, problems, refunded };
}

// What `seed` writes when the dates didn't take: the cases that need charges on different days.
export function datesWarning(checks: CustomerCheck[]): string | null {
  const wrongDates = checks.filter(check => check.problems.some(problem => problem.includes(' is dated ')));
  if (wrongDates.length === 0) return null;
  return [
    `Stripe dated the charges for ${wrongDates.map(check => check.fixture).join(', ')} with the real time, not the test clock's.`,
    'Charges meant for different days now share a day, so the not-a-duplicate cases (dc-06, dc-07, at-04) are not valid.',
  ].join(' ');
}

// Before a case: recreate the case's customer if an earlier case refunded a charge or a charge is
// missing. Wrong dates alone don't count: recreating can't fix them.
export async function resetIfChanged(api: StripeApi, fixture: StripeCustomer, now: number): Promise<boolean> {
  const check = await checkCustomer(api, fixture);
  const changed = check.problems.some(problem => !problem.includes(' is dated '));
  if (!changed) return false;
  await seedCustomer(api, fixture, now);
  return true;
}
