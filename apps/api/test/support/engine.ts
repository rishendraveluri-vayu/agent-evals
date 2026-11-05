import request from 'supertest';
import type { ClaimResponse, ExperimentDetail, GraderClaimResponse, ReportResponse } from '../../src/contract';
import { graderVersion } from '../../src/grading/grading-core';
import { type TestEnv, auth, runnerReport } from './app';

/** Any framework version will do: the grade's version is computed from it and the spec. */
const GRADER_FRAMEWORK = 'test-grader-0';

/**
 * Worker-side helpers for the run-control tests: create and start experiments, claim like a
 * worker, and report a result with the label, end state and cost a test needs. No real model is
 * called; the reports are what a runner would send.
 */
export function engine(env: TestEnv) {
  async function experiment(body: Record<string, unknown>, opts: { start?: boolean; expect?: number } = {}): Promise<ExperimentDetail> {
    const res = await request(env.http)
      .post('/api/experiments')
      .send({ name: 'run controls', axis: 'temperature', n: 1, sim_model: null, budget_usd: 50, ...body });
    if (res.status !== (opts.expect ?? 201)) throw new Error(`experiment: ${res.status} ${JSON.stringify(res.body)}`);
    const exp = res.body as ExperimentDetail;
    if (opts.start !== false && res.status === 201) await request(env.http).post(`/api/experiments/${exp.id}/start`).expect(200);
    return exp;
  }

  async function claim(worker: string, harness = 'ownloop'): Promise<ClaimResponse | null> {
    const res = await request(env.http).post('/api/worker/claim').set(auth).send({ worker_id: worker, harness });
    if (res.status === 204) return null;
    if (res.status !== 200) throw new Error(`claim: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ClaimResponse;
  }

  /** Reports a claimed trial. `end_state` defaults to answered for agent, harness_error otherwise. */
  async function report(
    c: ClaimResponse,
    worker: string,
    label = 'agent',
    opts: { end_state?: string; cost_usd?: number; result?: Record<string, unknown> | null; last_status?: string; checks?: Record<string, unknown> } = {},
  ): Promise<ReportResponse> {
    const rr = runnerReport(c.trial_id, c.attempt, label);
    if (opts.end_state) rr.end_state = opts.end_state;
    if (opts.checks) rr.checks = opts.checks;
    const usage = rr.proxy_usage as Record<string, unknown>;
    if (opts.cost_usd !== undefined) usage.cost_usd = opts.cost_usd;
    if (opts.last_status) usage.last_status = opts.last_status;
    const res = await request(env.http)
      .post(`/api/worker/trials/${c.trial_id}/report`)
      .set(auth)
      .send({ worker_id: worker, attempt: c.attempt, runner_report: rr, result: opts.result ?? null, spans: [], files: [] });
    if (res.status !== 200) throw new Error(`report: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as ReportResponse;
  }

  const detail = async (id: string): Promise<ExperimentDetail> => (await request(env.http).get(`/api/experiments/${id}`).expect(200)).body as ExperimentDetail;

  const configOf = (c: ClaimResponse): string => (c.spec as { trial: { config_hash: string } }).trial.config_hash;

  /** Cancels every experiment that could still hand out trials, so a test starts with an empty queue. */
  async function quiesce(): Promise<void> {
    const { rows } = await env.pool.query<{ id: string }>("SELECT id FROM experiments WHERE status IN ('created', 'running', 'paused')");
    for (const { id } of rows) await request(env.http).post(`/api/experiments/${id}/cancel`).expect(200);
  }

  /**
   * Grades every done trial waiting for grading, as the grader worker would (SP4), and returns the
   * ids graded. `verdict` picks each trial's outcome: `pass` or `fail` on its first grader (taken
   * as required), `incomplete` as an `error` on it; any other grader is optional and not
   * implemented. Trials it does not know pass.
   */
  async function grade(worker: string, verdict: (trialId: string) => 'pass' | 'fail' | 'incomplete' = () => 'pass'): Promise<string[]> {
    const graded: string[] = [];
    for (;;) {
      const res = await request(env.http).post('/api/grader/claim').set(auth).send({ worker_id: worker });
      if (res.status === 204) return graded;
      if (res.status !== 200) throw new Error(`grader claim: ${res.status} ${JSON.stringify(res.body)}`);
      const job = res.body as GraderClaimResponse;
      const v = verdict(job.trial_id);
      const grades = job.graders.map((g, i) => {
        const spec = g.spec as { id: string; type?: string };
        const first = i === 0;
        const word = first ? (v === 'incomplete' ? 'error' : v) : 'not_implemented';
        return {
          grader_id: spec.id,
          type: spec.type ?? 'exact_number',
          required: first,
          verdict: word,
          score: word === 'pass' ? 1 : word === 'fail' ? 0 : null,
          reason: `${spec.id}: ${word}`,
          evidence: [],
          grader_version: graderVersion(g.spec_sha256, GRADER_FRAMEWORK),
        };
      });
      const out = await request(env.http)
        .post(`/api/grader/trials/${job.trial_id}/grades`)
        .set(auth)
        .send({ worker_id: worker, job_id: job.job_id, attempt: job.attempt, framework_version: GRADER_FRAMEWORK, grades });
      if (out.status !== 200) throw new Error(`grades: ${out.status} ${JSON.stringify(out.body)}`);
      graded.push(job.trial_id);
    }
  }

  return { experiment, claim, report, detail, configOf, quiesce, grade };
}
