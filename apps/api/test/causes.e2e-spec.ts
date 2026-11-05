import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import type { ClaimResponse, CompareResponse, GraderClaimResponse, TrialRowSummary, TrialView } from '../src/contract';
import { graderVersion } from '../src/grading/grading-core';
import { type TestEnv, auth, bootEnv, catalogue, makeConfig, runnerReport } from './support/app';
import { describeWithDb } from './support/db';
import { engine } from './support/engine';

/**
 * D64 on the real API and Postgres: each trial's failure cause on the trial rows, the trial page,
 * the comparison's regression list and the export, and each arm's behaviour on the comparison.
 * No model is called: the test plays the worker (tool spans, end states) and the grader (grades
 * with the reasons and evidence evals_graders writes). The tasks, trials and the one label are
 * synthetic, written for this file only; the label goes into the throwaway database, never labels/.
 */

jest.setTimeout(60_000);

const TASKS = {
  'cause-emi': {
    required_tools: ['list_debts'],
    graders: [
      { id: 'used-emi', type: 'tool_called', tool: 'calculate_emi', args: { principal: 1000000 } },
      { id: 'emi-value', type: 'number', severity: 'critical' },
      { id: 'every-amount', type: 'provenance' },
      { id: 'overall', type: 'judge', required: false, criteria: [{ id: 'clear', text: 'Clear to a client (test criterion)' }] },
    ],
  },
  'cause-fd': {
    graders: [
      { id: 'used-fd', type: 'tool_called', tool: 'fd_maturity' },
      { id: 'maturity', type: 'number' },
    ],
  },
};

type Scenario = {
  calls: { name: string; args?: Record<string, unknown>; error?: boolean }[];
  end_state?: string;
  model_calls: number;
  answer?: string | null;
  stop?: string;
  /** Per grader id: verdict, reason and evidence; any grader not named passes. */
  grades?: Record<string, { verdict: string; reason: string; evidence?: Record<string, unknown>[] }>;
};

const PASS: Scenario = { calls: [{ name: 'list_debts' }, { name: 'calculate_emi', args: { principal: 1000000 } }], model_calls: 3 };

/** What each arm does on each task, by repeat. */
function scenario(arm: 'A' | 'B', task: string, repeat: number): Scenario {
  if (task === 'cause-emi') {
    if (arm === 'A' && repeat === 0) return PASS;
    if (arm === 'A') {
      return { ...PASS, grades: { 'every-amount': { verdict: 'fail', reason: "1 of 2 amount(s) in the agent's replies have no tool result, client-file number or user message behind them: Rs 23,120, more than the 0 allowed", evidence: [{ source: 'final_answer', quote: 'Rs 23,120' }] } } };
    }
    if (repeat === 0) {
      return {
        calls: [{ name: 'list_debts' }, { name: 'amortization_schedule' }],
        model_calls: 3,
        grades: {
          'used-emi': { verdict: 'fail', reason: 'calculate_emi was called 0 time(s) with {\'principal\': 1000000}, need at least 1 (tools called: amortization_schedule, list_debts)' },
          'emi-value': { verdict: 'fail', reason: 'no rupee amount within ±1 of ₹8,997.26' },
        },
      };
    }
    return {
      calls: [{ name: 'list_debts' }, { name: 'calculate_emi', args: { principal: 900000 } }],
      model_calls: 3,
      grades: {
        'used-emi': {
          verdict: 'fail',
          reason: "calculate_emi was called 1 time(s), but 0 matched with {'principal': 1000000} (need 1)",
          evidence: [{ source: 'span', span_id: 'x', tool: 'calculate_emi', quote: '{"principal": 900000}' }],
        },
        overall: { verdict: 'fail', reason: 'judge: clear no', evidence: [{ criterion: 'clear', verdict: 'no', required: true, quote: '', reason: 'test' }, { source: 'judge_call', reply: 'x'.repeat(2000) }] },
      },
    };
  }
  if (arm === 'A') return { calls: [{ name: 'fd_maturity' }], model_calls: 2 };
  if (repeat === 0) {
    return {
      calls: [{ name: 'fd_maturity', error: true }, { name: 'fd_maturity', error: true }, { name: 'fd_maturity' }],
      end_state: 'step_limit',
      model_calls: 15,
      answer: null,
      stop: 'max_steps',
      grades: { maturity: { verdict: 'fail', reason: 'the agent gave no final answer to find a number in' } },
    };
  }
  return {
    calls: [],
    model_calls: 1,
    grades: {
      'used-fd': { verdict: 'fail', reason: 'fd_maturity was called 0 time(s), need at least 1 (tools called: none)' },
      maturity: { verdict: 'fail', reason: 'no rupee amount in the final_answer (expected ₹7,10,870)' },
    },
  };
}

