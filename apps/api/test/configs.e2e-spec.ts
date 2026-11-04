import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { type TestEnv, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';

describeWithDb('catalogue and configs (e2e, real Postgres)', () => {
  let env: TestEnv;
  let cat: Awaited<ReturnType<typeof catalogue>>;

  beforeAll(async () => {
    env = await bootEnv();
    cat = await catalogue(env.http);
  });

  afterAll(async () => {
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
    const toolsets = (await request(env.http).get('/api/toolsets').expect(200)).body as { id: string; version: string; servers: { allowed_tools: string[] }[] }[];
    expect(toolsets).toHaveLength(1);
    expect(toolsets[0]).toMatchObject({ id: 'finance', version: 'all' });
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
    expect(res.body).toEqual({ error: 'unsupported_setting', message: expect.stringContaining('memory') as string });
  });

  it('leaves an unset temperature and parallel_tool_calls unsent, shown as the harness default (D25)', async () => {
    const res = await request(env.http)
      .post('/api/configs')
      .send({ name: 'unset', harness: 'ownloop', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset, settings: {} })
      .expect(201);
    const c = res.body as { settings: Record<string, unknown>; settings_sources: Record<string, string> };
    expect(c.settings).toMatchObject({ temperature: null, parallel_tool_calls: null, max_output_tokens: 8192, max_steps: 15, timeout_s: 300 });
    expect(c.settings_sources).toMatchObject({
      temperature: 'harness_default',
      parallel_tool_calls: 'harness_default',
      max_output_tokens: 'platform_default',
      max_steps: 'platform_default',
      timeout_s: 'platform_default',
    });
  });

  it('refuses a setting the model rejects with 400 unsupported_setting naming the model (temperature on Haiku 5.5)', async () => {
    const base = { name: 'haiku', harness: 'ownloop', model: 'claude-haiku-5-5', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    const res = await request(env.http).post('/api/configs').send({ ...base, settings: { temperature: 0.37 } }).expect(400);
    expect(res.body).toEqual({ error: 'unsupported_setting', message: expect.stringContaining('claude-haiku-5-5 refuses temperature') as string });
    const ok = (await request(env.http).post('/api/configs').send({ ...base, settings: { max_steps: 12 } }).expect(201)).body as {
      settings: Record<string, unknown>;
      settings_sources: Record<string, string>;
    };
    expect(ok.settings).toMatchObject({ temperature: null, max_steps: 12 });
    expect(ok.settings_sources.temperature).toBe('harness_default');
  });

  it('accepts memory for Hermes, which supports it, and checks harness options against its schema', async () => {
    const base = { name: 'h', harness: 'hermes', model: 'fake/finance-emi', prompt_sha256: cat.prompt, toolset_sha256: cat.toolset };
    await request(env.http).post('/api/configs').send({ ...base, settings: { memory: { enabled: true } }, harness_options: { prompt_cache_markers: false } }).expect(201);
    const bad = await request(env.http).post('/api/configs').send({ ...base, harness_options: { nope: true } }).expect(400);
    expect((bad.body as { error: string }).error).toBe('invalid_harness_options');
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
