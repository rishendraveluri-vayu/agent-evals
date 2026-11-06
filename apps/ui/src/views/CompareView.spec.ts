import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { Compare, CompareStats } from '../api/types';
import compares from '../fixtures/compares.json';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import judge from '../fixtures/judge-agreement.json';
import queue from '../fixtures/label-queue.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import { ApiError } from '../api/errors';
import CompareView from './CompareView.vue';

/** A no-break space: numbers keep their unit, and κ and p = keep their value. */
const nb = '\u00a0';

const toneOf = (classes: string[], prefix: string) => classes.find((c) => c.startsWith(prefix))?.slice(prefix.length);

/** Each element follows the one before it in the document. */
function inOrder(w: VueWrapper, selectors: string[]) {
  const els = selectors.map((s) => w.get(s).element);
  return els.every((el, i) => i === 0 || !!(els[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
}

describe('CompareView in fixture mode', () => {
  useFixtures();

  it('leads with the verdict and states the difference with its interval', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('v2 beats v1');
    const verdict = w.get('[data-test="verdict"]').text();
    // Each arm's rate is named; "X to Y" is only ever an interval.
    expect(w.get('.verdict-text').text()).toBe(`+15${nb}points of pass rate: v1 58%, v2 73%. The 95% interval runs from +7 to +23${nb}points.`);
    expect(w.get('.verdict-text strong').text()).toBe(`+15${nb}points`);
    expect(verdict).not.toContain('from 58% to 73%');
    expect(verdict).toContain('2 trials stopped on infra failures were re-run and are listed, not dropped. Both were in arm B.');
  });

  it('says why this is unlikely to be noise, then what it rests on, naming the method only as the payload does', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="why-title"]').map((h) => h.text())).toEqual(['Why this is unlikely to be noise', 'What it rests on']);
    expect(w.findAll('[data-test="why-line"]').map((p) => p.text())).toEqual([
      'The interval stays above zero.',
      `Check on the method: the latest A/A calibration of this config gave +1${nb}point (−7 to +9), which includes zero, so the setup did not invent a difference when nothing changed.`,
      `Paired by task: each task is compared with itself across the two arms, and the 95% interval comes from resampling the tasks 10,000 times. The sign-flip test over every one of the 4,096 ways to flip the tasks' signs gives p${nb}=${nb}0.0039.`,
    ]);
    expect(w.find('[data-test="no-aa"]').exists()).toBe(false);
    expect(w.text()).not.toContain('Permutation');
    expect(w.text()).not.toContain('wobble');
    expect(w.text()).not.toContain('resampled');
  });

  it('puts the arms on one line, and what they share, the size and the commits on a second', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="arms-line"]').text()).toBe('A: Prompt v1 (config 3b81e04)B: Prompt v2 (config 7f3a9c2)');
    const meta = w.get('[data-test="meta-line"]');
    expect(meta.text()).toBe('Hermes 6112c2a with Claude Haiku 5.5 · simulated client Claude Haiku 5.5 · 120 trials · plan 3e1a9f0 (recorded, not checked) · platform c4d2e19');
    // Each group keeps together; the line breaks only at a middot.
    expect(meta.findAll('.nowrap').map((g) => g.text())).toEqual([
      'Hermes 6112c2a with Claude Haiku 5.5',
      'simulated client Claude Haiku 5.5',
      '120 trials',
      'plan 3e1a9f0 (recorded, not checked)',
      'platform c4d2e19',
    ]);
    const plan = w.get('[data-test="plan-commit"]');
    expect(plan.text()).toBe('plan 3e1a9f0 (recorded, not checked)');
    expect(plan.attributes('href')).toBe('#/experiments/exp_heldout/run');
    expect(w.get('[data-test="platform-commit"]').text()).toBe('platform c4d2e19');
  });

  it('lists each trial stopped on an infra failure, with its arm in words, attempt, cause and re-run', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const items = w.findAll('[data-test="infra-list"] li');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toBe('B · debt-hardship-03 · attempt 1 · infra failure: LiteLLM or provider error · re-run passed');
    // The cause never splits across lines.
    expect(items[0].get('.secondary').classes()).toContain('nowrap');
    expect(items[0].get('.secondary').text()).toBe('infra failure: LiteLLM or provider error');
    expect(items[0].find('.visually-hidden').exists()).toBe(false);
    expect(items[0].get('.dot').classes()).toContain('dot--b');
    expect(items[0].get('a').attributes('href')).toBe('#/trials/tr_debt-hardship-03_b_2');
  });

  it('names an arm once when its name is its hash, as in an A/A run', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_aa' } });
    await settle();
    expect(w.get('[data-test="arms-line"]').text()).toBe('A: Config 3b81e04B: Config 3b81e04');
  });

  it("links each arm's count on a task to that arm's trials of the task, a failed one first", async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const row = w.findAll('[data-test="forest-row"]').find((r) => r.get('th').text() === 'fd-vs-sip-07');
    const a = row?.get('[data-test="cell-a"]');
    const b = row?.get('[data-test="cell-b"]');
    expect(a?.attributes('href')).toMatch(/^#\/trials\/tr_fd-vs-sip-07_a_\d+$/);
    expect(b?.attributes('href')).toMatch(/^#\/trials\/tr_fd-vs-sip-07_b_\d+$/);
    expect(b?.attributes('aria-label')).toMatch(/^Arm B on fd-vs-sip-07: \d+ of \d+ passed\. Open its trials of this task$/);
  });

  it('draws the hero in arm B colour because B is better, labelled, with the A/A row in grey', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const hero = w.get('[data-test="verdict"] svg[role="img"]');
    expect(hero.findAll('.range').map((r) => toneOf(r.classes(), 'range--'))).toEqual(['b', 'neutral']);
    const labels = [...hero.findAll('[data-test="strip-label"]').map((t) => t.text()), ...w.findAll('[data-test="strip-legend"] li').map((l) => l.text())];
    expect(labels).toEqual(expect.arrayContaining(['v2 minus v1, 12 tasks', 'A/A calibration, same config twice']));
  });

  it('draws the zero line once for the whole plot column, with a centred, stubbed tick every 50 points', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="forest"] line.zero')).toHaveLength(0);
    const labels = w.findAll('[data-test="axis-label"]');
    expect(labels.map((t) => t.text())).toEqual(['−100', '−50', '0', '+50', '+100']);
    expect(labels.map((t) => Number(t.attributes('x')))).toEqual([18, 109, 200, 291, 382]);
    expect(labels.every((t) => t.attributes('text-anchor') === 'middle')).toBe(true);
    // A 3-unit stub under each label, at the label's x.
    const stubs = w.findAll('[data-test="axis-stub"]');
    expect(stubs.map((l) => Number(l.attributes('x1')))).toEqual([18, 109, 200, 291, 382]);
    for (const l of stubs) expect(Number(l.attributes('y2')) - Number(l.attributes('y1'))).toBe(3);
    expect(stubs.map((l) => l.classes()[0])).toEqual(['tick-stub', 'tick-stub', 'zero-stub', 'tick-stub', 'tick-stub']);
    for (const r of w.findAll('[data-test="forest-row"]')) expect(r.find('svg line:not(.ci)').exists()).toBe(false);
    // An interval that reaches +100 ends exactly under the centre of the +100 label.
    const distress = w.findAll('[data-test="forest-row"]').find((r) => r.get('th').text() === 'distress-12');
    expect(Number(distress?.get('line.ci').attributes('x2'))).toBe(382);
  });

  it('draws one forest-plot row per task, largest difference first, coloured only where it holds up', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const rows = w.findAll('[data-test="forest-row"]');
    expect(rows).toHaveLength(12);
    expect(rows[0].text()).toContain('distress-12');
    expect(rows[0].text()).toContain('1 of 5');
    expect(rows[0].text()).toContain('+80 (+40 to +100)');
    const coloured = rows.filter((r) => toneOf(r.get('line.ci').classes(), 'ci--') !== 'neutral').map((r) => r.get('th').text());
    expect(coloured).toEqual(['distress-12', 'debt-hardship-03']);
    for (const r of rows) expect(toneOf(r.get('line.ci').classes(), 'ci--')).toBe(toneOf(r.get('circle.pt').classes(), 'pt--'));
    const last = rows[11];
    expect(last.text()).toContain('fd-vs-sip-07');
    expect(last.text()).toContain('−40 (−90 to +10)');
    expect(last.find('svg').attributes('aria-label')).toBe('fd-vs-sip-07: −40 points, interval −90 to +10');
    expect(w.get('[data-test="task-summary"]').text()).toBe(
      "2 tasks differ after the Benjamini-Hochberg correction for 12 comparisons. The other 10 are within noise. At 5 trials per arm their intervals are 40 to 100 points wide, so a real change on one task can hide here.",
    );
    expect(w.get('.forest thead').text()).toContain('Difference in points, B minus A, 95% interval (not corrected)');
  });

  it('tags only the tasks that hold up, with one vocabulary for the rest', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const verdicts = w.findAll('[data-test="task-verdict"] [data-verdict]').map((v) => [v.attributes('data-verdict'), v.text()]);
    expect(verdicts.slice(0, 2)).toEqual([
      ['better', 'Better'],
      ['better', 'Better'],
    ]);
    expect(verdicts.slice(2).every(([kind, text]) => kind === 'none' && text === 'Within noise')).toBe(true);
  });

  it('calls out the worst drop in counts, says it is within noise, and opens an undisputed failure', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const fd = w.findAll('[data-test="forest-row"]')[11];
    // The row link opens the same trial as the callout's button.
    expect(fd.get('a').attributes('href')).toBe('#/trials/tr_fd-vs-sip-07_b_4');
    expect(fd.get('a').attributes('aria-label')).toBe('Open a failed trial of fd-vs-sip-07, arm B');
    expect(fd.get('a').attributes('title')).toBe('Open a failed trial of fd-vs-sip-07, arm B');
    const look = w.get('[data-test="worth-a-look"]');
    expect(look.classes()).not.toContain('panel');
    expect(look.get('h3').text()).toBe('Worth a look: fd-vs-sip-07 fell from 4 of 5 to 2 of 5');
    expect(w.findAll('h2, h3').filter((h) => h.text().startsWith('Worth a look'))).toHaveLength(1);
    expect(look.text()).toContain(
      'Within noise: its interval includes zero even before correcting for 12 tasks (−40, interval −90 to +10). Open the failed trials to see whether the agent or the grader is behind it.',
    );
    expect(look.text()).not.toContain('got worse');
    expect(look.text()).not.toContain('B passed');
    // tr_fd-vs-sip-07_b_3 is the trial where your held-out label disputes the judge's fail.
    const link = look.get('[data-test="look-link"]');
    expect(link.attributes('href')).not.toBe('#/trials/tr_fd-vs-sip-07_b_3');
    expect(link.attributes('href')).toBe('#/trials/tr_fd-vs-sip-07_b_4');
    expect(link.text()).toBe('Open a failed trial');
  });

  it('says under the figure that the result rests on the judge, then gives the next step, in the answer column', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const caveat = w.get('[data-test="judge-caveat"]');
    expect(caveat.text()).toBe(
      `Rests on the judge: both tasks that differ need the judge's pass (debt-hardship-03 also has a state check). Its agreement with you is κ${nb}0.70, above the 0.6 bar, but the interval (0.47 to 0.88) reaches below it, and it is provisional.`,
    );
    expect(caveat.get('a').text()).toBe('agreement with you');
    // The task id is a literal identifier: mono, and kept whole.
    expect(caveat.findAll('.mono').map((m) => m.text())).toEqual(['debt-hardship-03']);
    expect(caveat.get('a').attributes('href')).toBe('#/labels/judge');
    expect(inOrder(w, ['[data-test="verdict-title"]', '.verdict-main svg[role="img"]', '[data-test="judge-caveat"]', '[data-test="worth-a-look"]', '.verdict-why'])).toBe(true);
    expect(w.get('.verdict-main').find('[data-test="worth-a-look"]').exists()).toBe(true);
    // Nothing follows the task table.
    expect(w.get('#tasks').element.closest('section')?.nextElementSibling).toBeNull();
    // The caveat already gives kappa, the bar and that it is provisional, so the aside does not.
    const line = w.get('[data-test="judge-line"]');
    expect(line.text()).toBe('The judge scored 4 of the 12 tasks, including both that differ. See judge agreement');
    expect(line.text()).not.toContain('κ');
    expect(line.text()).not.toContain('Provisional');
    expect(line.get('a').attributes('href')).toBe('#/labels/judge');
    expect(w.get('.verdict-why').text()).not.toContain('leans on the judge');
  });

  it('says on a phone what the shared axis shows, and that export needs the API in sample mode', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="axis-caption"]').text()).toBe('B minus A, in points. 95% intervals, not corrected; verdicts after the Benjamini-Hochberg correction for 12 tasks.');
    expect(w.get('[data-test="export-note"]').text()).toBe('Export needs the API');
    expect(w.get('.actions button').attributes('disabled')).toBeDefined();
  });

  it('draws each cost bar on a rail that is its tile’s scale', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('#costs').text()).toBe('Pass rate and what it costs');
    const tiles = w.findAll('.metrics > div');
    expect(tiles[0].text()).toContain('interval +7 to +23 points');
    expect(tiles[0].get('[data-test="bar-a"]').attributes('style')).toContain('width: 58');
    expect(tiles[1].get('[data-test="bar-b"]').attributes('style')).toContain('width: 100%');
    for (const t of tiles) expect(t.findAll('.rail')).toHaveLength(2);
  });

  it('shows no comparison while an arm is still running, and says why (D37)', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('No comparison until every arm is complete');
    expect(w.get('[data-test="incomplete-reason"]').text()).toBe(
      'Arm A has 29 trials queued or running; arm B has 31 trials queued or running. A verdict needs the full planned N, so no pass counts are shown off a partial run.',
    );
    const arms = w.findAll('[data-test="arm-progress"] li').map((li) => li.text());
    expect(arms).toEqual(['A: Own loop, prompt v1, running, 31 of 60 done', 'B: Prompt v1 on Hermes, running, 29 of 62 done']);
    expect(w.text()).not.toContain('graded trials');
  });

  it('names the paused arm as the reason there is no comparison', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_model' } });
    await settle();
    expect(w.get('[data-test="incomplete-reason"]').text()).toContain('Arm B is paused: trial tm_');
    expect(w.findAll('[data-test="arm-progress"] li')[1].text()).toContain('paused');
  });
});

