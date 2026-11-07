import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'agent-evals-theme';

/** The system's setting as matchMedia reports it, and a way to change it as the OS would. */
function system(dark: boolean | null) {
  const listeners: ((e: MediaQueryListEvent) => void)[] = [];
  const query = {
    matches: !!dark,
    addEventListener: (_: string, f: (e: MediaQueryListEvent) => void) => listeners.push(f),
    removeEventListener: (_: string, f: (e: MediaQueryListEvent) => void) => listeners.splice(listeners.indexOf(f), 1),
  };
  vi.stubGlobal('matchMedia', dark === null ? undefined : vi.fn(() => query));
  return {
    change(to: boolean) {
      query.matches = to;
      for (const f of [...listeners]) f({ matches: to } as MediaQueryListEvent);
    },
  };
}

/** The theme module as a fresh page load reads it. */
async function load() {
  vi.resetModules();
  return import('./theme');
}

describe('the theme follows the system until the viewer picks one (7 Nov QA)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('opens dark when the system is dark and nothing is saved', async () => {
    system(true);
    const t = await load();
    t.applyTheme();
    expect(t.theme.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('opens light when the system is light, or cannot say', async () => {
    system(false);
    expect((await load()).theme.value).toBe('light');
    system(null);
    expect((await load()).theme.value).toBe('light');
  });

  it('keeps a saved choice over the system', async () => {
    window.localStorage.setItem(KEY, 'light');
    system(true);
    expect((await load()).theme.value).toBe('light');
    window.localStorage.setItem(KEY, 'dark');
    system(false);
    expect((await load()).theme.value).toBe('dark');
  });

  it('follows the system as it changes while nothing is saved, and stops once the toggle is used', async () => {
    const os = system(false);
    const t = await load();
    const stop = t.followSystem();
    os.change(true);
    expect(t.theme.value).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    t.setTheme('light');
    expect(window.localStorage.getItem(KEY)).toBe('light');
    os.change(true);
    expect(t.theme.value).toBe('light');
    stop();
  });
});
