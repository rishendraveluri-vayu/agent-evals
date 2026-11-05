import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import type { ClaimResponse, SpendView } from '../src/contract';
import { MIGRATIONS_DIR } from '../src/database/migrate';
import { type TestEnv, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/**
 * G3: an abandoned attempt never reports, so before this fix its spend never reached GET /spend,
 * an experiment's spend, the spend guard or the export. The lease sweep now reads its keys' spend
 * from LiteLLM (the test double here, never a real proxy) before revoking them. The spend-log rows
 * below are synthetic.
 */

jest.setTimeout(60_000);

type TrialSpend = {
  status: string;
  cost_usd: number | null;
  sim_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_calls: number | null;
  spend_unknown: boolean;
  keys_revoked_at: Date | null;
};

describeWithDb('spend of an abandoned attempt (G3, e2e, real Postgres)', () => {
  let env: TestEnv;
  let e: ReturnType<typeof engine>;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let haiku: string;

  beforeAll(async () => {
    env = await bootEnv();
    e = engine(env);
    cat = await catalogue(env.http);
    haiku = await makeConfig(env.http, cat, { name: 'haiku arm', model: 'claude-haiku-5-5' });
  });

  afterAll(async () => {
    await env.close();
  });

  beforeEach(async () => {
    env.stub.failSpendLogs = null;
    env.stub.failKeyDelete = null;
    await e.quiesce();
  });

  const tokenOf = (key: string | null): string => env.stub.liveKeys().find((k) => k.key === key)!.token;
  const lapse = (trialId: string) => env.pool.query(`UPDATE trials SET heartbeat_at = now() - interval '61 seconds' WHERE id = $1`, [trialId]);
  const row = async (id: string): Promise<TrialSpend> =>
    (
      await env.pool.query<TrialSpend>(
        'SELECT status, cost_usd, sim_cost_usd, input_tokens, output_tokens, model_calls, spend_unknown, keys_revoked_at FROM trials WHERE id = $1',
        [id],
      )
    ).rows[0];
  const spend = async (): Promise<SpendView> => (await request(env.http).get('/api/spend').expect(200)).body as SpendView;
  /** RFC 4180: quoted cells may hold commas, quotes ("") and newlines. */
  const parseCsv = (text: string): string[][] => {
    const out: string[][] = [];
    let rowCells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted && ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (!quoted && ch === ',') {
        rowCells.push(cell);
        cell = '';
      } else if (!quoted && ch === '\n') {
        rowCells.push(cell);
        out.push(rowCells);
        rowCells = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
    if (cell || rowCells.length) out.push([...rowCells, cell]);
    return out;
  };
  const csvRow = async (experimentId: string, trialId: string): Promise<Record<string, string>> => {
    const [header, ...lines] = parseCsv((await request(env.http).get(`/api/experiments/${experimentId}/export?format=csv`).expect(200)).text);
    const line = lines.find((l) => l[header.indexOf('trial_id')] === trialId)!;
    return Object.fromEntries(header.map((col, i) => [col, line[i]]));
  };

  async function claimOn(task: string, sim: string | null): Promise<{ expId: string; c: ClaimResponse }> {
    const exp = await e.experiment({ config_hashes: [haiku], task_sha256s: [cat.tasks[task]], sim_model: sim });
    const c = (await e.claim('w-crash'))!;
    expect(c.experiment_id).toBe(exp.id);
    return { expId: exp.id, c };
  }

  it("reads the attempt's spend from LiteLLM before revoking its keys, and every total counts it", async () => {
    const before = await spend();
    const { expId, c } = await claimOn('widow-loan', 'claude-haiku-5-5');
    const agent = tokenOf(c.keys.model);
    const sim = tokenOf(c.keys.sim);
    // What LiteLLM logged before the worker died: one call that succeeded, one that failed, and a simulator reply.
    env.stub.spendLogs.set(agent, [
      { request_id: 'r1', status: 'success', spend: 0.012, prompt_tokens: 1000, completion_tokens: 100 },
      { request_id: 'r2', status: 'failure', spend: 0, prompt_tokens: 0, completion_tokens: 0 },
    ]);
    env.stub.spendLogs.set(sim, [{ request_id: 's1', status: 'success', spend: 0.003, prompt_tokens: 200, completion_tokens: 30 }]);

    await lapse(c.trial_id);
    expect((await env.worker.sweep()).abandoned).toEqual([c.trial_id]);

    expect(await row(c.trial_id)).toMatchObject({
      status: 'abandoned',
      cost_usd: 0.012,
      sim_cost_usd: 0.003,
      input_tokens: 1000,
      output_tokens: 100,
      model_calls: 2,
      spend_unknown: false,
      keys_revoked_at: expect.any(Date) as Date,
    });
    // Read first, then revoked: a deleted key's log is never relied on (A19).
    const paths = env.stub.calls.map((x) => x.path);
    const lastRead = Math.max(paths.lastIndexOf(`/spend/logs?api_key=${agent}`), paths.lastIndexOf(`/spend/logs?api_key=${sim}`));
    expect(lastRead).toBeGreaterThan(-1);
    expect(paths.indexOf('/key/delete', lastRead)).toBeGreaterThan(lastRead);
    expect(env.stub.deleted).toEqual(expect.arrayContaining([agent, sim]));

    const after = await spend();
    expect(after.trials_usd).toBeCloseTo(before.trials_usd + 0.015, 8);
    expect(after.trials_spend_unknown).toBe(0);
    const detail = await e.detail(expId);
    expect(detail.spend_usd).toBeCloseTo(0.015, 8);
    // Spent, but not a reported trial: no cost per trial until one reports.
    expect(detail.actual).toMatchObject({ spend_usd: 0.015, cost_per_trial_usd: null });
    expect(await csvRow(expId, c.trial_id)).toMatchObject({ status: 'abandoned', cost_usd: '0.012', sim_cost_usd: '0.003', spend_unknown: 'false' });
    const json = JSON.parse((await request(env.http).get(`/api/experiments/${expId}/export?format=json`).expect(200)).text) as { trials: { id: string; spend: Record<string, unknown> }[] };
    expect(json.trials.find((t) => t.id === c.trial_id)?.spend).toMatchObject({ cost_usd: 0.012, sim_cost_usd: 0.003, spend_unknown: false });

    // The re-queued attempt reports; the arm's spend over its one reported trial includes the crash.
    const second = (await e.claim('w-2'))!;
    expect(second.attempt).toBe(2);
    await e.report(second, 'w-2', 'agent', { cost_usd: 0.001 });
    const done = await e.detail(expId);
    expect(done.actual?.spend_usd).toBeCloseTo(0.016, 8);
    expect(done.actual?.cost_per_trial_usd).toBeCloseTo(0.016, 8);
  });

  it('records the spend as unknown, not zero, while LiteLLM is down, and reads it once LiteLLM is back', async () => {
    const before = await spend();
    const { expId, c } = await claimOn('emi-basic', null);
    const agent = tokenOf(c.keys.model);
    env.stub.spendLogs.set(agent, [{ request_id: 'r1', status: 'success', spend: 0.02, prompt_tokens: 900, completion_tokens: 80 }]);
    env.stub.failSpendLogs = 503;
    env.stub.failKeyDelete = 503;

    await lapse(c.trial_id);
    await env.worker.sweep();
    expect(await row(c.trial_id)).toMatchObject({ status: 'abandoned', cost_usd: null, sim_cost_usd: null, spend_unknown: true, keys_revoked_at: null });
    expect(env.stub.deleted).not.toContain(agent);
    const down = await spend();
    expect(down.trials_spend_unknown).toBe(before.trials_spend_unknown + 1);
    expect(down.trials_usd).toBeCloseTo(before.trials_usd, 8);
    expect(await csvRow(expId, c.trial_id)).toMatchObject({ cost_usd: '', spend_unknown: 'true' });

    // LiteLLM is back: the keys are still live, so the next sweep reads the spend, then revokes them.
    env.stub.failSpendLogs = null;
    env.stub.failKeyDelete = null;
    await env.worker.sweep();
    expect(await row(c.trial_id)).toMatchObject({ cost_usd: 0.02, spend_unknown: false, keys_revoked_at: expect.any(Date) as Date });
    expect(env.stub.deleted).toContain(agent);
    const back = await spend();
    expect(back.trials_spend_unknown).toBe(before.trials_spend_unknown);
    expect(back.trials_usd).toBeCloseTo(before.trials_usd + 0.02, 8);
  });

  it('keeps the spend unknown when the log cannot be read but the keys are revoked anyway', async () => {
    const before = await spend();
    const { expId, c } = await claimOn('emi-basic', null);
    const agent = tokenOf(c.keys.model);
    env.stub.failSpendLogs = 500;

    await lapse(c.trial_id);
    await env.worker.sweep();
    // A lapsed attempt's keys are revoked whatever: a worker that is not dead must not keep spending.
    expect(env.stub.deleted).toContain(agent);
    expect(await row(c.trial_id)).toMatchObject({ cost_usd: null, spend_unknown: true, keys_revoked_at: expect.any(Date) as Date });
    env.stub.failSpendLogs = null;
    await env.worker.sweep(); // nothing left to read: the key is gone, and its log is not relied on
    expect((await row(c.trial_id)).spend_unknown).toBe(true);
    expect((await spend()).trials_spend_unknown).toBe(before.trials_spend_unknown + 1);
    expect(await csvRow(expId, c.trial_id)).toMatchObject({ cost_usd: '', spend_unknown: 'true' });
  });

  it("migration 015 marks attempts abandoned before it as unknown, and leaves done trials and a shipped example's rows alone", async () => {
    const backfill = /UPDATE trials[\s\S]*?;/.exec(await fs.readFile(path.join(MIGRATIONS_DIR, '015_abandoned_spend.sql'), 'utf8'))![0];
    const old = await claimOn('emi-basic', null);
    await lapse(old.c.trial_id);
    await env.worker.sweep();
    await e.quiesce();
    const example = await claimOn('emi-basic', null);
    await lapse(example.c.trial_id);
    await env.worker.sweep();
    await e.quiesce();
    const done = await claimOn('emi-basic', null);
    await e.report(done.c, 'w-crash', 'agent', { cost_usd: 0.001 });
    // As the sweep left them before 015: keys revoked, spend never read.
    await env.pool.query('UPDATE trials SET cost_usd = NULL, sim_cost_usd = NULL, spend_unknown = false WHERE id = ANY($1)', [[old.c.trial_id, example.c.trial_id]]);
    await env.pool.query("UPDATE experiments SET example_name = 'synthetic-example', example_title = 'Synthetic example (test)' WHERE id = $1", [example.expId]);
    await env.pool.query(backfill);
    expect((await row(old.c.trial_id)).spend_unknown).toBe(true);
    expect((await row(example.c.trial_id)).spend_unknown).toBe(false);
    expect(await row(done.c.trial_id)).toMatchObject({ status: 'done', cost_usd: 0.001, spend_unknown: false });
  });
});
