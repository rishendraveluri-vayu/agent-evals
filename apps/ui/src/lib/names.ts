/** Words for the identifiers the API uses: harnesses, models, settings, splits and graders. */
import type { ConfigView, Json, SettingName, TaskView } from '../api/types';
import { shortHash } from './format';

const HARNESS_NAMES: Record<string, string> = {
  hermes: 'Hermes Agent',
  ownloop: 'Own loop',
  langgraph: 'LangGraph',
  adk: 'Google ADK',
  'openai-agents': 'OpenAI Agents SDK',
};

const HARNESS_SHORT: Record<string, string> = { hermes: 'Hermes', adk: 'ADK' };

export function harnessName(name: string): string {
  return HARNESS_NAMES[name] ?? name;
}

/** "Hermes" in running text, "Hermes Agent" in headings. */
export function harnessShort(name: string): string {
  return HARNESS_SHORT[name] ?? harnessName(name);
}

/** claude-haiku-5-5 → Claude Haiku 5.5; gemini-3.8-flash → Gemini 3.8 Flash; a fake model
 *  says so plainly: fake/finance-emi → Fake model finance-emi. */
export function modelName(name: string): string {
  if (name.startsWith('fake/')) return `Fake model ${name.slice(5)}`;
  const parts = name.split(/[-/]/).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(part) && prev !== undefined && /\d$/.test(prev)) out[out.length - 1] = `${prev}.${part}`;
    else out.push(/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1));
  }
  return out.join(' ');
}

export const SETTING_LABELS: Record<SettingName, string> = {
  temperature: 'Temperature',
  max_output_tokens: 'Max output tokens',
  max_steps: 'Max steps',
  timeout_s: 'Timeout',
  parallel_tool_calls: 'Parallel tool calls',
  memory: 'Memory',
  skills: 'Skills',
  compression: 'Compression',
};

export function settingLabel(name: string): string {
  if (name in SETTING_LABELS) return SETTING_LABELS[name as SettingName];
  const words = name.replace(/_/g, ' ');
  return words[0].toUpperCase() + words.slice(1);
}

export const BOOLEAN_SETTINGS: SettingName[] = ['parallel_tool_calls', 'memory', 'skills', 'compression'];

export function splitName(split: string): string {
  if (split === 'heldout' || split === 'held-out' || split === 'held_out') return 'held-out';
  return split;
}

export function graderName(kind: string | undefined): string {
  switch (kind) {
    case 'exact':
      return 'Exact match';
    case 'unit':
      return 'Unit test';
    case 'state':
      return 'State check';
    case 'judge':
      return 'Judge';
    default:
      return kind ?? 'Unknown';
  }
}

/** A task's grader kinds. The grader format is SP4's, so `graders` is loose JSON in the contract:
 *  each entry's `kind` (or `type`) is read, and anything else counts as unknown. */
export function graderKinds(graders: Json[]): string[] {
  const kind = (g: Json) => {
    if (typeof g !== 'object' || g === null || Array.isArray(g)) return 'unknown';
    return typeof g.kind === 'string' ? g.kind : typeof g.type === 'string' ? g.type : 'unknown';
  };
  return [...new Set(graders.map(kind))];
}

/** "Judge and state check" */
export function gradedBy(task: TaskView | undefined): string {
  if (!task || !task.graders.length) return 'Not set';
  const names = graderKinds(task.graders).map(graderName);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1].toLowerCase()}`;
}

export function isJudged(task: TaskView | undefined): boolean {
  return !!task && graderKinds(task.graders).includes('judge');
}

/** A grader in running text, with its article: "a state check", "an exact match". */
export function graderPhrase(kind: string): string {
  const name = graderName(kind).toLowerCase();
  return `${kind === 'exact' ? 'an' : 'a'} ${name}`;
}

/** A task's id and its code graders, for "debt-hardship-03 also has a state check": every grader
 *  but the judge. Null for an unknown task. */
export function alsoGradedBy(task: TaskView | undefined): { name: string; graders: string[] } | null {
  if (!task) return null;
  return { name: task.id, graders: graderKinds(task.graders).filter((k) => k !== 'judge').map(graderPhrase) };
}

export function clientKind(kind: string): string {
  if (kind === 'single' || kind === 'single_prompt' || kind === 'prompt') return 'Single prompt';
  if (kind === 'conversation' || kind === 'multi_turn' || kind === 'simulated') return 'Conversation';
  return kind;
}

export function promptName(config: Pick<ConfigView, 'prompt'>): string {
  return `${config.prompt.id} ${config.prompt.version}`;
}

export function configName(hash: string): string {
  return `config ${shortHash(hash)}`;
}

/** Infra labels in words: infra:provider_error → provider error. */
export function infraReason(label: string | null | undefined): string {
  if (!label?.startsWith('infra:')) return '';
  const reasons: Record<string, string> = {
    'infra:provider_error': 'provider error',
    'infra:budget_net': 'budget safety net',
    'infra:adapter_crash': 'adapter crash',
    'infra:timeout_kill': 'killed at the timeout',
    'infra:config_error': 'config error, the setup was refused',
    'infra:sim_error': 'the simulated client failed',
  };
  return reasons[label] ?? label.slice(6).replace(/_/g, ' ');
}

export function endStateName(state: string | null | undefined): string {
  switch (state) {
    case 'answered':
      return 'Agent answered';
    case 'step_limit':
      return 'Hit the step limit';
    case 'token_limit':
      return 'Hit the token limit';
    case 'timeout':
      return 'Timed out';
    case 'agent_error':
      return 'Agent error';
    case 'harness_error':
      return 'Harness error';
    default:
      return state ?? 'No result';
  }
}
