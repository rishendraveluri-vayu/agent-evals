import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { SETTING_NAMES, type ExperimentDetail, type TrialRowSummary } from '../api/types';
import { fixtureResponse } from './index';

const keys = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
const sorted = (list: string[]) => [...list].sort();

/** The fields of each contract type (apps/api/src/contract.ts), so a fixture that drifts from the
 *  API's shapes fails here. */
const FIELDS = {
  harness: ['name', 'package', 'ref', 'python', 'adapter_version', 'capabilities_sha256', 'capabilities'],
  prompt: ['id', 'version', 'sha256', 'path', 'text'],
  task: ['sha256', 'id', 'version', 'split', 'kind', 'summary', 'graders', 'problems'],
  model: ['name', 'provider', 'input_per_mtok', 'output_per_mtok'],
  config: [
    'hash', 'name', 'harness', 'harness_ref', 'adapter_version', 'capabilities_sha256', 'model', 'prompt', 'toolset', 'settings', 'settings_sources',
    'unsupported', 'warnings', 'harness_options', 'seed', 'parent_hash', 'created_at',
  ],
  summary: ['id', 'name', 'axis', 'status', 'config_hashes', 'task_sha256s', 'n', 'counts', 'spend_usd', 'estimate', 'budget_usd', 'created_at', 'example'],
  detailExtra: [
    'sim_model', 'sim', 'platform_commit', 'plan_commit', 'budgets', 'started_at', 'finished_at', 'order_seed', 'futility', 'parent_experiment_id',
    'baseline', 'actual', 'paused_at', 'paused_reason', 'arms', 'tasks', 'configs', 'events', 'judge',
  ],
  counts: ['queued', 'running', 'done', 'infra_failed', 'abandoned', 'cancelled', 'by_label', 'done_by_end_state'],
  arm: ['arm', 'config_hash', 'config_name', 'status', 'paused_at', 'paused_reason', 'fix', 'counts', 'reused_from', 'reused_trials'],
  event: ['at', 'kind', 'trial_id', 'attempt', 'arm', 'config_hash', 'detail'],
  // `passed` is the UI's own field (src/api/pending.ts): not in the contract yet.
  trialRow: [
    'id', 'experiment_id', 'task_sha256', 'task_id', 'config_hash', 'config_name', 'harness', 'model', 'repeat_index', 'order_index', 'attempt', 'status',
    'label', 'end_state', 'cost_usd', 'input_tokens', 'output_tokens', 'model_calls', 'wall_s', 'worker_id', 'claimed_at', 'finished_at', 'passed',
  ],
  compare: ['experiment_id', 'status', 'reason', 'arms', 'rows', 'stats'],
  compareRow: ['task', 'task_id', 'arm', 'config', 'config_name', 'passed', 'graded', 'trials', 'infra_failed', 'abandoned'],
  trial: [
    'id', 'experiment_id', 'probe', 'task', 'config', 'repeat_index', 'attempt', 'status', 'label', 'end_state', 'spec', 'result', 'runner_report', 'usage',
    'timing', 'worker_id', 'files', 'grades', 'grading', 'problems',
  ],
  grade: ['id', 'grader_id', 'grader_version', 'kind', 'type', 'required', 'verdict', 'score', 'reason', 'evidence', 'judge_model', 'run_index', 'created_at'],
  rendered: ['config_hash', 'status', 'probe', 'cached', 'error', 'rendered'],
  conflict: ['config_hash', 'rendered_sha256', 'input_sha256', 'checker', 'model', 'conflicts', 'notes', 'cost_usd', 'cached', 'skipped', 'spend_id', 'checked_at', 'allowance'],
  allowance: ['kind', 'limit_usd', 'used_usd', 'remaining_usd', 'calls', 'half_reached'],
  spend: ['trials_usd', 'system_usd', 'judge_usd', 'judge_approvals', 'total_usd', 'system_by_kind', 'allowances'],
  blind: ['item_id', 'task_id', 'task_summary', 'transcript', 'tool_calls', 'criteria'],
};

