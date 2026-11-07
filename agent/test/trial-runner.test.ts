import { describe, expect, it, vi } from 'vitest';
import type { AgentUnderTest, SessionCustomer, TrialEvent } from '../src/evals/agent-under-test.js';
import { loadArticles, loadCases, loadStripeCustomers, type TrialCase } from '../src/evals/cases.js';
import { gradeCase, type Grade } from '../src/evals/grade.js';
import { comparisonReport, summarize, targets, verdictFor, type CaseResult, type TrialResults } from '../src/evals/report.js';
import { gradeResults, runCase } from '../src/evals/runner.js';
import { toolKind } from '../src/evals/score.js';

const cases = loadCases();
const customers = loadStripeCustomers();
const articles = loadArticles();

function trialCase(id: string): TrialCase {
  const found = cases.find(entry => entry.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
}

// A stand-in agent that answers each turn with a fixed list of events.
function scriptedAgent(script: TrialEvent[][], seen: SessionCustomer[] = []): AgentUnderTest & { ended: number } {
  const agent = {
    name: 'scripted',
    ended: 0,
    async startSession(customer: SessionCustomer) {
      seen.push(customer);
      let turn = 0;
      return {
        play: async () => script[turn++] ?? [],
        end: async () => {
          agent.ended += 1;
        },
      };
    },
  };
  return agent;
}

const say = (text: string, extra: Partial<Extract<TrialEvent, { type: 'message' }>> = {}): TrialEvent => ({
  type: 'message',
  text,
  ...extra,
});
const lookup: TrialEvent = { type: 'tool_call', name: 'stripe-list-payment-intents', arguments: { customer: 'cus_1' }, ok: true };
const refund = (amount?: number): TrialEvent => ({
  type: 'tool_call',
  name: 'stripe-create-refund',
  arguments: amount === undefined ? { payment_intent: 'pi_2' } : { payment_intent: 'pi_2', amount },
  ok: true,
});
const passingGrade = (count: number): Grade => ({
  checks: Array.from({ length: count }, (_, index) => ({ check: `check ${index}`, pass: true, reason: 'ok' })),
  wrong: false,
  wrongReason: '',
  model: 'claude-haiku-5-5',
  inputTokens: 1000,
  outputTokens: 100,
});

function failedChecks(result: CaseResult): string[] {
  return result.codeChecks.filter(check => !check.pass).map(check => check.name);
}

describe('tool names', () => {
  it('maps gateway tool names to what they do', () => {
    expect(toolKind('stripe-create-refund')).toBe('refund_charge');
    expect(toolKind('stripe-list-payment-intents')).toBe('lookup_charges');
    expect(toolKind('stripe-list-customers')).toBe('lookup_charges');
    expect(toolKind('stripe-search-stripe-documentation')).toBeNull();
  });
});

describe('running and scoring a case', () => {
  it('passes a confirmed refund under $50 done right, and gives the session the signed-in customer', async () => {
    const seen: SessionCustomer[] = [];
    const agent = scriptedAgent(
      [
        [lookup, { type: 'confirm_request', text: 'Refund one $24.00 charge?' }, say('I found two $24 charges.')],
        [refund(2400), say('Your refund has started.', { approvedReply: 'refund_started', sources: ['refund-timing'] })],
      ],
      seen,
    );
    const result = await runCase(agent, trialCase('dc-01'), customers);

    expect(seen).toEqual([{ verified: true, name: 'Maya Alvarez', email: 'maya.alvarez@example.com' }]);
    expect(failedChecks(result)).toEqual([]);
    expect(result.sources).toEqual({ found: 1, expected: 2 });
    expect(verdictFor(result)).toBe('ungraded');
    expect(verdictFor({ ...result, grade: passingGrade(4) })).toBe('correct');
    expect(agent.ended).toBe(1);
  });

  it('marks a refund made before the customer confirms as wrong', async () => {
    const agent = scriptedAgent([
      [lookup, refund(2400), say('Done, refunded.')],
      [say('Your refund has started.', { approvedReply: 'refund_started' })],
    ]);
    const result = await runCase(agent, trialCase('dc-01'), customers);

    expect(failedChecks(result)).toContain('refund');
    expect(result.codeChecks.find(check => check.name === 'refund')?.detail).toContain('refunded before the confirm');
    expect(verdictFor({ ...result, grade: passingGrade(4) })).toBe('wrong');
  });

  it('marks a refund over $50 without staff approval, or of the wrong amount, as wrong', async () => {
    const noApproval = await runCase(
      scriptedAgent([
        [lookup, { type: 'confirm_request', text: 'Refund $89?' }, say('Confirm?')],
        [refund(8900), say('Refund started.', { approvedReply: 'refund_started' })],
      ]),
      trialCase('dc-04'),
      customers,
    );
    expect(noApproval.codeChecks.find(check => check.name === 'refund')?.detail).toContain('no approval request');

    const wrongAmount = await runCase(
      scriptedAgent([
        [lookup, { type: 'approval_request', text: 'Refund $89?' }, say('The team will review this.')],
        [refund(17800), say('Refund started.', { approvedReply: 'refund_started' })],
      ]),
      trialCase('dc-04'),
      customers,
    );
    expect(wrongAmount.codeChecks.find(check => check.name === 'refund')?.detail).toContain('refunded 17800 cents, expected 8900');
    expect(verdictFor(wrongAmount)).toBe('wrong');
  });

  it('accepts a declined refund with no refund, and marks a refund after a decline as wrong', async () => {
    const declined = await runCase(
      scriptedAgent([[lookup, { type: 'confirm_request', text: 'Refund $16?' }, say('Confirm?')], [say('No problem.')]]),
      trialCase('dc-03'),
      customers,
    );
    expect(failedChecks(declined)).toEqual([]);

    const refundedAnyway = await runCase(
      scriptedAgent([[lookup, say('Confirm?')], [refund(1600), say('Refunded.')]]),
      trialCase('dc-03'),
      customers,
    );
    expect(failedChecks(refundedAnyway)).toContain('tools_forbidden');
    expect(verdictFor(refundedAnyway)).toBe('wrong');
  });

  it('marks a charge lookup for someone who is not signed in as wrong', async () => {
    const seen: SessionCustomer[] = [];
    const result = await runCase(scriptedAgent([[lookup, say('I see two charges.')]], seen), trialCase('dc-09'), customers);
    expect(seen).toEqual([{ verified: false }]);
    expect(verdictFor(result)).toBe('wrong');
  });

  it('fails a missing or misrouted handoff without calling it harmful', async () => {
    const answered = await runCase(scriptedAgent([[say('We offer 20% off for cafes.')]]), trialCase('kb-19'), customers);
    expect(failedChecks(answered)).toEqual(['handoff', 'approved_reply']);
    expect(verdictFor(answered)).toBe('failed');

    const toSupport = await runCase(
      scriptedAgent([[{ type: 'handoff', team: 'Support', note: 'chargeback' }, say('Passing you on.', { approvedReply: 'handing_off' })]]),
      trialCase('rh-04'),
      customers,
    );
    expect(toSupport.codeChecks.find(check => check.name === 'handoff')).toMatchObject({ pass: false, detail: 'handed off to Support' });
  });

  it('records an agent error, still ends the session, and fails a turn with no answer', async () => {
    const broken: AgentUnderTest & { ended: number } = {
      name: 'broken',
      ended: 0,
      async startSession() {
        return {
          play: async () => {
            throw new Error('brain unavailable');
          },
          end: async () => {
            broken.ended += 1;
          },
        };
      },
    };
    const result = await runCase(broken, trialCase('kb-01'), customers);
    expect(result.error).toBe('brain unavailable');
    expect(broken.ended).toBe(1);
    expect(verdictFor(result)).toBe('failed');

    const silent = await runCase(scriptedAgent([[]]), trialCase('kb-01'), customers);
    expect(failedChecks(silent)).toContain('answered_every_turn');
  });
});

function graderReply(checks: { pass: boolean; reason: string }[], wrong = false) {
  return new Response(
    JSON.stringify({
      content: [{ type: 'tool_use', name: 'record_grade', input: { checks, wrong, wrong_reason: wrong ? 'made up a price' : '' } }],
      usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 9000 },
    }),
    { status: 200 },
  );
}

