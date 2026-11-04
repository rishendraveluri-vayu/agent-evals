import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import type { ExperimentDetail, GraderClaimResponse, JudgeApprovalResponse, JudgeRevokeResponse, Json, SpendView } from '../src/contract';
import { graderVersion, specSha256 } from '../src/grading/grading-core';
import { type TestEnv, auth, bootEnv, catalogue, makeConfig } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';
import type { StubKey } from './support/litellm-stub';

/**
 * SP4, R8: real-model judging only with an approval per experiment, with a model and a budget.
 * The API mints one LiteLLM key for it (limited to the model, capped at the budget) and hands it
 * to the grader worker in the grading claim; no UI-facing route shows it. A judge's rubric is
 * part of its grader version. No model is called: the LiteLLM stub stands in.
 */

const RUBRIC = 'configs/rubrics/open-coding.v0.md';
const JUDGED_TASK: { id: string; graders: Json[] } & Record<string, Json> = {
  id: 'emi-judged',
  version: '1',
  split: 'discovery',
  summary: 'EMI with a judge (test fixture)',
  messages: [{ role: 'user', content: 'What is my EMI on Rs 10 lakh at 9% for 20 years?' }],
  client_sim: null,
  client_state: 'client.json',
  graders: [
    { id: 'answered', type: 'end_state', states: ['answered'] },
    { id: 'overall', type: 'judge', required: false, rubric: RUBRIC, criteria: [{ id: 'overall', text: 'Would a real client be well served?' }] },
    // A rubric outside configs/rubrics is never read: no file, like a bad unit_test file name.
    { id: 'sneaky', type: 'judge', required: false, rubric: 'configs/rubrics/../prompts/finance-advisor.v1.md', criteria: ['c'] },
  ],
};
const FRAMEWORK = '0.1.0';
const sha = (data: string | Buffer): string => `sha256:${createHash('sha256').update(data).digest('hex')}`;