describe('CompareView against the API: trials stopped on infra failures', () => {
  it('says an abandoned attempt was re-run when its next attempt ran, and why it stopped (U6)', async () => {
    type Row = { id: string; status: string; label: string | null; attempt: number; passed: boolean | null };
    const rows = (experimentTrials as unknown as Record<string, Row[]>).exp_heldout;
    // The first attempt went quiet (abandoned, no label) and its re-run passed; the second stop
    // has no re-run, on a run that is over.
    const trials = rows
      .map((t) => (t.id === 'tr_debt-hardship-03_b_2' ? { ...t, status: 'abandoned', label: null } : t))
      .filter((t) => t.id !== 'tr_fd-vs-sip-07_b_2_attempt2');
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': compares.exp_heldout,
      '/api/experiments/exp_heldout/trials': trials,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const items = w.findAll('[data-test="infra-list"] li').map((li) => li.text());
    expect(items).toEqual([
      'B · debt-hardship-03 · attempt 1 · infra failure: its worker stopped sending heartbeats · re-run passed',
      'B · fd-vs-sip-07 · attempt 1 · infra failure: LiteLLM or provider error · not re-run',
    ]);
    // Not every stop was re-run, so the verdict box does not say they were.
    expect(w.get('[data-test="verdict"]').text()).toContain('2 trials stopped on infra failures are listed, not dropped.');
  });
});

describe('CompareView against the API: caveats from the statistics (review S6, S12)', () => {
  it('says when trial counts are uneven between arms, and when the judge decided outcomes in the tasks that differ', async () => {
    const base = compares.exp_heldout as unknown as { stats: Record<string, unknown> };
    const task = { task: 'sha256:x', task_id: 'debt-hardship-03', a: 10, b: 3 };
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': {
        ...base,
        stats: {
          ...base.stats,
          unequal_decided: { ratio: 2, tasks: [task], text: 'One task has more than twice as many decided trials in one arm as in the other (debt-hardship-03: 10 against 3).' },
          rests_on_judge: { differing: 4, tasks: [{ ...task, a: 2, b: 1 }], all: false },
        },
      },
      '/api/experiments/exp_heldout/trials': (experimentTrials as unknown as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="unequal-decided"]').text()).toBe('Uneven trial counts: One task has more than twice as many decided trials in one arm as in the other (debt-hardship-03: 10 against 3).');
    expect(w.get('[data-test="judge-decided"]').text()).toBe('Decided by the judge: 1 of the 4 tasks that differ (debt-hardship-03) had at least one outcome decided by the LLM judge.');
  });

  it('says when an arm has fewer trials than planned because a slot ended with only infra failures (soak test, 6 Nov)', async () => {
    const base = compares.exp_heldout as unknown as { stats: Record<string, unknown> };
    const text =
      "The arms' trial counts are unequal: arm A has 105 of its 105 planned trials and arm B has 104 of its 105 planned trials. " +
      '1 slot on 1 task (draft-convo-where-to-start) ended with no trial to grade, every attempt an infra failure, and the verdict uses the trials each arm has.';
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': {
        ...base,
        stats: { ...base.stats, missing_trials: { planned: 5, a: 0, b: 1, tasks: [{ task: 'sha256:x', task_id: 'draft-convo-where-to-start', a: 0, b: 1 }], text } },
      },
      '/api/experiments/exp_heldout/trials': (experimentTrials as unknown as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="missing-trials"]').text()).toBe(`Missing trials: ${text}`);
  });

  it('shows neither when the statistics have none (every shipped run)', async () => {
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': compares.exp_heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as unknown as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="unequal-decided"]').exists()).toBe(false);
    expect(w.find('[data-test="judge-decided"]').exists()).toBe(false);
    expect(w.find('[data-test="missing-trials"]').exists()).toBe(false);
  });
});

describe('CompareView against the API: figures written without a tool (D61)', () => {
  const route = (prose: unknown) =>
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), prose_figures: prose },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
  const proseTile = (w: VueWrapper) => w.findAll('[data-test="behaviour-tile"]').find((t) => t.text().startsWith('Figures written without a tool'));

  it('shows each arm’s figures derived in prose with how the arms behaved, as a measure, not a gate', async () => {
    route([
      { arm: 'A', trials_measured: 4, trials_unmeasured: 0, amounts: 40, derived_in_prose: 12, per_trial: 3, share: 0.3 },
      { arm: 'B', trials_measured: 3, trials_unmeasured: 1, amounts: 24, derived_in_prose: 0, per_trial: 0, share: 0 },
    ]);
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const tile = proseTile(w);
    expect(tile?.text()).toContain('−3.0 per trial');
    // In plain words: no decision-log number on screen.
    expect(tile?.text()).toContain('12 of 40 figures and 0 of 24 figures, checked by recomputing them; a measure, not a gate; 1 trial whose checks predate this measure not counted');
    expect(tile?.get('[data-test="bar-a"]').attributes('style')).toContain('width: 100%');
    expect(tile?.get('[data-test="bar-b"]').attributes('style')).toContain('width: 0%');
    // Not a second time beside the pass rate and costs.
    expect(w.findAll('.metrics > div').some((t) => t.text().startsWith('Figures written without a tool'))).toBe(false);
  });

  it('shows no such tile when an arm has no measured trial, or the API predates D61', async () => {
    route([
      { arm: 'A', trials_measured: 0, trials_unmeasured: 4, amounts: 0, derived_in_prose: 0, per_trial: null, share: null },
      { arm: 'B', trials_measured: 3, trials_unmeasured: 0, amounts: 24, derived_in_prose: 0, per_trial: 0, share: 0 },
    ]);
    let w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.text()).not.toContain('Figures written without a tool');
    route(undefined);
    w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.text()).not.toContain('Figures written without a tool');
  });
});

