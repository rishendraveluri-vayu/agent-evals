/**
 * D75: an experiment with a Hermes config on a real model starts only after the pre-run conflict
 * check (D33, D38) has read that config's current input: Hermes's rendered prompt, our task prompt
 * and the settings. A new prompt, new settings or a new Hermes pin changes the input and needs a
 * new check; an unchanged input reuses the stored one, which costs nothing. The findings never
 * block (the checker is one model's reading, never validated); the check only has to have run.
 *
 * Exempt: fake models (`fake/*`, the platform's tests and CI, which never call a real model) and
 * every other harness (Rishi asked for Hermes, whose own system text wraps ours).
 */

export const GATED_HARNESS = 'hermes';

export interface GateConfig {
  hash: string;
  harness: string;
  model: string;
}

/** Whether a config needs a stored conflict check before an experiment with it starts. */
export function needsConflictCheck(cfg: Pick<GateConfig, 'harness' | 'model'>): boolean {
  return cfg.harness === GATED_HARNESS && !cfg.model.startsWith('fake/');
}

/** The 409's message and fix for configs that have no check for their current input. */
export function conflictGateError(missing: GateConfig[]): { message: string; fix: string } {
  const named = missing.map((c) => `${c.hash.replace(/^sha256:/, '').slice(0, 12)} (Hermes on ${c.model})`).join(', ');
  const one = missing.length === 1;
  return {
    message:
      `${one ? 'config' : 'configs'} ${named} ${one ? 'has' : 'have'} no conflict check for ${one ? 'its' : 'their'} current prompt and settings, ` +
      'and a Hermes run on a real model starts only after one (D75): Hermes wraps our prompt in its own instructions, and the check lists where they pull against each other',
    fix:
      `For each: POST /api/configs/<hash>/rendered-prompt until it is ready (a free probe on the fake model), then POST /api/configs/<hash>/conflict-check ` +
      '(one call on Claude Sonnet 5.5, typically $0.02 to $0.03 and at most about $0.08, from the conflict-check allowance). The Run screen does both when you start.',
  };
}
