/** Fixture mode (VITE_FIXTURES=1) serves the sample data in src/fixtures instead of calling the
 *  API, so every screen renders with no backend. The header says "Sample data" while it is on.
 *  Read on every call so tests can switch it with vi.stubEnv. */
export function isFixtureMode(): boolean {
  return import.meta.env.VITE_FIXTURES === '1';
}

/** The time fixtures are written against, so "2 hours ago" stays true in screenshots. */
export const FIXTURE_NOW = Date.parse('2026-11-05T14:08:00Z');

export function now(): number {
  return isFixtureMode() ? FIXTURE_NOW : Date.now();
}

/** Fixture times print in UTC so tests and screenshots do not depend on the machine's zone. */
export function displayTimeZone(): string | undefined {
  return isFixtureMode() ? 'UTC' : undefined;
}