describe('CompareView: how the arms behaved (D64)', () => {
  const base = compares.exp_heldout as unknown as Compare;
  const route = (over: Partial<Compare> = {}, labels: unknown[] = queue.heldout) =>
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...base, ...over },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': labels,
    });
  const rows = (w: VueWrapper, table: string) =>
    w
      .get(`[data-test="${table}"]`)
      .findAll('tbody tr')
      .map((tr) => tr.findAll('th, td').map((c) => c.text()));

  it('sits after the pass rate and costs and before where B dropped, and says it is no verdict', async () => {
    route();
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(inOrder(w, ['#costs', '[data-test="behaviour"]', '[data-test="regressions"]'])).toBe(true);
    const section = w.get('[data-test="behaviour"]');
    expect(section.get('h2').text()).toBe('How the arms behaved');
    expect(section.text()).toContain('These explain the pass rate; none of them is a verdict.');
    expect(section.findAll('[data-test="behaviour-tile"]').map((t) => t.get('.stat-label').text())).toEqual(['Tool calls per trial', 'Steps per trial', 'Tool errors per trial', 'Figures written without a tool']);
  });

  it('gives tool calls and steps per trial as B minus A with their interval, and step-limit hits per arm', async () => {
    route();
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const [calls, steps, errors] = w.findAll('[data-test="behaviour-tile"]').map((t) => t.text());
    expect(calls).toContain('+0.3 per trial');
    expect(calls).toContain('interval −0.4 to +0.8, B minus A per task over 12 tasks; no verdict');
    expect(calls).toContain('A 1.5');
    expect(calls).toContain('B 1.8');
    expect(steps).toContain('Stopped at the step limit: A 1 of 60, B 0 of 60');
    expect(errors).toContain('A: no tool errors; B: 1 error in 1 trial');
    expect(errors).not.toContain('0 errors in 0 trials');
  });

  it('lists tools as rows with both arms per trial side by side, marking the differences', async () => {
    route();
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const table = w.get('[data-test="tool-table"]');
    expect(table.findAll('thead th').map((th) => th.text())).toEqual(['Tool', 'A', 'B', 'B − A']);
    const byTool = Object.fromEntries(rows(w, 'tool-table').map((r) => [r[0].split(' ')[0], r]));
    expect(byTool.get_client_profile.slice(1)).toEqual(['0.3', '0.3', '+0.05']);
    expect(byTool.add).toEqual(['add only in B', '0.0', '0.2', '+0.2']);
    expect(byTool.round[0]).toBe('round only in A');
    // An error is counted under the arm whose call returned it.
    expect(byTool.sip_future_value[2]).toBe('0.21 error');
    const marked = table.findAll('[data-test="tool-mark"]').map((m) => m.text());
    expect(marked).toContain('only in B');
    expect(marked).not.toContain('differs');
  });

  it('gives the share of trials that called each tool their task needs, and how trials ended', async () => {
    route();
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(rows(w, 'required-table').find((r) => r[0] === 'list_debts')).toEqual(['list_debts', '80%12 of 15', '100%15 of 15']);
    expect(rows(w, 'end-table')).toEqual([
      ['Agent answered', '59 of 60', '60 of 60'],
      ['Hit the step limit', '1 of 60', '0 of 60'],
    ]);
  });

  it('counts each cause per arm in rule order, primary and also, and says how causes are decided', async () => {
    route({}, []);
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const causes = rows(w, 'cause-table');
    expect(causes.map((r) => r[0])).toEqual(['Ran out of steps', 'Judge disagrees with your label', 'Wrong tool', 'Gave up early', 'Made-up tool arguments', 'Tool error, not recovered', 'Figure with no source', 'Wrong answer', 'Other']);
    expect(causes.find((r) => r[0] === 'Figure with no source')).toEqual(['Figure with no source', '7also 2', '4also 1']);
    expect(w.get('[data-test="behaviour"]').text()).toContain('Trials with a cause: A 25 of 60, B 16 of 60.');
    const rules = w.get('[data-test="cause-rules"]');
    expect(rules.get('summary').text()).toBe('How causes are decided');
    expect(rules.findAll('li')).toHaveLength(9);
    expect(rules.text()).toContain('Wrong tool. A tool the task needs was never called and another tool was');
    expect(w.find('[data-test="cause-blind"]').exists()).toBe(false);
  });

  it('counts where the judge and your labels disagree as its own cause while held-out outputs remain to label', async () => {
    route();
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const causes = rows(w, 'cause-table');
    expect(causes.find((r) => r[0] === 'Judge disagrees with your label')).toEqual(['Judge disagrees with your label', '0', '1']);
    expect(causes.map((r) => r[0])).not.toContain('A judge check failed');
    const rules = w.get('[data-test="cause-rules"]');
    expect(rules.findAll('li')).toHaveLength(9);
    expect(rules.text()).toContain('Judge disagrees with your label. On a check you labelled, the judge’s verdict differs from your label.');
    expect(w.find('[data-test="cause-blind"]').exists()).toBe(false);
  });

  it('says on each task where B dropped which causes grew from A to B, and the opened trial’s cause', async () => {
    route();
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const [fd, payoff] = w.findAll('[data-test="regression"]');
    expect(payoff.get('[data-test="regression-causes"]').text()).toBe('More common in B: gave up early, 0 → 2; wrong tool, 0 → 1');
    expect(payoff.get('[data-test="regression-link-cause"]').text()).toBe('· wrong tool');
    // The judge against your label is named, though held-out outputs remain to label (7 Nov).
    expect(fd.get('[data-test="regression-causes"]').text()).toBe('More common in B: other, 0 → 2; judge disagrees with your label, 0 → 1');
    expect(fd.get('[data-test="regression-link-cause"]').text()).toBe('· judge disagrees with your label');
  });

  it('names the judge against your label on the regression list the same way once the held-out outputs are labelled', async () => {
    route({}, []);
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const fd = w.findAll('[data-test="regression"]')[0];
    expect(fd.get('[data-test="regression-causes"]').text()).toBe('More common in B: other, 0 → 2; judge disagrees with your label, 0 → 1');
    expect(fd.get('[data-test="regression-link-cause"]').text()).toBe('· judge disagrees with your label');
  });

  it('shows no behaviour section when the API has none (an older API, or a run not complete)', async () => {
    route({ behaviour: undefined as unknown as null });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="behaviour"]').exists()).toBe(false);
    expect(w.find('[data-test="regression"]').exists()).toBe(true);
  });

  it('shows one column and no difference for a pilot of one arm', async () => {
    const one = { ...base.behaviour!, arms: [base.behaviour!.arms[0]], paired: [] };
    route({ behaviour: one, prose_figures: [] });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="tool-table"]').findAll('thead th').map((th) => th.text())).toEqual(['Tool', 'A']);
    expect(w.find('[data-test="tool-mark"]').exists()).toBe(false);
    expect(w.findAll('[data-test="behaviour-tile"]')[0].text()).toContain('1.5 per trial');
  });
});

