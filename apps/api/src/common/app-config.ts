import * as path from 'node:path';
import { GRADER_SCHEMA_FILE } from '../catalogue/catalogue-files';

/**
 * Settings read from the environment once, at startup. Paths default to the repo layout, so
 * `pnpm dev` from apps/api works; compose sets them to the read-only mounts.
 */
export interface AppConfig {
  /** LiteLLM's base URL, without /v1. The API and the workers both reach it here. */
  litellmUrl: string | null;
  /** Only the API holds this (docs/api-contract.md, "Who holds which secret"). */
  litellmMasterKey: string | null;
  /** Workers send it as `Authorization: Bearer`. */
  workerToken: string | null;
  /**
   * EVALS_PLATFORM_COMMIT: recorded on every experiment as given, when set. When it is not, the
   * API reads the checkout's HEAD from `gitDir` each time an experiment is created (git-commit.ts).
   */
  platformCommit: string | null;
  /** The checkout's `.git` (EVALS_GIT_DIR; compose mounts the repo's read-only at /repo/.git). */
  gitDir: string;
  workersDir: string;
  configsDir: string;
  tasksDir: string;
  labelsDir: string;
  /** Shipped examples (examples/<name>/manifest.json), loaded on request; read-only. */
  examplesDir: string;
  runsDir: string;
  /** The finance MCP server's folder: its published tool manifest and version give the toolset's hash. */
  financeMcpDir: string;
  /**
   * The grader framework's schema for a grader spec (graders/src/evals_graders/grader-spec.schema.json),
   * which the catalogue checks every task's graders against. The API image copies it to the same
   * path under /repo, so the default holds in compose too.
   */
  graderSchemaFile: string;
  /** D38: the standing allowance for pre-run conflict checks, in USD. */
  conflictCheckAllowanceUsd: number;
  /** D75: the model every conflict check runs on (EVALS_CONFLICT_CHECK_MODEL); null: chosen per config (chooseCheckerModel). */
  conflictCheckModel: string | null;
  /**
   * Whether each provider's key is set for LiteLLM, by provider: compose passes a flag
   * (`ANTHROPIC_KEY_SET: ${ANTHROPIC_API_KEY:+1}`), never the key, which only LiteLLM holds.
   * null when the flag is absent: the API was not told (run outside compose).
   */
  providerKeys: Record<ProviderKeyName, boolean | null>;
}

/** The providers whose key the API is told about, each with the variable .env sets for LiteLLM. */
export const PROVIDER_KEYS = {
  anthropic: { flag: 'ANTHROPIC_KEY_SET', key: 'ANTHROPIC_API_KEY' },
  gemini: { flag: 'GEMINI_KEY_SET', key: 'GEMINI_API_KEY' },
} as const;
export type ProviderKeyName = keyof typeof PROVIDER_KEYS;

/** A set/unset flag: "1" (or any non-empty value) is set, empty is not, absent is unknown. */
function flag(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  return raw.trim() !== '';
}

/** D38's standing allowance when EVALS_CONFLICT_CHECK_ALLOWANCE_USD is unset. */
export const DEFAULT_CONFLICT_CHECK_ALLOWANCE_USD = 2;

/** A non-negative amount of USD, or the default when unset. A bad value stops the API at startup. */
function usd(name: string, raw: string | undefined, fallback: number): number {
  const text = nonEmpty(raw);
  if (text === null) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of USD, got "${text}"`);
  return value;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** The repo root: apps/api/{src,dist}/common/ is four levels down. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dir = (name: string, fallback: string): string => path.resolve(nonEmpty(env[name]) ?? path.join(REPO_ROOT, fallback));
  return {
    litellmUrl: nonEmpty(env.LITELLM_URL)?.replace(/\/+$/, '') ?? null,
    litellmMasterKey: nonEmpty(env.LITELLM_MASTER_KEY),
    workerToken: nonEmpty(env.EVALS_WORKER_TOKEN),
    platformCommit: nonEmpty(env.EVALS_PLATFORM_COMMIT),
    gitDir: dir('EVALS_GIT_DIR', '.git'),
    workersDir: dir('WORKERS_DIR', 'workers'),
    configsDir: dir('CONFIGS_DIR', 'configs'),
    tasksDir: dir('TASKS_DIR', 'tasks'),
    labelsDir: dir('LABELS_DIR', 'labels'),
    examplesDir: dir('EXAMPLES_DIR', 'examples'),
    financeMcpDir: dir('FINANCE_MCP_DIR', 'services/finance-mcp'),
    graderSchemaFile: dir('GRADER_SCHEMA_FILE', GRADER_SCHEMA_FILE),
    // RUNS_DIR keeps its SP1 meaning: relative to the working directory.
    runsDir: path.resolve(nonEmpty(env.RUNS_DIR) ?? 'runs'),
    conflictCheckAllowanceUsd: usd('EVALS_CONFLICT_CHECK_ALLOWANCE_USD', env.EVALS_CONFLICT_CHECK_ALLOWANCE_USD, DEFAULT_CONFLICT_CHECK_ALLOWANCE_USD),
    conflictCheckModel: nonEmpty(env.EVALS_CONFLICT_CHECK_MODEL),
    providerKeys: { anthropic: flag(env[PROVIDER_KEYS.anthropic.flag]), gemini: flag(env[PROVIDER_KEYS.gemini.flag]) },
  };
}
