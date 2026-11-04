import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { SETTING_NAMES } from '../api/types';
import { fixtureResponse } from './index';

const keys = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();

/** The fixtures stand in for the API, so they must keep the contract's shapes. */
describe('fixtures', () => {
  it('serve the catalogue in the shapes docs/api-contract.md lists', () => {
    const harnesses = fixtureResponse('GET', '/harnesses') as Record<string, unknown>[];
    for (const h of harnesses) {
      expect(keys(h)).toEqual(['capabilities', 'name', 'package', 'python', 'ref']);
      const caps = h.capabilities as { settings: Record<string, { evidence: string; supported: boolean }> };
      expect(Object.keys(caps.settings).sort()).toEqual([...SETTING_NAMES].sort());
      for (const s of Object.values(caps.settings)) expect(s.evidence).toMatch(/^(probe:\d{4}-\d{2}-\d{2}|declared:.+|none)$/);
    }
    for (const p of fixtureResponse('GET', '/prompts') as unknown[]) expect(keys(p)).toEqual(['id', 'path', 'sha256', 'text', 'version']);
    for (const t of fixtureResponse('GET', '/tasks') as unknown[]) expect(keys(t)).toEqual(['graders', 'id', 'kind', 'sha256', 'split', 'summary', 'version']);
    for (const m of fixtureResponse('GET', '/models') as unknown[]) expect(keys(m)).toEqual(['input_per_mtok', 'name', 'output_per_mtok', 'provider']);
  });

  it('serve configs and experiments with every field the contract names', () => {
    for (const c of fixtureResponse('GET', '/configs') as unknown[]) {
      expect(keys(c)).toEqual(['created_at', 'harness', 'harness_options', 'harness_ref', 'hash', 'model', 'name', 'prompt', 'settings', 'settings_sources', 'toolset']);
    }
    for (const e of fixtureResponse('GET', '/experiments') as Record<string, unknown>[]) {
      for (const k of ['id', 'name', 'axis', 'status', 'config_hashes', 'n', 'counts', 'spend_usd', 'estimate', 'created_at']) expect(e).toHaveProperty(k);
      expect(keys(e.counts)).toEqual(['abandoned', 'cancelled', 'done', 'infra_failed', 'queued', 'running']);
    }
    const detail = fixtureResponse('GET', '/experiments/exp_heldout') as Record<string, unknown>;
    for (const k of ['tasks', 'configs', 'events']) expect(detail).toHaveProperty(k);
    const compare = fixtureResponse('GET', '/experiments/exp_harness/compare') as { rows: unknown[]; stats: unknown };
    expect(compare.stats).toBeNull();
    for (const r of compare.rows) expect(keys(r)).toEqual(['config', 'graded', 'passed', 'task', 'trials']);
  });

  it('never run more trials at once than the estimate allows', () => {
    type Running = { id: string; status: string; estimate: { concurrency?: number } | null };
    const running = (fixtureResponse('GET', '/experiments') as Running[]).filter((e) => e.status === 'running');
    expect(running.length).toBeGreaterThan(0);
    for (const e of running) {
      const trials = fixtureResponse('GET', `/experiments/${e.id}/trials`) as { status: string }[];
      const live = trials.filter((t) => t.status === 'running' || t.status === 'claimed').length;
      expect(e.estimate?.concurrency, e.id).toBeDefined();
      expect(live, `${e.id} runs ${live} trials at once`).toBeLessThanOrEqual(e.estimate?.concurrency ?? 0);
    }
  });

  it('claim first attempts in the engine order, so the arms stay balanced at any point in a run', () => {
    type Detail = { tasks: { sha256: string }[]; config_hashes: string[]; n: number };
    type Trial = { task: string; config: string; repeat_index: number; attempt: number; status: string };
    const CLAIMED = ['done', 'infra_failed', 'abandoned', 'running', 'claimed'];
    let checked = 0;
    for (const e of fixtureResponse('GET', '/experiments') as { id: string; config_hashes: string[] }[]) {
      const [ha, hb] = e.config_hashes;
      if (e.config_hashes.length !== 2 || ha === hb) continue;
      const d = fixtureResponse('GET', `/experiments/${e.id}`) as Detail;
      const firsts = (fixtureResponse('GET', `/experiments/${e.id}/trials`) as Trial[]).filter((t) => t.attempt === 1);
      if (!firsts.length) continue;
      // Repeat by repeat, then task by task in the grid's order, the two arms alternating.
      const seq = (t: Trial) => t.repeat_index * d.tasks.length * 2 + d.tasks.findIndex((x) => x.sha256 === t.task) * 2 + d.config_hashes.indexOf(t.config);
      const order = [...firsts].sort((x, y) => seq(x) - seq(y));
      expect(order.map(seq), e.id).toEqual(order.map((_, i) => i));
      const claimed = order.map((t) => CLAIMED.includes(t.status));
      const m = claimed.filter(Boolean).length;
      expect(claimed, `${e.id}: the claimed first attempts are the first ${m} in claim order`).toEqual(order.map((_, i) => i < m));
      const perArm = (h: string) => order.filter((t, i) => claimed[i] && t.config === h).length;
      expect(Math.abs(perArm(ha) - perArm(hb)), e.id).toBeLessThanOrEqual(1);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('serve the one full trial with the contract trial fields, and spans as OTLP', () => {
    const trial = fixtureResponse('GET', '/trials/tr_fd-vs-sip-07_b_3');
    expect(keys(trial)).toEqual(['attempt', 'config', 'end_state', 'experiment_id', 'files', 'grades', 'id', 'label', 'repeat_index', 'result', 'runner_report', 'status', 'task', 'timing', 'usage']);
    const spans = fixtureResponse('GET', '/trials/tr_fd-vs-sip-07_b_3/spans') as Record<string, unknown>[];
    for (const s of spans) expect(s).toHaveProperty('startTimeUnixNano');
  });

  it('never put an answer in a labelling item, and never store a label', () => {
    for (const set of ['tuning', 'heldout', 'final']) {
      for (const item of fixtureResponse('GET', `/labels/queue?set=${set}`) as Record<string, unknown>[]) {
        expect(keys(item)).toEqual(['criteria', 'item_id', 'task_id', 'task_summary', 'tool_calls', 'transcript']);
      }
    }
    expect(fixtureResponse('POST', '/labels', { item_id: 'x', set: 'heldout', criterion: 'c', value: 'yes', note: '' })).toEqual({ saved: false, reason: 'sample data' });
  });

  it('refuse an unsupported setting the way the API does, and answer unknown paths with 404', () => {
    const body = { name: 'n', harness: 'ownloop', model: 'claude-haiku-5-5', prompt_sha256: 'x', toolset_sha256: 'y', settings: { memory: true }, harness_options: {} };
    expect(() => fixtureResponse('POST', '/configs', body)).toThrow(ApiError);
    try {
      fixtureResponse('GET', '/nothing');
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
    }
  });
});