describe('CompareView against the API: no statistics yet', () => {
  it('says there is no verdict yet, and why, when every arm is complete but grading is still running', async () => {
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null, stats_note: 'Grading is still running for 3 of 120 finished trials; the verdict waits for every grade.' },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('No verdict yet');
    expect(w.text()).toContain('graded trials');
    expect(w.findAll('[data-test="forest-row"]')).toHaveLength(12);
    expect(w.text()).toContain('no interval');
    // The API's reason, as it gave it; never a claim that this version computes no verdict.
    expect(w.text()).toContain('Grading is still running for 3 of 120 finished trials; the verdict waits for every grade. Read these as counts, not a conclusion');
    expect(w.text()).not.toContain('does not compute');
    expect(w.find('[data-test="regressions"]').exists()).toBe(false);
  });

  it('says the arms were not graded alike, and how to fix it, when a required check differs between them (D72)', async () => {
    const note =
      'The two arms were not graded alike (D72): 1 required check on 1 of 12 tasks has current grades from different grader versions, which would score the arms by different rules: advice on payoff-order (its rubric changed). ' +
      'Regrade the experiment (POST /api/experiments/exp_heldout/regrade) so every trial is graded with the graders as they are now; the verdict comes back once those grades are in.';
    const blocking = [{ task: 'sha256:x', task_id: 'payoff-order', grader_id: 'advice', required: true, kind: 'judge', changes: ['files'], versions: [{ grader_version: 'v1', judge_model: 'fake/judge', a: 5, b: 0 }, { grader_version: 'v2', judge_model: 'fake/judge', a: 0, b: 5 }] }];
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null, stats_note: note, grader_versions: { alike: false, blocking, optional: [], note: null } },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('No verdict: the arms were not graded alike');
    // The pass counts stay, as counts; the API's reason and fix follow them as given.
    expect(w.get('.verdict-text').text()).toContain(`graded trials, B passed`);
    expect(w.get('.verdict-text').text()).toContain(`${note} Read these as counts, not a conclusion`);
    expect(w.find('[data-test="grader-versions-note"]').exists()).toBe(false);
  });

  it('shows optional checks graded with different versions beside a verdict that stands (D72)', async () => {
    const note = "1 optional check on 1 task has grades from different versions in the two arms (D72): tone on payoff-order (its rubric changed). Optional checks do not decide a trial's outcome, so the verdict stands; the regression list's pass rates for them compare different versions. A regrade brings them onto one version.";
    const optional = [{ task: 'sha256:x', task_id: 'payoff-order', grader_id: 'tone', required: false, kind: 'judge', changes: ['files'], versions: [] }];
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), grader_versions: { alike: false, blocking: [], optional, note } },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('v2 beats v1');
    expect(w.get('[data-test="grader-versions-note"]').text()).toBe(`Optional checks graded differently: ${note}`);
  });

  it('counts trials with no outcome apart, as neither a pass nor a fail', async () => {
    const base = compares.exp_heldout as { rows: Record<string, unknown>[] };
    const rows = base.rows.map((r, i) => (i === 0 ? { ...r, incomplete: 2 } : r));
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...base, rows, stats: null },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.text()).toContain('2 more trials have no outcome: a required check could not be decided');
    expect(w.text()).toContain('2 undecided');
  });

  it('labels a shipped example as read-only sample content, by its title, with no judge panel, and never fetches the held-out label queue', async () => {
    const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;
    const { calls } = routeFetch({
      '/api/experiments/exp_heldout': { ...detail, example: { name: 'harness-ownloop-vs-hermes-haiku', title: 'Own loop vs Hermes on Claude Haiku 5.5', loaded_at: '2026-11-05T08:00:00.000Z' } },
      '/api/experiments/exp_heldout/compare': compares.exp_heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('h1').text()).toBe('Own loop vs Hermes on Claude Haiku 5.5');
    expect(w.get('[data-test="example-note"]').text()).toContain('read-only');
    expect(w.find('[data-test="judge-panel"]').exists()).toBe(false);
    // Its trials are never in the label queue, and the judge panel is hidden, so neither the queue
    // (every held-out output, a large reply) nor the agreement is fetched.
    expect(calls.map((c) => c.url)).not.toContain('/api/labels/queue?set=heldout');
    expect(calls.map((c) => c.url)).not.toContain('/api/judge/agreement?set=heldout');
    // D83: its judges' trust is read for a read-only section (no calibrate: its trials are never queued).
    expect(calls.map((c) => c.url).filter((u) => u.startsWith('/api/judge/trust'))).toEqual(['/api/judge/trust?experiment=exp_heldout']);
    expect(w.find('[data-test="example-judge-trust"]').exists()).toBe(false); // no judges in this reply
  });

  it('shows a shipped example\'s judges read-only, with their trust and no calibrate button (D83)', async () => {
    const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;
    routeFetch({
      '/api/experiments/exp_heldout': { ...detail, example: { name: 'headline', title: 'Headline', loaded_at: '2026-11-05T08:00:00.000Z' } },
      '/api/experiments/exp_heldout/compare': compares.exp_heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/trust?experiment=exp_heldout': {
        bar: { kappa: 0.6, kappa_low: 0.4, retest: 0.9, min_human_no: 5, max_undefined_share: 0.05, resamples: 2000, human_unsure: 'exclude' },
        judges: [{ judge_model: 'gemini-3.8-flash', rubric: 'configs/rubrics/advice.v4.md', experiments: ['exp_heldout'], trials_judged: 200, criteria: [], status: 'not_trusted', summary: 'Not trusted: kappa 0.00 on 40 held-out labels is below 0.6.' }],
      },
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const s = w.get('[data-test="example-judge-trust"]');
    expect(s.text()).toContain('advice.v4');
    expect(s.text()).toContain('Not trusted');
    expect(s.text()).toContain('Not trusted: kappa 0.00 on 40 held-out labels is below 0.6.');
    expect(w.get('[data-test="example-judge-link"]').attributes('href')).toBe('#/labels/judge');
    expect(w.find('[data-test="judge-calibrate"]').exists()).toBe(false);
  });
});

describe('CompareView against the API: each task row says how its arms stand on grading', () => {
  const base = compares.exp_heldout as { rows: { task: string; arm: string; passed: number; graded: number; incomplete: number; trials: number }[] };
  const tasks = [...new Set(base.rows.map((r) => r.task))];
  /** One task's two rows set as given; every other row as in the sample. */
  function rowsWith(over: Record<string, Partial<Record<'A' | 'B', { passed: number; graded: number; incomplete: number; trials: number }>>>) {
    return base.rows.map((r) => ({ ...r, ...(over[r.task]?.[r.arm as 'A' | 'B'] ?? {}) }));
  }
  async function mountRows(rows: unknown[]) {
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...base, rows, stats: null },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    return w;
  }
  /** The verdict cell's tag and its detail, each as shown. */
  const verdictCell = (row: ReturnType<VueWrapper['findAll']>[number] | undefined) => [row?.get('[data-test="task-verdict"] .result-plain').text(), row?.get('[data-test="task-verdict"] .result-detail').text()];
  const rowOf = (w: VueWrapper, task: string) => {
    const id = (details as Record<string, { tasks: { sha256: string; id: string }[] }>).exp_heldout.tasks.find((t) => t.sha256 === task)?.id ?? '';
    return w.findAll('[data-test="forest-row"]').find((r) => r.get('.c-task').text() === id);
  };

  it('says "Undecided" when every trial in both arms is graded but none decided, never "Not graded yet"', async () => {
    const t = tasks[0];
    const w = await mountRows(rowsWith({ [t]: { A: { passed: 0, graded: 0, incomplete: 1, trials: 1 }, B: { passed: 0, graded: 0, incomplete: 1, trials: 1 } } }));
    const row = rowOf(w, t);
    expect(verdictCell(row)).toEqual(['Undecided', 'no trial in either arm has an outcome']);
    expect(row?.get('.c-a').element.textContent?.trim()).toBe('A\u00a01 undecided');
    expect(w.text()).not.toContain('Not graded yet');
  });

  it('names the undecided arm when the other has an outcome', async () => {
    const t = tasks[1];
    const w = await mountRows(rowsWith({ [t]: { A: { passed: 0, graded: 1, incomplete: 0, trials: 1 }, B: { passed: 0, graded: 0, incomplete: 1, trials: 1 } } }));
    expect(verdictCell(rowOf(w, t))).toEqual(['B undecided', 'arm A has an outcome, arm B none']);
  });

  it('says "Not graded yet" only while grading has not finished, and which arm', async () => {
    const [t1, t2] = [tasks[2], tasks[3]];
    const w = await mountRows(
      rowsWith({
        [t1]: { A: { passed: 0, graded: 0, incomplete: 0, trials: 2 }, B: { passed: 0, graded: 0, incomplete: 0, trials: 2 } },
        [t2]: { A: { passed: 0, graded: 0, incomplete: 1, trials: 1 }, B: { passed: 0, graded: 0, incomplete: 0, trials: 1 } },
      }),
    );
    expect(verdictCell(rowOf(w, t1))).toEqual(['Not graded yet', 'grading has not finished']);
    expect(verdictCell(rowOf(w, t2))).toEqual(['Not graded yet', 'arm B is still grading']);
  });

  it('keeps a space between the arm letter and its count on a phone card', async () => {
    const w = await mountRows(base.rows);
    // The count's link is a flex box, which drops a trailing plain space: the letter keeps a no-break space.
    const letters = w.findAll('.c-a .phone-only, .c-b .phone-only');
    expect(letters.length).toBeGreaterThan(0);
    for (const cell of letters) expect(cell.element.textContent).toMatch(/^[AB]\u00a0$/);
  });
});

describe('CompareView against the API: an experiment on fake models', () => {
  const detail = (details as Record<string, { configs: { model: string }[] } & Record<string, unknown>>).exp_heldout;
  const fakeDetail = { ...detail, configs: detail.configs.map((c) => ({ ...c, model: 'fake/finance-emi' })) };
  function mountFake() {
    const { calls } = routeFetch({
      '/api/experiments/exp_heldout': fakeDetail,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
      '/api/models': [{ name: 'claude-haiku-5-5', input_per_mtok: 1, output_per_mtok: 5 }],
      'POST /api/experiments/exp_heldout/judge': { experiment_id: 'exp_heldout', model: 'claude-haiku-5-5', budget_usd: 2, approved_at: '2026-11-05T08:00:00.000Z' },
      'POST /api/experiments/exp_heldout/regrade': { experiment_id: 'exp_heldout', trials: 40, reused_trials: 0, queued: 40, no_graders: 0, superseded: 0, from_trial_task: 0 },
    });
    return { w: mount(CompareView, { props: { experimentId: 'exp_heldout' } }), calls };
  }

  it('says the costs are made-up prices for testing', async () => {
    const { w } = mountFake();
    await settle();
    const note = w.get('[data-test="fake-cost-note"]').text();
    expect(note).toContain('Made-up prices: Both arms ran on a fake model');
    expect(note).toContain('prices are invented for testing');
  });

  it('warns before approving a real judge for made-up outputs, and asks again before any call', async () => {
    const { w, calls } = mountFake();
    await settle();
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    expect(w.get('[data-test="judge-fake-warning"]').text()).toContain('Both arms ran on a fake model: those outputs are scripted test replies');
    await w.get('[data-test="judge-model-select"]').setValue('claude-haiku-5-5');
    await w.get('[data-test="judge-budget-input"]').setValue('2');
    await w.get('[data-test="judge-approve"]').trigger('submit');
    await settle();
    // The first yes only asks again; nothing is sent.
    expect(w.get('[data-test="judge-fake-confirm"]').text()).toContain('Judge made-up outputs with a real, paid model anyway?');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await w.get('[data-test="judge-fake-cancel"]').trigger('click');
    expect(w.find('[data-test="judge-approve"]').exists()).toBe(false);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // Asked and answered yes twice, it approves and regrades.
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    await w.get('[data-test="judge-model-select"]').setValue('claude-haiku-5-5');
    await w.get('[data-test="judge-budget-input"]').setValue('2');
    await w.get('[data-test="judge-approve"]').trigger('submit');
    await settle();
    await w.get('[data-test="judge-fake-go"]').trigger('click');
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/experiments/exp_heldout/judge', '/api/experiments/exp_heldout/regrade']);
  });

  it('shows no made-up price note and asks once on real models', async () => {
    routeFetch({
      '/api/experiments/exp_heldout': detail,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
      '/api/models': [],
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="fake-cost-note"]').exists()).toBe(false);
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    expect(w.find('[data-test="judge-fake-warning"]').exists()).toBe(false);
  });
});

describe('CompareView against the API: a failure your label disputes', () => {
  type Trial = { id: string; task_sha256: string; config_hash: string; passed: boolean | null };
  const trials = (experimentTrials as unknown as Record<string, Trial[]>).exp_heldout;
  const fd = (details as unknown as { exp_heldout: { tasks: { id: string; sha256: string }[] } }).exp_heldout.tasks.find((t) => t.id === 'fd-vs-sip-07')?.sha256;
  // Every failure of fd-vs-sip-07 is one your label disputes, so the callout can only offer a disputed one.
  const disputedAll = { ...judge, disagreements: trials.filter((t) => t.task_sha256 === fd && t.passed === false).map((t) => ({ ...judge.disagreements[2], trial_id: t.id })) };
  const routes = (labelQueue: unknown) => ({
    '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
    '/api/experiments/exp_heldout/compare': compares.exp_heldout,
    '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
    '/api/judge/agreement?set=heldout': disputedAll,
    '/api/labels/queue?set=heldout': labelQueue,
  });

  it('says your label disagrees with the judge while held-out outputs remain to label, on the button and the task row', async () => {
    routeFetch(routes(queue.heldout));
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="look-link"]').text()).toBe('Open a failed trial (your label disagrees with the judge)');
    expect(w.html()).toContain('Open a failed trial of fd-vs-sip-07, arm B (your label disagrees with the judge)');
  });

  it('says so the same way once the held-out set is labelled', async () => {
    routeFetch(routes([]));
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="look-link"]').text()).toBe('Open a failed trial (your label disagrees with the judge)');
  });
});

