/**
 * A page's unsaved choices, kept in this tab's sessionStorage, so following a link away and
 * pressing Back finds them as they were. Storage can be blocked or full (a private window, site
 * data turned off): then nothing is kept and the page starts fresh, as before.
 */

export function readDraft(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export function writeDraft(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept: the page still works, it just starts fresh next time.
  }
}

export function clearDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

/** A plain object, or null: for reading a stored draft field by field. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
