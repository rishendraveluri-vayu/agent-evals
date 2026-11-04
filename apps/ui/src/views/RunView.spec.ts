import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { ExperimentDetail, ExperimentTrial } from '../api/types';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import RunView from './RunView.vue';

/** A no-break space: a number keeps its unit. */
const nb = '\u00a0';

describe('RunView, setting up a run in fixture mode', () => {
  useFixtures();

  it('names each config first in the arm pickers, then its short hash', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    const selected = (sel: string) => (w.get(sel).element as HTMLSelectElement).selectedOptions[0]?.text;
    expect(selected('[data-test="arm-a"]')).toBe('Prompt v1 on Hermes · 3b81e04');
    expect(selected('[data-test="arm-b"]')).toBe('Prompt v2 on Hermes · 7f3a9c2');
    for (const o of w.findAll('[data-test="arm-a"] option')) expect(o.text()).toMatch(/^[A-Z].* · [0-9a-f]{7}$/);
  });

  it('names the checks that stand in the way under a disabled Start', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    expect(w.get('[data-test="start-helper"]').text()).toBe('1 check is not passing: No analysis plan commit yet.');
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    expect(w.find('[data-test="start-helper"]').exists()).toBe(false);
  });

  it('shows trials, cost, time and the smallest detectable difference before anything starts', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    expect(w.get('[data-test="run-title"]').text()).toBe('Check and run');
    expect(w.find('.lede').exists()).toBe(true);
    expect(w.find('[data-test="run-actions"]').exists()).toBe(false);
    const plan = w.get('[data-test="plan"]').text();
    expect(plan).toContain('120');
    expect(plan).toContain('12 tasks × 2 arms × 5 trials');
    expect(plan).toContain('$21.30');
    expect(plan).toContain('Likely $16.00 to $27.00');
    expect(plan).toContain(`10${nb}points`);
    // Before the start the plan is the answer, so its figures stay large (34 px).
    expect(w.get('[data-test="plan"]').classes()).not.toContain('plan--past');
    const tiles = w.findAll('[data-test="plan"] > div');
    expect(tiles[3].get('.stat-label').text()).toBe('Smallest overall difference it can see');
    expect(tiles[3].get('[data-test="power-note"]').text()).toBe("Pass rate over all 12 tasks, 8 times in 10, from the pilot's spread");
  });

  it('will not start until every check passes', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    const checks = w.findAll('[data-test="check"]').map((c) => c.text());
    expect(checks[0]).toContain('Only the system prompt differs between the arms');
    expect(checks.some((c) => c.includes('No analysis plan commit yet') && c.includes('Check failed'))).toBe(true);
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeDefined();
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    expect(w.findAll('[data-test="check"]').every((c) => c.text().includes('Check passed'))).toBe(true);
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeUndefined();
    expect(w.get('[data-test="start"]').text()).toBe('Start 120 trials');
  });

  it('re-estimates when the number of trials changes', async () => {
    const w = mount(RunView, { props: {} });
    await settle();
    await w.get('[data-test="n-input"]').setValue('10');
    await settle();
    expect(w.get('[data-test="plan"]').text()).toContain('240');
  });
});