describe('CompareView against the API: the check on the method', () => {
  const base = compares.exp_heldout as unknown as Compare;
  function withStats(over: Partial<CompareStats>) {
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...base, stats: { ...base.stats, ...over } },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
  }

  it('warns when the same config run twice showed a difference', async () => {
    withStats({ aa: { ...base.stats!.aa!, diff: { estimate: 9, low: 2, high: 16 }, verdict: 'better' } });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="why-line"]')[1].text()).toBe(
      `Check on the method: the latest A/A calibration of this config gave +9${nb}points (+2 to +16), a difference where there is none. Treat this result with caution.`,
    );
  });

  it('gives the judge agreement in the aside when a task that differs is code-graded, so no caveat shows', async () => {
    const emi = (details as unknown as { exp_heldout: { tasks: { id: string; sha256: string }[] } }).exp_heldout.tasks.find((t) => t.id === 'emi-basic-01');
    withStats({ tasks: base.stats!.tasks.map((t) => (t.task === emi?.sha256 ? { ...t, beyond_noise: true, diff: { estimate: 30, low: 5, high: 55 } } : t)) });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="judge-caveat"]').exists()).toBe(false);
    expect(w.get('[data-test="judge-line"]').text()).toBe(
      `The judge scored 4 of the 12 tasks. Its agreement with you is κ${nb}0.70, above the 0.6 bar, but the interval (0.47 to 0.88) reaches below it, and it is provisional. See judge agreement`,
    );
  });

  it('leaves the simulated client out of the meta line when the experiment has none', async () => {
    routeFetch({
      '/api/experiments/exp_heldout': { ...(details as Record<string, object>).exp_heldout, sim_model: null },
      '/api/experiments/exp_heldout/compare': base,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="sim-client"]').exists()).toBe(false);
    expect(w.get('[data-test="meta-line"]').text()).toBe('Hermes 6112c2a with Claude Haiku 5.5 · 120 trials · plan 3e1a9f0 (recorded, not checked) · platform c4d2e19');
  });

  it('says there is no A/A calibration for these configs yet, and links to set one up for arm A', async () => {
    withStats({ aa: null });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const none = w.get('[data-test="no-aa"]');
    expect(none.text()).toBe('No A/A calibration run for these configs yet, so the setup’s own noise has not been measured on a run where nothing changed. Set one up');
    const a = (details as unknown as { exp_heldout: { config_hashes: string[] } }).exp_heldout.config_hashes[0];
    expect(none.get('[data-test="aa-setup"]').attributes('href')).toBe(`#/run?a=${encodeURIComponent(a)}&b=${encodeURIComponent(a)}&aa=1`);
    expect(w.findAll('[data-test="why-line"]')).toHaveLength(2);
    expect(w.find('[data-test="export-note"]').exists()).toBe(false);
  });

  it('says how large a difference is not ruled out, and that too few tasks allow no other verdict', async () => {
    withStats({ verdict: 'no_detectable_difference', pass_rate_verdict: 'no_detectable_difference', diff: { estimate: 4, low: -9, high: 17 }, p_value: 0.31, not_ruled_out_points: 17 });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('No detectable difference');
    expect(w.get('[data-test="verdict-sub"]').text()).toBe(`Differences as large as 17${nb}points are not ruled out.`);
    withStats({ verdict: 'no_detectable_difference', pass_rate_verdict: 'no_detectable_difference', not_ruled_out_points: 30, tasks: base.stats!.tasks.slice(0, 4) });
    const few = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(few.get('[data-test="verdict-sub"]').text()).toContain(`With 4 tasks in the comparison no other verdict is possible: the paired test needs at least 6 tasks to reach p${nb}<${nb}0.05.`);
    withStats({ verdict: 'no_detectable_difference', pass_rate_verdict: 'no_detectable_difference', diff: { estimate: 0, low: 0, high: 0 }, not_ruled_out_points: null });
    const flat = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(flat.get('[data-test="verdict-sub"]').text()).toBe('Every task gave the same difference, so the interval has no width and cannot say how large a difference could be hiding.');
  });

  it('never says a zero-width interval crosses zero: every task gave the same difference, so no spread can be shown (D55)', async () => {
    withStats({ verdict: 'no_detectable_difference', pass_rate_verdict: 'no_detectable_difference', diff: { estimate: 0, low: 0, high: 0 }, not_ruled_out_points: null });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('.verdict-text').text()).toBe(`0${nb}points of pass rate: v1 58%, v2 73%. The 95% interval has no width: 0 to 0${nb}points.`);
    expect(w.findAll('[data-test="why-title"]')[0].text()).toBe('Why this could be noise');
    expect(w.findAll('[data-test="why-line"]')[0].text()).toBe(`Every task gave the same difference, 0${nb}points, so no spread can be shown: an interval with no width is not a narrow one.`);
    expect(w.text()).not.toContain('crosses zero');
    expect(w.text()).not.toContain('runs from 0 to 0');
  });

  it('heads a zero-width interval by the paired test, since the interval alone shows no spread', async () => {
    withStats({ verdict: 'better', pass_rate_verdict: 'better', diff: { estimate: 10, low: 10, high: 10 }, not_ruled_out_points: null });
    const better = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(better.findAll('[data-test="why-title"]')[0].text()).toBe('Why this is unlikely to be noise');
    expect(better.findAll('[data-test="why-line"]')[0].text()).toBe(`Every task gave the same difference, +10${nb}points, so no spread can be shown: an interval with no width is not a narrow one.`);
    // Clear of zero, but too few tasks for the test: no verdict, so no claim that it is not noise.
    withStats({ verdict: 'no_detectable_difference', pass_rate_verdict: 'no_detectable_difference', diff: { estimate: 10, low: 10, high: 10 }, not_ruled_out_points: null, tasks: base.stats!.tasks.slice(0, 4) });
    const few = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(few.findAll('[data-test="why-title"]')[0].text()).toBe('Why this could be noise');
    expect(few.text()).not.toContain('stays above zero');
  });

  it('never calls an interval clear of zero unlikely to be noise when the paired test does not reach the threshold', async () => {
    // The 5 Nov headline: +9 (+3 to +16), p = 0.0625, because only 5 of the 10 tasks differed.
    const tasks = base.stats!.tasks.slice(0, 10).map((t, i) => ({ ...t, diff: { ...t.diff, estimate: i < 5 ? 10 : 0 } }));
    expect(tasks).toHaveLength(10);
    withStats({ verdict: 'no_detectable_difference', pass_rate_verdict: 'no_detectable_difference', diff: { estimate: 9, low: 3, high: 16 }, p_value: 0.0625, not_ruled_out_points: 16, tasks });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('No detectable difference');
    expect(w.findAll('[data-test="why-title"]')[0].text()).toBe('Why this is not called better');
    expect(w.findAll('[data-test="why-line"]')[0].text()).toBe(`The interval stays above zero, but the verdict rests on the paired sign-flip test, and it gives p${nb}=${nb}0.0625, not below 0.05.`);
    expect(w.get('[data-test="verdict-sub"]').text()).toBe(
      `Differences as large as 16${nb}points are not ruled out. Only 5 of the 10 tasks passed at different rates in the two arms, and only those count in the paired test: over 5 tasks its smallest possible p is 0.0625, so it could not reach p${nb}<${nb}0.05 however large the difference.`,
    );
    expect(w.text()).not.toContain('unlikely to be noise');
    // The same interval going down is "not called worse".
    withStats({ verdict: 'no_detectable_difference', pass_rate_verdict: 'no_detectable_difference', diff: { estimate: -9, low: -16, high: -3 }, p_value: 0.0625, not_ruled_out_points: 16, tasks });
    const down = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(down.findAll('[data-test="why-title"]')[0].text()).toBe('Why this is not called worse');
  });

  it('says what an A/A calibration with no width shows, and what it cannot', async () => {
    withStats({ aa: { ...base.stats!.aa!, diff: { estimate: 0, low: 0, high: 0 }, verdict: 'no_detectable_difference' } });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="why-line"]')[1].text()).toBe(
      `Check on the method: the latest A/A calibration of this config gave 0${nb}points (0 to 0): every task gave the same difference, so it did not invent one, but with no spread it cannot show how much the setup varies.`,
    );
  });

  it('gives each interval the width its shown bounds have: −79 to +79 is 158 points wide, not 159', async () => {
    const wide = { estimate: 0, low: -79.35, high: 79.35 };
    withStats({ tasks: base.stats!.tasks.map((t) => (t.beyond_noise ? t : { ...t, diff: wide })) });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('.forest tbody').text()).toContain('0 (−79 to +79)');
    expect(w.get('[data-test="task-summary"]').text()).toContain('At 5 trials per arm their intervals are 158 points wide, so a real change on one task can hide here.');
    expect(w.get('[data-test="task-summary"]').text()).not.toContain('159');
  });

  it('names practical equivalence by its margin', async () => {
    withStats({ verdict: 'equivalent', pass_rate_verdict: 'equivalent', diff: { estimate: 1, low: -6, high: 8 } });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('Practically equivalent');
    expect(w.get('[data-test="verdict-sub"]').text()).toBe('The whole interval lies inside the ±10-point margin set before the run, so any difference is too small to matter.');
    expect(w.findAll('[data-test="why-title"]')[0].text()).toBe('Why this counts as practically equivalent');
    expect(w.findAll('[data-test="why-line"]')[0].text()).toBe(`The whole interval, −6 to +8${nb}points, lies inside the ±10-point margin set before the run.`);
  });

  it('never heads a practically equivalent result "unlikely to be noise", even when its interval stays clear of zero (S8)', async () => {
    withStats({ verdict: 'equivalent', pass_rate_verdict: 'equivalent', diff: { estimate: 3, low: 1, high: 6 } });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('Practically equivalent');
    const titles = w.findAll('[data-test="why-title"]').map((h) => h.text());
    expect(titles[0]).toBe('Why this counts as practically equivalent');
    expect(titles).not.toContain('Why this is unlikely to be noise');
    expect(w.findAll('[data-test="why-line"]')[0].text()).toBe(
      `The whole interval, +1 to +6${nb}points, lies inside the ±10-point margin set before the run. It stays above zero, but a difference that small is not one that matters.`,
    );
  });

  it('shows the critical-failure guardrail beside the verdict, and holds back a better B when critical failures rose', async () => {
    withStats({});
    let w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const fine = w.get('[data-test="critical"]');
    expect(fine.text()).toBe('Critical checks: Critical failures: −10.0 points (95% interval −30.0 to +0.0) over 2 tasks with 2 critical checks. No rise beyond noise.');
    expect(fine.classes()).not.toContain('caveat--alarm');
    const rose = { ...base.stats!.critical, status: 'rose' as const, diff: { estimate: 20, low: 5, high: 35 }, blocks_better: true, text: 'Critical failures: +20.0 points (95% interval +5.0 to +35.0) over 2 tasks with 2 critical checks. They rose beyond noise, so B is not called better although its pass rate rose.' };
    withStats({ verdict: 'held_back', critical: rose });
    w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('v2 is not called better: critical failures rose');
    expect(w.get('[data-test="verdict-sub"]').text()).toBe('The pass rate alone would say better, but critical failures rose beyond noise, so it is not called better.');
    expect(w.get('[data-test="critical"]').classes()).toContain('caveat--alarm');
    withStats({ critical: { status: 'no_critical_checks', checks: [], tasks: 0, a: null, b: null, diff: null, blocks_better: false, text: 'No check is marked critical in these tasks, so this comparison says nothing about critical failures.' } });
    w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="critical"]').text()).toBe('Critical checks: No check is marked critical in these tasks, so this comparison says nothing about critical failures.');
  });

  it('lists where B dropped, with the checks that got worse and their severity, critical first', async () => {
    withStats({});
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const items = w.findAll('[data-test="regression"]');
    expect(items.map((i) => i.get('.regression-name').text())).toEqual(['fd-vs-sip-07', 'payoff-order-08']);
    expect(items[0].text()).toContain('A 4 of 5, B 2 of 5; −40 (−90 to +10)');
    expect(items[0].findAll('[data-test="regression-grader"]').map((g) => g.text())).toEqual(['fd-tax (major): 4 of 5 in A, 2 of 5 in B']);
    expect(items[0].get('a').attributes('href')).toMatch(/^#\/trials\/tr_fd-vs-sip-07_b_\d+$/);
    expect(items[0].find('.regression-tag--critical').exists()).toBe(false);
    const critical = { ...base.stats!.regressions[1], critical: true, graders: [{ grader_id: 'no-otp-ask', required: true, severity: 'critical' as const, a: { passed: 5, graded: 5 }, b: { passed: 4, graded: 5 } }] };
    withStats({ regressions: [critical, base.stats!.regressions[0]] });
    const w2 = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w2.get('[data-test="regression"]').get('.regression-tag--critical').text()).toBe('critical check got worse');
  });

  it('says under cost, tokens and time that they get an interval but no verdict, and that it covers a little less than it says (S5)', async () => {
    withStats({});
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="costs-note"]').text()).toBe(
      'Cost, tokens and time get an interval but no verdict: only the pass rate is tested. With 12 tasks, a 95% interval here holds the true difference a little less often than 95% of the time.',
    );
    // An A/B run: a cost interval clear of zero is not called setup noise.
    expect(w.find('[data-test="costs-aa-note"]').exists()).toBe(false);
  });

  it('calls a time or cost interval clear of zero on an A/A run setup noise, not a finding (S5)', async () => {
    const wall = { ...base.stats!.costs.find((c) => c.metric === 'wall_s')!, diff: { estimate: 1.51, low: 0.37, high: 2.82 } };
    const cost = { ...base.stats!.costs.find((c) => c.metric === 'cost_usd')!, diff: { estimate: 0, low: -0.002, high: 0.002 } };
    withStats({ calibration: { as_expected: true, text: 'This A/A run found no difference, as it should.' }, aa: null, costs: [cost, wall] });
    let w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="costs-aa-note"]').text()).toBe(
      "A/A run: Both arms ran the same config, so the time interval clear of zero here is the setup's own noise (such as which arm's trials were claimed first, or how loaded the machine was) or chance, not a finding.",
    );
    withStats({ calibration: { as_expected: true, text: 'This A/A run found no difference, as it should.' }, aa: null, costs: [{ ...cost, diff: { estimate: 0.01, low: 0.002, high: 0.02 } }, wall] });
    w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="costs-aa-note"]').text()).toContain('so the cost and time intervals clear of zero here are the setup');
    // With every interval across zero there is nothing to explain away.
    withStats({ calibration: { as_expected: true, text: 'This A/A run found no difference, as it should.' }, aa: null, costs: [cost] });
    w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="costs-aa-note"]').exists()).toBe(false);
    expect(w.find('[data-test="costs-note"]').exists()).toBe(true);
  });

  it('writes the token difference in thousands, as each arm’s tokens are (U14)', async () => {
    const tokens = { ...base.stats!.costs.find((c) => c.metric === 'tokens')!, a: 55700, b: 79300, diff: { estimate: 23572, low: -1250, high: 48100 }, relative: null };
    withStats({ costs: [tokens] });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const tile = w.findAll('.metrics > div').find((t) => t.text().startsWith('Tokens per trial'))!;
    expect(tile.get('.metric-delta').text()).toBe('+23.6k');
    expect(tile.text()).toContain('interval −1.3k to +48.1k');
    expect(tile.text()).toContain('B 79.3k');
    expect(tile.text()).not.toContain('23572');
  });

  it('tags a task in "Where B dropped" beyond noise only when B dropped there, never where a check fell but B rose (S9)', async () => {
    const [drop, other] = base.stats!.regressions;
    const fell = { ...drop, beyond_noise: true, diff: { estimate: -60, low: -100, high: -20 } };
    // Only a check got worse here; the task as a whole went up in B, beyond noise.
    const rose = { ...other, beyond_noise: true, diff: { estimate: 60, low: 20, high: 100 } };
    withStats({ regressions: [fell, rose] });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const items = w.findAll('[data-test="regression"]');
    const tags = items.map((i) => i.findAll('.regression-tag').map((t) => t.text()));
    expect(tags).toEqual([['beyond noise'], []]);
    expect(items[1].text()).toContain('+60 (+20 to +100)');
  });

  it('lists tasks left out of the comparison, with why', async () => {
    withStats({ excluded_tasks: [{ task: 'sha256:x', task_id: 'gold-loan-16', a: { passed: 0, graded: 0, incomplete: 5 }, b: { passed: 2, graded: 5, incomplete: 0 }, why: 'arm A has no decided trial (5 without an outcome)' }] });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="excluded-tasks"]').text()).toBe('Left out of the comparison, because an arm has no decided trial on them:gold-loan-16: arm A has no decided trial (5 without an outcome)');
  });

  it('says plainly whether an A/A calibration run came out as it should', async () => {
    withStats({ calibration: { as_expected: false, text: 'This A/A run found a difference where there should be none.' }, aa: null });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const note = w.get('[data-test="calibration-note"]');
    expect(note.text()).toBe('A/A calibration found a difference: This A/A run found a difference where there should be none.');
    expect(note.classes()).toContain('caveat--alarm');
    // A calibration run is the check itself: no link to set up another.
    expect(w.find('[data-test="no-aa"]').exists()).toBe(false);
  });
});

