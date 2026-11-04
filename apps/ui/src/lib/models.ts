/**
 * Real and fake models. GET /models lists the real ones only; the fake ones are LiteLLM's
 * `fake/*` route to the fake LLM server, which plays a script named after the slash
 * (services/fake-llm/scripts). They cost nothing real (made-up prices, so budgets still count),
 * so a reviewer with no API keys can build and run a config end to end. The list below is the
 * scripts that make sense to pick; POST /configs accepts any `fake/<script>`.
 */
import type { ModelView } from '../api/types';

export interface FakeModel {
  name: string;
  /** What the script does, in a phrase. */
  does: string;
  /** For the simulated client rather than the agent. */
  sim?: boolean;
}

export const FAKE_MODELS: FakeModel[] = [
  { name: 'fake/finance-emi', does: 'one EMI tool call, then an answer that uses it' },
  { name: 'fake/finance-chat', does: 'a tool call, then one answer per client message (for conversation tasks)' },
  { name: 'fake/finance-malformed', does: 'a broken tool call first, then a good one and an answer' },
  { name: 'fake/finance-loop', does: 'calls a tool forever, so it ends at the step limit' },
  { name: 'fake/finance-429', does: 'always rate-limited, so every trial is an infra failure' },
  { name: 'fake/echo', does: 'repeats the last message back' },
  { name: 'fake/sim-client', does: 'a simulated client: two replies, then it ends the conversation', sim: true },
];

export const FAKE_SIM_MODEL = 'fake/sim-client';

export function isFake(model: string | null | undefined): boolean {
  return !!model && model.startsWith('fake/');
}

/** A fake model's script, in words; empty for a real model or an unknown script. */
export function fakeDoes(model: string): string {
  return FAKE_MODELS.find((m) => m.name === model)?.does ?? (isFake(model) ? 'a scripted reply from the fake LLM server' : '');
}

/** The models a config can pick: the real ones from the API, then the fake ones for the agent. */
export function agentModels(real: ModelView[]): { real: ModelView[]; fake: FakeModel[] } {
  return { real: real.filter((m) => !isFake(m.name)), fake: FAKE_MODELS.filter((m) => !m.sim) };
}

/** The models the simulated client can run on: the real ones, then the fake client script. */
export function simModels(real: ModelView[]): { real: ModelView[]; fake: FakeModel[] } {
  return { real: real.filter((m) => !isFake(m.name)), fake: FAKE_MODELS.filter((m) => m.sim) };
}
