/** No screen shows the authors' internal references: decision-log numbers (R8, D32, SP5, A14) or
 *  raw API paths (POST /...). They belong in the docs and in code comments, not in front of a
 *  reviewer. Each screen is rendered in fixture mode, with every disclosure opened, and its text,
 *  titles and labels are read. */
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { api } from './api/client';
import type { ConfigView } from './api/types';
import configs from './fixtures/configs.json';
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

async function expectPlain(hash: string) {
  open(hash);
  const w = mount(App, { attachTo: document.body });
  await settle();
  // The screen has loaded: its heading is there and nothing is still loading.
  expect(w.find('main h1').exists()).toBe(true);
  expect(w.find('[data-test="load-loading"]').exists()).toBe(false);
  expect(w.find('[data-test="load-error"]').exists()).toBe(false);
  const text = readable(document.body);
  expect(text.length).toBeGreaterThan(400);
  const hits = text.split('\n').filter((line) => INTERNAL.test(line));
  expect(hits).toEqual([]);
  w.unmount();
}

describe('plain words on every screen', () => {
  for (const [name, hash] of Object.entries(SCREENS)) {
    it(`the ${name} screen names no decision-log entry and no raw API path`, () => expectPlain(hash));
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
  };
  for (const [name, hash] of Object.entries(STATES)) {
    it(`the ${name} screen names no decision-log entry and no raw API path`, () => expectPlain(hash));
  }
});
