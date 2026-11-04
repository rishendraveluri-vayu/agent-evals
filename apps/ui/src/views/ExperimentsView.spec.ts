import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import compares from '../fixtures/compares.json';
import configs from '../fixtures/configs.json';
import details from '../fixtures/experiment-details.json';
import experiments from '../fixtures/experiments.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import ExperimentsView from './ExperimentsView.vue';

/** A no-break space: numbers keep their unit, and κ keeps its value. */
const nb = '\u00a0';

describe('ExperimentsView in fixture mode', () => {
  useFixtures();

  it('leads with the latest verdict, its size and its interval', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const latest = w.get('[data-test="latest-result"]').text();
    expect(latest).toContain('Prompt v2 beats v1 on the held-out tasks');
    // Each arm's rate is named; "X to Y" is kept for intervals.
    expect(w.findAll('[data-test="latest-result"] .latest-figure > span').map((x) => x.text())).toEqual([`+15${nb}points`, 'pass rate: v1 58%, v2 73%']);
    expect(latest).not.toContain('58% to 73%');
    expect(latest).toContain('95% interval +7 to +23, paired over 12 held-out tasks with 5 trials each.');
    expect(latest).toContain('finished 2 h ago');
    expect(latest).not.toContain('An A/A run on the same setup moved');
  });

  it('says under the caption that the result rests on the judge', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const caveat = w.get('[data-test="latest-result"] [data-test="judge-caveat"]');
    expect(caveat.text()).toBe(
      `Rests on the judge: both tasks that differ need the judge's pass (debt-hardship-03 also has a state check). Its agreement with you is κ${nb}0.70, above the 0.6 bar, but the interval (0.47 to 0.88) reaches below it, and it is provisional.`,
    );
    expect(caveat.get('a').attributes('href')).toBe('#/labels/judge');
    const caption = w.get('[data-test="latest-result"] figcaption').element;
    expect(caption.parentElement?.nextElementSibling).toBe(caveat.element);
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

  it('lists what needs attention: a paused arm, a paused run, infra failures, labels to go, an inert setting', async () => {
    const w = mount(ExperimentsView);
    await settle();
    // Neutral words: a reviewer reading the page is not the one asked to label.
    expect(w.get('#attention').text()).toBe('Needs attention');
    const items = w.findAll('[data-test="attention"]');
    expect(items.map((a) => a.find('.attention-head').text())).toEqual([
      'Arm B of Model: Haiku 5.5 vs Gemini 3.8 Flash, discovery is paused',
      'Prompt v1 vs v2, discovery batch 3 is paused',
      '2 infra failures',
      '3 held-out outputs waiting for a human label (7 checks)',
      'Temperature looks inert on ADK',
    ]);
    // What paused each, in a phrase; the run page has the full reason and the fix.
    expect(items[0].text()).toContain('A config error (LiteLLM status 404). The run page says how to fix it.');
    expect(items[1].text()).toContain('The futility check: arm B passed 0 of its first 3 graded trials. Review it, then resume or stop.');
    expect(items[0].attributes('href')).toBe('#/experiments/exp_model/run');
  });

  it('shows every experiment with its arms, progress and result, and filters them', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const rows = () => w.findAll('[data-test="experiments-table"] tbody tr');
    expect(rows()).toHaveLength(7);
    expect(rows()[3].get('[data-verdict]').attributes('data-verdict')).toBe('better');
    expect(rows()[3].text()).toContain('Better');
    expect(rows()[3].text()).toContain(`+15${nb}points (+7 to +23)`);
    expect(rows()[5].get('[data-verdict]').text()).toBe('No clear difference');
    expect(rows()[5].text()).toContain(`+1${nb}point (−7 to +9), as expected`);
    expect(rows()[1].get('[data-test="status"]').text()).toBe('Paused');
    expect(rows()[1].get('[data-test="result"]').text()).toContain('The futility check: arm B passed 0 of its first 3 graded trials');
    await w.get('[data-test="show-filter"]').setValue('running');
    expect(rows()).toHaveLength(3);
    expect(rows()[2].text()).toContain('Running');
    expect(rows()[2].text()).toContain('60 of 120');
    expect(rows()[2].get('[data-test="result"]').text()).toContain('About 19 min left');
  });

  it('shows a pill in the Result column only for Better or Worse; status words are plain', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const results = w.findAll('[data-test="result"]');
    expect(results).toHaveLength(7);
    for (const r of results) {
      expect(r.find('.pill').exists()).toBe(false);
      const tag = r.find('.verdict-tag');
      if (tag.exists()) expect(['better', 'worse']).toContain(tag.attributes('data-verdict'));
      expect(r.find('.result-detail').exists()).toBe(true);
    }
    const plain = results.flatMap((r) => r.findAll('.result-plain').map((p) => p.text()));
    expect(plain).toEqual(expect.arrayContaining(['Running', 'Paused', 'No clear difference', 'One arm']));
    expect(results.filter((r) => r.find('.verdict-tag').exists())).toHaveLength(1);
  });

  it('opens a failed trial of arm B on the task where B did worst', async () => {
    const w = mount(ExperimentsView);
    await settle();
    expect(w.find('a[href="#/trials/tr_fd-vs-sip-07_b_3"]').exists()).toBe(true);
  });
});

