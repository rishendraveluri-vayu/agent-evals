/** No screen shows the authors' internal references: decision-log numbers (R8, D32, SP5, A14) or
 *  raw API paths (POST /...). They belong in the docs and in code comments, not in front of a
 *  reviewer. Each screen is rendered in fixture mode, with every disclosure opened, and its text,
 *  titles and labels are read. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount } from '@vue/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { api } from './api/client';
import type { ConfigView } from './api/types';
import configs from './fixtures/configs.json';
import details from './fixtures/experiment-details.json';
import experiments from './fixtures/experiments.json';
import harnesses from './fixtures/harnesses.json';
import trial from './fixtures/trial.json';
import { currentHash } from './router';
import { settle, useFixtures } from './test/helpers';

useFixtures();

const INTERNAL = /\b(?:R\d+[a-z]?|D\d{2}|SP\d|A\d{1,2})\b|\b(?:GET|POST|DELETE|PUT) \//;

const SCREENS: Record<string, string> = {
  start: '#/',
  build: '#/build',
  experiments: '#/experiments',
  config: '#/configs',
  'config page': `#/configs/${encodeURIComponent(configs[0].hash)}`,
  comparison: '#/experiments/exp_heldout',
  'paused comparison': '#/experiments/exp_model',
  trial: '#/trials/tr_fd-vs-sip-07_b_3',
  'recorded runs': '#/trials',
  labels: '#/labels',
  judge: '#/labels/judge',
  tasks: '#/tasks',
  harnesses: '#/harnesses',
  'run setup': '#/run',
  'running run': '#/experiments/exp_model/run',
  'paused run': '#/experiments/exp_futility/run',
  'finished run': '#/experiments/exp_heldout/run',
};

function open(hash: string) {
  window.location.hash = hash;
  currentHash.value = hash;
}

afterEach(() => open(''));

/** Everything a person reads or hears: the text, and the titles, labels and placeholders. */
function readable(root: HTMLElement): string {
  for (const d of root.querySelectorAll('details')) d.open = true;
  const attrs = [...root.querySelectorAll('[title], [aria-label], [placeholder]')].flatMap((el) => ['title', 'aria-label', 'placeholder'].map((a) => el.getAttribute(a) ?? ''));
  return [root.textContent ?? '', ...attrs].join('\n');
}

/** Opens a screen and returns everything a person reads on it, once it has loaded. */
async function screenText(hash: string): Promise<string> {
  open(hash);
  const w = mount(App, { attachTo: document.body });
  await settle();
  // The screen has loaded: its heading is there and nothing is still loading.
  expect(w.find('main h1').exists()).toBe(true);
  expect(w.find('[data-test="load-loading"]').exists()).toBe(false);
  expect(w.find('[data-test="load-error"]').exists()).toBe(false);
  const text = readable(document.body);
  w.unmount();
  return text;
}

async function expectPlain(hash: string): Promise<void> {
  const text = await screenText(hash);
  expect(text.length).toBeGreaterThan(400);
  const hits = text.split('\n').filter((line) => INTERNAL.test(line));
  expect(hits).toEqual([]);
}

describe('plain words on every screen', () => {
  for (const [name, hash] of Object.entries(SCREENS)) {
    it(`the ${name} screen names no decision-log entry and no raw API path`, async () => {
      const text = await screenText(hash);
      expect(text.length).toBeGreaterThan(400);
      const hits = text.split('\n').filter((line) => INTERNAL.test(line));
      expect(hits).toEqual([]);
    });
  }
});

/**
 * The same, with the text the live API serves where the sample data is tidier than the real thing
 * (QA round 2, 5 Nov): each harness's capabilities as its adapter ships them in
 * workers/<harness>/src/<package>/capabilities.json ("(D36)", "(D18; ...)", "(..., D33)"), a Hermes
 * trial's result.json as the shipped example holds it ("R10.11: one attempt"), and the shipped
 * example, whose experiment keeps its working name ("Label batch 1: open coding (R8, ...)").
 */
// A path, not new URL(..., import.meta.url), which Vite turns into an asset address.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CAPABILITY_FILES = ['adk/src/adk_adapter', 'hermes/src/hermes_adapter', 'langgraph/src/langgraph_adapter', 'openai-agents/src/openai_agents_adapter', 'ownloop/src/ownloop'].map((dir) =>
  resolve(REPO, 'workers', dir, 'capabilities.json'),
);
const WORKING_NAME = 'Label batch 1: open coding (R8, approved: 30 trials, cap $2)';
const EXAMPLE = { name: 'harness-ownloop-vs-hermes-haiku', title: 'Draft stand-in: own loop vs Hermes on Claude Haiku 5.5 (15 draft tasks, one trial each)', loaded_at: '2026-11-05T08:00:00.000Z' };
const OWNLOOP = configs.find((c) => c.harness === 'ownloop')?.hash ?? '';

