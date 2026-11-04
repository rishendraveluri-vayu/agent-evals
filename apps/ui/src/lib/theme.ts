/** Light or dark, chosen by the viewer and remembered in this browser. Nothing flips it
 *  automatically. `?theme=dark` in the address overrides it for one visit (screenshots). */
import { ref } from 'vue';

export type Theme = 'light' | 'dark';
const KEY = 'agent-evals-theme';

function stored(): Theme {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('theme');
    if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // Storage can be blocked; the light theme is the default.
  }
  return 'light';
}

export const theme = ref<Theme>(typeof window === 'undefined' ? 'light' : stored());

export function applyTheme(value: Theme = theme.value): void {
  document.documentElement.dataset.theme = value;
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
