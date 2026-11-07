// The Parlant trial's test data (evals/trial): test cases, Stripe test customers and help articles.
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const TRIAL_DIR = new URL('../../evals/trial/', import.meta.url);
export const CASE_FILES = ['knowledge', 'duplicate-charges', 'rules-and-handoff', 'attacks'];
// Refunds of this amount or more need a staff approval; smaller ones need the customer to confirm.
export const STAFF_APPROVAL_FROM_CENTS = 5000;

const turnSchema = z.union([
  z.object({ from: z.literal('customer'), text: z.string().min(1) }),
  z.object({ from: z.literal('customer'), action: z.enum(['confirm', 'decline']) }),
  z.object({ from: z.literal('staff'), action: z.enum(['approve', 'reject']) }),
]);

export const toolKindSchema = z.enum(['lookup_charges', 'refund_charge']);

export const caseSchema = z.object({
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
    tools_required: z.array(toolKindSchema),
    tools_forbidden: z.array(toolKindSchema),
    approved_reply: z.enum(['refund_started', 'handing_off']).nullable(),
    sources: z.array(z.string()),
    checks: z.array(z.string().min(1)).min(1),
  }),
});

export const chargeSchema = z.object({
  id: z.string(),
  amount_cents: z.number().int().positive(),
  days_ago: z.number().int().min(0),
  description: z.string(),
  metadata: z.record(z.string(), z.string()),
});

export const stripeCustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  kind: z.enum(['duplicate_under_50', 'duplicate_over_50', 'not_duplicate', 'no_charges']),
  charges: z.array(chargeSchema),
});

export type TrialCase = z.infer<typeof caseSchema>;
export type CaseTurn = TrialCase['turns'][number];
export type ToolKind = z.infer<typeof toolKindSchema>;
export type Charge = z.infer<typeof chargeSchema>;
export type StripeCustomer = z.infer<typeof stripeCustomerSchema>;
export type Article = { slug: string; title: string; content: string };

function readJson(path: string, dir: URL): unknown {
  return JSON.parse(readFileSync(new URL(path, dir), 'utf8'));
}

export function loadCases(dir: URL = TRIAL_DIR): TrialCase[] {
  return CASE_FILES.flatMap(name => z.array(caseSchema).parse(readJson(`cases/${name}.json`, dir)));
}

export function loadStripeCustomers(dir: URL = TRIAL_DIR): StripeCustomer[] {
  return z.object({ customers: z.array(stripeCustomerSchema) }).parse(readJson('stripe-customers.json', dir)).customers;
}

export function loadArticles(dir: URL = TRIAL_DIR): Article[] {
  const folder = new URL('articles/', dir);
  return readdirSync(folder)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const text = readFileSync(new URL(name, folder), 'utf8');
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const title = match?.[1]?.match(/^title:\s*(.+)$/m)?.[1];
      if (!match || !title) throw new Error(`${name} has no front matter title`);
      return { slug: name.replace(/\.md$/, ''), title: title.trim(), content: (match[2] ?? '').trim() };
    });
}
