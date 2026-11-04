/**
 * A message for one experiment's run page, set just before the page opens it. Creating a run and
 * starting it are two calls (POST /experiments, then .../start): when the start fails, the
 * experiment exists but has not started, so the Run screen opens its page, which can start or
 * discard it, and shows why it did not start. Read once, then gone.
 */
const messages = new Map<string, string>();

export function setRunFlash(experimentId: string, text: string): void {
  messages.set(experimentId, text);
}

export function takeRunFlash(experimentId: string): string | null {
  const text = messages.get(experimentId) ?? null;
  messages.delete(experimentId);
  return text;
}
