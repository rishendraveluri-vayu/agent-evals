import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { settle, useFixtures } from '../test/helpers';
import ExperimentsView from './ExperimentsView.vue';

useFixtures();

describe('ExperimentsView in fixture mode', () => {
  it('leads with the latest verdict, its size and its interval', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const latest = w.get('[data-test="latest-result"]').text();
    expect(latest).toContain('Prompt v2 beats v1 on the held-out tasks');
    expect(latest).toContain('+15 points');
    expect(latest).toContain('pass rate, 58% to 73%');
    expect(latest).toContain('95% interval +7 to +23, paired over 12 held-out tasks with 5 trials each.');
    expect(latest).toContain('finished 2 h ago');
  });

  it('lists what needs attention: infra failures, labels to go, an inert setting', async () => {
    const w = mount(ExperimentsView);
    await settle();
    expect(w.findAll('[data-test="attention"]').map((a) => a.find('.attention-head').text())).toEqual([
      '2 trials stopped on infra failures',
      '3 held-out labels to go',
      'Temperature looks inert on ADK',
    ]);
  });

  it('shows every experiment with its arms, progress and result, and filters them', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const rows = () => w.findAll('[data-test="experiments-table"] tbody tr');
    expect(rows()).toHaveLength(5);
    expect(rows()[1].text()).toContain('Better');
    expect(rows()[1].text()).toContain('+15 pts (+7 to +23)');
    expect(rows()[3].text()).toContain('+1 pts (−7 to +9), as expected');
    await w.get('[data-test="show-filter"]').setValue('running');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text()).toContain('Running');
    expect(rows()[0].text()).toContain('60 of 120');
  });

  it('opens a failed trial of arm B on the task where B did worst', async () => {
    const w = mount(ExperimentsView);
    await settle();
    expect(w.find('a[href="#/trials/tr_fd-vs-sip-07_b_3"]').exists()).toBe(true);
  });
});
