import Ajv2020 from 'ajv/dist/2020';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import type { ClaimResponse, ConflictCheckView, RenderedPromptView, SpendView, SystemSpendRow, TrialView } from '../src/contract';
import { PreflightService } from '../src/preflight/preflight.service';
import { REPO, type TestEnv, auth, bootEnv, catalogue, makeConfig, runnerReport } from './support/app';
import { describeWithDb } from './support/db';

/**
 * D33 and D38 end to end: a probe trial through the worker protocol gives the rendered prompt; the
 * conflict check calls the checker model once through a key the API mints, records the spend, and
 * is cached; the allowance refuses a check that could pass it; spend splits trials from system
 * calls. LiteLLM is the stub: no real model is called.
 */

const validateSpec = new Ajv2020({ allErrors: true, strict: false }).compile(
  JSON.parse(readFileSync(path.join(REPO, 'contract/v2/spec.schema.json'), 'utf8')) as object,
);
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const FINDINGS = {
  conflicts: [
    {
      harness_says: 'a one-line question gets a one-line answer',
      we_say: 'Stay under about 250 words unless the client asks for detail.',
      why_it_matters: 'Replies may come out shorter than the task prompt asks for.',
      severity: 'high',
    },
  ],
  notes: 'One clear clash on length.',
};

