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
      `Rests on the judge: both tasks that differ need the judge's pass (debt-hardship-03 also has a state check). Its agreement with you is κ${nb}0.55 (interval 0.29 to 0.79), short of the trust bar.`,
    );
    expect(caveat.get('a').attributes('href')).toBe('#/labels/judge');
    const caption = w.get('[data-test="latest-result"] figcaption').element;
    expect(caption.parentElement?.nextElementSibling).toBe(caveat.element);
  });

  it('draws the result in arm B colour only because B is better, with the A/A run labelled under it', async () => {
    const w = mount(ExperimentsView);
    await settle();
    const strip = w.get('[data-test="latest-result"] svg[role="img"]');
    expect(strip.attributes('aria-label')).toContain('An A/A calibration of the same config gave +1, interval −7 to +9.');
    expect(strip.findAll('.range').map((r) => r.classes().find((c) => /^range--(a|b|neutral|ink)$/.test(c)))).toEqual(['range--b', 'range--neutral']);
    const labels = [...strip.findAll('[data-test="strip-label"]').map((t) => t.text()), ...w.findAll('[data-test="strip-legend"] li').map((l) => l.text())];
    expect(labels).toEqual(expect.arrayContaining(['v2 minus v1, 12 tasks', 'A/A calibration, same config twice']));
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
    // The A/A calibration says whether it came out as it should (D44).
    expect(rows()[5].get('[data-verdict]').text()).toBe('No difference, as it should');
    expect(rows()[5].text()).toContain(`A/A calibration: +1${nb}point (−7 to +9)`);
    expect(rows()[5].text()).toContain('nothing: an A/A calibration (same config twice)');
    expect(rows()[4].get('[data-verdict]').text()).toBe('No detectable difference');
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
    expect(plain).toEqual(expect.arrayContaining(['Running', 'Paused', 'No detectable difference', 'No difference, as it should', 'One arm']));
    expect(results.filter((r) => r.find('.verdict-tag').exists())).toHaveLength(1);
  });

  it('opens a failed trial of arm B on the task where B did worst', async () => {
    const w = mount(ExperimentsView);
    await settle();
    expect(w.find('a[href="#/trials/tr_fd-vs-sip-07_b_3"]').exists()).toBe(true);
  });
});

describe('ExperimentsView against the API: a finished A/B still grading', () => {
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
      '/api/experiments/exp_heldout/compare': { ...(compares.exp_heldout as object), stats: null, stats_note: 'Grading is still running for 2 of 30 finished trials; the verdict waits for every grade.' },
      '/api/experiments/exp_heldout': { ...detail, name: 'Label batch 1: open coding (R8, approved: 30 trials, cap $2)', example: EXAMPLE },
      '/api/experiments/exp_heldout/trials?status=done': [],
    });
    return mount(ExperimentsView);
  }

  it('leads with the latest finished A/B as counts while it has no verdict, by its one name, saying why', async () => {
    const w = mountLive();
    await settle();
    expect(w.find('[data-test="latest-result"]').exists()).toBe(false);
    const latest = w.get('[data-test="latest-counts"]');
    expect(latest.get('h2').text()).toBe(EXAMPLE.title);
    expect(latest.text()).toMatch(/A: .+, \d+ of \d+ graded trials passed/);
    expect(latest.text()).toContain('These are counts, not a conclusion: Grading is still running for 2 of 30 finished trials; the verdict waits for every grade.');
    expect(w.text()).not.toContain('does not compute');
    expect(latest.get('a').attributes('href')).toBe('#/experiments/exp_heldout');
    // The list names the example the same way, and never by its working name.
    expect(w.get('[data-test="experiments-table"] .row-link').text()).toBe(EXAMPLE.title);
    expect(w.text()).not.toContain('Label batch 1');
  });

  it('marks the spend of a run on fake models as made-up prices, as the comparison does', async () => {
    const hashes = done.config_hashes as string[];
    const fake = (configs as { hash: string; model: string }[]).map((c) => (hashes.includes(c.hash) ? { ...c, model: 'fake/finance-emi' } : c));
    routeFetch({
      '/api/experiments': [done, { ...done, id: 'exp_one_fake', config_hashes: [hashes[0], (configs as { hash: string }[]).find((c) => !hashes.includes(c.hash))?.hash] }],
      '/api/configs': fake,
      '/api/harnesses': [],
      '/api/labels/queue?set=heldout': [],
      '/api/labels/queue?set=tuning': [],
    });
    const w = mount(ExperimentsView);
    await settle();
    const notes = w.findAll('[data-test="experiment-row"]').map((r) => r.find('[data-test="fake-prices"]'));
    expect(notes[0].text()).toBe('Made-up prices: fake model');
    expect(notes[0].attributes('title')).toContain('invented for testing');
    expect(notes[1].text()).toBe('Made-up prices in arm A: fake model');
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
    expect(text).toContain('The verdict with its interval, then pass counts, cost and time per version, task by task.');
    expect(text).not.toContain('No verdict or interval');
  });
});

