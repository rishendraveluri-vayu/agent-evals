import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { ConfigView, EstimateResponse, ExperimentDetail, TrialRowSummary } from '../api/types';
import configsJson from '../fixtures/configs.json';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import harnessesJson from '../fixtures/harnesses.json';
import { ApiError } from '../api/errors';
import { setRunFlash, takeRunFlash } from '../lib/runFlash';
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

  it('shows trials, cost and time before anything starts, and says the power estimate is not in yet', async () => {
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
    expect(plan).toContain('4 workers at a time (4 hermes)');
    // Before the start the plan is the answer, so its figures stay large (34 px).
    expect(w.get('[data-test="plan"]').classes()).not.toContain('plan--past');
    const tiles = w.findAll('[data-test="plan"] > div');
    expect(tiles[3].get('.stat-label').text()).toBe('Smallest overall difference it can see');
    // The API has no power estimate yet (SP6), so the tile says so rather than inventing one.
    expect(tiles[3].get('.stat-value').text()).toBe('–');
    expect(tiles[3].get('[data-test="power-note"]').text()).toBe('Not estimated yet: the power estimate comes with the statistics step');
    expect(nb).toBe('\u00a0');
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
    expect(grid.text()).toContain('debt-hardship-03, arm B, trial 3: infra failure, re-queued');
    // The log reads in the order things happened, in the API's own words under a title.
    const lines = w.findAll('[data-test="events"] li');
    expect(lines[0].text()).toContain('Created2 configs x 12 tasks x N=5; claim order seed 2024');
    expect(lines[1].text()).toContain('Started');
    const infra = lines.filter((li) => li.attributes('data-tone') === 'infra');
    expect(infra).toHaveLength(2);
    expect(infra.map((li) => li.get('.event-title').text())).toEqual(['Infra failure, arm B', 'Infra failure, arm B']);
    expect(infra.some((li) => li.text().includes('debt-hardship-03 on Prompt v1 on Hermes, attempt 1: infra:provider_error (LiteLLM status 429)'))).toBe(true);
  });

  it('fills the grid in its shuffled claim order (D32), the arms in step, so any early batch is a random sample', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    const rows = w.findAll('[data-test="run-grid"] tbody tr').map((tr) => tr.findAll('[data-state]').map((c) => c.attributes('data-state')));
    const filled = (s: string | undefined) => s === 'pass' || s === 'fail' || s === 'infra';
    expect(rows.flat().filter(filled)).toHaveLength(62);
    // Not row by row: debt-hardship-03 has all 5 trials in, inflation-09 only its first.
    const byTask = Object.fromEntries(w.findAll('[data-test="run-grid"] tbody tr').map((tr, i) => [tr.get('th').text(), rows[i]]));
    expect(byTask['debt-hardship-03'].slice(0, 5).every(filled)).toBe(true);
    expect(byTask['inflation-09'].slice(0, 5).map(filled)).toEqual([true, false, false, false, false]);
    // Each task and repeat is a block with one trial per arm, so the arms fill the same slots.
    for (const cells of rows) for (let r = 0; r < 5; r++) expect(cells[r] === 'waiting', `repeat ${r + 1}`).toBe(cells[r + 5] === 'waiting');
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
    expect(tiles[3].get('[data-test="power-note"]').text()).toBe('Not estimated yet: the power estimate comes with the statistics step');
    const actions = w.get('[data-test="run-actions"]');
    expect(actions.get('[data-test="pause"]').text()).toBe('Pause');
    expect(actions.get('[data-test="stop"]').text()).toBe('Stop');
    expect(actions.text()).toContain('Pause stops new claims; running trials finish. Stop cancels the waiting trials for good; running ones finish and are kept.');
    expect(w.get('[data-test="plan-facts"]').text()).toContain('Claim order shuffled from seed 2024, arms interleaved.');
    expect(w.get('[data-test="plan-facts"]').text()).toContain('Futility check on: pauses for review if an arm passes fewer than 1 of its first 3 graded trials');
    expect(w.get('[data-test="actual"]').text()).toMatch(/^So far: 62 trials finished, \$[0-9.]+ a trial, \d+ s a trial, projected \$21\.80\.$/);
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
    const detail = { ...(details as unknown as Record<string, ExperimentDetail>).exp_harness, status: 'done' };
    const trials = ((experimentTrials as Record<string, TrialRowSummary[]>).exp_harness)
      .filter((t) => t.id !== 'th_emi-basic-01_b_4_attempt2')
      .map((t) => {
        if (t.id === 'th_emi-basic-01_b_4') return { ...t, status: 'abandoned' };
        if (t.id === 'th_debt-hardship-03_b_3_attempt2') return { ...t, status: 'done', label: 'agent', passed: false };
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
    expect(gaveUp[0].get('.visually-hidden').text()).toBe('emi-basic-01, arm B, trial 4: infra failure, gave up after 1 attempt');
    expect(gaveUp[0].text()).not.toContain('re-queued');
    const failedAfter = grid.findAll('[data-retried="true"]');
    expect(failedAfter.map((c) => c.attributes('data-state'))).toEqual(['fail']);
    expect(failedAfter[0].get('.visually-hidden').text()).toContain('failed, after an infra failure');
  });
});

