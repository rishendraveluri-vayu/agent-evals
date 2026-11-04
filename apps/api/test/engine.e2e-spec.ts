import Ajv2020 from 'ajv/dist/2020';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import * as path from 'node:path';
import request from 'supertest';
import type { ClaimResponse, ExperimentDetail, ReportResponse, TrialView } from '../src/contract';
import { REPO, TASKS, type TestEnv, auth, bootEnv, catalogue, makeConfig, runnerReport } from './support/app';
import { describeWithDb } from './support/db';

const EXAMPLES = path.join(REPO, 'contract/v2/examples');
const validateSpec = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(readFileSync(path.join(REPO, 'contract/v2/spec.schema.json'), 'utf8')) as object,
);
const EXAMPLE_RESULT = JSON.parse(readFileSync(path.join(EXAMPLES, 'result.json'), 'utf8')) as Record<string, unknown>;
const EXAMPLE_SPANS = readFileSync(path.join(EXAMPLES, 'trace.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

describeWithDb('experiments and the worker protocol (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let configA: string;
  let configB: string;

  beforeAll(async () => {
    env = await bootEnv();
    cat = await catalogue(env.http);
    configA = await makeConfig(env.http, cat, { name: 'arm A', settings: { temperature: 0.2 } });
    configB = await makeConfig(env.http, cat, { name: 'arm B', settings: { temperature: 0.7 } });
  });

  afterAll(async () => {
    await env.close();
  });

  // ---- helpers ----

  async function experiment(opts: { configs?: string[]; tasks?: string[]; n?: number; sim?: string | null; budget?: number; start?: boolean } = {}): Promise<ExperimentDetail> {
    const res = await request(env.http)
      .post('/api/experiments')
      .send({
        name: 'test run',
        axis: 'temperature',
        config_hashes: opts.configs ?? [configA],
        task_sha256s: opts.tasks ?? [cat.tasks['emi-basic']],
        n: opts.n ?? 1,
        sim_model: opts.sim ?? null,
        budget_usd: opts.budget ?? 50,
        plan_commit: 'plan123',
      });
    if (res.status !== 201) throw new Error(`experiment: ${res.status} ${JSON.stringify(res.body)}`);
    const exp = res.body as ExperimentDetail;
    if (opts.start !== false) await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200);
    return exp;
  }

  async function claim(worker: string, harness = 'ownloop'): Promise<ClaimResponse | null> {
    const res = await request(env.http).post('/api/worker/claim').set(auth).send({ worker_id: worker, harness });
    if (res.status === 204) return null;
    if (res.status !== 200) throw new Error(`claim: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ClaimResponse;
  }

  /** PUTs one file of the trial's out/ folder, as the worker does before its report. */
  function upload(c: { trial_id: string; attempt: number }, worker: string, rel: string, data: string | Buffer, hash: string = sha(data)) {
    return request(env.http)
      .put(`/api/worker/trials/${c.trial_id}/files/${rel}?worker_id=${encodeURIComponent(worker)}&attempt=${c.attempt}`)
      .set(auth)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Content-Sha256', hash)
      .send(Buffer.from(data));
  }

  /** Uploads the files the runner leaves in /trial/out, and returns their manifest. With `strict`,
   *  every upload must be accepted (201 new, 200 the same bytes again). */
  async function writeFolder(c: ClaimResponse, worker: string, strict = true): Promise<{ path: string; bytes: number; sha256: string }[]> {
    const files: Record<string, string> = {
      'result.json': JSON.stringify({ ...EXAMPLE_RESULT, trial_id: c.trial_id }),
      'trace.jsonl': EXAMPLE_SPANS.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'artifacts/proxy/0001.request.json': '{"model":"fake/finance-emi"}',
    };
    const manifest = [];
    for (const [rel, text] of Object.entries(files)) {
      const res = await upload(c, worker, rel, text);
      if (strict && res.status !== 201 && res.status !== 200) throw new Error(`upload ${rel}: ${res.status} ${JSON.stringify(res.body)}`);
      manifest.push({ path: rel, bytes: Buffer.byteLength(text), sha256: sha(text) });
    }
    return manifest;
  }

  async function report(c: ClaimResponse, worker: string, label = 'agent', expectStatus = 200): Promise<ReportResponse> {
    const files = await writeFolder(c, worker, expectStatus === 200);
    const res = await request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({
        worker_id: worker,
        attempt: c.attempt,
        runner_report: runnerReport(c.trial_id, c.attempt, label, files),
        result: label === 'agent' ? { ...EXAMPLE_RESULT, trial_id: c.trial_id } : null,
        spans: EXAMPLE_SPANS,
        files,
      });
    expect(res.status).toBe(expectStatus);
    return res.body as ReportResponse;
  }

  const rows = async (experimentId: string): Promise<{ id: string; attempt: number; repeat_index: number; status: string; label: string | null }[]> =>
    (await env.pool.query('SELECT id, attempt, repeat_index, status, label FROM trials WHERE experiment_id = $1 ORDER BY seq, attempt', [experimentId])).rows as never;

  const lapse = async (trialId: string): Promise<void> => {
    await env.pool.query(`UPDATE trials SET heartbeat_at = now() - interval '61 seconds' WHERE id = $1`, [trialId]);
  };

  const cancel = (id: string) => request(env.http).post(`/api/experiments/${id}/cancel`).expect(200);

  // ---- tests ----

  it('refuses workers without the worker token', async () => {
    await request(env.http).post('/api/worker/claim').send({ worker_id: 'w', harness: 'ownloop' }).expect(401);
    const res = await request(env.http).post('/api/worker/claim').set({ Authorization: 'Bearer wrong' }).send({ worker_id: 'w', harness: 'ownloop' }).expect(401);
    expect((res.body as { error: string }).error).toBe('unauthorized');
  });

  it('estimates trials, cost and time from the cost.md assumptions before any history', async () => {
    const res = await request(env.http)
      .post('/api/experiments/estimate')
      .send({ config_hashes: [configA, configB], task_sha256s: [cat.tasks['emi-basic']], n: 5, sim_model: null })
      .expect(200);
    const e = res.body as { trials: number; cost_usd: { expected: number; high: number }; minutes: number; basis: string };
    expect(e.trials).toBe(10);
    // fake/* prices: 64k x $1e-6 + 2.4k x $2e-6 = $0.0688 a trial
    expect(e.cost_usd.expected).toBeCloseTo(0.688, 6);
    expect(e.cost_usd.high).toBeCloseTo(1.376, 6);
    expect(e.minutes).toBe(10); // one ownloop worker, 10 x 60 s
    expect(e.basis).toContain('docs/cost.md assumptions');
  });

  it('refuses a plan it cannot cost or run', async () => {
    const unpriced = await makeConfig(env.http, cat, { name: 'unpriced', model: 'unpriced-model' });
    const est = (body: Record<string, unknown>) =>
      request(env.http).post('/api/experiments/estimate').send({ config_hashes: [configA], task_sha256s: [cat.tasks['emi-basic']], n: 1, ...body });
    expect((await est({ config_hashes: [unpriced] }).expect(400)).body).toMatchObject({ error: 'no_price' });
    expect((await est({ task_sha256s: [cat.tasks['widow-loan']] }).expect(400)).body).toMatchObject({ error: 'sim_model_required' });
    expect((await est({ n: 0 }).expect(400)).body).toMatchObject({ error: 'invalid_experiment' });
    expect((await est({ config_hashes: [`sha256:${'0'.repeat(64)}`] }).expect(400)).body).toMatchObject({ error: 'unknown_config' });
  });

  it('creates an experiment with queued trials, a LiteLLM team budget and the platform commit; nothing runs until started', async () => {
    const tooSmall = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'x', axis: 'temperature', config_hashes: [configA], task_sha256s: [cat.tasks['emi-basic']], n: 10, budget_usd: 0.5 })
      .expect(400);
    expect((tooSmall.body as { error: string }).error).toBe('budget_below_estimate');

    const exp = await experiment({ configs: [configA, configB], n: 2, budget: 7, start: false });
    expect(exp).toMatchObject({ status: 'created', n: 2, platform_commit: 'abc1234', plan_commit: 'plan123', budget_usd: 7 });
    expect(exp.counts.queued).toBe(4);
    expect(exp.configs.map((c) => c.name)).toEqual(['arm A', 'arm B']);
    expect(env.stub.teams.find((t) => t.team_alias === `experiment:${exp.id}`)?.max_budget).toBe(7);
    // Interleaved claim order: repeat, then task, then config.
    expect((await rows(exp.id)).map((r) => r.repeat_index)).toEqual([0, 0, 1, 1]);
    expect(await claim('w-early')).toBeNull();
    await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200);
    await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200); // idempotent
    await cancel(exp.id);
    await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(409);
  });

  it('never gives two concurrent claims the same trial', async () => {
    const exp = await experiment({ configs: [configA, configB], n: 3 });
    env.stub.keyDelayMs = 40; // hold each claim transaction open while the others run
    try {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`w-${i}`)));
      const won = results.filter((r): r is ClaimResponse => r !== null);
      expect(won).toHaveLength(6);
      expect(new Set(won.map((c) => c.trial_id)).size).toBe(6);
      const held = await rows(exp.id);
      expect(held.every((r) => r.status === 'claimed')).toBe(true);
      const workers = (await env.pool.query('SELECT DISTINCT worker_id FROM trials WHERE experiment_id = $1', [exp.id])).rowCount;
      expect(workers).toBe(6);
    } finally {
      env.stub.keyDelayMs = 0;
    }
  });

  it('hands out a full contract v2 spec, the client state and keys limited to the trial model', async () => {
    const exp = await experiment();
    const c = (await claim('w-spec'))!;
    expect(validateSpec(c.spec)).toBe(true);
    expect(c).toMatchObject({ attempt: 1, experiment_id: exp.id, lease_s: 60, folder: `${exp.id}/${c.trial_id}/attempt-1` });
    const spec = c.spec as { trial: { id: string; config_hash: string; task_version: string }; model: { name: string; base_url: string } };
    expect(spec.trial).toMatchObject({ id: c.trial_id, config_hash: configA, task_version: cat.tasks['emi-basic'] });
    expect(spec.model).toEqual(expect.objectContaining({ name: 'fake/finance-emi', base_url: `${env.stub.url}/v1` }));
    expect(Buffer.from(c.state_files['client.json'], 'base64').toString()).toBe(TASKS['emi-basic'].state);
    expect(c.keys.sim).toBeNull();
    const key = env.stub.liveKeys().find((k) => k.key === c.keys.model)!;
    expect(key).toMatchObject({ models: ['fake/finance-emi'], max_budget: c.budgets.trial_usd, team_id: env.stub.teams.find((t) => t.team_alias === `experiment:${exp.id}`)!.team_id });
    expect(key.metadata).toMatchObject({ trial_id: c.trial_id, role: 'agent' });
    // The master key never leaves the API.
    expect(JSON.stringify(c)).not.toContain('sk-test-master');
    await cancel(exp.id);
  });

  it('gives a simulated-client task the experiment simulator and its own key', async () => {
    const exp = await experiment({ tasks: [cat.tasks['widow-loan']], sim: 'claude-haiku-5-5' });
    expect(exp.sim).toMatchObject({ prompt: { id: 'client-sim', version: 'v1' }, temperature: 0 });
    const c = (await claim('w-sim'))!;
    expect(validateSpec(c.spec)).toBe(true);
    const sim = (c.spec as { task: { client_sim: { model: { name: string; api_key_env: string; prompt: { text: string } } } } }).task.client_sim;
    expect(sim.model).toMatchObject({ name: 'claude-haiku-5-5', api_key_env: 'EVALS_SIM_API_KEY' });
    expect(sim.model.prompt.text.startsWith('<!--')).toBe(false);
    expect(c.keys.sim).toEqual(expect.stringMatching(/^sk-trial-/));
    expect(env.stub.liveKeys().find((k) => k.key === c.keys.sim)?.models).toEqual(['claude-haiku-5-5']);
    expect(c.state_files).toEqual({});
    await cancel(exp.id);
  });

  it('leaves the trial queued when LiteLLM cannot mint its key', async () => {
    const exp = await experiment();
    env.stub.failKeyGenerate = 500;
    try {
      const res = await request(env.http).post('/api/worker/claim').set(auth).send({ worker_id: 'w-fail', harness: 'ownloop' }).expect(502);
      expect((res.body as { error: string }).error).toBe('litellm_error');
    } finally {
      env.stub.failKeyGenerate = null;
    }
    expect((await rows(exp.id)).map((r) => r.status)).toEqual(['queued']);
    expect(await claim('w-ok')).not.toBeNull();
    await cancel(exp.id);
  });

  it('keeps a lease on heartbeat and refuses one it does not hold', async () => {
    const exp = await experiment();
    const c = (await claim('w-hb'))!;
    const hb = (body: Record<string, unknown>, id = c.trial_id) => request(env.http).post(`/api/worker/trials/${id}/heartbeat`).set(auth).send(body);
    expect((await hb({ worker_id: 'w-hb', attempt: 1 }).expect(200)).body).toEqual({ lease_s: 60 });
    expect((await rows(exp.id))[0].status).toBe('running');
    expect((await hb({ worker_id: 'someone-else', attempt: 1 }).expect(409)).body).toMatchObject({ error: 'claim_lost' });
    await hb({ worker_id: 'w-hb', attempt: 2 }).expect(409);
    await hb({ worker_id: 'w-hb', attempt: 1 }, 't_nope').expect(404);
    await cancel(exp.id);
  });

  it('treats the same report twice as a no-op, stores spans and files, and revokes the keys', async () => {
    const exp = await experiment();
    const c = (await claim('w-rep'))!;
    const agentToken = env.stub.liveKeys().find((k) => k.key === c.keys.model)!.token;
    const first = await report(c, 'w-rep');
    expect(first).toMatchObject({ status: 'done', duplicate: false, requeued_trial_id: null, spans_stored: EXAMPLE_SPANS.length, problems: [] });
    expect(env.stub.deleted).toContain(agentToken);
    const before = (await env.pool.query('SELECT reported_at, runner_report FROM trials WHERE id = $1', [c.trial_id])).rows[0] as Record<string, unknown>;

    const again = await report(c, 'w-rep');
    expect(again).toMatchObject({ status: 'done', duplicate: true, spans_stored: EXAMPLE_SPANS.length });
    const after = (await env.pool.query('SELECT reported_at, runner_report FROM trials WHERE id = $1', [c.trial_id])).rows[0] as Record<string, unknown>;
    expect(after).toEqual(before);
    const spanCount = (await env.pool.query('SELECT count(*)::int AS n FROM spans WHERE trial_id = $1', [c.trial_id])).rows[0] as { n: number };
    expect(spanCount.n).toBe(EXAMPLE_SPANS.length);

    const view = (await request(env.http).get(`/api/trials/${c.trial_id}`).expect(200)).body as TrialView;
    expect(view).toMatchObject({ id: c.trial_id, experiment_id: exp.id, attempt: 1, status: 'done', label: 'agent', end_state: 'answered', grades: [] });
    expect(view.config).toMatchObject({ hash: configA, name: 'arm A', harness: 'ownloop', prompt: { id: 'finance-advisor', version: 'v1' } });
    expect(view.task).toMatchObject({ id: 'emi-basic', split: 'discovery' });
    expect(view.usage).toMatchObject({ cost_usd: 0.00136, input_tokens: 1200, complete: true });
    expect(view.files.every((f) => f.ok)).toBe(true);
    expect(view.timing.wall_s).toBe(12.5);

    const spans = (await request(env.http).get(`/api/trials/${c.trial_id}/spans`).expect(200)).body as { startTimeUnixNano: string; attributes: unknown[] }[];
    expect(spans).toHaveLength(EXAMPLE_SPANS.length);
    expect(Array.isArray(spans[0].attributes)).toBe(true); // contract v2 OTLP shape, unchanged
    const starts = spans.map((s) => BigInt(s.startTimeUnixNano));
    expect([...starts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(starts);

    const file = await request(env.http).get(`/api/trials/${c.trial_id}/files/artifacts/proxy/0001.request.json`).expect(200);
    expect(file.text).toContain('fake/finance-emi');
    await request(env.http).get(`/api/trials/${c.trial_id}/files/..%2F..%2F..%2Fsecret`).expect(404);
    await request(env.http).get(`/api/trials/${c.trial_id}/files/../../x`).expect(404);

    // The experiment finished on its own; a later report from another worker changes nothing.
    expect((await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body).toMatchObject({ status: 'done' });
  });

  it('re-queues attempt 2 on an infra label, and nothing after attempt 2 (D16)', async () => {
    const exp = await experiment();
    const first = (await claim('w-infra'))!;
    const r1 = await report(first, 'w-infra', 'infra:provider_error');
    expect(r1).toMatchObject({ status: 'infra_failed', duplicate: false });
    expect(r1.requeued_trial_id).toEqual(expect.any(String));

    const second = (await claim('w-infra'))!;
    expect(second.trial_id).toBe(r1.requeued_trial_id);
    expect(second.attempt).toBe(2);
    expect((second.spec as { trial: { attempt: number; repeat_index: number } }).trial).toMatchObject({ attempt: 2, repeat_index: 0 });
    const r2 = await report(second, 'w-infra', 'infra:provider_error');
    expect(r2).toMatchObject({ status: 'infra_failed', requeued_trial_id: null });

    expect((await rows(exp.id)).map((r) => [r.attempt, r.status, r.label])).toEqual([
      [1, 'infra_failed', 'infra:provider_error'],
      [2, 'infra_failed', 'infra:provider_error'],
    ]);
    expect(await claim('w-infra')).toBeNull();
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail.status).toBe('done');
    expect(detail.counts).toMatchObject({ infra_failed: 2, by_label: { 'infra:provider_error': 2 } });
    expect(detail.events.filter((e) => e.kind === 'infra_failure')).toHaveLength(2);
    expect(detail.events.filter((e) => e.kind === 'requeue')).toHaveLength(1);
    // Newest first.
    expect([...detail.events].sort((a, b) => b.at.localeCompare(a.at))).toEqual(detail.events);
  });

  it('re-queues a lapsed lease once, and not after that', async () => {
    const exp = await experiment();
    const first = (await claim('w-crash'))!;
    const firstToken = env.stub.liveKeys().find((k) => k.key === first.keys.model)!.token;
    await lapse(first.trial_id);
    const swept = await env.worker.sweep();
    expect(swept.abandoned).toEqual([first.trial_id]);
    expect(swept.requeued).toHaveLength(1);
    expect(env.stub.deleted).toContain(firstToken);
    // The crashed worker comes back: its claim is gone, so it stops and reports nothing.
    await request(env.http).post(`/api/worker/trials/${first.trial_id}/heartbeat`).set(auth).send({ worker_id: 'w-crash', attempt: 1 }).expect(409);
    await report(first, 'w-crash', 'agent', 409);

    const second = (await claim('w-2'))!;
    expect(second.attempt).toBe(2);
    await lapse(second.trial_id);
    const again = await env.worker.sweep();
    expect(again).toEqual({ abandoned: [second.trial_id], requeued: [] });
    expect(await env.worker.sweep()).toEqual({ abandoned: [], requeued: [] });

    expect((await rows(exp.id)).map((r) => [r.attempt, r.status])).toEqual([
      [1, 'abandoned'],
      [2, 'abandoned'],
    ]);
    expect(await claim('w-3')).toBeNull();
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail).toMatchObject({ status: 'done', counts: { abandoned: 2 } });
    expect(detail.events.filter((e) => e.kind === 'abandoned')).toHaveLength(2);
  });

  it('resumes after a worker crash with no lost, duplicated or mislabelled trials', async () => {
    const exp = await experiment({ configs: [configA, configB], n: 2 });
    const a = (await claim('w-a'))!;
    const b = (await claim('w-b'))!; // w-b crashes holding b
    await report(a, 'w-a');
    await lapse(b.trial_id);
    await env.worker.sweep();
    for (;;) {
      const c = await claim('w-a');
      if (!c) break;
      await report(c, 'w-a');
    }
    const all = await rows(exp.id);
    const slots = new Map<string, string[]>();
    for (const r of (await env.pool.query('SELECT config_hash, repeat_index, attempt, status FROM trials WHERE experiment_id = $1', [exp.id])).rows as {
      config_hash: string;
      repeat_index: number;
      attempt: number;
      status: string;
    }[]) {
      const key = `${r.config_hash}:${r.repeat_index}`;
      slots.set(key, [...(slots.get(key) ?? []), `${r.attempt}:${r.status}`].sort());
    }
    expect(slots.size).toBe(4); // every slot present
    expect([...slots.values()].filter((s) => s.includes('1:abandoned'))).toEqual([['1:abandoned', '2:done']]);
    expect(all.filter((r) => r.status === 'done')).toHaveLength(4); // one done per slot, none twice
    expect((await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body).toMatchObject({ status: 'done' });
  });

  it('accepts a report whose files do not match, and says so instead of dropping the trial', async () => {
    const exp = await experiment();
    const c = (await claim('w-files'))!;
    const files = await writeFolder(c, 'w-files');
    files[0] = { ...files[0], sha256: '0'.repeat(64) };
    files.push({ path: 'missing.log', bytes: 1, sha256: '1'.repeat(64) });
    const res = await request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: 'w-files', attempt: 1, runner_report: runnerReport(c.trial_id, 1, 'agent', files), result: EXAMPLE_RESULT, spans: [], files })
      .expect(200);
    expect((res.body as ReportResponse).problems.join(' ')).toContain('2 of 4 files');
    const view = (await request(env.http).get(`/api/trials/${c.trial_id}`).expect(200)).body as TrialView;
    expect(view.files.filter((f) => !f.ok).map((f) => f.path)).toEqual(['result.json', 'missing.log']);
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail.events.some((e) => e.kind === 'file_problem')).toBe(true);
  });

  it('stores uploaded files under runs/<experiment>/<trial>/attempt-<n>/, whole, hashed and never overwritten', async () => {
    const exp = await experiment();
    const c = (await claim('w-up'))!;
    const stored = path.join(env.runsDir, c.folder);
    const first = await upload(c, 'w-up', 'artifacts/proxy/0001.request.json', '{"a":1}').expect(201);
    expect(first.body).toEqual({ path: 'artifacts/proxy/0001.request.json', bytes: 7, sha256: `sha256:${sha('{"a":1}')}`, duplicate: false });
    expect(await fs.readFile(path.join(stored, 'artifacts/proxy/0001.request.json'), 'utf8')).toBe('{"a":1}');
    // The same bytes again (a retried upload) are a no-op; different bytes never replace them.
    expect((await upload(c, 'w-up', 'artifacts/proxy/0001.request.json', '{"a":1}', `sha256:${sha('{"a":1}')}`).expect(200)).body).toMatchObject({ duplicate: true });
    expect((await upload(c, 'w-up', 'artifacts/proxy/0001.request.json', '{"a":2}').expect(409)).body).toMatchObject({ error: 'file_conflict' });
    expect(await fs.readFile(path.join(stored, 'artifacts/proxy/0001.request.json'), 'utf8')).toBe('{"a":1}');
    // The hash header is checked against the bytes, in either form; a mismatch stores nothing.
    expect((await upload(c, 'w-up', 'stdout.log', 'hello', sha('other')).expect(400)).body).toMatchObject({ error: 'hash_mismatch' });
    await expect(fs.stat(path.join(stored, 'stdout.log'))).rejects.toThrow();
    await upload(c, 'w-up', 'stdout.log', 'hello', sha('hello').toUpperCase()).expect(201);
    // Paths that leave the attempt folder are refused, and nothing lands outside it.
    for (const bad of ['..%2F..%2Fescape.txt', 'a/../../escape.txt', '.%2E/escape.txt', 'a%00b']) {
      expect((await upload(c, 'w-up', bad, 'x').expect(400)).body).toMatchObject({ error: 'invalid_path' });
    }
    await expect(fs.stat(path.join(env.runsDir, exp.id, 'escape.txt'))).rejects.toThrow();
    await expect(fs.stat(path.join(env.runsDir, exp.id, c.trial_id, 'escape.txt'))).rejects.toThrow();
    // A file in the way of a folder, and the other refusals.
    await upload(c, 'w-up', 'stdout.log/inner', 'x').expect(409);
    const put = (headers: Record<string, string>) =>
      request(env.http).put(`/api/worker/trials/${c.trial_id}/files/x.txt?worker_id=w-up&attempt=1`).set(auth).set(headers).send(Buffer.from('x'));
    expect((await put({ 'Content-Type': 'application/octet-stream' }).expect(400)).body).toMatchObject({ error: 'invalid_upload' });
    await put({ 'Content-Type': 'application/json', 'X-Content-Sha256': sha('x') }).expect(415);
    await request(env.http).put(`/api/worker/trials/${c.trial_id}/files/x.txt?worker_id=w-up&attempt=1`).set('Content-Type', 'application/octet-stream').send(Buffer.from('x')).expect(401);
    expect((await upload(c, 'someone-else', 'x.txt', 'x').expect(409)).body).toMatchObject({ error: 'claim_lost' });
    expect((await upload({ ...c, attempt: 2 }, 'w-up', 'x.txt', 'x').expect(409)).body).toMatchObject({ error: 'attempt_mismatch' });
    await upload({ trial_id: 't_nope', attempt: 1 }, 'w-up', 'x.txt', 'x').expect(404);
    // No temporary files are left next to the attempt folder.
    expect((await fs.readdir(path.dirname(stored))).sort()).toEqual(['attempt-1']);
    await cancel(exp.id);
  });

  it('refuses a file over 64 MB from its Content-Length, before reading it', async () => {
    await experiment();
    const c = (await claim('w-big-file'))!;
    const { port } = (env.app.getHttpServer() as { address(): { port: number } }).address();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: `/api/worker/trials/${c.trial_id}/files/huge.bin?worker_id=w-big-file&attempt=1`,
          headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(64 * 1024 * 1024 + 1), 'X-Content-Sha256': sha('') },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.flushHeaders(); // headers only: the body is never sent
    });
    expect(status).toBe(413);
    await expect(fs.stat(path.join(env.runsDir, c.folder, 'huge.bin'))).rejects.toThrow();
  });

  it('after the report, takes the same bytes again but no new or changed file', async () => {
    await experiment();
    const c = (await claim('w-after'))!;
    await report(c, 'w-after');
    const result = JSON.stringify({ ...EXAMPLE_RESULT, trial_id: c.trial_id });
    expect((await upload(c, 'w-after', 'result.json', result).expect(200)).body).toMatchObject({ duplicate: true });
    expect((await upload(c, 'w-after', 'result.json', '{}').expect(409)).body).toMatchObject({ error: 'file_conflict' });
    expect((await upload(c, 'w-after', 'late.log', 'late').expect(409)).body).toMatchObject({ error: 'already_reported' });
  });

  it('refuses uploads for a lapsed claim', async () => {
    const exp = await experiment();
    const c = (await claim('w-lapsed'))!;
    await lapse(c.trial_id);
    await env.worker.sweep();
    expect((await upload(c, 'w-lapsed', 'result.json', '{}').expect(409)).body).toMatchObject({ error: 'claim_lost' });
    await cancel(exp.id);
  });

  it('takes reported file hashes as sha256:<hex> or bare hex and stores them as sha256:<hex>', async () => {
    await experiment();
    const c = (await claim('w-hash'))!;
    const files = await writeFolder(c, 'w-hash');
    const mixed = files.map((f, i) => ({ ...f, sha256: i % 2 ? `sha256:${f.sha256}` : f.sha256.toUpperCase() }));
    const res = await request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: 'w-hash', attempt: 1, runner_report: runnerReport(c.trial_id, 1, 'agent', files), result: EXAMPLE_RESULT, spans: [], files: mixed })
      .expect(200);
    expect((res.body as ReportResponse).problems).toEqual([]);
    const view = (await request(env.http).get(`/api/trials/${c.trial_id}`).expect(200)).body as TrialView;
    expect(view.files.map((f) => [f.path, f.sha256, f.ok])).toEqual(files.map((f) => [f.path, `sha256:${f.sha256}`, true]));
  });

  it('passes LiteLLM spend-log rows for a trial key through to its worker', async () => {
    const exp = await experiment();
    const c = (await claim('w-calls'))!;
    const token = env.stub.liveKeys().find((k) => k.key === c.keys.model)!.token;
    env.stub.spendLogs.set(token, [{ request_id: 'r1', status: 'success', spend: 0.001 }]);
    const res = await request(env.http).get(`/api/worker/trials/${c.trial_id}/calls?role=agent`).set(auth).expect(200);
    expect(res.body).toEqual([{ request_id: 'r1', status: 'success', spend: 0.001 }]);
    await request(env.http).get(`/api/worker/trials/${c.trial_id}/calls?role=sim`).set(auth).expect(404);
    await request(env.http).get(`/api/worker/trials/${c.trial_id}/calls?role=judge`).set(auth).expect(400);
    await cancel(exp.id);
  });

  it('cancels queued trials and lets claimed ones finish without a re-queue', async () => {
    const exp = await experiment({ n: 3 });
    const c = (await claim('w-cancel'))!;
    const res = (await cancel(exp.id)).body as ExperimentDetail;
    expect(res).toMatchObject({ status: 'cancelled', counts: { cancelled: 2, running: 1 } });
    expect(await claim('w-cancel')).toBeNull();
    const r = await report(c, 'w-cancel', 'infra:adapter_crash');
    expect(r).toMatchObject({ status: 'infra_failed', requeued_trial_id: null });
  });

  it('exports every trial, infra failures and cancelled ones included, as JSON and CSV', async () => {
    const exp = await experiment({ n: 3 });
    await report((await claim('w-x'))!, 'w-x', 'agent');
    await report((await claim('w-x'))!, 'w-x', 'infra:provider_error'); // queues attempt 2
    await cancel(exp.id); // attempt 2 and the third slot are cancelled

    const json = await request(env.http).get(`/api/experiments/${exp.id}/export?format=json`).expect(200);
    expect(json.headers['content-type']).toContain('application/json');
    const body = JSON.parse(json.text) as { experiment: { id: string; platform_commit: string }; trials: { status: string; label: string | null; config: { hash: string; settings: unknown }; task: { id: string }; spend: { cost_usd: number | null }; grades: unknown[] }[] };
    expect(body.experiment).toMatchObject({ id: exp.id, platform_commit: 'abc1234' });
    expect(body.trials.map((t) => [t.status, t.label])).toEqual([
      ['done', 'agent'],
      ['infra_failed', 'infra:provider_error'],
      ['cancelled', null],
      ['cancelled', null],
    ]);
    expect(body.trials[0]).toMatchObject({ config: { hash: configA }, task: { id: 'emi-basic' }, spend: { cost_usd: 0.00136 }, grades: [] });

    const csv = await request(env.http).get(`/api/experiments/${exp.id}/export?format=csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\n');
    expect(lines).toHaveLength(5);
    const header = lines[0].split(',');
    const status = header.indexOf('status');
    const label = header.indexOf('label');
    expect(lines.slice(1).map((l) => [l.split(',')[status], l.split(',')[label]])).toEqual([
      ['done', 'agent'],
      ['infra_failed', 'infra:provider_error'],
      ['cancelled', ''],
      ['cancelled', ''],
    ]);
    await request(env.http).get(`/api/experiments/${exp.id}/export?format=xml`).expect(400);
    await request(env.http).get('/api/experiments/e_nope/export').expect(404);
  });

  it('compares per task and arm with stats null until SP6, and lists experiments with counts and spend', async () => {
    const exp = await experiment({ configs: [configA, configB] });
    await report((await claim('w-cmp'))!, 'w-cmp', 'agent');
    await report((await claim('w-cmp'))!, 'w-cmp', 'infra:budget_net');
    const cmp = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as { stats: unknown; rows: { config: string; trials: number; infra_failed: number; graded: number }[] };
    expect(cmp.stats).toBeNull();
    expect(cmp.rows.map((r) => [r.config, r.trials, r.infra_failed, r.graded])).toEqual([
      [configA, 1, 0, 0],
      [configB, 0, 1, 0],
    ]);
    const list = (await request(env.http).get('/api/experiments').expect(200)).body as { id: string; spend_usd: number; counts: { done: number; queued: number } }[];
    const mine = list.find((e) => e.id === exp.id)!;
    expect(mine.spend_usd).toBeCloseTo(0.00272, 8);
    expect(mine.counts).toMatchObject({ done: 1, queued: 1 }); // budget_net re-queued attempt 2
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail.events.some((e) => e.kind === 'budget_trip')).toBe(true);
    const trials = (await request(env.http).get(`/api/experiments/${exp.id}/trials?status=done`).expect(200)).body as { config_name: string }[];
    expect(trials.map((t) => t.config_name)).toEqual(['arm A']);
    await request(env.http).get(`/api/experiments/${exp.id}/trials?status=bogus`).expect(400);
    await cancel(exp.id);
  });

  it('estimates from earlier finished trials once there are some', async () => {
    const res = await request(env.http)
      .post('/api/experiments/estimate')
      .send({ config_hashes: [configA], task_sha256s: [cat.tasks['emi-basic']], n: 1 })
      .expect(200);
    const e = res.body as { basis: string; basis_detail: { cells: { source: string; input_tokens: number; wall_s: number }[] } };
    expect(e.basis_detail.cells[0]).toMatchObject({ source: 'history', input_tokens: 1200, wall_s: 12.5 });
    expect(e.basis).toContain('earlier finished trials');
  });

  it('serves a blind label queue and appends labels to labels/<set>.jsonl', async () => {
    const exp = await experiment();
    const c = (await claim('w-label'))!;
    await report(c, 'w-label');
    const queue = (await request(env.http).get(`/api/labels/queue?set=tuning&experiment=${exp.id}`).expect(200)).body as Record<string, unknown>[];
    expect(queue).toHaveLength(1);
    const item = queue[0];
    expect(Object.keys(item).sort()).toEqual(['criteria', 'item_id', 'task_summary', 'tool_calls', 'transcript']);
    expect(JSON.stringify(item)).not.toMatch(/ownloop|fake\/finance-emi|arm A|cost|wall_s/);
    expect(item.criteria).toEqual([
      { id: 'empathy', text: 'Acknowledges the client situation' },
      { id: 'no_jargon', text: 'no_jargon' },
    ]);
    expect((item.tool_calls as { name: string }[])[0].name).toBe('calculate_emi');

    await request(env.http).post('/api/labels').send({ item_id: item.item_id, set: 'tuning', criterion: 'nope', value: 'yes' }).expect(400);
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, set: 'tuning', criterion: 'empathy', value: 'maybe' }).expect(400);
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, set: 'nonsense', criterion: 'empathy', value: 'yes' }).expect(400);
    const created = await request(env.http).post('/api/labels').send({ item_id: item.item_id, set: 'tuning', criterion: 'empathy', value: 'yes', note: 'warm' }).expect(201);
    expect(created.body).toMatchObject({ trial_id: c.trial_id, set: 'tuning', criterion: 'empathy', value: 'yes', note: 'warm' });
    const lines = (await fs.readFile(path.join(env.labelsDir, 'tuning.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ criterion: 'empathy', value: 'yes', labelled_at: expect.any(String) as string });

    const left = (await request(env.http).get(`/api/labels/queue?set=tuning&experiment=${exp.id}`).expect(200)).body as { criteria: { id: string }[] }[];
    expect(left[0].criteria.map((x) => x.id)).toEqual(['no_jargon']);
    expect((await request(env.http).get(`/api/labels/queue?set=heldout&experiment=${exp.id}`).expect(200)).body).toHaveLength(1);
    const agreement = await request(env.http).get('/api/judge/agreement?set=heldout').expect(200);
    expect(agreement.text).toBe('null');
  });

  it('takes a report far over Express’s 100 kB default body limit', async () => {
    const exp = await experiment();
    const c = (await claim('w-big'))!;
    const [template] = EXAMPLE_SPANS;
    const spans = Array.from({ length: 800 }, (_, i) => ({ ...template, spanId: i.toString(16).padStart(16, '0') }));
    expect(JSON.stringify(spans).length).toBeGreaterThan(400_000);
    const res = await request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: 'w-big', attempt: 1, runner_report: runnerReport(c.trial_id, 1, 'agent'), result: EXAMPLE_RESULT, spans, files: [] })
      .expect(200);
    expect((res.body as ReportResponse).spans_stored).toBe(800);
    expect((await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body).toMatchObject({ status: 'done' });
  });

  it('still serves folder trials (gate and smoke runs) from RUNS_DIR, with experiment_id null', async () => {
    const dir = path.join(env.runsDir, '20261103T000000Z', 'scripted', 'gate', 'trial');
    await fs.mkdir(path.join(dir, 'out'), { recursive: true });
    await fs.copyFile(path.join(EXAMPLES, 'spec.json'), path.join(dir, 'spec.json'));
    for (const name of ['result.json', 'runner-report.json', 'trace.jsonl']) await fs.copyFile(path.join(EXAMPLES, name), path.join(dir, 'out', name));

    const list = (await request(env.http).get('/api/trials').expect(200)).body as { experiment_id: null; trialId: string }[];
    const known = (await env.pool.query('SELECT id FROM trials')).rows.map((r: { id: string }) => r.id);
    // Experiment attempt folders are on the same volume but are not folder trials.
    expect(list.filter((t) => known.includes(t.trialId))).toEqual([]);
    expect(list.map((t) => [t.trialId, t.experiment_id])).toEqual([['t_01JEXAMPLE0001', null]]);
    const detail = (await request(env.http).get('/api/trials/t_01JEXAMPLE0001').expect(200)).body as { experiment_id: null; summary: { harness: string } };
    expect(detail).toMatchObject({ experiment_id: null, summary: { harness: 'scripted' } });
    const spans = (await request(env.http).get('/api/trials/t_01JEXAMPLE0001/spans').expect(200)).body as { attributes: Record<string, unknown> }[];
    expect(Array.isArray(spans[0].attributes)).toBe(false); // the folder view's plain attributes, as before
    await request(env.http).get('/api/trials/t_nope').expect(404);
  });
});
