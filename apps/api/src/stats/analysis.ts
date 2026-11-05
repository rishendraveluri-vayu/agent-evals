import type {
  CompareStats,
  CostStat,
  CriticalGuardrail,
  GraderSeverity,
  PassRateVerdict,
  Regression,
  RegressionGrader,
  RegressionTrial,
  StatsArmCounts,
  StatsExcludedTask,
  StatsInterval,
  StatsTask,
} from '../contract';
import { type TaskSample, binaryArm, bootstrapTasks, percentileInterval, valuesArm } from './bootstrap';
import { benjaminiHochberg, fisherExact, newcombe, signFlipTest } from './methods';
import { seededStream } from './random';

/**
 * The comparison of arm B against arm A (SP6), as Rishi settled it: D10 (the task is the unit, a
 * task bootstrap interval (revised 5 Nov from two levels to tasks only), a sign-flip test, a
 * critical-failure guardrail and a regression list), D41 (Benjamini-Hochberg for the per-task flags), D42 (a +/- 10 point equivalence margin)
 * and D43 (alpha 0.05, 95% intervals). Pure and deterministic: the same input and seed always
 * give the same numbers. docs/design.md, "Statistics", explains each step in plain words.
 */

/** Bump when a change here can move a number, so cached results are not reused across it. */
export const STATS_METHOD_VERSION = 'sp6-2';
export const RESAMPLES = 10_000;
export const LEVEL = 0.95;
export const ALPHA = 0.05;
export const BH_Q = 0.05;
export const MARGIN_POINTS = 10;
/**
 * Fewest tasks for a verdict other than "no detectable difference". Below 6 the exact sign-flip
 * test cannot reach p < 0.05 (its smallest p is 2/2^K), so better and worse are impossible; the
 * same floor keeps "practically equivalent" from resting on a task bootstrap of 1 to 5 tasks,
 * which under-covers (84% at K = 4 in the simulation) and has no width at all with one task.
 * Proposed 5 Nov, for Rishi to confirm (docs/known-limits.md, "Statistics").
 */
export const MIN_TASKS_FOR_VERDICT = 6;
/** At most this many failed trials per arm in each regression entry. */
export const FAILED_TRIALS_PER_ARM = 10;

export type Outcome = 'pass' | 'fail' | 'incomplete';

/** One grader's verdict on one trial, from the trial's current grading. */
export interface GradeInput {
  grader_id: string;
  required: boolean;
  verdict: string | null;
  severity: GraderSeverity | null;
}

/** One done trial (an agent outcome); infra failures never reach the statistics. */
export interface TrialInput {
  trial_id: string;
  arm: 'A' | 'B';
  /** From the latest finished grading; `incomplete` when it gave no outcome or there is none. */
  outcome: Outcome;
  grades: GradeInput[];
  cost_usd: number | null;
  tokens: number | null;
  wall_s: number | null;
  /** LiteLLM retried one of its model calls (D16): true, false, or null when not recorded. */
  retried: boolean | null;
}

export interface TaskInput {
  task: string;
  task_id: string;
  /** In a stable order (the caller sorts), so the resampling is repeatable. */
  trials: TrialInput[];
}

export interface AnalysisInput {
  /** Seeds every random stream: the experiment id. */
  seed: string;
  /** In the experiment's task order. */
  tasks: TaskInput[];
  /** An arm ran on a fake model, whose prices are made up. */
  madeUpPrices?: boolean;
  /** D44: this run is an A/A calibration (one config on both arms). */
  calibration?: boolean;
}

export interface AnalysisOptions {
  resamples?: number;
  /** 1, tasks only (D10 revised); a simulation test asks for 2 to show what the first design cost. */
  levels?: 1 | 2;
  exactMaxTasks?: number;
  flips?: number;
  /** Leave out cost, tokens and time (the simulation tests). */
  costs?: boolean;
}

