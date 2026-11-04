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
