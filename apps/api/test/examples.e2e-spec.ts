import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import request from 'supertest';
import type {
  AaCalibration,
  ClaimResponse,
  CompareResponse,
  ConfigView,
  ExampleView,
  ExperimentBundle,
  ExperimentDetail,
  ExperimentSummary,
  GraderClaimResponse,
  LoadExampleResponse,
  StoredFile,
  TrialRowSummary,
  TrialView,
} from '../src/contract';
import { graderVersion } from '../src/grading/grading-core';
import { REPO, type TestEnv, auth, bootEnv, catalogue, makeConfig, runnerReport } from './support/app';
import { describeWithDb } from './support/db';

/**
 * SP7 shipped examples, end to end on real Postgres: a finished experiment on one API (the
 * source) is exported with the real scripts/export_example.py through GET /bundle, then loaded
 * into a fresh database behind a second API (the target), which must show the same trials,
 * spans, grades and files, read-only. No model is called: trials are reported as a worker would.
 */

const CONTRACT_EXAMPLES = path.join(REPO, 'contract/v2/examples');
const RESULT = JSON.parse(readFileSync(path.join(CONTRACT_EXAMPLES, 'result.json'), 'utf8')) as Record<string, unknown>;
const SPANS = readFileSync(path.join(CONTRACT_EXAMPLES, 'trace.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
// Loading the shipped example writes hundreds of trial files; under a full parallel test run
// that can pass jest's 5 s default.
jest.setTimeout(60_000);

const FRAMEWORK = /^FRAMEWORK_VERSION = "([^"]+)"/m.exec(readFileSync(path.join(REPO, 'graders/src/evals_graders/__init__.py'), 'utf8'))![1];
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const run = promisify(execFile);

/** A synthetic task with rule-based graders (test fixture, not part of the task set). */
const TASK = {
  id: 'emi-example',
  version: '1',
  split: 'discovery',
  summary: 'EMI for the example test (test fixture)',
  messages: [{ role: 'user', content: 'What is my EMI on Rs 10 lakh at 9% for 20 years?' }],
  client_sim: null,
  client_state: 'client.json',
  graders: [
    { id: 'answered', type: 'end_state', states: ['answered'] },
    { id: 'emi-tool', type: 'tool_called', tool: 'mcp__finance__calculate_emi' },
  ],
};
const TASK_TWO = { ...TASK, id: 'emi-example-two', summary: 'A second EMI task for the example test (test fixture)' };
/** Not UTF-8, so the export ships it as base64. */
const BLOB = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f]);

