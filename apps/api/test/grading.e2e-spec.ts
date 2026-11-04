import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import type { ClaimResponse, ExperimentDetail, GraderClaimResponse, GradesReportResponse, RegradeResponse, TrialView } from '../src/contract';
import { graderVersion } from '../src/grading/grading-core';
import { REPO, type TestEnv, auth, bootEnv, catalogue, makeConfig, runnerReport } from './support/app';
import { describeWithDb } from './support/db';

/**
 * SP4 grading as its own step (R14), end to end on real Postgres: a done trial is queued for
 * grading, a grader worker claims it, downloads its files, reports grades; a regrade after a
 * grader fix makes new grades next to the old ones without re-running the trial.
 */

const EXAMPLES = path.join(REPO, 'contract/v2/examples');
const EXAMPLE_RESULT = JSON.parse(readFileSync(path.join(EXAMPLES, 'result.json'), 'utf8')) as Record<string, unknown>;
const EXAMPLE_SPANS = readFileSync(path.join(EXAMPLES, 'trace.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
/** The Python framework's own version (graders/src/evals_graders/__init__.py), so the real grader's reports match. */
const FRAMEWORK = /^FRAMEWORK_VERSION = "([^"]+)"/m.exec(readFileSync(path.join(REPO, 'graders/src/evals_graders/__init__.py'), 'utf8'))![1];

/** A synthetic task with graders (test fixture, not part of the task set). The example trial's
 *  answer is "Your EMI is Rs 8,997.26." and its one tool call is calculate_emi. */
const GRADED_TASK = {
  id: 'emi-graded',
  version: '1',
  split: 'discovery',
  summary: 'EMI with graders (test fixture)',
  messages: [{ role: 'user', content: 'What is my EMI on Rs 10 lakh at 9% for 20 years?' }],
  client_sim: null,
  client_state: 'client.json',
  graders: [
    { id: 'answered', type: 'end_state', states: ['answered'] },
    { id: 'emi', type: 'number', expected: { from_tool: 'calculate_emi', field: 'emi' } },
    { id: 'emi-tool', type: 'tool_called', tool: 'mcp__finance__calculate_emi', args: { principal: 1000000 } },
    { id: 'unit', type: 'unit_test' },
    { id: 'tone', type: 'judge', required: false, rubric: { id: 'advice', version: 'v1' }, criteria: ['acknowledges'] },
  ],
};
const GRADER_PY = "def grade(trial):\n    said = '8,997' in (trial['final_answer'] or '')\n    return {'pass': said, 'reason': 'EMI stated' if said else 'EMI missing'}\n";
const UNGRADED_TASK = { ...GRADED_TASK, id: 'emi-ungraded', summary: 'EMI without graders (test fixture)', graders: [] };