describe('RunView, a running experiment in fixture mode', () => {
  useFixtures();

  it('shows progress per task, arm and trial, with infra failures apart from agent failures', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="tally"]').text()).toBe('About 19 min left · 4 running · 54 waiting · 2 infra failures re-queued, both in arm B');
    const grid = w.get('[data-test="run-grid"]');
    expect(grid.findAll('tbody tr')).toHaveLength(12);
    const states = grid.findAll('[data-state]').map((c) => c.attributes('data-state'));
    expect(states).toHaveLength(120);
    expect(states.filter((s) => s === 'infra')).toHaveLength(2);
    expect(grid.text()).toContain('debt-hardship-03, arm B, trial 2: infra failure, re-queued');
    // The log reads in the order things happened, which is the order trials were claimed.
    const lines = w.findAll('[data-test="events"] li').map((li) => li.text());
    expect(lines[0]).toMatch(/arms alternating\.$/);
    expect(lines[1]).toContain('debt-hardship-03, arm B, trial 2: infra failure, the provider returned 429. Re-queued as attempt 2, the last.');
    expect(lines[2]).toContain('fd-vs-sip-07, arm B, trial 2');
    expect(lines[3]).toContain('Half the trials done. Spend is on track: $11.20 against $10.65 expected by now.');
  });

  it('fills the grid in claim order: trials 1 and 2 in every row, trial 3 in the first rows', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    const rows = w.findAll('[data-test="run-grid"] tbody tr').map((tr) => tr.findAll('[data-state]').map((c) => c.attributes('data-state')));
    const filled = (s: string | undefined) => s === 'pass' || s === 'fail' || s === 'infra';
    for (const cells of rows) {
      // Trials 1 and 2 of arm A (cells 0, 1) and of arm B (cells 5, 6).
      expect([cells[0], cells[1], cells[5], cells[6]].every(filled)).toBe(true);
    }
    expect(rows.slice(0, 7).every((cells) => filled(cells[2]) && filled(cells[7]))).toBe(true);
    expect(rows.slice(7, 9).every((cells) => cells[2] === 'running' && cells[7] === 'running')).toBe(true);
    expect(rows.slice(9).every((cells) => cells[2] === 'waiting' && cells[7] === 'waiting')).toBe(true);
    expect(rows.every((cells) => [3, 4, 8, 9].every((i) => cells[i] === 'waiting'))).toBe(true);
  });

  it('leads with its progress: the count in the title, then the grid, then what was planned and checked', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="run-title"]').text()).toBe('Running: 60 of 120 trials done');
    expect(w.find('.lede').exists()).toBe(false);
    // The live state sits right under the h1; the Progress heading carries no line of its own.
    expect(w.get('[data-test="run-title"]').element.nextElementSibling).toBe(w.get('[data-test="tally"]').element);
    expect(w.get('.page-head').find('[data-test="tally"]').exists()).toBe(true);
    expect(w.get('#progress').element.parentElement?.querySelector('[data-test="tally"]')).toBeNull();
    // What was planned steps back.
    expect(w.get('[data-test="plan"]').classes()).toEqual(expect.arrayContaining(['stat-strip', 'plan', 'plan--past']));
    const tiles = w.findAll('[data-test="plan"] > div');
    expect(tiles[3].get('.stat-label').text()).toBe('Smallest overall difference it can see');
    expect(tiles[3].get('[data-test="power-note"]').text()).toBe("Pass rate over all 12 tasks, 8 times in 10, from the pilot's spread");
    const actions = w.get('[data-test="run-actions"]');
    expect(actions.get('[data-test="cancel"]').text()).toBe('Cancel the waiting trials');
    expect(actions.text()).toContain('Running trials finish; waiting ones are marked cancelled and kept.');
    const before = (first: string, then: string) => !!(w.get(first).element.compareDocumentPosition(w.get(then).element) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before('[data-test="run-grid"]', '[data-test="plan"]')).toBe(true);
    expect(before('[data-test="plan"]', '[data-test="checks-details"]')).toBe(true);
    expect(before('[data-test="checks-details"]', '[data-test="diff-details"]')).toBe(true);
    expect(w.get('#planned').text()).toBe('Planned');
    expect(w.get('[data-test="run-arms"]').text()).toContain('A: Own loop');
    expect(w.get('[data-test="run-sim-client"]').text()).toBe('Simulated client: Claude Haiku 5.5');
    expect(w.get('[data-test="run-sim-client"]').find('.dot').exists()).toBe(false);
    expect(w.text()).toContain('LiteLLM stops all spending at $40');
  });

  it('keeps the checks and the arm diff closed, with what they hold in the summary', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    for (const summary of w.findAll('.run-details > summary')) expect(summary.find('.summary-text').exists()).toBe(true);
    const checks = w.get('[data-test="checks-details"]');
    expect(checks.attributes('open')).toBeUndefined();
    expect(checks.get('summary').text()).toMatch(/^Checked before the start: \d+ of \d+ passed, plan 3e1a9f0$/);
    expect(checks.findAll('[data-test="check"]').length).toBeGreaterThan(0);
    const diff = w.get('[data-test="diff-details"]');
    expect(diff.attributes('open')).toBeUndefined();
    expect(diff.get('summary').text()).toMatch(/^How the two arms differ: \d+ fields?$/);
  });

  it('gives pass and fail cells equal weight and reads the legend in two rows: outcomes, then only the infra states shown', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    const outcomes = w.get('[data-test="legend-outcomes"]');
    expect(outcomes.findAll('.legend-item').map((i) => i.text())).toEqual(['Pass', 'Fail', 'Running', 'Waiting']);
    expect(outcomes.findAll('.cell').map((c) => c.classes().find((k) => k.startsWith('cell--')))).toEqual(['cell--pass', 'cell--fail', 'cell--running', 'cell--waiting']);
    const infra = w.get('[data-test="legend-infra"]');
    expect(infra.findAll('.legend-item').map((i) => i.text())).toEqual(['!Infra, re-queued']);
    // On a phone each arm's header is its dot and letter; the rest of the label is for screen readers.
    const heads = w.findAll('.arm-col');
    expect(heads.map((h) => h.get('.arm-letter').text())).toEqual(['A', 'B']);
    expect(heads.map((h) => h.get('[data-test="arm-rest"]').text())).toEqual([', Own loop', ', Hermes Agent']);
    expect(heads.map((h) => h.text())).toEqual(['A, Own loop', 'B, Hermes Agent']);
    const grid = w.get('[data-test="run-grid"]');
    expect(grid.findAll('[data-state="fail"]').length).toBeGreaterThan(0);
    // As many running as the run allows at once, in both arms.
    const running = grid.findAll('[data-state="running"]');
    expect(running).toHaveLength(4);
    expect(running.map((c) => c.attributes('title')).some((t) => t?.includes('arm A'))).toBe(true);
    expect(running.map((c) => c.attributes('title')).some((t) => t?.includes('arm B'))).toBe(true);
  });
});