export interface AnalysisResult {
  stats: CompareStats | null;
  /** Why stats is null. */
  note: string | null;
}

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const sig = (v: number): number => Number(v.toPrecision(4));
const pts = (v: number): string => `${v > 0 ? '+' : ''}${round(v, 1).toFixed(1)}`;
const pValueText = (p: number): string => (p < 0.001 ? 'p < 0.001' : `p = ${sig(p)}`);

function interval(estimate: number, lowHigh: [number, number], scale: number, places: number): StatsInterval {
  return { estimate: round(estimate * scale, places), low: round(lowHigh[0] * scale, places), high: round(lowHigh[1] * scale, places) };
}

function counts(trials: TrialInput[], arm: 'A' | 'B'): StatsArmCounts {
  let passed = 0;
  let graded = 0;
  let incomplete = 0;
  for (const t of trials) {
    if (t.arm !== arm) continue;
    if (t.outcome === 'incomplete') incomplete += 1;
    else {
      graded += 1;
      if (t.outcome === 'pass') passed += 1;
    }
  }
  return { passed, graded, incomplete };
}

const rate = (c: { passed: number; graded: number }): number => c.passed / c.graded;

function whyExcluded(a: StatsArmCounts, b: StatsArmCounts): string {
  const side = (c: StatsArmCounts, arm: string): string =>
    c.incomplete ? `arm ${arm} has no decided trial (${c.incomplete} without an outcome)` : `arm ${arm} has no finished trial`;
  if (!a.graded && !b.graded) return `neither arm has a decided trial (${a.incomplete + b.incomplete} without an outcome)`;
  return !a.graded ? side(a, 'A') : side(b, 'B');
}

/** D42 and D43, in the order the proposal gives: better or worse first, then equivalence. */
export function passRateVerdict(diff: StatsInterval, p: number, tasks: number, alpha = ALPHA, margin = MARGIN_POINTS): PassRateVerdict {
  if (tasks < MIN_TASKS_FOR_VERDICT) return 'no_detectable_difference';
  if (diff.low > 0 && p < alpha) return 'better';
  if (diff.high < 0 && p < alpha) return 'worse';
  // D55: a zero-width interval (every task gave the same difference) shows no spread, not a small
  // one, so it cannot support "practically equivalent".
  if (diff.high > diff.low && diff.low >= -margin && diff.high <= margin) return 'equivalent';
  return 'no_detectable_difference';
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2 };
const severityRank = (s: GraderSeverity | null): number => (s === null ? 3 : SEVERITY_RANK[s]);

function criticalFailed(t: TrialInput): boolean {
  return t.grades.some((g) => g.required && g.severity === 'critical' && g.verdict === 'fail');
}

function guardrail(input: AnalysisInput, eligible: Set<string>, rand: () => number, opts: Required<Pick<AnalysisOptions, 'resamples' | 'levels'>>): Omit<CriticalGuardrail, 'blocks_better' | 'text'> {
  const checks: string[] = [];
  const withChecks: TaskInput[] = [];
  for (const t of input.tasks) {
    const ids = new Set<string>();
    for (const tr of t.trials) for (const g of tr.grades) if (g.required && g.severity === 'critical') ids.add(g.grader_id);
    if (!ids.size) continue;
    checks.push(...[...ids].sort().map((id) => `${t.task_id}/${id}`));
    withChecks.push(t);
  }
  if (!checks.length) return { status: 'no_critical_checks', checks, tasks: 0, a: null, b: null, diff: null };
  const used = withChecks.filter((t) => eligible.has(t.task));
  if (!used.length) return { status: 'no_decided_trials', checks, tasks: 0, a: null, b: null, diff: null };
  const per = used.map((t) => {
    const arm = (letter: 'A' | 'B') => {
      const decided = t.trials.filter((x) => x.arm === letter && x.outcome !== 'incomplete');
      return { failed: decided.filter(criticalFailed).length, graded: decided.length };
    };
    return { a: arm('A'), b: arm('B') };
  });
  const samples: TaskSample[] = per.map((p) => ({ a: binaryArm(p.a.failed, p.a.graded), b: binaryArm(p.b.failed, p.b.graded) }));
  const draws = bootstrapTasks(samples, rand, opts);
  const k = per.length;
  const meanA = per.reduce((s, p) => s + p.a.failed / p.a.graded, 0) / k;
  const meanB = per.reduce((s, p) => s + p.b.failed / p.b.graded, 0) / k;
  const diff = interval(meanB - meanA, percentileInterval(draws.diff, LEVEL), 100, 2);
  const sum = (arm: 'a' | 'b') => per.reduce((acc, p) => ({ failed: acc.failed + p[arm].failed, graded: acc.graded + p[arm].graded }), { failed: 0, graded: 0 });
  return {
    status: diff.low > 0 ? 'rose' : 'did_not_rise',
    checks,
    tasks: k,
    a: { rate: round(meanA, 4), ...sum('a') },
    b: { rate: round(meanB, 4), ...sum('b') },
    diff,
  };
}

