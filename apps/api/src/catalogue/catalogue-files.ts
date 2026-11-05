import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { HarnessView, Json, JsonObject, PromptView, TaskSplit, ToolsetView } from '../contract';
import { GRADER_SEVERITIES } from '../contract';
import { hashCanonical, sha256Ref } from '../common/hashing';

/**
 * Reading the catalogue from files in git: harness capabilities, prompts, the built-in
 * toolset and tasks. Pure parsing lives here so it can be unit-tested without Nest.
 */

type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// ---- Harnesses -------------------------------------------------------------------------

/** `version` and `requires-python` from a pyproject.toml's [project] table. */
export function parsePyproject(text: string): { version: string | null; python: string | null } {
  const start = text.search(/^\[project\]\s*$/m);
  if (start === -1) return { version: null, python: null };
  const rest = text.slice(start + '[project]'.length);
  const next = rest.search(/^\[/m);
  const table = next === -1 ? rest : rest.slice(0, next);
  const field = (name: string): string | null => {
    const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(table);
    return m ? m[1] : null;
  };
  return { version: field('version'), python: field('requires-python') };
}

export interface HarnessFile extends HarnessView {
  /** The worker folder, e.g. workers/openai-agents. */
  dir: string;
}

/** One entry per workers/<dir>/src/<pkg>/capabilities.json. */
export async function readHarnesses(workersDir: string): Promise<HarnessFile[]> {
  const out: HarnessFile[] = [];
  for (const dir of await listDir(workersDir)) {
    const src = path.join(workersDir, dir, 'src');
    for (const pkg of await listDir(src)) {
      const file = path.join(src, pkg, 'capabilities.json');
      let raw: Buffer;
      try {
        raw = await fs.readFile(file);
      } catch {
        continue;
      }
      let caps: unknown;
      try {
        caps = JSON.parse(raw.toString('utf8'));
      } catch {
        continue;
      }
      if (!isObject(caps) || typeof caps.harness !== 'string' || !isObject(caps.version) || !isObject(caps.settings)) continue;
      let pyproject = { version: null as string | null, python: null as string | null };
      try {
        pyproject = parsePyproject(await fs.readFile(path.join(workersDir, dir, 'pyproject.toml'), 'utf8'));
      } catch {
        // no pyproject: version unknown
      }
      out.push({
        name: caps.harness,
        package: typeof caps.version.package === 'string' ? caps.version.package : '',
        ref: typeof caps.version.ref === 'string' ? caps.version.ref : '',
        python: pyproject.python,
        adapter_version: pyproject.version ?? 'unknown',
        capabilities_sha256: sha256Ref(raw),
        capabilities: caps as JsonObject,
        dir: path.join('workers', dir),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Prompts ---------------------------------------------------------------------------

/** A prompt file's text without its leading `<!-- -->` review header (as gate.prompt_text). */
export function promptText(raw: string): string {
  let text = raw;
  if (text.startsWith('<!--')) {
    const end = text.indexOf('-->');
    if (end !== -1) text = text.slice(end + 3);
  }
  return text.trim() + '\n';
}

/** `finance-advisor.v1.md` to id `finance-advisor`, version `v1`. */
export function parsePromptName(name: string): { id: string; version: string } | null {
  const m = /^(.+)\.([^.]+)\.md$/.exec(name);
  return m ? { id: m[1], version: m[2] } : null;
}

export async function readPrompts(configsDir: string): Promise<PromptView[]> {
  const dir = path.join(configsDir, 'prompts');
  const out: PromptView[] = [];
  for (const name of await listDir(dir)) {
    const parsed = parsePromptName(name);
    if (!parsed) continue;
    const text = promptText(await fs.readFile(path.join(dir, name), 'utf8'));
    out.push({ ...parsed, sha256: sha256Ref(text), path: `configs/prompts/${name}`, text });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(a.version, b.version));
}

/** A prompt id or version safe to put in a file name: no dots, slashes or other separators. */
export const PROMPT_NAME_PART = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** POST /prompts' limit on the text, in UTF-8 bytes. */
export const PROMPT_MAX_BYTES = 50 * 1024;

/** `v<highest numbered version + 1>`; versions that are not `v<n>` are not counted. */
export function nextPromptVersion(versions: string[]): string {
  const numbers = versions.map((v) => /^v(\d+)$/.exec(v)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  return `v${Math.max(0, ...numbers) + 1}`;
}

/** `4 Nov 2026`, the date style of the prompt files' review headers, in UTC. */
export function headerDate(when: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${when.getUTCDate()} ${months[when.getUTCMonth()]} ${when.getUTCFullYear()}`;
}

/**
 * A new prompt version's file: a review header in the style of the existing files, then the text.
 * `promptText` of the result is the text trimmed, with one final newline.
 */
export function promptFile(id: string, version: string, baseVersion: string, text: string, when: Date): string {
  return (
    '<!--\n' +
    `${id} ${version}, created from ${baseVersion} in the UI on ${headerDate(when)}.\n` +
    'This header comment is stripped before use. Once a run has used this version, changes go in\n' +
    'a new version file.\n' +
    '-->\n\n' +
    `${text.trim()}\n`
  );
}

/** Natural order, so v2 < v10. */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

// ---- Toolsets --------------------------------------------------------------------------

/**
 * The arithmetic tools, on the finance server since 5 Nov (D54, server 0.3.0): with them every
 * figure an answer gives can come from a tool result, so the agent never does its own sums.
 */
export const ARITHMETIC_TOOLS = ['add', 'subtract', 'multiply', 'divide', 'percent_of', 'percent_change', 'round'] as const;

/**
 * Documented Indian market assumptions with sources and dates, on the finance server since 5 Nov
 * (D58, server 0.4.0), so a rate an agent volunteers has a source and an invented one does not.
 */
export const REFERENCE_TOOLS = ['reference_rates'] as const;

/**
 * Every tool the finance MCP server has, in its order (services/finance-mcp/tests/snapshots/
 * tools_manifest.json). A unit test checks this list against that snapshot.
 */
export const FINANCE_TOOLS = [
  'calculate_emi',
  'amortization_schedule',
  'prepayment_impact',
  'debt_payoff_plan',
  'sip_future_value',
  'fd_maturity',
  'inflation_adjusted_value',
  'loan_affordability',
  'get_client_profile',
  'list_debts',
  'list_transactions',
  ...ARITHMETIC_TOOLS,
  ...REFERENCE_TOOLS,
] as const;

/**
 * The eight calculators, each a loan's, a deposit's or an investment's sum in one call, in the
 * server's order. D70's positive control removes all eight (`finance-no-calculators`).
 */
export const CALCULATOR_TOOLS = [
  'calculate_emi',
  'amortization_schedule',
  'prepayment_impact',
  'debt_payoff_plan',
  'sip_future_value',
  'fd_maturity',
  'inflation_adjusted_value',
  'loan_affordability',
] as const;

/**
 * The built-in toolsets' version (`finance`'s, which `finance-no-calculators` shares, since both
 * are cut from the same server; see BUILT_IN_TOOLSETS). A change to its tools (a tool added or removed, a description
 * or schema edited, a new server version) is a new version here, never an edit of the old one in
 * place, and a unit test pins the hash of each so an unlabelled change fails it.
 *
 * - `all` (4 Nov to 5 Nov): the eleven finance tools, last at server 0.2.0. It is not listed any
 *   more, because today's server is 0.3.0, so its hash cannot be made again. Configs and trials
 *   that used it keep their toolset row, its manifest and its hash.
 * - `v2` (5 Nov, D54): the eleven plus the seven arithmetic tools, at server 0.3.0. Not listed
 *   since v3, for the same reason as `all`; what recorded it keeps it.
 * - `v3` (5 Nov, D58): v2's eighteen plus `reference_rates`, at server 0.4.1 (six rates approved
 *   by Rishi; it was 0.4.0, with a seventh, before any run used it, so v3 was re-pinned). The rates' values
 *   are pinned to the server version (services/finance-mcp/tests/test_reference.py), so a
 *   changed value is a new server version and so a new toolset version here.
 */
export const FINANCE_TOOLSET_VERSION = 'v3';

/** One tool as the server publishes it: what a model is shown. */
export interface PublishedTool {
  name: string;
  description: string | null;
  input_schema: Json;
}

/** The finance MCP server as its tools are published: its version and every tool. */
export interface FinanceServerManifest {
  version: string;
  tools: PublishedTool[];
}

/** The server's tool list, which its tests keep equal to what it serves (test_tools_manifest_snapshot). */
export const FINANCE_MANIFEST_FILE = path.join('tests', 'snapshots', 'tools_manifest.json');
/** The server's own version, which it reports in the MCP handshake (serverInfo.version). */
export const FINANCE_VERSION_FILE = path.join('src', 'finance_mcp', '__init__.py');

/**
 * Reads the finance MCP server's published manifest and version from its folder
 * (services/finance-mcp, or FINANCE_MCP_DIR in compose). Throws when either is missing or
 * unreadable: a toolset whose tools are unknown must not get a hash.
 */
export function loadFinanceServer(dir: string): FinanceServerManifest {
  const raw = JSON.parse(readFileSync(path.join(dir, FINANCE_MANIFEST_FILE), 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${FINANCE_MANIFEST_FILE} is not a list of tools`);
  const tools = raw.map((t, i): PublishedTool => {
    if (!isObject(t) || typeof t.name !== 'string' || !isObject(t.inputSchema)) {
      throw new Error(`${FINANCE_MANIFEST_FILE}[${i}] is not a tool with a name and an inputSchema`);
    }
    return { name: t.name, description: typeof t.description === 'string' ? t.description : null, input_schema: t.inputSchema as Json };
  });
  const init = readFileSync(path.join(dir, FINANCE_VERSION_FILE), 'utf8');
  const version = /^__version__\s*=\s*["']([^"']+)["']/m.exec(init)?.[1];
  if (!version) throw new Error(`no __version__ in ${FINANCE_VERSION_FILE}`);
  return { version, tools };
}

/** A built-in toolset: which of the finance server's tools a config with it gives the model. */
interface BuiltInToolset {
  id: string;
  version: string;
  description: string;
  validation_only: boolean;
  allowed: readonly string[];
}

/**
 * The built-in toolsets, in the order GET /toolsets lists them. The first is the default for a
 * new config and the builder's choice, so a toolset made to test the platform goes after it,
 * says so (`validation_only`), and neither default picks it.
 *
 * - `finance` at FINANCE_TOOLSET_VERSION: every finance tool.
 * - `finance-no-calculators` (5 Nov, D70): the same server and version with the eight
 *   calculators left out, as if the calculator service were down; the client data, arithmetic
 *   and reference-rate tools stay (11 tools). It is for the positive control, the run whose
 *   effect is known in advance, not for comparing agents. Its version follows `finance`'s, since
 *   both are cut from the same server: a new server version is a new version of both, and a new
 *   pinned hash for each.
 */
const BUILT_IN_TOOLSETS: BuiltInToolset[] = [
  {
    id: 'finance',
    version: FINANCE_TOOLSET_VERSION,
    description: 'Every finance tool: the eight calculators, the client data, the arithmetic tools and the reference rates.',
    validation_only: false,
    allowed: FINANCE_TOOLS,
  },
  {
    id: 'finance-no-calculators',
    version: FINANCE_TOOLSET_VERSION,
    description:
      'Validation only (D70, the positive control): finance with its eight calculators removed, as if the calculator service were down. The client data, arithmetic and reference-rate tools stay.',
    validation_only: true,
    allowed: FINANCE_TOOLS.filter((t) => !(CALCULATOR_TOOLS as readonly string[]).includes(t)),
  },
];

/**
 * The built-in toolsets (BUILT_IN_TOOLSETS), each read from the finance server's published
 * manifest. A toolset's sha256 covers its id, version and allowed list and the full published
 * manifest of the tools it allows, not just the names: each tool's name, description and input
 * schema, and the server's version, as canonical JSON. So a schema change (sip_future_value's
 * lump_sum, 4 Nov) or a new server version is a new toolset, and a past result points at the
 * exact tools its model was shown. Before 4 Nov the hash covered the names only. `description`
 * and `validation_only` are words for people, outside the hash: they change nothing a model sees.
 */
export function builtInToolsets(server: FinanceServerManifest): ToolsetView[] {
  const byName = new Map(server.tools.map((t) => [t.name, t]));
  const missing = FINANCE_TOOLS.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`the finance server's manifest has no ${missing.join(', ')}`);
  return BUILT_IN_TOOLSETS.map(({ id, version, description, validation_only, allowed }) => {
    const manifest = [{ server: 'finance', server_version: server.version, tools: allowed.map((n) => byName.get(n) as PublishedTool) }];
    const content = { id, version, servers: [{ name: 'finance', allowed_tools: [...allowed] }], manifest };
    return { ...content, sha256: hashCanonical(content), description, validation_only };
  });
}

/** What a toolset's sha256 covers: every field but the hash and the words for people. */
export function toolsetContent(t: ToolsetView): Pick<ToolsetView, 'id' | 'version' | 'servers' | 'manifest'> {
  return { id: t.id, version: t.version, servers: t.servers, manifest: t.manifest };
}

// ---- Tasks -----------------------------------------------------------------------------

export interface TaskFile {
  sha256: string;
  id: string;
  version: string;
  split: TaskSplit;
  kind: string;
  summary: string;
  graders: Json[];
  body: JsonObject;
  clientStateName: string | null;
  clientState: Buffer | null;
  clientStateSha256: string | null;
  sourcePath: string;
  problems: string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SIM_FIELDS = ['persona', 'hidden_facts', 'concerns', 'goal', 'opening_message', 'max_client_turns'] as const;

/** Checks the minimum the engine reads (docs/api-contract.md, "Task file"). */
export function checkTask(task: unknown): string[] {
  if (!isObject(task)) return ['task.json is not a JSON object'];
  const problems: string[] = [];
  if (typeof task.id !== 'string' || !ID.test(task.id) || task.id.length > 128) problems.push('id must be a string of letters, digits and _.:-');
  if (typeof task.version !== 'string' || task.version === '') problems.push('version must be a non-empty string');
  if (task.split !== 'discovery' && task.split !== 'held_out') problems.push('split must be "discovery" or "held_out"');
  const msgs = task.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    problems.push('messages must be a non-empty list');
  } else {
    msgs.forEach((m, i) => {
      if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        problems.push(`messages[${i}] must be {role: "user"|"assistant", content: string}`);
      }
    });
    const last: unknown = msgs[msgs.length - 1];
    if (isObject(last) && last.role !== 'user') problems.push('the last message must be the user\'s');
  }
  const sim = task.client_sim;
  if (sim !== undefined && sim !== null) {
    if (!isObject(sim)) {
      problems.push('client_sim must be an object or null');
    } else {
      for (const f of SIM_FIELDS) if (!(f in sim)) problems.push(`client_sim.${f} is missing`);
      if ('model' in sim) problems.push('client_sim.model must not be set: the experiment supplies the simulator model');
      const turns = sim.max_client_turns;
      if (turns !== undefined && (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1 || turns > 10)) {
        problems.push('client_sim.max_client_turns must be an integer from 1 to 10');
      }
    }
  }
  const state = task.client_state;
  if (state !== undefined && state !== null && (typeof state !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(state))) {
    problems.push('client_state must be a file name next to task.json');
  }
  if (task.graders !== undefined && !Array.isArray(task.graders)) problems.push('graders must be a list');
  // D10: a grader's severity feeds the comparison's critical-failure guardrail, so a misspelt one
  // must not quietly leave a critical check unrated. The grader framework checks the rest of a spec.
  if (Array.isArray(task.graders)) {
    task.graders.forEach((g, i) => {
      if (isObject(g) && g.severity !== undefined && !(GRADER_SEVERITIES as readonly unknown[]).includes(g.severity)) {
        problems.push(`graders[${i}].severity must be one of ${GRADER_SEVERITIES.join(', ')}`);
      }
    });
  }
  const required = task.required_tools;
  if (required !== undefined) {
    const known: readonly string[] = FINANCE_TOOLS;
    if (!Array.isArray(required) || required.some((t) => typeof t !== 'string' || !known.includes(t))) {
      problems.push(`required_tools must be a list of finance tool names (${FINANCE_TOOLS.join(', ')})`);
    } else if (new Set(required).size !== required.length) {
      problems.push('required_tools must not repeat a tool');
    }
  }
  return problems;
}

function firstText(task: Obj): string {
  const msgs = Array.isArray(task.messages) ? task.messages : [];
  const first: unknown = msgs[0];
  const text = isObject(first) && typeof first.content === 'string' ? first.content : '';
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Every tasks/<dir>/task.json. A task with problems is still listed, with its problems. */
export async function readTasks(tasksDir: string): Promise<TaskFile[]> {
  const out: TaskFile[] = [];
  for (const dir of await listDir(tasksDir)) {
    const folder = path.join(tasksDir, dir);
    if (!(await isDir(folder))) continue;
    let raw: Buffer;
    try {
      raw = await fs.readFile(path.join(folder, 'task.json'));
    } catch {
      continue;
    }
    let parsed: unknown;
    const problems: string[] = [];
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      problems.push(`task.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    problems.push(...(parsed === undefined ? [] : checkTask(parsed)));
    const task: Obj = isObject(parsed) ? parsed : {};
    let clientState: Buffer | null = null;
    const stateName = typeof task.client_state === 'string' ? task.client_state : null;
    if (stateName && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(stateName)) {
      try {
        clientState = await fs.readFile(path.join(folder, stateName));
      } catch {
        problems.push(`client_state ${stateName} is not next to task.json`);
      }
    }
    const hasSim = isObject(task.client_sim);
    out.push({
      sha256: sha256Ref(raw),
      id: typeof task.id === 'string' ? task.id : dir,
      version: typeof task.version === 'string' ? task.version : '',
      split: task.split === 'held_out' ? 'held_out' : 'discovery',
      kind: typeof task.kind === 'string' ? task.kind : hasSim ? 'conversation' : 'single_prompt',
      summary: typeof task.summary === 'string' ? task.summary : firstText(task),
      graders: Array.isArray(task.graders) ? (task.graders as Json[]) : [],
      body: task as JsonObject,
      clientStateName: stateName,
      clientState,
      clientStateSha256: clientState ? sha256Ref(clientState) : null,
      sourcePath: `tasks/${dir}/task.json`,
      problems,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(a.version, b.version));
}