describe('RunView against the API, with infra failures in both arms', () => {
  it('counts them per arm', async () => {
    const detail = (details as unknown as Record<string, ExperimentDetail>).exp_harness;
    const base = (experimentTrials as Record<string, TrialRowSummary[]>).exp_harness;
    const first = base.find((t) => t.id === 'th_distress-12_a_1') as TrialRowSummary;
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
    const detail = (details as unknown as Record<string, ExperimentDetail>).exp_harness;
    const trials = ((experimentTrials as Record<string, TrialRowSummary[]>).exp_harness)
      .filter((t) => t.id !== 'th_emi-basic-01_b_4_attempt2')
      .map((t) => (t.id === 'th_emi-basic-01_b_4' ? { ...t, status: 'abandoned' } : t));
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
    const detail = { ...(details as unknown as Record<string, ExperimentDetail>).exp_harness, sim_model: null };
    routeFetch({ '/api/experiments/exp_harness': detail, '/api/experiments/exp_harness/trials': (experimentTrials as Record<string, TrialRowSummary[]>).exp_harness, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="run-arms"]').text()).toContain('A: Own loop');
    expect(w.find('[data-test="run-sim-client"]').exists()).toBe(false);
  });
});

describe('RunView run controls (D32, D37)', () => {
  useFixtures();

  it('pauses a running experiment through the client, and asks before stopping it', async () => {
    const pause = vi.spyOn(api, 'pauseExperiment').mockResolvedValue((details as unknown as Record<string, ExperimentDetail>).exp_harness);
    const stop = vi.spyOn(api, 'stopExperiment').mockResolvedValue((details as unknown as Record<string, ExperimentDetail>).exp_harness);
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    await w.get('[data-test="pause"]').trigger('click');
    await settle();
    expect(pause).toHaveBeenCalledWith('exp_harness');
    // Stop cancels the waiting trials for good, so the first click only asks.
    await w.get('[data-test="stop"]').trigger('click');
    expect(stop).not.toHaveBeenCalled();
    expect(w.get('[data-test="stop-confirm"]').text()).toBe('Stop and cancel 56 waiting trials');
    await w.get('[data-test="stop-keep"]').trigger('click');
    expect(w.find('[data-test="stop-confirm"]').exists()).toBe(false);
    await w.get('[data-test="stop"]').trigger('click');
    await w.get('[data-test="stop-confirm"]').trigger('click');
    await settle();
    expect(stop).toHaveBeenCalledWith('exp_harness');
  });

  it('shows what paused the whole run, the full reason, and resumes it through the client', async () => {
    const resume = vi.spyOn(api, 'resumeExperiment').mockResolvedValue((details as unknown as Record<string, ExperimentDetail>).exp_futility);
    const w = mount(RunView, { props: { experimentId: 'exp_futility' } });
    await settle();
    expect(w.get('[data-test="run-title"]').text()).toBe('Paused: 6 of 40 trials done');
    const banner = w.get('[data-test="pause-banner"]');
    expect(banner.get('h2').text()).toBe('The futility check: arm B passed 0 of its first 3 graded trials');
    expect(banner.text()).toContain('Review those trials, then resume or stop; the check runs once per arm and never compares the arms');
    expect(w.find('[data-test="pause"]').exists()).toBe(false);
    await w.get('[data-test="resume"]').trigger('click');
    await settle();
    expect(resume).toHaveBeenCalledWith('exp_futility');
    // The pause is an event in the log, with its reason.
    const pauseEvent = w.findAll('[data-test="events"] li').find((li) => li.attributes('data-tone') === 'pause');
    expect(pauseEvent?.get('.event-title').text()).toBe('Paused by the futility check');
    expect(w.get('[data-test="plan-facts"]').text()).toContain('Follows from exp_discovery');
  });

  it('says which arm is paused, why and how to fix it, and resumes or pauses an arm through the client', async () => {
    const resumeArm = vi.spyOn(api, 'resumeArm').mockResolvedValue((details as unknown as Record<string, ExperimentDetail>).exp_model);
    const pauseArm = vi.spyOn(api, 'pauseArm').mockResolvedValue((details as unknown as Record<string, ExperimentDetail>).exp_model);
    const w = mount(RunView, { props: { experimentId: 'exp_model' } });
    await settle();
    expect(w.find('[data-test="pause-banner"]').exists()).toBe(false);
    const b = w.get('[data-test="arm-B"]');
    expect(b.classes()).toContain('arm-card--paused');
    expect(b.text()).toContain('Arm B: Prompt v1 on Hermes, Gemini Flash');
    expect(b.get('.arm-status').text()).toBe('Paused');
    // A config error in words, by LiteLLM's status; the API's own words stay behind Details.
    expect(b.get('[data-test="arm-reason"]').text()).toBe('Why: Gemini 3.8 Flash was not found: LiteLLM or the provider does not know this model.');
    expect(b.get('[data-test="arm-fix"]').text()).toContain("How to fix it: Check the model's entry in LiteLLM's config (services/litellm/config.yaml), then restart the stack (docker compose up -d). Then press Resume arm B");
    expect(b.get('[data-test="arm-fix"]').text()).not.toContain('POST /');
    expect(b.get('[data-test="arm-details"] summary').text()).toBe('Details');
    expect(b.get('[data-test="arm-details"]').text()).toContain("infra:config_error (LiteLLM status 404): litellm.NotFoundError: model 'gemini-3.8-flash' is not served by this proxy");
    expect(b.get('[data-test="arm-details"]').attributes('open')).toBeUndefined();
    const a = w.get('[data-test="arm-A"]');
    expect(a.get('.arm-status').text()).toBe('Running');
    expect(a.find('[data-test="arm-reason"]').exists()).toBe(false);
    await b.get('[data-test="resume-arm-B"]').trigger('click');
    await settle();
    expect(resumeArm).toHaveBeenCalledWith('exp_model', 'B');
    await w.get('[data-test="pause-arm-A"]').trigger('click');
    await settle();
    expect(pauseArm).toHaveBeenCalledWith('exp_model', 'A');
    const armEvent = w.findAll('[data-test="events"] li').find((li) => li.text().includes('Arm B paused'));
    expect(armEvent?.attributes('data-tone')).toBe('pause');
  });

  it('shows a refused control with the API fix', async () => {
    vi.spyOn(api, 'pauseArm').mockRejectedValue(new ApiError(404, 'unknown_arm', 'no arm A in exp_model', 'Name an arm by its letter (A or B) or its config hash.'));
    const w = mount(RunView, { props: { experimentId: 'exp_model' } });
    await settle();
    await w.get('[data-test="pause-arm-A"]').trigger('click');
    await settle();
    expect(w.get('[data-test="arm-A"] [role="alert"]').text()).toBe('no arm A in exp_model. Name an arm by its letter (A or B) or its config hash.');
  });
});

describe('RunView against the API, with claim events', () => {
  it('counts the claims and lists them only on request', async () => {
    const detail = (details as unknown as Record<string, ExperimentDetail>).exp_harness;
    const claim = { at: '2026-11-05T13:42:00.000Z', kind: 'claim', trial_id: 'th_distress-12_a_1', attempt: 1, arm: 'A', config_hash: detail.config_hashes[0], detail: 'distress-12 on Own loop, prompt v1, attempt 1 claimed by ownloop-1' };
    routeFetch({
      '/api/experiments/exp_harness': { ...detail, events: [claim, ...detail.events] },
      '/api/experiments/exp_harness/trials': (experimentTrials as Record<string, TrialRowSummary[]>).exp_harness,
      '/api/harnesses': [],
      '/api/prompts': [],
      '/api/tasks': [],
    });
    const w = mount(RunView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.text()).not.toContain('claimed by ownloop-1');
    const toggle = w.get('[data-test="toggle-claims"]');
    expect(toggle.text()).toBe('Show the 1 claim');
    await toggle.trigger('click');
    expect(w.text()).toContain('claimed by ownloop-1');
  });
});

describe('RunView against an API from before grading on trial rows, with no pass or fail', () => {
  it('shows done trials as done and waiting for grades, with that in the legend', async () => {
    const detail = (details as unknown as Record<string, ExperimentDetail>).exp_heldout;
    const trials = (experimentTrials as Record<string, TrialRowSummary[]>).exp_heldout.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'passed' && k !== 'grading')));
    routeFetch({ '/api/experiments/exp_heldout': detail, '/api/experiments/exp_heldout/trials': trials, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const states = w.findAll('[data-test="run-grid"] [data-state]').map((c) => c.attributes('data-state'));
    expect(new Set(states)).toEqual(new Set(['ungraded']));
    expect(w.get('[data-test="legend-ungraded"]').text()).toBe('Done, waiting for grades');
  });
});