describe('ExperimentsView against the API: no statistics in this version', () => {
  /** The shipped example as the live API lists it: its working name, and the manifest's title. */
  const EXAMPLE = { name: 'harness-ownloop-vs-hermes-haiku', title: 'Draft stand-in: own loop vs Hermes on Claude Haiku 5.5 (15 draft tasks, one trial each)', loaded_at: '2026-11-05T08:00:00.000Z' };
  const done = (experiments as { id: string }[]).find((e) => e.id === 'exp_heldout') as Record<string, unknown>;
  const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;

  function mountLive() {
    routeFetch({
      '/api/experiments': [{ ...done, name: 'Label batch 1: open coding (R8, approved: 30 trials, cap $2)', example: EXAMPLE }],
      '/api/configs': configs,
      '/api/harnesses': [],
      '/api/labels/queue?set=heldout': [],
      '/api/labels/queue?set=tuning': [],
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null },
      '/api/experiments/exp_heldout': { ...detail, name: 'Label batch 1: open coding (R8, approved: 30 trials, cap $2)', example: EXAMPLE },
      '/api/experiments/exp_heldout/trials?status=done': [],
    });
    return mount(ExperimentsView);
  }

  it('leads with the latest finished A/B as counts, by its one name, and promises no verdict', async () => {
    const w = mountLive();
    await settle();
    expect(w.find('[data-test="latest-result"]').exists()).toBe(false);
    const latest = w.get('[data-test="latest-counts"]');
    expect(latest.get('h2').text()).toBe(EXAMPLE.title);
    expect(latest.text()).toMatch(/A: .+, \d+ of \d+ graded trials passed/);
    expect(latest.text()).toContain('These are counts, not a conclusion: this version does not compute the verdict and its interval.');
    expect(latest.get('a').attributes('href')).toBe('#/experiments/exp_heldout');
    // The list names the example the same way, and never by its working name.
    expect(w.get('[data-test="experiments-table"] .row-link').text()).toBe(EXAMPLE.title);
    expect(w.text()).not.toContain('Label batch 1');
  });

  it('says what each step does today: no power estimate, no verdict, no interval', async () => {
    const w = mountLive();
    await settle();
    const text = w.text();
    expect(text).not.toContain('whether N is enough');
    expect(text).not.toContain('One verdict with its interval');
    expect(text).not.toContain('verdict shows here first');
    expect(text).not.toContain('how sure we can be');
    expect(text).toContain('See the trials, models, cost and time before anything starts.');
    expect(text).toContain('No verdict or interval in this version.');
  });
});