describe('ExperimentsView with the shipped examples loaded (destructive review U2)', () => {
  const done = (experiments as { id: string }[]).find((e) => e.id === 'exp_heldout') as Record<string, unknown>;
  const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;
  const compare = compares.exp_heldout as unknown as { stats: Record<string, unknown> };
  const ref = (name: string, title: string) => ({ name, title, loaded_at: '2026-11-06T08:00:00.000Z' });
  const HEADLINE = ref('headline-prompt-v1-vs-v2', 'Prompt v1 vs v2 on Hermes with Claude Haiku 5.5');
  const REPLICATION = ref('replication-langgraph-prompt-v1-vs-v2', 'Replication on LangGraph');
  const example = (e: { name: string }) => ({ name: e.name, title: e.name, description: '', experiment_id: `e_${e.name}`, loaded: true, created_at: '2026-11-05T07:00:00.000Z', counts: {} });

  /** The replication was made and finished after the headline. */
  function mountShipped(own: Record<string, unknown>[] = [], moreConfigs: Record<string, unknown>[] = []) {
    const rep = { ...done, id: 'e_rep', created_at: '2026-11-05T09:43:08.000Z', finished_at: '2026-11-05T10:19:51.000Z', example: REPLICATION };
    const head = { ...done, id: 'e_head', created_at: '2026-11-05T07:32:29.000Z', finished_at: '2026-11-05T08:05:59.000Z', example: HEADLINE };
    routeFetch({
      '/api/experiments': [...own, rep, head],
      '/api/configs': [...configs, ...moreConfigs],
      '/api/harnesses': [],
      '/api/labels/queue?set=heldout': [],
      '/api/labels/queue?set=tuning': [],
      '/api/examples': [example(HEADLINE), example(REPLICATION)],
      '/api/experiments/e_rep/compare': { ...compare, stats: { ...compare.stats, verdict: 'better' } },
      '/api/experiments/e_head/compare': { ...compare, stats: { ...compare.stats, verdict: 'no_detectable_difference' } },
      '/api/experiments/e_mine/compare': { ...compare, stats: { ...compare.stats, verdict: 'worse' } },
      '/api/experiments/e_rep': { ...detail, ...rep },
      '/api/experiments/e_head': { ...detail, ...head },
      '/api/experiments/e_mine': { ...detail, id: 'e_mine', example: null },
    });
    return mount(ExperimentsView);
  }

  it('leads with the shipped run that finished last, naming its harness and model, not the headline (QA, 7 Nov)', async () => {
    const w = mountShipped();
    await settle();
    const title = w.get('[data-test="latest-result"] h2').text();
    expect(title).toBe('Prompt v2 beats v1 on the held-out tasks, with Hermes Agent and Claude Haiku 5.5 (shipped example: a replication)');
    expect(w.get('[data-test="latest-result"] a').attributes('href')).toBe('#/experiments/e_rep');
  });

  it('leads with a run of your own that finished later, and never with one on fake models only', async () => {
    const mine = { ...done, id: 'e_mine', created_at: '2026-11-06T10:00:00.000Z', finished_at: '2026-11-06T10:40:00.000Z', example: null };
    let w = mountShipped([mine]);
    await settle();
    expect(w.get('[data-test="latest-result"] h2').text()).toBe('Prompt v2 does worse than v1 on the held-out tasks, with Hermes Agent and Claude Haiku 5.5');
    w.unmount();
    // The same run of yours on fake models: its pass rates test the platform, so the shipped one leads.
    const fakeHashes = ['sha256:fa1', 'sha256:fa2'];
    const fakeConfigs = fakeHashes.map((hash, i) => ({ ...(configs[i] as object), hash, model: 'fake/finance-emi' }));
    w = mountShipped([{ ...mine, config_hashes: fakeHashes }], fakeConfigs);
    await settle();
    expect(w.get('[data-test="latest-result"] a').attributes('href')).toBe('#/experiments/e_rep');
    w.unmount();
  });
});