// ------------------------------------------------------------------------------------------
// The fresh-clone QA's run-flow findings (4 Nov night), one block each.

const fixtureConfigs = configsJson as unknown as ConfigView[];
const [cfgV1, cfgV2, , cfgGemini] = fixtureConfigs;
const selectValue = (w: VueWrapper, sel: string) => (w.get(sel).element as HTMLSelectElement).value;
const checkTexts = (w: VueWrapper) => w.findAll('[data-test="check"]').map((c) => c.text());
/** Two configs on fake models that differ only in the prompt, as a reviewer would make them. */
const fakeA: ConfigView = { ...fixtureConfigs[2], hash: `sha256:fa${'0'.repeat(61)}1`, name: 'Own loop, fake, v1', harness: 'ownloop', model: 'fake/finance-emi' };
const fakeB: ConfigView = { ...fakeA, hash: `sha256:fb${'0'.repeat(61)}2`, name: 'Own loop, fake, v2', prompt: cfgV2.prompt };

describe('RunView arm defaults (QA blocker 3)', () => {
  useFixtures();

  it('with only arm B in the address, starts arm A on the newest other agent of the same harness, never the oldest or B', async () => {
    const w = mount(RunView, { props: { a: null, b: cfgV2.hash } });
    await settle();
    expect(selectValue(w, '[data-test="arm-b"]')).toBe(cfgV2.hash);
    expect(selectValue(w, '[data-test="arm-a"]')).toBe(cfgGemini.hash);
    expect(selectValue(w, '[data-test="arm-a"]')).not.toBe(cfgV1.hash);
    expect(w.find('[data-test="arm-note"]').exists()).toBe(false);
  });

  it('with one agent, runs it on its own, says a second one is needed and links to the builder; never an A/A run', async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([cfgV1]);
    const estimate = vi.spyOn(api, 'estimate');
    const w = mount(RunView, { props: { a: null, b: cfgV1.hash } });
    await settle();
    expect(selectValue(w, '[data-test="arm-a"]')).toBe(cfgV1.hash);
    expect(selectValue(w, '[data-test="arm-b"]')).toBe('');
    const note = w.get('[data-test="arm-note"]');
    expect(note.text()).toContain('A comparison needs a second agent to compare against, and there is only one so far');
    expect(note.get('a').attributes('href')).toBe('#/build');
    expect(estimate).toHaveBeenCalled();
    for (const [body] of estimate.mock.calls) expect(body.config_hashes).toEqual([cfgV1.hash]);
    expect(w.get('[data-test="plan"]').text()).toContain('12 tasks × 1 arm × 5 trials');
  });

  it('refuses the same agent on both arms in plain words: Start is off and no estimate is asked for', async () => {
    const estimate = vi.spyOn(api, 'estimate');
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    estimate.mockClear();
    await w.get('[data-test="arm-b"]').setValue(cfgV1.hash);
    await settle();
    expect(w.get('[data-test="same-config"]').text()).toBe('Arm A and arm B are the same agent. Pick a different agent for one of them, or set arm B to None to run it on its own.');
    expect(checkTexts(w)).toContain('Arm A and arm B are the same agentCheck failed.Pick a different agent for one of the arms, or set arm B to None to run this agent on its own.');
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-test="start"]').text()).toBe('Start');
    expect(estimate).not.toHaveBeenCalled();
    expect(w.text()).not.toContain('same hash twice');
    expect(w.text()).not.toContain('A/A');
  });
});