function guardrailText(g: Omit<CriticalGuardrail, 'text'>): string {
  if (g.status === 'no_critical_checks') return 'No check is marked critical in these tasks, so this comparison says nothing about critical failures.';
  const n = g.checks.length;
  const checks = `${n} critical ${n === 1 ? 'check' : 'checks'}`;
  if (g.status === 'no_decided_trials' || !g.diff) return `There ${n === 1 ? 'is' : 'are'} ${checks}, but no task with one has a decided trial in both arms, so critical failures could not be compared.`;
  const what = `Critical failures: ${pts(g.diff.estimate)} points (95% interval ${pts(g.diff.low)} to ${pts(g.diff.high)}) over ${g.tasks} ${g.tasks === 1 ? 'task' : 'tasks'} with ${checks}.`;
  if (g.blocks_better) return `${what} They rose beyond noise, so B is not called better although its pass rate rose.`;
  if (g.status === 'rose') return `${what} They rose beyond noise.`;
  return `${what} No rise beyond noise.`;
}

function regressionsOf(input: AnalysisInput, perTask: Map<string, StatsTask>): Regression[] {
  const out: { r: Regression; order: number }[] = [];
  input.tasks.forEach((t, order) => {
    const stat = perTask.get(t.task) ?? null;
    const byGrader = new Map<string, RegressionGrader>();
    for (const tr of t.trials) {
      for (const g of tr.grades) {
        if (g.verdict !== 'pass' && g.verdict !== 'fail') continue;
        let row = byGrader.get(g.grader_id);
        if (!row) {
          row = { grader_id: g.grader_id, required: g.required, severity: g.severity, a: { passed: 0, graded: 0 }, b: { passed: 0, graded: 0 } };
          byGrader.set(g.grader_id, row);
        }
        // The latest severity seen wins: a regraded trial carries the task file's current one.
        if (g.severity !== null) row.severity = g.severity;
        const side = tr.arm === 'A' ? row.a : row.b;
        side.graded += 1;
        if (g.verdict === 'pass') side.passed += 1;
      }
    }
    const fell = [...byGrader.values()]
      .filter((g) => g.a.graded > 0 && g.b.graded > 0 && rate(g.b) < rate(g.a))
      .sort((x, y) => severityRank(x.severity) - severityRank(y.severity) || rate(x.b) - rate(x.a) - (rate(y.b) - rate(y.a)) || x.grader_id.localeCompare(y.grader_id));
    const dropped = stat !== null && stat.diff.estimate < 0;
    if (!dropped && !fell.length) return;
    const failed = (arm: 'A' | 'B'): RegressionTrial[] =>
      t.trials
        .filter((x) => x.arm === arm && x.outcome === 'fail')
        .slice(0, FAILED_TRIALS_PER_ARM)
        // The cause (D64) is filled after the statistics, from rules that also read labels: causes/behaviour.ts.
        .map((x) => ({ trial_id: x.trial_id, arm, failed_graders: x.grades.filter((g) => g.required && g.verdict === 'fail').map((g) => g.grader_id), cause: null }));
    out.push({
      order,
      r: {
        task: t.task,
        task_id: t.task_id,
        a: stat?.a ?? counts(t.trials, 'A'),
        b: stat?.b ?? counts(t.trials, 'B'),
        diff: stat?.diff ?? null,
        beyond_noise: stat?.beyond_noise ?? false,
        critical: fell.some((g) => g.severity === 'critical'),
        graders: fell,
        failed_trials: [...failed('B'), ...failed('A')],
        causes_grew: [],
      },
    });
  });
  out.sort((x, y) => Number(y.r.critical) - Number(x.r.critical) || (x.r.diff?.estimate ?? Infinity) - (y.r.diff?.estimate ?? Infinity) || x.order - y.order);
  return out.map((e) => e.r);
}

