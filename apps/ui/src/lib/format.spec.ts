import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayOf, stamp, when } from './format';

describe('times from another day say their day (7 Nov QA)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prints a time from today alone, and any other day with its date', () => {
    // Fixture mode: the clock is 5 Nov 2026, 14:08 UTC, and times print in UTC.
    vi.stubEnv('VITE_FIXTURES', '1');
    expect(dayOf('2026-11-05T00:01:00Z')).toBeNull();
    expect(stamp('2026-11-05T13:02:00Z')).toBe('13:02');
    expect(when('2026-11-05T13:02:00Z')).toBe('today at 13:02');
    expect(dayOf('2026-11-04T23:59:00Z')).toBe('4 Nov');
    expect(stamp('2026-11-03T13:02:00Z')).toBe('3 Nov, 13:02');
    expect(when('2026-11-06T09:00:00Z')).toBe('on 6 Nov at 09:00');
    // Another year says its year.
    expect(stamp('2025-12-31T08:00:00Z')).toBe('31 Dec 2025, 08:00');
  });
});