describe('RunView on fake models only (QA major 1)', () => {
  useFixtures();

  it('never blocks the run on its spending limit, keeps the estimate and says the price is made up', async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([...fixtureConfigs, fakeA, fakeB]);
    vi.spyOn(api, 'configDiff').mockResolvedValue([{ path: 'prompt.sha256', a: fakeA.prompt.sha256, b: fakeB.prompt.sha256 }]);
    const create = vi.spyOn(api, 'createExperiment');
    const w = mount(RunView, { props: { a: fakeA.hash, b: fakeB.hash } });
    await settle();
    expect(w.find('[data-test="budget-input"]').exists()).toBe(false);
    expect(checkTexts(w)).toContain('No spending limit needed: every model here is fakeCheck passed.Fake models spend nothing real; the estimate is at made-up test prices.');
    expect(checkTexts(w).some((c) => c.includes('spending limit is below'))).toBe(false);
    expect(w.get('[data-test="plan"]').text()).toContain('$21.30');
    expect(w.get('[data-test="cost-note"]').text()).toBe('A made-up test price: fake models spend nothing real');
    // Free, so no paid-run confirmation: one click starts it, with a budget that covers the estimate.
    await w.get('[data-test="start"]').trigger('click');
    await settle();
    expect(w.find('[data-test="confirm-paid"]').exists()).toBe(false);
    expect(create.mock.calls[0][0].budget_usd).toBeGreaterThanOrEqual(27);
  });

  it('offers a default limit that covers a paid run’s high end', async () => {
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    // High end $27.00: rounding to the nearest $10 offered $20, below it; rounding up offers $30.
    expect((w.get('[data-test="budget-input"]').element as HTMLInputElement).value).toBe('30');
    expect(checkTexts(w)).toContain('The spending limit covers the likely costCheck passed.$30 against at most $27.00.');
  });
});