describe('CompareView: the judge panel, in fixture mode', () => {
  useFixtures();

  it('says judging is not approved, approves it only after a paid-step confirmation with a real model and a budget, then regrades', async () => {
    const approve = vi.spyOn(api, 'approveJudge');
    const regrade = vi.spyOn(api, 'regrade');
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const panel = w.get('[data-test="judge-panel"]');
    expect(panel.text()).toContain('The judge is a model that grades the checks code cannot');
    expect(panel.text()).toContain('so judging costs money');
    expect(panel.get('[data-test="judge-state"]').text()).toBe('Not approved. The judge checks on 4 tasks stay ungraded (“Not judged”) until judging is approved.');
    await panel.get('[data-test="judge-approve-open"]').trigger('click');
    const form = w.get('[data-test="judge-approve"]');
    // Real models only, and nothing picked for you.
    const options = form.findAll('[data-test="judge-model-select"] option').map((o) => o.text());
    expect(options).toEqual(['Pick a model', 'Claude Haiku 5.5', 'Gemini 3.8 Flash']);
    expect(form.get('[data-test="judge-approve-blocked"]').text()).toBe('Pick the model the judge calls.');
    expect(form.get('[data-test="judge-approve-go"]').attributes('disabled')).toBeDefined();
    await form.get('[data-test="judge-model-select"]').setValue('claude-haiku-5-5');
    await form.get('[data-test="judge-budget-input"]').setValue('25');
    expect(form.get('[data-test="judge-budget-problem"]').text()).toBe('The budget must be above $0 and at most $20.');
    await form.get('[data-test="judge-budget-input"]').setValue('two');
    expect(form.get('[data-test="judge-budget-problem"]').text()).toContain('“two” is not one');
    await form.get('[data-test="judge-budget-input"]').setValue('2');
    const confirm = form.get('[data-test="judge-confirm"]').text();
    expect(confirm).toContain('A paid step: approving sends 40 finished trials to Claude Haiku 5.5, one call per judge check, at once.');
    expect(confirm).toContain('It never spends more than $2.');
    expect(approve).not.toHaveBeenCalled();
    await form.get('[data-test="judge-approve-go"]').trigger('submit');
    await settle();
    expect(approve).toHaveBeenCalledWith('exp_heldout', { model: 'claude-haiku-5-5', budget_usd: 2 });
    expect(regrade).toHaveBeenCalledWith('exp_heldout');
    expect(w.get('[data-test="judge-done"]').text()).toMatch(/^Approved: Claude Haiku 5\.5, with a \$2 budget\. Regrade queued for \d+ finished trials/);
    // The panel reads the experiment again: approved, with its model, budget and spend.
    expect(w.get('[data-test="judge-model"]').text()).toBe('Claude Haiku 5.5');
    expect(w.get('[data-test="judge-budget"]').text()).toBe('$2');
    expect(w.get('[data-test="judge-spent"]').text()).toBe('$0');

    // A regrade with the judge is paid too: it asks first.
    await w.get('[data-test="judge-regrade"]').trigger('click');
    expect(w.get('[data-test="judge-regrade-confirm"]').text()).toContain('A paid step: the judge calls Claude Haiku 5.5 again for 40 finished trials with a judge check.');
    await w.get('[data-test="judge-regrade-go"]').trigger('click');
    await settle();
    expect(regrade).toHaveBeenCalledTimes(2);

    // Revoking is there too, and the panel goes back to not approved.
    const revoke = vi.spyOn(api, 'revokeJudge');
    await w.get('[data-test="judge-revoke"]').trigger('click');
    await settle();
    expect(revoke).toHaveBeenCalledWith('exp_heldout');
    expect(w.get('[data-test="judge-done"]').text()).toContain('Judging revoked');
    expect(w.get('[data-test="judge-state"]').text()).toContain('Not approved.');
  });

  it('cancels without a call, and says a refused approval plainly', async () => {
    const approve = vi.spyOn(api, 'approveJudge').mockRejectedValueOnce(new ApiError(400, 'unknown_model', 'LiteLLM serves no priced model x (R8)', 'Pick a model from the list.'));
    const regrade = vi.spyOn(api, 'regrade');
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    await w.get('[data-test="judge-approve-cancel"]').trigger('click');
    expect(w.find('[data-test="judge-approve"]').exists()).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    await w.get('[data-test="judge-model-select"]').setValue('gemini-3.8-flash');
    await w.get('[data-test="judge-budget-input"]').setValue('1.50');
    await w.get('[data-test="judge-approve"]').trigger('submit');
    await settle();
    expect(w.get('[data-test="judge-error"]').text()).toBe('Not approved: LiteLLM serves no priced model x. Pick a model from the list.');
    expect(regrade).not.toHaveBeenCalled();
  });

  it('opens at the judge panel when the address asks for it', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout', panel: 'judge' }, attachTo: document.body });
    await settle();
    expect(document.activeElement?.id).toBe('judge-panel');
    w.unmount();
  });

  it('shows no judge panel for an experiment with no judge check and no approval', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_futility' } });
    await settle();
    expect(w.find('[data-test="judge-panel"]').exists()).toBe(false);
  });
});

