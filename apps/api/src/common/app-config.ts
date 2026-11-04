import * as path from 'node:path';

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
  /** Recorded on every experiment; null when unset. */
  platformCommit: string | null;
  workersDir: string;
  configsDir: string;
  tasksDir: string;
  labelsDir: string;
  /** Shipped examples (examples/<name>/manifest.json), loaded on request; read-only. */
  examplesDir: string;
  runsDir: string;
  /** The finance MCP server's folder: its published tool manifest and version give the toolset's hash. */
  financeMcpDir: string;
  /** D38: the standing allowance for pre-run conflict checks, in USD. */
  conflictCheckAllowanceUsd: number;
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
    workersDir: dir('WORKERS_DIR', 'workers'),
    configsDir: dir('CONFIGS_DIR', 'configs'),
    tasksDir: dir('TASKS_DIR', 'tasks'),
    labelsDir: dir('LABELS_DIR', 'labels'),
    examplesDir: dir('EXAMPLES_DIR', 'examples'),
    financeMcpDir: dir('FINANCE_MCP_DIR', 'services/finance-mcp'),
    // RUNS_DIR keeps its SP1 meaning: relative to the working directory.
    runsDir: path.resolve(nonEmpty(env.RUNS_DIR) ?? 'runs'),
    conflictCheckAllowanceUsd: usd('EVALS_CONFLICT_CHECK_ALLOWANCE_USD', env.EVALS_CONFLICT_CHECK_ALLOWANCE_USD, DEFAULT_CONFLICT_CHECK_ALLOWANCE_USD),
  };
}
