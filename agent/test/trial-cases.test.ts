import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Checks the Parlant trial's test data (evals/trial) so the cases, the Stripe test customers
// and the help articles stay in step with each other.
const trialDir = new URL('../evals/trial/', import.meta.url);
const STAFF_APPROVAL_FROM_CENTS = 5000;

const turnSchema = z.union([
  z.object({ from: z.literal('customer'), text: z.string().min(1) }),
  z.object({ from: z.literal('customer'), action: z.enum(['confirm', 'decline']) }),
  z.object({ from: z.literal('staff'), action: z.enum(['approve', 'reject']) }),
]);

const toolSchema = z.enum(['lookup_charges', 'refund_charge']);

const caseSchema = z.object({
  id: z.string().regex(/^[a-z]{2}-\d{2}$/),
  group: z.enum(['knowledge', 'duplicate_charge', 'rules', 'attack']),
  title: z.string().min(1),
  customer: z.union([
    z.object({ verified: z.literal(false) }),
    z.object({ verified: z.literal(true), stripe_customer: z.string() }),
  ]),
  turns: z.array(turnSchema).min(1),
  expected: z.object({
    outcome: z.enum(['answer', 'handoff', 'refund', 'no_refund', 'ask_to_sign_in', 'refuse']),
    handoff_team: z.enum(['Support', 'Billing']).nullable(),
    refund: z
      .object({
        charge_any_of: z.array(z.string()).min(1),
        amount_cents: z.number().int().positive(),
        gate: z.enum(['customer_confirm', 'staff_approval']),
      })
      .nullable(),
    tools_required: z.array(toolSchema),
    tools_forbidden: z.array(toolSchema),
    approved_reply: z.enum(['refund_started', 'handing_off']).nullable(),
    sources: z.array(z.string()),
    checks: z.array(z.string().min(1)).min(1),
  }),
});

const chargeSchema = z.object({
  id: z.string(),
  amount_cents: z.number().int().positive(),
  days_ago: z.number().int().min(0),
  description: z.string(),
  metadata: z.record(z.string(), z.string()),
});

const stripeSchema = z.object({
  customers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
      kind: z.enum(['duplicate_under_50', 'duplicate_over_50', 'not_duplicate', 'no_charges']),
      charges: z.array(chargeSchema),
    }),
  ),
});

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, trialDir), 'utf8'));
}

const caseFiles = ['knowledge', 'duplicate-charges', 'rules-and-handoff', 'attacks'];
const cases = caseFiles.flatMap(name => z.array(caseSchema).parse(readJson(`cases/${name}.json`)));
const { customers } = stripeSchema.parse(readJson('stripe-customers.json'));
const customersById = new Map(customers.map(customer => [customer.id, customer]));

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

describe('trial test data', () => {
  it('has the 40 cases from the plan, with unique ids', () => {
    expect(countBy(cases, item => item.group)).toEqual({ knowledge: 20, duplicate_charge: 10, rules: 6, attack: 4 });
    expect(new Set(cases.map(item => item.id)).size).toBe(40);
  });

  it('has the 8 Stripe customers from the plan', () => {
    expect(countBy(customers, customer => customer.kind)).toEqual({
      duplicate_under_50: 3,
      duplicate_over_50: 2,
      not_duplicate: 2,
      no_charges: 1,
    });
  });

  it('gives each duplicate customer two charges with the same amount, day and order', () => {
    for (const customer of customers.filter(item => item.kind.startsWith('duplicate'))) {
      const duplicates = customer.charges.filter(charge => charge.id.includes('-dup-'));
      expect(duplicates, customer.id).toHaveLength(2);
      const [first, second] = duplicates as [z.infer<typeof chargeSchema>, z.infer<typeof chargeSchema>];
      expect(second.amount_cents).toBe(first.amount_cents);
      expect(second.days_ago).toBe(first.days_ago);
      expect(second.metadata).toEqual(first.metadata);
      const overLimit = first.amount_cents >= STAFF_APPROVAL_FROM_CENTS;
      expect(overLimit, customer.id).toBe(customer.kind === 'duplicate_over_50');
    }
  });

  it('puts the not-duplicate charges on different days', () => {
    for (const customer of customers.filter(item => item.kind === 'not_duplicate')) {
      const [first, second] = customer.charges;
      expect(first?.amount_cents).toBe(second?.amount_cents);
      expect(first?.days_ago).not.toBe(second?.days_ago);
    }
  });

  it('only points at articles and customers that exist', () => {
    for (const item of cases) {
      for (const slug of item.expected.sources) {
        expect(existsSync(new URL(`articles/${slug}.md`, trialDir)), `${item.id}: ${slug}`).toBe(true);
      }
      if (item.customer.verified) {
        expect(customersById.has(item.customer.stripe_customer), item.id).toBe(true);
      }
    }
  });

  it('keeps refunds consistent with the customer, the amount and the right approval', () => {
    for (const item of cases) {
      const { refund, outcome, tools_required, tools_forbidden } = item.expected;
      expect(refund !== null, item.id).toBe(outcome === 'refund');
      expect(tools_required.includes('refund_charge'), item.id).toBe(outcome === 'refund');
      expect(tools_forbidden.includes('refund_charge'), item.id).toBe(outcome !== 'refund');
      if (!refund) continue;

      expect(item.customer.verified, item.id).toBe(true);
      const customer = item.customer.verified ? customersById.get(item.customer.stripe_customer) : undefined;
      for (const chargeId of refund.charge_any_of) {
        const charge = customer?.charges.find(entry => entry.id === chargeId);
        expect(charge?.amount_cents, `${item.id}: ${chargeId}`).toBe(refund.amount_cents);
      }
      const gate = refund.amount_cents >= STAFF_APPROVAL_FROM_CENTS ? 'staff_approval' : 'customer_confirm';
      expect(refund.gate, item.id).toBe(gate);
      const action = gate === 'staff_approval' ? 'approve' : 'confirm';
      expect(item.turns.some(turn => 'action' in turn && turn.action === action), item.id).toBe(true);
    }
  });

  it('hands off to a team exactly when the outcome is a handoff', () => {
    for (const item of cases) {
      expect(item.expected.handoff_team !== null, item.id).toBe(item.expected.outcome === 'handoff');
    }
    const unanswerable = cases.filter(item => item.group === 'knowledge' && item.expected.outcome === 'handoff');
    expect(unanswerable).toHaveLength(2);
  });

  it('never looks up charges for a customer who is not signed in', () => {
    for (const item of cases.filter(entry => !entry.customer.verified)) {
      expect(item.expected.tools_required, item.id).not.toContain('lookup_charges');
    }
  });
});
