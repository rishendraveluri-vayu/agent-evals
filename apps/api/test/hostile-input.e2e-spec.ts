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
});