describeWithDb('failure causes and behaviour per arm (D64, e2e, real Postgres)', () => {
  let env: TestEnv;
  let A: string;
  let B: string;
  let e: ReturnType<typeof engine>;
  let expId: string;
  /** trial id -> [arm, task, repeat] */
  const where = new Map<string, ['A' | 'B', string, number]>();

  beforeAll(async () => {
    env = await bootEnv();
    for (const [id, t] of Object.entries(TASKS)) {
      await fs.mkdir(path.join(env.tasksDir, id), { recursive: true });
      const task = { id, version: '1', split: 'held_out', summary: `Synthetic cause task ${id} (test fixture)`, messages: [{ role: 'user', content: `Question ${id}` }], client_sim: null, ...t };
      await fs.writeFile(path.join(env.tasksDir, id, 'task.json'), JSON.stringify(task, null, 2));
    }
    const cat = await catalogue(env.http);
    A = await makeConfig(env.http, cat, { name: 'arm A', settings: { temperature: 0.2 } });
    B = await makeConfig(env.http, cat, { name: 'arm B', settings: { temperature: 0.7 } });
    e = engine(env);
    const exp = await e.experiment({ config_hashes: [A, B], task_sha256s: [cat.tasks['cause-emi'], cat.tasks['cause-fd']], n: 2, futility: { enabled: false } });
    expId = exp.id;

    let n = 0;
    for (let c: ClaimResponse | null = await e.claim('w-cause'); c; c = await e.claim('w-cause')) {
      const spec = c.spec as { trial: { config_hash: string; repeat_index: number; task_id: string } };
      const arm = spec.trial.config_hash === A ? 'A' : 'B';
      where.set(c.trial_id, [arm, spec.trial.task_id, spec.trial.repeat_index]);
      const s = scenario(arm, spec.trial.task_id, spec.trial.repeat_index);
      const rr = runnerReport(c.trial_id, c.attempt, 'agent');
      rr.end_state = s.end_state ?? 'answered';
      (rr.proxy_usage as Record<string, unknown>).model_calls = s.model_calls;
      const t0 = 1_793_800_000_000_000_000n + BigInt(n++) * 1_000_000_000_000n;
      const spans = s.calls.map((call, i) => ({
        traceId: 'a'.repeat(32),
        spanId: `${String(n).padStart(8, '0')}${String(i).padStart(8, '0')}`,
        name: `execute_tool ${call.name}`,
        kind: 1,
        startTimeUnixNano: String(t0 + BigInt(i) * 1_000_000n),
        endTimeUnixNano: String(t0 + BigInt(i) * 1_000_000n + 500_000n),
        status: { code: 1 },
        attributes: [
          { key: 'gen_ai.tool.name', value: { stringValue: call.name } },
          { key: 'evals.tool.arguments', value: { stringValue: JSON.stringify(call.args ?? {}) } },
          { key: 'evals.tool.result', value: { stringValue: call.error ? '{"error": "principal_rupees is required"}' : '{"ok": true}' } },
          { key: 'evals.tool.is_error', value: { boolValue: call.error === true } },
        ],
      }));
      const result = {
        end_state: rr.end_state,
        end_detail: { harness_stop_reason: s.stop ?? 'stop', exception_type: null, exception_message: null, last_message_excerpt: null },
        final_answer: s.answer === undefined ? 'An answer.' : s.answer,
        counts: { model_calls: s.model_calls, tool_calls: s.calls.length, tool_errors: s.calls.filter((x) => x.error).length, malformed_tool_calls: 0 },
      };
      await request(env.http).post(`/api/worker/trials/${c.trial_id}/report`).set(auth).send({ worker_id: 'w-cause', attempt: c.attempt, runner_report: rr, result, spans, files: [] }).expect(200);
    }
    expect(n).toBe(8);

    // The grader, as evals_graders would write these grades.
    for (;;) {
      const res = await request(env.http).post('/api/grader/claim').set(auth).send({ worker_id: 'g-cause' });
      if (res.status === 204) break;
      const job = res.body as GraderClaimResponse;
      const [arm, task, repeat] = where.get(job.trial_id)!;
      const s = scenario(arm, task, repeat);
      const grades = job.graders.map((g) => {
        const spec = g.spec as { id: string; type: string; required?: boolean };
        const given = s.grades?.[spec.id];
        const verdict = given?.verdict ?? 'pass';
        return {
          grader_id: spec.id,
          type: spec.type,
          required: spec.required !== false,
          verdict,
          score: verdict === 'pass' ? 1 : 0,
          reason: given?.reason ?? `${spec.id} passed`,
          evidence: given?.evidence ?? [],
          grader_version: graderVersion(g.spec_sha256, 'test-grader-0'),
        };
      });
      await request(env.http).post(`/api/grader/trials/${job.trial_id}/grades`).set(auth).send({ worker_id: 'g-cause', job_id: job.job_id, attempt: job.attempt, framework_version: 'test-grader-0', grades }).expect(200);
    }

    // One synthetic label (not Rishi's): "clear" is yes on arm B's made-up-arguments trial, where the judge said no.
    const madeUp = [...where.entries()].find(([, [arm, task, repeat]]) => arm === 'B' && task === 'cause-emi' && repeat === 1)![0];
    await env.pool.query(
      `INSERT INTO labels (trial_id, criterion, value, label_set, note, labelled_at, source, line_sha256)
       VALUES ($1, 'clear', 'yes', 'heldout', 'synthetic test label', now(), 'test (synthetic)', 'synthetic-line-1')`,
      [madeUp],
    );
  });

  afterAll(async () => {
    await env.close();
  });

  const idOf = (arm: 'A' | 'B', task: string, repeat: number): string => [...where.entries()].find(([, w]) => w[0] === arm && w[1] === task && w[2] === repeat)![0];

  it('gives every failed or stopped-short trial a cause on its row, and none to a pass', async () => {
    const rows = (await request(env.http).get(`/api/experiments/${expId}/trials`).expect(200)).body as TrialRowSummary[];
    const by = (arm: 'A' | 'B', task: string, repeat: number) => rows.find((r) => r.id === idOf(arm, task, repeat))!;
    expect(by('A', 'cause-emi', 0).cause).toBeNull();
    expect(by('A', 'cause-fd', 0).cause).toBeNull();
    expect(by('A', 'cause-emi', 1).cause).toMatchObject({ cause: 'unsupported_figure', reason: 'Rs 23,120 has no tool result, client-file number or message behind it (1 of 2 figures)' });
    expect(by('B', 'cause-emi', 0).cause).toMatchObject({ cause: 'wrong_tool', reason: 'calculate_emi was never called; amortization_schedule was' });
    const madeUp = by('B', 'cause-emi', 1).cause!;
    expect(madeUp).toMatchObject({ cause: 'made_up_arguments', rules_version: 'causes-1' });
    expect(madeUp.reason).toBe('calculate_emi was called once, but never with the arguments the check wants ({"principal":1000000}); it sent {"principal": 900000}');
    // The judge's no on "clear" against the (synthetic) yes label contributes; the judge check is optional.
    expect(madeUp.contributing).toEqual([{ cause: 'judge_vs_label', reason: 'On clear the judge said no and the human label says yes' }]);
    const steps = by('B', 'cause-fd', 0).cause!;
    expect(steps.cause).toBe('ran_out_of_steps');
    expect(steps.reason).toBe('Stopped at the step limit after 15 model calls (its limit is 15); the own loop stops at the limit without an answer (the own loop reported "max_steps")');
    expect(steps.contributing.map((c) => c.cause)).toEqual(['wrong_answer']);
    expect(by('B', 'cause-fd', 1).cause).toMatchObject({ cause: 'gave_up_early', reason: 'Answered without calling any tool; the task needs fd_maturity' });
  });

  it('shows the same cause on the trial page', async () => {
    const view = (await request(env.http).get(`/api/trials/${idOf('B', 'cause-emi', 0)}`).expect(200)).body as TrialView;
    expect(view.cause).toMatchObject({ cause: 'wrong_tool' });
    const pass = (await request(env.http).get(`/api/trials/${idOf('A', 'cause-emi', 0)}`).expect(200)).body as TrialView;
    expect(pass.cause).toBeNull();
  });

  it("puts each arm's behaviour on the comparison, with tool calls and steps paired by task and no verdict", async () => {
    const cmp = (await request(env.http).get(`/api/experiments/${expId}/compare`).expect(200)).body as CompareResponse;
    expect(cmp.status).toBe('complete');
    const [a, b] = cmp.behaviour!.arms;
    expect(a).toMatchObject({ arm: 'A', trials: 4, tool_calls: { total: 6, per_trial: 1.5 }, tool_errors: { total: 0, trials: 0 }, steps: { trials_measured: 4, per_trial: 2.5, step_limit: 0 } });
    expect(b).toMatchObject({ arm: 'B', trials: 4, tool_calls: { total: 7, per_trial: 1.75 }, tool_errors: { total: 2, per_trial: 0.5, trials: 1 }, steps: { trials_measured: 4, per_trial: 5.5, step_limit: 1 } });
    expect(b.by_tool).toEqual([
      { tool: 'fd_maturity', calls: 3, per_trial: 0.75, errors: 2, trials: 1 },
      { tool: 'list_debts', calls: 2, per_trial: 0.5, errors: 0, trials: 2 },
      { tool: 'amortization_schedule', calls: 1, per_trial: 0.25, errors: 0, trials: 1 },
      { tool: 'calculate_emi', calls: 1, per_trial: 0.25, errors: 0, trials: 1 },
    ]);
    expect(a.required_tools).toEqual([
      { tool: 'calculate_emi', trials: 2, called: 2, share: 1 },
      { tool: 'fd_maturity', trials: 2, called: 2, share: 1 },
      { tool: 'list_debts', trials: 2, called: 2, share: 1 },
    ]);
    expect(b.required_tools.map((r) => [r.tool, r.called, r.trials])).toEqual([
      ['calculate_emi', 1, 2],
      ['fd_maturity', 1, 2],
      ['list_debts', 2, 2],
    ]);
    expect(b.end_states).toEqual([
      { end_state: 'answered', trials: 3 },
      { end_state: 'step_limit', trials: 1 },
    ]);
    expect(a.causes).toEqual({ trials: 1, by_cause: [{ cause: 'unsupported_figure', primary: 1, contributing: 0 }] });
    expect(b.causes.by_cause.map((c) => [c.cause, c.primary, c.contributing])).toEqual([
      ['ran_out_of_steps', 1, 0],
      ['judge_vs_label', 0, 1],
      ['wrong_tool', 1, 0],
      ['gave_up_early', 1, 0],
      ['made_up_arguments', 1, 0],
      // fd_maturity's two errors were followed by a successful call: recovered, so no tool_error.
      ['wrong_answer', 0, 1],
    ]);
    const paired = Object.fromEntries(cmp.behaviour!.paired.map((p) => [p.metric, p]));
    expect(paired.tool_calls).toMatchObject({ tasks: 2, a: 1.5, b: 1.75, trials: { a: 4, b: 4 } });
    expect(paired.steps).toMatchObject({ tasks: 2, a: 2.5, b: 5.5, diff: { estimate: 3 } });
    expect(paired.steps).not.toHaveProperty('verdict');
  });

  it('lists on each regression the causes that grew from A to B, and each failed trial’s cause', async () => {
    const cmp = (await request(env.http).get(`/api/experiments/${expId}/compare`).expect(200)).body as CompareResponse;
    const regs = Object.fromEntries(cmp.stats!.regressions.map((r) => [r.task_id, r]));
    expect(regs['cause-emi'].causes_grew).toEqual([
      { cause: 'wrong_tool', a: 0, b: 1 },
      { cause: 'made_up_arguments', a: 0, b: 1 },
    ]);
    expect(regs['cause-fd'].causes_grew).toEqual([
      { cause: 'ran_out_of_steps', a: 0, b: 1 },
      { cause: 'gave_up_early', a: 0, b: 1 },
    ]);
    for (const r of cmp.stats!.regressions) for (const f of r.failed_trials) expect(f.cause).not.toBeNull();
    expect(regs['cause-emi'].failed_trials.find((f) => f.arm === 'A')?.cause?.cause).toBe('unsupported_figure');
  });

  it('exports the cause in the CSV and the JSON', async () => {
    const csv = (await request(env.http).get(`/api/experiments/${expId}/export?format=csv`).expect(200)).text.trim().split('\n');
    const head = csv[0].split(',');
    expect(head.slice(head.indexOf('outcome'), head.indexOf('outcome') + 4)).toEqual(['outcome', 'cause', 'cause_reason', 'causes_contributing']);
    const line = csv.find((l) => l.includes(idOf('B', 'cause-fd', 0)))!;
    expect(line).toContain(',fail,ran_out_of_steps,"Stopped at the step limit after 15 model calls');
    expect(line).toContain(',wrong_answer,');
    const pass = csv.find((l) => l.includes(idOf('A', 'cause-emi', 0)))!;
    expect(pass).toContain(',pass,,,,');
    const json = JSON.parse((await request(env.http).get(`/api/experiments/${expId}/export?format=json`).expect(200)).text) as { trials: { id: string; cause: unknown }[] };
    expect(json.trials.find((t) => t.id === idOf('B', 'cause-emi', 0))?.cause).toMatchObject({ cause: 'wrong_tool' });
    expect(json.trials.find((t) => t.id === idOf('A', 'cause-emi', 0))?.cause).toBeNull();
  });
});
