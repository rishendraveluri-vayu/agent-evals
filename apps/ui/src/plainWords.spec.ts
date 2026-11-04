/** No screen shows the authors' internal references: decision-log numbers (R8, D32, SP5, A14) or
 *  raw API paths (POST /...). They belong in the docs and in code comments, not in front of a
 *  reviewer. Each screen is rendered in fixture mode, with every disclosure opened, and its text,
 *  titles and labels are read. */
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App.vue';
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

describe('plain words on every screen', () => {
  for (const [name, hash] of Object.entries(SCREENS)) {
    it(`the ${name} screen names no decision-log entry and no raw API path`, async () => {
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
    });
  }
});