describe('ExperimentsView: filters and the figure (QA, 7 Nov)', () => {
  const done = (experiments as { id: string }[]).find((e) => e.id === 'exp_heldout') as Record<string, unknown>;
  const detail = (details as Record<string, Record<string, unknown>>).exp_heldout;
  const compare = compares.exp_heldout as unknown as { stats: Record<string, unknown> };

  it('gives a stopped run a filter of its own, so it shows under one of them', async () => {
    const stopped = { ...done, id: 'e_stop', status: 'cancelled', finished_at: null, name: 'Stopped run' };
    routeFetch({
      '/api/experiments': [stopped, done],
      '/api/configs': configs,
      '/api/harnesses': [],
      '/api/labels/queue?set=heldout': [],
      '/api/labels/queue?set=tuning': [],
      '/api/experiments/exp_heldout/compare': compare,
      '/api/experiments/exp_heldout': detail,
    });
    const w = mount(ExperimentsView);
    await settle();
    const names = () => w.findAll('[data-test="experiment-row"] .row-link').map((a) => a.text());
    const filter = w.get('[data-test="show-filter"]');
    expect(filter.findAll('option').map((o) => o.text())).toEqual(['All', 'Running', 'Finished', 'Stopped or cancelled']);
    await filter.setValue('stopped');
    expect(names()).toEqual(['Stopped run']);
    expect(w.get('[data-test="experiment-row"] [data-test="status"]').text()).toBe('Cancelled');
    await filter.setValue('done');
    expect(names()).not.toContain('Stopped run');
    await filter.setValue('running');
    expect(names()).not.toContain('Stopped run');
  });

  it('keeps the figure inside -100 to +100 points: no "+110" tick for an interval up to +100', async () => {
    routeFetch({
      '/api/experiments': [done],
      '/api/configs': configs,
      '/api/harnesses': [],
      '/api/labels/queue?set=heldout': [],
      '/api/labels/queue?set=tuning': [],
      '/api/experiments/exp_heldout/compare': { ...compare, stats: { ...compare.stats, diff: { estimate: 50, low: 0, high: 100 }, aa: null } },
      '/api/experiments/exp_heldout': detail,
    });
    const w = mount(ExperimentsView);
    await settle();
    const ticks = w.get('[data-test="latest-result"] svg[role="img"]').findAll('text.tick:not(.row-label)').map((t) => t.text());
    expect(ticks).toContain('+100');
    expect(ticks).not.toContain('+110');
  });
});

describe('ExperimentsView counts in words (destructive review U14)', () => {
  it('says "1 task" and "1 trial", never "1 tasks" or "1 trials"', async () => {
    const done = (experiments as { id: string }[]).find((e) => e.id === 'exp_heldout') as Record<string, unknown>;
    const detail = (details as Record<string, Record<string, unknown>>).exp_heldout as { tasks: unknown[] };
    const compare = compares.exp_heldout as unknown as { stats: { tasks: unknown[] } };
    routeFetch({
      '/api/experiments': [{ ...done, n: 1 }],
      '/api/configs': configs,
      '/api/harnesses': [],
      '/api/labels/queue?set=heldout': [],
      '/api/labels/queue?set=tuning': [],
      '/api/experiments/exp_heldout/compare': { ...compare, stats: { ...compare.stats, tasks: compare.stats.tasks.slice(0, 1) } },
      '/api/experiments/exp_heldout': { ...detail, n: 1, tasks: detail.tasks.slice(0, 1) },
    });
    const w = mount(ExperimentsView);
    await settle();
    const latest = w.get('[data-test="latest-result"]');
    expect(latest.get('figcaption').text()).toContain('paired over 1 held-out task with 1 trial each.');
    expect(latest.text()).toContain('v2 minus v1, 1 task');
    expect(w.text()).not.toMatch(/\b1 (tasks|trials)\b/);
  });
});
