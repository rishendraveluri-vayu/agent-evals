/**
 * A reviewer with no API keys builds a config on a fake model, runs it and opens the results, all
 * from the page. These tests drive the screens against a stubbed API in the contract's shapes.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { ConfigView as Config, ExperimentDetail } from '../api/types';
import configsJson from '../fixtures/configs.json';
import details from '../fixtures/experiment-details.json';
import { settle, useFixtures } from '../test/helpers';
import ConfigView from './ConfigView.vue';
import RunView from './RunView.vue';

useFixtures();

const configs = configsJson as unknown as Config[];
/** Two configs on fake models that differ only in the prompt, as a reviewer would make them. */
const fakeA: Config = { ...configs[2], hash: 'sha256:fa00000000000000000000000000000000000000000000000000000000000001', name: 'Own loop, fake, v1', harness: 'ownloop', model: 'fake/finance-emi' };
const fakeB: Config = { ...fakeA, hash: 'sha256:fb00000000000000000000000000000000000000000000000000000000000002', name: 'Own loop, fake, v2', prompt: configs[1].prompt };

describe('the Config screen offers fake models, labelled as fake', () => {
  it('lists the real models as paid and the fake ones as free, and saves a config on a fake one', async () => {
    const create = vi.spyOn(api, 'createConfig');
    const w = mount(ConfigView);
    await settle();
    const groups = w.findAll('[data-test="model-select"] optgroup');
    // A hosted model's calls cost money; the local one's do not (destructive review U1).
    expect(groups.map((g) => g.attributes('label'))).toEqual(["Real models: a hosted model's calls cost money", 'Fake models: scripted replies, free']);
    const fake = groups[1].findAll('option').map((o) => o.text());
    expect(fake[0]).toBe('Fake model finance-emi: one EMI tool call, then an answer that uses it');
    expect(fake.every((t) => t.startsWith('Fake model '))).toBe(true);
    // The simulated client's script is not an agent model.
    expect(fake.some((t) => t.includes('sim-client'))).toBe(false);
    await w.get('[data-test="model-select"]').setValue('fake/finance-emi');
    await settle();
    expect(w.get('[data-test="fake-model-note"]').text()).toContain('No real model and no real spend');
    await w.get('[data-test="save-config"]').trigger('click');
    await settle();
    expect(create.mock.calls[0][0].model).toBe('fake/finance-emi');
    expect(w.text()).toContain('Saved as config');
  });
});

describe('the Run screen runs fake configs for free', () => {
  function mountDraft(b: string | null = fakeB.hash) {
    vi.spyOn(api, 'configs').mockResolvedValue([...configs, fakeA, fakeB]);
    vi.spyOn(api, 'configDiff').mockResolvedValue([
      { path: 'prompt.sha256', a: fakeA.prompt.sha256, b: fakeB.prompt.sha256 },
      { path: 'prompt.version', a: 'v1', b: 'v2' },
    ]);
    return mount(RunView, { props: { a: fakeA.hash, b } });
  }

  it('needs no plan commit, defaults the simulated client to the fake one, and says the run is free', async () => {
    const w = mountDraft();
    await settle();
    expect(w.findAll('[data-test="check"]').map((c) => c.text())).toContain(
      'No analysis plan needed: every arm runs on a fake modelCheck passed.A fake run tries the platform out; it measures nothing about a real agent.',
    );
    expect((w.get('[data-test="sim-model"]').element as HTMLSelectElement).value).toBe('fake/sim-client');
    expect(w.get('[data-test="spend-kind"]').text()).toBe('Every model here is fake, so the run is free: its prices are made up for testing, and nothing it finds is about a real model.');
    expect(w.get('[data-test="start"]').attributes('disabled')).toBeUndefined();
  });

  it('says when a real model would cost money', async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([...configs, fakeA, fakeB]);
    const w = mount(RunView, { props: { a: fakeA.hash, b: configs[0].hash } });
    await settle();
    expect(w.get('[data-test="spend-kind"]').text()).toBe('Real models: Claude Haiku 5.5. This run costs real money; you confirm the cost before it starts.');
    expect(w.text()).not.toContain('Rishi');
    expect(w.text()).not.toContain('R8');
    // Not all fake, so the plan commit is asked for again.
    expect(w.get('[data-test="start-helper"]').text()).toContain('No analysis plan commit yet');
  });

  it('takes tasks out one by one and re-estimates', async () => {
    const estimate = vi.spyOn(api, 'estimate');
    const w = mountDraft();
    await settle();
    const pick = w.get('[data-test="task-pick"]');
    expect(pick.get('legend').text()).toBe('12 of 12 tasks in the run');
    await pick.get('[data-test="task-distress-12"]').setValue(false);
    await settle();
    expect(pick.get('legend').text()).toBe('11 of 12 tasks in the run');
    const last = estimate.mock.calls.at(-1)?.[0];
    expect(last?.task_sha256s).toHaveLength(11);
    expect(w.get('[data-test="plan"]').text()).toContain('11 tasks × 2 arms × 2 trials');
  });

  it('creates and starts the experiment with the seed, no plan commit and the fake simulator, then opens its run page', async () => {
    const created = { ...(details as Record<string, ExperimentDetail>).exp_heldout, id: 'e_new', status: 'created' as const };
    const create = vi.spyOn(api, 'createExperiment').mockResolvedValue(created);
    const start = vi.spyOn(api, 'startExperiment').mockResolvedValue({ ...created, status: 'running' });
    const w = mountDraft();
    await settle();
    await w.get('[data-test="n-input"]').setValue('2');
    await w.get('[data-test="order-seed"]').setValue('42');
    await settle();
    await w.get('[data-test="start"]').trigger('click');
    await settle();
    const body = create.mock.calls[0][0];
    expect(body.config_hashes).toEqual([fakeA.hash, fakeB.hash]);
    expect(body.n).toBe(2);
    expect(body.order_seed).toBe(42);
    expect(body.plan_commit).toBeNull();
    expect(body.sim_model).toBe('fake/sim-client');
    expect(body.task_sha256s).toHaveLength(12);
    expect(start).toHaveBeenCalledWith('e_new');
    expect(window.location.hash).toBe('#/experiments/e_new/run');
  });

  it('runs one arm when arm B is set to none', async () => {
    const w = mountDraft('');
    await settle();
    expect((w.get('[data-test="arm-b"]').element as HTMLSelectElement).value).toBe('');
    expect(w.get('[data-test="plan"]').text()).toContain('12 tasks × 1 arm × 2 trials');
  });
});
