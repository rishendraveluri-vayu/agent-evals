import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { settle, useFixtures } from '../test/helpers';
import CompareView from './CompareView.vue';

useFixtures();

const toneOf = (classes: string[], prefix: string) => classes.find((c) => c.startsWith(prefix))?.slice(prefix.length);

describe('CompareView in fixture mode', () => {
  it('leads with the verdict and states the difference with its interval', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('v2 is better');
    const verdict = w.get('[data-test="verdict"]').text();
    expect(verdict).toContain('+15 points of pass rate, from 58% to 73%');
    expect(verdict).toContain('The 95% interval runs from +7 to +23 points');
    expect(verdict).toContain("Running the same config twice moved only +1 point (−7 to +9), so the setup's own wobble is smaller than this difference.");
    expect(verdict).toContain('2 trials stopped on infra failures were re-run and are listed, not dropped');
  });

  it('names the plan and platform commits in the meta line', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const plan = w.get('[data-test="plan-commit"]');
    expect(plan.text()).toBe('plan 3e1a9f0, committed before the run');
    expect(plan.attributes('href')).toBe('#/experiments/exp_heldout/run');
    expect(w.get('[data-test="platform-commit"]').text()).toBe('platform c4d2e19');
  });

  it('lists each trial stopped on an infra failure, with its arm, attempt and reason', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const items = w.findAll('[data-test="infra-list"] li');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain('debt-hardship-03');
    expect(items[0].text()).toContain('attempt 1');
    expect(items[0].text()).toContain('provider error');
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
    expect(w.get('[data-test="task-summary"]').text()).toBe("2 tasks differ after Holm's correction for 12 comparisons. The other 10 show no clear difference.");
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
    expect(fd.get('a').attributes('href')).toBe('#/trials/tr_fd-vs-sip-07_b_3');
    const look = w.get('[data-test="worth-a-look"]');
    expect(look.classes()).not.toContain('panel--dashed');
    expect(look.get('h2').text()).toBe('Worth a look: fd-vs-sip-07 fell from 4 of 5 to 2 of 5');
    expect(look.text()).toContain('No clear difference: its interval includes zero even before correcting for 12 tasks (−40, interval −90 to +10). The failed trials show what went wrong.');
    expect(look.text()).not.toContain('got worse');
    expect(look.text()).not.toContain('B passed');
    // tr_fd-vs-sip-07_b_3 is the trial where your held-out label disputes the judge's fail.
    const link = look.get('[data-test="look-link"]');
    expect(link.attributes('href')).not.toBe('#/trials/tr_fd-vs-sip-07_b_3');
    expect(link.attributes('href')).toBe('#/trials/tr_fd-vs-sip-07_b_4');
    expect(link.text()).toBe('Open a failed trial');
  });

  it('says the result leans on the judge, and that the judge check is provisional', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const verdict = w.get('[data-test="verdict"]').text();
    expect(verdict).toContain(
      'though its interval dips below it. Both tasks that differ after correction are judge-graded, so this result leans on the judge. Provisional: 3 held-out items still to label.',
    );
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
