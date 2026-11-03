export type DbState = 'up' | 'down' | 'not_configured';

export interface Health {
  status: string;
  db: DbState;
}

export type HealthResult =
  | { kind: 'ok'; health: Health }
  | { kind: 'unreachable'; reason: string };

const HEALTH_URL = '/api/health';
const TIMEOUT_MS = 5000;
const DB_STATES: readonly string[] = ['up', 'down', 'not_configured'];

function isHealth(value: unknown): value is Health {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.status === 'string' && typeof record.db === 'string' && DB_STATES.includes(record.db);
}

/**
 * Asks the API for its health. The API answers 200 (db up or not configured)
 * or 503 (db down) with the same body; anything else, such as a network error,
 * a timeout or a proxy error page, means the API itself is unreachable.
 */
export async function fetchHealth(): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetch(HEALTH_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) };
  }
  if (response.status !== 200 && response.status !== 503) {
    return { kind: 'unreachable', reason: `HTTP ${response.status}` };
  }
  try {
    const body: unknown = await response.json();
    if (isHealth(body)) {
      return { kind: 'ok', health: body };
    }
  } catch {
    // Not JSON: fall through to the unexpected-reply case.
  }
  return { kind: 'unreachable', reason: `unexpected reply (HTTP ${response.status})` };
}
