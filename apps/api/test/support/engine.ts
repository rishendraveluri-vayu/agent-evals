import request from 'supertest';
import type { ClaimResponse, ExperimentDetail, ReportResponse } from '../../src/contract';
import { type TestEnv, auth, runnerReport } from './app';

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
    opts: { end_state?: string; cost_usd?: number; result?: Record<string, unknown> | null; last_status?: string } = {},
  ): Promise<ReportResponse> {
    const rr = runnerReport(c.trial_id, c.attempt, label);
    if (opts.end_state) rr.end_state = opts.end_state;
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

  return { experiment, claim, report, detail, configOf, quiesce };
}
