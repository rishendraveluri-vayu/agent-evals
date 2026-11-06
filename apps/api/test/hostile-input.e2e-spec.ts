import request from 'supertest';
import type { ClaimResponse } from '../src/contract';
import { type TestEnv, auth, bootEnv, catalogue, makeConfig, runnerReport } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/**
 * Hostile or broken input from a worker or a client (E7 to E10 of the 6 Nov review): the API
 * answers a clean 4xx or stores what it can, and never a 500. Fake models and the LiteLLM stub
 * only: nothing is spent.
 */
describeWithDb('hostile input from workers and clients (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let A: string;
  let e: ReturnType<typeof engine>;

  beforeAll(async () => {
    env = await bootEnv();
    cat = await catalogue(env.http);
    A = await makeConfig(env.http, cat, { name: 'hostile A', settings: { temperature: 0.2 } });
    e = engine(env);
  });

  afterAll(async () => {
    await env.close();
  });

  beforeEach(async () => {
    await e.quiesce();
  });

  const send = (c: ClaimResponse, worker: string, body: Record<string, unknown>) =>
    request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: worker, attempt: c.attempt, runner_report: runnerReport(c.trial_id, c.attempt, 'agent'), result: null, spans: [], files: [], ...body });

  const row = async (id: string) =>
    (
      await env.pool.query<{ status: string; end_state: string | null; result: Record<string, unknown> | null; problems: string[]; cost_usd: number | null; input_tokens: number | null; output_tokens: number | null; model_calls: number | null; wall_s: number | null }>(
        'SELECT status, end_state, result, problems, cost_usd, input_tokens, output_tokens, model_calls, wall_s FROM trials WHERE id = $1',
        [id],
      )
    ).rows[0];

  // ---- E7 ----

  it('stores a report with NUL characters (U+FFFD in their place, said in problems) instead of a 500 on every retry (E7)', async () => {
    await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 1 });
    const c = (await e.claim('w-nul'))!;
    const span = {
      traceId: '0'.repeat(32),
      spanId: 'a1a1a1a1a1a1a1a1',
      name: 'chat fake\u0000model',
      kind: 3,
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: [{ key: 'k\u0000', value: { stringValue: 'x\u0000y' } }],
    };
    const rr = { ...runnerReport(c.trial_id, c.attempt, 'agent'), end_state: 'answered\u0000' };
    const res = await send(c, 'w-nul', { runner_report: rr, result: { end_state: 'answered', final_answer: 'hello\u0000world' }, spans: [span] });
    expect(res.status).toBe(200);
    expect((res.body as { spans_stored: number }).spans_stored).toBe(1);
    const stored = await row(c.trial_id);
    expect(stored.status).toBe('done');
    expect(stored.end_state).toBe('answered\uFFFD');
    expect(stored.result).toMatchObject({ final_answer: 'hello\uFFFDworld' });
    expect(stored.problems).toContain('the report had 5 NUL characters, stored as U+FFFD (the database cannot hold NUL); the uploaded files keep them');
    const [s] = (await env.pool.query<{ name: string; attributes: Record<string, unknown> }>('SELECT name, attributes FROM spans WHERE trial_id = $1', [c.trial_id])).rows;
    expect(s).toEqual({ name: 'chat fake\uFFFDmodel', attributes: { 'k\uFFFD': 'x\uFFFDy' } });
  });

  // ---- E8 ----

  it('stores impossible worker numbers as unknown, clamps a count to the column, and never lets spend go negative (E8)', async () => {
    const exp = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 2 });
    const neg = (await e.claim('w-num-1'))!;
    const rr = runnerReport(neg.trial_id, neg.attempt, 'agent');
    rr.proxy_usage = { complete: true, model_calls: -1, input_tokens: -5, output_tokens: -7, cost_usd: -1000, last_status: '200' };
    rr.timing = { wall_s: -99 };
    expect((await send(neg, 'w-num-1', { runner_report: rr })).status).toBe(200);
    expect(await row(neg.trial_id)).toMatchObject({ status: 'done', cost_usd: null, input_tokens: null, output_tokens: null, model_calls: null, wall_s: null });
    expect((await row(neg.trial_id)).problems).toEqual(expect.arrayContaining(['proxy_usage.cost_usd -1000 is not a number of at least 0; stored as unknown']));

    const huge = (await e.claim('w-num-2'))!;
    const big = runnerReport(huge.trial_id, huge.attempt, 'agent');
    big.proxy_usage = { complete: true, model_calls: 1, input_tokens: 3_000_000_000, output_tokens: 1, cost_usd: 0.01, last_status: '200' };
    expect((await send(huge, 'w-num-2', { runner_report: big })).status).toBe(200);
    expect(await row(huge.trial_id)).toMatchObject({ status: 'done', input_tokens: 2_147_483_647, cost_usd: 0.01 });
    const d = await e.detail(exp.id);
    expect(d.status).toBe('done');
    expect(d.spend_usd).toBeCloseTo(0.01, 8);
  });

  // ---- E9 ----

  const plan = (over: Record<string, unknown> = {}) => ({
    name: 'bounds',
    axis: 'x',
    config_hashes: [A],
    task_sha256s: [cat.tasks['emi-basic']],
    n: 1,
    budget_usd: 1,
    ...over,
  });

  it('answers a clean 400, never a 500, for a NUL in a name, an unbounded budget and a repeated query parameter (E9)', async () => {
    const nul = await request(env.http).post('/api/experiments').send(plan({ name: 'a\u0000b' })).expect(400);
    expect(nul.body).toMatchObject({ error: 'invalid_experiment', message: 'name contains a NUL character (\\u0000), which cannot be stored' });
    await request(env.http).post('/api/experiments').send(plan({ axis: 'x\u0000' })).expect(400);
    for (const budget of [1e308, 1000.01]) {
      const res = await request(env.http).post('/api/experiments').send(plan({ budget_usd: budget })).expect(400);
      expect(res.body).toMatchObject({ error: 'invalid_experiment', message: 'budget_usd must be a number above 0 and at most 1000' });
    }
    const top = (await request(env.http).post('/api/experiments').send(plan({ budget_usd: 1000 })).expect(201)).body as { id: string; budget_usd: number };
    expect(top.budget_usd).toBe(1000);

    // Any route: a NUL the database cannot take is a 400 from the error filter, not a 500.
    const trial = await request(env.http).get('/api/trials/%00').expect(400);
    expect(trial.body).toMatchObject({ error: 'invalid_value' });

    await request(env.http).post(`/api/experiments/${top.id}/start`).expect(200);
    const both = await request(env.http).get(`/api/experiments/${top.id}/trials?status=queued&status=done`).expect(200);
    expect((both.body as unknown[]).length).toBe(1);
    expect((await request(env.http).get(`/api/experiments/${top.id}/trials?status=queued&status=bogus`).expect(400)).body).toMatchObject({ error: 'invalid_filter' });
    expect((await request(env.http).get(`/api/experiments/${top.id}/trials?config=${A}&config=${A}`).expect(400)).body).toMatchObject({ error: 'invalid_filter', message: 'give config once' });
    expect((await request(env.http).get('/api/labels/queue?set=tuning&items=t_a&items=t_b').expect(400)).body).toMatchObject({ error: 'invalid_query' });

    const c = (await e.claim('w-bounds'))!;
    for (const attempt of [1.5, 0, 1e20]) {
      const hb = await request(env.http).post(`/api/worker/trials/${c.trial_id}/heartbeat`).set(auth).send({ worker_id: 'w-bounds', attempt }).expect(400);
      expect(hb.body).toMatchObject({ error: 'invalid_heartbeat' });
    }
  });

  it('refuses a config name over 120 characters or with a NUL, and max_steps over 200 or timeout_s over 3600 (E9)', async () => {
    const base = { harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, settings: {} };
    const long = await request(env.http).post('/api/configs').send({ ...base, name: 'n'.repeat(121) }).expect(400);
    expect(long.body).toMatchObject({ error: 'invalid_config', message: 'name is 121 characters, longer than the 120 allowed' });
    await request(env.http).post('/api/configs').send({ ...base, name: 'n'.repeat(120) }).expect(201);
    expect((await request(env.http).post('/api/configs').send({ ...base, name: 'a\u0000' }).expect(400)).body).toMatchObject({ error: 'invalid_config' });
    const steps = await request(env.http).post('/api/configs').send({ ...base, name: 's', settings: { max_steps: 1_000_000 } }).expect(400);
    expect(steps.body).toMatchObject({ error: 'invalid_setting', message: 'max_steps must be an integer from 1 to 200' });
    const timeout = await request(env.http).post('/api/configs').send({ ...base, name: 't', settings: { timeout_s: 1e9 } }).expect(400);
    expect(timeout.body).toMatchObject({ error: 'invalid_setting', message: 'timeout_s must be a number of seconds above 0 and at most 3600' });
  });
});