const LIVE_SCREENS: Record<string, string> = {
  'config editor on Hermes': '#/configs',
  'config editor on the own loop': `#/configs?fork=${encodeURIComponent(OWNLOOP)}`,
  'config page on the own loop': `#/configs/${encodeURIComponent(OWNLOOP)}`,
  'config page on Hermes': `#/configs/${encodeURIComponent(configs[0].hash)}`,
  build: '#/build',
  harnesses: '#/harnesses',
  'run setup': '#/run',
  'example in the experiments list': '#/experiments',
  'example comparison': '#/experiments/exp_heldout',
  'example run page': '#/experiments/exp_heldout/run',
  'example Hermes trial': '#/trials/tr_fd-vs-sip-07_b_3',
  'tasks, last run the example': '#/tasks',
};

describe.runIf(CAPABILITY_FILES.every((f) => existsSync(f)))("plain words with the live API's own text", () => {
  type Mutable = Record<string, unknown>;
  const before = structuredClone({ harnesses, trial, details, experiments });

  beforeAll(() => {
    for (const file of CAPABILITY_FILES) {
      const caps = JSON.parse(readFileSync(file, 'utf8')) as { harness: string };
      const h = (harnesses as Mutable[]).find((x) => x.name === caps.harness);
      if (h) h.capabilities = caps;
    }
    const applied = (trial.result as Mutable).applied_settings as Mutable;
    applied.api_max_retries = { value: 1, source: 'platform_default', observed: 'R10.11: one attempt' };
    Object.assign((details as Record<string, Mutable>).exp_heldout, { name: WORKING_NAME, example: EXAMPLE });
    Object.assign((experiments as Mutable[]).find((e) => e.id === 'exp_heldout') as Mutable, { name: WORKING_NAME, example: EXAMPLE });
  });

  afterAll(() => {
    harnesses.splice(0, harnesses.length, ...before.harnesses);
    Object.assign(trial, before.trial);
    Object.assign(details, before.details);
    experiments.splice(0, experiments.length, ...before.experiments);
  });

  it('starts from the real text: the capabilities hold decision-log references', () => {
    // If the adapters ever drop them, this suite still guards the screens, but says so here.
    const raw = CAPABILITY_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(raw).toMatch(/\(D36\)/);
    expect(raw).toMatch(/\(D18[;)]/);
  });

  for (const [name, hash] of Object.entries(LIVE_SCREENS)) {
    it(`the ${name} screen names no decision-log entry, and the example by its title only`, async () => {
      const text = await screenText(hash);
      const hits = text.split('\n').filter((line) => INTERNAL.test(line));
      expect(hits).toEqual([]);
      expect(text).not.toContain('Label batch 1');
      if (name.startsWith('example') || name.startsWith('tasks')) expect(text).toContain(EXAMPLE.title);
    });
  }
});

/**
 * The states the 5 Nov QA reached: the shipped example loaded (its configs are the newest, on an
 * older toolset and named after a decision-log entry), no provider key in .env, a capabilities
 * note that cites the decision log, and a run link to nothing.
 */
