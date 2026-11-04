/** Hash routes. Every link is a plain <a href="#/...">, so it works with the keyboard, opens in
 *  a new tab and needs no router library. */
import { ref } from 'vue';

export type Route =
  | { name: 'experiments' }
  | { name: 'config' }
  | { name: 'run-new'; a: string | null; b: string | null }
  | { name: 'run'; id: string }
  | { name: 'compare'; id: string }
  | { name: 'trial'; id: string }
  | { name: 'recorded' }
  | { name: 'labels' }
  | { name: 'judge' }
  | { name: 'harnesses' }
  | { name: 'tasks' }
  | { name: 'not-found'; path: string };

export type Section = 'experiments' | 'configs' | 'tasks' | 'harnesses' | 'labels';

const dec = (s: string) => decodeURIComponent(s);
const enc = encodeURIComponent;

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  const params = new URLSearchParams(search);
  const parts = path.split('/').filter(Boolean);
  const [first, second, third] = parts;
  if (parts.length === 0 || (first === 'experiments' && parts.length === 1)) return { name: 'experiments' };
  if (first === 'configs' && parts.length <= 2) return { name: 'config' };
  if (first === 'run' && parts.length === 1) return { name: 'run-new', a: params.get('a'), b: params.get('b') };
  if (first === 'experiments' && second && third === 'run' && parts.length === 3) return { name: 'run', id: dec(second) };
  if (first === 'experiments' && second && parts.length === 2) return { name: 'compare', id: dec(second) };
  if (first === 'trials' && parts.length === 1) return { name: 'recorded' };
  if (first === 'trials' && second && parts.length === 2) return { name: 'trial', id: dec(second) };
  if (first === 'labels' && parts.length === 1) return { name: 'labels' };
  if (first === 'labels' && second === 'judge') return { name: 'judge' };
  if (first === 'harnesses' && parts.length === 1) return { name: 'harnesses' };
  if (first === 'tasks' && parts.length === 1) return { name: 'tasks' };
  return { name: 'not-found', path };
}

export function sectionOf(route: Route): Section | null {
  switch (route.name) {
    case 'config':
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
  experiments: () => '#/',
  config: () => '#/configs',
  runNew: (a?: string, b?: string) => {
    const q = new URLSearchParams();
    if (a) q.set('a', a);
    if (b) q.set('b', b);
    const s = q.toString();
    return `#/run${s ? `?${s}` : ''}`;
  },
  run: (id: string) => `#/experiments/${enc(id)}/run`,
  compare: (id: string) => `#/experiments/${enc(id)}`,
  trial: (id: string) => `#/trials/${enc(id)}`,
  recorded: () => '#/trials',
  labels: () => '#/labels',
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
