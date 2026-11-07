// The Parlant trial's test runner (docs/phase-0.md, Day 10). Run with: npm run trial -- <command>
//   run --setup <name> [--cases kb-01,dc-02] [--no-grade]   play the cases through a setup
//   grade <results.json>                                     grade cases that have no grade yet
//   report <results.json>                                    rescore and rewrite the Markdown report
//   compare <candidate.json> <baseline.json>                 the go/no-go table
// Grading needs ANTHROPIC_API_KEY. TRIAL_GRADER_MODEL picks the model (default claude-haiku-5-5).
// The baseline needs ANTHROPIC_API_KEY, and GATEWAY_MCP_URL and GATEWAY_TOKEN for Stripe.
// Results go to evals/trial/results/: a JSON file to keep and review, and a Markdown report.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AgentUnderTest } from './evals/agent-under-test.js';
import { loadArticles, loadCases, loadStripeCustomers, TRIAL_DIR } from './evals/cases.js';
import { comparisonReport, markdownReport, type TrialResults } from './evals/report.js';
import { gradeResults, runCase } from './evals/runner.js';
import { scoreCase, sourcesFound } from './evals/score.js';
import { createBaseline } from './evals/setups/baseline.js';
import { createDisconnectedStripe, createGatewayStripe } from './evals/setups/stripe.js';
import { createMcpClient } from './mcp-client.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Stripe through the team's gateway server (GATEWAY_MCP_URL and GATEWAY_TOKEN, from
// gateway/trial.mjs make-server). Without them, Stripe calls fail and show as failed tool calls.
function stripeFromEnv() {
  const url = process.env.GATEWAY_MCP_URL;
  if (!url) {
    console.log('GATEWAY_MCP_URL is not set: Stripe calls will fail.');
    return createDisconnectedStripe();
  }
  return createGatewayStripe(createMcpClient(url, requiredEnv('GATEWAY_TOKEN')));
}

// The setups under test. Parlant is added with its adapter.
const SETUPS: Record<string, () => Promise<AgentUnderTest>> = {
  baseline: async () =>
    createBaseline({
      anthropic: { apiKey: requiredEnv('ANTHROPIC_API_KEY') },
      stripe: stripeFromEnv(),
      articles: loadArticles(),
      model: process.env.BASELINE_MODEL,
    }),
};

const RESULTS_DIR = new URL('results/', TRIAL_DIR);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    setup: { type: 'string' },
    cases: { type: 'string' },
    'no-grade': { type: 'boolean', default: false },
  },
});

const cases = loadCases();
const customers = loadStripeCustomers();
const articles = loadArticles();
const [command, ...files] = positionals;

function readResults(path: string): TrialResults {
  return JSON.parse(readFileSync(path, 'utf8')) as TrialResults;
}

function save(results: TrialResults, path: string): void {
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(path.replace(/\.json$/, '.md'), markdownReport(results));
  console.log(`Saved ${path} and its .md report`);
}

function graderOptions() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return { apiKey, model: process.env.TRIAL_GRADER_MODEL };
}

async function grade(results: TrialResults, path: string): Promise<void> {
  const options = graderOptions();
  if (!options) {
    console.log('ANTHROPIC_API_KEY is not set, so the cases are not graded. Run grade later.');
    return;
  }
  const { graded, failed } = await gradeResults(results.cases, cases, articles, customers, options, console.log);
  save(results, path);
  console.log(`Graded ${graded}${failed.length ? `; couldn't grade ${failed.join(', ')}. Run grade again to retry them.` : '.'}`);
}

async function run(): Promise<void> {
  const setupName = values.setup;
  const makeSetup = setupName ? SETUPS[setupName] : undefined;
  if (!setupName || !makeSetup) {
    const names = Object.keys(SETUPS);
    throw new Error(`Pick a setup with --setup. Available: ${names.length ? names.join(', ') : 'none yet'}`);
  }
  const wanted = values.cases?.split(',').map(id => id.trim());
  const selected = wanted ? cases.filter(entry => wanted.includes(entry.id)) : cases;
  const unknown = wanted?.filter(id => !cases.some(entry => entry.id === id)) ?? [];
  if (unknown.length) throw new Error(`Unknown cases: ${unknown.join(', ')}`);

  const agent = await makeSetup();
  const results: TrialResults = { setup: agent.name, startedAt: new Date().toISOString(), cases: [] };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = new URL(`${agent.name}-${results.startedAt.replaceAll(':', '-').slice(0, 19)}.json`, RESULTS_DIR).pathname;

  for (const trialCase of selected) {
    const result = await runCase(agent, trialCase, customers);
    results.cases.push(result);
    const failedChecks = result.codeChecks.filter(check => !check.pass).map(check => check.name);
    console.log(`${trialCase.id} ${result.error ? `error: ${result.error}` : failedChecks.length ? `failed ${failedChecks.join(', ')}` : 'ok'}`);
  }
  save(results, path);
  if (!values['no-grade']) await grade(results, path);
}

// Recomputes the code checks from the saved transcripts, for when the cases or checks change.
function rescore(results: TrialResults): void {
  for (const result of results.cases) {
    const trialCase = cases.find(entry => entry.id === result.id);
    if (!trialCase) throw new Error(`No case ${result.id}`);
    result.codeChecks = scoreCase(trialCase, result.played);
    result.sources = sourcesFound(trialCase, result.played);
  }
}

async function main(): Promise<void> {
  if (command === 'run') return run();
  const [first, second] = files;
  if (command === 'grade' && first) return grade(readResults(first), first);
  if (command === 'report' && first) {
    const results = readResults(first);
    rescore(results);
    return save(results, first);
  }
  if (command === 'compare' && first && second) {
    console.log(comparisonReport(readResults(first), readResults(second)));
    return;
  }
  throw new Error('Usage: npm run trial -- run --setup <name> | grade <file> | report <file> | compare <candidate> <baseline>');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
