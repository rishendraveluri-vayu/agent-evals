import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enterEntry, resetScrollMemory, restoreScroll, startScrollMemory } from './scrollMemory';

/** The page as scrolled to `y`, with a scroll event, as a browser fires one. */
function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
  window.dispatchEvent(new Event('scroll'));
}

/** How tall the page is, for a restore to wait on. */
function pageHeight(px: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: px });
}

describe('Back and Forward return to where you were on a page (7 Nov QA)', () => {
  let stop: () => void = () => undefined;
  let scrolled: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetScrollMemory();
    window.history.replaceState(null, '', '#/experiments/exp_heldout');
    scrolled = vi.fn();
    vi.stubGlobal('scrollTo', scrolled);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    pageHeight(5000);
    stop = startScrollMemory();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keys each history entry and keeps its position; a page opened afresh has none, one come back to has its own', () => {
    const comparison = enterEntry();
    expect(comparison.saved).toBeNull();
    expect((window.history.state as Record<string, unknown>).evalsScrollKey).toBe(comparison.key);
    scrollTo(1840);
    // A trial opened from the task table: a new entry, which starts at the top.
    const before = window.history.state as unknown;
    window.history.pushState(null, '', '#/trials/t_1');
    const trial = enterEntry();
    expect(trial.saved).toBeNull();
    expect(trial.key).not.toBe(comparison.key);
    scrollTo(300);
    // Back: the comparison's entry, with its key, comes back with its position.
    window.history.pushState(before, '', '#/experiments/exp_heldout');
    expect(enterEntry()).toEqual({ key: comparison.key, saved: 1840 });
    // Entering the same entry twice changes nothing.
    expect(enterEntry().key).toBe(comparison.key);
  });

  it('keeps whatever else the history entry holds', () => {
    window.history.pushState({ other: 1 }, '', '#/tasks');
    const { key } = enterEntry();
    expect(window.history.state).toEqual({ other: 1, evalsScrollKey: key });
  });

  it('waits for the page to grow tall enough before it scrolls there, then stops', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => setTimeout(() => f(Date.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    // The comparison is loading: the page is no taller than the window.
    pageHeight(800);
    restoreScroll(1840);
    expect(scrolled).toHaveBeenLastCalledWith(0, 0);
    vi.advanceTimersByTime(100);
    pageHeight(4000);
    vi.advanceTimersByTime(20);
    expect(scrolled).toHaveBeenLastCalledWith(0, 1840);
    const calls = scrolled.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(scrolled.mock.calls.length).toBe(calls);
  });

  it('gives up when you scroll by hand, or after 3 s', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => setTimeout(() => f(Date.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    pageHeight(800);
    restoreScroll(1840);
    window.dispatchEvent(new Event('wheel'));
    const calls = scrolled.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(scrolled.mock.calls.length).toBe(calls);
    restoreScroll(1840);
    vi.advanceTimersByTime(3500);
    const after = scrolled.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(scrolled.mock.calls.length).toBe(after);
  });
});
