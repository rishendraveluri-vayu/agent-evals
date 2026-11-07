/** Light or dark. A choice made with the header toggle is remembered in this browser and wins;
 *  with none saved, the page follows the system's setting (prefers-color-scheme), and keeps
 *  following it as it changes (7 Nov QA: the system's dark mode was ignored). `?theme=dark` in the
 *  address overrides both for one visit (screenshots). */
import { ref } from 'vue';

export type Theme = 'light' | 'dark';
const KEY = 'agent-evals-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The viewer's own choice: the address's for this visit, else the one saved; null when neither. */
function chosen(): Theme | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('theme');
    if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // Storage can be blocked: no choice is known, so the system's setting applies.
  }
  return null;
}

/** The system's setting; light where the browser cannot say. */
function system(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export const theme = ref<Theme>(typeof window === 'undefined' ? 'light' : (chosen() ?? system()));

export function applyTheme(value: Theme = theme.value): void {
  document.documentElement.dataset.theme = value;
}

/** Follows the system's setting as it changes, while no choice is saved. Returns a stop function. */
export function followSystem(): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  const onChange = (e: MediaQueryListEvent) => {
    if (chosen() !== null) return;
    theme.value = e.matches ? 'dark' : 'light';
    applyTheme();
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function setTheme(value: Theme): void {
  theme.value = value;
  applyTheme(value);
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    // Not remembered, but still applied for this visit.
  }
}
