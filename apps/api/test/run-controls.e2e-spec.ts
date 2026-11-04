import request from 'supertest';
import type { ExperimentDetail, TrialRowSummary } from '../src/contract';
import { type TestEnv, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/** D32, D34, D35 and D37 on the real API and Postgres, with LiteLLM stubbed: no model is called. */
describeWithDb('run controls (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let A: string;
  let B: string;
  let e: ReturnType<typeof engine>;

  beforeAll(async () => {
    env = await bootEnv();
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

  const trials = async (id: string): Promise<TrialRowSummary[]> =>
    ((await request(env.http).get(`/api/experiments/${id}/trials`).expect(200)).body as TrialRowSummary[]).sort((x, y) => x.order_index - y.order_index || x.attempt - y.attempt);

  const both = (): string[] => [cat.tasks['emi-basic'], cat.tasks['widow-loan']];

  // ---- D35 ----

  it('refuses a 3-config experiment with a fix: several A/B experiments against one parent (D35)', async () => {
    const C = await makeConfig(env.http, cat, { name: 'arm C', settings: { temperature: 1.1 } });
    for (const path of ['/api/experiments', '/api/experiments/estimate']) {
      const res = await request(env.http)
        .post(path)
        .send({ name: 'x', axis: 'temperature', config_hashes: [A, B, C], task_sha256s: [cat.tasks['emi-basic']], n: 1, budget_usd: 5 })
        .expect(400);
      expect(res.body).toEqual({
        error: 'too_many_arms',
        message: 'an experiment has one config (a pilot) or two (arm A and arm B); this one has 3',
        fix: expect.stringContaining('Run several A/B experiments against the same parent') as string,
      });
    }
    // A pilot (one config) and an A/B (two) are both fine.
    await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']] }, { start: false });
    await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']] }, { start: false });
  });

  // ---- D32: order ----

  it('shuffles the claim order from a recorded seed, the same seed giving the same order, with the arms interleaved (D32)', async () => {
    const body = { config_hashes: [A, B], task_sha256s: both(), n: 3, sim_model: 'claude-haiku-5-5', order_seed: 4242 };
    const first = await e.experiment(body, { start: false });
    const second = await e.experiment(body, { start: false });
    expect(first.order_seed).toBe(4242);
    const slots = async (id: string) => (await trials(id)).map((t) => `${t.task_id}/${t.config_name}/${t.repeat_index}`);
    const order = await slots(first.id);
    expect(order).toHaveLength(12);
    expect(await slots(second.id)).toEqual(order);
    // Not the plan order (repeat, task, config), and every pair holds one trial of each arm.
    const plan = (await trials(first.id)).sort((x, y) => x.repeat_index - y.repeat_index || x.task_id.localeCompare(y.task_id) || x.config_name.localeCompare(y.config_name));
    expect(order).not.toEqual(plan.map((t) => `${t.task_id}/${t.config_name}/${t.repeat_index}`));
    const arms = (await trials(first.id)).map((t) => t.config_name);
    for (let i = 0; i < arms.length; i += 2) expect([arms[i], arms[i + 1]].sort()).toEqual(['arm A', 'arm B']);

    // Workers claim in that order.
    await request(env.http).post(`/api/experiments/${second.id}/cancel`).expect(200);
    await request(env.http).post(`/api/experiments/${first.id}/start`).expect(200);
    const claimed: string[] = [];
    for (let c = await e.claim('w-order'); c; c = await e.claim('w-order')) claimed.push(c.trial_id);
    expect(claimed).toEqual((await trials(first.id)).map((t) => t.id));

    // Without a seed, one is drawn and recorded; another seed gives another order.
    const random = await e.experiment({ ...body, order_seed: undefined }, { start: false });
    expect(Number.isInteger(random.order_seed)).toBe(true);
    const other = await e.experiment({ ...body, order_seed: 4243 }, { start: false });
    expect(await slots(other.id)).not.toEqual(order);
    const bad = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'x', axis: 'x', ...body, order_seed: -1, budget_usd: 50 })
      .expect(400);
    expect((bad.body as { fix?: string }).fix).toEqual(expect.any(String));
  });

  // ---- D32, D37: run controls ----

  it('pauses and resumes by hand: nothing is claimed while paused, a running trial finishes', async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 2 });
    const running = (await e.claim('w-p'))!;
    const paused = (await request(env.http).post(`/api/experiments/${exp.id}/pause`).expect(200)).body as ExperimentDetail;
    expect(paused).toMatchObject({ status: 'paused', paused_reason: expect.stringContaining('paused by hand') as string });
    expect(paused.events.find((x) => x.kind === 'paused')?.detail).toBe(paused.paused_reason);
    await request(env.http).post(`/api/experiments/${exp.id}/pause`).expect(200); // already paused: no-op
    expect(await e.claim('w-p')).toBeNull();
    expect((await e.report(running, 'w-p')).status).toBe('done');
    const compare = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as { status: string; reason: string };
    expect(compare).toMatchObject({ status: 'incomplete', reason: expect.stringContaining('the experiment is paused: paused by hand') as string });

    const resumed = (await request(env.http).post(`/api/experiments/${exp.id}/resume`).expect(200)).body as ExperimentDetail;
    expect(resumed.status).toBe('running');
    expect(resumed.events.filter((x) => x.kind === 'resumed')).toHaveLength(1);
    expect(await e.claim('w-p')).not.toBeNull();

    const created = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']] }, { start: false });
    expect((await request(env.http).post(`/api/experiments/${created.id}/pause`).expect(409)).body).toMatchObject({ error: 'experiment_not_started', fix: expect.any(String) as string });
    expect((await request(env.http).post(`/api/experiments/${created.id}/resume`).expect(409)).body).toMatchObject({ error: 'experiment_not_started' });
  });

  it('stops: queued trials are cancelled, a running one finishes and is kept, and compare says why there is no verdict', async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 3 });
    const running = (await e.claim('w-stop'))!;
    const stopped = (await request(env.http).post(`/api/experiments/${exp.id}/stop`).expect(200)).body as ExperimentDetail;
    expect(stopped).toMatchObject({ status: 'cancelled', counts: { cancelled: 5, running: 1 } });
    expect(stopped.events.find((x) => x.kind === 'cancelled')?.detail).toContain('stopped');
    expect(await e.claim('w-stop')).toBeNull();
    expect(await e.report(running, 'w-stop')).toMatchObject({ status: 'done' });
    const compare = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as { status: string; reason: string; rows: unknown[]; arms: { status: string }[] };
    expect(compare.status).toBe('incomplete');
    expect(compare.reason).toMatch(/^the experiment was stopped before every trial ran \([23] of arm A's trials cancelled, [23] of arm B's trials cancelled\); a verdict needs the full planned N/);
    expect(compare.rows).toEqual([]);
    expect(compare.arms.map((a) => a.status)).toEqual(['stopped', 'stopped']);
    await request(env.http).post(`/api/experiments/${exp.id}/resume`).expect(409);
  });

  it('a config error pauses only its arm; the other keeps claiming; compare waits for both arms (D37)', async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 3, order_seed: 11 });
    const first = (await e.claim('w-ce'))!;
    const bad = e.configOf(first);
    const good = bad === A ? B : A;
    await e.report(first, 'w-ce', 'infra:config_error', { last_status: '401' });
    const d = await e.detail(exp.id);
    expect(d.status).toBe('running');
    expect(d.arms.find((a) => a.config_hash === bad)).toMatchObject({ status: 'paused', fix: expect.stringContaining('fix the provider key') as string });

    const claimed: string[] = [];
    for (let c = await e.claim('w-ce'); c; c = await e.claim('w-ce')) {
      claimed.push(e.configOf(c));
      await e.report(c, 'w-ce');
    }
    expect(claimed).toEqual([good, good, good]); // every good-arm trial ran; none of the paused arm's
    const compare = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as { status: string; reason: string; arms: { config_hash: string; status: string }[] };
    expect(compare.status).toBe('incomplete');
    expect(compare.reason).toMatch(/^arm [AB] is paused: emi-basic on arm [AB], attempt 1: infra:config_error \(LiteLLM status 401\)/);
    expect(compare.arms.find((a) => a.config_hash === good)?.status).toBe('complete');

    await request(env.http).post(`/api/experiments/${exp.id}/arms/${bad}/resume`).expect(200);
    for (let c = await e.claim('w-ce'); c; c = await e.claim('w-ce')) await e.report(c, 'w-ce');
    const done = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as { status: string; rows: { arm: string; trials: number; infra_failed: number }[] };
    expect(done.status).toBe('complete');
    // The config error is kept and shown, never dropped (CLAUDE.md).
    expect(done.rows.map((r) => [r.arm, r.trials, r.infra_failed]).sort()).toEqual([
      ['A', bad === A ? 2 : 3, bad === A ? 1 : 0],
      ['B', bad === B ? 2 : 3, bad === B ? 1 : 0],
    ]);
  });

  it('pauses and resumes one arm by hand, by its hash or its letter', async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 2 });
    const d = (await request(env.http).post(`/api/experiments/${exp.id}/arms/${B}/pause`).expect(200)).body as ExperimentDetail;
    expect(d.arms.map((a) => [a.arm, a.status])).toEqual([
      ['A', 'active'],
      ['B', 'paused'],
    ]);
    expect(d.arms[1].fix).toContain(`/arms/${B}/resume`);
    const got = [];
    for (let c = await e.claim('w-arm'); c; c = await e.claim('w-arm')) got.push(e.configOf(c));
    expect(got).toEqual([A, A]);
    await request(env.http).post(`/api/experiments/${exp.id}/arms/b/resume`).expect(200);
    expect(e.configOf((await e.claim('w-arm'))!)).toBe(B);
    expect((await request(env.http).post(`/api/experiments/${exp.id}/arms/C/pause`).expect(404)).body).toMatchObject({ error: 'unknown_arm', fix: expect.any(String) as string });
  });

  // ---- D32: futility and guards ----

  /** Claims and reports until nothing is claimable; `outcome` picks each report's label and end state. */
  async function drain(worker: string, outcome: (config: string, i: number) => { label?: string; end_state?: string; cost_usd?: number }): Promise<number> {
    let i = 0;
    for (let c = await e.claim(worker); c; c = await e.claim(worker)) {
      const o = outcome(e.configOf(c), i++);
      await e.report(c, worker, o.label ?? 'agent', { end_state: o.end_state, cost_usd: o.cost_usd });
    }
    return i;
  }

  it('pauses after 3 finished trials per arm when an arm passed none, once per arm, never on the A/B difference (D32)', async () => {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 4, order_seed: 3 });
    expect(exp.futility).toEqual({ enabled: true, after: 3, min_passed: 1 });
    // Arm A answers every time; arm B always hits the step limit, so it passes nothing.
    const ran = await drain('w-fut', (config) => (config === B ? { end_state: 'step_limit' } : {}));
    let d = await e.detail(exp.id);
    expect(d.status).toBe('paused');
    expect(ran).toBeLessThan(8);
    expect(d.arms.find((a) => a.config_hash === B)!.counts.done).toBe(3);
    const pause = d.events.find((x) => x.kind === 'futility_pause')!;
    expect(pause.detail).toBe(d.paused_reason);
    expect(pause.detail).toContain('futility check (D32): arm B passed 0 of its first 3 finished trials');
    expect(pause.detail).toContain('passed means label agent and end state answered until graders exist (SP4)');
    expect(pause.detail).not.toContain('arm A');

    // After review, resuming runs the rest; the check does not fire again for arm B.
    await request(env.http).post(`/api/experiments/${exp.id}/resume`).expect(200);
    await drain('w-fut', (config) => (config === B ? { end_state: 'step_limit' } : {}));
    d = await e.detail(exp.id);
    expect(d.status).toBe('done');
    expect(d.events.filter((x) => x.kind === 'futility_pause')).toHaveLength(1);
  });

  it('takes a stricter futility rule, or none', async () => {
    const off = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 3, futility: { enabled: false } });
    await drain('w-fut-off', () => ({ end_state: 'step_limit' }));
    expect((await e.detail(off.id)).status).toBe('done');

    const strict = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 4, futility: { after: 2, min_passed: 2 } });
    await drain('w-fut-strict', (_c, i) => (i === 0 ? {} : { end_state: 'timeout' }));
    const d = await e.detail(strict.id);
    expect(d.status).toBe('paused');
    expect(d.paused_reason).toContain('arm A passed 1 of its first 2 finished trials, fewer than the 2 the rule asks for');

    const bad = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'x', axis: 'x', config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 1, budget_usd: 5, futility: { after: 0 } })
      .expect(400);
    expect(bad.body).toMatchObject({ error: 'invalid_experiment', fix: expect.stringContaining('"after"') as string });
  });

  it('pauses when infra failures pass 30% after at least 5 finished trials, and counts again from the resume (D32)', async () => {
    const exp = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 8, futility: { enabled: false } });
    // budget_net is never re-queued, so each failure is one finished slot.
    const plan = ['agent', 'agent', 'infra:budget_net', 'infra:budget_net', 'agent', 'agent', 'agent', 'agent'];
    for (let i = 0; i < 4; i += 1) await e.report((await e.claim('w-infra'))!, 'w-infra', plan[i]);
    expect((await e.detail(exp.id)).status).toBe('running'); // 2 of 4: too few finished to judge
    await e.report((await e.claim('w-infra'))!, 'w-infra', plan[4]);
    const d = await e.detail(exp.id);
    expect(d.status).toBe('paused');
    expect(d.events.find((x) => x.kind === 'infra_guard_pause')?.detail).toBe(
      'infra guard (D32): 2 of the 5 trials finished since the run started or last resumed were infra failures (40%, above 30%: infra:budget_net x2). ' +
        'Fix the cause, then resume (the count starts again), or stop',
    );
    expect(await e.claim('w-infra')).toBeNull();
    await request(env.http).post(`/api/experiments/${exp.id}/resume`).expect(200);
    await drain('w-infra', () => ({}));
    expect((await e.detail(exp.id)).status).toBe('done');
  });

  it('counts an abandoned lease toward the infra guard', async () => {
    const exp = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 8, futility: { enabled: false } });
    for (let i = 0; i < 3; i += 1) await e.report((await e.claim('w-ab'))!, 'w-ab', 'agent');
    const lost = [(await e.claim('w-ab'))!, (await e.claim('w-ab2'))!];
    await env.pool.query(`UPDATE trials SET heartbeat_at = now() - interval '61 seconds' WHERE id = ANY($1)`, [lost.map((c) => c.trial_id)]);
    await env.worker.sweep();
    const d = await e.detail(exp.id);
    expect(d.status).toBe('paused');
    expect(d.paused_reason).toContain('2 of the 5 trials finished');
    expect(d.paused_reason).toContain('abandoned x2');
  });

  it('pauses once when the projected spend passes the budget (D32)', async () => {
    // The estimate for 4 trials is well under $0.60; the first trial costs $0.30, projecting $1.20.
    const exp = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 4, budget_usd: 0.6 });
    await e.report((await e.claim('w-spend'))!, 'w-spend', 'agent', { cost_usd: 0.3 });
    const d = await e.detail(exp.id);
    expect(d.status).toBe('paused');
    const pause = d.events.find((x) => x.kind === 'spend_guard_pause')!;
    expect(pause.detail).toMatch(/^spend guard \(D32\): \$0\.3000 spent; the 3 trials left, at the cost of the trials finished so far, project \$1\.2000, above the experiment budget of \$0\.6000/);
    await request(env.http).post(`/api/experiments/${exp.id}/resume`).expect(200);
    await e.report((await e.claim('w-spend'))!, 'w-spend', 'agent', { cost_usd: 0.3 });
    expect((await e.detail(exp.id)).status).toBe('running'); // acknowledged: it does not fire again
  });

  // ---- D34: lineage and baseline reuse ----

  it("reuses the parent's arm-A trials when everything matches, and runs only arm B (D34)", async () => {
    const task = [cat.tasks['emi-basic']];
    const parent = await e.experiment({ config_hashes: [A], task_sha256s: task, n: 2 });
    await drain('w-base', () => ({}));
    expect((await e.detail(parent.id)).status).toBe('done');
    const parentTrials = (await trials(parent.id)).map((t) => t.id).sort();

    const body = { config_hashes: [A, B], task_sha256s: task, n: 2, parent_experiment_id: parent.id, reuse_baseline: true };
    const est = (await request(env.http).post('/api/experiments/estimate').send(body).expect(200)).body as { trials: number; baseline: { applied: boolean } };
    expect(est).toMatchObject({ trials: 2, baseline: { applied: true, reused_trials: 2 } });

    const child = await e.experiment(body);
    expect(child).toMatchObject({ parent_experiment_id: parent.id, baseline: { applied: true, reused_trials: 2 }, estimate: { trials: 2 } });
    expect(child.baseline!.reason).toBe(`arm A reuses 2 finished trials of ${parent.id} (N=2 for each of 1 tasks): same config, tasks, platform commit abc1234 and simulator`);
    expect(child.arms[0]).toMatchObject({ arm: 'A', status: 'complete', reused_from: parent.id, reused_trials: 2, counts: { done: 2, queued: 0 } });
    expect(child.arms[1]).toMatchObject({ arm: 'B', status: 'not_started', reused_from: null, counts: { queued: 2 } }); // the POST response, before the start
    expect(child.events.find((x) => x.kind === 'baseline')).toMatchObject({ arm: 'A', config_hash: A, detail: child.baseline!.reason });
    expect((await trials(child.id)).map((t) => t.config_hash)).toEqual([B, B]); // arm A is not queued again

    await drain('w-base', () => ({}));
    const cmp = (await request(env.http).get(`/api/experiments/${child.id}/compare`).expect(200)).body as { status: string; rows: { arm: string; trials: number }[] };
    expect(cmp.status).toBe('complete');
    expect(cmp.rows.map((r) => [r.arm, r.trials])).toEqual([
      ['A', 2],
      ['B', 2],
    ]);
    // The reused trials stay the parent's: nothing is copied or changed.
    expect((await env.pool.query('SELECT reused_trial_ids FROM experiment_arms WHERE experiment_id = $1 AND arm = $2', [child.id, 'A'])).rows[0]).toEqual({
      reused_trial_ids: expect.arrayContaining(parentTrials) as string[],
    });
    expect((await env.pool.query('SELECT count(*)::int AS n FROM trials WHERE experiment_id = $1', [parent.id])).rows[0]).toEqual({ n: 2 });
  });

  it('refuses the reuse and queues arm A again when the platform commit differs, saying why (D34)', async () => {
    const task = [cat.tasks['emi-basic']];
    const parent = await e.experiment({ config_hashes: [A], task_sha256s: task, n: 2 });
    await drain('w-base2', () => ({}));
    // The parent as if it had run under an older build of the platform.
    await env.pool.query("UPDATE experiments SET platform_commit = 'old0000' WHERE id = $1", [parent.id]);
    const child = await e.experiment({ config_hashes: [A, B], task_sha256s: task, n: 2, parent_experiment_id: parent.id, reuse_baseline: true });
    expect(child.baseline).toEqual({ applied: false, reused_trials: 0, reason: 'arm A runs again: the platform commit differs (parent old0000, now abc1234)' });
    expect(child.events.find((x) => x.kind === 'baseline')?.detail).toBe(child.baseline!.reason);
    expect(child.arms.map((a) => [a.arm, a.status, a.reused_from])).toEqual([
      ['A', 'not_started', null],
      ['B', 'not_started', null],
    ]);
    expect((await trials(child.id)).map((t) => t.config_hash).sort()).toEqual([A, A, B, B].sort());

    // More trials than the parent has finished: also run again.
    await env.pool.query("UPDATE experiments SET platform_commit = 'abc1234' WHERE id = $1", [parent.id]);
    const more = await e.experiment({ config_hashes: [A, B], task_sha256s: task, n: 3, parent_experiment_id: parent.id, reuse_baseline: true }, { start: false });
    expect(more.baseline?.reason).toContain('the parent has fewer than N=3 finished arm-A trials for 1 of 1 tasks (as few as 2)');
  });

  it('records a parent without reuse, and refuses reuse it cannot do', async () => {
    const task = [cat.tasks['emi-basic']];
    const parent = await e.experiment({ config_hashes: [A], task_sha256s: task }, { start: false });
    const child = await e.experiment({ config_hashes: [A, B], task_sha256s: task, parent_experiment_id: parent.id }, { start: false });
    expect(child).toMatchObject({ parent_experiment_id: parent.id, baseline: null });
    const post = (b: Record<string, unknown>) => request(env.http).post('/api/experiments').send({ name: 'x', axis: 'x', task_sha256s: task, n: 1, budget_usd: 5, ...b }).expect(400);
    expect((await post({ config_hashes: [A, B], reuse_baseline: true })).body).toMatchObject({ error: 'invalid_experiment', fix: expect.any(String) as string });
    expect((await post({ config_hashes: [A], reuse_baseline: true, parent_experiment_id: parent.id })).body).toMatchObject({ message: expect.stringContaining('two arms') as string });
    expect((await post({ config_hashes: [A, B], parent_experiment_id: 'e_nope' })).body).toMatchObject({ error: 'unknown_parent_experiment' });
  });

  it('keeps a re-queued attempt in its slot’s place, so it is claimed next', async () => {
    const exp: ExperimentDetail = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 3, order_seed: 7 });
    const first = (await e.claim('w-rq'))!;
    const r = await e.report(first, 'w-rq', 'infra:provider_error');
    const next = (await e.claim('w-rq'))!;
    expect(next.trial_id).toBe(r.requeued_trial_id);
    const rows = await trials(exp.id);
    expect(rows.filter((t) => t.order_index === rows.find((x) => x.id === first.trial_id)!.order_index).map((t) => t.attempt)).toEqual([1, 2]);
  });
});
