/**
 * Back and Forward return to where you were on a page (7 Nov QA: Back from a trial opened the
 * comparison at its top). The app's own version of a router's `scrollBehavior` with
 * `savedPosition`, for its hash routes: each history entry gets a key in `history.state`, the
 * scroll position of the entry in view is kept against its key as you scroll, and an entry you come
 * back to is scrolled to its position again, waiting for its page to grow tall enough (its data
 * loads after the route changes). An entry opened afresh has no position kept, so it starts at the
 * top. Positions live in memory: a reload starts at the top.
 */

const STATE_KEY = 'evalsScrollKey';
/** How long a restore waits for the page to be tall enough. */
const RESTORE_FOR_MS = 3000;

const positions = new Map<string, number>();
let current: string | null = null;
let stopRestoring: (() => void) | null = null;

function newKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The history entry in view becomes the one whose scroll is kept. It is given a key when it has
 * none (a page opened afresh). `saved` is the position kept for it, or null when there is none.
 */
export function enterEntry(): { key: string; saved: number | null } {
  const state: unknown = window.history.state;
  const fields = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  const stored = fields[STATE_KEY];
  let key = typeof stored === 'string' ? stored : null;
  if (!key) {
    key = newKey();
    try {
      window.history.replaceState({ ...fields, [STATE_KEY]: key }, '');
    } catch {
      // A browser that refuses (too many calls): this entry's position is not kept.
    }
  }
  current = key;
  return { key, saved: positions.get(key) ?? null };
}

/** Keeps the scroll position of the entry in view. */
export function rememberScroll(): void {
  if (current) positions.set(current, window.scrollY);
}

/** Stops a restore that is still waiting for its page to grow. */
export function stopRestore(): void {
  stopRestoring?.();
}

/**
 * Scrolls to `y` once the page is tall enough, trying on each frame for up to 3 s; scrolling by
 * hand (wheel, touch, a key) stops it.
 */
export function restoreScroll(y: number): void {
  stopRestore();
  const started = Date.now();
  const frame = window.requestAnimationFrame?.bind(window) ?? ((f: FrameRequestCallback) => window.setTimeout(() => f(Date.now()), 16));
  const cancelFrame = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window);
  let id = 0;
  const stop = () => {
    cancelFrame(id);
    for (const type of ['wheel', 'touchstart', 'keydown'] as const) window.removeEventListener(type, stop);
    if (stopRestoring === stop) stopRestoring = null;
  };
  const attempt = () => {
    const room = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.min(y, room));
    if (room >= y || Date.now() - started > RESTORE_FOR_MS) stop();
    else id = frame(attempt);
  };
  for (const type of ['wheel', 'touchstart', 'keydown'] as const) window.addEventListener(type, stop, { passive: true });
  stopRestoring = stop;
  attempt();
}

/** Starts keeping positions: the browser's own restoring is turned off, since it would scroll
 *  before a page's data is in, and the entry in view is keyed. Returns a stop function. */
export function startScrollMemory(): () => void {
  try {
    window.history.scrollRestoration = 'manual';
  } catch {
    // Not settable here: the browser may restore too, and this still corrects it.
  }
  enterEntry();
  window.addEventListener('scroll', rememberScroll, { passive: true });
  return () => {
    window.removeEventListener('scroll', rememberScroll);
    stopRestore();
  };
}

/** For tests: forgets every position. */
export function resetScrollMemory(): void {
  positions.clear();
  current = null;
  stopRestore();
}
