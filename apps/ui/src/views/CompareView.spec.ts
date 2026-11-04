import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { settle, useFixtures } from '../test/helpers';
import CompareView from './CompareView.vue';

useFixtures();

describe('CompareView in fixture mode', () => {
  it('leads with the verdict and states the difference with its interval', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    expect(w.get('[data-test="verdict-title"]').text()).toBe('v2 is better');
    const verdict = w.get('[data-test="verdict"]').text();
    expect(verdict).toContain('+15 points of pass rate, from 58% to 73%');
    expect(verdict).toContain('The 95% interval runs from +7 to +23 points');
    expect(verdict).toContain('Running the same config twice moved only +1 point');
    expect(verdict).toContain('2 trials stopped on infra failures were re-run and are listed, not dropped');
  });

  it('draws one forest-plot row per task, largest difference first, each with its interval', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const rows = w.findAll('[data-test="forest-row"]');
    expect(rows).toHaveLength(12);
    expect(rows[0].text()).toContain('distress-12');
    expect(rows[0].text()).toContain('1 of 5');
    expect(rows[0].text()).toContain('Better');
    expect(rows[0].text()).toContain('+80 (+40 to +100)');
    const last = rows[11];
    expect(last.text()).toContain('fd-vs-sip-07');
    expect(last.text()).toContain('Within noise');
    expect(last.text()).toContain('−40 (−90 to +10)');
    expect(last.find('svg').attributes('aria-label')).toBe('fd-vs-sip-07: −40 points, interval −90 to +10');
    expect(w.get('[data-test="task-summary"]').text()).toBe('2 tasks differ after correcting for 12 comparisons. The other 10 are within noise.');
  });

  it('links each task to a failed trial of arm B and calls out the worst regression', async () => {
    const w = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const fd = w.findAll('[data-test="forest-row"]')[11];
    expect(fd.get('a').attributes('href')).toBe('#/trials/tr_fd-vs-sip-07_b_3');
    expect(w.text()).toContain('Worth a look: fd-vs-sip-07 got worse');
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
