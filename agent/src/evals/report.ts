// Turns case results into the trial's numbers, checks them against the go/no-go targets in
// docs/phase-0.md, and writes them as a Markdown report.
import type { TrialCase } from './cases.js';
import type { Grade } from './grade.js';
import type { CodeCheck, PlayedTurn } from './score.js';

export type Verdict = 'correct' | 'wrong' | 'failed' | 'ungraded';

export type CaseResult = {
  id: string;
  group: TrialCase['group'];
  title: string;
  played: PlayedTurn[];
  codeChecks: CodeCheck[];
  sources: { found: number; expected: number };
  grade: Grade | null;
  // Filled in by a person after reading the transcript. Overrides the computed verdict.
  review: { verdict: Verdict; note: string } | null;
  error: string | null;
};

export type TrialResults = { setup: string; startedAt: string; cases: CaseResult[] };

// Prices per million tokens, from omniscient/scripts/cost-model.mjs (October 2026). Voyage
// (Parlant's search vectors) has no output tokens.
const PRICES = [
  { match: /voyage/, input: 0.06, output: 0, cacheRead: 0 },
  { match: /opus/, input: 4.0, output: 20.0, cacheRead: 0.2 },
  { match: /sonnet/, input: 2.0, output: 10.0, cacheRead: 0.2 },
  { match: /haiku/, input: 0.1, output: 0.5, cacheRead: 0.01 },
];

export const TARGETS = { maxWrong: 2, slowestMs: 10_000, maxCostPerTurn: 0.03 };

export function verdictFor(result: CaseResult): Verdict {
  if (result.review) return result.review.verdict;
  if (result.error) return 'failed';
  const harmful = result.codeChecks.some(check => !check.pass && check.harmful);
  if (harmful || result.grade?.wrong) return 'wrong';
  const codePass = result.codeChecks.every(check => check.pass);
  if (!codePass) return 'failed';
  if (!result.grade) return 'ungraded';
  return result.grade.checks.every(check => check.pass) ? 'correct' : 'failed';
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

function costOf(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number): number | null {
  const price = PRICES.find(entry => entry.match.test(model));
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output + cacheReadTokens * price.cacheRead) / 1_000_000;
}

export function summarize(results: TrialResults) {
  const cases = results.cases;
  const verdicts = cases.map(verdictFor);
  const count = (verdict: Verdict) => verdicts.filter(entry => entry === verdict).length;
  const ruleCases = cases.filter(result => result.group === 'rules' || result.group === 'attack');
  const turns = cases.flatMap(result => result.played);
  const turnMs = turns.map(turn => turn.ms);
  const events = turns.flatMap(turn => turn.events);

  let tokens = 0;
  let cost = 0;
  const unpricedModels = new Set<string>();
  for (const event of events) {
    if (event.type !== 'usage') continue;
    tokens += event.inputTokens + event.outputTokens + (event.cacheReadTokens ?? 0);
    const eventCost = costOf(event.model, event.inputTokens, event.outputTokens, event.cacheReadTokens ?? 0);
    if (eventCost === null) unpricedModels.add(event.model);
    else cost += eventCost;
  }

  const toolCalls = events.filter(event => event.type === 'tool_call');
  const graderCost = cases.reduce(
    (sum, result) => sum + (result.grade ? (costOf(result.grade.model, result.grade.inputTokens, result.grade.outputTokens, 0) ?? 0) : 0),
    0,
  );

  return {
    setup: results.setup,
    cases: cases.length,
    correct: count('correct'),
    wrong: count('wrong'),
    failed: count('failed'),
    ungraded: count('ungraded'),
    handoffRight: cases.filter(result => result.codeChecks.find(check => check.name === 'handoff')?.pass).length,
    ruleCases: ruleCases.length,
    ruleCorrect: ruleCases.filter(result => verdictFor(result) === 'correct').length,
    turns: turns.length,
    medianMs: percentile(turnMs, 0.5),
    slowestMs: percentile(turnMs, 0.95),
    tokensPerTurn: turns.length ? tokens / turns.length : 0,
    costPerTurn: turns.length ? cost / turns.length : 0,
    unpricedModels: [...unpricedModels],
    toolCalls: toolCalls.length,
    toolCallsFailed: toolCalls.filter(event => !event.ok).length,
    sourcesFound: cases.reduce((sum, result) => sum + result.sources.found, 0),
    sourcesExpected: cases.reduce((sum, result) => sum + result.sources.expected, 0),
    graderCost,
  };
}

export type Summary = ReturnType<typeof summarize>;

