import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import configs from '../fixtures/configs.json';
import { settle, useFixtures } from '../test/helpers';
import StartView from './StartView.vue';

useFixtures();

const newest = [...configs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

describe('The front door, in fixture mode', () => {
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
