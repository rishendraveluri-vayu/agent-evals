import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { hashCanonical } from '../src/common/hashing';
import type { ToolsetView } from '../src/contract';
import { type TestEnv, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';

describeWithDb('catalogue and configs (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;

  beforeAll(async () => {
    // As compose passes them (`${ANTHROPIC_API_KEY:+1}`): an Anthropic key is set, a Gemini one is not.
    Object.assign(process.env, { ANTHROPIC_KEY_SET: '1', GEMINI_KEY_SET: '' });
    env = await bootEnv();
    cat = await catalogue(env.http);
  });

  afterAll(async () => {
    delete process.env.ANTHROPIC_KEY_SET;
    delete process.env.GEMINI_KEY_SET;
    await env.close();
  });

  it('lists harnesses from workers/*/src/*/capabilities.json', async () => {
    const res = await request(env.http).get('/api/harnesses').expect(200);
    const hermes = (res.body as { name: string; ref: string; python: string; capabilities: { harness: string } }[]).find((h) => h.name === 'hermes');
    expect(hermes).toMatchObject({ ref: '6112c2adb9e11f69734a29be9d2696f345ffa06a', python: '>=3.14', capabilities: { harness: 'hermes' } });
  });

  it('lists prompts without their review header, the built-in toolset, and tasks', async () => {
    const prompts = (await request(env.http).get('/api/prompts').expect(200)).body as { id: string; version: string; text: string; path: string }[];
    expect(prompts.map((p) => `${p.id}.${p.version}`)).toEqual(expect.arrayContaining(['finance-advisor.v1', 'client-sim.v1', 'client-sim.v2']));
    expect(prompts.every((p) => !p.text.startsWith('<!--'))).toBe(true);
    const toolsets = (await request(env.http).get('/api/toolsets').expect(200)).body as ToolsetView[];
    expect(toolsets).toHaveLength(1);
    expect(toolsets[0]).toMatchObject({ id: 'finance', version: 'v3', manifest: [{ server: 'finance', server_version: '0.4.1' }] });
    // The hash covers the manifest, and the manifest is stored with it (migration 009).
    const { sha256, ...content } = toolsets[0];
    expect(sha256).toBe(hashCanonical(content));
    const [row] = (await env.pool.query<{ manifest: unknown }>('SELECT manifest FROM toolsets WHERE sha256 = $1', [sha256])).rows;
    expect(row.manifest).toEqual(toolsets[0].manifest);
    const tasks = (await request(env.http).get('/api/tasks').expect(200)).body as { id: string; kind: string; split: string; problems: string[] }[];
    expect(tasks.map((t) => [t.id, t.kind, t.split, t.problems.length])).toEqual([
      ['emi-basic', 'single_prompt', 'discovery', 0],
      ['widow-loan', 'conversation', 'held_out', 0],
    ]);
  });

  it('lists real models only, priced per million tokens', async () => {
    const models = (await request(env.http).get('/api/models').expect(200)).body as { name: string; provider: string; input_per_mtok: number }[];
    expect(models.map((m) => m.name)).toEqual(['claude-haiku-5-5', 'gemini-3.8-flash', 'unpriced-model']);
    expect(models[0]).toMatchObject({ provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5 });
    expect(models[1]).toMatchObject({ provider: 'gemini', input_per_mtok: 0.75 });
  });

  it('says per model whether its provider key is set, from the flags compose passes, never the key', async () => {
    const res = await request(env.http).get('/api/models').expect(200);
    const models = res.body as { name: string; key_set: boolean | null }[];
    expect(models.map((m) => [m.name, m.key_set])).toEqual([
      ['claude-haiku-5-5', true],
      ['gemini-3.8-flash', false],
      // An openai/ route: the API is told about no key for it, so it does not guess.
      ['unpriced-model', null],
    ]);
    expect(res.text).not.toMatch(/sk-|api_key/i);
  });

  it('returns one hash for the same config posted twice: 201, then 200 with the stored config', async () => {
    const body = { name: 'first name', harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, settings: { temperature: 0.5 } };
    const first = await request(env.http).post('/api/configs').send(body).expect(201);
    // Same content in another key order, with the hash given as bare hex and a different name.
    const again = await request(env.http)
      .post('/api/configs')
      .send({ settings: { temperature: 0.5 }, toolset_sha256: cat.toolset.replace('sha256:', ''), prompt_sha256: cat.prompt, model: 'fake/finance-emi', harness: 'ownloop', name: 'second name' })
      .expect(200);
    const a = first.body as { hash: string; name: string; settings: Record<string, unknown>; settings_sources: Record<string, string> };
    expect((again.body as { hash: string }).hash).toBe(a.hash);
    expect((again.body as { name: string }).name).toBe('first name');
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.settings).toMatchObject({ temperature: 0.5, max_steps: 15, memory: null });
    expect(a.settings_sources).toMatchObject({ temperature: 'config', max_steps: 'platform_default', memory: 'unsupported' });
    const all = (await request(env.http).get('/api/configs').expect(200)).body as { hash: string }[];
    expect(all.filter((c) => c.hash === a.hash)).toHaveLength(1);
    await request(env.http).get(`/api/configs/${a.hash}`).expect(200);
  });

  it('refuses an unsupported setting with 400 unsupported_setting naming it', async () => {
    const res = await request(env.http)
      .post('/api/configs')
      .send({ name: 'x', harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, settings: { memory: { enabled: true } } })
      .expect(400);
    expect(res.body).toEqual({
      error: 'unsupported_setting',
      message: 'ownloop does not support memory, so a config cannot set it (the loop has no memory)',
      fix: 'ownloop ignores memory: leave it unset, or pick a harness that takes it (hermes).',
    });
  });

  it('leaves an unset temperature unsent, shown as the harness default (D25); parallel tool calls stay off (D19)', async () => {
    const res = await request(env.http)
      .post('/api/configs')
      .send({ name: 'unset', harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, settings: {} })
      .expect(201);
    const c = res.body as { settings: Record<string, unknown>; settings_sources: Record<string, string> };
    expect(c.settings).toMatchObject({ temperature: null, parallel_tool_calls: false, max_output_tokens: 8192, max_steps: 15, timeout_s: 300 });
    expect(c.settings_sources).toMatchObject({
      temperature: 'harness_default',
      parallel_tool_calls: 'platform_default',
      max_output_tokens: 'platform_default',
      max_steps: 'platform_default',
      timeout_s: 'platform_default',
    });
  });

  it('refuses a setting the model rejects with 400 unsupported_setting naming the model (temperature on Haiku 5.5)', async () => {
    const base = { name: 'haiku', harness: 'ownloop', model: 'claude-haiku-5-5', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    const res = await request(env.http).post('/api/configs').send({ ...base, settings: { temperature: 0.37 } }).expect(400);
    expect(res.body).toEqual({
      error: 'unsupported_setting',
      message: expect.stringContaining('Claude Haiku 5.5 (claude-haiku-5-5) refuses temperature') as string,
      fix: 'Claude Haiku 5.5 rejects temperature: leave it unset, or pick a model that takes it.',
    });
    const ok = (await request(env.http).post('/api/configs').send({ ...base, settings: { max_steps: 12 } }).expect(201)).body as {
      settings: Record<string, unknown>;
      settings_sources: Record<string, string>;
    };
    expect(ok.settings).toMatchObject({ temperature: null, max_steps: 12 });
    expect(ok.settings_sources.temperature).toBe('harness_default');
  });

  it('shows what a harness or model ignores, with a reason for the greyed-out field', async () => {
    const res = await request(env.http)
      .post('/api/configs')
      .send({ name: 'lg haiku', harness: 'langgraph', model: 'claude-haiku-5-5', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset })
      .expect(201);
    const c = res.body as { hash: string; unsupported: Record<string, string>; warnings: unknown[] };
    expect(c.unsupported).toEqual({
      temperature: "Claude Haiku 5.5 rejects temperature, so it is not sent and the provider's default applies",
      memory: 'langgraph does not support memory: create_agent has no memory unless a store and memory tools are added; the adapter adds neither',
      skills: 'langgraph does not support skills: LangGraph has no skills',
      compression: 'langgraph does not support compression: nothing compresses unless SummarizationMiddleware is added; the full history is sent',
    });
    expect(c.warnings).toEqual([]);
    expect(((await request(env.http).get(`/api/configs/${c.hash}`).expect(200)).body as { unsupported: unknown }).unsupported).toEqual(c.unsupported);
  });

  it('stores a LangGraph config whose model name rewrites the request, with a warning and a fix', async () => {
    const base = { name: 'lg gpt-5', model: 'gpt-5-mini', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, settings: { temperature: 0.2 } };
    const res = await request(env.http).post('/api/configs').send({ ...base, harness: 'langgraph' }).expect(201);
    const c = res.body as { hash: string; warnings: { code: string; message: string; fix: string }[] };
    expect(c.warnings).toEqual([
      {
        code: 'langgraph_model_name_rewrite',
        message: 'LangGraph changes the request for this model name (gpt-5-mini): a gpt-5 name drops any temperature other than 1.',
        fix: 'Serve the model under a LiteLLM name that does not start with gpt-5, gpt-6, o1 or o<digit> and does not contain codex, or run it on another harness.',
      },
    ]);
    expect(((await request(env.http).get(`/api/configs/${c.hash}`).expect(200)).body as { warnings: unknown }).warnings).toEqual(c.warnings);
    // The same model on the own loop is sent as configured: no warning.
    expect(((await request(env.http).post('/api/configs').send({ ...base, harness: 'ownloop' }).expect(201)).body as { warnings: unknown[] }).warnings).toEqual([]);
  });

  it('carries a fix on the other refusals too', async () => {
    const base = { name: 'x', harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    const fixOf = async (change: Record<string, unknown>) => ((await request(env.http).post('/api/configs').send({ ...base, ...change }).expect(400)).body as { fix?: string }).fix;
    expect(await fixOf({ settings: { temprature: 0.2 } })).toBe('Did you mean temperature? Rename temprature to temperature.');
    expect(await fixOf({ settings: { max_steps: -1 } })).toBe('Set max_steps to an integer of at least 1, or leave it unset for the default.');
    expect(await fixOf({ harness: 'nope' })).toContain('Pick a harness from GET /harnesses: ');
    expect(await fixOf({ model: 'gpt-nope' })).toContain('GET /models');
  });

  it('accepts memory for Hermes, which supports it, and checks harness options against its schema', async () => {
    const base = { name: 'h', harness: 'hermes', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    await request(env.http).post('/api/configs').send({ ...base, settings: { memory: { enabled: true } }, harness_options: { prompt_cache_markers: false } }).expect(201);
    const bad = await request(env.http).post('/api/configs').send({ ...base, harness_options: { nope: true } }).expect(400);
    expect((bad.body as { error: string }).error).toBe('invalid_harness_options');
  });

  it('seeds memory and skills on Hermes: a seeded config has its own hash, the same seeds the same one (D39)', async () => {
    const base = { name: 'h mem', harness: 'hermes', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    const on = { memory: { enabled: true }, skills: { enabled: true } };
    const seed = {
      memory: ['The client (synthetic) wants every amount in rupees.'],
      skills: [{ name: 'emi-check', description: 'Check an EMI before quoting it', body: 'Call the EMI tool, then quote its number.' }],
    };
    const empty = (await request(env.http).post('/api/configs').send({ ...base, settings: on }).expect(201)).body as { hash: string; seed: unknown };
    expect(empty.seed).toEqual({ memory: [], skills: [] });
    // Empty lists are no seed: the same config.
    expect(((await request(env.http).post('/api/configs').send({ ...base, settings: on, seed: { memory: [], skills: [] } }).expect(200)).body as { hash: string }).hash).toBe(empty.hash);

    const seeded = (await request(env.http).post('/api/configs').send({ ...base, name: 'h seeded', settings: on, seed }).expect(201)).body as { hash: string; seed: unknown };
    expect(seeded.hash).not.toBe(empty.hash);
    expect(seeded.seed).toEqual(seed);
    const again = (await request(env.http).post('/api/configs').send({ ...base, name: 'h seeded again', settings: on, seed: { skills: seed.skills, memory: seed.memory } }).expect(200))
      .body as { hash: string };
    expect(again.hash).toBe(seeded.hash);
    const memoryOnly = (await request(env.http).post('/api/configs').send({ ...base, settings: on, seed: { memory: seed.memory } }).expect(201)).body as { hash: string; seed: unknown };
    expect(memoryOnly.seed).toEqual({ memory: seed.memory, skills: [] });
    expect(new Set([empty.hash, seeded.hash, memoryOnly.hash]).size).toBe(3);

    expect(((await request(env.http).get(`/api/configs/${seeded.hash}`).expect(200)).body as { seed: unknown }).seed).toEqual(seed);
    expect((await request(env.http).get(`/api/configs/${empty.hash}/diff/${seeded.hash}`).expect(200)).body).toEqual([
      { path: 'name', a: 'h mem', b: 'h seeded' },
      { path: 'seed.memory', a: [], b: seed.memory },
      { path: 'seed.skills', a: [], b: seed.skills },
    ]);
  });

  it('refuses seeds a harness cannot take, or a config turns off, with a fix (D39)', async () => {
    const base = { name: 's', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    const noMemory = await request(env.http).post('/api/configs').send({ ...base, harness: 'ownloop', seed: { memory: ['a fact'] } }).expect(400);
    expect(noMemory.body).toEqual({
      error: 'unsupported_seed',
      message: 'ownloop does not support memory, so a config cannot seed it',
      fix: 'ownloop has no memory to seed: remove seed.memory, or pick a harness that takes it (hermes).',
    });
    // Memory is off unless the config turns it on (R3, R10.8).
    const off = await request(env.http).post('/api/configs').send({ ...base, harness: 'hermes', seed: { memory: ['a fact'] } }).expect(400);
    expect(off.body).toEqual({
      error: 'seed_feature_off',
      message: 'seed.memory is set but memory is off for this config, so the seeds would not be used',
      fix: 'Set settings.memory to {"enabled": true}, or remove seed.memory.',
    });
    const shape = await request(env.http)
      .post('/api/configs')
      .send({ ...base, harness: 'hermes', settings: { skills: { enabled: true } }, seed: { skills: [{ name: 'Bad Name', description: 'd', body: 'b' }] } })
      .expect(400);
    expect(shape.body).toMatchObject({ error: 'invalid_seed', fix: expect.stringContaining('"memory"') as string });
  });

  it.each([
    ['an unknown harness', { harness: 'nope' }, 'unknown_harness'],
    ['an unknown model', { model: 'gpt-nope' }, 'unknown_model'],
    ['an unknown prompt', { prompt_sha256: `sha256:${'0'.repeat(64)}` }, 'unknown_prompt'],
    ['a bad prompt hash', { prompt_sha256: 'v1' }, 'invalid_config'],
    ['an unknown setting', { settings: { temprature: 1 } }, 'unknown_setting'],
  ])('refuses %s with 400', async (_what, change, code) => {
    const res = await request(env.http)
      .post('/api/configs')
      .send({ name: 'x', harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, ...change })
      .expect(400);
    expect((res.body as { error: string }).error).toBe(code);
  });

  it('diffs two configs field by field', async () => {
    const a = await makeConfig(env.http, cat, { settings: { temperature: 0.1 } });
    const b = await makeConfig(env.http, cat, { settings: { temperature: 0.9 }, model: 'gemini-3.8-flash' });
    const diff = (await request(env.http).get(`/api/configs/${a}/diff/${b}`).expect(200)).body as { path: string; a: unknown; b: unknown }[];
    expect(diff).toEqual([
      { path: 'model', a: 'fake/finance-emi', b: 'gemini-3.8-flash' },
      { path: 'settings.temperature', a: 0.1, b: 0.9 },
    ]);
    expect((await request(env.http).get(`/api/configs/${a}/diff/${a}`).expect(200)).body).toEqual([]);
    await request(env.http).get(`/api/configs/sha256:${'f'.repeat(64)}`).expect(404);
  });

  it('records a fork with its parent, lists the children on the parent, and keeps lineage out of the hash (D34)', async () => {
    const base = { harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    const parent = ((await request(env.http).post('/api/configs').send({ ...base, name: 'parent', settings: { max_steps: 11 } }).expect(201)).body as { hash: string; parent_hash: null })
      .hash;
    const fork = (await request(env.http).post('/api/configs').send({ ...base, name: 'fork', settings: { max_steps: 12 }, parent_hash: parent.replace('sha256:', '') }).expect(201))
      .body as { hash: string; parent_hash: string };
    expect(fork.parent_hash).toBe(parent);
    // The same content with no parent is the same config: lineage is not behaviour, and the first post's parent stays.
    const again = (await request(env.http).post('/api/configs').send({ ...base, name: 'fork again', settings: { max_steps: 12 } }).expect(200)).body as { hash: string; parent_hash: string };
    expect(again).toMatchObject({ hash: fork.hash, parent_hash: parent });

    const detail = (await request(env.http).get(`/api/configs/${parent}`).expect(200)).body as { parent_hash: null; children: { hash: string; name: string }[] };
    expect(detail.parent_hash).toBeNull();
    expect(detail.children.map((c) => [c.hash, c.name])).toEqual([[fork.hash, 'fork']]);
    expect(((await request(env.http).get(`/api/configs/${fork.hash}`).expect(200)).body as { children: unknown[] }).children).toEqual([]);
    // The diff shows the name and the one change, not the lineage.
    expect((await request(env.http).get(`/api/configs/${parent}/diff/${fork.hash}`).expect(200)).body).toEqual([
      { path: 'name', a: 'parent', b: 'fork' },
      { path: 'settings.max_steps', a: 11, b: 12 },
    ]);

    const same = await request(env.http).post('/api/configs').send({ ...base, name: 'no change', settings: { max_steps: 11 }, parent_hash: parent }).expect(400);
    expect(same.body).toMatchObject({ error: 'same_as_parent', fix: expect.stringContaining('Change the one thing') as string });
    const unknown = await request(env.http).post('/api/configs').send({ ...base, name: 'orphan', settings: { max_steps: 13 }, parent_hash: `sha256:${'e'.repeat(64)}` }).expect(400);
    expect(unknown.body).toMatchObject({ error: 'unknown_parent', fix: expect.any(String) as string });
  });

  it('flags a stored task whose state file changed without a task.json change', async () => {
    await fs.writeFile(path.join(env.tasksDir, 'emi-basic', 'client.json'), '{"name": "changed"}');
    try {
      const tasks = (await request(env.http).get('/api/tasks').expect(200)).body as { id: string; problems: string[] }[];
      expect(tasks.find((t) => t.id === 'emi-basic')?.problems.join(' ')).toContain('changed after this task.json was first stored');
    } finally {
      await fs.writeFile(path.join(env.tasksDir, 'emi-basic', 'client.json'), '{"name": "Test Client (synthetic)"}');
    }
  });

  it('gives errors the contract shape', async () => {
    const res = await request(env.http).get('/api/configs/not-a-hash').expect(400);
    expect(res.body).toEqual({ error: 'invalid_hash', message: expect.any(String) as string });
    const unknown = await request(env.http).get('/api/nothing-here').expect(404);
    expect(Object.keys(unknown.body as object).sort()).toEqual(['error', 'message']);
  });
});