describe('RunView asks before a paid run (QA major 6)', () => {
  useFixtures();

  it('shows trials, models, the most it can cost and the limit, then starts or cancels', async () => {
    const create = vi.spyOn(api, 'createExperiment');
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    expect(w.get('[data-test="spend-kind"]').text()).toBe('Real models: Claude Haiku 5.5. This run costs real money; you confirm the cost before it starts.');
    expect(w.text()).not.toContain('Rishi');
    expect(w.get('[data-test="plan-why"]').text()).toBe(
      'The git commit where the hypothesis and how to read the result were written down before the run, so the result is judged against a plan made in advance.',
    );
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    await w.get('[data-test="start"]').trigger('click');
    await settle();
    const confirm = w.get('[data-test="confirm-paid"]');
    expect(create).not.toHaveBeenCalled();
    expect(w.find('[data-test="start"]').exists()).toBe(false);
    const facts = confirm.findAll('li').map((li) => li.text());
    expect(facts[0]).toBe('120 trials');
    expect(facts).toContain('Arm A: Claude Haiku 5.5');
    expect(facts).toContain('Arm B: Claude Haiku 5.5');
    expect(facts).toContain('Estimated cost $21.30, likely at most $27.00');
    expect(facts).toContain('The most it can cost: $30, the spending limit. LiteLLM stops all spending there.');
    await w.get('[data-test="confirm-paid-cancel"]').trigger('click');
    expect(w.find('[data-test="confirm-paid"]').exists()).toBe(false);
    await w.get('[data-test="start"]').trigger('click');
    await w.get('[data-test="confirm-paid-start"]').trigger('click');
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ n: 5, budget_usd: 30, plan_commit: '3e1a9f0' });
  });
});

