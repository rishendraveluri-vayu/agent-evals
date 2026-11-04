/** No screen shows the authors' internal references: decision-log numbers (R8, D32, SP5, A14) or
 *  raw API paths (POST /...). They belong in the docs and in code comments, not in front of a
 *  reviewer. Each screen is rendered in fixture mode, with every disclosure opened, and its text,
 *  titles and labels are read. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount } from '@vue/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import App from './App.vue';
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
