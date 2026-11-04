import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HarnessView, Json, JsonObject, PromptView, TaskSplit, ToolsetView } from '../contract';
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
 * Every tool the finance MCP server has (services/finance-mcp/tests/snapshots/
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
] as const;

/** The one built-in toolset until more exist: every finance tool. */
export function builtInToolsets(): ToolsetView[] {
  const content = { id: 'finance', version: 'all', servers: [{ name: 'finance', allowed_tools: [...FINANCE_TOOLS] }] };
  return [{ ...content, sha256: hashCanonical(content) }];
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
