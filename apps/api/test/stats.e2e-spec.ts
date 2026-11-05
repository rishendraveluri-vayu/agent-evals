import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import type { CompareResponse, ExperimentDetail, ExperimentSummary, TrialRowSummary } from '../src/contract';
import { type TestEnv, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/**
 * SP6 on the real API and Postgres, with LiteLLM stubbed and the grader played by the test: the
 * comparison's statistics (D10, D41, D42, D43, D50) and A/A calibration runs (D44). No model is
 * called. The tasks are synthetic, written for this file only.
 */
const STAT_TASKS = Array.from({ length: 7 }, (_, i) => `stat-${i + 1}`);

// Each test claims, reports and grades up to 28 trials over HTTP, then computes 10,000 resamples:
// a few seconds alone, more beside the other suites.
jest.setTimeout(60_000);

describeWithDb('statistics and A/A calibration (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let A: string;
  let B: string;
  let e: ReturnType<typeof engine>;

  beforeAll(async () => {
    env = await bootEnv();
    // Seven synthetic tasks, each graded by one critical check (D10's severity).
    for (const id of STAT_TASKS) {
      await fs.mkdir(path.join(env.tasksDir, id), { recursive: true });
      const task = {
        id,
        version: '1',
        split: 'held_out',
        summary: `Synthetic statistics task ${id} (test fixture)`,
        messages: [{ role: 'user', content: `Question ${id}` }],
        client_sim: null,
        graders: [{ id: 'safety', type: 'end_state', states: ['answered'], severity: 'critical' }],
      };
      await fs.writeFile(path.join(env.tasksDir, id, 'task.json'), JSON.stringify(task, null, 2));
    }
    cat = await catalogue(env.http);
    A = await makeConfig(env.http, cat, { name: 'arm A', settings: { temperature: 0.2 } });
    B = await makeConfig(env.http, cat, { name: 'arm B', settings: { temperature: 0.7 } });
    e = engine(env);
  });

  afterAll(async () => {
    await env.close();
  });

  beforeEach(async () => {
    await e.quiesce();
  });

  const tasks = (): string[] => STAT_TASKS.map((id) => cat.tasks[id]);
  const compare = async (id: string): Promise<CompareResponse> => (await request(env.http).get(`/api/experiments/${id}/compare`).expect(200)).body as CompareResponse;
  const trials = async (id: string): Promise<TrialRowSummary[]> => (await request(env.http).get(`/api/experiments/${id}/trials`).expect(200)).body as TrialRowSummary[];

  type Verdict = 'pass' | 'fail' | 'incomplete';
  /** Claims, reports and grades every claimable trial; `verdict` picks each one's outcome from its claim. */
  async function run(worker: string, verdict: (claim: { config: string; repeat: number; task: string }) => Verdict, grade = true): Promise<number> {
    let n = 0;
    const outcome = new Map<string, Verdict>();
    for (let c = await e.claim(worker); c; c = await e.claim(worker)) {
      const spec = c.spec as { trial: { config_hash: string; repeat_index: number; task_id: string } };
      outcome.set(c.trial_id, verdict({ config: spec.trial.config_hash, repeat: spec.trial.repeat_index, task: spec.trial.task_id }));
      await e.report(c, worker, 'agent');
      n += 1;
    }
    if (grade) await e.grade(`g-${worker}`, (id) => outcome.get(id) ?? 'pass');
    return n;
  }

  it("reports per arm the money figures written without a tool (D61), from each trial's runner report", async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: tasks().slice(0, 2), n: 2, futility: { enabled: false } });
    const checks = (extra: Record<string, unknown>) => ({ path: 'checks.json', valid: true, errors: [], unsupported_amounts: 0, missing_tools: null, ...extra });
    let k = 0;
    for (let c = await e.claim('w-prose'); c; c = await e.claim('w-prose')) {
      const spec = c.spec as { trial: { config_hash: string } };
      // Arm A works its sums out in prose (3 of 10 figures each); arm B uses the tools (0 of 8),
      // except one trial whose checks predate D61 and so have no counts.
      if (spec.trial.config_hash === A) await e.report(c, 'w-prose', 'agent', { checks: checks({ amounts: 10, derived_in_prose: 3 }) });
      else if (k++ === 0) await e.report(c, 'w-prose', 'agent', { checks: checks({ unsupported_amounts: 1 }) });
      else await e.report(c, 'w-prose', 'agent', { checks: checks({ amounts: 8, derived_in_prose: 0 }) });
    }
    await e.grade('g-prose', () => 'pass');
    const cmp = await compare(exp.id);
    expect(cmp.status).toBe('complete');
    expect(cmp.prose_figures).toEqual([
      { arm: 'A', trials_measured: 4, trials_unmeasured: 0, amounts: 40, derived_in_prose: 12, per_trial: 3, share: 0.3 },
      { arm: 'B', trials_measured: 3, trials_unmeasured: 1, amounts: 24, derived_in_prose: 0, per_trial: 0, share: 0 },
    ]);
    // A measure beside the verdict, not part of it: both arms pass every task.
    expect(cmp.stats?.verdict).not.toBe('better');
  });

  it("fills a complete experiment's comparison with the verdict, per-task flags, the guardrail and costs", async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: tasks(), n: 2, futility: { enabled: false } });
    // Arm A fails every task; arm B passes every one.
    expect(await run('w-ab', ({ config }) => (config === B ? 'pass' : 'fail'))).toBe(28);
    const cmp = await compare(exp.id);
    expect(cmp).toMatchObject({ status: 'complete', stats_note: null });
    const s = cmp.stats!;
    expect(s).toMatchObject({
      method: 'paired_task_bootstrap',
      measure: 'pass_rate',
      level: 0.95,
      alpha: 0.05,
      margin_points: 10,
      resamples: 10_000,
      seed: exp.id,
      verdict: 'better',
      pass_rate_verdict: 'better',
      diff: { estimate: 100, low: 100, high: 100 },
      a: { rate: 0, passed: 0, graded: 14, incomplete: 0 },
      b: { rate: 1, passed: 14, graded: 14, incomplete: 0 },
      test: { name: 'sign_flip', exact: true, flips: 128 },
      correction: 'benjamini_hochberg',
      excluded_tasks: [],
      aa: null,
      calibration: null,
      judge: null,
    });
    expect(s.p_value).toBeCloseTo(2 / 128, 4);
    expect(s.tasks.map((t) => t.task_id)).toEqual(STAT_TASKS);
    // 2 of 2 against 0 of 2 per task: Fisher's p is 1/3, so no task is beyond noise on its own.
    expect(s.tasks[0]).toMatchObject({ a: { passed: 0, graded: 2 }, b: { passed: 2, graded: 2 }, beyond_noise: false });
    expect(s.tasks[0].p_value).toBeCloseTo(0.3333, 4);
    // A failed its critical check on every trial and B on none: they fell, so nothing is blocked.
    expect(s.critical).toMatchObject({ status: 'did_not_rise', tasks: 7, blocks_better: false, a: { rate: 1, failed: 14, graded: 14 }, b: { rate: 0, failed: 0 } });
    expect(s.critical.checks).toEqual(STAT_TASKS.map((id) => `${id}/safety`));
    expect(s.regressions).toEqual([]);
    const costs = Object.fromEntries(s.costs.map((c) => [c.metric, c]));
    expect(costs.cost_usd).toMatchObject({ tasks: 7, a: 0.00136, b: 0.00136, diff: { estimate: 0 }, made_up_prices: true, trials: { a: 14, b: 14 } });
    expect(costs.tokens).toMatchObject({ a: 1280, b: 1280 });
    // The test runner reports predate the retry count, so their retries are unknown, kept and counted.
    expect(costs.wall_s).toMatchObject({ a: 12.5, b: 12.5, left_out_retried: { a: 0, b: 0 }, retries_unknown: { a: 14, b: 14 } });
  });

  it('recomputes after a regrade, and leaves out a trial LiteLLM retried from the time', async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: tasks(), n: 1, futility: { enabled: false } });
    await run('w-re', ({ config }) => (config === B ? 'pass' : 'fail'));
    // One of arm B's trials had a retried model call: its span says LiteLLM tried twice.
    const bTrial = (await trials(exp.id)).find((t) => t.config_hash === B)!;
    await env.pool.query(
      `INSERT INTO spans (trial_id, span_id, name, kind, start_ns, end_ns, status_code, attributes, raw)
       VALUES ($1, 'span-retried', 'chat fake/finance-emi', 3, 0, 1, 1, '{"evals.proxy.attempts": 2}', '{}')`,
      [bTrial.id],
    );
    // The first read is cached by the trials and their grading jobs, so the new span is not read yet.
    const before = (await compare(exp.id)).stats!;
    expect(before.verdict).toBe('better');
    // A regrade gives new grading jobs: the statistics are computed again, from the new outcomes.
    await request(env.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(202);
    expect((await compare(exp.id)).stats_note).toMatch(/^Grading is still running for 14 of 14 finished trials/);
    // This time every trial fails.
    await e.grade('g-re2', () => 'fail');
    const after = (await compare(exp.id)).stats!;
    // Every task now differs by exactly 0, so the task bootstrap has no spread to show; a zero-width
    // interval never reads as practically equivalent (D55), however many tasks tie.
    expect(after.diff).toEqual({ estimate: 0, low: 0, high: 0 });
    expect(after.verdict).toBe('no_detectable_difference');
    expect(after.verdict_text).toContain('Every task gave the same difference');
    const wall = after.costs.find((c) => c.metric === 'wall_s')!;
    // With one trial per task and arm, that task has no time left for B, so it leaves the time comparison.
    expect(wall).toMatchObject({ left_out_retried: { a: 0, b: 1 }, tasks: 6, trials: { a: 6, b: 6 } });
    expect(after.costs.find((c) => c.metric === 'cost_usd')!.trials).toEqual({ a: 7, b: 7 });
  });

  it('says why there are no statistics: grading still running, or a pilot of one config', async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: tasks().slice(0, 2), n: 1, futility: { enabled: false } });
    await run('w-wait', () => 'pass', false);
    expect(await compare(exp.id)).toMatchObject({ status: 'complete', stats: null, stats_note: 'Grading is still running for 4 of 4 finished trials; the verdict waits for every grade.' });
    await e.grade('g-wait');
    const graded = await compare(exp.id);
    // Two tasks: below the 6-task floor (D50), so no verdict but this one.
    expect(graded.stats).toMatchObject({ verdict: 'no_detectable_difference', diff: { estimate: 0 } });
    expect(graded.stats!.verdict_text).toContain('With fewer than 6 tasks no other verdict is possible');

    const pilot = await e.experiment({ config_hashes: [A], task_sha256s: tasks().slice(0, 1), n: 1, futility: { enabled: false } });
    await run('w-pilot', () => 'pass');
    expect(await compare(pilot.id)).toMatchObject({ status: 'complete', stats: null, stats_note: 'A pilot of one config has nothing to compare it with, so there is no verdict.' });
  });

  // ---- D44: A/A calibration ----

  it('refuses the same config twice unless the run is marked as a calibration, and a calibration of two configs', async () => {
    for (const p of ['/api/experiments', '/api/experiments/estimate']) {
      const plain = await request(env.http).post(p).send({ name: 'x', axis: 'none', config_hashes: [A, A], task_sha256s: tasks(), n: 1, budget_usd: 5 }).expect(400);
      expect(plain.body).toEqual({ error: 'invalid_experiment', message: 'config_hashes lists the same hash twice', fix: expect.stringContaining('mark the run as an A/A calibration') as string });
      const two = await request(env.http).post(p).send({ name: 'x', axis: 'none', config_hashes: [A, B], task_sha256s: tasks(), n: 1, budget_usd: 5, calibration: true }).expect(400);
      expect(two.body).toMatchObject({ error: 'invalid_calibration', message: 'an A/A calibration run puts the same config on both arms; these are two different configs' });
      const one = await request(env.http).post(p).send({ name: 'x', axis: 'none', config_hashes: [A], task_sha256s: tasks(), n: 1, budget_usd: 5, calibration: true }).expect(400);
      expect(one.body).toMatchObject({ error: 'invalid_calibration' });
      const notBool = await request(env.http).post(p).send({ name: 'x', axis: 'none', config_hashes: [A, A], task_sha256s: tasks(), n: 1, budget_usd: 5, calibration: 'yes' }).expect(400);
      expect(notBool.body).toMatchObject({ error: 'invalid_experiment', message: 'calibration must be true or false' });
    }
    // An estimate of a calibration run is of both arms.
    const est = (await request(env.http).post('/api/experiments/estimate').send({ config_hashes: [A, A], task_sha256s: tasks(), n: 2, calibration: true }).expect(200)).body as { trials: number };
    expect(est.trials).toBe(28);
    // It is a run of its own: it cannot reuse a parent's trials.
    const parent = await e.experiment({ config_hashes: [A, B], task_sha256s: tasks(), n: 1 }, { start: false });
    const reuse = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'x', axis: 'none', config_hashes: [A, A], task_sha256s: tasks(), n: 1, budget_usd: 5, calibration: true, parent_experiment_id: parent.id, reuse_baseline: true })
      .expect(400);
    expect(reuse.body).toMatchObject({ error: 'invalid_calibration' });
  });

  it('runs a calibration as two arms of one config, split by repeat, each pausable on its own', async () => {
    const exp = await e.experiment({ name: 'A/A calibration: arm A', axis: 'none', config_hashes: [A, A], task_sha256s: tasks(), n: 2, calibration: true, futility: { enabled: false } }, { start: false });
    expect(exp).toMatchObject({ calibration: true, config_hashes: [A, A] });
    expect(exp.arms.map((a) => [a.arm, a.config_hash, a.counts.queued])).toEqual([
      ['A', A, 14],
      ['B', A, 14],
    ]);
    const list = (await request(env.http).get('/api/experiments').expect(200)).body as ExperimentSummary[];
    expect(list.find((x) => x.id === exp.id)?.calibration).toBe(true);
    expect(list.find((x) => x.id !== exp.id)?.calibration).toBe(false);
    const rows = await trials(exp.id);
    expect(rows).toHaveLength(28);
    expect([...new Set(rows.map((t) => t.repeat_index))].sort()).toEqual([0, 1, 2, 3]);

    // Pausing arm B holds only its trials (repeats 2 and 3); arm A's are claimed.
    await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200);
    const paused = (await request(env.http).post(`/api/experiments/${exp.id}/arms/B/pause`).expect(200)).body as ExperimentDetail;
    expect(paused.arms.map((a) => a.status)).toEqual(['active', 'paused']);
    const repeats: number[] = [];
    await run('w-cal', ({ repeat }) => {
      repeats.push(repeat);
      return 'pass';
    });
    expect(repeats).toHaveLength(14);
    expect(repeats.every((r) => r < 2)).toBe(true);
    const mid = await e.detail(exp.id);
    expect(mid.arms.map((a) => [a.status, a.counts.done, a.counts.queued])).toEqual([
      ['complete', 14, 0],
      ['paused', 0, 14],
    ]);
    expect((await compare(exp.id)).status).toBe('incomplete');
    await request(env.http).post(`/api/experiments/${exp.id}/arms/B/resume`).expect(200);
    // Arm B passes on all but one task, so the run comes out as it should: no detectable difference.
    await run('w-cal', ({ task, repeat }) => (task === 'stat-1' && repeat === 2 ? 'fail' : 'pass'));
    const cmp = await compare(exp.id);
    expect(cmp.rows.filter((r) => r.task_id === 'stat-1').map((r) => [r.arm, r.config, r.passed, r.graded])).toEqual([
      ['A', A, 2, 2],
      ['B', A, 1, 2],
    ]);
    expect(cmp.stats).toMatchObject({ verdict: 'no_detectable_difference', aa: null, calibration: { as_expected: true } });
    expect(cmp.stats!.calibration!.text).toMatch(/^As it should, this A\/A run found no detectable difference/);
    expect((await e.detail(exp.id)).status).toBe('done');

    // An ordinary A/B of the same config shows that calibration's interval beside its own.
    const ab = await e.experiment({ config_hashes: [A, B], task_sha256s: tasks(), n: 1, futility: { enabled: false } });
    await run('w-ab2', ({ config }) => (config === B ? 'pass' : 'fail'));
    const abCmp = await compare(ab.id);
    expect(abCmp.stats!.aa).toEqual({
      experiment_id: exp.id,
      name: 'A/A calibration: arm A',
      config_hash: A,
      finished_at: expect.any(String) as string,
      diff: cmp.stats!.diff,
      verdict: 'no_detectable_difference',
    });
  });

  it('exports a calibration run with each trial in its arm', async () => {
    const exp = await e.experiment({ axis: 'none', config_hashes: [A, A], task_sha256s: tasks().slice(0, 1), n: 1, calibration: true, futility: { enabled: false } });
    await run('w-exp', () => 'pass');
    const csv = (await request(env.http).get(`/api/experiments/${exp.id}/export?format=csv`).expect(200)).text;
    const [head, ...lines] = csv.trim().split('\n');
    const arm = head.split(',').indexOf('arm');
    expect(lines.map((l) => l.split(',')[arm]).sort()).toEqual(['A', 'B']);
  });
});
