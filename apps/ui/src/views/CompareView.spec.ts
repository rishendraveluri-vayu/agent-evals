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
      `Check on the method: the same config run twice gave +1${nb}point (−7 to +9), which includes zero, so the method did not invent a difference when nothing changed.`,
      `Paired by task: each task is compared with itself across the two arms. Paired task bootstrap, p${nb}=${nb}0.003.`,
    ]);
    expect(w.text()).not.toContain('Permutation');
    expect(w.text()).not.toContain('wobble');
    expect(w.text()).not.toContain('resampled');
  });

  it('puts the arms on one line, and what they share, the size and the commits on a second', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="arms-line"]').text()).toBe('A: Prompt v1 (config 3b81e04)B: Prompt v2 (config 7f3a9c2)');
    const meta = w.get('[data-test="meta-line"]');
    expect(meta.text()).toBe('Hermes 6112c2a with Claude Haiku 5.5 · simulated client Claude Haiku 5.5 · 120 trials · plan 3e1a9f0, committed before the run · platform c4d2e19');
    // Each group keeps together; the line breaks only at a middot.
    expect(meta.findAll('.nowrap').map((g) => g.text())).toEqual([
      'Hermes 6112c2a with Claude Haiku 5.5',
      'simulated client Claude Haiku 5.5',
      '120 trials',
      'plan 3e1a9f0, committed before the run',
      'platform c4d2e19',
    ]);
    const plan = w.get('[data-test="plan-commit"]');
    expect(plan.text()).toBe('plan 3e1a9f0, committed before the run');
    expect(plan.attributes('href')).toBe('#/experiments/exp_heldout/run');
    expect(w.get('[data-test="platform-commit"]').text()).toBe('platform c4d2e19');
  });

  it('lists each trial stopped on an infra failure, with its arm in words, attempt, cause and re-run', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const items = w.findAll('[data-test="infra-list"] li');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toBe('B · debt-hardship-03 · attempt 1 · infra failure: provider error · re-run passed');
    // The cause never splits across lines.
    expect(items[0].get('.secondary').classes()).toContain('nowrap');
    expect(items[0].get('.secondary').text()).toBe('infra failure: provider error');
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
    expect(labels).toEqual(expect.arrayContaining(['v2 minus v1, 12 tasks', 'A/A run, same config twice']));
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
      "2 tasks differ after Holm's correction for 12 comparisons. The other 10 show no clear difference. At 5 trials per arm their intervals are 40 to 100 points wide, so a real change on one task can hide here.",
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
    expect(verdicts.slice(2).every(([kind, text]) => kind === 'none' && text === 'No clear difference')).toBe(true);
  });

  it('calls out the worst drop in counts, says it is no clear difference, and opens an undisputed failure', async () => {
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
      'No clear difference: its interval includes zero even before correcting for 12 tasks (−40, interval −90 to +10). Open the failed trials to see whether the agent or the grader is behind it.',
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
    expect(w.get('[data-test="axis-caption"]').text()).toBe("B minus A, in points. 95% intervals, not corrected; verdicts after Holm's correction for 12 tasks.");
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

describe('CompareView against the API: no statistics yet', () => {
  it('says there is no verdict yet when every arm is complete but the statistics have not reported', async () => {
    routeFetch({
      '/api/experiments/exp_heldout': (details as Record<string, unknown>).exp_heldout,
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null },
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
    // Not "pending": the verdict is not computed by this version at all.
    expect(w.text()).toContain('does not compute the verdict and its interval yet');
    expect(w.text()).not.toContain('has not reported');
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

  it('labels a shipped example as read-only sample content, by its title, with no judge panel', async () => {
    const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;
    routeFetch({
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
  });
});

describe('CompareView against the API: blind labelling', () => {
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

  it('never says your label disagrees with the judge while held-out outputs remain to label', async () => {
    routeFetch(routes(queue.heldout));
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="look-link"]').text()).toBe('Open a failed trial');
    expect(w.text()).not.toContain('your label disagrees');
    expect(w.html()).not.toContain('your label disagrees');
  });

  it('says so once the held-out set is labelled', async () => {
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
    withStats({ aa: { experiment_id: 'exp_aa', diff: { estimate: 9, low: 2, high: 16 } } });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="why-line"]')[1].text()).toBe(
      `Check on the method: the same config run twice gave +9${nb}points (+2 to +16), a difference where there is none. Treat this result with caution.`,
    );
  });

  it('gives the judge agreement in the aside when a task that differs is code-graded, so no caveat shows', async () => {
    const emi = (details as unknown as { exp_heldout: { tasks: { id: string; sha256: string }[] } }).exp_heldout.tasks.find((t) => t.id === 'emi-basic-01');
    withStats({ tasks: base.stats!.tasks.map((t) => (t.task === emi?.sha256 ? { ...t, significant: true, diff: { estimate: 30, low: 5, high: 55 } } : t)) });
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
    expect(w.get('[data-test="meta-line"]').text()).toBe('Hermes 6112c2a with Claude Haiku 5.5 · 120 trials · plan 3e1a9f0, committed before the run · platform c4d2e19');
  });

  it('says the method is unchecked when there is no A/A run', async () => {
    withStats({ aa: null });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="why-line"]')[1].text()).toBe('No A/A run on this setup yet, so the method has not been checked on a run where nothing changed.');
    expect(w.find('[data-test="export-note"]').exists()).toBe(false);
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