describeWithDb('shipped examples (e2e, real Postgres)', () => {
  let source: TestEnv;
  let target: TestEnv;
  let tmp: string;
  let examplesDir: string;
  let exp: ExperimentDetail;
  let second: ExperimentDetail;
  let calib: ExperimentDetail;
  let configs: { a: string; b: string };

  const portOf = (env: TestEnv): number => ((env.app.getHttpServer() as unknown as Server).address() as AddressInfo).port;

  /** Every queued trial through the worker protocol. The first claim of `failFirst` reports an infra failure, so it is re-queued. */
  async function runTrials(env: TestEnv, failFirst = false): Promise<void> {
    let failed = !failFirst;
    for (;;) {
      const res = await request(env.http).post('/api/worker/claim').set(auth).send({ worker_id: 'w1', harness: 'ownloop' });
      if (res.status === 204) return;
      const c = res.body as ClaimResponse;
      const label = failed ? 'agent' : 'infra:adapter_crash';
      failed = true;
      const files: Record<string, Buffer> = {
        'result.json': Buffer.from(JSON.stringify({ ...RESULT, trial_id: c.trial_id })),
        'trace.jsonl': Buffer.from(SPANS.map((s) => JSON.stringify(s)).join('\n') + '\n'),
        'artifacts/proxy/0001.request.json': Buffer.from('{"model":"fake/finance-emi"}'),
        'artifacts/blob.bin': BLOB,
      };
      const manifest = [];
      for (const [rel, data] of Object.entries(files)) {
        await request(env.http)
          .put(`/api/worker/trials/${c.trial_id}/files/${rel}?worker_id=w1&attempt=${c.attempt}`)
          .set(auth)
          .set('Content-Type', 'application/octet-stream')
          .set('X-Content-Sha256', sha(data))
          .send(data)
          .expect((r) => expect([200, 201]).toContain(r.status));
        manifest.push({ path: rel, bytes: data.length, sha256: sha(data) });
      }
      await request(env.http)
        .post(`/api/worker/trials/${c.trial_id}/report`)
        .set(auth)
        .send({
          worker_id: 'w1',
          attempt: c.attempt,
          runner_report: runnerReport(c.trial_id, c.attempt, label, manifest),
          result: label === 'agent' ? { ...RESULT, trial_id: c.trial_id } : null,
          spans: SPANS,
          files: manifest,
        })
        .expect(200);
    }
  }

  /** Grades every queued grading job, every grader passing, as the Python framework would report. */
  async function drainGrading(env: TestEnv): Promise<void> {
    for (;;) {
      const res = await request(env.http).post('/api/grader/claim').set(auth).send({ worker_id: 'g1' });
      if (res.status === 204) return;
      const job = res.body as GraderClaimResponse;
      const grades = job.graders.map((g) => {
        const spec = g.spec as { id: string; type: string };
        return {
          grader_id: spec.id,
          type: spec.type,
          required: true,
          verdict: 'pass',
          score: 1,
          reason: `${spec.id}: pass`,
          evidence: [{ source: 'final_answer', quote: 'Your EMI is Rs 8,997.26.' }],
          grader_version: graderVersion(g.spec_sha256, FRAMEWORK),
          spec_sha256: g.spec_sha256,
        };
      });
      await request(env.http)
        .post(`/api/grader/trials/${job.trial_id}/grades`)
        .set(auth)
        .send({ worker_id: 'g1', job_id: job.job_id, attempt: job.attempt, framework_version: FRAMEWORK, grades })
        .expect(200);
    }
  }

  async function finishedExperiment(body: Record<string, unknown>, failFirst: boolean, env: TestEnv = source): Promise<ExperimentDetail> {
    const res = await request(env.http).post('/api/experiments').send({ axis: 'max_steps', n: 1, sim_model: null, budget_usd: 50, ...body });
    if (res.status !== 201) throw new Error(`experiment: ${res.status} ${JSON.stringify(res.body)}`);
    const created = res.body as ExperimentDetail;
    await request(env.http).post(`/api/experiments/${created.id}/start`).expect(200);
    await runTrials(env, failFirst);
    await drainGrading(env);
    return (await request(env.http).get(`/api/experiments/${created.id}`).expect(200)).body as ExperimentDetail;
  }

  async function exportExample(experimentId: string, name: string): Promise<void> {
    const args = [path.join(REPO, 'scripts/export_example.py'), experimentId, '--name', name, '--title', `Example ${name} (test fixture)`];
    args.push('--api', `http://127.0.0.1:${portOf(source)}/api`, '--out', examplesDir, '--repo', tmp, '--source', 'bundle');
    await run('python3', args, { timeout: 60_000 });
  }

  /** Rewrites an example's rows (and its manifest's hash of them), as a hand edit would. */
  async function rewriteRows(name: string, edit: (tables: ExperimentBundle['tables']) => void): Promise<void> {
    const dir = path.join(examplesDir, name);
    const bundle = JSON.parse(gunzipSync(await fs.readFile(path.join(dir, 'rows.json.gz'))).toString('utf8')) as ExperimentBundle;
    edit(bundle.tables);
    const gz = gzipSync(Buffer.from(JSON.stringify(bundle)));
    await fs.writeFile(path.join(dir, 'rows.json.gz'), gz);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      parts: Record<string, { bytes: number; sha256: string }>;
      counts: Record<string, number>;
    };
    manifest.parts['rows.json.gz'] = { bytes: gz.length, sha256: `sha256:${sha(gz)}` };
    for (const k of ['configs', 'tasks', 'trials', 'spans', 'grades'] as const) manifest.counts[k] = bundle.tables[k].length;
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  }

  const count = async (env: TestEnv, table: string): Promise<number> => (await env.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const counts = async (env: TestEnv): Promise<number[]> =>
    Promise.all(['experiments', 'trials', 'spans', 'grades', 'grading_jobs', 'configs', 'tasks', 'experiment_arms'].map((t) => count(env, t)));
  const spanCount = async (env: TestEnv, id: string): Promise<number> =>
    (await env.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM spans s JOIN trials t ON t.id = s.trial_id WHERE t.experiment_id = $1', [id])).rows[0].n;
  const load = (name: string) => request(target.http).post(`/api/examples/${name}/load`);
  const aaOf = async (env: TestEnv, id: string): Promise<AaCalibration | null> =>
    ((await request(env.http).get(`/api/experiments/${id}/compare`).expect(200)).body as CompareResponse).stats!.aa;
  const trialIds = async (env: TestEnv, id: string): Promise<string[]> =>
    ((await request(env.http).get(`/api/experiments/${id}/trials`).expect(200)).body as TrialRowSummary[]).map((t) => t.id);

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-examples-e2e-'));
    examplesDir = path.join(tmp, 'examples');
    // Every example shipped in the repo, beside the ones this test exports.
    await fs.cp(path.join(REPO, 'examples'), examplesDir, { recursive: true });

    // Both APIs see the same examples folder; the source is the machine they were exported from.
    process.env.EXAMPLES_DIR = examplesDir;
    source = await bootEnv();
    for (const task of [TASK, TASK_TWO]) {
      const dir = path.join(source.tasksDir, task.id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
      await fs.writeFile(path.join(dir, 'client.json'), '{"name": "Test Client (synthetic)"}');
    }
    const cat = await catalogue(source.http);
    const a = await makeConfig(source.http, cat, { name: 'arm A (test)' });
    const b = await makeConfig(source.http, cat, { name: 'arm B (test)', settings: { max_steps: 5 }, parent_hash: a });
    configs = { a, b };
    exp = await finishedExperiment({ name: 'example source', config_hashes: [a, b], task_sha256s: [cat.tasks[TASK.id], cat.tasks[TASK_TWO.id]] }, true);
    // A regrade with the same graders: a second job per trial, reusing the same grade rows.
    await request(source.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(202);
    await drainGrading(source);
    second = await finishedExperiment({ name: 'second source', config_hashes: [a], task_sha256s: [cat.tasks[TASK.id]] }, false);
    // D44: an A/A calibration of arm A's config, shipped beside the A/B as the real examples are.
    calib = await finishedExperiment(
      { name: 'aa source', axis: 'none', calibration: true, config_hashes: [a, a], task_sha256s: [cat.tasks[TASK.id], cat.tasks[TASK_TWO.id]] },
      false,
    );
    await exportExample(exp.id, 'test-example');
    await exportExample(second.id, 'second-example');
    await exportExample(calib.id, 'test-aa');
    target = await bootEnv();
  }, 180_000);

  afterAll(async () => {
    delete process.env.EXAMPLES_DIR;
    await target?.close();
    await source?.close();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('exports every row through GET /bundle, without key tokens or the LiteLLM team', async () => {
    expect(exp.status).toBe('done');
    const res = await request(source.http).get(`/api/experiments/${exp.id}/bundle`).expect(200);
    const bundle = res.body as ExperimentBundle;
    // The bundle names the newest migration this database has applied.
    const newest = readdirSync(path.join(REPO, 'apps/api/migrations')).filter((f) => /^\d+_.+\.sql$/.test(f)).sort().at(-1)!.replace(/\.sql$/, '');
    expect(bundle).toMatchObject({ format: 'agent-evals-bundle', format_version: 1, experiment_id: exp.id, schema_version: newest });
    const t = bundle.tables;
    expect(t.experiments).toHaveLength(1);
    expect(t.trials).toHaveLength(5); // 4 slots, one re-queued after an infra failure
    expect(t.trials.filter((r) => r.status === 'infra_failed')).toHaveLength(1);
    expect(t.configs.map((c) => c.hash).sort()).toEqual([configs.a, configs.b].sort());
    expect(t.tasks).toHaveLength(2);
    expect(t.grading_jobs).toHaveLength(8); // 4 done trials, graded and re-graded
    expect(t.spans.length).toBe(await spanCount(source, exp.id));
    expect(t.spans.length).toBeGreaterThan(0);
    expect(Object.keys(t.spans[0]).sort()).toEqual(['raw', 'trial_id']);
    // The source holds the key tokens (the claim minted keys); the bundle never does.
    const { rows } = await source.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM trials WHERE experiment_id = $1 AND agent_key_token IS NOT NULL', [exp.id]);
    expect(rows[0].n).toBe(5);
    expect(t.trials.every((r) => !('agent_key_token' in r) && !('sim_key_token' in r))).toBe(true);
    expect('litellm_team_id' in t.experiments[0]).toBe(false);
    expect(JSON.stringify(bundle)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    await request(source.http).get('/api/experiments/e_none/bundle').expect(404);
  });

  it('lists the examples folder, none loaded yet', async () => {
    const list = (await request(target.http).get('/api/examples').expect(200)).body as ExampleView[];
    const mine = list.find((e) => e.name === 'test-example')!;
    expect(mine).toEqual({
      name: 'test-example',
      title: 'Example test-example (test fixture)',
      description: expect.stringContaining('example source') as unknown,
      experiment_id: exp.id,
      loaded: false,
      created_at: expect.any(String) as unknown,
      counts: { configs: 2, tasks: 2, trials: 5, spans: await spanCount(source, exp.id), grades: 8, files: 20 },
    });
    expect(list.map((e) => e.name)).toContain('second-example');
  });

  it('loads an example: the same trials, spans, grades, files and comparison as the source', async () => {
    const res = await load('test-example').expect(200);
    expect(res.body as LoadExampleResponse).toEqual({ name: 'test-example', experiment_id: exp.id, created: true });

    const listed = (await request(target.http).get('/api/experiments').expect(200)).body as ExperimentSummary[];
    expect(listed.find((e) => e.id === exp.id)?.example).toEqual({ name: 'test-example', title: 'Example test-example (test fixture)', loaded_at: expect.any(String) as unknown });
    const own = (await request(source.http).get('/api/experiments').expect(200)).body as ExperimentSummary[];
    expect(own.find((e) => e.id === exp.id)?.example).toBeNull();

    // The detail is the same but for the example mark (and `actual`, whose elapsed time is to now),
    // and its configs' example_only, which says where they came from: here, the example.
    const strip = (d: ExperimentDetail): Partial<ExperimentDetail> => ({ ...d, example: undefined, actual: undefined, configs: d.configs.map((c) => ({ ...c, example_only: false })) });
    const there = (await request(target.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    const here = (await request(source.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(strip(there)).toEqual(strip(here));

    const ids = await trialIds(source, exp.id);
    expect(await trialIds(target, exp.id)).toEqual(ids);
    // Grades get the target's own ids; everything else about a trial is the same.
    const noGradeIds = (v: TrialView): unknown => ({ ...v, grades: v.grades.map((g) => ({ ...g, id: undefined })) });
    for (const id of ids) {
      const a = (await request(source.http).get(`/api/trials/${id}`).expect(200)).body as TrialView;
      const b = (await request(target.http).get(`/api/trials/${id}`).expect(200)).body as TrialView;
      expect(noGradeIds(b)).toEqual(noGradeIds(a));
      expect((await request(target.http).get(`/api/trials/${id}/spans`).expect(200)).body).toEqual((await request(source.http).get(`/api/trials/${id}/spans`).expect(200)).body);
      const files: StoredFile[] = a.files;
      for (const f of files) {
        const got = await request(target.http).get(`/api/trials/${id}/files/${f.path}`).responseType('blob').expect(200);
        expect(`sha256:${sha(got.body as Buffer)}`).toBe(f.sha256);
      }
    }
    const cmp = async (env: TestEnv): Promise<CompareResponse> => (await request(env.http).get(`/api/experiments/${exp.id}/compare`).expect(200)).body as CompareResponse;
    expect((await cmp(target)).rows).toEqual((await cmp(source)).rows);
    expect((await cmp(target)).status).toBe('complete');

    const list = (await request(target.http).get('/api/examples').expect(200)).body as ExampleView[];
    expect(list.find((e) => e.name === 'test-example')?.loaded).toBe(true);

    // The exports carry the title screens show; the stored name stays the one it was run under.
    const json = JSON.parse((await request(target.http).get(`/api/experiments/${exp.id}/export?format=json`).expect(200)).text) as { experiment_title: string; experiment: ExperimentDetail };
    expect(json.experiment_title).toBe('Example test-example (test fixture)');
    expect(json.experiment.name).toBe(exp.name);
    const ownJson = JSON.parse((await request(source.http).get(`/api/experiments/${exp.id}/export?format=json`).expect(200)).text) as { experiment_title: string };
    expect(ownJson.experiment_title).toBe(exp.name);
    const [header, first] = (await request(target.http).get(`/api/experiments/${exp.id}/export?format=csv`).expect(200)).text.split('\n');
    expect(header.split(',').slice(0, 3)).toEqual(['experiment_id', 'experiment_title', 'trial_id']);
    expect(first.startsWith(`${exp.id},Example test-example (test fixture),`)).toBe(true);
  });

  it("an example's comparison shows the A/A calibration shipped beside it, never one of your own", async () => {
    // Where they ran, both are that machine's own, so the A/B shows its A/A.
    expect((await aaOf(source, exp.id))?.experiment_id).toBe(calib.id);
    // Here the A/B is an example and its calibration is not loaded yet.
    expect(await aaOf(target, exp.id)).toBeNull();
    expect((await load('test-aa').expect(200)).body).toMatchObject({ experiment_id: calib.id, created: true });
    expect((await aaOf(target, exp.id))?.experiment_id).toBe(calib.id);
  });

  it("marks the example's configs example-only until an experiment of your own uses one", async () => {
    const flags = async (env: TestEnv): Promise<Record<string, boolean>> =>
      Object.fromEntries(
        ((await request(env.http).get('/api/configs').expect(200)).body as ConfigView[]).filter((c) => c.hash === configs.a || c.hash === configs.b).map((c) => [c.hash, c.example_only]),
      );
    // Where they were made they are that machine's own; here they came with the example.
    expect(await flags(source)).toEqual({ [configs.a]: false, [configs.b]: false });
    expect(await flags(target)).toEqual({ [configs.a]: true, [configs.b]: true });
    expect(((await request(target.http).get(`/api/configs/${configs.b}`).expect(200)).body as ConfigView).example_only).toBe(true);
    // Not behaviour: the diff is the same on both machines.
    const diff = async (env: TestEnv): Promise<unknown> => (await request(env.http).get(`/api/configs/${configs.a}/diff/${configs.b}`).expect(200)).body;
    expect(await diff(target)).toEqual(await diff(source));
    // An experiment of your own on arm A makes A yours (even one discarded unstarted); B stays the example's.
    const cat = await catalogue(target.http);
    const mine = await request(target.http)
      .post('/api/experiments')
      .send({ name: 'mine on A', axis: 'none', config_hashes: [configs.a], task_sha256s: [cat.tasks['emi-basic']], n: 1, sim_model: null, budget_usd: 50 })
      .expect(201);
    await request(target.http).post(`/api/experiments/${(mine.body as ExperimentDetail).id}/discard`).expect(200);
    expect(await flags(target)).toEqual({ [configs.a]: false, [configs.b]: true });
  });

  it('a second load is a no-op', async () => {
    const before = await counts(target);
    const res = await load('test-example').expect(200);
    expect(res.body as LoadExampleResponse).toEqual({ name: 'test-example', experiment_id: exp.id, created: false });
    expect(await counts(target)).toEqual(before);
  });

  it('an example is never run, re-graded, judged, claimed or counted as spend', async () => {
    for (const action of ['start', 'pause', 'resume', 'stop', 'cancel', 'arms/A/pause', 'arms/A/resume']) {
      const res = await request(target.http).post(`/api/experiments/${exp.id}/${action}`).expect(409);
      expect(res.body).toMatchObject({ error: 'example_read_only', fix: expect.any(String) as unknown });
    }
    const regrade = await request(target.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(409);
    expect(regrade.body).toMatchObject({ error: 'example_read_only' });
    expect((regrade.body as { message: string }).message).toContain('re-graded');
    await request(target.http).post(`/api/experiments/${exp.id}/judge`).send({ model: 'fake/finance-emi', budget_usd: 1 }).expect(409);
    // Reusing an example's arm A in your own experiment is refused too.
    const cat = await catalogue(target.http);
    const reuse = await request(target.http)
      .post('/api/experiments')
      .send({ name: 'mine', axis: 'max_steps', n: 1, sim_model: null, budget_usd: 50, config_hashes: [configs.a, configs.b], task_sha256s: [cat.tasks['emi-basic']], parent_experiment_id: exp.id, reuse_baseline: true });
    expect(reuse.status).toBe(409);
    expect(reuse.body).toMatchObject({ error: 'example_read_only' });

    // Its trials are not history for your estimates, as they are on the machine it came from.
    const plan = { config_hashes: [configs.a], task_sha256s: [cat.tasks[TASK.id] ?? exp.task_sha256s[0]], n: 1, sim_model: null };
    const estimate = async (env: TestEnv): Promise<string> =>
      ((await request(env.http).post('/api/experiments/estimate').send(plan).expect(200)).body as { basis_detail: { cells: { source: string }[] } }).basis_detail.cells[0].source;
    expect(await estimate(source)).toBe('config_task');
    expect(await estimate(target)).toBe('assumption');

    await request(target.http).post('/api/worker/claim').set(auth).send({ worker_id: 'w9', harness: 'ownloop' }).expect(204);
    await request(target.http).post('/api/grader/claim').set(auth).send({ worker_id: 'g9' }).expect(204);
    const spend = (await request(target.http).get('/api/spend').expect(200)).body as { trials_usd: number };
    expect(spend.trials_usd).toBe(0);
    // Nothing above changed the example.
    const view = (await request(target.http).get(`/api/experiments/${exp.id}`).expect(200)).body as ExperimentDetail;
    expect(view.status).toBe('done');
    expect(view.arms.every((a) => a.paused_at === null)).toBe(true);
  });

  it('refuses an id that is already there, and changes nothing', async () => {
    // The machine it was exported from: the experiment is its own there, not an example.
    const before = await counts(source);
    const res = await request(source.http).post('/api/examples/test-example/load').expect(409);
    expect(res.body).toMatchObject({ error: 'example_conflict', message: expect.stringContaining('as an experiment of its own') as unknown });
    expect(await counts(source)).toEqual(before);

    // The same experiment under another example name.
    await fs.cp(path.join(examplesDir, 'test-example'), path.join(examplesDir, 'copy-example'), { recursive: true });
    const manifestPath = path.join(examplesDir, 'copy-example', 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await fs.readFile(manifestPath, 'utf8')), name: 'copy-example' }));
    const targetBefore = await counts(target);
    const copy = await load('copy-example').expect(409);
    expect(copy.body).toMatchObject({ error: 'example_conflict', message: expect.stringContaining('already loaded as the example test-example') as unknown });
    expect(await counts(target)).toEqual(targetBefore);
  });

  it('refuses shared rows or stored files with other content, and changes nothing', async () => {
    const original = await fs.readFile(path.join(examplesDir, 'second-example', 'rows.json.gz'));
    const originalManifest = await fs.readFile(path.join(examplesDir, 'second-example', 'manifest.json'));
    // The target already holds arm A's config from the first example; this one says otherwise.
    await rewriteRows('second-example', (t) => {
      (t.configs[0].settings as Record<string, unknown>).max_steps = 99;
    });
    const before = await counts(target);
    const res = await load('second-example').expect(409);
    expect(res.body).toMatchObject({ error: 'example_conflict', message: expect.stringContaining(`configs ${configs.a}`) as unknown });
    expect(await counts(target)).toEqual(before);
    await fs.writeFile(path.join(examplesDir, 'second-example', 'rows.json.gz'), original);
    await fs.writeFile(path.join(examplesDir, 'second-example', 'manifest.json'), originalManifest);

    // A different file already where one of its trial files goes.
    const [trialId] = await trialIds(source, second.id);
    const stray = path.join(target.runsDir, second.id, trialId, 'attempt-1', 'result.json');
    await fs.mkdir(path.dirname(stray), { recursive: true });
    await fs.writeFile(stray, '{"not": "the shipped file"}');
    const clash = await load('second-example').expect(409);
    expect(clash.body).toMatchObject({ error: 'example_conflict', message: expect.stringContaining('result.json is already stored with other content') as unknown });
    expect(await counts(target)).toEqual(before);
    await fs.rm(stray);

    // With its shared rows as they are, it loads beside the first one, sharing arm A's config
    // row. It is shipped ungraded here, and is still never queued for grading: an example keeps
    // the grades it came with.
    await rewriteRows('second-example', (t) => {
      t.grading_jobs = [];
      t.grades = [];
    });
    expect((await load('second-example').expect(200)).body).toMatchObject({ created: true });
    const after = await counts(target);
    expect(after[0]).toBe(before[0] + 1); // one more experiment
    expect(after[5]).toBe(before[5]); // no new config: arm A's row is shared
    await request(target.http).post('/api/grader/claim').set(auth).send({ worker_id: 'g9' }).expect(204);
    expect(await count(target, 'grading_jobs')).toBe(before[4]);
    const ungraded = (await request(target.http).get(`/api/trials/${trialId}`).expect(200)).body as TrialView;
    expect(ungraded.grading.current).toBeNull();
  });

  it('refuses a corrupt or unknown example', async () => {
    await fs.cp(path.join(examplesDir, 'test-example'), path.join(examplesDir, 'corrupt-example'), { recursive: true });
    const manifestPath = path.join(examplesDir, 'corrupt-example', 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await fs.readFile(manifestPath, 'utf8')), name: 'corrupt-example' }));
    await fs.appendFile(path.join(examplesDir, 'corrupt-example', 'files.jsonl.gz'), 'x');
    const res = await load('corrupt-example').expect(422);
    expect(res.body).toMatchObject({ error: 'example_invalid', message: expect.stringContaining('files.jsonl.gz') as unknown });
    await load('no-such-example').expect(404);
    await load('Not_A_Name').expect(400);
  });

  it('loads every example shipped in the repo, matching its manifest', async () => {
    const shipped = (await fs.readdir(path.join(REPO, 'examples'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(shipped.length).toBeGreaterThan(0);
    const loaded: ExperimentDetail[] = [];
    for (const name of shipped) {
      const manifest = JSON.parse(await fs.readFile(path.join(REPO, 'examples', name, 'manifest.json'), 'utf8')) as ExampleView & { sample: boolean };
      expect(manifest.sample).toBe(true);
      const res = await load(name).expect(200);
      expect(res.body).toEqual({ name, experiment_id: manifest.experiment_id, created: true });
      const detail = (await request(target.http).get(`/api/experiments/${manifest.experiment_id}`).expect(200)).body as ExperimentDetail;
      loaded.push(detail);
      expect(detail.example?.name).toBe(name);
      expect(detail.status).toMatch(/^(done|cancelled)$/);
      const q = async (sql: string): Promise<number> => (await target.pool.query<{ n: number }>(sql, [manifest.experiment_id])).rows[0].n;
      expect(await q('SELECT count(*)::int AS n FROM trials WHERE experiment_id = $1')).toBe(manifest.counts.trials);
      expect(await q('SELECT count(*)::int AS n FROM spans s JOIN trials t ON t.id = s.trial_id WHERE t.experiment_id = $1')).toBe(manifest.counts.spans);
      expect(await q('SELECT count(*)::int AS n FROM grades g JOIN trials t ON t.id = g.trial_id WHERE t.experiment_id = $1')).toBe(manifest.counts.grades);
      // One trial's files come back byte for byte.
      const [first] = (await request(target.http).get(`/api/experiments/${manifest.experiment_id}/trials`).expect(200)).body as TrialRowSummary[];
      const view = (await request(target.http).get(`/api/trials/${first.id}`).expect(200)).body as TrialView;
      expect(view.files.length).toBeGreaterThan(0);
      const result = view.files.find((f) => f.path === 'result.json')!;
      const got = await request(target.http).get(`/api/trials/${first.id}/files/result.json`).expect(200);
      expect(`sha256:${sha(Buffer.from(got.text))}`).toBe(result.sha256);
      const compared = (await request(target.http).get(`/api/experiments/${manifest.experiment_id}/compare`).expect(200)).body as CompareResponse;
      expect(compared).toMatchObject({ status: 'complete' });
      // SP6: its statistics are computed from its recorded grades; every task is in or listed as left out.
      const stats = compared.stats!;
      expect(stats.tasks.length + stats.excluded_tasks.length).toBe(detail.task_sha256s.length);
      expect(stats.seed).toBe(manifest.experiment_id);
      // D64: its behaviour per arm is read from its recorded spans, and every failed trial has a cause.
      const behaviour = compared.behaviour!;
      const done = await q("SELECT count(*)::int AS n FROM trials WHERE experiment_id = $1 AND status = 'done'");
      expect(behaviour.arms.reduce((s, a) => s + a.trials, 0)).toBe(done);
      expect(behaviour.arms.reduce((s, a) => s + a.tool_calls.total, 0)).toBe(
        await q("SELECT count(*)::int AS n FROM spans s JOIN trials t ON t.id = s.trial_id WHERE t.experiment_id = $1 AND t.status = 'done' AND s.name LIKE 'execute_tool%'"),
      );
      const rows = (await request(target.http).get(`/api/experiments/${manifest.experiment_id}/trials`).expect(200)).body as TrialRowSummary[];
      for (const r of rows.filter((x) => x.grading === 'fail')) expect(r.cause).not.toBeNull();
      expect(behaviour.arms.reduce((s, a) => s + a.causes.trials, 0)).toBe(rows.filter((x) => x.cause).length);
      // Its tasks have judge criteria, so its trials would be labelling items if they were your own.
      const queue = (await request(target.http).get('/api/labels/queue?set=tuning').expect(200)).body as { item_id: string }[];
      const ids = new Set(await trialIds(target, manifest.experiment_id));
      expect(queue.filter((item) => ids.has(item.item_id))).toEqual([]);
      const spend = (await request(target.http).get('/api/spend').expect(200)).body as { trials_usd: number };
      expect(spend.trials_usd).toBe(0);
    }
    // D44: a shipped A/B whose config has a shipped A/A calibration shows it beside its own interval.
    for (const ab of loaded.filter((d) => !d.calibration)) {
      const cal = loaded.find((d) => d.calibration && ab.config_hashes.slice(0, 2).includes(d.config_hashes[0]));
      if (cal) expect((await aaOf(target, ab.id))?.experiment_id).toBe(cal.id);
    }
    // Five shipped examples (about 1,000 trials and 30,000 files) take longer than jest's default.
  }, 600_000);

  it('your own comparison never shows a shipped A/A calibration', async () => {
    // test-aa, loaded above, is a shipped A/A of configs.a; an A/B of your own on configs.a has none of its own.
    const cat = await catalogue(target.http);
    const own = await finishedExperiment({ name: 'own A/B', config_hashes: [configs.a, configs.b], task_sha256s: [cat.tasks['emi-basic']] }, false, target);
    expect(own.status).toBe('done');
    expect(own.example).toBeNull();
    expect(await aaOf(target, own.id)).toBeNull();
  });
});
