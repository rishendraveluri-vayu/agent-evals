import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import type { CompareResponse, ExperimentDetail, GraderClaimResponse, GraderVersionCount, Json, RegradeResponse, TrialRowSummary } from '../src/contract';
import { sha256Ref } from '../src/common/hashing';
import { graderVersion, specSha256 } from '../src/grading/grading-core';
import { type TestEnv, auth, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/**
 * D72 on the real API and Postgres: a comparison gives no verdict when, on a task, a required
 * grader's current grades in the two arms come from different grader versions (its spec, a file it
 * reads such as a judge rubric, or the judge model); an optional grader's difference is reported
 * and the verdict stands; a regrade, which also covers a reused arm A's trials (D34), brings the
 * arms onto one version and the verdict back. The grader is played by the test over the grader
 * protocol, and the judge is the LiteLLM stub's fake model: no model is called. Tasks and rubrics
 * are synthetic, written for this file only.
 */

const FRAMEWORK = 'test-grader-d72';

jest.setTimeout(60_000);

type Grader = Record<string, Json>;

describeWithDb('arms graded alike, or no verdict (D72, e2e, real Postgres)', () => {
  let env: TestEnv;
  let e: ReturnType<typeof engine>;
  let A: string;
  let B: string;

  beforeAll(async () => {
    env = await bootEnv();
    e = engine(env);
    const cat = await catalogue(env.http);
    A = await makeConfig(env.http, cat, { name: 'arm A', settings: { temperature: 0.1 } });
    B = await makeConfig(env.http, cat, { name: 'arm B', settings: { temperature: 0.8 } });
  });

  afterAll(async () => {
    await env?.close();
  });

  beforeEach(async () => {
    await e.quiesce();
    await gradeAll();
  });

  // ---- helpers ----

  const rubricPath = (name: string): string => `configs/rubrics/${name}.md`;
  const writeRubric = (name: string, text: string): Promise<void> => fs.writeFile(path.join(env.configsDir, 'rubrics', `${name}.md`), text);
  const judge = (rubric: string, required: boolean): Grader => ({ id: 'advice', type: 'judge', required, rubric: rubricPath(rubric), criteria: [{ id: 'helpful', text: 'Is the reply helpful? (test fixture)' }] });
  const answered: Grader = { id: 'answered', type: 'end_state', states: ['answered'] };

  async function writeTask(id: string, graders: Grader[], version = '1'): Promise<string> {
    await fs.mkdir(path.join(env.tasksDir, id), { recursive: true });
    const task = { id, version, split: 'held_out', summary: `D72 task ${id} (test fixture)`, messages: [{ role: 'user', content: `Question ${id}` }], client_sim: null, graders };
    await fs.writeFile(path.join(env.tasksDir, id, 'task.json'), JSON.stringify(task, null, 2));
    return (await catalogue(env.http)).tasks[id];
  }

  /** The version a grader's grades carry when its rubric file holds `text`. */
  const judgeVersion = (spec: Grader, text: string): string => graderVersion(specSha256(spec, { [spec.rubric as string]: sha256Ref(Buffer.from(text)) }), FRAMEWORK);

  /**
   * Grades every job waiting, as the grader worker would report it: every grader passes, with
   * `required` as its spec says; a judge passes with its call's model in the evidence when the
   * claim carries an approved judge, else it is not_implemented, as the Python judge answers.
   */
  async function gradeAll(): Promise<number> {
    let n = 0;
    for (;;) {
      const res = await request(env.http).post('/api/grader/claim').set(auth).send({ worker_id: 'g-d72' });
      if (res.status === 204) return n;
      if (res.status !== 200) throw new Error(`grader claim: ${res.status} ${JSON.stringify(res.body)}`);
      const job = res.body as GraderClaimResponse;
      const grades = job.graders.map((g) => {
        const spec = g.spec as { id: string; type: string; required?: boolean };
        const unjudged = spec.type === 'judge' && !job.judge;
        const verdict = unjudged ? 'not_implemented' : 'pass';
        const call = spec.type === 'judge' && job.judge ? [{ criterion: 'helpful', verdict: 'yes', quote: 'Question', reason: 'r' }, { source: 'judge_call', model: job.judge.model, status: 200 }] : [];
        return { grader_id: spec.id, type: spec.type, required: spec.required !== false, verdict, score: unjudged ? null : 1, reason: `${spec.id}: ${verdict}`, evidence: call, grader_version: graderVersion(g.spec_sha256, FRAMEWORK) };
      });
      await request(env.http)
        .post(`/api/grader/trials/${job.trial_id}/grades`)
        .set(auth)
        .send({ worker_id: 'g-d72', job_id: job.job_id, attempt: job.attempt, framework_version: FRAMEWORK, grades })
        .expect(200);
      n += 1;
    }
  }

  /** Claims and reports every trial that can be claimed now. */
  async function runTrials(worker = 'w-d72'): Promise<number> {
    let n = 0;
    for (let c = await e.claim(worker); c; c = await e.claim(worker)) {
      await e.report(c, worker, 'agent');
      n += 1;
    }
    return n;
  }

  const compare = async (id: string): Promise<CompareResponse> => (await request(env.http).get(`/api/experiments/${id}/compare`).expect(200)).body as CompareResponse;
  const trials = async (id: string): Promise<TrialRowSummary[]> => (await request(env.http).get(`/api/experiments/${id}/trials`).expect(200)).body as TrialRowSummary[];
  const regrade = async (id: string, trialIds?: string[]): Promise<RegradeResponse> =>
    (await request(env.http).post(`/api/experiments/${id}/regrade`).send(trialIds ? { trial_ids: trialIds } : {}).expect(202)).body as RegradeResponse;
  const approve = (id: string, model = 'fake/judge') => request(env.http).post(`/api/experiments/${id}/judge`).send({ model, budget_usd: 1 }).expect(201);
  const armPause = (id: string, arm: 'A' | 'B') => request(env.http).post(`/api/experiments/${id}/arms/${arm}/pause`).expect(200);
  const armResume = (id: string, arm: 'A' | 'B') => request(env.http).post(`/api/experiments/${id}/arms/${arm}/resume`).expect(200);
  const byVersion = (vs: GraderVersionCount[]): GraderVersionCount[] => [...vs].sort((x, y) => String(x.grader_version).localeCompare(String(y.grader_version)));

  /** A started A/B on one task with arm B paused, so arm A runs and is graded first. */
  async function armAFirst(task: string, n: number): Promise<ExperimentDetail> {
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [task], n, futility: { enabled: false } });
    await armPause(exp.id, 'B');
    return exp;
  }

  // ---- 1: a reused baseline graded under an older rubric ----

  it("gives no verdict when a reused arm A was judged under an older rubric than arm B, until a regrade of the child brings both onto one version (required judge)", async () => {
    const V1 = 'Rubric v1 (test fixture): is the reply helpful?\n';
    const V2 = 'Rubric v2 (test fixture): is the reply helpful, and does it say why?\n';
    await writeRubric('d72-reuse', V1);
    const spec = judge('d72-reuse', true);
    const task = await writeTask('d72-reuse-req', [answered, spec]);
    // The parent: arm A alone, judged under rubric v1.
    const parent = await e.experiment({ config_hashes: [A], task_sha256s: [task], n: 2, futility: { enabled: false } });
    await approve(parent.id);
    expect(await runTrials()).toBe(2);
    expect(await gradeAll()).toBe(2);

    // The rubric is edited; a child reuses the parent's arm A (D34) and its arm B is judged under v2.
    await writeRubric('d72-reuse', V2);
    const child = await e.experiment({ config_hashes: [A, B], task_sha256s: [task], n: 2, parent_experiment_id: parent.id, reuse_baseline: true, futility: { enabled: false } });
    expect(child.baseline).toMatchObject({ applied: true, reused_trials: 2 });
    await approve(child.id);
    expect(await runTrials()).toBe(2);
    expect(await gradeAll()).toBe(2);

    const blocked = await compare(child.id);
    expect(blocked.status).toBe('complete');
    expect(blocked.stats).toBeNull();
    // The pass counts are still shown; only the verdict is withheld.
    expect(blocked.rows.map((r) => [r.arm, r.passed, r.graded])).toEqual([
      ['A', 2, 2],
      ['B', 2, 2],
    ]);
    expect(blocked.grader_versions).toEqual({
      alike: false,
      blocking: [
        {
          task,
          task_id: 'd72-reuse-req',
          grader_id: 'advice',
          required: true,
          kind: 'judge',
          changes: ['files'],
          versions: byVersion([
            { grader_version: judgeVersion(spec, V1), judge_model: 'fake/judge', a: 2, b: 0 },
            { grader_version: judgeVersion(spec, V2), judge_model: 'fake/judge', a: 0, b: 2 },
          ]),
        },
      ],
      optional: [],
      note: null,
    });
    expect(blocked.stats_note).toBe(
      'The two arms were not graded alike (D72): 1 required check on 1 of 1 task has current grades from different grader versions, which would score the arms by different rules: ' +
        'advice on d72-reuse-req (its rubric changed). ' +
        `Regrade the experiment (POST /api/experiments/${child.id}/regrade), which also regrades the 2 trials arm A reuses from ${parent.id} so every trial is graded with the graders as they are now; ` +
        'the verdict comes back once those grades are in.',
    );

    // The regrade covers the reused trials too: new grade versions, nothing overwritten.
    const gradesBefore = (await env.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM grades')).rows[0].n;
    expect(await regrade(child.id)).toEqual({ experiment_id: child.id, trials: 4, reused_trials: 2, queued: 4, no_graders: 0, superseded: 0, from_trial_task: 0 });
    expect((await compare(child.id)).stats_note).toBe('Grading is still running for 4 of 4 finished trials; the verdict waits for every grade.');
    expect(await gradeAll()).toBe(4);
    const back = await compare(child.id);
    expect(back.stats).toMatchObject({ verdict: 'no_detectable_difference', a: { passed: 2, graded: 2 }, b: { passed: 2, graded: 2 } });
    expect(back.stats_note).toBeNull();
    expect(back.grader_versions).toEqual({ alike: true, blocking: [], optional: [], note: null });
    // The reused trials' v1 grades stay as older versions; their v2 grades are new rows.
    const reusedIds = (await trials(parent.id)).map((t) => t.id);
    const versions = await env.pool.query<{ grader_version: string }>("SELECT DISTINCT grader_version FROM grades WHERE trial_id = ANY($1) AND grader_id = 'advice'", [reusedIds]);
    expect(versions.rows.map((r) => r.grader_version).sort()).toEqual([judgeVersion(spec, V1), judgeVersion(spec, V2)].sort());
    expect((await env.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM grades')).rows[0].n).toBeGreaterThan(gradesBefore);
  });

  it('reports an optional judge whose rubric differs between a reused arm A and arm B, and still gives the verdict', async () => {
    await writeRubric('d72-reuse-opt', 'Optional rubric v1 (test fixture)\n');
    const task = await writeTask('d72-reuse-opt', [answered, judge('d72-reuse-opt', false)]);
    const parent = await e.experiment({ config_hashes: [A], task_sha256s: [task], n: 2, futility: { enabled: false } });
    await approve(parent.id);
    await runTrials();
    await gradeAll();
    await writeRubric('d72-reuse-opt', 'Optional rubric v2 (test fixture)\n');
    const child = await e.experiment({ config_hashes: [A, B], task_sha256s: [task], n: 2, parent_experiment_id: parent.id, reuse_baseline: true, futility: { enabled: false } });
    await approve(child.id);
    await runTrials();
    await gradeAll();

    const cmp = await compare(child.id);
    expect(cmp.stats).toMatchObject({ verdict: 'no_detectable_difference' });
    expect(cmp.stats_note).toBeNull();
    expect(cmp.grader_versions).toMatchObject({ alike: false, blocking: [], optional: [{ task_id: 'd72-reuse-opt', grader_id: 'advice', required: false, changes: ['files'] }] });
    expect(cmp.grader_versions!.note).toBe(
      "1 optional check on 1 task has grades from different versions in the two arms (D72): advice on d72-reuse-opt (its rubric changed). Optional checks do not decide a trial's outcome, so the verdict stands; the regression list's pass rates for them compare different versions. A regrade brings them onto one version.",
    );
  });

  // ---- 2: a regrade of one arm's trials only ----

  it("gives no verdict after a regrade of one arm's trials only, and gives it back once the other arm is regraded", async () => {
    await writeRubric('d72-arm', 'Arm rubric v1 (test fixture)\n');
    const spec = judge('d72-arm', true);
    const task = await writeTask('d72-arm', [answered, spec]);
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [task], n: 2, futility: { enabled: false } });
    await approve(exp.id);
    expect(await runTrials()).toBe(4);
    await gradeAll();
    expect((await compare(exp.id)).grader_versions).toEqual({ alike: true, blocking: [], optional: [], note: null });

    await writeRubric('d72-arm', 'Arm rubric v2 (test fixture)\n');
    const rows = await trials(exp.id);
    const armA = rows.filter((t) => t.config_hash === A).map((t) => t.id);
    const armB = rows.filter((t) => t.config_hash === B).map((t) => t.id);
    expect(await regrade(exp.id, armA)).toMatchObject({ trials: 2, reused_trials: 0, queued: 2 });
    await gradeAll();
    const blocked = await compare(exp.id);
    expect(blocked.stats).toBeNull();
    expect(blocked.grader_versions!.blocking).toHaveLength(1);
    expect(byVersion(blocked.grader_versions!.blocking[0].versions)).toEqual(
      byVersion([
        { grader_version: judgeVersion(spec, 'Arm rubric v2 (test fixture)\n'), judge_model: 'fake/judge', a: 2, b: 0 },
        { grader_version: judgeVersion(spec, 'Arm rubric v1 (test fixture)\n'), judge_model: 'fake/judge', a: 0, b: 2 },
      ]),
    );
    expect(blocked.stats_note).toContain('advice on d72-arm (its rubric changed)');
    expect(blocked.stats_note).toContain(`Regrade the experiment (POST /api/experiments/${exp.id}/regrade) so every trial`);

    expect(await regrade(exp.id, armB)).toMatchObject({ trials: 2, queued: 2 });
    await gradeAll();
    const back = await compare(exp.id);
    expect(back.stats).not.toBeNull();
    expect(back.grader_versions!.alike).toBe(true);
  });

  // ---- 3: a grader spec edited while the experiment is still being graded ----

  it('gives no verdict when a required grader spec is edited between grading one arm and the other, and gives it with an optional one', async () => {
    const tone: Grader = { id: 'tone', type: 'regex_absent', required: false, pattern: 'guaranteed' };
    const first = await writeTask('d72-edit', [answered, tone]);
    // An optional check edited mid-grading: reported, the verdict stands.
    const opt = await armAFirst(first, 2);
    expect(await runTrials()).toBe(2);
    expect(await gradeAll()).toBe(2);
    await writeTask('d72-edit', [answered, { ...tone, pattern: 'guarantee' }], '2');
    await armResume(opt.id, 'B');
    expect(await runTrials()).toBe(2);
    await gradeAll();
    const optCmp = await compare(opt.id);
    expect(optCmp.stats).not.toBeNull();
    expect(optCmp.grader_versions).toMatchObject({ alike: false, blocking: [], optional: [{ grader_id: 'tone', required: false, changes: ['spec'] }] });
    // Arm A's 2 trials on the first spec, arm B's 2 on the second.
    expect(optCmp.grader_versions!.optional[0].versions.map((v) => [v.a, v.b]).sort()).toEqual([
      [0, 2],
      [2, 0],
    ]);
    expect(optCmp.grader_versions!.note).toContain('tone on d72-edit (its spec changed)');

    // A required check edited mid-grading: no verdict, until a regrade.
    const second = (await catalogue(env.http)).tasks['d72-edit'];
    const req = await armAFirst(second, 2);
    await runTrials();
    await gradeAll();
    await writeTask('d72-edit', [{ ...answered, states: ['answered', 'step_limit'] }, { ...tone, pattern: 'guarantee' }], '3');
    await armResume(req.id, 'B');
    await runTrials();
    await gradeAll();
    const blocked = await compare(req.id);
    expect(blocked.stats).toBeNull();
    expect(blocked.grader_versions).toMatchObject({ alike: false, blocking: [{ grader_id: 'answered', required: true, kind: 'state', changes: ['spec'] }], optional: [] });
    expect(blocked.stats_note).toContain('1 required check on 1 of 1 task has current grades from different grader versions');
    expect(blocked.stats_note).toContain('answered on d72-edit (its spec changed)');
    expect(blocked.stats_note).not.toContain('reuses');
    await regrade(req.id);
    await gradeAll();
    expect((await compare(req.id)).stats).not.toBeNull();
  });

  it('gives no verdict when the judge model changed between the arms under the same rubric', async () => {
    await writeRubric('d72-model', 'Model rubric (test fixture)\n');
    const task = await writeTask('d72-model', [answered, judge('d72-model', true)]);
    const exp = await armAFirst(task, 1);
    await approve(exp.id, 'fake/judge');
    await runTrials();
    await gradeAll();
    // Judging is approved again on another model before arm B is graded.
    await request(env.http).delete(`/api/experiments/${exp.id}/judge`).expect(200);
    await approve(exp.id, 'fake/gpt-4o-mini');
    await armResume(exp.id, 'B');
    await runTrials();
    await gradeAll();
    const cmp = await compare(exp.id);
    expect(cmp.stats).toBeNull();
    expect(cmp.grader_versions!.blocking).toMatchObject([{ grader_id: 'advice', changes: ['judge_model'] }]);
    expect(cmp.stats_note).toContain('advice on d72-model (judge models fake/gpt-4o-mini and fake/judge)');
  });
});
