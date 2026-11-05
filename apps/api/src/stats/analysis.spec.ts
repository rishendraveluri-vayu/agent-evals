import type { GraderSeverity } from '../contract';
import { type GradeInput, type Outcome, type TaskInput, type TrialInput, analyse, passRateVerdict } from './analysis';

/** A trial of arm `arm` with `outcome`, and optional grades and costs. */
function trial(id: string, arm: 'A' | 'B', outcome: Outcome, extra: Partial<TrialInput> = {}): TrialInput {
  return { trial_id: id, arm, outcome, grades: [], cost_usd: null, tokens: null, wall_s: null, retried: false, ...extra };
}

/** A task whose arm A passed `pa` of `na` and arm B `pb` of `nb` (the rest failed). */
function task(id: string, pa: number, na: number, pb: number, nb: number, extra: (arm: 'A' | 'B', i: number, pass: boolean) => Partial<TrialInput> = () => ({})): TaskInput {
  const trials: TrialInput[] = [];
  for (let i = 0; i < na; i += 1) trials.push(trial(`${id}-a${i}`, 'A', i < pa ? 'pass' : 'fail', extra('A', i, i < pa)));
  for (let i = 0; i < nb; i += 1) trials.push(trial(`${id}-b${i}`, 'B', i < pb ? 'pass' : 'fail', extra('B', i, i < pb)));
  return { task: `sha256:${id}`, task_id: id, trials };
}

const grade = (grader_id: string, verdict: string, severity: GraderSeverity | null = null, required = true): GradeInput => ({ grader_id, verdict, severity, required });
const fast = { resamples: 2000 };

describe('the verdict rule (D42, D43)', () => {
  it.each([
    [{ estimate: 15, low: 7, high: 23 }, 0.003, 'better'],
    [{ estimate: 15, low: 7, high: 23 }, 0.06, 'no_detectable_difference'],
    [{ estimate: -15, low: -23, high: -7 }, 0.01, 'worse'],
    [{ estimate: 1, low: -6, high: 8 }, 0.7, 'equivalent'],
    [{ estimate: -2, low: -14, high: 10 }, 0.7, 'no_detectable_difference'],
    [{ estimate: 3, low: 0.5, high: 6 }, 0.01, 'better'],
    [{ estimate: 4, low: -1, high: 9 }, 0.02, 'equivalent'],
  ] as const)('%j with p = %f over 20 tasks is %s', (diff, p, verdict) => {
    expect(passRateVerdict(diff, p, 20)).toBe(verdict);
  });

  it('gives no verdict but no detectable difference with fewer than 6 tasks', () => {
    expect(passRateVerdict({ estimate: 1, low: -2, high: 3 }, 0.9, 5)).toBe('no_detectable_difference');
    expect(passRateVerdict({ estimate: 30, low: 20, high: 40 }, 0.01, 5)).toBe('no_detectable_difference');
    expect(passRateVerdict({ estimate: 1, low: -2, high: 3 }, 0.9, 6)).toBe('equivalent');
  });

  it('never calls one tied task equivalent, though its task bootstrap has no width', () => {
    const s = analyse({ seed: 'e_one', tasks: [task('t', 2, 4, 2, 4)] }, fast).stats;
    expect(s?.diff).toEqual({ estimate: 0, low: 0, high: 0 });
    expect(s?.verdict).toBe('no_detectable_difference');
    // A zero-width interval rules nothing out, so it never says "as large as 0 points".
    expect(s?.not_ruled_out_points).toBeNull();
    expect(s?.verdict_text).toBe(
      'No detectable difference: 0.0 points (95% interval 0.0 to 0.0), p = 1 by the paired sign-flip test over 1 task. Every task gave the same difference, so the interval has no width and cannot say how large a difference could be hiding. With fewer than 6 tasks no other verdict is possible: the paired test cannot reach p < 0.05.',
    );
  });
});

