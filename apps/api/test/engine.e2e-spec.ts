import Ajv2020 from 'ajv/dist/2020';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import * as path from 'node:path';
import request from 'supertest';
import type { ClaimResponse, ExperimentDetail, LabelQueueItem, ReportResponse, ToolsetView, TrialView } from '../src/contract';
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
        plan_commit: 'a1b2c3d',
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
  async function writeFolder(c: ClaimResponse, worker: string, strict = true, extra: Record<string, string> = {}): Promise<{ path: string; bytes: number; sha256: string }[]> {
    const files: Record<string, string> = {
      'result.json': JSON.stringify({ ...EXAMPLE_RESULT, trial_id: c.trial_id }),
      'trace.jsonl': EXAMPLE_SPANS.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'artifacts/proxy/0001.request.json': '{"model":"fake/finance-emi"}',
      ...extra,
    };
    const manifest = [];
    for (const [rel, text] of Object.entries(files)) {
      const res = await upload(c, worker, rel, text);
      if (strict && res.status !== 201 && res.status !== 200) throw new Error(`upload ${rel}: ${res.status} ${JSON.stringify(res.body)}`);
      manifest.push({ path: rel, bytes: Buffer.byteLength(text), sha256: sha(text) });
    }
    return manifest;
  }

  async function report(c: ClaimResponse, worker: string, label = 'agent', expectStatus = 200, extra: Record<string, string> = {}): Promise<ReportResponse> {
    const files = await writeFolder(c, worker, expectStatus === 200, extra);
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
    // One ownloop worker, 10 trials x 10 s: a fake model answers at once (60 s is for real models).
    expect(e.minutes).toBe(1.7);
    expect(e.basis).toContain('docs/cost.md assumptions');
    expect(e.basis).toContain('with no history 60 s on a real model, 10 s on a fake one');
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

  it('refuses a run name longer than 200 characters, saying how long it is, and creates nothing (QA round 3)', async () => {
    const body = (name: string) => ({ name, axis: 'temperature', config_hashes: [configA], task_sha256s: [cat.tasks['emi-basic']], n: 1, budget_usd: 1 });
    const before = ((await request(env.http).get('/api/experiments').expect(200)).body as unknown[]).length;
    const res = await request(env.http).post('/api/experiments').send(body('N'.repeat(201))).expect(400);
    expect(res.body).toEqual({ error: 'invalid_experiment', message: 'name is 201 characters, longer than the 200 allowed', fix: 'Shorten the name to 200 characters or fewer.' });
    expect(((await request(env.http).get('/api/experiments').expect(200)).body as unknown[]).length).toBe(before);
    // Spaces around it are trimmed first, and 200 is allowed.
    const ok = (await request(env.http).post('/api/experiments').send(body(`  ${'N'.repeat(200)}  `)).expect(201)).body as ExperimentDetail;
    expect(ok.name).toHaveLength(200);
    await cancel(ok.id);
  });

  it('creates an experiment with queued trials, a LiteLLM team budget and the platform commit; nothing runs until started', async () => {
    // A real model: a budget below the estimate's high end is refused (R10.6).
    const haiku = await makeConfig(env.http, cat, { name: 'real haiku', model: 'claude-haiku-5-5' });
    const tooSmall = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'x', axis: 'temperature', config_hashes: [haiku], task_sha256s: [cat.tasks['emi-basic']], n: 10, budget_usd: 0.01 })
      .expect(400);
    expect((tooSmall.body as { error: string }).error).toBe('budget_below_estimate');
    // Fake models only: the prices are made up, so it is not refused; the budget is raised to the
    // estimate's high end so LiteLLM's cap and the spend guard cannot stop it part-way.
    const fake = (
      await request(env.http)
        .post('/api/experiments')
        .send({ name: 'free', axis: 'temperature', config_hashes: [configA], task_sha256s: [cat.tasks['emi-basic']], n: 10, budget_usd: 0.5 })
        .expect(201)
    ).body as ExperimentDetail;
    expect(fake.budget_usd).toBeCloseTo(fake.estimate.cost_usd.high, 6);
    expect(fake.budget_usd).toBeGreaterThan(0.5);
    expect(env.stub.teams.find((t) => t.team_alias === `experiment:${fake.id}`)?.max_budget).toBeCloseTo(fake.estimate.cost_usd.high, 6);
    // Above the high end, the budget is kept as given.
    const roomy = (
      await request(env.http)
        .post('/api/experiments')
        .send({ name: 'free', axis: 'temperature', config_hashes: [configA], task_sha256s: [cat.tasks['emi-basic']], n: 1, budget_usd: 9 })
        .expect(201)
    ).body as ExperimentDetail;
    expect(roomy.budget_usd).toBe(9);
    // A fake agent with a real simulated client spends real money, so it is checked as usual.
    const realSim = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'x', axis: 'temperature', config_hashes: [configA], task_sha256s: [cat.tasks['widow-loan']], n: 10, sim_model: 'claude-sonnet-5-5', budget_usd: 0.01 })
      .expect(400);
    expect((realSim.body as { error: string }).error).toBe('budget_below_estimate');
    await cancel(fake.id);
    await cancel(roomy.id);

    const exp = await experiment({ configs: [configA, configB], n: 2, budget: 7, start: false });
    expect(exp).toMatchObject({ status: 'created', n: 2, platform_commit: 'abc1234', plan_commit: 'a1b2c3d', budget_usd: 7 });
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
    // D27: the default simulator prompt is the highest version (v4 since Rishi's review, 4 Nov), and Haiku 5.5 gets no temperature.
    expect(exp.sim).toMatchObject({ prompt: { id: 'client-sim', version: 'v4' }, temperature: null, max_output_tokens: 2048 });
    const c = (await claim('w-sim'))!;
    expect(validateSpec(c.spec)).toBe(true);
    const sim = (c.spec as { task: { client_sim: { client_summary?: string; model: { name: string; api_key_env: string; temperature: number | null; prompt: { text: string; version: string } } } } }).task
      .client_sim;
    expect(sim.model).toMatchObject({ name: 'claude-haiku-5-5', api_key_env: 'EVALS_SIM_API_KEY', temperature: null, max_output_tokens: 2048 });
    expect(sim.model.prompt.version).toBe('v4');
    expect(sim.model.prompt.text).toContain('## Your patience');
    expect(sim.model.prompt.text.startsWith('<!--')).toBe(false);
    expect(sim.model.prompt.text).toContain('{{client_summary}}');
    // The summary of the task's client file, which the API built from the stored client.json.
    expect(sim.client_summary).toBe(
      'Profile:\n- name: Test Widow (synthetic)\n- city: Pune\n- monthly net income: 92000\n' +
        'Debts (1, total balance ₹18,00,000.00, total minimum payments ₹16,200.00 a month):\n' +
        '- Home loan (home loan): balance ₹18,00,000.00 at 8.5% a year, minimum payment ₹16,200.00 a month, 180 months left\n' +
        'Transactions: none recorded',
    );
    expect(c.keys.sim).toEqual(expect.stringMatching(/^sk-trial-/));
    expect(env.stub.liveKeys().find((k) => k.key === c.keys.sim)?.models).toEqual(['claude-haiku-5-5']);
    expect(Object.keys(c.state_files)).toEqual(['client.json']);
    await cancel(exp.id);
  });

  it("keeps D22's temperature 0 for a simulator model that takes it", async () => {
    const exp = await experiment({ tasks: [cat.tasks['widow-loan']], sim: 'gemini-3.8-flash', start: false });
    expect(exp.sim).toMatchObject({ prompt: { version: 'v4' }, temperature: 0 });
    await cancel(exp.id);
  });

  it("hands a worker only the config's toolset: finance-no-calculators gives its 11 tools, not the calculators (D70)", async () => {
    const toolsets = (await request(env.http).get('/api/toolsets').expect(200)).body as ToolsetView[];
    const broken = toolsets.find((t) => t.id === 'finance-no-calculators')!;
    const config = await makeConfig(env.http, cat, { name: 'no calculators', harness: 'langgraph', toolset_sha256: broken.sha256 });
    const exp = await experiment({ configs: [config] });
    const c = (await claim('w-d70', 'langgraph'))!;
    expect(validateSpec(c.spec)).toBe(true);
    const tools = (c.spec as { tools: { toolset: { id: string; version: string; sha256: string }; mcp_servers: { name: string; allowed_tools: string[] }[] } }).tools;
    expect(tools.toolset).toEqual({ id: 'finance-no-calculators', version: 'v3', sha256: broken.sha256.slice('sha256:'.length) });
    expect(tools.mcp_servers.map((s) => [s.name, s.allowed_tools])).toEqual([
      ['finance', ['get_client_profile', 'list_debts', 'list_transactions', 'add', 'subtract', 'multiply', 'divide', 'percent_of', 'percent_change', 'round', 'reference_rates']],
    ]);
    await cancel(exp.id);
  });

  it("puts the config's seeded memory and skills in the claimed trial's spec (D39)", async () => {
    const seed = {
      memory: ['The client (synthetic) wants every amount in rupees.'],
      skills: [{ name: 'emi-check', description: 'Check an EMI before quoting it', body: 'Call the EMI tool, then quote its number.' }],
    };
    const seeded = await makeConfig(env.http, cat, { name: 'hermes seeded', harness: 'hermes', settings: { memory: { enabled: true }, skills: { enabled: true } }, seed });
    const exp = await experiment({ configs: [seeded] });
    const c = (await claim('w-seed', 'hermes'))!;
    expect(validateSpec(c.spec)).toBe(true);
    expect(c.spec).toMatchObject({ trial: { config_hash: seeded }, seed });
    await cancel(exp.id);
    // A config without seeds still starts its trials with none.
    const plain = await experiment();
    expect(((await claim('w-seed'))!.spec as { seed: unknown }).seed).toEqual({ memory: [], skills: [] });
    await cancel(plain.id);
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

  it('re-queues a simulator failure once (infra:sim_error, D26) and never caches its empty reply', async () => {
    // Earlier tests' experiments must not hold queued ownloop trials that would be claimed first.
    for (const { id } of (await env.pool.query("SELECT id FROM experiments WHERE status = 'running'")).rows as { id: string }[]) await cancel(id);
    const widow = cat.tasks['widow-loan'];
    const exp = await experiment({ tasks: [widow], sim: 'claude-haiku-5-5' });
    const emptyKey = `sha256:${'e'.repeat(64)}`;
    const oldKey = `sha256:${'f'.repeat(64)}`;
    // What the adapter writes for the 4 Nov case: the reply had no text, all its tokens were reasoning.
    const usage = { completion_tokens: 2048, completion_tokens_details: { reasoning_tokens: 2048, text_tokens: 0 } };
    const simFile = JSON.stringify({ key: emptyKey, reply: '', model: 'claude-haiku-5-5', usage, error: 'reply has no text' }) + '\n';

    const first = (await claim('w-simerr'))!;
    expect(first.sim_cache).toEqual({});
    const r1 = await report(first, 'w-simerr', 'infra:sim_error', 200, { 'sim_replies.jsonl': simFile });
    expect(r1).toMatchObject({ status: 'infra_failed', duplicate: false, sim_replies_stored: 0 });
    expect(r1.problems.filter((p) => p.includes('sim_replies'))).toEqual([]);
    expect(r1.requeued_trial_id).toEqual(expect.any(String));
    // The raw reply stays in the attempt's stored file, for the record.
    const stored = await request(env.http).get(`/api/trials/${first.trial_id}/files/sim_replies.jsonl`).expect(200);
    expect(stored.text).toBe(simFile);

    // An empty reply stored before this rule (the 4 Nov Haiku replies) is not handed out either.
    const model = (first.spec as { task: { client_sim: { model: { max_output_tokens: number; prompt: { sha256: string } } } } }).task.client_sim.model;
    await env.pool.query(
      `INSERT INTO sim_replies (key, task_sha256, sim_model, temperature, max_output_tokens, prompt_sha256, reply, usage, trial_id)
       VALUES ($1, $2, 'claude-haiku-5-5', NULL, $3, $4, '', $5, $6)`,
      [oldKey, widow, model.max_output_tokens, `sha256:${model.prompt.sha256.replace(/^sha256:/, '')}`, JSON.stringify(usage), first.trial_id],
    );

    const second = (await claim('w-simerr'))!;
    expect(second).toMatchObject({ trial_id: r1.requeued_trial_id, attempt: 2 });
    expect(second.sim_cache).toEqual({});
    const r2 = await report(second, 'w-simerr', 'infra:sim_error', 200, { 'sim_replies.jsonl': simFile });
    expect(r2).toMatchObject({ status: 'infra_failed', requeued_trial_id: null, sim_replies_stored: 0 });

    expect((await rows(exp.id)).map((r) => [r.attempt, r.status, r.label])).toEqual([
      [1, 'infra_failed', 'infra:sim_error'],
      [2, 'infra_failed', 'infra:sim_error'],
    ]);
    expect(await claim('w-simerr')).toBeNull();
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail.status).toBe('done');
    expect(detail.counts).toMatchObject({ infra_failed: 2, by_label: { 'infra:sim_error': 2 } });
    expect(detail.events.filter((e) => e.kind === 'infra_failure').map((e) => [e.attempt, e.detail])).toEqual([
      [2, expect.stringContaining('attempt 2: infra:sim_error') as string],
      [1, expect.stringContaining('attempt 1: infra:sim_error') as string],
    ]);
    expect(detail.events.filter((e) => e.kind === 'requeue').map((e) => e.trial_id)).toEqual([second.trial_id]);
    const cached = (await env.pool.query('SELECT key FROM sim_replies WHERE task_sha256 = $1 AND key = ANY($2)', [widow, [emptyKey, oldKey]])).rows;
    expect(cached).toEqual([{ key: oldKey }]); // the reported empty reply was never stored
    await env.pool.query('DELETE FROM sim_replies WHERE key = $1', [oldKey]); // later tests count the widow task's replies
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

  it('hands later trials of a conversation task the simulator replies earlier trials stored (D22)', async () => {
    // Earlier tests' experiments must not hold queued ownloop trials that would be claimed first.
    for (const { id } of (await env.pool.query("SELECT id FROM experiments WHERE status = 'running'")).rows as { id: string }[]) await cancel(id);
    const widow = cat.tasks['widow-loan'];
    const exp = await experiment({ configs: [configA, configB], tasks: [widow], sim: 'claude-haiku-5-5' });
    const key = (c: string): string => `sha256:${c.repeat(64)}`;
    const jsonl = (rows: Record<string, unknown>[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

    const first = (await claim('w-sim-1'))!;
    expect(first.sim_cache).toEqual({});
    const r1 = await report(first, 'w-sim-1', 'agent', 200, {
      'sim_replies.jsonl': jsonl([
        { key: key('1'), reply: 'Will I lose the house?', model: 'claude-haiku-5-5', usage: { prompt_tokens: 40, completion_tokens: 6 } },
        { key: key('2'), reply: 'Thank you. [[END_CONVERSATION]]', model: 'claude-haiku-5-5', usage: null },
        { key: 'not-a-key', reply: 'x', model: 'claude-haiku-5-5' },
      ]),
    });
    expect(r1).toMatchObject({ status: 'done', sim_replies_stored: 2 });
    expect(r1.problems).toEqual([expect.stringContaining('line 3 is not {key: sha256:<hex>, reply}') as string]);

    // The second arm's trial reaches the same conversation states: it gets the first's replies, so
    // its runner answers those turns from the cache instead of calling the simulator.
    const second = (await claim('w-sim-2'))!;
    expect(second.trial_id).not.toBe(first.trial_id);
    expect(second.sim_cache).toEqual({ [key('1')]: 'Will I lose the house?', [key('2')]: 'Thank you. [[END_CONVERSATION]]' });
    // Its new replies are added; a reply for a state already stored never replaces the first one.
    const r2 = await report(second, 'w-sim-2', 'agent', 200, {
      'sim_replies.jsonl': jsonl([
        { key: key('1'), reply: 'a different reply', model: 'claude-haiku-5-5' },
        { key: key('3'), reply: 'What about my EMI?', model: 'claude-haiku-5-5' },
      ]),
    });
    expect(r2.sim_replies_stored).toBe(1);
    expect(await report(second, 'w-sim-2')).toMatchObject({ duplicate: true, sim_replies_stored: 1 }); // a repeat stores nothing
    const stored = (await env.pool.query('SELECT key, reply, trial_id FROM sim_replies WHERE task_sha256 = $1 ORDER BY key', [widow])).rows as { key: string; reply: string; trial_id: string }[];
    expect(stored.map((r) => [r.key, r.reply, r.trial_id])).toEqual([
      [key('1'), 'Will I lose the house?', first.trial_id],
      [key('2'), 'Thank you. [[END_CONVERSATION]]', first.trial_id],
      [key('3'), 'What about my EMI?', second.trial_id],
    ]);
    // D27: Haiku 5.5's simulator sends no temperature, so its replies are stored and found under a null one.
    expect((await env.pool.query('SELECT DISTINCT temperature FROM sim_replies WHERE task_sha256 = $1', [widow])).rows).toEqual([{ temperature: null }]);
    expect((await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body).toMatchObject({ status: 'done' });

    // Another simulator model shares nothing, and a file the API does not hold intact is not read.
    const other = await experiment({ tasks: [widow], sim: 'gemini-3.8-flash' });
    const third = (await claim('w-sim-3'))!;
    expect(third.sim_cache).toEqual({});
    const files = await writeFolder(third, 'w-sim-3');
    files.push({ path: 'sim_replies.jsonl', bytes: 10, sha256: '9'.repeat(64) });
    const r3 = (
      await request(env.http)
        .post(`/api/worker/trials/${third.trial_id}/report`)
        .set(auth)
        .send({ worker_id: 'w-sim-3', attempt: 1, runner_report: runnerReport(third.trial_id, 1, 'agent', files), result: EXAMPLE_RESULT, spans: [], files })
        .expect(200)
    ).body as ReportResponse;
    expect(r3.sim_replies_stored).toBe(0);
    expect(r3.problems).toEqual(expect.arrayContaining([expect.stringContaining('sim_replies.jsonl was not stored intact') as string]));
    expect((await request(env.http).get(`/api/experiments/${other.id}`).expect(200)).body).toMatchObject({ status: 'done' });

    // A task without a simulated client gets no cache at all.
    const plain = await experiment();
    expect((await claim('w-sim-4'))!.sim_cache).toBeNull();
    await cancel(plain.id);
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
    const body = JSON.parse(json.text) as { experiment_title: string; experiment: { id: string; name: string; platform_commit: string }; trials: { status: string; label: string | null; config: { hash: string; settings: unknown }; task: { id: string }; spend: { cost_usd: number | null }; grades: unknown[] }[] };
    expect(body.experiment).toMatchObject({ id: exp.id, platform_commit: 'abc1234' });
    // Not a shipped example: its title is its own name.
    expect(body.experiment_title).toBe(body.experiment.name);
    // The export is in plan order (repeat, task, config); claims went in the seeded order (D32).
    const byStatus = (a: (string | null)[], b: (string | null)[]): number => String(a).localeCompare(String(b));
    expect(body.trials.map((t) => [t.status, t.label]).sort(byStatus)).toEqual([
      ['cancelled', null],
      ['cancelled', null],
      ['done', 'agent'],
      ['infra_failed', 'infra:provider_error'],
    ]);
    expect(body.trials.find((t) => t.status === 'done')).toMatchObject({ config: { hash: configA }, task: { id: 'emi-basic' }, spend: { cost_usd: 0.00136 }, grades: [] });

    const csv = await request(env.http).get(`/api/experiments/${exp.id}/export?format=csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\n');
    expect(lines).toHaveLength(5);
    const header = lines[0].split(',');
    expect(header.slice(0, 3)).toEqual(['experiment_id', 'experiment_title', 'trial_id']);
    const status = header.indexOf('status');
    const label = header.indexOf('label');
    expect(lines.slice(1).map((l) => [l.split(',')[status], l.split(',')[label]]).sort(byStatus)).toEqual([
      ['cancelled', ''],
      ['cancelled', ''],
      ['done', 'agent'],
      ['infra_failed', 'infra:provider_error'],
    ]);
    await request(env.http).get(`/api/experiments/${exp.id}/export?format=xml`).expect(400);
    await request(env.http).get('/api/experiments/e_nope/export').expect(404);
  });

  it('compares per task and arm with stats null until SP6, and lists experiments with counts and spend', async () => {
    const exp = await experiment({ configs: [configA, configB] });
    const ok = (await claim('w-cmp'))!;
    await report(ok, 'w-cmp', 'agent');
    await report((await claim('w-cmp'))!, 'w-cmp', 'infra:budget_net');
    // Claims follow the seeded order (D32), so either arm may have gone first.
    const okConfig = (ok.spec as { trial: { config_hash: string } }).trial.config_hash;
    const okName = okConfig === configA ? 'arm A' : 'arm B';
    const cmp = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as { stats: unknown; rows: { config: string; trials: number; infra_failed: number; graded: number }[] };
    expect(cmp.stats).toBeNull();
    expect(cmp.rows.map((r) => [r.config, r.trials, r.infra_failed, r.graded])).toEqual([
      [configA, okConfig === configA ? 1 : 0, okConfig === configA ? 0 : 1, 0],
      [configB, okConfig === configB ? 1 : 0, okConfig === configB ? 0 : 1, 0],
    ]);
    const list = (await request(env.http).get('/api/experiments').expect(200)).body as { id: string; spend_usd: number; counts: { done: number; queued: number } }[];
    const mine = list.find((e) => e.id === exp.id)!;
    expect(mine.spend_usd).toBeCloseTo(0.00272, 8);
    expect(mine.counts).toMatchObject({ done: 1, queued: 0, infra_failed: 1 }); // D26: a budget stop is never re-queued
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail.status).toBe('done');
    expect(detail.events.some((e) => e.kind === 'budget_trip')).toBe(true);
    expect(detail.events.some((e) => e.kind === 'requeue')).toBe(false);
    const trials = (await request(env.http).get(`/api/experiments/${exp.id}/trials?status=done`).expect(200)).body as { config_name: string }[];
    expect(trials.map((t) => t.config_name)).toEqual([okName]);
    await request(env.http).get(`/api/experiments/${exp.id}/trials?status=bogus`).expect(400);
  });

  it('pauses only the arm on infra:config_error, never re-queues it, and resumes the arm (D26 as amended by D37)', async () => {
    for (const { id } of (await env.pool.query("SELECT id FROM experiments WHERE status IN ('running', 'paused')")).rows as { id: string }[]) await cancel(id);
    const exp = await experiment({ configs: [configA, configB], n: 2 });
    const first = (await claim('w-cfg-1'))!;
    const second = (await claim('w-cfg-2'))!; // still running when the pause comes
    // The unscoped-key 400 exactly as the own loop reported it on 4 Nov.
    const unscoped =
      'Error code: 400 - litellm.BadRequestError: AnthropicException - {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."},"request_id":"req_011CghWkuA86P2P7Ev167Xxo"}. Received Model Group=claude-haiku-5-5\nAvailable Model Group Fallbacks=None';
    const files = await writeFolder(first, 'w-cfg-1');
    const rr = runnerReport(first.trial_id, 1, 'infra:config_error', files);
    rr.proxy_usage = { ...(rr.proxy_usage as Record<string, unknown>), failed_calls: 1, last_status: '400' };
    const result = {
      ...EXAMPLE_RESULT,
      trial_id: first.trial_id,
      end_state: 'harness_error',
      end_detail: { harness_stop_reason: 'model call failed: BadRequestError', exception_type: 'BadRequestError', exception_message: unscoped, last_message_excerpt: null },
      final_answer: null,
    };
    const r1 = (
      await request(env.http)
        .post(`/api/worker/trials/${first.trial_id}/report`)
        .set(auth)
        .send({ worker_id: 'w-cfg-1', attempt: 1, runner_report: rr, result, spans: EXAMPLE_SPANS, files })
        .expect(200)
    ).body as ReportResponse;
    expect(r1).toMatchObject({ status: 'infra_failed', requeued_trial_id: null });

    const badConfig = (first.spec as { trial: { config_hash: string } }).trial.config_hash;
    const goodConfig = badConfig === configA ? configB : configA;
    let detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail.status).toBe('running'); // D37: the experiment goes on
    const bad = detail.arms.find((a) => a.config_hash === badConfig)!;
    expect(bad.status).toBe('paused');
    expect(bad.paused_reason).toMatch(/^emi-basic on arm [AB], attempt 1: infra:config_error \(LiteLLM status 400\): This API key is not scoped to a workspace/);
    expect(bad.fix).toContain('a key or account problem is fixed in LiteLLM');
    expect(detail.arms.find((a) => a.config_hash === goodConfig)!.status).toBe('active');
    const paused = detail.events.find((e) => e.kind === 'arm_paused')!;
    expect(paused).toMatchObject({ trial_id: first.trial_id, config_hash: badConfig, arm: bad.arm, detail: `arm ${bad.arm} paused: ${bad.paused_reason}` });
    expect(detail.events.filter((e) => e.kind === 'config_error').map((e) => e.trial_id)).toEqual([first.trial_id]);

    // The trial already running (the other arm) finishes; its provider error is re-queued once, as always.
    expect((second.spec as { trial: { config_hash: string } }).trial.config_hash).toBe(goodConfig);
    const r2 = await report(second, 'w-cfg-2', 'infra:provider_error');
    expect(r2.requeued_trial_id).toEqual(expect.any(String));
    // Claims go on, from the good arm only: its re-queued attempt and its other slot.
    const claimed = [];
    for (let c = await claim('w-cfg-3'); c; c = await claim('w-cfg-3')) claimed.push(c);
    expect(claimed.map((c) => (c.spec as { trial: { config_hash: string } }).trial.config_hash)).toEqual([goodConfig, goodConfig]);
    for (const c of claimed) await report(c, 'w-cfg-3');

    // Resuming the arm hands out its queued trial.
    detail = (await request(env.http).post(`/api/experiments/${exp.id}/arms/${badConfig}/resume`).expect(200)).body as ExperimentDetail;
    expect(detail.arms.find((a) => a.config_hash === badConfig)).toMatchObject({ status: 'active', paused_reason: null, fix: null });
    expect(detail.events.some((e) => e.kind === 'arm_resumed' && e.config_hash === badConfig)).toBe(true);
    const next = (await claim('w-cfg-3'))!;
    expect((next.spec as { trial: { config_hash: string } }).trial.config_hash).toBe(badConfig);
    // The config error's slot has its one attempt only: never re-queued.
    const all = (await env.pool.query('SELECT id, attempt, label FROM trials WHERE experiment_id = $1 ORDER BY seq, attempt', [exp.id])).rows as { id: string; attempt: number; label: string | null }[];
    expect(all.filter((t) => t.label === 'infra:config_error')).toEqual([{ id: first.trial_id, attempt: 1, label: 'infra:config_error' }]);
    expect(all).toHaveLength(5); // 4 slots, plus attempt 2 of the provider error
    await cancel(exp.id);
  });

  it('a config error on the last trial: the run is done, but compare waits until the arm is resumed', async () => {
    for (const { id } of (await env.pool.query("SELECT id FROM experiments WHERE status IN ('running', 'paused')")).rows as { id: string }[]) await cancel(id);
    const exp = await experiment();
    const c = (await claim('w-cfg-last'))!;
    const files = await writeFolder(c, 'w-cfg-last');
    const rr = runnerReport(c.trial_id, 1, 'infra:config_error', files);
    await request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: 'w-cfg-last', attempt: 1, runner_report: rr, result: null, spans: [], files })
      .expect(200);
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail).toMatchObject({ status: 'done', arms: [{ arm: 'A', status: 'paused' }] });
    const before = (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as { status: string; reason: string; rows: unknown[] };
    expect(before).toMatchObject({ status: 'incomplete', rows: [] });
    expect(before.reason).toMatch(/^arm A is paused: emi-basic on arm A, attempt 1: infra:config_error/);
    await request(env.http).post(`/api/experiments/${exp.id}/arms/A/resume`).expect(200);
    expect((await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body).toMatchObject({ status: 'complete', reason: null });
  });

  it('estimates from earlier finished trials once there are some', async () => {
    // A trial's time is its worker's slot, claim to report (here 20 s), not the agent's own 12.5 s:
    // the slot also covers starting the trial and uploading its files.
    await env.pool.query(
      `UPDATE trials SET claimed_at = finished_at - interval '20 seconds'
       WHERE config_hash = $1 AND task_sha256 = $2 AND status = 'done' AND NOT probe`,
      [configA, cat.tasks['emi-basic']],
    );
    const res = await request(env.http)
      .post('/api/experiments/estimate')
      .send({ config_hashes: [configA], task_sha256s: [cat.tasks['emi-basic']], n: 1 })
      .expect(200);
    const e = res.body as { basis: string; basis_detail: { cells: { source: string; input_tokens: number; wall_s: number; agent_usd_per_trial: number }[] } };
    // LiteLLM's recorded cost of those trials, not tokens at today's price (item 8).
    expect(e.basis_detail.cells[0]).toMatchObject({ source: 'config_task', input_tokens: 1200, wall_s: 20, agent_usd_per_trial: 0.00136 });
    expect(e.basis).toContain('earlier finished trials of the same config and task');
  });

  it('estimates a new config from the same harness and model, and shows the estimate next to actual spend and time (item 8)', async () => {
    const fresh = await makeConfig(env.http, cat, { name: 'never run', settings: { temperature: 1.3 } });
    const res = await request(env.http).post('/api/experiments/estimate').send({ config_hashes: [fresh], task_sha256s: [cat.tasks['emi-basic']], n: 2 }).expect(200);
    const e = res.body as { minutes: number; basis: string; basis_detail: { cells: { source: string; trials_seen: number }[]; workers: Record<string, { live: number; used: number }> } };
    expect(e.basis_detail.cells[0].source).toBe('harness_model');
    expect(e.basis_detail.cells[0].trials_seen).toBeGreaterThan(1);
    expect(e.basis).toContain('of the same harness and model');
    // Every worker id these tests claimed with counts as live: the time divides by them.
    const live = (await env.pool.query("SELECT count(*)::int AS n FROM workers WHERE harness = 'ownloop' AND last_seen_at > now() - interval '60 seconds'")).rows[0] as { n: number };
    expect(live.n).toBeGreaterThan(1);
    expect(e.basis_detail.workers.ownloop).toEqual({ live: live.n, used: live.n });

    for (const { id } of (await env.pool.query("SELECT id FROM experiments WHERE status IN ('running', 'paused')")).rows as { id: string }[]) await cancel(id);
    const exp = await experiment({ configs: [fresh], n: 2 });
    expect((await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body).toMatchObject({ actual: null });
    await report((await claim('w-actual'))!, 'w-actual');
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(detail.estimate.trials).toBe(2);
    expect(detail.actual).toMatchObject({ finished_trials: 1, spend_usd: 0.00136, cost_per_trial_usd: 0.00136, wall_s_per_trial: 12.5, projected_spend_usd: 0.00272 });
    expect(detail.actual!.elapsed_minutes).toEqual(expect.any(Number));
    await cancel(exp.id);
  });

  it('serves a blind label queue of real-model outputs only, and appends labels to labels/<set>.jsonl', async () => {
    // A fake model plays a script: its trials are nothing to label, in any set.
    const fake = await experiment();
    const f = (await claim('w-label'))!;
    expect(f.experiment_id).toBe(fake.id);
    await report(f, 'w-label');
    for (const set of ['tuning', 'heldout', 'final']) {
      expect((await request(env.http).get(`/api/labels/queue?set=${set}&experiment=${fake.id}`).expect(200)).body).toEqual([]);
      const all = (await request(env.http).get(`/api/labels/queue?set=${set}`).expect(200)).body as { item_id: string }[];
      expect(all.map((i) => i.item_id)).not.toContain(f.trial_id);
    }

    const haiku = await makeConfig(env.http, cat, { name: 'labelled arm', model: 'claude-haiku-5-5' });
    const exp = await experiment({ configs: [haiku] });
    const c = (await claim('w-label'))!;
    expect(c.experiment_id).toBe(exp.id);
    await report(c, 'w-label');
    const queue = (await request(env.http).get(`/api/labels/queue?set=tuning&experiment=${exp.id}`).expect(200)).body as Record<string, unknown>[];
    expect(queue).toHaveLength(1);
    const item = queue[0];
    expect(Object.keys(item).sort()).toEqual(['criteria', 'item_id', 'second_look', 'task_summary', 'tool_calls', 'transcript']);
    expect(item.second_look).toBe(false);
    expect(JSON.stringify(item)).not.toMatch(/ownloop|claude-haiku|labelled arm|cost|wall_s/);
    expect(item.criteria).toEqual([
      { id: 'empathy', text: 'Acknowledges the client situation' },
      { id: 'no_jargon', text: 'no_jargon' },
    ]);
    expect((item.tool_calls as { name: string }[])[0].name).toBe('calculate_emi');

    await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'nope', value: 'yes' }).expect(400);
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'empathy', value: 'maybe' }).expect(400);
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'nonsense', criterion: 'empathy', value: 'yes' }).expect(400);
    const created = await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'empathy', value: 'yes', note: 'warm' }).expect(201);
    expect(created.body).toMatchObject({ trial_id: c.trial_id, set: 'tuning', rater: 'rishi', criterion: 'empathy', value: 'yes', note: 'warm' });
    const lines = (await fs.readFile(path.join(env.labelsDir, 'tuning.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ rater: 'rishi', criterion: 'empathy', value: 'yes', labelled_at: expect.any(String) as string });

    const left = (await request(env.http).get(`/api/labels/queue?set=tuning&experiment=${exp.id}`).expect(200)).body as { criteria: { id: string }[] }[];
    expect(left[0].criteria.map((x) => x.id)).toEqual(['no_jargon']);
    // D71: `items` limits the queue to listed trials (a judge panel's disagreements); an unlisted
    // or unknown id is simply not offered, and a malformed list is refused.
    const listed = (await request(env.http).get(`/api/labels/queue?set=tuning&items=${c.trial_id},t_not_a_trial`).expect(200)).body as { item_id: string }[];
    expect(listed.map((x) => x.item_id)).toEqual([c.trial_id]);
    expect((await request(env.http).get('/api/labels/queue?set=tuning&items=t_not_a_trial').expect(200)).body).toEqual([]);
    const bad = await request(env.http).get(`/api/labels/queue?set=tuning&items=${encodeURIComponent("t_x' OR 1=1")}`).expect(400);
    expect(bad.body).toMatchObject({ error: 'invalid_items' });
    // The sets follow the task split (D52): emi-basic is a discovery task, so its trials are tuning
    // material only, never held-out or final, and a held-out label on one is refused.
    expect((await request(env.http).get(`/api/labels/queue?set=heldout&experiment=${exp.id}`).expect(200)).body).toHaveLength(0);
    expect((await request(env.http).get(`/api/labels/queue?set=final&experiment=${exp.id}`).expect(200)).body).toHaveLength(0);
    const wrong = await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'heldout', criterion: 'empathy', value: 'yes' }).expect(400);
    expect(wrong.body).toMatchObject({ error: 'wrong_split' });
    const agreement = await request(env.http).get('/api/judge/agreement?set=heldout').expect(200);
    expect(agreement.text).toBe('null');

    // D46: "unsure" comes back once, after the fresh items, for a firm answer.
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'empathy', value: 'yes', second_look: true }).expect(400); // already firm
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'no_jargon', value: 'yes', second_look: true }).expect(400); // never marked unsure
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'no_jargon', value: 'unsure' }).expect(201);
    const again = (await request(env.http).get(`/api/labels/queue?set=tuning&experiment=${exp.id}`).expect(200)).body as { item_id: string; second_look: boolean; criteria: { id: string }[] }[];
    expect(again).toEqual([expect.objectContaining({ item_id: item.item_id, second_look: true, criteria: [{ id: 'no_jargon', text: 'no_jargon' }] })]);
    const firm = await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'no_jargon', value: 'no', second_look: true }).expect(201);
    expect(firm.body).toMatchObject({ criterion: 'no_jargon', value: 'no', second_look: true });
    expect(JSON.parse((await fs.readFile(path.join(env.labelsDir, 'tuning.jsonl'), 'utf8')).trim().split('\n').at(-1)!)).toMatchObject({ value: 'no', second_look: true });
    // Only once: no third look, and a second second-look is refused.
    expect((await request(env.http).get(`/api/labels/queue?set=tuning&experiment=${exp.id}`).expect(200)).body).toEqual([]);
    await request(env.http).post('/api/labels').send({ item_id: item.item_id, rater: 'rishi', set: 'tuning', criterion: 'no_jargon', value: 'yes', second_look: true }).expect(400);
  });

  it('labels by the task split in tasks/ today, so a trial of a task moved to held-out is never tuning material (D52)', async () => {
    const haiku = await makeConfig(env.http, cat, { name: 'split arm', model: 'claude-haiku-5-5' });
    const exp = await experiment({ configs: [haiku] });
    const c = (await claim('w-split'))!;
    await report(c, 'w-split');
    const queue = async (set: string) => (await request(env.http).get(`/api/labels/queue?set=${set}&experiment=${exp.id}`).expect(200)).body as { item_id: string }[];
    expect((await queue('tuning')).map((i) => i.item_id)).toEqual([c.trial_id]);
    // The task file moves to held-out as a new version; the trial keeps the version it ran on.
    const file = path.join(env.tasksDir, 'emi-basic', 'task.json');
    const before = await fs.readFile(file, 'utf8');
    try {
      await fs.writeFile(file, JSON.stringify({ ...(JSON.parse(before) as object), version: '2', split: 'held_out' }, null, 2));
      expect(await queue('tuning')).toEqual([]);
      expect((await queue('heldout')).map((i) => i.item_id)).toEqual([c.trial_id]);
      const refused = await request(env.http).post('/api/labels').send({ item_id: c.trial_id, rater: 'rishi', set: 'tuning', criterion: 'empathy', value: 'yes' }).expect(400);
      expect(refused.body).toMatchObject({ error: 'wrong_split' });
    } finally {
      await fs.writeFile(file, before);
    }
    expect((await queue('tuning')).map((i) => i.item_id)).toEqual([c.trial_id]);
  });

  // ---- D73: more than one human rater. The labels below are synthetic, in the test's own labels dir. ----

  /** A new experiment on a real model, its one emi-basic trial (criteria empathy and no_jargon) reported: one item to label. */
  async function labelItem(worker: string): Promise<{ expId: string; trial: string }> {
    for (const { id } of (await env.pool.query("SELECT id FROM experiments WHERE status IN ('running', 'paused')")).rows as { id: string }[]) await cancel(id);
    const haiku = await makeConfig(env.http, cat, { name: `rater arm ${worker}`, model: 'claude-haiku-5-5' });
    const exp = await experiment({ configs: [haiku] });
    const c = (await claim(worker))!;
    expect(c.experiment_id).toBe(exp.id);
    await report(c, worker);
    return { expId: exp.id, trial: c.trial_id };
  }
  /** One rater's queue for one experiment as [item, criteria, second look]; no rater gives the queue as before D73. */
  const raterQueue = async (expId: string, rater: string | null, set = 'tuning'): Promise<[string, string[], boolean][]> =>
    ((await request(env.http).get(`/api/labels/queue?set=${set}&experiment=${expId}${rater === null ? '' : `&rater=${rater}`}`).expect(200)).body as LabelQueueItem[]).map((i) => [
      i.item_id,
      i.criteria.map((x) => x.id),
      i.second_look,
    ]);
  const saveLabel = (body: Record<string, unknown>) => request(env.http).post('/api/labels').send({ set: 'tuning', ...body });
  const lastLine = async (set = 'tuning'): Promise<Record<string, unknown>> =>
    JSON.parse((await fs.readFile(path.join(env.labelsDir, `${set}.jsonl`), 'utf8')).trim().split('\n').at(-1)!) as Record<string, unknown>;

  it('refuses a label without a rater id, or with one that is not lower-case letters, digits, dash or underscore, 1 to 40 long (D73)', async () => {
    const { expId, trial } = await labelItem('w-rater-id');
    const file = path.join(env.labelsDir, 'tuning.jsonl');
    const before = await fs.readFile(file, 'utf8');
    const ok = { item_id: trial, criterion: 'empathy', value: 'yes' };
    const missing = await saveLabel(ok).expect(400);
    expect(missing.body).toMatchObject({ error: 'invalid_rater', message: expect.stringContaining('rater is required') as string, fix: expect.stringContaining('1 to 40') as string });
    for (const rater of ['', 'Rishi', 'a b', 'rater.one', 'é', 'a'.repeat(41), 42, null, ['a']]) {
      const res = await saveLabel({ ...ok, rater }).expect(400);
      expect(res.body).toMatchObject({ error: 'invalid_rater', fix: expect.any(String) as string });
    }
    // A refused label writes nothing.
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await raterQueue(expId, null)).toEqual([[trial, ['empathy', 'no_jargon'], false]]);
    // The longest id, and each of the allowed characters.
    for (const rater of ['a'.repeat(40), 'r-2_x']) {
      const res = await saveLabel({ ...ok, rater }).expect(201);
      expect(res.body).toMatchObject({ rater, criterion: 'empathy', value: 'yes' });
    }
    // The queue takes the same ids, and refuses a malformed one rather than ignore it.
    for (const rater of ['', 'Rishi', 'a'.repeat(41), `x${encodeURIComponent("' OR 1=1")}`]) {
      const res = await request(env.http).get(`/api/labels/queue?set=tuning&experiment=${expId}&rater=${rater}`).expect(400);
      expect(res.body).toMatchObject({ error: 'invalid_rater' });
    }
  });

  it('gives each rater their own queue: a criterion one rater answered stays in every other rater’s until they answer it (D73)', async () => {
    const { expId, trial } = await labelItem('w-raters');
    const both: [string, string[], boolean][] = [[trial, ['empathy', 'no_jargon'], false]];
    expect(await raterQueue(expId, 'rater-a')).toEqual(both);
    expect(await raterQueue(expId, 'rater_b')).toEqual(both);

    const a = await saveLabel({ item_id: trial, rater: 'rater-a', criterion: 'empathy', value: 'yes', note: 'warm' }).expect(201);
    expect(a.body).toMatchObject({ trial_id: trial, set: 'tuning', rater: 'rater-a', criterion: 'empathy', value: 'yes', note: 'warm' });
    // The line in labels/tuning.jsonl carries the rater, and so does the imported row.
    expect(await lastLine()).toMatchObject({ trial_id: trial, set: 'tuning', rater: 'rater-a', criterion: 'empathy', value: 'yes', labelled_at: expect.any(String) as string });
    expect((await env.pool.query('SELECT rater, criterion, value FROM labels WHERE trial_id = $1', [trial])).rows).toEqual([{ rater: 'rater-a', criterion: 'empathy', value: 'yes' }]);

    expect(await raterQueue(expId, 'rater-a')).toEqual([[trial, ['no_jargon'], false]]);
    expect(await raterQueue(expId, 'rater_b')).toEqual(both);
    // Without a rater, any rater's label counts, as before D73.
    expect(await raterQueue(expId, null)).toEqual([[trial, ['no_jargon'], false]]);

    // The other rater answers the same criterion their own way; neither answer touches the other's queue.
    await saveLabel({ item_id: trial, rater: 'rater_b', criterion: 'empathy', value: 'no' }).expect(201);
    expect(await lastLine()).toMatchObject({ rater: 'rater_b', criterion: 'empathy', value: 'no' });
    expect(await raterQueue(expId, 'rater_b')).toEqual([[trial, ['no_jargon'], false]]);
    await saveLabel({ item_id: trial, rater: 'rater-a', criterion: 'no_jargon', value: 'no' }).expect(201);
    expect(await raterQueue(expId, 'rater-a')).toEqual([]);
    expect(await raterQueue(expId, 'rater_b')).toEqual([[trial, ['no_jargon'], false]]);
    expect(await raterQueue(expId, null)).toEqual([]);
    // A rater with no labels yet sees the whole item.
    expect(await raterQueue(expId, 'rater-c')).toEqual(both);
    await saveLabel({ item_id: trial, rater: 'rater_b', criterion: 'no_jargon', value: 'yes' }).expect(201);
    expect(await raterQueue(expId, 'rater_b')).toEqual([]);
  });

  it('gives each rater their own second look at what they marked "not sure" (D46, D73)', async () => {
    const { expId, trial } = await labelItem('w-raters-2nd');
    // rater-a and rater_b are unsure on empathy; rater-c is firm on it. All three are firm on no_jargon.
    for (const [rater, empathy] of [['rater-a', 'unsure'], ['rater_b', 'unsure'], ['rater-c', 'yes']]) {
      await saveLabel({ item_id: trial, rater, criterion: 'empathy', value: empathy }).expect(201);
      await saveLabel({ item_id: trial, rater, criterion: 'no_jargon', value: 'yes' }).expect(201);
    }
    const look: [string, string[], boolean][] = [[trial, ['empathy'], true]];
    expect(await raterQueue(expId, 'rater-a')).toEqual(look);
    expect(await raterQueue(expId, 'rater_b')).toEqual(look);
    expect(await raterQueue(expId, 'rater-c')).toEqual([]);
    // Another rater's "not sure" is not this rater's: rater-c has nothing to look at again.
    const refused = await saveLabel({ item_id: trial, rater: 'rater-c', criterion: 'empathy', value: 'no', second_look: true }).expect(400);
    expect(refused.body).toMatchObject({ error: 'not_a_second_look' });
    // One rater's second look settles their own "not sure" only.
    const firm = await saveLabel({ item_id: trial, rater: 'rater-a', criterion: 'empathy', value: 'no', second_look: true }).expect(201);
    expect(firm.body).toMatchObject({ rater: 'rater-a', criterion: 'empathy', value: 'no', second_look: true });
    expect(await lastLine()).toMatchObject({ rater: 'rater-a', criterion: 'empathy', value: 'no', second_look: true });
    expect(await raterQueue(expId, 'rater-a')).toEqual([]);
    expect(await raterQueue(expId, 'rater_b')).toEqual(look);
    await saveLabel({ item_id: trial, rater: 'rater-a', criterion: 'empathy', value: 'yes', second_look: true }).expect(400);
    await saveLabel({ item_id: trial, rater: 'rater_b', criterion: 'empathy', value: 'unsure', second_look: true }).expect(201);
    expect(await raterQueue(expId, 'rater_b')).toEqual([]);
  });

  it('reads a label line without a rater as Rishi’s, written before D73, and skips one whose rater is malformed', async () => {
    const { expId, trial } = await labelItem('w-raters-old');
    const file = path.join(env.labelsDir, 'tuning.jsonl');
    // Two synthetic lines in the pre-D73 shape: no rater field.
    const old = { item_id: trial, trial_id: trial, set: 'tuning', note: null, labelled_at: '2026-11-04T10:00:00.000Z' };
    await fs.appendFile(file, `${JSON.stringify({ ...old, criterion: 'empathy', value: 'no' })}\n${JSON.stringify({ ...old, criterion: 'no_jargon', value: 'unsure' })}\n`);
    // A line naming a rater that is not a rater id is not anyone's.
    await fs.appendFile(file, `${JSON.stringify({ ...old, criterion: 'no_jargon', value: 'yes', rater: 'Not A Rater' })}\n`);
    // Rishi's queue: empathy is answered and no_jargon, "not sure" before D73, comes back for his second look.
    expect(await raterQueue(expId, 'rishi')).toEqual([[trial, ['no_jargon'], true]]);
    expect(await raterQueue(expId, 'rater-a')).toEqual([[trial, ['empathy', 'no_jargon'], false]]);
    expect((await env.pool.query('SELECT rater, criterion, value FROM labels WHERE trial_id = $1 ORDER BY criterion', [trial])).rows).toEqual([
      { rater: 'rishi', criterion: 'empathy', value: 'no' },
      { rater: 'rishi', criterion: 'no_jargon', value: 'unsure' },
    ]);
    // Only Rishi can answer that second look; another rater cannot.
    await saveLabel({ item_id: trial, rater: 'rater-a', criterion: 'no_jargon', value: 'yes', second_look: true }).expect(400);
    await saveLabel({ item_id: trial, rater: 'rishi', criterion: 'no_jargon', value: 'yes', second_look: true }).expect(201);
    expect(await lastLine()).toMatchObject({ rater: 'rishi', criterion: 'no_jargon', value: 'yes', second_look: true });
    expect(await raterQueue(expId, 'rishi')).toEqual([]);
  });

  it('keeps the sets apart across raters: a trial one rater labelled in held-out is in no rater’s final queue (D52, D73)', async () => {
    const { expId, trial } = await labelItem('w-raters-sets');
    const file = path.join(env.tasksDir, 'emi-basic', 'task.json');
    const before = await fs.readFile(file, 'utf8');
    try {
      await fs.writeFile(file, JSON.stringify({ ...(JSON.parse(before) as object), version: '2', split: 'held_out' }, null, 2));
      const fresh: [string, string[], boolean][] = [[trial, ['empathy', 'no_jargon'], false]];
      expect(await raterQueue(expId, 'rater_b', 'final')).toEqual(fresh);
      await saveLabel({ item_id: trial, set: 'heldout', rater: 'rater-a', criterion: 'empathy', value: 'yes' }).expect(201);
      expect(await lastLine('heldout')).toMatchObject({ set: 'heldout', rater: 'rater-a', criterion: 'empathy' });
      expect(await raterQueue(expId, 'rater-a', 'final')).toEqual([]);
      expect(await raterQueue(expId, 'rater_b', 'final')).toEqual([]);
      expect(await raterQueue(expId, 'rater_b', 'heldout')).toEqual(fresh);
      expect(await raterQueue(expId, 'rater-a', 'heldout')).toEqual([[trial, ['no_jargon'], false]]);
    } finally {
      await fs.writeFile(file, before);
    }
  });

  it('takes a label only for a trial the queue could offer: no fake model, probe, shipped example or other set (E11)', async () => {
    const lines = async (): Promise<number> => (await fs.readFile(path.join(env.labelsDir, 'tuning.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const ok = { rater: 'rishi', criterion: 'empathy', value: 'yes' };
    // A fake model's trial plays a script: never in the queue, and now never labelled.
    for (const { id } of (await env.pool.query("SELECT id FROM experiments WHERE status IN ('running', 'paused')")).rows as { id: string }[]) await cancel(id);
    await experiment();
    const f = (await claim('w-e11-fake'))!;
    await report(f, 'w-e11-fake');
    const before = await lines();
    const fake = await saveLabel({ ...ok, item_id: f.trial_id }).expect(400);
    expect(fake.body).toMatchObject({ error: 'not_labellable', message: expect.stringContaining('fake model') as string, fix: expect.stringContaining('GET /labels/queue') as string });

    // A real-model trial is labellable, until it is a probe's or a shipped example's.
    const { expId, trial } = await labelItem('w-e11');
    // (A probe has no experiment: the row is made one for the moment.)
    await env.pool.query('UPDATE trials SET probe = true, experiment_id = NULL WHERE id = $1', [trial]);
    expect((await saveLabel({ ...ok, item_id: trial }).expect(400)).body).toMatchObject({ error: 'not_labellable', message: expect.stringContaining('probe') as string });
    await env.pool.query('UPDATE trials SET probe = false, experiment_id = $2 WHERE id = $1', [trial, expId]);
    await env.pool.query(`UPDATE experiments SET example_name = 'e11-example' WHERE id = $1`, [expId]);
    expect((await saveLabel({ ...ok, item_id: trial }).expect(400)).body).toMatchObject({ error: 'not_labellable', message: expect.stringContaining('shipped example') as string });
    await env.pool.query('UPDATE experiments SET example_name = NULL WHERE id = $1', [expId]);
    expect(await lines()).toBe(before);

    // D52: a trial labelled in one set is labelled in no other, by anyone.
    const file = path.join(env.tasksDir, 'emi-basic', 'task.json');
    const task = await fs.readFile(file, 'utf8');
    try {
      await fs.writeFile(file, JSON.stringify({ ...(JSON.parse(task) as object), version: '2', split: 'held_out' }, null, 2));
      await saveLabel({ ...ok, item_id: trial, set: 'heldout' }).expect(201);
      const other = await saveLabel({ ...ok, item_id: trial, set: 'final', rater: 'rater-b' }).expect(400);
      expect(other.body).toMatchObject({ error: 'wrong_set', message: expect.stringContaining('already has labels in the heldout set') as string });
      await saveLabel({ ...ok, item_id: trial, set: 'heldout', criterion: 'no_jargon' }).expect(201);
    } finally {
      await fs.writeFile(file, task);
    }
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