const COST_METRICS: { metric: CostStat['metric']; places: number; value: (t: TrialInput) => number | null }[] = [
  { metric: 'cost_usd', places: 6, value: (t) => t.cost_usd },
  { metric: 'tokens', places: 1, value: (t) => t.tokens },
  // Retry backoff skews latency: a trial whose model call LiteLLM retried waited out the
  // backoff, so its time says more about the provider's rate limits than about the agent.
  { metric: 'wall_s', places: 2, value: (t) => (t.retried === true ? null : t.wall_s) },
];

function costsOf(input: AnalysisInput, opts: Required<Pick<AnalysisOptions, 'resamples' | 'levels'>>): CostStat[] {
  const out: CostStat[] = [];
  for (const m of COST_METRICS) {
    const samples: TaskSample[] = [];
    const trials = { a: 0, b: 0 };
    for (const t of input.tasks) {
      const vals = (arm: 'A' | 'B') => t.trials.filter((x) => x.arm === arm).map(m.value).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const a = vals('A');
      const b = vals('B');
      if (!a.length || !b.length) continue;
      trials.a += a.length;
      trials.b += b.length;
      samples.push({ a: valuesArm(a), b: valuesArm(b) });
    }
    if (!samples.length) continue;
    const draws = bootstrapTasks(samples, seededStream(`${input.seed}:${m.metric}`), opts);
    const meanA = samples.reduce((s, x) => s + x.a.mean, 0) / samples.length;
    const meanB = samples.reduce((s, x) => s + x.b.mean, 0) / samples.length;
    const stat: CostStat = {
      metric: m.metric,
      tasks: samples.length,
      a: round(meanA, m.places),
      b: round(meanB, m.places),
      diff: interval(meanB - meanA, percentileInterval(draws.diff, LEVEL), 1, m.places),
      relative: meanA !== 0 && draws.relative.length ? interval(meanB / meanA - 1, percentileInterval(draws.relative, LEVEL), 100, 2) : null,
      trials,
    };
    if (m.metric === 'wall_s') {
      const all = input.tasks.flatMap((t) => t.trials).filter((x) => typeof x.wall_s === 'number');
      const n = (arm: 'A' | 'B', pick: (x: TrialInput) => boolean) => all.filter((x) => x.arm === arm && pick(x)).length;
      stat.left_out_retried = { a: n('A', (x) => x.retried === true), b: n('B', (x) => x.retried === true) };
      stat.retries_unknown = { a: n('A', (x) => x.retried === null), b: n('B', (x) => x.retried === null) };
    }
    if (m.metric === 'cost_usd' && input.madeUpPrices) stat.made_up_prices = true;
    out.push(stat);
  }
  return out;
}

/**
 * `differing` counts the tasks whose arms passed at different rates: only they move the sign-flip
 * test, so over fewer than MIN_TASKS_FOR_VERDICT of them it cannot reach p < 0.05 whatever k is.
 */