describe('RunView, an experiment created but never started (QA major 7)', () => {
  const base = (details as unknown as Record<string, ExperimentDetail>).exp_heldout;
  const zero = { queued: 0, running: 0, done: 0, infra_failed: 0, abandoned: 0, cancelled: 0 };
  const orphan: ExperimentDetail = {
    ...base,
    id: 'e_orphan',
    status: 'created',
    plan_commit: null,
    started_at: null,
    finished_at: null,
    actual: null,
    spend_usd: 0,
    counts: { ...zero, queued: 120, by_label: {}, done_by_end_state: {} },
    arms: base.arms.map((a) => ({ ...a, status: 'not_started' as const, counts: { ...zero, queued: 60 } })),
    events: [],
  };
  // The two arms differ in the prompt only, as the sample run's do.
  const promptDiff = () => vi.spyOn(api, 'configDiff').mockResolvedValue([{ path: 'prompt.sha256', a: 'sha256:a', b: 'sha256:b' }]);
  const routes = (detail: ExperimentDetail) => ({
    [`/api/experiments/${detail.id}`]: detail,
    [`/api/experiments/${detail.id}/trials`]: [],
    '/api/harnesses': harnessesJson,
    '/api/prompts': [],
    '/api/tasks': [],
    '/api/models': [],
  });

  it('says what it still needs, takes the plan commit and starts it after the paid-run check', async () => {
    routeFetch(routes(orphan));
    promptDiff();
    const start = vi.spyOn(api, 'startExperiment').mockResolvedValue({ ...orphan, status: 'running', plan_commit: '3e1a9f0' });
    const w = mount(RunView, { props: { experimentId: 'e_orphan' } });
    await settle();
    expect(w.get('[data-test="unstarted"]').text()).toContain('This run was set up but never started, so nothing has run.');
    expect(checkTexts(w).some((c) => c.startsWith('No analysis plan commit yetCheck failed.'))).toBe(true);
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeDefined();
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeUndefined();
    expect(w.get('[data-test="start"]').text()).toBe('Start 120 trials');
    await w.get('[data-test="start"]').trigger('click');
    await w.get('[data-test="confirm-paid-start"]').trigger('click');
    await settle();
    expect(start).toHaveBeenCalledWith('e_orphan', { plan_commit: '3e1a9f0' });
  });

  it('needs no plan commit on fake models, and starts it without asking about money', async () => {
    const fake = { ...orphan, id: 'e_fake_orphan', sim_model: 'fake/sim-client', configs: [fakeA, fakeB], config_hashes: [fakeA.hash, fakeB.hash] };
    routeFetch(routes(fake));
    promptDiff();
    const start = vi.spyOn(api, 'startExperiment').mockResolvedValue({ ...fake, status: 'running' });
    const w = mount(RunView, { props: { experimentId: 'e_fake_orphan' } });
    await settle();
    expect(w.find('[data-test="plan-commit"]').exists()).toBe(false);
    await w.get('[data-test="start"]').trigger('click');
    await settle();
    expect(start).toHaveBeenCalledWith('e_fake_orphan');
  });

  it('can be discarded, after a second click; nothing is deleted', async () => {
    routeFetch(routes(orphan));
    const discard = vi.spyOn(api, 'discardExperiment').mockResolvedValue({ ...orphan, status: 'cancelled' });
    const w = mount(RunView, { props: { experimentId: 'e_orphan' } });
    await settle();
    await w.get('[data-test="discard-ask"]').trigger('click');
    expect(discard).not.toHaveBeenCalled();
    expect(w.get('[data-test="discard"]').text()).toContain('Nothing has run; it is marked stopped and kept in the list, and nothing is deleted.');
    await w.get('[data-test="discard-confirm"]').trigger('click');
    await settle();
    expect(discard).toHaveBeenCalledWith('e_orphan');
    expect(window.location.hash).toBe('#/experiments');
  });

  it('says why when the draft saved it but could not start it', async () => {
    setRunFlash('e_orphan', 'The run was saved but did not start: The platform could not be reached. Check that it is running, then try again. Start it here, or discard it.');
    routeFetch(routes(orphan));
    const w = mount(RunView, { props: { experimentId: 'e_orphan' } });
    await settle();
    expect(w.get('[data-test="action-error"]').text()).toContain('The run was saved but did not start');
    expect(takeRunFlash('e_orphan')).toBeNull(); // read once
  });
});

