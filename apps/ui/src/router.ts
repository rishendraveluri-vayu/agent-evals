/** Hash routes. Every link is a plain <a href="#/...">, so it works with the keyboard, opens in
 *  a new tab and needs no router library. */
import { ref } from 'vue';
import { LABEL_SETS, type LabelSet } from './api/types';

export type Route =
  | { name: 'start' }
  | { name: 'build' }
  | { name: 'example' }
  | { name: 'experiments' }
  | { name: 'config'; fork: string | null }
  | { name: 'config-page'; hash: string }
  | { name: 'run-new'; a: string | null; b: string | null; calibration: boolean }
  | { name: 'run'; id: string }
  | { name: 'compare'; id: string; panel: string | null }
  | { name: 'trial'; id: string }
  | { name: 'recorded' }
  /** `calibrate`: label one experiment's outputs to calibrate its judge (D83). */
  | { name: 'labels'; set: LabelSet | null; experiment: string | null; items: string | null; calibrate: boolean }
  | { name: 'judge' }
  | { name: 'harnesses' }
  | { name: 'tasks' }
  | { name: 'not-found'; path: string };

export type Section = 'start' | 'build' | 'experiments' | 'configs' | 'tasks' | 'harnesses' | 'labels';

const dec = (s: string) => decodeURIComponent(s);
const enc = encodeURIComponent;

/** The route for an address. One with a broken percent escape (`#/trials/%`) is not found, never
 *  a blank page: decodeURIComponent throws a URIError on it. */
export function parseHash(hash: string): Route {
  try {
    return routeOf(hash);
  } catch (err) {
    if (err instanceof URIError) return { name: 'not-found', path: (hash.replace(/^#/, '') || '/').split('?')[0] };
    throw err;
  }
}

function routeOf(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  const params = new URLSearchParams(search);
  const parts = path.split('/').filter(Boolean);
  const [first, second, third] = parts;
  // The front door (three ways in) is the root; the full platform starts at #/experiments.
  if (parts.length === 0) return { name: 'start' };
  if (first === 'experiments' && parts.length === 1) return { name: 'experiments' };
  if (first === 'build' && parts.length === 1) return { name: 'build' };
  if (first === 'example' && parts.length === 1) return { name: 'example' };
  if (first === 'configs' && parts.length === 1) return { name: 'config', fork: params.get('fork') };
  if (first === 'configs' && second && parts.length === 2) return { name: 'config-page', hash: dec(second) };
  if (first === 'run' && parts.length === 1) return { name: 'run-new', a: params.get('a'), b: params.get('b'), calibration: params.get('aa') === '1' };
  if (first === 'experiments' && second && third === 'run' && parts.length === 3) return { name: 'run', id: dec(second) };
  if (first === 'experiments' && second && parts.length === 2) return { name: 'compare', id: dec(second), panel: params.get('panel') };
  if (first === 'trials' && parts.length === 1) return { name: 'recorded' };
  if (first === 'trials' && second && parts.length === 2) return { name: 'trial', id: dec(second) };
  if (first === 'labels' && parts.length === 1) {
    const set = params.get('set');
    return {
      name: 'labels',
      set: (LABEL_SETS as readonly string[]).includes(set ?? '') ? (set as LabelSet) : null,
      experiment: params.get('experiment'),
      items: params.get('items'),
      calibrate: params.get('calibrate') === '1',
    };
  }
  if (first === 'labels' && second === 'judge') return { name: 'judge' };
  if (first === 'harnesses' && parts.length === 1) return { name: 'harnesses' };
  if (first === 'tasks' && parts.length === 1) return { name: 'tasks' };
  return { name: 'not-found', path };
}

export function sectionOf(route: Route): Section | null {
  switch (route.name) {
    case 'start':
    case 'example':
      return 'start';
    case 'build':
      return 'build';
    case 'config':
    case 'config-page':
      return 'configs';
    case 'tasks':
      return 'tasks';
    case 'harnesses':
      return 'harnesses';
    case 'labels':
    case 'judge':
      return 'labels';
    case 'not-found':
      return null;
    default:
      return 'experiments';
  }
}

export const href = {
  /** The front door: a finished example, the guided builder, or the full platform. */
  start: () => '#/',
  /** Build an agent, step by step: the guided way to make a config. */
  build: () => '#/build',
  /** The finished example shipped with the repo: loads it if needed, then opens its comparison. */
  example: () => '#/example',
  experiments: () => '#/experiments',
  config: () => '#/configs',
  /** A new config that starts as a copy of `hash` and names it as its parent (D34). */
  fork: (hash: string) => `#/configs?fork=${enc(hash)}`,
  configPage: (hash: string) => `#/configs/${enc(hash)}`,
  /** `calibration`: an A/A calibration run of `a` (D44), the same agent on both arms. */
  runNew: (a?: string, b?: string, opts: { calibration?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (a) q.set('a', a);
    if (b) q.set('b', b);
    if (opts.calibration) q.set('aa', '1');
    const s = q.toString();
    return `#/run${s ? `?${s}` : ''}`;
  },
  run: (id: string) => `#/experiments/${enc(id)}/run`,
  compare: (id: string) => `#/experiments/${enc(id)}`,
  /** The comparison with its judge panel in view: approve, revoke or regrade there. */
  compareJudge: (id: string) => `#/experiments/${enc(id)}?panel=judge`,
  trial: (id: string) => `#/trials/${enc(id)}`,
  recorded: () => '#/trials',
  /** The labelling page; with `calibrate`, one experiment's outputs ordered to calibrate its judge (D83). */
  labels: (opts: { set?: LabelSet; experiment?: string; calibrate?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.set) q.set('set', opts.set);
    if (opts.experiment) q.set('experiment', opts.experiment);
    if (opts.calibrate) q.set('calibrate', '1');
    const s = q.toString();
    return `#/labels${s ? `?${s}` : ''}`;
  },
  judge: () => '#/labels/judge',
  harnesses: () => '#/harnesses',
  tasks: () => '#/tasks',
};

/** The current route, kept in step with the address bar by App.vue. */
export const currentHash = ref(typeof window === 'undefined' ? '' : window.location.hash);

export function navigate(to: string): void {
  if (window.location.hash === to) return;
  window.location.hash = to;
  currentHash.value = to;
}

/** Like navigate, but the current address is replaced rather than kept in history, so Back skips
 *  a screen that only forwards (#/example). */
export function replaceRoute(to: string): void {
  if (window.location.hash === to) return;
  window.location.replace(to);
  currentHash.value = to;
}