describe('RunView, a finished run in fixture mode', () => {
  useFixtures();

  it('keeps the infra history: retried slots carry a ring and the tally still counts the stops', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const tally = w.get('[data-test="tally"]').text();
    expect(tally).toContain('2 infra failures: 2 re-run, both in arm B');
    expect(tally).not.toContain('re-queued');
    expect(tally).not.toContain('left');
    const retried = w.findAll('[data-test="run-grid"] [data-retried="true"]');
    expect(retried).toHaveLength(2);
    for (const c of retried) {
      expect(c.classes()).toContain('cell--retried');
      expect(c.attributes('data-state')).toBe('pass');
      expect(c.get('.visually-hidden').text()).toMatch(/: passed, after an infra failure$/);
    }
    expect(w.get('[data-test="run-grid"]').text()).toContain('debt-hardship-03, arm B, trial 2: passed, after an infra failure');
    // Only the infra state this grid holds is in the legend.
    expect(w.get('[data-test="legend-infra"]').findAll('.legend-item').map((i) => i.text())).toEqual(['Re-run after infra']);
    expect(w.get('[data-test="legend-infra"] .cell').classes()).toEqual(expect.arrayContaining(['cell--pass', 'cell--retried']));
  });
});

describe('RunView against the API, with a slot that gave up', () => {
  it('says the slot gave up, never that it was re-queued, and splits the tally', async () => {
    const detail = { ...(details as Record<string, ExperimentDetail>).exp_harness, status: 'done' };
    const trials = ((experimentTrials as Record<string, ExperimentTrial[]>).exp_harness)
      .filter((t) => t.id !== 'th_fd-vs-sip-07_b_2_attempt2')
      .map((t) => {
        if (t.id === 'th_fd-vs-sip-07_b_2') return { ...t, status: 'abandoned' };
        if (t.id === 'th_debt-hardship-03_b_2_attempt2') return { ...t, status: 'done', label: 'agent', passed: false };
        return t;
      });
    routeFetch({ '/api/experiments/exp_harness': detail, '/api/experiments/exp_harness/trials': trials, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="tally"]').text()).toContain('2 infra failures: 1 re-run, 1 gave up, both in arm B');
    const grid = w.get('[data-test="run-grid"]');
    const gaveUp = grid.findAll('[data-state="abandoned"]');
    expect(gaveUp).toHaveLength(1);
    // Filled and marked with an en dash: finished, with no result.
    expect(gaveUp[0].text()).toContain('–');
    expect(gaveUp[0].text()).not.toContain('!');
    expect(gaveUp[0].get('.visually-hidden').text()).toBe('fd-vs-sip-07, arm B, trial 2: infra failure, gave up after 1 attempt');
    expect(gaveUp[0].text()).not.toContain('re-queued');
    const failedAfter = grid.findAll('[data-retried="true"]');
    expect(failedAfter.map((c) => c.attributes('data-state'))).toEqual(['fail']);
    expect(failedAfter[0].get('.visually-hidden').text()).toContain('failed, after an infra failure');
  });
});

describe('RunView against the API, with infra failures in both arms', () => {
  it('counts them per arm', async () => {
    const detail = (details as Record<string, ExperimentDetail>).exp_harness;
    const base = (experimentTrials as Record<string, ExperimentTrial[]>).exp_harness;
    const first = base.find((t) => t.id === 'th_emi-basic-01_a_1') as ExperimentTrial;
    const trials = [
      ...base.map((t) => (t.id === first.id ? { ...t, status: 'infra_failed', label: 'infra:provider_error', passed: null } : t)),
      { ...first, id: `${first.id}_attempt2`, attempt: 2, status: 'queued', label: null, passed: null },
    ];
    routeFetch({ '/api/experiments/exp_harness': detail, '/api/experiments/exp_harness/trials': trials, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="tally"]').text()).toBe('About 19 min left · 4 running · 54 waiting · 3 infra failures re-queued, A 1, B 2');
  });
});

describe('RunView against the API, with one slot re-queued and one that gave up', () => {
  it('tells them apart in the grid and the legend: an outline with "!", and a filled cell with "–"', async () => {
    const detail = (details as Record<string, ExperimentDetail>).exp_harness;
    const trials = ((experimentTrials as Record<string, ExperimentTrial[]>).exp_harness)
      .filter((t) => t.id !== 'th_fd-vs-sip-07_b_2_attempt2')
      .map((t) => (t.id === 'th_fd-vs-sip-07_b_2' ? { ...t, status: 'abandoned' } : t));
    routeFetch({ '/api/experiments/exp_harness': detail, '/api/experiments/exp_harness/trials': trials, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    const swatches = w.get('[data-test="legend-infra"]').findAll('.legend-item');
    expect(swatches.map((i) => i.text())).toEqual(['!Infra, re-queued', '–Infra, gave up']);
    const [requeued, gaveUp] = swatches.map((i) => i.get('.cell'));
    expect(requeued.classes()).toContain('cell--infra');
    expect(gaveUp.classes()).toContain('cell--abandoned');
    expect(requeued.classes()).not.toContain('cell--abandoned');
    expect(requeued.text()).toBe('!');
    expect(gaveUp.text()).toBe('–');
    const grid = w.get('[data-test="run-grid"]');
    // Each cell's glyph, without its hidden label.
    const glyph = (state: string) => {
      const cell = grid.get(`[data-state="${state}"]`);
      return cell.text().replace(cell.get('.visually-hidden').text(), '');
    };
    expect(glyph('infra')).toBe('!');
    expect(glyph('abandoned')).toBe('–');
  });
});

describe('RunView against the API, with no simulated client', () => {
  it('leaves the simulated client line out', async () => {
    const detail = { ...(details as Record<string, ExperimentDetail>).exp_harness, sim_model: null };
    routeFetch({ '/api/experiments/exp_harness': detail, '/api/experiments/exp_harness/trials': (experimentTrials as Record<string, ExperimentTrial[]>).exp_harness, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="run-arms"]').text()).toContain('A: Own loop');
    expect(w.find('[data-test="run-sim-client"]').exists()).toBe(false);
  });
});