describeWithDb('grading (e2e, real Postgres)', () => {
  let env: TestEnv;
  let config: string;
  let tasks: Record<string, string>;

  async function writeTask(task: Record<string, unknown>, grader?: string): Promise<void> {
    const dir = path.join(env.tasksDir, task.id as string);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
    await fs.writeFile(path.join(dir, 'client.json'), '{"name": "Test Client (synthetic)"}');
    if (grader !== undefined) await fs.writeFile(path.join(dir, 'grader.py'), grader);
  }

  beforeAll(async () => {
    env = await bootEnv();
    await writeTask(GRADED_TASK, GRADER_PY);
    await writeTask(UNGRADED_TASK);
    const cat = await catalogue(env.http);
    tasks = cat.tasks;
    config = await makeConfig(env.http, cat, { name: 'graded arm' });
  });

  afterAll(async () => {
    await env?.close();
  });

  // ---- helpers ----

  async function experiment(taskIds: string[], n = 1): Promise<ExperimentDetail> {
    const res = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'grading test', axis: 'none', config_hashes: [config], task_sha256s: taskIds.map((t) => tasks[t]), n, sim_model: null, budget_usd: 50, plan_commit: 'plan123' });
    if (res.status !== 201) throw new Error(`experiment: ${res.status} ${JSON.stringify(res.body)}`);
    const exp = res.body as ExperimentDetail;
    await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200);
    return exp;
  }

  /** Runs every queued trial of the experiment through the worker protocol, with `label`. */
  async function runTrials(label = 'agent'): Promise<string[]> {
    const ids: string[] = [];
    for (;;) {
      const res = await request(env.http).post('/api/worker/claim').set(auth).send({ worker_id: 'w1', harness: 'ownloop' });
      if (res.status === 204) return ids;
      const c = res.body as ClaimResponse;
      const files: Record<string, string> = {
        'result.json': JSON.stringify({ ...EXAMPLE_RESULT, trial_id: c.trial_id }),
        'trace.jsonl': EXAMPLE_SPANS.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'artifacts/proxy/0001.request.json': '{"model":"fake/finance-emi"}',
      };
      const manifest = [];
      for (const [rel, text] of Object.entries(files)) {
        await request(env.http)
          .put(`/api/worker/trials/${c.trial_id}/files/${rel}?worker_id=w1&attempt=${c.attempt}`)
          .set(auth)
          .set('Content-Type', 'application/octet-stream')
          .set('X-Content-Sha256', sha(text))
          .send(Buffer.from(text))
          .expect((r) => expect([200, 201]).toContain(r.status));
        manifest.push({ path: rel, bytes: Buffer.byteLength(text), sha256: sha(text) });
      }
      await request(env.http)
        .post(`/api/worker/trials/${c.trial_id}/report`)
        .set(auth)
        .send({
          worker_id: 'w1',
          attempt: c.attempt,
          runner_report: runnerReport(c.trial_id, c.attempt, label, manifest),
          result: label === 'agent' ? { ...EXAMPLE_RESULT, trial_id: c.trial_id } : null,
          spans: EXAMPLE_SPANS,
          files: manifest,
        })
        .expect(200);
      ids.push(c.trial_id);
    }
  }

  async function claimGrading(worker = 'g1'): Promise<GraderClaimResponse | null> {
    const res = await request(env.http).post('/api/grader/claim').set(auth).send({ worker_id: worker });
    if (res.status === 204) return null;
    expect(res.status).toBe(200);
    return res.body as GraderClaimResponse;
  }

  /** Grades as the Python framework would report them, with every grader passing. */
  function gradesFor(job: GraderClaimResponse, verdict = 'pass', overrides: Record<string, string> = {}): Record<string, unknown>[] {
    return job.graders.map((g) => {
      const spec = g.spec as { id: string; type: string; required?: boolean };
      const v = overrides[spec.id] ?? (spec.type === 'judge' ? 'not_implemented' : verdict);
      return {
        grader_id: spec.id,
        type: spec.type,
        required: spec.required !== false,
        verdict: v,
        score: v === 'pass' ? 1 : v === 'fail' ? 0 : null,
        reason: `${spec.id}: ${v}`,
        evidence: [{ source: 'final_answer', quote: 'Your EMI is Rs 8,997.26.' }],
        grader_version: graderVersion(g.spec_sha256, FRAMEWORK),
        spec_sha256: g.spec_sha256,
      };
    });
  }

  const report = (job: GraderClaimResponse, worker = 'g1', grades = gradesFor(job), attempt = job.attempt) =>
    request(env.http).post(`/api/grader/trials/${job.trial_id}/grades`).set(auth).send({ worker_id: worker, job_id: job.job_id, attempt, framework_version: FRAMEWORK, grades });

  const count = async (sql: string, params: unknown[]): Promise<number> => (await env.pool.query<{ n: number }>(sql, params)).rows[0].n;

  const trial = async (id: string): Promise<TrialView> => (await request(env.http).get(`/api/trials/${id}`).expect(200)).body as TrialView;

  const drain = async (): Promise<void> => {
    for (let job = await claimGrading('drain'); job; job = await claimGrading('drain')) await report(job, 'drain').expect(200);
  };

  // ---- tests ----

  it('refuses a grader without the worker token', async () => {
    await request(env.http).post('/api/grader/claim').send({ worker_id: 'g1' }).expect(401);
    await request(env.http).post('/api/grader/trials/t_x/grades').send({}).expect(401);
  });

  it('queues a done trial, hands its graders and files to one grader, and stores the grades', async () => {
    await drain();
    await experiment(['emi-graded']);
    const [trialId] = await runTrials();
    expect((await trial(trialId)).grading).toEqual({ current: null, pending: null });

    const job = (await claimGrading('g1'))!;
    expect(job.trial_id).toBe(trialId);
    expect(job.attempt).toBe(1);
    expect(job.task).toEqual({ id: 'emi-graded', sha256: tasks['emi-graded'], grader_source: 'catalogue', note: null });
    expect(job.graders.map((g) => (g.spec as { id: string }).id)).toEqual(['answered', 'emi', 'emi-tool', 'unit', 'tone']);
    expect(job.grader_files['grader.py']).toEqual({ sha256: `sha256:${sha(GRADER_PY)}`, base64: Buffer.from(GRADER_PY).toString('base64') });
    expect(job.trial.end_state).toBe('answered');
    const manifest = job.trial.files.find((f) => f.path === 'result.json')!;
    expect(manifest.ok).toBe(true);
    // the grader downloads through the public files endpoint and checks the manifest's hash
    const file = await request(env.http).get(`/api/trials/${trialId}/files/result.json`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(`sha256:${sha(file.body as Buffer)}`).toBe(manifest.sha256);
    expect(await claimGrading('g2')).toBeNull(); // claimed once, by g1 only

    const res = await report(job).expect(200);
    expect(res.body).toEqual({ job_id: job.job_id, trial_id: trialId, status: 'done', duplicate: false, passed: true, outcome: 'pass', grades_stored: 5, grades_reused: 0 });
    // the same report again is a no-op
    const again = (await report(job).expect(200)).body as GradesReportResponse;
    expect(again).toMatchObject({ duplicate: true, grades_stored: 0, grades_reused: 5, outcome: 'pass' });

    const view = await trial(trialId);
    expect(view.grades.map((g) => [g.grader_id, g.type, g.kind, g.required, g.verdict])).toEqual([
      ['answered', 'end_state', 'state', true, 'pass'],
      ['emi', 'number', 'exact', true, 'pass'],
      ['emi-tool', 'tool_called', 'state', true, 'pass'],
      ['unit', 'unit_test', 'unit', true, 'pass'],
      ['tone', 'judge', 'judge', false, 'not_implemented'],
    ]);
    expect(view.grades[0].evidence).toEqual([{ source: 'final_answer', quote: 'Your EMI is Rs 8,997.26.' }]);
    expect(view.grading.current).toMatchObject({ job_id: job.job_id, status: 'done', reason: 'trial_done', passed: true, outcome: 'pass', framework_version: FRAMEWORK });
    expect(view.grading.pending).toBeNull();
  });

  it('records a task with no graders without anything to claim, and never grades infra failures', async () => {
    await drain();
    await experiment(['emi-ungraded']);
    const [ungraded] = await runTrials();
    await experiment(['emi-graded']);
    const failed = await runTrials('infra:provider_error'); // attempt 1 and its re-queued attempt 2
    expect(failed).toHaveLength(2);
    expect(await claimGrading()).toBeNull();
    const view = await trial(ungraded);
    expect(view.grading.current).toMatchObject({ status: 'no_graders', passed: null });
    expect(view.grades).toEqual([]);
    expect(await count('SELECT count(*)::int AS n FROM grading_jobs WHERE trial_id = ANY($1)', [failed])).toBe(0);
  });

  it('refuses grades that do not match the job: wrong version, missing grader, unknown job', async () => {
    await drain();
    await experiment(['emi-graded']);
    const [trialId] = await runTrials();
    const job = (await claimGrading())!;
    const grades = gradesFor(job);
    const wrong = grades.map((g, i) => (i === 1 ? { ...g, grader_version: graderVersion(job.graders[0].spec_sha256, FRAMEWORK) } : g));
    expect(((await report(job, 'g1', wrong).expect(400)).body as { error: string }).error).toBe('grader_version_mismatch');
    expect(((await report(job, 'g1', grades.slice(1)).expect(400)).body as { error: string }).error).toBe('grades_mismatch');
    const res = await request(env.http).post(`/api/grader/trials/${trialId}/grades`).set(auth).send({ worker_id: 'g1', job_id: 'g_nope', attempt: 1, framework_version: FRAMEWORK, grades });
    expect(res.status).toBe(404);
    // a required grader failing fails the task; an error leaves it incomplete
    const r = (await report(job, 'g1', gradesFor(job, 'pass', { emi: 'fail', unit: 'error' })).expect(200)).body as GradesReportResponse;
    expect(r).toMatchObject({ passed: false, outcome: 'fail' });
  });

  it('gives a lapsed grading lease to another grader, refuses the old one, and fails a job that keeps lapsing', async () => {
    await drain();
    await experiment(['emi-graded']);
    await runTrials();
    const first = (await claimGrading('slow'))!;
    expect(await claimGrading('fast')).toBeNull();
    await env.pool.query(`UPDATE grading_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [first.job_id]);
    const second = (await claimGrading('fast'))!;
    expect(second.job_id).toBe(first.job_id);
    expect(second.attempt).toBe(2);
    expect(((await report(first, 'slow').expect(409)).body as { error: string }).error).toBe('claim_lost');
    await report(second, 'fast').expect(200);
    expect(((await report(first, 'slow').expect(409)).body as { error: string }).error).toBe('claim_lost');

    await experiment(['emi-graded']);
    await runTrials();
    let job = (await claimGrading('crashy'))!;
    for (let i = 0; i < 2; i++) {
      await env.pool.query(`UPDATE grading_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [job.job_id]);
      job = (await claimGrading('crashy'))!;
    }
    expect(job.attempt).toBe(3);
    await env.pool.query(`UPDATE grading_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [job.job_id]);
    expect(await claimGrading('crashy')).toBeNull();
    const view = await trial(job.trial_id);
    expect(view.grading.pending).toMatchObject({ status: 'failed', error: 'the grading lease lapsed 3 times without a report' });
  });

  it('re-grades after a grader fix, keeping the old grades and re-running nothing', async () => {
    await drain();
    const exp = await experiment(['emi-graded']);
    const [trialId] = await runTrials();
    const firstJob = (await claimGrading())!;
    await report(firstJob, 'g1', gradesFor(firstJob, 'pass', { emi: 'fail' })).expect(200);
    expect((await trial(trialId)).grading.current?.outcome).toBe('fail');
    const trialsBefore = await count('SELECT count(*)::int AS n FROM trials WHERE experiment_id = $1', [exp.id]);

    // the grader fix: only the graders change (and the version), so the new ones apply
    const fixed = { ...GRADED_TASK, version: '2', graders: GRADED_TASK.graders.map((g) => (g.id === 'emi' ? { ...g, tolerance: { rel: 0.01 } } : g)) };
    await writeTask(fixed, GRADER_PY);
    const queued = (await request(env.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(202)).body as RegradeResponse;
    expect(queued).toEqual({ experiment_id: exp.id, trials: 1, queued: 1, no_graders: 0, superseded: 0, from_trial_task: 0 });
    // a second click replaces the queued job instead of adding another
    expect(((await request(env.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(202)).body as RegradeResponse).superseded).toBe(1);
    expect((await trial(trialId)).grading.pending).toMatchObject({ status: 'queued', reason: 'regrade' });

    const job = (await claimGrading())!;
    expect(job.trial_id).toBe(trialId);
    expect(job.task.grader_source).toBe('catalogue');
    expect(job.task.sha256).not.toBe(tasks['emi-graded']);
    expect(job.task.note).toContain('only in its graders');
    const emiBefore = firstJob.graders.find((g) => (g.spec as { id: string }).id === 'emi')!;
    const emiAfter = job.graders.find((g) => (g.spec as { id: string }).id === 'emi')!;
    expect(emiAfter.spec_sha256).not.toBe(emiBefore.spec_sha256);
    const res = (await report(job).expect(200)).body as GradesReportResponse;
    // 4 graders are unchanged and gave the same answer, so their rows are reused; emi is new
    expect(res).toMatchObject({ outcome: 'pass', grades_stored: 1, grades_reused: 4 });

    const view = await trial(trialId);
    expect(view.grading.current).toMatchObject({ job_id: job.job_id, outcome: 'pass', reason: 'regrade', grader_source: 'catalogue' });
    expect(view.grades.find((g) => g.grader_id === 'emi')).toMatchObject({ verdict: 'pass', grader_version: graderVersion(emiAfter.spec_sha256, FRAMEWORK) });
    const all = (await env.pool.query<{ grader_version: string; verdict: string }>(`SELECT grader_version, verdict FROM grades WHERE trial_id = $1 AND grader_id = 'emi' ORDER BY id`, [trialId])).rows;
    expect(all.map((g) => g.verdict)).toEqual(['fail', 'pass']); // the old grade is kept
    const current = (await env.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM current_grades WHERE trial_id = $1', [trialId])).rows[0];
    expect(current.n).toBe(5);
    expect(await count('SELECT count(*)::int AS n FROM trials WHERE experiment_id = $1', [exp.id])).toBe(trialsBefore);

    // a fix that changes the task itself does not apply to answers given to the old task
    await writeTask({ ...fixed, version: '3', messages: [{ role: 'user', content: 'What is my EMI on Rs 20 lakh?' }] }, GRADER_PY);
    const stale = (await request(env.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(202)).body as RegradeResponse;
    expect(stale.from_trial_task).toBe(1);
    const old = (await claimGrading())!;
    expect(old.task).toMatchObject({ grader_source: 'trial_task', sha256: tasks['emi-graded'] });
    expect(old.graders.map((g) => g.spec)).toEqual(GRADED_TASK.graders);
    // the old grader.py is not known; the rubric is not part of the task, so it is read as it is now (here: no such file)
    expect(old.grader_files).toEqual({ 'grader.py': null, 'configs/rubrics/advice.v1.md': null });
    await report(old).expect(200);
    await writeTask(GRADED_TASK, GRADER_PY);
  });

  it('answers 404 for an unknown experiment and 400 for a bad trial list', async () => {
    await request(env.http).post('/api/experiments/e_nope/regrade').send({}).expect(404);
    const exp = await experiment(['emi-ungraded']);
    await runTrials();
    await request(env.http).post(`/api/experiments/${exp.id}/regrade`).send({ trial_ids: 'all' }).expect(400);
    const r = (await request(env.http).post(`/api/experiments/${exp.id}/regrade`).send({}).expect(202)).body as RegradeResponse;
    expect(r).toMatchObject({ trials: 1, queued: 0, no_graders: 1 });
  });

  // The real Python grader worker against this API: set EVALS_GRADER_BIN to graders/.venv/bin/evals-grader.
  const graderBin = process.env.EVALS_GRADER_BIN;
  (graderBin ? it : it.skip)('is graded by the real evals-grader, with versions the API accepts', async () => {
    await drain();
    await experiment(['emi-graded']);
    const [trialId] = await runTrials();
    const port = ((env.app.getHttpServer() as unknown as Server).address() as AddressInfo).port;
    const { stderr } = await promisify(execFile)(graderBin!, ['--once'], {
      env: { ...process.env, EVALS_API_URL: `http://127.0.0.1:${port}/api`, EVALS_WORKER_TOKEN: 'test-worker-token', EVALS_GRADER_ID: 'py-grader' },
      timeout: 60_000,
    });
    const view = await trial(trialId);
    expect(view.grades.map((g) => [g.grader_id, g.verdict])).toEqual([
      ['answered', 'pass'],
      ['emi', 'pass'],
      ['emi-tool', 'pass'],
      ['unit', 'pass'],
      ['tone', 'not_implemented'],
    ]);
    expect(view.grading.current).toMatchObject({ outcome: 'pass', passed: true, framework_version: FRAMEWORK });
    const emi = view.grades[1].evidence as { source: string; quote?: string }[];
    expect(emi[0]).toEqual({ source: 'final_answer', quote: 'Your EMI is Rs 8,997.26.' });
    expect(emi[1]).toMatchObject({ source: 'tool_result', quote: '"emi": "8997.26"' });
    expect(stderr).toContain(`trial ${trialId}: pass (answered=pass, emi=pass, emi-tool=pass, unit=pass, tone=not_implemented)`);
  });
  if (!graderBin) console.warn('EVALS_GRADER_BIN is not set: the real evals-grader e2e test is SKIPPED, not passed.');
});
