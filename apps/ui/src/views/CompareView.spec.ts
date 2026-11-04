import { mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Compare, CompareStats } from '../api/types';
import compares from '../fixtures/compares.json';
import details from '../fixtures/experiment-details.json';
import experimentTrials from '../fixtures/experiment-trials.json';
import judge from '../fixtures/judge-agreement.json';
import queue from '../fixtures/label-queue.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import CompareView from './CompareView.vue';

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
    expect(w.get('[data-test="verdict-title"]').text()).toBe('v2 is better');
    const verdict = w.get('[data-test="verdict"]').text();
    expect(verdict).toContain('+15 points of pass rate, from 58% to 73%');
    expect(verdict).toContain('The 95% interval runs from +7 to +23 points');
    expect(verdict).toContain('2 trials stopped on infra failures were re-run and are listed, not dropped. Both were in arm B.');
  });

  it('says why this is not noise, then what it rests on, naming the method only as the payload does', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="why-title"]').map((h) => h.text())).toEqual(['Why this is not noise', 'What it rests on']);
    expect(w.findAll('[data-test="why-line"]').map((p) => p.text())).toEqual([
      'The interval stays above zero.',
      'Check on the method: the same config run twice gave +1 point (−7 to +9), which includes zero, so the method did not invent a difference when nothing changed.',
      'Paired by task: each task is compared with itself across the two arms. Paired task bootstrap, p = 0.003.',
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
    expect(meta.text()).toBe('Hermes 6112c2a with Claude Haiku 5.5 · 120 trials · plan 3e1a9f0, committed before the run · platform c4d2e19');
    // Each group keeps together; the line breaks only at a middot.
    expect(meta.findAll('.nowrap').map((g) => g.text())).toEqual(['Hermes 6112c2a with Claude Haiku 5.5', '120 trials', 'plan 3e1a9f0, committed before the run', 'platform c4d2e19']);
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
    expect(items[0].find('.visually-hidden').exists()).toBe(false);
    expect(items[0].get('.dot').classes()).toContain('dot--b');
    expect(items[0].get('a').attributes('href')).toBe('#/trials/tr_debt-hardship-03_b_2');
  });

  it('draws the hero in arm B colour because B is better, labelled, with the A/A row in grey', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const hero = w.get('[data-test="verdict"] svg[role="img"]');
    expect(hero.findAll('.range').map((r) => toneOf(r.classes(), 'range--'))).toEqual(['b', 'neutral']);
    const labels = [...hero.findAll('[data-test="strip-label"]').map((t) => t.text()), ...w.findAll('[data-test="strip-legend"] li').map((l) => l.text())];
    expect(labels).toEqual(expect.arrayContaining(['v2 minus v1, 12 tasks', 'A/A run, same config twice']));
  });

  it('draws the zero line once for the whole plot column, with ticks every 50 points', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="forest"] line.zero')).toHaveLength(0);
    expect(w.findAll('[data-test="axis"] text').map((t) => t.text())).toEqual(['−100', '−50', '0', '+50', '+100']);
    expect(w.findAll('[data-test="axis"] text').map((t) => t.attributes('x'))).toEqual(['0', '100', '200', '300', '400']);
    for (const r of w.findAll('[data-test="forest-row"]')) expect(r.find('svg line:not(.ci)').exists()).toBe(false);
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
    expect(w.get('.forest thead').text()).toContain('Difference, B minus A, 95% interval (not corrected)');
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
      'Rests on the judge: both tasks that differ are judge-graded. Its agreement with you is κ 0.70, above the 0.6 bar, but the interval (0.47 to 0.88) reaches below it, and it is provisional.',
    );
    expect(caveat.get('a').text()).toBe('agreement with you');
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

  it('says there is no verdict yet when the statistics have not reported', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_harness' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('No verdict yet');
    expect(w.text()).toContain('graded trials');
    expect(w.findAll('[data-test="forest-row"]')).toHaveLength(12);
    expect(w.text()).toContain('No interval yet');
  });
});

describe('CompareView against the API: blind labelling', () => {
  type Trial = { id: string; task: string; config: string; passed: boolean | null };
  const trials = (experimentTrials as unknown as Record<string, Trial[]>).exp_heldout;
  const fd = (details as unknown as { exp_heldout: { tasks: { id: string; sha256: string }[] } }).exp_heldout.tasks.find((t) => t.id === 'fd-vs-sip-07')?.sha256;
  // Every failure of fd-vs-sip-07 is one your label disputes, so the callout can only offer a disputed one.
  const disputedAll = { ...judge, disagreements: trials.filter((t) => t.task === fd && t.passed === false).map((t) => ({ ...judge.disagreements[2], trial_id: t.id })) };
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
      'Check on the method: the same config run twice gave +9 points (+2 to +16), a difference where there is none. Treat this result with caution.',
    );
  });

  it('gives the judge agreement in the aside when a task that differs is code-graded, so no caveat shows', async () => {
    const emi = (details as unknown as { exp_heldout: { tasks: { id: string; sha256: string }[] } }).exp_heldout.tasks.find((t) => t.id === 'emi-basic-01');
    withStats({ tasks: base.stats!.tasks.map((t) => (t.task === emi?.sha256 ? { ...t, significant: true, diff: { estimate: 30, low: 5, high: 55 } } : t)) });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.find('[data-test="judge-caveat"]').exists()).toBe(false);
    expect(w.get('[data-test="judge-line"]').text()).toBe(
      'The judge scored 4 of the 12 tasks. Its agreement with you is κ 0.70, above the 0.6 bar, but the interval (0.47 to 0.88) reaches below it, and it is provisional. See judge agreement',
    );
  });

  it('says the method is unchecked when there is no A/A run', async () => {
    withStats({ aa: null });
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.findAll('[data-test="why-line"]')[1].text()).toBe('No A/A run on this setup yet, so the method has not been checked on a run where nothing changed.');
    expect(w.find('[data-test="export-note"]').exists()).toBe(false);
  });
});
