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
/** The fake agent model a new config falls back to when no real model has its key set. */
export const FAKE_EMI_MODEL = 'fake/finance-emi';

export function isFake(model: string | null | undefined): boolean {
  return !!model && model.startsWith('fake/');
}

/** The command that starts the local model's Ollama service (README, Add a model). */
export const LOCAL_MODEL_COMMAND = 'docker compose --profile local-model up -d ollama';

/**
 * The local open-weight model, served by the optional Ollama service: free per token and needs
 * no key, but it answers only once its compose profile is up. GET /models lists it from the
 * LiteLLM config either way, with `key_set: null` (no key to tell about).
 */
export function isLocal(model: Pick<ModelView, 'name' | 'provider'> | string | null | undefined): boolean {
  if (!model) return false;
  const m = typeof model === 'string' ? { name: model, provider: null } : model;
  return m.name.endsWith('-local') || m.provider === 'ollama' || m.provider === 'ollama_chat';
}

/** A hosted model (a provider's, not the local one, not fake). */
const isHosted = (m: ModelView) => !isFake(m.name) && !isLocal(m);

/**
 * The hosted models that can run, best first: those whose provider key is set, then those the
 * API could not tell about (`key_set: null`, run outside compose), which may well run. The local
 * model is never among them: `null` there means it needs no key, not that it is up.
 */
export function runnableHosted(models: ModelView[]): ModelView[] {
  const hosted = models.filter(isHosted);
  return [...hosted.filter((m) => m.key_set === true), ...hosted.filter((m) => m.key_set === null)];
}

/**
 * The real model a new agent starts on in the guided builder: one that can run (runnableHosted),
 * else the first hosted model (saving and the preview are free without its key, and the page says
 * which key it needs), else the local one; '' when none is listed.
 */
export function defaultRealModel(models: ModelView[]): string {
  const real = models.filter((m) => !isFake(m.name));
  return (runnableHosted(real)[0] ?? real.find(isHosted) ?? real[0])?.name ?? '';
}

/** A fake model's script, in words; empty for a real model or an unknown script. */
export function fakeDoes(model: string): string {
  return FAKE_MODELS.find((m) => m.name === model)?.does ?? (isFake(model) ? 'a scripted reply from the fake LLM server' : '');
}

/** Free per token: the local model, or a model priced at 0 in and 0 out. */
export function isFree(m: Pick<ModelView, 'name' | 'provider' | 'input_per_mtok' | 'output_per_mtok'>): boolean {
  return isLocal(m) || (m.input_per_mtok === 0 && m.output_per_mtok === 0);
}

/** The models a config can pick: the real ones from the API, then the fake ones for the agent. */
export function agentModels(real: ModelView[]): { real: ModelView[]; fake: FakeModel[] } {
  return { real: real.filter((m) => !isFake(m.name)), fake: FAKE_MODELS.filter((m) => !m.sim) };
}

/** The models the simulated client can run on: the real ones, then the fake client script. */
export function simModels(real: ModelView[]): { real: ModelView[]; fake: FakeModel[] } {
  return { real: real.filter((m) => !isFake(m.name)), fake: FAKE_MODELS.filter((m) => m.sim) };
}