describe('RunView drafts: N, refusals and the name (QA major 12)', () => {
  useFixtures();

  it('takes only a whole N from 1 to 1,000, says why inline, and keeps Start and the estimate to the valid value', async () => {
    const estimate = vi.spyOn(api, 'estimate');
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    const cases: [string, string][] = [
      ['0', 'Run at least 1 trial per task and arm.'],
      ['-1', 'Run at least 1 trial per task and arm.'],
      ['2.5', 'Trials per task and arm must be a whole number, with no fraction.'],
      ['1001', 'Run at most 1,000 trials per task and arm.'],
      ['1000000000', 'Run at most 1,000 trials per task and arm.'],
      ['', 'Enter how many trials to run per task and arm: a whole number from 1 to 1,000.'],
    ];
    for (const [typed, why] of cases) {
      await w.get('[data-test="n-input"]').setValue(typed);
      await settle();
      expect(w.get('[data-test="n-error"]').text(), typed).toBe(why);
      expect(w.get('[data-test="n-input"]').attributes('aria-invalid')).toBe('true');
      expect(w.get('[data-test="start"]').attributes('disabled'), typed).toBeDefined();
      expect(w.get('[data-test="start"]').text(), typed).toBe('Start');
      expect(w.get('[data-test="plan"] .stat-value').text(), typed).toBe('–');
    }
    for (const [body] of estimate.mock.calls) expect(Number.isInteger(body.n) && body.n >= 1 && body.n <= 1000).toBe(true);
    await w.get('[data-test="n-input"]').setValue('2');
    await settle();
    expect(w.find('[data-test="n-error"]').exists()).toBe(false);
    expect(w.get('[data-test="start"]').text()).toBe('Start 48 trials');
  });

  it('drops an estimate that comes back after a newer one, so Start never offers a stale count', async () => {
    let release: (e: EstimateResponse) => void = () => undefined;
    const late = new Promise<EstimateResponse>((resolve) => (release = resolve));
    const real = api.estimate;
    const estimate = vi.spyOn(api, 'estimate').mockImplementationOnce(() => late);
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    await w.get('[data-test="n-input"]').setValue('2');
    await settle();
    expect(w.get('[data-test="start"]').text()).toBe('Start 48 trials');
    release({ ...(await real({ config_hashes: [cfgV1.hash, cfgV2.hash], task_sha256s: [], n: 5 })), trials: 120 });
    await settle();
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(w.get('[data-test="start"]').text()).toBe('Start 48 trials');
    expect(w.get('[data-test="plan"]').text()).toContain('48');
  });

  it('shows a refusal at create in plain words, never the API’s field names', async () => {
    vi.spyOn(api, 'createExperiment').mockRejectedValue(new ApiError(400, 'invalid_experiment', 'config_hashes lists the same hash twice'));
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    await w.get('[data-test="start"]').trigger('click');
    await w.get('[data-test="confirm-paid-start"]').trigger('click');
    await settle();
    expect(w.get('[data-test="action-error"]').text()).toBe('Arm A and arm B are the same agent. Pick a different agent for one of them.');
    expect(w.text()).not.toContain('config_hashes');
  });

  it('opens the saved run when it was created but did not start, and says why there', async () => {
    const created = { ...(details as unknown as Record<string, ExperimentDetail>).exp_heldout, id: 'e_saved', status: 'created' as const };
    vi.spyOn(api, 'createExperiment').mockResolvedValue(created);
    vi.spyOn(api, 'startExperiment').mockRejectedValue(new ApiError(0, 'unreachable', 'The API could not be reached (Failed to fetch)'));
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    await w.get('[data-test="plan-commit"]').setValue('3e1a9f0');
    await settle();
    await w.get('[data-test="start"]').trigger('click');
    await w.get('[data-test="confirm-paid-start"]').trigger('click');
    await settle();
    expect(window.location.hash).toBe('#/experiments/e_saved/run');
    expect(takeRunFlash('e_saved')).toBe(
      'The run was saved but did not start: The platform could not be reached. Check that it is running, then try again. Start it here, or discard it.',
    );
  });

  it('names the run "all tasks" only when every task is in it', async () => {
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    const name = () => (w.get('[data-test="run-name"]').element as HTMLInputElement).value;
    expect(name()).toBe('Prompt v1 vs v2, held-out');
    const all = w.findAll('.seg button').find((b) => b.text() === 'All')!;
    await all.trigger('click');
    await settle();
    expect(name()).toBe('Prompt v1 vs v2, all tasks');
    await w.findAll('[data-test="task-pick"] input')[0].setValue(false);
    await settle();
    expect(name()).toBe('Prompt v1 vs v2, 23 tasks');
  });

  it('says the task list scrolls, and how many tasks are in view, until it reaches the end', async () => {
    const w = mount(RunView, { props: { a: cfgV1.hash, b: cfgV2.hash } });
    await settle();
    const list = w.get('[data-test="task-pick"]');
    const el = list.element as HTMLElement;
    const define = (target: HTMLElement, prop: string, value: number) => Object.defineProperty(target, prop, { value, configurable: true, writable: true });
    define(el, 'scrollHeight', 12 * 40);
    define(el, 'clientHeight', 280);
    define(el, 'scrollTop', 0);
    list.findAll('.task-option').forEach((o, i) => {
      define(o.element as HTMLElement, 'offsetTop', i * 40);
      define(o.element as HTMLElement, 'offsetHeight', 32);
    });
    await list.trigger('scroll');
    expect(w.get('[data-test="task-hint"]').text()).toBe('7 of 12 shown, scroll for more');
    expect(list.classes()).toContain('task-pick--more');
    define(el, 'scrollTop', 200);
    await list.trigger('scroll');
    expect(w.find('[data-test="task-hint"]').exists()).toBe(false);
    expect(list.classes()).not.toContain('task-pick--more');
  });
});