function verdictText(v: PassRateVerdict | 'held_back', diff: StatsInterval, p: number, k: number, differing: number, notRuledOut: number | null): string {
  const numbers = `${pts(diff.estimate)} points (95% interval ${pts(diff.low)} to ${pts(diff.high)}), ${pValueText(p)} by the paired sign-flip test over ${k} ${k === 1 ? 'task' : 'tasks'}`;
  if (v === 'held_back') return `Not called better: the pass rate alone says B is better (${numbers}), but its critical failures rose beyond noise.`;
  if (v === 'better') return `B passes more than A: ${numbers}.`;
  if (v === 'worse') return `B passes less than A: ${numbers}.`;
  if (v === 'equivalent') return `Practically equivalent: ${numbers}. The whole interval lies inside the +/-${MARGIN_POINTS}-point margin set before the run.`;
  const few =
    k < MIN_TASKS_FOR_VERDICT
      ? ` With fewer than ${MIN_TASKS_FOR_VERDICT} tasks no other verdict is possible: the paired test cannot reach p < 0.05.`
      : differing > 0 && differing < MIN_TASKS_FOR_VERDICT
        ? ` Only ${differing} of the ${k} tasks passed at different rates in the two arms, and only those count in the paired test: over ${differing} its smallest possible p is ${2 / 2 ** differing}, so it could not reach p < 0.05 however large the difference.`
        : '';
  // Every task gave the same difference: the task bootstrap has no spread to show, so it cannot say
  // how large a difference could be hiding (docs/known-limits.md, "Statistics").
  const hiding = notRuledOut === null ? ' Every task gave the same difference, so the interval has no width and cannot say how large a difference could be hiding.' : ` Differences as large as ${notRuledOut} points are not ruled out.`;
  return `No detectable difference: ${numbers}.${hiding}${few}`;
}

/**
 * Pass rate, per task and in aggregate, with the verdict; the critical guardrail; the regression
 * list; and cost, tokens and time. Null (with a note) when no task has a decided trial in both arms.
 */