describeWithDb('pre-run rendered prompt, conflict check and spend (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;
  let ourPrompt: string;
  let checkerPrompt: string;
  let hermes: string;
  let ownloop: string;

  beforeAll(async () => {
    env = await bootEnv();
    cat = await catalogue(env.http);
    const prompts = (await request(env.http).get('/api/prompts').expect(200)).body as { id: string; version: string; sha256: string; text: string }[];
    ourPrompt = prompts.find((p) => p.sha256 === cat.prompt)!.text;
    checkerPrompt = prompts.find((p) => p.id === 'conflict-check' && p.version === 'v1')!.text;
    hermes = await makeConfig(env.http, cat, { name: 'hermes base', harness: 'hermes' });
    ownloop = await makeConfig(env.http, cat, { name: 'own loop base', harness: 'ownloop' });
    // Keep a missing spend-log row from slowing the suite; the stub logs every call at once.
    env.app.get(PreflightService).spendLogWaitMs = 200;
  });

  afterAll(async () => {
    await env.close();
  });

  // ---- helpers ----

  const rendered = (hash: string, method: 'post' | 'get' = 'post') => request(env.http)[method](`/api/configs/${hash}/rendered-prompt`);
  const check = (hash: string, method: 'post' | 'get' = 'post') => request(env.http)[method](`/api/configs/${hash}/conflict-check`);

  async function claim(worker: string, harness: string): Promise<ClaimResponse | null> {
    const res = await request(env.http).post('/api/worker/claim').set(auth).send({ worker_id: worker, harness });
    if (res.status === 204) return null;
    if (res.status !== 200) throw new Error(`claim: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ClaimResponse;
  }

  /** Uploads `files` the way the worker does, then reports the attempt with `label`. */
  async function finish(c: ClaimResponse, worker: string, label: string, files: Record<string, string>): Promise<void> {
    const manifest = [];
    for (const [rel, text] of Object.entries(files)) {
      const res = await request(env.http)
        .put(`/api/worker/trials/${c.trial_id}/files/${rel}?worker_id=${worker}&attempt=${c.attempt}`)
        .set(auth)
        .set('Content-Type', 'application/octet-stream')
        .set('X-Content-Sha256', sha(text))
        .send(Buffer.from(text));
      expect([200, 201]).toContain(res.status);
      manifest.push({ path: rel, bytes: Buffer.byteLength(text), sha256: sha(text) });
    }
    await request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: worker, attempt: c.attempt, runner_report: runnerReport(c.trial_id, c.attempt, label, manifest), result: null, spans: [], files: manifest })
      .expect(200);
  }

  /** The first request a harness would send: its own text around ours, as LiteLLM stored it. */
  function firstRequest(system: string): string {
    return JSON.stringify({
      model: 'fake/finance-emi',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'What is my EMI on Rs 10 lakh at 9% for 20 years?' },
      ],
      tools: [{ type: 'function', function: { name: 'mcp__finance__calculate_emi' } }],
      parallel_tool_calls: false,
    });
  }

  const hermesSystem = (): string =>
    'You are Hermes Agent. Be direct: a one-line question gets a one-line answer.\n\n' +
    ourPrompt +
    '\nActive Hermes profile: default.\n\nConversation started: Wednesday, November 04, 2026 (UTC, UTC+00:00)\nModel: fake/finance-emi\nProvider: custom';

  /** Runs a config's probe through the worker protocol and returns its rendered prompt. */
  async function render(hash: string, harness: string, system: string): Promise<RenderedPromptView> {
    const started = (await rendered(hash).expect(202)).body as RenderedPromptView;
    const c = (await claim(`w-probe-${harness}`, harness))!;
    expect(c.trial_id).toBe(started.probe!.trial_id);
    await finish(c, `w-probe-${harness}`, 'agent', { 'artifacts/proxy/0001.request.json': firstRequest(system) });
    return (await rendered(hash).expect(200)).body as RenderedPromptView;
  }

  const spendRows = async (): Promise<SystemSpendRow[]> => (await request(env.http).get('/api/spend/system?kind=conflict_check').expect(200)).body as SystemSpendRow[];

  // ---- tests ----

  it('runs a probe trial on the fake model ahead of queued experiment trials, and reads the rendered prompt from it', async () => {
    // An experiment on the same harness is running with a trial queued: the probe still goes first.
    const exp = (
      await request(env.http)
        .post('/api/experiments')
        .send({ name: 'busy', axis: 'none', config_hashes: [hermes], task_sha256s: [cat.tasks['emi-basic']], n: 1, budget_usd: 5 })
        .expect(201)
    ).body as { id: string };
    await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200);

    expect(((await rendered(hermes, 'get').expect(200)).body as RenderedPromptView).status).toBe('none');
    const started = (await rendered(hermes).expect(202)).body as RenderedPromptView;
    expect(started).toMatchObject({ status: 'queued', cached: false, rendered: null, probe: { status: 'queued', model: 'fake/finance-emi' } });
    // A second click queues no second probe.
    const again = (await rendered(hermes).expect(202)).body as RenderedPromptView;
    expect(again.probe!.trial_id).toBe(started.probe!.trial_id);

    const c = (await claim('w-hermes', 'hermes'))!;
    expect(c.trial_id).toBe(started.probe!.trial_id);
    expect(c).toMatchObject({ experiment_id: null, folder: `probes/${c.trial_id}/attempt-1`, budgets: { trial_usd: 0.5, sim_usd: 0 }, sim_cache: null });
    expect(validateSpec(c.spec)).toBe(true);
    const spec = c.spec as { trial: Record<string, unknown>; model: { name: string }; system_prompt: { text: string }; task: { messages: unknown[] } };
    expect(spec.trial).toMatchObject({ experiment_id: null, config_hash: hermes, task_id: 'prompt-probe', task_split: null });
    expect(spec.model.name).toBe('fake/finance-emi');
    expect(spec.system_prompt.text).toBe(ourPrompt);
    const key = env.stub.liveKeys().find((k) => k.key === c.keys.model)!;
    expect(key).toMatchObject({ models: ['fake/finance-emi'], max_budget: 0.5, team_id: null });
    expect(key.metadata).toMatchObject({ trial_id: c.trial_id, experiment_id: null, probe: true });
    expect(((await rendered(hermes, 'get').expect(200)).body as RenderedPromptView).status).toBe('running');

    await finish(c, 'w-hermes', 'agent', { 'artifacts/proxy/0001.request.json': firstRequest(hermesSystem()) });
    expect(env.stub.deleted).toContain(key.token);

    const view = (await rendered(hermes).expect(200)).body as RenderedPromptView;
    expect(view).toMatchObject({ status: 'ready', cached: false, error: null, probe: { trial_id: c.trial_id, status: 'done', label: 'agent' } });
    const r = view.rendered!;
    expect(r.system_text.slice(r.ours!.start, r.ours!.end)).toBe(ourPrompt);
    expect(r.harness_text).toContain('one-line answer.\n\n<<OUR TASK PROMPT>>\nActive Hermes profile');
    expect(r.harness_text).not.toContain('250 words');
    expect(r.system_text).toContain('Conversation started: <date>\nModel: <model>');
    expect(r.tools).toEqual(['mcp__finance__calculate_emi']);
    expect(r.trial_id).toBe(c.trial_id);

    // Cached by config hash: nothing runs again.
    const cached = (await rendered(hermes).expect(200)).body as RenderedPromptView;
    expect(cached).toMatchObject({ status: 'ready', cached: true });
    expect(cached.rendered!.sha256).toBe(r.sha256);

    // The probe is visible as a trial, marked, outside any experiment; the experiment's own trial is untouched.
    const trial = (await request(env.http).get(`/api/trials/${c.trial_id}`).expect(200)).body as TrialView;
    expect(trial).toMatchObject({ probe: true, experiment_id: null, task: { id: 'prompt-probe' } });
    const detail = (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).body as { counts: { queued: number; done: number } };
    expect(detail.counts).toMatchObject({ queued: 1, done: 0 });
    // The prompt-probe task is not in the task catalogue.
    const tasks = (await request(env.http).get('/api/tasks').expect(200)).body as { id: string }[];
    expect(tasks.map((t) => t.id)).not.toContain('prompt-probe');
    await request(env.http).post(`/api/experiments/${exp.id}/cancel`).expect(200);
  });

  it('says why a probe gave no prompt, never re-queues it, and probes again on the next POST', async () => {
    const cfg = await makeConfig(env.http, cat, { name: 'hermes fails', harness: 'hermes', settings: { max_steps: 7 } });
    const first = (await rendered(cfg).expect(202)).body as RenderedPromptView;
    const c = (await claim('w-fail', 'hermes'))!;
    await finish(c, 'w-fail', 'infra:adapter_crash', { 'stdout.log': 'crashed before the first call' });
    expect(await claim('w-fail', 'hermes')).toBeNull(); // not re-queued (D16 is for experiment slots)

    const failed = (await rendered(cfg, 'get').expect(200)).body as RenderedPromptView;
    expect(failed).toMatchObject({ status: 'failed', rendered: null, probe: { trial_id: first.probe!.trial_id, status: 'infra_failed' } });
    expect(failed.error).toContain('never reached the model');

    const retry = (await rendered(cfg).expect(202)).body as RenderedPromptView;
    expect(retry.probe!.trial_id).not.toBe(first.probe!.trial_id);
    const c2 = (await claim('w-fail', 'hermes'))!;
    await finish(c2, 'w-fail', 'agent', { 'artifacts/proxy/0001.request.json': firstRequest(hermesSystem()) });
    expect(((await rendered(cfg).expect(200)).body as RenderedPromptView).status).toBe('ready');
  });

  it('refuses a conflict check before the rendered prompt exists', async () => {
    const cfg = await makeConfig(env.http, cat, { name: 'never probed', harness: 'hermes', settings: { max_steps: 9 } });
    expect((await check(cfg).expect(409)).body).toMatchObject({ error: 'rendered_prompt_required' });
    expect(env.stub.chatCalls).toHaveLength(0);
  });

  it('skips the call when the harness adds no text of its own', async () => {
    const view = await render(ownloop, 'ownloop', ourPrompt);
    expect(view.rendered!.harness_text).toBe('<<OUR TASK PROMPT>>');
    const res = (await check(ownloop).expect(200)).body as ConflictCheckView;
    expect(res).toMatchObject({ skipped: 'no_harness_text', conflicts: [], cost_usd: 0, cached: false, spend_id: null });
    expect(env.stub.chatCalls).toHaveLength(0);
  });

  it('calls the checker once through a minted key, records the cost from the spend log, and serves the cache without a second call', async () => {
    env.stub.chatReply = JSON.stringify(FINDINGS);
    await check(hermes, 'get').expect(404);
    const res = (await check(hermes).expect(200)).body as ConflictCheckView;
    expect(res).toMatchObject({
      config_hash: hermes,
      checker: { id: 'conflict-check', version: 'v1' },
      model: 'claude-sonnet-5-5',
      conflicts: FINDINGS.conflicts,
      notes: FINDINGS.notes,
      cost_usd: 0.0123,
      cached: false,
      skipped: null,
      allowance: { kind: 'conflict_check', limit_usd: 2, used_usd: 0.0123, calls: 1, half_reached: false },
    });

    // The call: Sonnet 5.5, max_tokens 6000, no temperature, no thinking setting, our checker prompt.
    expect(env.stub.chatCalls).toHaveLength(1);
    const call = env.stub.chatCalls[0];
    expect(call.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 6000 });
    expect(Object.keys(call.body).sort()).toEqual(['max_tokens', 'messages', 'model']);
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: 'system', content: checkerPrompt });
    expect(messages[1].content).toContain('<harness_text>\nYou are Hermes Agent.');
    expect(messages[1].content).toContain('<<OUR TASK PROMPT>>');
    expect(messages[1].content).toContain(`<task_prompt>\n${ourPrompt.trim()}\n</task_prompt>`);
    expect(messages[1].content).toContain('"parallel_tool_calls": false');
    // With a key the API minted for this one call, limited to the model, $0.10, then revoked.
    const key = [...env.stub.keys.values()].find((k) => k.key === call.key)!;
    expect(key).toMatchObject({ models: ['claude-sonnet-5-5'], max_budget: 0.1 });
    expect(key.key_alias).toBe(`system:conflict_check:${res.spend_id}`);
    expect(env.stub.deleted).toContain(key.token);
    expect(call.key).not.toContain('master');

    const [row] = await spendRows();
    expect(row).toMatchObject({ id: res.spend_id, kind: 'conflict_check', model: 'claude-sonnet-5-5', status: 'done', cost_usd: 0.0123, cost_source: 'spend_log', input_tokens: 3000, output_tokens: 400, ref: `config:${hermes}` });

    // The same prompt never pays twice.
    const cached = (await check(hermes).expect(200)).body as ConflictCheckView;
    expect(cached).toMatchObject({ cached: true, cost_usd: 0.0123, spend_id: res.spend_id, conflicts: FINDINGS.conflicts });
    expect(((await check(hermes, 'get').expect(200)).body as ConflictCheckView).cached).toBe(true);
    expect(env.stub.chatCalls).toHaveLength(1);
    expect(await spendRows()).toHaveLength(1);
  });

  it('records a reply it cannot use as spend, caches nothing, and two clicks at once pay once', async () => {
    const cfg = await makeConfig(env.http, cat, { name: 'hermes bad reply', harness: 'hermes', settings: { max_steps: 11 } });
    await render(cfg, 'hermes', hermesSystem());
    const calls = env.stub.chatCalls.length;
    env.stub.chatReply = 'Sure! I found one conflict: the harness wants short answers.';
    const bad = await check(cfg).expect(502);
    expect(bad.body).toMatchObject({ error: 'checker_output_invalid' });
    const [failed] = await spendRows();
    expect(failed).toMatchObject({ status: 'failed', cost_usd: 0.0123, cost_source: 'spend_log', ref: `config:${cfg}` });
    expect(failed.error).toContain('not a JSON object');
    await check(cfg, 'get').expect(404);

    env.stub.chatReply = JSON.stringify(FINDINGS);
    const [a, b] = await Promise.all([check(cfg), check(cfg)]);
    expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([200]));
    for (const r of [a, b]) {
      if (r.status === 409) expect(r.body).toMatchObject({ error: 'conflict_check_busy' });
      else expect(r.status).toBe(200);
    }
    expect(env.stub.chatCalls.length).toBe(calls + 2); // the bad reply, then one good call
  });

  it('refuses with 402 allowance_exhausted when a check could pass the allowance, and makes no call', async () => {
    const cfg = await makeConfig(env.http, cat, { name: 'hermes over budget', harness: 'hermes', settings: { max_steps: 13 } });
    await render(cfg, 'hermes', hermesSystem());
    const before = (await request(env.http).get('/api/spend').expect(200)).body as SpendView;
    const used = before.allowances[0].used_usd;
    // Earlier checks used most of the $2: leave $0.01, less than one check's worst case (about $0.03).
    await env.pool.query(
      `INSERT INTO system_spend (id, kind, model, status, reserved_usd, cost_usd, cost_source, ref, settled_at)
       VALUES ('ss_test_filler', 'conflict_check', 'claude-sonnet-5-5', 'done', $1, $1, 'spend_log', 'test filler (synthetic)', now())`,
      [Math.round((2 - used - 0.01) * 1e8) / 1e8],
    );
    const calls = env.stub.chatCalls.length;
    const keys = env.stub.keys.size;
    const res = await check(cfg).expect(402);
    expect(res.body).toMatchObject({ error: 'allowance_exhausted' });
    expect((res.body as { message: string }).message).toContain('$2');
    expect(env.stub.chatCalls.length).toBe(calls);
    expect(env.stub.keys.size).toBe(keys); // no key minted
    expect((await spendRows()).filter((r) => r.status === 'pending')).toHaveLength(0);
    // A cached result still comes back: it costs nothing.
    expect(((await check(hermes).expect(200)).body as ConflictCheckView).cached).toBe(true);
  });

  it('splits spend into experiment trials and system calls, leaving probes out, and fake models’ made-up prices apart', async () => {
    const runOne = async (config: string, name: string): Promise<string> => {
      const exp = (
        await request(env.http)
          .post('/api/experiments')
          .send({ name, axis: 'none', config_hashes: [config], task_sha256s: [cat.tasks['emi-basic']], n: 1, budget_usd: 5 })
          .expect(201)
      ).body as { id: string };
      await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200);
      const c = (await claim(`w-${name}`, 'ownloop'))!;
      expect(c.experiment_id).toBe(exp.id);
      await finish(c, `w-${name}`, 'agent', { 'artifacts/proxy/0001.request.json': firstRequest(ourPrompt) });
      return c.trial_id;
    };
    // The own-loop config runs on fake/finance-emi: its cost is a made-up price, not money.
    const fakeTrial = await runOne(ownloop, 'fake');
    const haiku = await makeConfig(env.http, cat, { name: 'own loop on haiku', harness: 'ownloop', model: 'claude-haiku-5-5' });
    const realTrial = await runOne(haiku, 'real');

    const probes = (await env.pool.query<{ n: number; usd: number }>('SELECT count(*)::int AS n, sum(cost_usd)::float8 AS usd FROM trials WHERE probe AND cost_usd IS NOT NULL')).rows[0];
    expect(probes.n).toBeGreaterThan(0); // probes reported a (fake) cost, and it must not count
    const system = (await spendRows()).reduce((s, r) => s + (r.cost_usd ?? 0), 0);

    const spend = (await request(env.http).get('/api/spend').expect(200)).body as SpendView;
    expect(spend.trials_usd).toBeCloseTo(0.00136, 8); // the real-model trial only (runnerReport's proxy cost)
    expect(spend.fake_trials_usd).toBeCloseTo(0.00136, 8); // the fake one, kept apart
    expect(spend.system_usd).toBeCloseTo(system, 8);
    expect(spend.total_usd).toBeCloseTo(0.00136 + system, 8);

    // The simulated client is counted by its own model: a fake client on a real agent is made up, and the other way round.
    await env.pool.query(`UPDATE trials SET sim_cost_usd = 0.5 WHERE id = ANY($1)`, [[fakeTrial, realTrial]]);
    await env.pool.query(`UPDATE experiments SET sim_model = 'fake/sim-client' WHERE id = (SELECT experiment_id FROM trials WHERE id = $1)`, [realTrial]);
    await env.pool.query(`UPDATE experiments SET sim_model = 'claude-haiku-5-5' WHERE id = (SELECT experiment_id FROM trials WHERE id = $1)`, [fakeTrial]);
    const mixed = (await request(env.http).get('/api/spend').expect(200)).body as SpendView;
    expect(mixed.trials_usd).toBeCloseTo(0.00136 + 0.5, 8);
    expect(mixed.fake_trials_usd).toBeCloseTo(0.00136 + 0.5, 8);
    expect(mixed.total_usd).toBeCloseTo(0.00136 + 0.5 + system, 8);
    await env.pool.query(`UPDATE trials SET sim_cost_usd = NULL WHERE id = ANY($1)`, [[fakeTrial, realTrial]]);
    expect(spend.system_by_kind.conflict_check.calls).toBe((await spendRows()).length);
    expect(spend.system_by_kind.conflict_check.usd).toBeCloseTo(system, 8);
    expect(spend.allowances).toEqual([expect.objectContaining({ kind: 'conflict_check', limit_usd: 2, half_reached: true })]);
    expect(spend.allowances[0].used_usd).toBeCloseTo(system, 8);
  });
});