/** The fixtures stand in for the API, so they must keep the contract's shapes. */
describe('fixtures', () => {
  it('serve the catalogue in the contract shapes', () => {
    const harnesses = fixtureResponse('GET', '/harnesses') as Record<string, unknown>[];
    for (const h of harnesses) {
      expect(keys(h)).toEqual(sorted(FIELDS.harness));
      const caps = h.capabilities as { settings: Record<string, { evidence: string; supported: boolean }> };
      expect(Object.keys(caps.settings).sort()).toEqual([...SETTING_NAMES].sort());
      for (const s of Object.values(caps.settings)) expect(s.evidence).toMatch(/^(probe:\d{4}-\d{2}-\d{2}|declared:.+|none)$/);
    }
    for (const p of fixtureResponse('GET', '/prompts') as unknown[]) expect(keys(p)).toEqual(sorted(FIELDS.prompt));
    for (const t of fixtureResponse('GET', '/tasks') as { split: string }[]) {
      expect(keys(t)).toEqual(sorted(FIELDS.task));
      expect(['discovery', 'held_out']).toContain(t.split);
    }
    for (const m of fixtureResponse('GET', '/models') as unknown[]) expect(keys(m)).toEqual(sorted(FIELDS.model));
  });

  it('serve configs with every setting resolved, toggles as {enabled}, and a reason for each ignored one', () => {
    for (const c of fixtureResponse('GET', '/configs') as { settings: Record<string, unknown>; settings_sources: Record<string, string>; unsupported: Record<string, string> }[]) {
      expect(keys(c)).toEqual(sorted(FIELDS.config));
      expect(keys(c.settings)).toEqual([...SETTING_NAMES].sort());
      for (const name of ['memory', 'skills', 'compression']) {
        const v = c.settings[name];
        expect(v === null || (typeof v === 'object' && keys(v).join() === 'enabled'), name).toBe(true);
      }
      for (const [name, source] of Object.entries(c.settings_sources)) if (source === 'unsupported') expect(c.unsupported[name], name).toBeTruthy();
    }
    // Haiku 5.5 refuses temperature (D25): no sample config on it sets one.
    const haiku = (fixtureResponse('GET', '/configs') as { model: string; settings_sources: Record<string, string> }[]).filter((c) => c.model === 'claude-haiku-5-5');
    for (const c of haiku) expect(c.settings_sources.temperature).not.toBe('config');
  });

  it('serve experiments, their arms and events, and compare in the contract shapes', () => {
    for (const e of fixtureResponse('GET', '/experiments') as Record<string, unknown>[]) {
      expect(keys(e)).toEqual(sorted(FIELDS.summary));
      expect(keys(e.counts)).toEqual(sorted(FIELDS.counts));
      const d = fixtureResponse('GET', `/experiments/${e.id as string}`) as ExperimentDetail;
      expect(keys(d)).toEqual(sorted([...FIELDS.summary, ...FIELDS.detailExtra]));
      for (const a of d.arms) expect(keys(a)).toEqual(sorted(FIELDS.arm));
      for (const ev of d.events) expect(keys(ev)).toEqual(sorted(FIELDS.event));
      const compare = fixtureResponse('GET', `/experiments/${d.id}/compare`) as { status: string; rows: unknown[] };
      expect(keys(compare)).toEqual(sorted(FIELDS.compare));
      for (const r of compare.rows) expect(keys(r)).toEqual(sorted(FIELDS.compareRow));
      // D37: no rows off a partial run.
      if (compare.status === 'incomplete') expect(compare.rows).toEqual([]);
      for (const t of fixtureResponse('GET', `/experiments/${d.id}/trials`) as unknown[]) expect(keys(t)).toEqual(sorted(FIELDS.trialRow));
    }
  });

  it('never run more trials at once than the estimate has workers for', () => {
    const running = (fixtureResponse('GET', '/experiments') as { id: string; status: string }[]).filter((e) => e.status === 'running');
    expect(running.length).toBeGreaterThan(0);
    for (const e of running) {
      const d = fixtureResponse('GET', `/experiments/${e.id}`) as ExperimentDetail;
      const workers = Object.values(d.estimate.basis_detail.workers ?? {}).reduce((sum, w) => sum + w.used, 0);
      const trials = fixtureResponse('GET', `/experiments/${e.id}/trials`) as TrialRowSummary[];
      const live = trials.filter((t) => t.status === 'running' || t.status === 'claimed').length;
      expect(live, `${e.id} runs ${live} trials at once on ${workers} workers`).toBeLessThanOrEqual(workers);
    }
  });

  it('claim first attempts in claim order (D32), so any early batch is a random sample and the arms stay balanced', () => {
    const CLAIMED = ['done', 'infra_failed', 'abandoned', 'running', 'claimed'];
    let checked = 0;
    for (const e of fixtureResponse('GET', '/experiments') as { id: string; config_hashes: string[] }[]) {
      const [ha, hb] = e.config_hashes;
      if (e.config_hashes.length !== 2 || ha === hb) continue;
      const firsts = (fixtureResponse('GET', `/experiments/${e.id}/trials`) as TrialRowSummary[]).filter((t) => t.attempt === 1);
      if (!firsts.length) continue;
      const order = [...firsts].sort((x, y) => x.order_index - y.order_index);
      expect(order.map((t) => t.order_index), e.id).toEqual(order.map((_, i) => i));
      // Not plan order: the seeded shuffle moved something.
      const plan = [...firsts].sort((x, y) => x.repeat_index - y.repeat_index);
      expect(order.map((t) => t.id), e.id).not.toEqual(plan.map((t) => t.id));
      const claimed = order.map((t) => CLAIMED.includes(t.status));
      // A paused arm (D37) stops claiming, so only the other arm's claims run on past it.
      const d = fixtureResponse('GET', `/experiments/${e.id}`) as ExperimentDetail;
      const pausedArm = d.arms.find((a) => a.status === 'paused')?.config_hash;
      const claimable = order.filter((t) => t.config_hash !== pausedArm);
      const m = claimable.filter((t) => CLAIMED.includes(t.status)).length;
      expect(
        claimable.map((t) => CLAIMED.includes(t.status)),
        `${e.id}: the claimed first attempts are the first ${m} in claim order`,
      ).toEqual(claimable.map((_, i) => i < m));
      if (!pausedArm) {
        const perArm = (h: string) => order.filter((t, i) => claimed[i] && t.config_hash === h).length;
        expect(Math.abs(perArm(ha) - perArm(hb)), e.id).toBeLessThanOrEqual(1);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('serve the one full trial in the contract trial shape, grades included, and spans as OTLP', () => {
    const trial = fixtureResponse('GET', '/trials/tr_fd-vs-sip-07_b_3') as { grades: unknown[] };
    expect(keys(trial)).toEqual(sorted(FIELDS.trial));
    for (const g of trial.grades) expect(keys(g)).toEqual(sorted(FIELDS.grade));
    const spans = fixtureResponse('GET', '/trials/tr_fd-vs-sip-07_b_3/spans') as Record<string, unknown>[];
    for (const s of spans) expect(s).toHaveProperty('startTimeUnixNano');
  });

  it('serve pre-run checks and spend in the contract shapes, and never make a call', () => {
    for (const c of fixtureResponse('GET', '/configs') as { hash: string }[]) {
      const r = fixtureResponse('GET', `/configs/${c.hash}/rendered-prompt`) as { status: string };
      expect(keys(r)).toEqual(sorted(FIELDS.rendered));
      if (r.status !== 'ready') continue;
      try {
        const check = fixtureResponse('GET', `/configs/${c.hash}/conflict-check`) as { allowance: unknown };
        expect(keys(check)).toEqual(sorted(FIELDS.conflict));
        expect(keys(check.allowance)).toEqual(sorted(FIELDS.allowance));
      } catch (err) {
        expect((err as ApiError).code).toBe('no_conflict_check');
      }
    }
    const spend = fixtureResponse('GET', '/spend') as { allowances: unknown[] };
    expect(keys(spend)).toEqual(sorted(FIELDS.spend));
    // A POST with no stored result is refused in sample mode, never answered as if a model ran.
    const unchecked = (fixtureResponse('GET', '/configs') as { hash: string; name: string }[]).find((c) => c.name === 'Prompt v1 on Hermes, Gemini Flash');
    expect(() => fixtureResponse('POST', `/configs/${unchecked?.hash}/conflict-check`)).toThrow(ApiError);
  });

  it('never put an answer in a labelling item, and never store a label', () => {
    for (const set of ['tuning', 'heldout', 'final']) {
      for (const item of fixtureResponse('GET', `/labels/queue?set=${set}`) as Record<string, unknown>[]) {
        expect(keys(item)).toEqual(sorted(FIELDS.blind));
      }
    }
    expect(fixtureResponse('POST', '/labels', { item_id: 'x', set: 'heldout', criterion: 'c', value: 'yes', note: '' })).toEqual({ saved: false, reason: 'sample data' });
  });

  it('refuse a setting the harness or the model rejects the way the API does, with a fix, and answer unknown paths with 404', () => {
    const configs = fixtureResponse('GET', '/configs') as { prompt: { sha256: string }; toolset: { sha256: string } }[];
    const body = { name: 'n', harness: 'ownloop', model: 'claude-haiku-5-5', prompt_sha256: configs[0].prompt.sha256, toolset_sha256: configs[0].toolset.sha256, settings: { memory: { enabled: true } }, harness_options: {} };
    expect(() => fixtureResponse('POST', '/configs', body)).toThrow(ApiError);
    try {
      fixtureResponse('POST', '/configs', { ...body, harness: 'hermes', settings: { temperature: 0.2 } });
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).code).toBe('unsupported_setting');
      expect((err as ApiError).fix).toBe('Claude Haiku 5.5 rejects temperature: leave it unset, or pick a model that takes it.');
    }
    try {
      fixtureResponse('GET', '/nothing');
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
    }
  });
});