export function analyse(input: AnalysisInput, options: AnalysisOptions = {}): AnalysisResult {
  const opts = { resamples: options.resamples ?? RESAMPLES, levels: options.levels ?? 1 };
  const eligible: { t: TaskInput; a: StatsArmCounts; b: StatsArmCounts }[] = [];
  const excluded: StatsExcludedTask[] = [];
  for (const t of input.tasks) {
    const a = counts(t.trials, 'A');
    const b = counts(t.trials, 'B');
    if (a.graded > 0 && b.graded > 0) eligible.push({ t, a, b });
    else excluded.push({ task: t.task, task_id: t.task_id, a, b, why: whyExcluded(a, b) });
  }
  if (!eligible.length) {
    const n = input.tasks.length;
    return { stats: null, note: `No task has a decided trial (a pass or a fail) in both arms, so there is nothing to compare${n ? `: all ${n} ${n === 1 ? 'task is' : 'tasks are'} left out` : ''}.` };
  }

  // The aggregate: mean over tasks of B - A, task bootstrap interval, sign-flip test.
  const k = eligible.length;
  const diffs = eligible.map((e) => rate(e.b) - rate(e.a));
  const meanDiff = diffs.reduce((s, d) => s + d, 0) / k;
  const samples: TaskSample[] = eligible.map((e) => ({ a: binaryArm(e.a.passed, e.a.graded), b: binaryArm(e.b.passed, e.b.graded) }));
  const draws = bootstrapTasks(samples, seededStream(`${input.seed}:pass_rate`), opts);
  const diff = interval(meanDiff, percentileInterval(draws.diff, LEVEL), 100, 2);
  const test = signFlipTest(diffs, seededStream(`${input.seed}:sign_flip`), { exactMaxTasks: options.exactMaxTasks, flips: options.flips });
  const prVerdict = passRateVerdict(diff, test.p, k);

  // Per task: Newcombe's interval and Fisher's exact test; Benjamini-Hochberg flags (D41).
  const fisher = eligible.map((e) => fisherExact(e.b.passed, e.b.graded - e.b.passed, e.a.passed, e.a.graded - e.a.passed));
  const bh = benjaminiHochberg(fisher, BH_Q);
  const tasks: StatsTask[] = eligible.map((e, i) => {
    const [est, lo, hi] = newcombe(e.b.passed, e.b.graded, e.a.passed, e.a.graded);
    return {
      task: e.t.task,
      task_id: e.t.task_id,
      a: e.a,
      b: e.b,
      diff: interval(est, [lo, hi], 100, 2),
      p_value: sig(fisher[i]),
      q_value: sig(bh.adjusted[i]),
      beyond_noise: bh.rejected[i],
    };
  });
  const perTask = new Map(tasks.map((t) => [t.task, t]));

  // D10's guardrail: B is not called better while its critical failures rose beyond noise.
  const g = guardrail(input, new Set(eligible.map((e) => e.t.task)), seededStream(`${input.seed}:critical`), opts);
  const blocks = prVerdict === 'better' && g.status === 'rose';
  const critical: CriticalGuardrail = { ...g, blocks_better: blocks, text: guardrailText({ ...g, blocks_better: blocks }) };
  const verdict = blocks ? 'held_back' : prVerdict;

  const notRuledOut = prVerdict === 'no_detectable_difference' && diff.high > diff.low ? round(Math.max(Math.abs(diff.low), Math.abs(diff.high)), 1) : null;
  const text = verdictText(verdict, diff, test.p, k, diffs.filter((d) => d !== 0).length, notRuledOut);

  const pooled = (arm: 'a' | 'b') =>
    eligible.reduce((acc, e) => ({ passed: acc.passed + e[arm].passed, graded: acc.graded + e[arm].graded, incomplete: acc.incomplete + e[arm].incomplete }), { passed: 0, graded: 0, incomplete: 0 });
  const meanRate = (arm: 'a' | 'b') => round(eligible.reduce((s, e) => s + rate(e[arm]), 0) / k, 4);

  let calibration: CompareStats['calibration'] = null;
  if (input.calibration) {
    const flagged = tasks.filter((t) => t.beyond_noise).length;
    const flags = flagged ? ` ${flagged} ${flagged === 1 ? 'task was' : 'tasks were'} flagged beyond noise; in an A/A run every such flag is a false one.` : '';
    const width = round(diff.high - diff.low, 1);
    calibration =
      verdict === 'no_detectable_difference' || verdict === 'equivalent'
        ? { as_expected: true, text: `As it should, this A/A run found no detectable difference: the same config on both arms gave ${pts(diff.estimate)} points (95% interval ${pts(diff.low)} to ${pts(diff.high)}). Its interval, ${width} points wide, is this setup's own noise at this N and task count.${flags}` }
        : { as_expected: false, text: `This A/A run found a difference where there should be none (${pts(diff.estimate)} points, 95% interval ${pts(diff.low)} to ${pts(diff.high)}, ${pValueText(test.p)}). The setup's noise, or a side-by-side effect such as the claim order or the arms sharing workers, needs a look before any A/B result on it is trusted.${flags}` };
  }

  const stats: CompareStats = {
    method_version: STATS_METHOD_VERSION,
    measure: 'pass_rate',
    level: LEVEL,
    alpha: ALPHA,
    margin_points: MARGIN_POINTS,
    method: 'paired_task_bootstrap',
    resamples: opts.resamples,
    seed: input.seed,
    a: { rate: meanRate('a'), ...pooled('a') },
    b: { rate: meanRate('b'), ...pooled('b') },
    diff,
    p_value: sig(test.p),
    test: { name: 'sign_flip', exact: test.exact, flips: test.flips },
    verdict,
    pass_rate_verdict: prVerdict,
    verdict_text: text,
    not_ruled_out_points: notRuledOut,
    tasks,
    excluded_tasks: excluded,
    correction: 'benjamini_hochberg',
    critical,
    regressions: regressionsOf(input, perTask),
    costs: options.costs === false ? [] : costsOf(input, opts),
    aa: null,
    calibration,
    judge: null,
  };
  return { stats, note: null };
}
