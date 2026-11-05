import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import type { ExampleView } from '../api/types';
import { currentHash, parseHash } from '../router';
import { settle, useFixtures } from '../test/helpers';
import OpenExampleView from './OpenExampleView.vue';

useFixtures();

const shipped: ExampleView = {
  name: 'harness-ownloop-vs-hermes-haiku',
  title: 'Own loop vs Hermes on Claude Haiku 5.5',
  description: 'A real run.',
  experiment_id: 'e_shipped',
  loaded: false,
  created_at: '2026-11-04T14:11:32.275Z',
  counts: { configs: 2, tasks: 15, trials: 30, spans: 418, grades: 128, files: 638 },
};

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = '';
  currentHash.value = '';
});

describe('#/example: the finished example', () => {
  it('is its own route, under the front door', () => {
    expect(parseHash('#/example')).toEqual({ name: 'example' });
  });

  it('opens the comparison of an example that is already loaded, and loads nothing', async () => {
    const load = vi.spyOn(api, 'loadExample');
    mount(OpenExampleView);
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(currentHash.value).toBe('#/experiments/exp_heldout');
  });

  it('loads an example the first time, saying nothing runs or is spent, then opens it', async () => {
    vi.spyOn(api, 'examples').mockResolvedValue([shipped]);
    let finish: (v: { name: string; experiment_id: string; created: boolean }) => void = () => {};
    const load = vi.spyOn(api, 'loadExample').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const w = mount(OpenExampleView);
    await settle();
    expect(load).toHaveBeenCalledWith('harness-ownloop-vs-hermes-haiku');
    expect(w.get('[data-test="example-status"]').text()).toContain('Own loop vs Hermes on Claude Haiku 5.5');
    expect(w.get('[data-test="example-status"]').text()).toContain('Nothing runs and nothing is spent.');
    finish({ name: shipped.name, experiment_id: shipped.experiment_id, created: true });
    await settle();
    expect(currentHash.value).toBe('#/experiments/e_shipped');
  });

  it('opens the original run on the machine the example was exported from, where the load is refused', async () => {
    vi.spyOn(api, 'examples').mockResolvedValue([{ ...shipped, experiment_id: 'exp_heldout' }]);
    vi.spyOn(api, 'loadExample').mockRejectedValue(new ApiError(409, 'example_conflict', 'experiment exp_heldout is already here as an experiment of its own'));
    mount(OpenExampleView);
    await settle();
    expect(currentHash.value).toBe('#/experiments/exp_heldout');
  });

  it('loads the first example and its companions before opening it, and the others after', async () => {
    const headline: ExampleView = { ...shipped, name: 'headline', experiment_id: 'e_headline', title: 'Headline' };
    const aa: ExampleView = { ...shipped, name: 'headline-zz-aa', experiment_id: 'e_aa', title: 'A/A calibration' };
    const control: ExampleView = { ...shipped, name: 'positive-control', experiment_id: 'e_control', title: 'Positive control' };
    const replication: ExampleView = { ...shipped, name: 'replication', experiment_id: 'e_rep', title: 'Replication', loaded: true };
    vi.spyOn(api, 'examples').mockResolvedValue([headline, aa, control, replication]);
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const load = vi.spyOn(api, 'loadExample').mockImplementation(async (name: string) => {
      order.push(name);
      if (name === 'positive-control') await held;
      return { name, experiment_id: `e_${name}`, created: true };
    });
    mount(OpenExampleView);
    await settle();
    // The comparison opens once the headline and its A/A companion are in, while the control is
    // still loading behind it; the replication was already here.
    expect(currentHash.value).toBe('#/experiments/e_headline');
    expect(order).toEqual(['headline', 'headline-zz-aa', 'positive-control']);
    release();
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('says so when no example ships, and offers the other ways in', async () => {
    vi.spyOn(api, 'examples').mockResolvedValue([]);
    const w = mount(OpenExampleView);
    await settle();
    expect(w.get('[data-test="example-none"]').text()).toContain('ships no finished example');
    expect(w.get('[data-test="example-none"] a').attributes('href')).toBe('#/experiments');
  });

  it('shows a refused load in plain words with its fix, and stays put', async () => {
    vi.spyOn(api, 'examples').mockResolvedValue([shipped]);
    vi.spyOn(api, 'loadExample').mockRejectedValue(
      new ApiError(409, 'example_conflict', 'trial t_1 is already here (SP7)', 'Load it into a fresh database: docker compose down -v, then up.'),
    );
    const w = mount(OpenExampleView);
    await settle();
    const box = w.get('[data-test="example-failed"]');
    expect(box.text()).toContain('The example could not be opened: trial t_1 is already here');
    expect(box.text()).not.toContain('SP7');
    expect(box.text()).toContain('docker compose down -v');
    expect(currentHash.value).toBe('');
  });
});
