import type { JsonObject, Seed, Settings, SettingsSources } from '../contract';
import { bareHex } from '../common/hashing';
import { modelRejects } from '../configs/settings';

/** Environment variable names for the trial's keys (D23); never OPENAI_API_KEY. */
export const MODEL_KEY_ENV = 'EVALS_MODEL_API_KEY';
export const SIM_KEY_ENV = 'EVALS_SIM_API_KEY';

/**
 * How a worker starts the finance MCP server: the contract's own example (docs/adapter-
 * contract.md section 3), over stdio, with its state in the fixed trial folder (D3, D14).
 */
export const FINANCE_MCP_COMMAND = ['/opt/finance-mcp/bin/finance-mcp', '--transport', 'stdio', '--state-dir', '/trial/state'];
export const TOOL_TIMEOUT_S = 30;

/** D22: the simulated client runs at temperature 0. */
export const SIM_TEMPERATURE = 0;
/**
 * The simulator's output token cap, also the contract example's. Haiku 5.5 thinks by default and
 * its reasoning counts towards the cap: on 4 Nov a cap of 300 went entirely to reasoning
 * (`reasoning_tokens: 300, text_tokens: 0`) and the reply was empty. 2048 leaves room for the
 * reasoning; the prompt asks for two or three sentences, so the visible text stays short. The cap
 * is part of the reply-cache key, so replies cached under 300 are not reused.
 */
export const SIM_MAX_OUTPUT_TOKENS = 2048;

/**
 * The simulator's temperature on `model`: D22's 0, or null (not sent, so the model's default
 * applies) on a model that refuses temperature, which D27 settles for Haiku 5.5. The reply cache
 * keeps the client repeatable either way.
 */
export function simTemperature(model: string): number | null {
  return modelRejects(model, 'temperature') ? null : SIM_TEMPERATURE;
}

/** The file the finance MCP server reads from its state folder. */
export const CLIENT_STATE_FILE = 'client.json';

export interface SpecInputs {
  trial: {
    id: string;
    /** Null for a probe trial (D33); contract v2 allows it outside an experiment. */
    experimentId: string | null;
    repeatIndex: number;
    attempt: number;
  };
  config: {
    id: string;
    hash: string;
    model: string;
    apiFormat: string;
    settings: Settings;
    settingsSources: SettingsSources;
    harnessOptions: JsonObject;
    /** The config's seeded memory and skills (D39); empty lists when it seeds nothing. */
    seed: Seed;
  };
  task: {
    id: string;
    sha256: string;
    /** Null outside an experiment (a probe), as contract v2's task_split allows. */
    split: 'discovery' | 'held_out' | null;
    body: JsonObject;
    /** D27: the client file's summary for the simulator (client-summary.ts); null without one. */
    clientSummary?: string | null;
  };
  prompt: { id: string; version: string; sha256: string; text: string };
  toolset: { id: string; version: string; sha256: string; servers: { name: string; allowed_tools: string[] }[] };
  sim: {
    model: string;
    /** Null: not sent (D27). */
    temperature: number | null;
    maxOutputTokens: number;
    prompt: { id: string; version: string; sha256: string; text: string };
  } | null;
  /** LiteLLM's OpenAI-compatible URL as the worker sees it. */
  modelBaseUrl: string;
}

const SIM_FIELDS = ['persona', 'hidden_facts', 'concerns', 'goal', 'opening_message', 'max_client_turns'] as const;

/**
 * A task's optional `required_tools` (a grader primitive), copied into the spec only when the
 * task sets it: the runner's checks.json records which were called (docs/adapter-contract.md
 * section 12). The catalogue has already checked it is a list of finance tool names.
 */
function requiredTools(body: JsonObject): { required_tools?: string[] } {
  const list = body.required_tools;
  if (!Array.isArray(list)) return {};
  return { required_tools: list.filter((t): t is string => typeof t === 'string') };
}

/**
 * A complete contract v2 spec (contract/v2/spec.schema.json) for one trial attempt.
 * The task's client_sim gets the experiment's simulator model, held identical across every
 * config in the experiment (D22), and the summary of the task's client file (D27).
 */
export function buildSpec(i: SpecInputs): JsonObject {
  const taskSim = i.task.body.client_sim;
  let clientSim: JsonObject | null = null;
  if (taskSim && typeof taskSim === 'object' && !Array.isArray(taskSim)) {
    if (!i.sim) throw new Error(`task ${i.task.id} has a simulated client but the experiment has no simulator model`);
    const picked: JsonObject = {};
    for (const f of SIM_FIELDS) picked[f] = taskSim[f];
    if (i.task.clientSummary) picked.client_summary = i.task.clientSummary;
    clientSim = {
      ...picked,
      model: {
        name: i.sim.model,
        base_url: i.modelBaseUrl,
        api_key_env: SIM_KEY_ENV,
        temperature: i.sim.temperature,
        max_output_tokens: i.sim.maxOutputTokens,
        prompt: { id: i.sim.prompt.id, version: i.sim.prompt.version, sha256: bareHex(i.sim.prompt.sha256), text: i.sim.prompt.text },
      },
    };
  }
  return {
    contract_version: '2',
    trial: {
      id: i.trial.id,
      experiment_id: i.trial.experimentId,
      config_id: i.config.id,
      config_hash: i.config.hash,
      task_id: i.task.id,
      task_version: i.task.sha256,
      task_split: i.task.split,
      repeat_index: i.trial.repeatIndex,
      attempt: i.trial.attempt,
    },
    task: { messages: i.task.body.messages ?? [], client_sim: clientSim, ...requiredTools(i.task.body) },
    system_prompt: { id: i.prompt.id, version: i.prompt.version, sha256: bareHex(i.prompt.sha256), text: i.prompt.text },
    model: { name: i.config.model, base_url: i.modelBaseUrl, api_key_env: MODEL_KEY_ENV, api_format: i.config.apiFormat },
    settings: i.config.settings as unknown as JsonObject,
    settings_sources: i.config.settingsSources,
    harness_options: i.config.harnessOptions,
    tools: {
      toolset: { id: i.toolset.id, version: i.toolset.version, sha256: bareHex(i.toolset.sha256) },
      mcp_servers: i.toolset.servers.map((s) => ({
        name: s.name,
        command: [...FINANCE_MCP_COMMAND],
        allowed_tools: [...s.allowed_tools],
        tool_timeout_s: TOOL_TIMEOUT_S,
      })),
      enabled_builtins: [],
    },
    // Config-given state only, never anything a trial learned (R10.8).
    seed: {
      memory: [...i.config.seed.memory],
      skills: i.config.seed.skills.map((s) => ({ name: s.name, description: s.description, body: s.body })),
    },
  };
}
