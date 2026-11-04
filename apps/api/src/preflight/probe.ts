import type { JsonObject } from '../contract';
import { canonicalJson, sha256Ref } from '../common/hashing';

/**
 * Probe trials (D33): one run of a config on the fake model, through the harness's own worker and
 * the normal claim and report protocol, so the API can read the exact system prompt the harness
 * sent. A probe has no experiment and is never counted in experiment results, estimates, labels
 * or trial spend.
 */

/** The fake model, through LiteLLM: one finance tool call, then an answer. Costs nothing real. */
export const PROBE_MODEL = 'fake/finance-emi';

/** Fake money only: the key is limited to PROBE_MODEL, whose prices in config.yaml are made up. */
export const PROBE_BUDGET_USD = 0.5;

/** Probe attempts are stored under runs/probes/<trial_id>/attempt-<n>/. Experiment ids start with e_. */
export const PROBE_FOLDER = 'probes';

/** The stored first request, as the runner writes it from LiteLLM's spend log (contract v2 section 10). */
export const FIRST_REQUEST_FILE = 'artifacts/proxy/0001.request.json';

/**
 * The task every probe runs. Built in rather than under tasks/, so it never appears in the task
 * catalogue. The question matches what fake/finance-emi answers. No client file: the finance
 * server starts without one, and calculate_emi does not read it.
 */
export const PROBE_TASK_BODY: JsonObject = {
  id: 'prompt-probe',
  version: '1',
  split: 'discovery',
  kind: 'probe',
  summary: 'PROBE ONLY, built into the API: renders a config’s system prompt on the fake model (D33). Not part of the task set.',
  synthetic: true,
  messages: [{ role: 'user', content: 'What is my EMI on Rs 10 lakh at 9% for 20 years?' }],
  client_sim: null,
  client_state: null,
  graders: [],
};

export const PROBE_TASK_SHA256 = sha256Ref(canonicalJson(PROBE_TASK_BODY));
export const PROBE_TASK_SOURCE = 'built-in:prompt-probe';