describe('RunView progress reads each trial’s grading (QA major 10)', () => {
  it('colours a done trial pass or fail by its grades, and says when grading is incomplete, waiting or has no graders', async () => {
    const detail = (details as unknown as Record<string, ExperimentDetail>).exp_heldout;
    const rows = (experimentTrials as Record<string, TrialRowSummary[]>).exp_heldout;
    const done = rows.filter((t) => t.status === 'done');
    const set: Record<string, Pick<TrialRowSummary, 'grading' | 'passed'>> = {
      [done[0].id]: { grading: 'incomplete', passed: null },
      [done[1].id]: { grading: 'waiting', passed: null },
      [done[2].id]: { grading: 'no_graders', passed: null },
      [done[3].id]: { grading: 'fail', passed: false },
    };
    const trials = rows.map((t) => (set[t.id] ? { ...t, ...set[t.id] } : t));
    routeFetch({ '/api/experiments/exp_heldout': detail, '/api/experiments/exp_heldout/trials': trials, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const grid = w.get('[data-test="run-grid"]');
    expect(grid.findAll('[data-state="incomplete"]')).toHaveLength(1);
    expect(grid.findAll('[data-state="ungraded"]')).toHaveLength(1);
    expect(grid.findAll('[data-state="nograders"]')).toHaveLength(1);
    expect(grid.findAll('[data-state="pass"]').length + grid.findAll('[data-state="fail"]').length).toBe(done.length - 3);
    expect(grid.get('[data-state="incomplete"] .visually-hidden').text()).toContain('graded, incomplete: a required check gave no verdict');
    expect(grid.get('[data-state="ungraded"] .visually-hidden').text()).toContain('done, waiting for its grades');
    expect(w.get('[data-test="legend-incomplete"]').text()).toBe('?Graded, incomplete');
    expect(w.get('[data-test="legend-nograders"]').text()).toBe('·No graders');
    expect(w.get('[data-test="legend-ungraded"]').text()).toBe('Done, waiting for grades');
  });
});

describe('RunView while the whole run is paused (QA major 11)', () => {
  useFixtures();

  it('says Paused on each arm, and the futility reason counts graded trials', async () => {
    const w = mount(RunView, { props: { experimentId: 'exp_futility' } });
    await settle();
    expect(w.get('[data-test="arm-A"] .arm-status').text()).toBe('Paused');
    expect(w.get('[data-test="arm-B"] .arm-status').text()).toBe('Paused');
    expect(w.get('[data-test="arm-A"] .arm-status').attributes('data-status')).toBe('paused');
    const banner = w.get('[data-test="pause-banner"]').text();
    expect(banner).toContain('passed 0 of its first 3 graded trials');
    expect(banner).not.toContain('SP4');
    expect(banner).not.toContain('until graders exist');
  });
});

describe('RunView explains a missing key on the run side (QA major 5)', () => {
  it('names the provider and its key, fixes it with the Resume button, keeps the raw error behind Details', async () => {
    const base = (details as unknown as Record<string, ExperimentDetail>).exp_model;
    const raw = 'trial tm_sip-step-up-15_b_2 (sip-step-up-15 on Prompt v1 on Hermes, Gemini Flash, attempt 1): infra:config_error (LiteLLM status 401): API key not set';
    const detail: ExperimentDetail = {
      ...base,
      arms: base.arms.map((a) => (a.arm === 'B' ? { ...a, paused_reason: raw, fix: 'The provider refused the key ..., then POST /experiments/:id/arms/:config_hash/resume to continue this arm.' } : a)),
    };
    routeFetch({ '/api/experiments/exp_model': detail, '/api/experiments/exp_model/trials': (experimentTrials as Record<string, TrialRowSummary[]>).exp_model, '/api/harnesses': [], '/api/prompts': [], '/api/tasks': [], '/api/models': [] });
    const w = mount(RunView, { props: { experimentId: 'exp_model' } });
    await settle();
    const b = w.get('[data-test="arm-B"]');
    expect(b.get('[data-test="arm-reason"]').text()).toBe('Why: The Gemini API rejected the request: no key is set.');
    const fix = b.get('[data-test="arm-fix"]').text();
    expect(fix).toMatch(/^How to fix it: Add GEMINI_API_KEY to \.env, then restart the stack \(docker compose up -d\)\. Then press Resume arm B: its \d+ waiting trials run\. The trial that failed is not re-run; it stays an infra failure\.$/);
    expect(fix).not.toContain('POST');
    expect(b.get('[data-test="resume-arm-B"]').text()).toBe('Resume arm B');
    expect(b.get('[data-test="arm-details"]').text()).toContain(raw);
    // The config error's own trial is never re-queued (D26): the tally and its cell say so.
    expect(w.get('[data-test="tally"]').text()).toContain('1 infra failure, not re-run, in arm B');
    expect(w.get('[data-test="run-grid"]').findAll('[data-state="final"]')).toHaveLength(1);
    expect(w.get('[data-test="legend-final"]').text()).toBe('–Infra, not re-run');
  });
});