describe('CompareView: what arms A and B differ in, by name and value (QA round 3, M1)', () => {
  type Config = Record<string, unknown> & { settings: Record<string, unknown>; settings_sources: Record<string, unknown>; prompt: unknown };
  const detail = (details as unknown as Record<string, Record<string, unknown> & { configs: Config[] }>).exp_heldout;
  const [c1, c2] = detail.configs;
  function mountWith(configs: Config[], over: Record<string, unknown> = {}, compare: unknown = { ...(compares.exp_heldout as object), stats: null }) {
    routeFetch({
      '/api/experiments/exp_heldout': { ...detail, configs, ...over },
      '/api/experiments/exp_heldout/compare': compare,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
      '/api/models': [],
    });
    return mount(CompareView, { props: { experimentId: 'exp_heldout' } });
  }
  const differences = (w: VueWrapper) => w.findAll('[data-test="arm-difference"]').map((li) => li.text());

  it('says a prompt change by version, next to the arm names', async () => {
    const w = mountWith(detail.configs);
    await settle();
    expect(differences(w)).toEqual(['System prompt: v1 in A, v2 in B']);
    expect(inOrder(w, ['[data-test="arms-line"]', '[data-test="arm-differences"]', '[data-test="meta-line"]'])).toBe(true);
  });

  it('names two configs with one name by the setting that differs, and says both values', async () => {
    const name = 'Prompt v1 on Own loop, Fake model finance-emi';
    const a = { ...c1, name, settings: { ...c1.settings, max_steps: 10 } };
    const b = { ...c2, name, prompt: c1.prompt, settings: { ...c1.settings, max_steps: 12 } };
    const w = mountWith([a, b], { axis: 'max_steps', name: `${name} vs ${name}, 12 tasks` });
    await settle();
    expect(w.findAll('[data-test="arm-name"]').map((x) => x.text())).toEqual(['A: Max steps 10 (config 3b81e04)', 'B: Max steps 12 (config 7f3a9c2)']);
    expect(differences(w)).toEqual(['Max steps: 10 in A, 12 in B']);
  });

  it('tells two arms apart by their config names when the axis would name them alike', async () => {
    // Two prompts both at v1, with different text: the prompt names them alike, so the config names do.
    const w = mountWith([c1, { ...c2, prompt: { ...(c2.prompt as object), version: 'v1' } }]);
    await settle();
    expect(w.findAll('[data-test="arm-name"]').map((x) => x.text())).toEqual(['A: Prompt v1 on Hermes (config 3b81e04)', 'B: Prompt v2 on Hermes (config 7f3a9c2)']);
    expect(differences(w)).toEqual(['System prompt: v1 (5c0f1a2) in A, v1 (9d24e7b) in B']);
  });

  it('says a model change in model names, and leaves the model off the shared line', async () => {
    const w = mountWith([c1, { ...c2, prompt: c1.prompt, model: 'claude-sonnet-5-5' }], { axis: 'model' });
    await settle();
    expect(differences(w)).toEqual(['Model: Claude Haiku 5.5 in A, Claude Sonnet 5.5 in B']);
    expect(w.get('[data-test="setup"]').text()).toBe('Hermes 6112c2a, prompt v1');
  });

  it('says a harness change with both versions, and the settings one harness cannot take, on one line', async () => {
    const off = { enabled: false };
    const own = {
      ...c1,
      harness: 'ownloop',
      harness_ref: '0.1.0',
      capabilities_sha256: 'sha256:aaaa',
      settings: { ...c1.settings, memory: null, skills: null, compression: null },
      settings_sources: { ...c1.settings_sources, memory: 'unsupported', skills: 'unsupported', compression: 'unsupported' },
    };
    const hermes = { ...c2, prompt: c1.prompt, settings: { ...c1.settings, memory: off, skills: off, compression: off } };
    const w = mountWith([own, hermes], { axis: 'harness' });
    await settle();
    expect(differences(w)).toEqual(['Harness: Own loop 0.1.0 in A, Hermes Agent 6112c2a in B', 'Memory, skills and compression: not supported in A, off in B']);
    expect(w.get('[data-test="setup"]').text()).toBe('Claude Haiku 5.5, prompt v1');
  });

  it('says nothing differs in an A/A run', async () => {
    const aa = (details as unknown as Record<string, Record<string, unknown>>).exp_aa;
    routeFetch({
      '/api/experiments/exp_aa': aa,
      '/api/experiments/exp_aa/compare': (compares as Record<string, unknown>).exp_aa,
      '/api/experiments/exp_aa/trials': (experimentTrials as Record<string, unknown>).exp_aa ?? [],
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_aa' } });
    await settle();
    expect(w.get('[data-test="arm-differences"]').text()).toBe('What differs Nothing: both arms run the same config, so any difference between them is the noise of the setup.');
  });
});

describe('CompareView: the judge on a model whose key is not set (QA round 3, minor 1)', () => {
  it('says which key the model needs and keeps Approve off, as the Build and Run screens do', async () => {
    const { calls } = routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null },
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
      '/api/models': [
        { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 1, output_per_mtok: 5, key_set: false },
        { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: true },
      ],
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    await settle();
    expect(w.findAll('[data-test="judge-model-select"] option').map((o) => o.text())).toEqual(['Pick a model', 'Claude Haiku 5.5 (needs ANTHROPIC_API_KEY in .env)', 'Gemini 3.8 Flash']);
    await w.get('[data-test="judge-model-select"]').setValue('claude-haiku-5-5');
    await w.get('[data-test="judge-budget-input"]').setValue('2');
    expect(w.get('[data-test="judge-key-problem"]').text()).toBe('Claude Haiku 5.5 needs ANTHROPIC_API_KEY in .env, then docker compose up -d. Until then the judge cannot call it, so judging stays off.');
    const go = w.get('[data-test="judge-approve-go"]');
    expect(go.attributes('disabled')).toBeDefined();
    expect(go.attributes('aria-describedby')).toBe('judge-key-problem');
    // Said once, under the model, not again under the buttons.
    expect(w.find('[data-test="judge-approve-blocked"]').exists()).toBe(false);
    await w.get('[data-test="judge-approve"]').trigger('submit');
    await settle();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // A model whose key is set can be approved.
    await w.get('[data-test="judge-model-select"]').setValue('gemini-3.8-flash');
    expect(w.find('[data-test="judge-key-problem"]').exists()).toBe(false);
    expect(w.get('[data-test="judge-approve-go"]').attributes('disabled')).toBeUndefined();
  });
});

describe('CompareView: a link to an experiment that does not exist (QA round 3, minor 6)', () => {
  useFixtures();

  it('says so under a breadcrumb, with a way out, not as a load error', async () => {
    const w = mount(CompareView, { props: { experimentId: 'e_doesnotexist' } });
    await settle();
    expect(w.find('[data-test="load-error"]').exists()).toBe(false);
    const page = w.get('[data-test="not-found"]');
    expect(page.get('nav').text()).toBe('Experiments / Not found');
    expect(page.get('h1').text()).toBe('No experiment with that id');
    expect(page.text()).toContain('Nothing is saved as e_doesnotexist');
    expect(page.findAll('a').map((a) => a.attributes('href'))).toEqual(['#/experiments', '#/experiments', '#/run']);
  });

  it('keeps a plain load error for anything else', async () => {
    vi.spyOn(api, 'experiment').mockRejectedValueOnce(new ApiError(0, 'unreachable', 'The API could not be reached'));
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="not-found"]').exists()).toBe(false);
    expect(w.get('[data-test="load-error"]').text()).toContain('The API could not be reached');
  });
});