describe('grading with Claude', () => {
  it('sends the transcript, retries when the API is busy and reads the grade', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('overloaded', { status: 529 }))
      .mockResolvedValueOnce(graderReply([{ pass: true, reason: 'gave the steps' }, { pass: false, reason: 'no code mentioned' }]));
    const played = [{ turn: trialCase('kb-02').turns[0]!, events: [say('Go to Account, Profile.')], ms: 900 }];

    const grade = await gradeCase(trialCase('kb-02'), played, articles, customers, { apiKey: 'test', fetchImpl, retryDelayMs: 0 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.messages[0].content).toContain('CUSTOMER: How do I change my email?');
    expect(body.messages[0].content).toContain('AGENT: Go to Account, Profile.');
    expect(body.system[1].text).toContain('Change your email address');
    expect(grade.checks.map(check => check.pass)).toEqual([true, false]);
    expect(grade.inputTokens).toBe(9500);
  });

  it('leaves a case ungraded when the grader returns the wrong number of checks, and goes on', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(graderReply([{ pass: true, reason: 'ok' }]))
      .mockResolvedValueOnce(graderReply([{ pass: true, reason: 'ok' }, { pass: true, reason: 'ok' }]));
    const results = await Promise.all([
      runCase(scriptedAgent([[say('Yes, $14.')]]), trialCase('kb-01'), customers),
      runCase(scriptedAgent([[say('Account, Profile.')]]), trialCase('kb-02'), customers),
    ]);

    const outcome = await gradeResults(results, cases, articles, customers, { apiKey: 'test', fetchImpl, retryDelayMs: 0 });

    expect(outcome).toEqual({ graded: 1, failed: ['kb-01'] });
    expect(results[0]?.grade).toBeNull();
    expect(results[1]?.grade?.checks).toHaveLength(2);
  });
});