describe('plain words with the example loaded and no keys set', () => {
  const sample = configs as unknown as ConfigView[];
  const example: ConfigView = {
    ...sample[2],
    hash: `sha256:90a6761${'0'.repeat(57)}`,
    name: 'v2 sim check, ownloop, haiku',
    capabilities_sha256: 'sha256:old-capabilities',
    toolset: { id: 'finance', version: 'all', sha256: `sha256:e8a33031${'0'.repeat(56)}` },
    example_only: true,
    created_at: '2026-11-05T13:59:00.000Z',
  };
  const mine: ConfigView = { ...sample[2], hash: `sha256:ab${'0'.repeat(62)}`, name: 'My own loop', parent_hash: null, created_at: '2026-11-05T14:00:00.000Z' };

  beforeEach(async () => {
    vi.spyOn(api, 'configs').mockResolvedValue([...sample, example, mine]);
    vi.spyOn(api, 'config').mockImplementation((hash) => Promise.resolve({ ...([...sample, example, mine].find((c) => c.hash === hash) ?? example), children: [] }));
    vi.spyOn(api, 'models').mockResolvedValue([
      { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false },
      { name: 'claude-sonnet-5-5', provider: 'anthropic', input_per_mtok: 2, output_per_mtok: 10, key_set: false },
      { name: 'gemini-3.8-flash', provider: 'gemini', input_per_mtok: 0.75, output_per_mtok: 3.75, key_set: false },
    ]);
    const harnesses = await api.harnesses();
    for (const h of harnesses) {
      const s = h.capabilities.settings.max_output_tokens;
      if (s?.supported) s.native = `${s.native ?? 'max_tokens'}, raised once on a cut-off reply (D36)`;
    }
    vi.spyOn(api, 'harnesses').mockResolvedValue(harnesses);
  });

  const STATES: Record<string, string> = {
    'build, no keys': '#/build',
    'config, from the newest own config': '#/configs',
    'config, forking the example': `#/configs?fork=${encodeURIComponent(example.hash)}`,
    "config page, the example's": `#/configs/${encodeURIComponent(example.hash)}`,
    'run setup, the example named and no keys': `#/run?a=${encodeURIComponent(example.hash)}&b=${encodeURIComponent(mine.hash)}`,
    'run setup, no baseline': `#/run?b=${encodeURIComponent(mine.hash)}`,
    'a run that does not exist': '#/experiments/e_nope/run',
    'a comparison that does not exist': '#/experiments/e_doesnotexist',
    'a trial that does not exist': '#/trials/t_nope',
  };
  for (const [name, hash] of Object.entries(STATES)) {
    it(`the ${name} screen names no decision-log entry and no raw API path`, () => expectPlain(hash));
  }

  it("the judge's approval form, on a model whose key is not set, names no decision-log entry and no raw API path", async () => {
    open('#/experiments/exp_heldout?panel=judge');
    const w = mount(App, { attachTo: document.body });
    await settle();
    await w.get('[data-test="judge-approve-open"]').trigger('click');
    await settle();
    await w.get('[data-test="judge-model-select"]').setValue('claude-haiku-5-5');
    await w.get('[data-test="judge-budget-input"]').setValue('2');
    expect(w.get('[data-test="judge-key-problem"]').text()).toContain('needs ANTHROPIC_API_KEY in .env');
    const text = readable(document.body);
    w.unmount();
    expect(text.split('\n').filter((line) => INTERNAL.test(line))).toEqual([]);
  });
});

/**
 * The comparison states QA round 3 reached (5 Nov): two configs with one name that differ in a
 * setting, a run on fake models, and a stopped run whose reason cites the decision log.
 */
describe('plain words on the comparison of a fake run, and of a stopped one', () => {
  type Detail = Record<string, unknown> & { configs: (ConfigView & Record<string, unknown>)[] };
  const detail = (details as unknown as Record<string, Detail>).exp_heldout;
  const name = 'Prompt v1 on Own loop, Fake model finance-emi';
  const [c1, c2] = detail.configs;
  const fake: Detail = {
    ...detail,
    axis: 'max_steps',
    configs: [
      { ...c1, name, model: 'fake/finance-emi', settings: { ...c1.settings, max_steps: 10 } },
      { ...c2, name, model: 'fake/finance-emi', prompt: c1.prompt, settings: { ...c1.settings, max_steps: 12 } },
    ],
  };
  const stopped = {
    experiment_id: 'exp_heldout',
    status: 'incomplete',
    reason: "the experiment was stopped before every trial ran (40 of arm A's trials cancelled, 41 of arm B's trials cancelled); a verdict needs the full planned N (D32)",
    arms: [],
    rows: [],
    stats: null,
  };

  afterEach(() => vi.restoreAllMocks());

  for (const [state, compare] of [
    ['finished', null],
    ['stopped', stopped],
  ] as const) {
    it(`the ${state} fake run's comparison names no decision-log entry and no raw API path`, async () => {
      vi.spyOn(api, 'experiment').mockResolvedValue(fake as never);
      if (compare) vi.spyOn(api, 'compare').mockResolvedValue(compare as never);
      const text = await screenText('#/experiments/exp_heldout');
      expect(text).toContain('Max steps: 10 in A, 12 in B');
      expect(text).toContain('Scripted test outputs');
      expect(text.split('\n').filter((line) => INTERNAL.test(line))).toEqual([]);
    });
  }
});
