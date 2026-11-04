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
    expect(latest).not.toContain('An A/A run on the same setup moved');
  });

  it('draws the result in arm B colour only because B is better, with the A/A run labelled under it', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const strip = w.get('[data-test="latest-result"] svg[role="img"]');
    expect(strip.attributes('aria-label')).toContain('An A/A run on the same setup gave +1, interval −7 to +9.');
    expect(strip.findAll('.range').map((r) => r.classes().find((c) => /^range--(a|b|neutral|ink)$/.test(c)))).toEqual(['range--b', 'range--neutral']);
    const labels = [...strip.findAll('[data-test="strip-label"]').map((t) => t.text()), ...w.findAll('[data-test="strip-legend"] li').map((l) => l.text())];
    expect(labels).toEqual(expect.arrayContaining(['v2 minus v1, 12 tasks', 'A/A run, same config twice']));
    const ticks = strip
      .findAll('text.tick:not(.row-label)')
      .sort((p, q) => Number(p.attributes('x')) - Number(q.attributes('x')))
      .map((t) => t.text());
    expect(ticks).toEqual(['−20', '−10', '0, no change', '+10', '+20', '+30']);
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
    expect(rows()[1].get('[data-verdict]').attributes('data-verdict')).toBe('better');
    expect(rows()[1].text()).toContain('Better');
    expect(rows()[1].text()).toContain('+15 points (+7 to +23)');
    expect(rows()[3].get('[data-verdict]').text()).toBe('No clear difference');
    expect(rows()[3].text()).toContain('+1 points (−7 to +9), as expected');
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