describe('analyse: the aggregate', () => {
  it('is deterministic for a seed and changes with it', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, i % 7, 7, (i * 3) % 7, 7));
    const one = analyse({ seed: 'e_1', tasks }, fast).stats;
    const again = analyse({ seed: 'e_1', tasks }, fast).stats;
    const other = analyse({ seed: 'e_2', tasks }, fast).stats;
    expect(again).toEqual(one);
    expect(other?.diff.estimate).toBe(one?.diff.estimate);
    expect([other?.diff.low, other?.diff.high]).not.toEqual([one?.diff.low, one?.diff.high]);
  });

  it('weights each task equally: the estimate is the mean of the per-task differences, in points', () => {
    // Differences +20, +40, 0, +40 points; the pooled counts would weigh the 10-trial task more.
    const tasks = [task('t1', 3, 5, 4, 5), task('t2', 1, 5, 3, 5), task('t3', 4, 10, 4, 10), task('t4', 0, 5, 2, 5)];
    const s = analyse({ seed: 'e_eq', tasks }, fast).stats;
    expect(s?.diff.estimate).toBe(25);
    expect(s?.a).toMatchObject({ passed: 8, graded: 25, incomplete: 0 });
    expect(s?.a.rate).toBeCloseTo((0.6 + 0.2 + 0.4 + 0) / 4, 4);
    expect(s?.test).toEqual({ name: 'sign_flip', exact: true, flips: 16 });
    expect(s?.resamples).toBe(2000);
  });

  it('calls a large, consistent gain better, with the numbers in its sentence', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, 1 + (i % 3), 10, 7 + (i % 3), 10));
    const s = analyse({ seed: 'e_better', tasks }).stats;
    expect(s?.verdict).toBe('better');
    expect(s?.pass_rate_verdict).toBe('better');
    expect(s?.diff.estimate).toBe(60);
    expect(s?.diff.low).toBeGreaterThan(0);
    expect(s?.p_value).toBeCloseTo(2 / 1024, 6);
    expect(s?.verdict_text).toMatch(/^B passes more than A: \+60\.0 points \(95% interval \+\d+\.\d to \+\d+\.\d\), p = 0\.001953 by the paired sign-flip test over 10 tasks\.$/);
    expect(s?.not_ruled_out_points).toBeNull();
    expect(s?.resamples).toBe(10_000);
  });

  it('says how large a difference is not ruled out when it cannot tell', () => {
    const tasks = [task('t1', 2, 4, 3, 4), task('t2', 3, 4, 2, 4), task('t3', 1, 4, 2, 4)];
    const s = analyse({ seed: 'e_none', tasks }, fast).stats;
    expect(s?.verdict).toBe('no_detectable_difference');
    expect(s?.not_ruled_out_points).toBe(Math.round(Math.max(-(s?.diff.low ?? 0), s?.diff.high ?? 0) * 10) / 10);
    expect(s?.verdict_text).toContain(`Differences as large as ${s?.not_ruled_out_points} points are not ruled out.`);
  });

  it('calls a run with many tasks and trials and no change practically equivalent (40 tasks, 20 trials each)', () => {
    const tasks = Array.from({ length: 40 }, (_, i) => task(`t${i}`, 5 + (i % 10), 20, 5 + ((i + 3) % 10), 20));
    const s = analyse({ seed: 'e_equiv', tasks }).stats;
    expect(s?.diff.estimate).toBe(0);
    expect(s?.diff.low).toBeGreaterThanOrEqual(-10);
    expect(s?.diff.high).toBeLessThanOrEqual(10);
    expect(s?.verdict).toBe('equivalent');
    expect(s?.verdict_text).toContain('+/-10-point margin');
  });
});