describeWithDb('LLM judge approval and its key (e2e, real Postgres)', () => {
  let env: TestEnv;
  let config: string;
  let taskSha: string;
  let eng: ReturnType<typeof engine>;

  beforeAll(async () => {
    env = await bootEnv();
    const dir = path.join(env.tasksDir, JUDGED_TASK.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(JUDGED_TASK, null, 2));
    await fs.writeFile(path.join(dir, 'client.json'), '{"name": "Test Client (synthetic)"}');
    const cat = await catalogue(env.http);
    taskSha = cat.tasks[JUDGED_TASK.id];
    config = await makeConfig(env.http, cat, { name: 'judged arm' });
    eng = engine(env);
  });

  afterAll(async () => {
    await env?.close();
  });

  afterEach(() => {
    env.stub.failSpendLogs = null;
    env.stub.failKeyDelete = null;
    env.stub.keyDelayMs = 0;
  });

  // ---- helpers ----

  /** An experiment on the judged task with its one trial run and reported (no model called). */
  async function finishedExperiment(): Promise<{ exp: ExperimentDetail; trialId: string }> {
    await eng.quiesce();
    const exp = await eng.experiment({ config_hashes: [config], task_sha256s: [taskSha], n: 1 });
    const c = (await eng.claim('w1'))!;
    await eng.report(c, 'w1', 'agent');
    return { exp, trialId: c.trial_id };
  }

  async function claimGrading(worker = 'g1'): Promise<GraderClaimResponse | null> {
    const res = await request(env.http).post('/api/grader/claim').set(auth).send({ worker_id: worker });
    if (res.status === 204) return null;
    expect(res.status).toBe(200);
    return res.body as GraderClaimResponse;
  }

  /** Reports the job with every grader not_implemented, as the Python framework would without a judge. */
  async function report(job: GraderClaimResponse): Promise<void> {
    const grades = job.graders.map((g) => {
      const spec = g.spec as { id: string; type: string; required?: boolean };
      return { grader_id: spec.id, type: spec.type, required: spec.required !== false, verdict: 'not_implemented', score: null, reason: 'x', evidence: [], grader_version: graderVersion(g.spec_sha256, FRAMEWORK) };
    });
    await request(env.http).post(`/api/grader/trials/${job.trial_id}/grades`).set(auth).send({ worker_id: 'g1', job_id: job.job_id, attempt: job.attempt, framework_version: FRAMEWORK, grades }).expect(200);
  }

  /** Claims and reports every grading job waiting, so a test starts with an empty grading queue. */
  async function drain(): Promise<void> {
    for (let job = await claimGrading(); job; job = await claimGrading()) await report(job);
  }

  /** The job for this trial (draining others first), claimed. */
  async function jobFor(trialId: string): Promise<GraderClaimResponse> {
    for (;;) {
      const job = await claimGrading();
      if (!job) throw new Error(`no grading job for ${trialId}`);
      if (job.trial_id === trialId) return job;
      await report(job);
    }
  }

  const regrade = (expId: string) => request(env.http).post(`/api/experiments/${expId}/regrade`).send({}).expect(202);
  const approve = (expId: string, body: unknown) => request(env.http).post(`/api/experiments/${expId}/judge`).send(body as object);
  const revoke = (expId: string) => request(env.http).delete(`/api/experiments/${expId}/judge`);
  const detail = async (expId: string): Promise<ExperimentDetail> => (await request(env.http).get(`/api/experiments/${expId}`).expect(200)).body as ExperimentDetail;
  const spend = async (): Promise<SpendView> => (await request(env.http).get('/api/spend').expect(200)).body as SpendView;
  const judgeKey = (expId: string): StubKey => env.stub.liveKeys().find((k) => k.key_alias === `judge-${expId}`)!;
  const errorOf = (res: { body: unknown }): string => (res.body as { error: string }).error;

  // ---- tests ----

  it('refuses a bad approval and mints nothing', async () => {
    const { exp } = await finishedExperiment();
    const before = env.stub.keys.size;
    expect(errorOf(await approve('e_nope', { model: 'fake/judge', budget_usd: 1 }).expect(404))).toBe('unknown_experiment');
    for (const body of [{}, [], { model: 'fake/judge' }, { budget_usd: 1 }, { model: '', budget_usd: 1 }, { model: 'fake/judge', budget_usd: 0 }, { model: 'fake/judge', budget_usd: -1 }, { model: 'fake/judge', budget_usd: 20.01 }, { model: 'fake/judge', budget_usd: '5' }]) {
      const res = await approve(exp.id, body).expect(400);
      expect(errorOf(res)).toBe('invalid_judge');
      expect((res.body as { fix?: string }).fix).toContain('budget_usd');
    }
    expect(errorOf(await approve(exp.id, { model: 'no-such-model', budget_usd: 1 }).expect(400))).toBe('unknown_model');
    // LiteLLM serves it but has no price for it, so its spend could not be capped or counted.
    expect(errorOf(await approve(exp.id, { model: 'unpriced-model', budget_usd: 1 }).expect(400))).toBe('unknown_model');
    expect(env.stub.keys.size).toBe(before);
    expect((await detail(exp.id)).judge).toBeNull();
    // the limit itself is allowed
    await approve(exp.id, { model: 'fake/judge', budget_usd: 20 }).expect(201);
    await revoke(exp.id).expect(200);
  });

  it('approves judging with one key, limited to the model and capped at the budget, and never shows the key', async () => {
    const { exp } = await finishedExperiment();
    const res = await approve(exp.id, { model: 'claude-haiku-5-5', budget_usd: 2.5 }).expect(201);
    const body = res.body as JudgeApprovalResponse;
    expect(body).toEqual({ experiment_id: exp.id, model: 'claude-haiku-5-5', budget_usd: 2.5, approved_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string });
    const key = judgeKey(exp.id);
    expect(key).toMatchObject({ models: ['claude-haiku-5-5'], max_budget: 2.5, team_id: null, metadata: { experiment_id: exp.id, kind: 'judge' } });
    // one active approval per experiment
    expect(errorOf(await approve(exp.id, { model: 'fake/judge', budget_usd: 1 }).expect(409))).toBe('judge_already_approved');
    expect(env.stub.liveKeys().filter((k) => k.key_alias === `judge-${exp.id}`)).toHaveLength(1);

    expect((await detail(exp.id)).judge).toEqual({ model: 'claude-haiku-5-5', budget_usd: 2.5, spend_usd: 0, approved_at: body.approved_at });
    env.stub.spendLogs.set(key.token, [
      { request_id: 'r1', status: 'success', spend: 0.01 },
      { request_id: 'r2', status: 'success', spend: 0.0023 },
    ]);
    expect((await detail(exp.id)).judge?.spend_usd).toBe(0.0123);
    // LiteLLM unreachable: the spend is unknown, not zero, and the page still loads
    env.stub.failSpendLogs = 500;
    expect((await detail(exp.id)).judge).toMatchObject({ model: 'claude-haiku-5-5', spend_usd: null });
    env.stub.failSpendLogs = null;

    // the key is in no UI-facing answer
    const pages = [
      (await request(env.http).get(`/api/experiments/${exp.id}`).expect(200)).text,
      (await request(env.http).get('/api/experiments').expect(200)).text,
      (await request(env.http).get('/api/spend').expect(200)).text,
      (await request(env.http).post(`/api/experiments/${exp.id}/pause`).expect((r) => expect([200, 409]).toContain(r.status))).text,
      res.text,
    ];
    for (const page of pages) {
      expect(page).not.toContain(key.key);
      expect(page).not.toContain(key.token);
    }
    await revoke(exp.id).expect(200);
  });

  it('two approvals at once: one wins, the other is 409 and its key is deleted', async () => {
    const { exp } = await finishedExperiment();
    env.stub.keyDelayMs = 150;
    const [a, b] = await Promise.all([approve(exp.id, { model: 'fake/judge', budget_usd: 1 }), approve(exp.id, { model: 'fake/judge', budget_usd: 1 })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(env.stub.liveKeys().filter((k) => k.key_alias === `judge-${exp.id}`)).toHaveLength(1);
    await revoke(exp.id).expect(200);
  });

  it('hands the key to the grader only while judging is approved, with the task summary, read at claim time', async () => {
    await drain();
    const { exp, trialId } = await finishedExperiment();
    const first = await jobFor(trialId);
    expect(first.judge).toBeNull();
    expect(first.task.summary).toBe('EMI with a judge (test fixture)');
    await report(first);

    // approved after the trial finished: the next regrade's claim carries it
    await approve(exp.id, { model: 'fake/judge', budget_usd: 1.5 }).expect(201);
    const key = judgeKey(exp.id);
    await regrade(exp.id);
    const approved = await jobFor(trialId);
    expect(approved.judge).toEqual({ base_url: `${env.stub.url}/v1`, api_key: key.key, model: 'fake/judge' });
    expect(approved.task.summary).toBe('EMI with a judge (test fixture)');

    // another experiment's trial gets no key
    const other = await finishedExperiment();
    await report(approved);
    const unapproved = await jobFor(other.trialId);
    expect(unapproved.judge).toBeNull();
    await report(unapproved);

    // a lapsed claim taken again after a revoke carries no key
    await regrade(exp.id);
    const held = await jobFor(trialId);
    expect(held.judge?.api_key).toBe(key.key);
    const revoked = (await revoke(exp.id).expect(200)).body as JudgeRevokeResponse;
    expect(revoked).toEqual({ experiment_id: exp.id, revoked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string });
    await env.pool.query(`UPDATE grading_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [held.job_id]);
    const again = await jobFor(trialId);
    expect(again.job_id).toBe(held.job_id);
    expect(again.judge).toBeNull();
    await report(again);
    await regrade(exp.id);
    expect((await jobFor(trialId)).judge).toBeNull();
    await drain();
  });

  it('revokes: deletes the key in LiteLLM, then 404, and approves again with a new key', async () => {
    const { exp } = await finishedExperiment();
    expect(errorOf(await revoke(exp.id).expect(404))).toBe('no_judge_approval');
    expect(errorOf(await revoke('e_nope').expect(404))).toBe('unknown_experiment');
    await approve(exp.id, { model: 'fake/judge', budget_usd: 1 }).expect(201);
    const first = judgeKey(exp.id);

    // LiteLLM failing: the approval stays active, so a key that still works is never shown as revoked
    env.stub.failKeyDelete = 500;
    expect(errorOf(await revoke(exp.id).expect(502))).toBe('litellm_error');
    expect((await detail(exp.id)).judge).not.toBeNull();
    env.stub.failKeyDelete = null;

    await revoke(exp.id).expect(200);
    expect(env.stub.deleted).toContain(first.token);
    expect((await detail(exp.id)).judge).toBeNull();
    expect(errorOf(await revoke(exp.id).expect(404))).toBe('no_judge_approval');

    await approve(exp.id, { model: 'fake/judge', budget_usd: 3 }).expect(201);
    const second = judgeKey(exp.id);
    expect(second.token).not.toBe(first.token);
    expect((await detail(exp.id)).judge).toMatchObject({ budget_usd: 3 });
    // a key LiteLLM no longer has counts as deleted
    env.stub.deleted.push(second.token);
    await revoke(exp.id).expect(200);
  });

  it('GET /spend shows judge spend as its own line, revoked approvals included', async () => {
    const before = await spend();
    expect(before.judge_usd).not.toBeNull();
    const a = await finishedExperiment();
    const b = await finishedExperiment();
    await approve(a.exp.id, { model: 'fake/judge', budget_usd: 1 }).expect(201);
    await approve(b.exp.id, { model: 'fake/judge', budget_usd: 1 }).expect(201);
    env.stub.spendLogs.set(judgeKey(a.exp.id).token, [{ spend: 0.25 }]);
    env.stub.spendLogs.set(judgeKey(b.exp.id).token, [{ spend: 0.5 }, { spend: '0.125' }]);
    await revoke(a.exp.id).expect(200);

    const after = await spend();
    expect(after.judge_approvals).toBe(before.judge_approvals + 2);
    expect(after.judge_usd! - before.judge_usd!).toBeCloseTo(0.875, 8);
    expect(after.trials_usd).toBeCloseTo(before.trials_usd + 2 * 0.00136, 8); // the two trials' own cost, judge apart
    expect(after.system_usd).toBe(before.system_usd);
    expect(after.total_usd).toBeCloseTo(after.trials_usd + after.system_usd + after.judge_usd!, 8);

    // LiteLLM unreachable: an active key's spend is unknown, so the judge line is null, not a guess
    env.stub.failSpendLogs = 500;
    const down = await spend();
    expect(down.judge_usd).toBeNull();
    expect(down.total_usd).toBeCloseTo(down.trials_usd + down.system_usd, 8);
    env.stub.failSpendLogs = null;

    // once revoked, what the log said at revoke is the fallback
    await revoke(b.exp.id).expect(200);
    env.stub.failSpendLogs = 500;
    const revokedDown = await spend();
    expect(revokedDown.judge_usd! - before.judge_usd!).toBeCloseTo(0.875, 8);
  });

  it('puts the rubric in the grader set, so editing it gives new grade versions', async () => {
    await drain();
    const { exp, trialId } = await finishedExperiment();
    const file = path.join(env.configsDir, 'rubrics', 'open-coding.v0.md');
    const original = await fs.readFile(file);
    try {
      const job = await jobFor(trialId);
      expect(job.grader_files[RUBRIC]).toEqual({ sha256: sha(original), base64: original.toString('base64') });
      expect(Object.keys(job.grader_files)).toEqual([RUBRIC]); // the sneaky path is never read
      const [answered, overall, sneaky] = job.graders;
      expect(overall.spec_sha256).toBe(specSha256(JUDGED_TASK.graders[1], { [RUBRIC]: sha(original) }));
      expect(sneaky.spec_sha256).toBe(specSha256(JUDGED_TASK.graders[2], {}));
      await report(job);

      const edited = Buffer.concat([original, Buffer.from('\nAlso: name the next step.\n')]);
      await fs.writeFile(file, edited);
      await regrade(exp.id);
      const after = await jobFor(trialId);
      expect(after.grader_files[RUBRIC]?.sha256).toBe(sha(edited));
      expect(after.graders[1].spec_sha256).not.toBe(overall.spec_sha256);
      expect(after.graders[0].spec_sha256).toBe(answered.spec_sha256);
      expect(after.graders[2].spec_sha256).toBe(sneaky.spec_sha256);
      await report(after);
      // the old judge grade is kept next to the new version
      const rows = (await env.pool.query<{ grader_version: string }>(`SELECT grader_version FROM grades WHERE trial_id = $1 AND grader_id = 'overall' ORDER BY id`, [trialId])).rows;
      expect(rows.map((r) => r.grader_version)).toEqual([graderVersion(overall.spec_sha256, FRAMEWORK), graderVersion(after.graders[1].spec_sha256, FRAMEWORK)]);
    } finally {
      await fs.writeFile(file, original);
    }
  });
});