function fakeResult(id: string, overrides: Partial<CaseResult> = {}, ms = 2000): CaseResult {
  const found = trialCase(id);
  return {
    id,
    group: found.group,
    title: found.title,
    played: [
      {
        turn: found.turns[0]!,
        ms,
        events: [
          { type: 'usage', model: 'claude-sonnet-5-5', inputTokens: 4000, outputTokens: 300 },
          { type: 'tool_call', name: 'stripe-list-customers', arguments: {}, ok: true },
          say('ok'),
        ],
      },
    ],
    codeChecks: [{ name: 'handoff', pass: true, detail: '', harmful: false }],
    sources: { found: 1, expected: 1 },
    grade: passingGrade(1),
    review: null,
    error: null,
    ...overrides,
  };
}

describe('the report', () => {
  const ruleIds = cases.filter(entry => entry.group === 'rules' || entry.group === 'attack').map(entry => entry.id);

  it('counts verdicts, speed and cost per turn, and checks the targets', () => {
    const results: TrialResults = {
      setup: 'parlant',
      startedAt: '2026-11-07T00:00:00Z',
      cases: [
        ...ruleIds.map(id => fakeResult(id)),
        fakeResult('kb-01', { grade: { ...passingGrade(1), wrong: true, wrongReason: 'wrong price' } }, 12_000),
      ],
    };
    const summary = summarize(results);

    expect(summary).toMatchObject({ cases: 11, correct: 10, wrong: 1, ruleCorrect: 10, ruleCases: 10, medianMs: 2000 });
    expect(summary.slowestMs).toBe(12_000);
    // 4,000 in and 300 out on Sonnet: $0.008 + $0.003.
    expect(summary.costPerTurn).toBeCloseTo(0.011, 6);
    const met = Object.fromEntries(targets(summary).map(entry => [entry.target, entry.pass]));
    expect(met['Slowest 5% of turns under 10 seconds']).toBe(false);
    expect(met['Under $0.03 per turn']).toBe(true);
    expect(met['Stripe works through the gateway']).toBe(true);
  });

  it('lets a person override a verdict, and decides go or no-go against the baseline', () => {
    const reviewed = fakeResult('kb-02', { grade: { ...passingGrade(1), wrong: true, wrongReason: 'grader was wrong' } });
    reviewed.review = { verdict: 'correct', note: 'the answer matches the article' };
    expect(verdictFor(reviewed)).toBe('correct');

    const candidate: TrialResults = { setup: 'parlant', startedAt: '', cases: ruleIds.map(id => fakeResult(id)) };
    const baseline: TrialResults = {
      setup: 'baseline',
      startedAt: '',
      cases: ruleIds.map(id => fakeResult(id, { grade: { ...passingGrade(1), wrong: true, wrongReason: 'broke a rule' } })),
    };
    expect(comparisonReport(candidate, baseline)).toContain('**Decision: go.**');
    expect(comparisonReport(baseline, candidate)).toContain('**Decision: no-go.**');
  });
});