describe('analyse: incomplete trials and one-arm-empty tasks', () => {
  it('leaves out trials with no outcome, and tasks where an arm has no decided trial, saying why', () => {
    const half = task('half', 2, 4, 3, 4);
    half.trials.push(trial('half-ai', 'A', 'incomplete'), trial('half-bi', 'B', 'incomplete'), trial('half-bi2', 'B', 'incomplete'));
    const noB: TaskInput = { task: 'sha256:nob', task_id: 'nob', trials: [trial('nob-a', 'A', 'pass'), trial('nob-b', 'B', 'incomplete')] };
    const empty: TaskInput = { task: 'sha256:empty', task_id: 'empty', trials: [] };
    const neither: TaskInput = { task: 'sha256:neither', task_id: 'neither', trials: [trial('n-a', 'A', 'incomplete'), trial('n-b', 'B', 'incomplete')] };
    const s = analyse({ seed: 'e_inc', tasks: [half, noB, empty, neither, task('ok', 1, 4, 2, 4)] }, fast).stats;
    expect(s?.tasks.map((t) => t.task_id)).toEqual(['half', 'ok']);
    expect(s?.tasks[0]).toMatchObject({ a: { passed: 2, graded: 4, incomplete: 1 }, b: { passed: 3, graded: 4, incomplete: 2 }, diff: { estimate: 25 } });
    expect(s?.b).toMatchObject({ passed: 5, graded: 8, incomplete: 2 });
    expect(s?.excluded_tasks).toEqual([
      { task: 'sha256:nob', task_id: 'nob', a: { passed: 1, graded: 1, incomplete: 0 }, b: { passed: 0, graded: 0, incomplete: 1 }, why: 'arm B has no decided trial (1 without an outcome)' },
      { task: 'sha256:empty', task_id: 'empty', a: { passed: 0, graded: 0, incomplete: 0 }, b: { passed: 0, graded: 0, incomplete: 0 }, why: 'neither arm has a decided trial (0 without an outcome)' },
      { task: 'sha256:neither', task_id: 'neither', a: { passed: 0, graded: 0, incomplete: 1 }, b: { passed: 0, graded: 0, incomplete: 1 }, why: 'neither arm has a decided trial (2 without an outcome)' },
    ]);
    expect(s?.diff.estimate).toBe(25);
  });

  it('gives no statistics, with a note, when no task has a decided trial in both arms', () => {
    const r = analyse({ seed: 'e_0', tasks: [{ task: 'sha256:x', task_id: 'x', trials: [trial('x-a', 'A', 'pass'), trial('x-b', 'B', 'incomplete')] }] });
    expect(r.stats).toBeNull();
    expect(r.note).toBe('No task has a decided trial (a pass or a fail) in both arms, so there is nothing to compare: all 1 task is left out.');
  });
});

describe('analyse: per-task flags (D41)', () => {
  it("flags a task with Fisher's test and Benjamini-Hochberg, with Newcombe's interval", () => {
    const tasks = [task('flip', 0, 10, 10, 10), task('same', 5, 10, 5, 10), task('small', 4, 10, 6, 10)];
    const s = analyse({ seed: 'e_bh', tasks }, fast).stats;
    const byId = Object.fromEntries((s?.tasks ?? []).map((t) => [t.task_id, t]));
    expect(byId.flip).toMatchObject({ beyond_noise: true, diff: { estimate: 100, low: 60.75, high: 100 } });
    expect(byId.flip.p_value).toBeCloseTo(1.083e-5, 7);
    expect(byId.same).toMatchObject({ beyond_noise: false, p_value: 1, diff: { estimate: 0 } });
    expect(byId.small.beyond_noise).toBe(false);
    expect(byId.small.q_value).toBeGreaterThanOrEqual(byId.small.p_value);
    expect(s?.correction).toBe('benjamini_hochberg');
  });
});

