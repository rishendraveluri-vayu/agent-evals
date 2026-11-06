import request from 'supertest';
import type { ClaimResponse } from '../src/contract';
import { type TestEnv, auth, bootEnv, catalogue, makeConfig, runnerReport } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/**
 * E3, E4, E5 of the 6 Nov review: reports, the lease sweep and run controls on one experiment at
 * the same moment. Every such transaction locks the experiment row first (the lock order in
 * apps/api/src/experiments/run-state.ts). Fake models and the LiteLLM stub only: nothing is spent.
 * Each race runs several rounds, since one round may happen to serialise by itself.
 */
describeWithDb('races between reports, the sweep and run controls (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let A: string;
  let B: string;
  let e: ReturnType<typeof engine>;
  const ROUNDS = 8;

  beforeAll(async () => {
    env = await bootEnv();
    cat = await catalogue(env.http);
    A = await makeConfig(env.http, cat, { name: 'race A', settings: { temperature: 0.2 } });
    B = await makeConfig(env.http, cat, { name: 'race B', settings: { temperature: 0.7 } });
    e = engine(env);
  });

  afterAll(async () => {
    await env.close();
  });

  beforeEach(async () => {
    await e.quiesce();
  });

  /** A report as a worker sends it, answered with its status (never thrown). */
  const report = (c: ClaimResponse, worker: string, label = 'agent') =>
    request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: worker, attempt: c.attempt, runner_report: runnerReport(c.trial_id, c.attempt, label), result: null, spans: [], files: [] });

  const counts = async (id: string) =>
    (await env.pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM trials WHERE experiment_id = $1 GROUP BY status', [id])).rows.reduce<Record<string, number>>(
      (o, r) => ({ ...o, [r.status]: r.n }),
      {},
    );

  it('the last two trials reporting at once leave the run done, never stuck running (E3)', async () => {
    for (let r = 0; r < ROUNDS; r += 1) {
      const exp = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 2 });
      const c1 = (await e.claim(`w-fin-${r}-1`))!;
      const c2 = (await e.claim(`w-fin-${r}-2`))!;
      const answers = await Promise.all([report(c1, `w-fin-${r}-1`), report(c2, `w-fin-${r}-2`)]);
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      const d = await e.detail(exp.id);
      expect({ round: r, status: d.status, counts: await counts(exp.id) }).toEqual({ round: r, status: 'done', counts: { done: 2 } });
    }
  });

  it('a Stop racing an infra report never leaves a queued trial on a cancelled run (E4)', async () => {
    for (let r = 0; r < ROUNDS; r += 1) {
      const exp = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 2 });
      const c = (await e.claim(`w-stop-${r}`))!;
      const [rep, stop] = await Promise.all([report(c, `w-stop-${r}`, 'infra:provider_error'), request(env.http).post(`/api/experiments/${exp.id}/stop`)]);
      expect([rep.status, stop.status]).toEqual([200, 200]);
      const d = await e.detail(exp.id);
      expect(d.status).toBe('cancelled');
      // Either the report re-queued attempt 2 first and Stop cancelled it, or it saw the stop.
      expect({ round: r, queued: (await counts(exp.id)).queued ?? 0 }).toEqual({ round: r, queued: 0 });
    }
  });

  it('claims racing a Stop never deadlock or answer 500 (re-check of E5)', async () => {
    // As the re-verification found it: two workers claiming while Stop is pressed. The claim's
    // second write to its trial takes KEY SHARE on the experiment; it used to do so while holding
    // the trial, against Stop holding the experiment and waiting for that trial.
    for (let r = 0; r < 12; r += 1) {
      const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 2 });
      const claimOf = (w: string) => request(env.http).post('/api/worker/claim').set(auth).send({ worker_id: w, harness: 'ownloop' });
      const [c1, c2, stop] = await Promise.all([claimOf(`w-cs-${r}-1`), claimOf(`w-cs-${r}-2`), request(env.http).post(`/api/experiments/${exp.id}/stop`)]);
      expect({ round: r, codes: [c1.status, c2.status, stop.status].map((c) => (c === 204 ? 200 : c)) }).toEqual({ round: r, codes: [200, 200, 200] });
      const n = await counts(exp.id);
      // Whatever got claimed before the stop is kept (it runs and reports); nothing is left queued.
      expect({ round: r, queued: n.queued ?? 0 }).toEqual({ round: r, queued: 0 });
      for (const [res, w] of [[c1, `w-cs-${r}-1`], [c2, `w-cs-${r}-2`]] as const) {
        if (res.status === 200) await report(res.body as ClaimResponse, w, 'agent');
      }
      await e.quiesce();
    }
  }, 60_000);

  it('reports, the lease sweep and run controls at once never deadlock or answer 500, and end consistent (E5)', async () => {
    const codes: number[] = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['emi-basic']], n: 4 });
      const claims: [ClaimResponse, string][] = [];
      for (let i = 0; i < 4; i += 1) claims.push([(await e.claim(`w-mix-${r}-${i}`))!, `w-mix-${r}-${i}`]);
      // One claim lapses, so the sweep has work in the same moment.
      await env.pool.query(`UPDATE trials SET heartbeat_at = now() - interval '61 seconds' WHERE id = $1`, [claims[3][0].trial_id]);
      const labels = ['agent', 'infra:provider_error', 'infra:adapter_crash'];
      const controls = ['pause', 'resume', 'arms/A/pause', 'arms/A/resume', 'start', 'resume', 'arms/B/pause', 'arms/B/resume'];
      const ops: Promise<number>[] = [
        ...claims.slice(0, 3).map(([c, w], i) => report(c, w, labels[i]).then((res) => res.status)),
        ...controls.map((op) =>
          request(env.http)
            .post(`/api/experiments/${exp.id}/${op}`)
            .then((res) => res.status),
        ),
        env.worker.sweep().then(
          () => 200,
          () => 500,
        ),
      ];
      codes.push(...(await Promise.all(ops)));
      const d = await e.detail(exp.id);
      const c = await counts(exp.id);
      const held = (c.queued ?? 0) + (c.claimed ?? 0) + (c.running ?? 0);
      // Done with nothing left, never running with nothing left (a paused run waits for a resume).
      if (d.status === 'done') expect(held).toBe(0);
      if (d.status === 'running') expect(held).toBeGreaterThan(0);
      await request(env.http).post(`/api/experiments/${exp.id}/stop`);
    }
    expect(codes.filter((s) => s >= 500)).toEqual([]);
  }, 60_000);

  it('two sweeps and a report on one lapsed experiment abandon each lease once and re-queue it once', async () => {
    const exp = await e.experiment({ config_hashes: [A], task_sha256s: [cat.tasks['emi-basic']], n: 3 });
    const held: [ClaimResponse, string][] = [];
    for (let i = 0; i < 3; i += 1) held.push([(await e.claim(`w-lapse-${i}`))!, `w-lapse-${i}`]);
    await env.pool.query(`UPDATE trials SET heartbeat_at = now() - interval '61 seconds' WHERE id = ANY($1)`, [held.slice(0, 2).map(([c]) => c.trial_id)]);
    const [, , rep] = await Promise.all([env.worker.sweep(), env.worker.sweep(), report(held[2][0], held[2][1])]);
    expect(rep.status).toBe(200);
    // Read from the rows: the API's own timer may sweep in the same moment.
    expect(await counts(exp.id)).toEqual({ abandoned: 2, done: 1, queued: 2 });
    const { rows } = await env.pool.query<{ repeat_index: number; attempts: number[] }>(
      'SELECT repeat_index, array_agg(attempt ORDER BY attempt) AS attempts FROM trials WHERE experiment_id = $1 GROUP BY repeat_index ORDER BY repeat_index',
      [exp.id],
    );
    expect(rows.map((x) => x.attempts.length).sort()).toEqual([1, 2, 2]);
  });
});
