// Plays the trial's test cases through a setup, scores them in code and grades them with Claude.
import type { AgentUnderTest, SessionCustomer } from './agent-under-test.js';
import type { Article, StripeCustomer, TrialCase } from './cases.js';
import { gradeCase, type GraderOptions } from './grade.js';
import type { CaseResult } from './report.js';
import { scoreCase, sourcesFound, type PlayedTurn } from './score.js';

const TURN_TIMEOUT_MS = 120_000;

export function sessionCustomer(trialCase: TrialCase, customers: StripeCustomer[]): SessionCustomer {
  if (!trialCase.customer.verified) return { verified: false };
  const customerId = trialCase.customer.stripe_customer;
  const customer = customers.find(entry => entry.id === customerId);
  if (!customer) throw new Error(`${trialCase.id}: unknown Stripe customer ${customerId}`);
  return { verified: true, name: customer.name, email: customer.email };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took over ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runCase(agent: AgentUnderTest, trialCase: TrialCase, customers: StripeCustomer[]): Promise<CaseResult> {
  const played: PlayedTurn[] = [];
  let error: string | null = null;
  try {
    const session = await agent.startSession(sessionCustomer(trialCase, customers));
    try {
      for (const [index, turn] of trialCase.turns.entries()) {
        const started = performance.now();
        const events = await withTimeout(session.play(turn), TURN_TIMEOUT_MS, `turn ${index + 1}`);
        played.push({ turn, events, ms: Math.round(performance.now() - started) });
      }
    } finally {
      await session.end();
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return {
    id: trialCase.id,
    group: trialCase.group,
    title: trialCase.title,
    played,
    codeChecks: scoreCase(trialCase, played),
    sources: sourcesFound(trialCase, played),
    grade: null,
    review: null,
    error,
  };
}

// Grades the results that have no grade yet, in place. A failed grade is left empty so the next
// run of `grade` tries it again; it doesn't stop the other cases.
export async function gradeResults(
  results: CaseResult[],
  cases: TrialCase[],
  articles: Article[],
  customers: StripeCustomer[],
  options: GraderOptions,
  log: (line: string) => void = () => {},
): Promise<{ graded: number; failed: string[] }> {
  let graded = 0;
  const failed: string[] = [];
  for (const result of results) {
    if (result.grade || result.error) continue;
    const trialCase = cases.find(entry => entry.id === result.id);
    if (!trialCase) throw new Error(`No case ${result.id}`);
    try {
      result.grade = await gradeCase(trialCase, result.played, articles, customers, options);
      graded += 1;
      log(`graded ${result.id}`);
    } catch (caught) {
      failed.push(result.id);
      log(`couldn't grade ${result.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  return { graded, failed };
}