describe('analyse: the critical-failure guardrail (D10)', () => {
  // A's failures are a major check; B fails less often overall, but on a critical check.
  const guarded = (id: string) =>
    task(id, 3, 10, 7, 10, (arm, _i, pass) => ({
      grades: pass ? [grade('safety', 'pass', 'critical'), grade('tone', 'pass', 'major')] : arm === 'A' ? [grade('safety', 'pass', 'critical'), grade('tone', 'fail', 'major')] : [grade('safety', 'fail', 'critical'), grade('tone', 'pass', 'major')],
    }));

  it('keeps B from being called better while its critical failures rose beyond noise', () => {
    const s = analyse({ seed: 'e_guard', tasks: Array.from({ length: 10 }, (_, i) => guarded(`g${i}`)) }).stats;
    expect(s?.pass_rate_verdict).toBe('better');
    expect(s?.verdict).toBe('held_back');
    expect(s?.critical).toMatchObject({ status: 'rose', tasks: 10, blocks_better: true, a: { rate: 0, failed: 0, graded: 100 }, b: { rate: 0.3, failed: 30, graded: 100 } });
    expect(s?.critical.diff?.estimate).toBe(30);
    expect(s?.critical.diff?.low).toBeGreaterThan(0);
    expect(s?.critical.checks).toHaveLength(10);
    expect(s?.critical.checks[0]).toBe('g0/safety');
    expect(s?.verdict_text).toMatch(/^Not called better: the pass rate alone says B is better \(\+40\.0 points/);
    expect(s?.critical.text).toContain('so B is not called better although its pass rate rose');
  });

  it('lets B be better when the critical failures did not rise', () => {
    const fine = (id: string) => task(id, 3, 10, 7, 10, (_a, _i, pass) => ({ grades: [grade('safety', 'pass', 'critical'), grade('tone', pass ? 'pass' : 'fail', 'major')] }));
    const s = analyse({ seed: 'e_fine', tasks: Array.from({ length: 10 }, (_, i) => fine(`f${i}`)) }).stats;
    expect(s?.verdict).toBe('better');
    expect(s?.critical).toMatchObject({ status: 'did_not_rise', blocks_better: false, diff: { estimate: 0, low: 0, high: 0 } });
    expect(s?.critical.text).toContain('No rise beyond noise.');
  });

  it('says plainly when no check is marked critical, rather than claim safety', () => {
    const s = analyse({ seed: 'e_nocrit', tasks: [task('t1', 1, 5, 3, 5, () => ({ grades: [grade('tone', 'pass', 'major')] }))] }, fast).stats;
    expect(s?.critical).toEqual({
      status: 'no_critical_checks',
      checks: [],
      tasks: 0,
      a: null,
      b: null,
      diff: null,
      blocks_better: false,
      text: 'No check is marked critical in these tasks, so this comparison says nothing about critical failures.',
    });
  });

  it('counts only required critical checks, and only tasks that have one', () => {
    const optional = task('opt', 1, 5, 1, 5, () => ({ grades: [grade('safety', 'fail', 'critical', false)] }));
    const s = analyse({ seed: 'e_opt', tasks: [optional] }, fast).stats;
    expect(s?.critical.status).toBe('no_critical_checks');
  });

  it('says when the tasks with a critical check have no decided trial in both arms', () => {
    const crit: TaskInput = { task: 'sha256:c', task_id: 'c', trials: [trial('c-a', 'A', 'fail', { grades: [grade('safety', 'fail', 'critical')] }), trial('c-b', 'B', 'incomplete')] };
    const s = analyse({ seed: 'e_nodec', tasks: [crit, task('t', 1, 3, 2, 3)] }, fast).stats;
    expect(s?.critical).toMatchObject({ status: 'no_decided_trials', checks: ['c/safety'], diff: null, blocks_better: false });
  });
});

describe('analyse: the regression list (D10)', () => {
  it('lists every task where B dropped or a check fell, critical first, with the checks that got worse', () => {
    const dropped = task('dropped', 4, 5, 1, 5, (_a, _i, pass) => ({ grades: [grade('emi', pass ? 'pass' : 'fail', 'minor')] }));
    const checkFell = task('check-fell', 2, 5, 2, 5, (arm, i) => ({ grades: [grade('advice', 'pass'), grade('safety', arm === 'B' && i === 4 ? 'fail' : 'pass', 'critical', false)] }));
    const better = task('better', 1, 5, 4, 5);
    const s = analyse({ seed: 'e_reg', tasks: [dropped, checkFell, better] }, fast).stats;
    expect(s?.regressions.map((r) => r.task_id)).toEqual(['check-fell', 'dropped']);
    const [crit, drop] = s?.regressions ?? [];
    expect(crit).toMatchObject({ critical: true, diff: { estimate: 0 }, graders: [{ grader_id: 'safety', required: false, severity: 'critical', a: { passed: 5, graded: 5 }, b: { passed: 4, graded: 5 } }] });
    expect(drop).toMatchObject({ critical: false, beyond_noise: false, a: { passed: 4, graded: 5 }, b: { passed: 1, graded: 5 }, graders: [{ grader_id: 'emi', severity: 'minor' }] });
    expect(drop.diff?.estimate).toBe(-60);
    expect(drop.failed_trials.map((t) => [t.arm, t.trial_id])).toEqual([
      ['B', 'dropped-b1'],
      ['B', 'dropped-b2'],
      ['B', 'dropped-b3'],
      ['B', 'dropped-b4'],
      ['A', 'dropped-a4'],
    ]);
    expect(drop.failed_trials[0]).toEqual({ trial_id: 'dropped-b1', arm: 'B', failed_graders: ['emi'] });
    expect('cause' in drop.failed_trials[0]).toBe(false);
  });

  it('lists a task left out of the aggregate when one of its checks fell', () => {
    const t: TaskInput = {
      task: 'sha256:x',
      task_id: 'x',
      trials: [trial('x-a', 'A', 'incomplete', { grades: [grade('emi', 'pass')] }), trial('x-b', 'B', 'incomplete', { grades: [grade('emi', 'fail')] })],
    };
    const s = analyse({ seed: 'e_regx', tasks: [t, task('y', 1, 2, 1, 2)] }, fast).stats;
    expect(s?.regressions).toEqual([expect.objectContaining({ task_id: 'x', diff: null, beyond_noise: false, a: { passed: 0, graded: 0, incomplete: 1 } })]);
  });
});

describe('analyse: cost, tokens and time (proposal section 8)', () => {
  const costly = (id: string, retriedB = false) =>
    task(id, 2, 4, 2, 4, (arm, i) => ({
      cost_usd: arm === 'A' ? 0.01 : 0.012,
      tokens: arm === 'A' ? 1000 : 1100,
      wall_s: arm === 'A' ? 10 : retriedB && i === 0 ? 95 : 12,
      retried: arm === 'B' && retriedB && i === 0,
    }));

  it('gives the difference and relative difference with intervals, and no verdict', () => {
    const s = analyse({ seed: 'e_cost', tasks: [costly('c1'), costly('c2'), costly('c3')], madeUpPrices: true }, fast).stats;
    const by = Object.fromEntries((s?.costs ?? []).map((c) => [c.metric, c]));
    expect(Object.keys(by)).toEqual(['cost_usd', 'tokens', 'wall_s']);
    expect(by.cost_usd).toMatchObject({ tasks: 3, a: 0.01, b: 0.012, diff: { estimate: 0.002, low: 0.002, high: 0.002 }, relative: { estimate: 20 }, trials: { a: 12, b: 12 }, made_up_prices: true });
    expect(by.tokens).toMatchObject({ a: 1000, b: 1100, diff: { estimate: 100 }, relative: { estimate: 10 } });
    expect(by.wall_s).toMatchObject({ a: 10, b: 12, diff: { estimate: 2 }, left_out_retried: { a: 0, b: 0 }, retries_unknown: { a: 0, b: 0 } });
    expect(by.tokens.made_up_prices).toBeUndefined();
  });

  it('leaves a trial whose model call LiteLLM retried out of the time, and counts it (Retry Latency Skew)', () => {
    const s = analyse({ seed: 'e_retry', tasks: [costly('r1', true), costly('r2', true)] }, fast).stats;
    const wall = s?.costs.find((c) => c.metric === 'wall_s');
    expect(wall).toMatchObject({ b: 12, diff: { estimate: 2 }, trials: { a: 8, b: 6 }, left_out_retried: { a: 0, b: 2 } });
    // Cost and tokens keep the retried trials: a backoff wait costs nothing.
    expect(s?.costs.find((c) => c.metric === 'cost_usd')?.trials).toEqual({ a: 8, b: 8 });
  });

  it('keeps a trial whose retries were not recorded, and counts it as unknown', () => {
    const t = task('u', 1, 2, 1, 2, (arm) => ({ wall_s: 5, retried: arm === 'A' ? null : false }));
    const wall = analyse({ seed: 'e_unknown', tasks: [t] }, fast).stats?.costs.find((c) => c.metric === 'wall_s');
    expect(wall).toMatchObject({ trials: { a: 2, b: 2 }, retries_unknown: { a: 2, b: 0 } });
  });

  it('leaves a metric out when no task has a value in both arms', () => {
    expect(analyse({ seed: 'e_nocost', tasks: [task('n', 1, 2, 1, 2)] }, fast).stats?.costs).toEqual([]);
  });
});

describe('analyse: an A/A calibration run (D44)', () => {
  it('says it came out as it should when no difference is found', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, 2 + (i % 3), 5, 2 + ((i + 1) % 3), 5));
    const s = analyse({ seed: 'e_aa', tasks, calibration: true }, fast).stats;
    expect(['no_detectable_difference', 'equivalent']).toContain(s?.verdict);
    expect(s?.calibration?.as_expected).toBe(true);
    expect(s?.calibration?.text).toMatch(/^As it should, this A\/A run found no detectable difference/);
  });

  it('says the setup needs a look when an A/A run finds a difference', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, 1, 10, 9, 10));
    const s = analyse({ seed: 'e_aa_bad', tasks, calibration: true }, fast).stats;
    expect(s?.verdict).toBe('better');
    expect(s?.calibration?.as_expected).toBe(false);
    expect(s?.calibration?.text).toContain('the claim order or the arms sharing workers');
    expect(s?.calibration?.text).toContain('10 tasks were flagged beyond noise; in an A/A run every such flag is a false one.');
  });

  it('is null on an ordinary run', () => {
    expect(analyse({ seed: 'e_ab', tasks: [task('t', 1, 2, 1, 2)] }, fast).stats?.calibration).toBeNull();
  });
});
