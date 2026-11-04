import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import configs from '../fixtures/configs.json';
import { routeFetch, settle, useFixtures } from '../test/helpers';
import StartView from './StartView.vue';

const newest = [...configs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

describe('The front door, in fixture mode', () => {
  useFixtures();

  it('offers three ways in: a finished example, the guided builder, and the full platform', async () => {
    const w = mount(StartView);
    await settle();
    expect(w.findAll('.door-title').map((t) => t.text())).toEqual(['See a finished example', 'Build your own, step by step', 'Go straight to the full platform']);
    expect(w.get('[data-test="door-build"]').attributes('href')).toBe('#/build');
    expect(w.get('[data-test="door-full"]').attributes('href')).toBe('#/experiments');
    // The example opens through #/example, which loads the shipped example the first time.
    expect(w.get('[data-test="door-example"]').attributes('href')).toBe('#/example');
    expect(w.get('[data-test="door-example"]').text()).toContain('Nothing runs and nothing is spent.');
  });

  it('walks a reviewer through five steps, each linking to its screen', async () => {
    const w = mount(StartView);
    await settle();
    const steps = w.findAll('[data-test^="guide-"]');
    expect(steps.map((s) => s.get('.step-title').text())).toEqual([
      'Look at the finished example',
      'Build your own',
      'Preview what reaches the model',
      'Evaluate it against a baseline',
      'Read the result',
    ]);
    const link = (key: string) => w.get(`[data-test="guide-${key}"] a`);
    expect(link('example').attributes('href')).toBe('#/example');
    expect(link('example').text()).toBe('Open the example');
    // No verdict is promised until the statistics step computes one.
    expect(w.get('[data-test="guide-example"]').text()).not.toContain('verdict');
    expect(link('build').attributes('href')).toBe('#/build');
    expect(link('preview').attributes('href')).toBe(`#/configs/${encodeURIComponent(newest.hash)}`);
    expect(link('preview').text()).toBe(`Open the newest agent, ${newest.name}`);
    expect(link('evaluate').attributes('href')).toBe('#/run');
    expect(link('result').attributes('href')).toBe('#/experiments');
    expect(w.get('[data-test="guide-evaluate"]').text()).toContain('trials, models and cost before anything starts');
    // The guided path never offers the scripted test models.
    expect(w.text().toLowerCase()).not.toContain('fake');
  });
});

/** GET /examples as the live API answers it for the shipped draft example. */
const DRAFT = {
  name: 'harness-ownloop-vs-hermes-haiku',
  title: 'Draft stand-in: own loop vs Hermes on Claude Haiku 5.5 (15 draft tasks, one trial each)',
  description: 'A small draft run, shipped as a stand-in until the real experiment is run and exported.',
  experiment_id: 'e_0mw273dpt486807c2722a92dc',
  loaded: false,
  created_at: '2026-11-04T14:11:32.275Z',
  counts: { configs: 2, tasks: 15, trials: 30, spans: 418, grades: 256, files: 638 },
};

describe('The front door, against the API', () => {
  it("names the example by its own title, says it is a real but small draft that the full experiment replaces, and promises no verdict", async () => {
    vi.unstubAllEnvs();
    routeFetch({ '/api/configs': [], '/api/examples': [DRAFT] });
    const w = mount(StartView);
    await settle();
    const door = w.get('[data-test="door-example"]');
    expect(door.get('[data-test="door-example-name"]').text()).toBe(DRAFT.title);
    expect(door.text()).toContain('A real run on a real model, shipped with the repo');
    expect(door.text()).toContain('It is a small draft, for now: the full experiment replaces it.');
    // Not "an A/B experiment, already run", which the draft title contradicts.
    expect(door.text()).not.toContain('A/B experiment');
    // Nothing on the page promises the verdict, its interval or how sure we can be as if built.
    const result = w.get('[data-test="guide-result"]').text();
    expect(result).toContain('This version gives counts only: the verdict with its interval, how sure a difference is, is not built yet.');
    expect(w.get('.lede').text()).toContain('is not built yet');
  });

  it('says nothing about a draft when the shipped example is the full experiment', async () => {
    vi.unstubAllEnvs();
    routeFetch({ '/api/configs': [], '/api/examples': [{ ...DRAFT, title: 'Own loop vs Hermes on Claude Haiku 5.5, 30 tasks, 5 trials each' }] });
    const w = mount(StartView);
    await settle();
    expect(w.get('[data-test="door-example"]').text()).not.toContain('draft');
  });
});