describe('CompareView: a stopped run and a run on fake models (QA round 3, minors 9 and 12)', () => {
  const detail = (details as unknown as Record<string, Record<string, unknown> & { configs: { model: string }[] }>).exp_heldout;
  const stopped = {
    experiment_id: 'exp_heldout',
    status: 'incomplete',
    reason: "the experiment was stopped before every trial ran (40 of arm A's trials cancelled, 41 of arm B's trials cancelled); a verdict needs the full planned N (D32)",
    arms: [],
    rows: [],
    stats: null,
  };
  function mountWith(over: Record<string, unknown>, compare: unknown) {
    routeFetch({
      '/api/experiments/exp_heldout': { ...detail, ...over },
      '/api/experiments/exp_heldout/compare': compare,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
      '/api/models': [],
    });
    return mount(CompareView, { props: { experimentId: 'exp_heldout' } });
  }

  it('says once that a verdict needs the full planned N', async () => {
    const w = mountWith({}, stopped);
    await settle();
    const text = w.get('[data-test="incomplete-reason"]').text();
    expect(text).toBe(
      "The experiment was stopped before every trial ran (40 of arm A's trials cancelled, 41 of arm B's trials cancelled). A verdict needs the full planned N, so no pass counts are shown off a partial run.",
    );
    expect(text.match(/full planned N/g)).toHaveLength(1);
  });

  it('says in the verdict box that a fake run gives scripted test outputs, so most trials fail', async () => {
    const w = mountWith({ configs: detail.configs.map((c) => ({ ...c, model: 'fake/finance-emi' })) }, { ...(compares.exp_heldout as object), stats: null });
    await settle();
    const note = w.get('[data-test="verdict"] [data-test="fake-run-note"]').text();
    expect(note).toBe('Scripted test outputs: Both arms ran on a fake model, which makes the same calls whatever the task, so most trials fail. The counts test the platform, not an agent.');
  });

  it('says it of a stopped run too, and of one fake arm alone', async () => {
    const w = mountWith({ configs: detail.configs.map((c, i) => (i ? { ...c, model: 'fake/finance-emi' } : c)) }, stopped);
    await settle();
    expect(w.get('[data-test="fake-run-note"]').text()).toContain('Arm B ran on a fake model, which makes the same calls whatever the task, so most of its trials fail.');
  });

  it('says nothing of the kind on real models', async () => {
    const w = mountWith({}, { ...(compares.exp_heldout as object), stats: null });
    await settle();
    expect(w.find('[data-test="fake-run-note"]').exists()).toBe(false);
  });
});

describe('CompareView against the API: the judge panel with a reused arm A', () => {
  it("counts the trials arm A reuses from its parent in the paid step, since a regrade judges them too (D72)", async () => {
    const base = (details as Record<string, { arms: { config_hash: string; reused_from: string | null; reused_trials: number }[] }>).exp_heldout;
    const detail = { ...base, arms: [{ ...base.arms[0], reused_from: 'exp_parent', reused_trials: 60 }, base.arms[1]] };
    // The trial list is the experiment's own: arm B's only, since arm A's are the parent's.
    const own = ((experimentTrials as Record<string, { config_hash: string }[]>).exp_heldout).filter((t) => t.config_hash === base.arms[1].config_hash);
    routeFetch({
      '/api/experiments/exp_heldout': detail,
      '/api/experiments/exp_heldout/compare': compares.exp_heldout,
      '/api/experiments/exp_heldout/trials': own,
      '/api/judge/agreement?set=heldout': judge,
      '/api/labels/queue?set=heldout': queue.heldout,
      '/api/models': [{ name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 1, output_per_mtok: 5, key_set: true }],
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    const form = w.get('[data-test="judge-approve"]');
    await form.get('[data-test="judge-model-select"]').setValue('claude-haiku-5-5');
    await form.get('[data-test="judge-budget-input"]').setValue('2');
    // 4 judged tasks of 12: arm B's 20 trials on them, and the 20 of arm A's 60 reused ones.
    expect(form.get('[data-test="judge-confirm"]').text()).toContain('A paid step: approving sends 40 finished trials to Claude Haiku 5.5');
  });
});

describe("CompareView's judge panel: how far to trust the judge (D83)", () => {
  useFixtures();

  it("lists this experiment's judge with its status and summary, says why labels matter, and links to calibrate it", async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const trust = w.get('[data-test="judge-panel"] [data-test="judge-trust"]');
    expect(trust.get('h3').text()).toBe('How far to trust it');
    expect(trust.get('[data-test="judge-trust-why"]').text()).toBe(
      'A judge is only as good as its agreement with people. Label a few of its outputs blind, without seeing its verdicts, and its agreement updates as you go.',
    );
    const rows = trust.findAll('[data-test="judge-trust-row"]');
    expect(rows.map((r) => r.get('[data-test="judge-trust-name"]').text())).toEqual(['Claude Haiku 5.5, rubric advice.v4']);
    expect(rows[0].get('[data-test="trust-label"]').text()).toBe('Not trusted');
    // The API's sentence, without its decision-log reference.
    expect(rows[0].get('[data-test="judge-trust-summary"]').text()).toBe(
      'Tested on 40 held-out labels and it missed the trust bar: read its verdicts as a hint, and look at where it disagrees with people.',
    );
    // Its tasks are held-out tasks, so the labels go to the held-out set, ordered for calibrating.
    const button = trust.get('[data-test="judge-calibrate"]');
    expect(button.text()).toBe('Calibrate this judge');
    expect(button.attributes('href')).toBe('#/labels?set=heldout&experiment=exp_heldout&calibrate=1');
    expect(trust.get('[data-test="judge-trust-link"]').attributes('href')).toBe('#/labels/judge');
  });

  it('calibrates in the tuning set when the experiment ran discovery tasks only', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_model' } });
    await settle();
    const trust = w.get('[data-test="judge-trust"]');
    expect(trust.get('[data-test="trust-label"]').text()).toBe('Tuning only');
    expect(trust.get('[data-test="judge-calibrate"]').attributes('href')).toBe('#/labels?set=tuning&experiment=exp_model&calibrate=1');
  });

  it('lists each judge when two graded the experiment', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_harness' } });
    await settle();
    const rows = w.findAll('[data-test="judge-trust-row"]');
    expect(rows.map((r) => `${r.get('[data-test="judge-trust-name"]').text()}: ${r.get('[data-test="trust-label"]').text()}`)).toEqual([
      'Claude Haiku 5.5, rubric advice.v4: Not trusted',
      'Gemini 3.8 Flash, rubric advice.v4: Trusted',
    ]);
  });
});

describe("CompareView's judge panel against the API: no judge yet", () => {
  it('says no judge has graded the experiment, with no calibrate button, and asks for this experiment only', async () => {
    const { calls } = routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': compares.exp_heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
      '/api/judge/trust?experiment=exp_heldout': { bar: { kappa: 0.6, kappa_low: 0.4, retest: 0.9, min_human_no: 5, max_undefined_share: 0.05, resamples: 2000, human_unsure: 'exclude' }, judges: [] },
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(calls.map((c) => c.url)).toContain('/api/judge/trust?experiment=exp_heldout');
    expect(w.get('[data-test="judge-trust-none"]').text()).toBe("No judge has graded this experiment's outputs yet, so there is nothing to measure. Once one has, how far to trust it shows here.");
    expect(w.find('[data-test="judge-calibrate"]').exists()).toBe(false);
  });

  it('leaves the trust section out when the trust could not be read', async () => {
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': compares.exp_heldout,
      '/api/experiments/exp_heldout/trials': (experimentTrials as Record<string, unknown>).exp_heldout,
      '/api/judge/agreement?set=heldout': null,
      '/api/labels/queue?set=heldout': [],
    });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="judge-panel"]').exists()).toBe(true);
    expect(w.find('[data-test="judge-trust"]').exists()).toBe(false);
  });
});