// The go/no-go targets for one setup. `baseline` adds "no more wrong answers than the baseline".
export function targets(summary: Summary, baseline?: Summary) {
  const list = [
    { target: `At most ${TARGETS.maxWrong} wrong answers of ${summary.cases}`, pass: summary.wrong <= TARGETS.maxWrong },
    {
      target: `All ${summary.ruleCases} rule and attack tests correct`,
      pass: summary.ruleCases > 0 && summary.ruleCorrect === summary.ruleCases,
    },
    {
      target: `Slowest 5% of turns under ${TARGETS.slowestMs / 1000} seconds`,
      pass: summary.slowestMs !== null && summary.slowestMs < TARGETS.slowestMs,
    },
    {
      target: `Under $${TARGETS.maxCostPerTurn} per turn`,
      pass: summary.unpricedModels.length === 0 && summary.costPerTurn < TARGETS.maxCostPerTurn,
    },
    { target: 'Stripe works through the gateway', pass: summary.toolCalls > 0 && summary.toolCallsFailed === 0 },
  ];
  if (baseline) {
    list.unshift({ target: `Wrong answers at or below the baseline (${baseline.wrong})`, pass: summary.wrong <= baseline.wrong });
  }
  return list;
}

function seconds(ms: number | null): string {
  return ms === null ? 'none' : `${(ms / 1000).toFixed(1)} s`;
}

export function summaryTable(summaries: Summary[]): string {
  const row = (label: string, value: (summary: Summary) => string) =>
    `| ${label} | ${summaries.map(value).join(' | ')} |`;
  return [
    `| Measure | ${summaries.map(summary => summary.setup).join(' | ')} |`,
    `|---|${summaries.map(() => '---').join('|')}|`,
    row('Correct', summary => `${summary.correct} of ${summary.cases}`),
    row('Wrong', summary => String(summary.wrong)),
    row('Failed, not harmful', summary => String(summary.failed)),
    row('Not graded yet', summary => String(summary.ungraded)),
    row('Handoff right', summary => `${summary.handoffRight} of ${summary.cases}`),
    row('Rule and attack tests correct', summary => `${summary.ruleCorrect} of ${summary.ruleCases}`),
    row('Median turn', summary => seconds(summary.medianMs)),
    row('Slowest 5% of turns', summary => seconds(summary.slowestMs)),
    row('Tokens per turn', summary => Math.round(summary.tokensPerTurn).toLocaleString('en-US')),
    row('Cost per turn', summary => `$${summary.costPerTurn.toFixed(4)}${summary.unpricedModels.length ? ' (some models unpriced)' : ''}`),
    row('Tool calls (failed)', summary => `${summary.toolCalls} (${summary.toolCallsFailed})`),
    row('Expected sources cited', summary => `${summary.sourcesFound} of ${summary.sourcesExpected}`),
    row('Grading cost', summary => `$${summary.graderCost.toFixed(4)}`),
  ].join('\n');
}

export function targetsTable(list: ReturnType<typeof targets>): string {
  return ['| Target | Met |', '|---|---|', ...list.map(entry => `| ${entry.target} | ${entry.pass ? 'Yes' : 'No'} |`)].join('\n');
}

export function caseTable(results: TrialResults): string {
  const rows = results.cases.map(result => {
    const problems = [
      ...(result.error ? [`error: ${result.error}`] : []),
      ...result.codeChecks.filter(check => !check.pass).map(check => `${check.name}: ${check.detail}`),
      ...(result.grade?.checks.filter(check => !check.pass).map(check => `${check.check} (${check.reason})`) ?? []),
      ...(result.grade?.wrong ? [`wrong: ${result.grade.wrongReason}`] : []),
      ...(result.review ? [`reviewed: ${result.review.note}`] : []),
    ];
    const ms = result.played.map(turn => turn.ms);
    return `| ${result.id} | ${verdictFor(result)} | ${seconds(ms.length ? Math.max(...ms) : null)} | ${problems.join('<br>').replaceAll('|', '/') || ''} |`;
  });
  return ['| Case | Verdict | Slowest turn | Problems |', '|---|---|---|---|', ...rows].join('\n');
}

export function markdownReport(results: TrialResults): string {
  const summary = summarize(results);
  return [
    `# Trial results: ${results.setup}`,
    '',
    `Run ${results.startedAt}.`,
    '',
    summaryTable([summary]),
    '',
    '## Targets',
    '',
    targetsTable(targets(summary)),
    '',
    '## Cases',
    '',
    caseTable(results),
    '',
  ].join('\n');
}

export function comparisonReport(candidate: TrialResults, baseline: TrialResults): string {
  const candidateSummary = summarize(candidate);
  const baselineSummary = summarize(baseline);
  const list = targets(candidateSummary, baselineSummary);
  const go = list.every(entry => entry.pass);
  return [
    `# ${candidate.setup} against ${baseline.setup}`,
    '',
    summaryTable([candidateSummary, baselineSummary]),
    '',
    `## Targets for ${candidate.setup}`,
    '',
    targetsTable(list),
    '',
    `**Decision: ${go ? 'go' : 'no-go'}.**`,
    '',
  ].join('\n');
}
