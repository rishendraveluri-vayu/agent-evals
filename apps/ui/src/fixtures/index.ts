/**
 * Fixture mode: answers the client's calls from the JSON in this folder, sample data in the
 * shapes of apps/api/src/contract.ts (scripts/make-fixtures.mjs writes it). Writes such as a new
 * config or experiment live in memory for the session only; a label is checked and then
 * dropped, never stored, because labels are Rishi's own judgments. Nothing here calls a model:
 * a conflict check answers with the stored result, or says there is none.
 */
import { ApiError } from '../api/errors';
import type {
  Compare,
  ConfigDetail,
  ConfigDiffEntry,
  ConfigView,
  ConflictCheckView,
  CreatedPrompt,
  CreateConfigRequest,
  CreatePromptRequest,
  CreateExperimentRequest,
  CreateLabelRequest,
  EstimateRequest,
  EstimateResponse,
  ExampleView,
  ExperimentDetail,
  ExperimentStatus,
  ExperimentSummary,
  Harness,
  JudgeApprovalRequest,
  JudgeApprovalResponse,
  JudgeView,
  LoadExampleResponse,
  ModelView,
  PromptView,
  RegradeResponse,
  RenderedPromptView,
  SettingName,
  StartExperimentRequest,
  TaskView,
  TrialRowSummary,
} from '../api/types';
import comparesJson from './compares.json';
import configDetailsJson from './config-details.json';
import configsJson from './configs.json';
import conflictChecksJson from './conflict-checks.json';
import experimentDetailsJson from './experiment-details.json';
import experimentTrialsJson from './experiment-trials.json';
import experimentsJson from './experiments.json';
import harnessesJson from './harnesses.json';
import judgeJson from './judge-agreement.json';
import labelQueueJson from './label-queue.json';
import metaJson from './meta.json';
import modelsJson from './models.json';
import promptsJson from './prompts.json';
import recordedTrialJson from './recorded-trial.json';
import recordedTrialSpansJson from './recorded-trial-spans.json';
import recordedTrialsJson from './recorded-trials.json';
import renderedPromptsJson from './rendered-prompts.json';
import spendJson from './spend.json';
import systemSpendJson from './system-spend.json';
import tasksJson from './tasks.json';
import toolsetsJson from './toolsets.json';
import trialChecksJson from './trial-checks.json';
import trialJson from './trial.json';
import trialSpansJson from './trial-spans.json';

export const meta = metaJson;

const harnesses = harnessesJson as unknown as Harness[];
const tasks = tasksJson as unknown as TaskView[];
const configs = configsJson as unknown as ConfigView[];
const configDetails = configDetailsJson as unknown as Record<string, ConfigDetail>;
const experiments = experimentsJson as unknown as ExperimentSummary[];
const details = experimentDetailsJson as unknown as Record<string, ExperimentDetail>;
const experimentTrials = experimentTrialsJson as unknown as Record<string, TrialRowSummary[]>;
const compares = comparesJson as unknown as Record<string, Compare>;
const labelQueue = labelQueueJson as unknown as Record<string, unknown[]>;
const renderedPrompts = renderedPromptsJson as unknown as Record<string, RenderedPromptView>;
const conflictChecks = conflictChecksJson as unknown as Record<string, ConflictCheckView>;
const trial = trialJson as unknown as { id: string };
const recordedTrial = recordedTrialJson as unknown as { summary: { trialId: string } };

/** Session-only writes. A judge approval here mints no key and calls no model. */
const created = { configs: [] as ConfigView[], experiments: new Map<string, ExperimentDetail>(), prompts: [] as PromptView[], judges: new Map<string, JudgeView>() };

/** Forgets this session's writes, as a reload does; for tests that must not see each other's. */
export function resetSession(): void {
  created.configs.length = 0;
  created.prompts.length = 0;
  created.experiments.clear();
  created.judges.clear();
}
const allPrompts = () => [...(promptsJson as PromptView[]), ...created.prompts];

/** POST /prompts by the API's rules: the next v<n> of an existing id; the same text returns its
 *  version and writes nothing. */
function createPrompt(body: CreatePromptRequest): CreatedPrompt {
  const versions = allPrompts().filter((p) => p.id === body.id);
  if (!versions.length) throw new ApiError(400, 'unknown_prompt_id', `no prompt ${body.id}`, 'Start from a prompt listed in GET /prompts.');
  if (!versions.some((p) => p.version === body.base_version)) throw new ApiError(400, 'unknown_base_version', `${body.base_version} is not a version of ${body.id}`, 'Pick the version you edited from.');
  const text = body.text.trim();
  if (!text) throw new ApiError(400, 'invalid_prompt', 'text is empty', 'Write the prompt text.');
  const same = versions.find((p) => p.text.trim() === text);
  if (same) return { id: same.id, version: same.version, sha256: same.sha256, path: same.path };
  const n = Math.max(...versions.map((p) => Number(/^v(\d+)$/.exec(p.version)?.[1] ?? 0))) + 1;
  const prompt: PromptView = { id: body.id, version: `v${n}`, sha256: sampleHash(`prompt:${text}`), path: `configs/prompts/${body.id}.v${n}.md`, text };
  created.prompts.push(prompt);
  return { id: prompt.id, version: prompt.version, sha256: prompt.sha256, path: prompt.path };
}

const clone = <T>(value: T): T => structuredClone(value);
const notFound = (what: string) => new ApiError(404, 'not_found', `No sample data for ${what}.`);

function allConfigs(): ConfigView[] {
  return [...configs, ...created.configs];
}

function findConfig(hash: string): ConfigView {
  const c = allConfigs().find((x) => x.hash === hash);
  if (!c) throw new ApiError(404, 'unknown_config', `no config ${hash}`);
  return c;
}

function experimentDetail(id: string): ExperimentDetail {
  const d = created.experiments.get(id) ?? details[id];
  if (!d) throw new ApiError(404, 'unknown_experiment', `no experiment ${id}`);
  return d;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Not a real sha256: a stable stand-in so the same content gets the same sample hash. */
function sampleHash(text: string): string {
  let h = 0x811c9dc5;
  let out = '';
  for (let round = 0; out.length < 64; round++) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i) ^ round, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return `sha256:${out.slice(0, 64)}`;
}

/** What the API refuses for a model (MODEL_REJECTS in apps/api/src/configs/settings.ts). */
const MODEL_REJECTS: Record<string, { label: string; rejects: SettingName[] }> = { 'claude-haiku-5-5': { label: 'Claude Haiku 5.5', rejects: ['temperature'] } };
const PLATFORM_DEFAULTS: Record<SettingName, unknown> = {
  temperature: null,
  max_output_tokens: 8192,
  max_steps: 15,
  timeout_s: 300,
  parallel_tool_calls: false,
  memory: { enabled: false },
  skills: { enabled: false },
  compression: { enabled: false },
};

/** POST /configs, by the API's rules: a setting the harness or the model refuses is a 400 with a fix. */
function createConfig(body: CreateConfigRequest): ConfigView {
  const harness = harnesses.find((h) => h.name === body.harness);
  if (!harness) throw new ApiError(400, 'unknown_harness', `no harness named ${body.harness} under workers/`, `Pick a harness from GET /harnesses: ${harnesses.map((h) => h.name).join(', ')}.`);
  const given = (body.settings ?? {}) as Record<string, unknown>;
  const rejected = MODEL_REJECTS[body.model];
  const settings: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const unsupported: Partial<Record<SettingName, string>> = {};
  for (const name of Object.keys(PLATFORM_DEFAULTS) as SettingName[]) {
    const cap = harness.capabilities.settings[name];
    const set = given[name] !== undefined && given[name] !== null;
    const refused = rejected?.rejects.includes(name) ?? false;
    if (set && !cap?.supported) {
      throw new ApiError(400, 'unsupported_setting', `${harness.name} does not support ${name}, so a config cannot set it`, `${harness.name} ignores ${name}: leave it unset.`);
    }
    if (set && refused && rejected) {
      throw new ApiError(400, 'unsupported_setting', `${rejected.label} (${body.model}) refuses ${name}. Leave ${name} unset for ${body.model}`, `${rejected.label} rejects ${name}: leave it unset, or pick a model that takes it.`);
    }
    if (!cap?.supported) {
      settings[name] = null;
      sources[name] = 'unsupported';
      unsupported[name] = `${harness.name} does not support ${name}${cap?.observed ? `: ${cap.observed}` : ''}`;
    } else if (set) {
      settings[name] = given[name];
      sources[name] = 'config';
    } else if (PLATFORM_DEFAULTS[name] === null || refused) {
      settings[name] = null;
      sources[name] = 'harness_default';
    } else {
      settings[name] = PLATFORM_DEFAULTS[name];
      sources[name] = 'platform_default';
    }
    if (refused && rejected) unsupported[name] = `${rejected.label} rejects ${name}, so it is not sent and the provider's default applies`;
  }
  const prompt = allPrompts().find((p) => p.sha256 === body.prompt_sha256);
  if (!prompt) throw new ApiError(400, 'unknown_prompt', `no prompt with ${body.prompt_sha256}; see GET /prompts`, 'Pick a prompt sha256 from GET /prompts.');
  const toolset = (toolsetsJson as { id: string; version: string; sha256: string }[]).find((t) => t.sha256 === body.toolset_sha256);
  if (!toolset) throw new ApiError(400, 'unknown_toolset', `no toolset with ${body.toolset_sha256}; see GET /toolsets`, 'Pick a toolset sha256 from GET /toolsets.');
  const content = canonical({ ref: harness.ref, model: body.model, prompt: prompt.sha256, toolset: toolset.sha256, settings, harness_options: body.harness_options ?? {}, seed: body.seed ?? null });
  const hash = sampleHash(content);
  const parent = body.parent_hash ? allConfigs().find((c) => c.hash === body.parent_hash) : null;
  if (body.parent_hash && !parent) throw new ApiError(400, 'unknown_parent', `no config ${body.parent_hash} to be the parent`, 'Fork from a config in GET /configs, or leave parent_hash out.');
  if (parent && parent.hash === hash) throw new ApiError(400, 'same_as_parent', 'this fork is identical to its parent', 'Change the one thing this fork is meant to test.');
  const existing = allConfigs().find((c) => c.hash === hash);
  if (existing) return existing;
  const config: ConfigView = {
    hash,
    name: body.name,
    seed: { memory: body.seed?.memory ?? [], skills: body.seed?.skills ?? [] },
    harness: harness.name,
    harness_ref: harness.ref,
    adapter_version: harness.adapter_version,
    capabilities_sha256: harness.capabilities_sha256,
    model: body.model,
    prompt: { id: prompt.id, version: prompt.version, sha256: prompt.sha256 },
    toolset: { id: toolset.id, version: toolset.version, sha256: toolset.sha256 },
    settings: settings as unknown as ConfigView['settings'],
    settings_sources: sources as ConfigView['settings_sources'],
    unsupported,
    warnings: [],
    harness_options: body.harness_options ?? {},
    parent_hash: parent?.hash ?? null,
    example_only: false,
    created_at: meta.now,
  };
  created.configs.push(config);
  return config;
}

function configDetail(hash: string): ConfigDetail {
  const c = findConfig(hash);
  const children = allConfigs()
    .filter((x) => x.parent_hash === c.hash)
    .map((x) => ({ hash: x.hash, name: x.name, created_at: x.created_at }));
  return { ...(configDetails[hash] ?? c), children };
}

function diffConfigs(a: ConfigView, b: ConfigView): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  const walk = (path: string, x: unknown, y: unknown) => {
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort()) walk(path ? `${path}.${k}` : k, (x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]);
    } else if (canonical(x) !== canonical(y)) {
      out.push({ path, a: (x ?? null) as ConfigDiffEntry['a'], b: (y ?? null) as ConfigDiffEntry['b'] });
    }
  };
  // As the API diffs (NOT_DIFFED in apps/api/src/configs/configs.service.ts): every field but the
  // derived ones and the lineage, so the name, capabilities_sha256 and settings_sources show too.
  const fields = (c: ConfigView) => {
    const rest: Partial<ConfigView> = { ...c };
    for (const key of ['hash', 'created_at', 'unsupported', 'warnings', 'parent_hash', 'example_only'] as const) delete rest[key];
    return rest;
  };
  walk('', fields(a), fields(b));
  return out;
}

function estimate(body: EstimateRequest): EstimateResponse {
  const arms = body.config_hashes.length;
  if (arms > 2) throw new ApiError(400, 'too_many_arms', `an experiment has one arm or two (D35), not ${arms}`, 'Run several A/B experiments against the same parent.');
  const trials = arms * body.task_sha256s.length * body.n;
  const scale = trials / 120;
  const round = (v: number) => Math.round(v * 100) / 100;
  const base = details.exp_heldout.estimate;
  return {
    ...base,
    trials,
    cost_usd: { expected: round(21.3 * scale), low: round(16 * scale), high: round(27 * scale) },
    minutes: Math.max(1, Math.round(38 * scale)),
    baseline: null,
  };
}

function createExperiment(body: CreateExperimentRequest): ExperimentDetail {
  const id = `exp_new_${created.experiments.size + 1}`;
  const est = estimate({ config_hashes: body.config_hashes, task_sha256s: body.task_sha256s, n: body.n, sim_model: body.sim_model });
  const hashes = body.config_hashes;
  const zero = { queued: 0, running: 0, done: 0, infra_failed: 0, abandoned: 0, cancelled: 0 };
  const detail: ExperimentDetail = {
    ...details.exp_heldout,
    id,
    name: body.name,
    axis: body.axis,
    status: 'created',
    config_hashes: hashes,
    task_sha256s: body.task_sha256s,
    n: body.n,
    counts: { ...zero, queued: est.trials, by_label: {}, done_by_end_state: {} },
    spend_usd: 0,
    estimate: est,
    budget_usd: body.budget_usd,
    created_at: meta.now,
    plan_commit: body.plan_commit ?? null,
    sim_model: body.sim_model ?? null,
    started_at: null,
    finished_at: null,
    paused_at: null,
    paused_reason: null,
    order_seed: body.order_seed ?? 1,
    parent_experiment_id: body.parent_experiment_id ?? null,
    baseline: null,
    actual: null,
    tasks: tasks.filter((t) => body.task_sha256s.includes(t.sha256)),
    configs: allConfigs().filter((c) => hashes.includes(c.hash)),
    arms: hashes.map((h, i) => ({
      arm: 'AB'[i],
      config_hash: h,
      config_name: allConfigs().find((c) => c.hash === h)?.name ?? h,
      status: 'not_started',
      paused_at: null,
      paused_reason: null,
      fix: null,
      counts: { ...zero, queued: est.trials / hashes.length },
      reused_from: null,
      reused_trials: 0,
    })),
    events: [{ at: meta.now, kind: 'created', trial_id: null, attempt: null, arm: null, config_hash: null, detail: `${hashes.length} configs x ${body.task_sha256s.length} tasks x N=${body.n}` }],
  };
  created.experiments.set(id, detail);
  return detail;
}

function trialsFor(id: string): TrialRowSummary[] {
  if (experimentTrials[id]) return experimentTrials[id];
  const d = created.experiments.get(id);
  if (!d) return [];
  const status = d.status === 'cancelled' ? 'cancelled' : 'queued';
  let order = 0;
  return d.tasks.flatMap((t) =>
    d.config_hashes.flatMap((c, arm) =>
      Array.from({ length: d.n }, (_, r) => ({
        id: `${id}_${t.id}_${arm}_${r + 1}`,
        experiment_id: id,
        task_sha256: t.sha256,
        task_id: t.id,
        config_hash: c,
        config_name: d.arms[arm]?.config_name ?? c,
        harness: d.configs.find((x) => x.hash === c)?.harness ?? '',
        model: d.configs.find((x) => x.hash === c)?.model ?? '',
        repeat_index: r,
        order_index: order++,
        arm: 'AB'[arm],
        attempt: 1,
        status,
        label: null,
        end_state: null,
        cost_usd: null,
        input_tokens: null,
        output_tokens: null,
        model_calls: null,
        wall_s: null,
        worker_id: null,
        claimed_at: null,
        finished_at: null,
        passed: null,
        grading: null,
      })),
    ),
  );
}

/** Run controls work on experiments made in this session; the sample ones are read-only, as
 *  their trials are recorded. */
function control(id: string, from: ExperimentStatus[], to: ExperimentStatus, kind: ExperimentDetail['events'][number]['kind'], detail: string): ExperimentDetail {
  const d = created.experiments.get(id);
  if (!d) {
    experimentDetail(id);
    throw new ApiError(409, 'sample_data', 'The sample experiments are read-only.', 'Create an experiment on the Run page to try the controls; in sample mode nothing actually runs.');
  }
  if (!from.includes(d.status)) throw new ApiError(409, d.status === 'created' ? 'experiment_not_started' : 'experiment_finished', `the experiment is ${d.status}`, 'Reload the page to see its state now.');
  d.status = to;
  if (to === 'paused') {
    d.paused_at = meta.now;
    d.paused_reason = detail;
  }
  d.arms = d.arms.map((a) => ({ ...a, status: to === 'cancelled' ? 'stopped' : a.status === 'not_started' ? 'active' : a.status }));
  d.events.unshift({ at: meta.now, kind, trial_id: null, attempt: null, arm: null, config_hash: null, detail });
  return d;
}

/** POST .../start with a plan commit, as the API does: set on an unstarted experiment only. */
function startExperiment(id: string, body: StartExperimentRequest | undefined): ExperimentDetail {
  const d = created.experiments.get(id);
  const commit = typeof body?.plan_commit === 'string' ? body.plan_commit.trim() : '';
  if (d && commit) {
    if (d.status !== 'created' && commit !== d.plan_commit) {
      throw new ApiError(409, 'plan_commit_locked', `experiment ${id} has started, so its plan commit is fixed`, 'Leave plan_commit out to resume it.');
    }
    if (d.status === 'created') d.plan_commit = commit;
  }
  return control(id, ['created', 'paused'], 'running', 'started', 'trials can be claimed. In sample mode nothing actually runs.');
}

/** POST .../discard: an experiment that never started is marked cancelled; nothing is deleted. */
function discardExperiment(id: string): ExperimentDetail {
  const d = created.experiments.get(id);
  if (d && d.status !== 'created') {
    throw new ApiError(409, d.status === 'done' || d.status === 'cancelled' ? 'experiment_finished' : 'experiment_started', `experiment ${id} is ${d.status}`, 'Stop it instead.');
  }
  return control(id, ['created'], 'cancelled', 'discarded', 'discarded before it started: nothing ran, and nothing was deleted');
}

function armControl(id: string, armKey: string, pause: boolean): ExperimentDetail {
  const d = created.experiments.get(id);
  if (!d) {
    experimentDetail(id);
    throw new ApiError(409, 'sample_data', 'The sample experiments are read-only.', 'Create an experiment on the Run page to try the controls; in sample mode nothing actually runs.');
  }
  const arm = d.arms.find((a) => a.arm === armKey || a.config_hash === armKey);
  if (!arm) throw new ApiError(404, 'unknown_arm', `no arm ${armKey} in ${id}`, 'Name an arm by its letter (A or B) or its config hash.');
  const detail = pause ? 'paused by hand: this arm claims nothing more; its running trials finish' : 'resumed: its queued trials can be claimed again';
  Object.assign(arm, pause ? { status: 'paused', paused_at: meta.now, paused_reason: detail, fix: `POST /experiments/${id}/arms/${arm.config_hash}/resume to continue it.` } : { status: 'active', paused_at: null, paused_reason: null, fix: null });
  d.events.unshift({ at: meta.now, kind: pause ? 'arm_paused' : 'arm_resumed', trial_id: null, attempt: null, arm: arm.arm, config_hash: arm.config_hash, detail });
  return d;
}

/** POST /experiments/:id/judge by the API's rules: a priced model LiteLLM serves, a budget above 0
 *  and at most 20, one active approval at a time. In sample mode nothing is minted or called. */
function approveJudge(id: string, body: JudgeApprovalRequest): JudgeApprovalResponse {
  experimentDetail(id);
  const b = (body ?? {}) as Partial<JudgeApprovalRequest>;
  if (typeof b.model !== 'string' || !b.model) throw new ApiError(400, 'invalid_judge', 'model is required', 'Name a model LiteLLM serves with a price.');
  if (typeof b.budget_usd !== 'number' || !(b.budget_usd > 0) || b.budget_usd > 20) {
    throw new ApiError(400, 'invalid_judge', 'budget_usd must be a number above 0 and at most 20', 'Give a budget in dollars, above 0 and at most 20.');
  }
  const priced = (modelsJson as ModelView[]).some((m) => m.name === b.model && m.input_per_mtok !== null) || b.model.startsWith('fake/');
  if (!priced) throw new ApiError(400, 'unknown_model', `LiteLLM serves no priced model ${b.model}`, 'Pick a model from GET /models.');
  if (created.judges.has(id)) throw new ApiError(409, 'judge_already_approved', `judging is already approved for ${id}`, 'Revoke it first, then approve again.');
  const approval = { model: b.model, budget_usd: b.budget_usd, spend_usd: 0, approved_at: meta.now };
  created.judges.set(id, approval);
  return { experiment_id: id, model: approval.model, budget_usd: approval.budget_usd, approved_at: approval.approved_at };
}

function revokeJudge(id: string) {
  experimentDetail(id);
  if (!created.judges.delete(id)) throw new ApiError(404, 'no_judge_approval', `judging is not approved for ${id}`, 'There is nothing to revoke.');
  return { experiment_id: id, revoked_at: meta.now };
}

/** POST /experiments/:id/regrade: counts what the API would queue; in sample mode nothing runs. */
function regrade(id: string): RegradeResponse {
  experimentDetail(id);
  const done = trialsFor(id).filter((t) => t.status === 'done').length;
  return { experiment_id: id, trials: done, queued: done, no_graders: 0, superseded: 0, from_trial_task: 0 };
}

function saveLabel(body: CreateLabelRequest) {
  const values = ['yes', 'no', 'unsure'];
  if (!body.item_id || !body.criterion || !values.includes(body.value)) {
    throw new ApiError(400, 'invalid_label', 'A label needs an item, a criterion and yes, no or unsure.');
  }
  // Deliberately not stored: in sample mode nothing is written to labels/.
  return { saved: false, reason: 'sample data' };
}

function renderedPrompt(hash: string): RenderedPromptView {
  findConfig(hash);
  return renderedPrompts[hash] ?? { config_hash: hash, status: 'none', probe: null, cached: false, error: null, rendered: null };
}

/** GET returns the stored check, or null when there is none (as the API does); POST in sample
 *  mode never calls a model either, so it answers with the stored check (cached) or refuses. */
function conflictCheck(hash: string, post: boolean): ConflictCheckView | null {
  const rendered = renderedPrompt(hash);
  if (rendered.status !== 'ready') {
    throw new ApiError(409, 'rendered_prompt_required', `config ${hash} has no rendered prompt yet`, 'Render the prompt first; the check reads it.');
  }
  const stored = conflictChecks[hash];
  if (stored) return { ...stored, cached: true };
  if (post) throw new ApiError(409, 'sample_data', 'Sample mode makes no model calls, so this check cannot run here.', 'Run the UI against the API to check a config; each check is a real, paid call.');
  return null;
}

/** Sample mode's shipped example: one of the sample experiments, already in place, so "See a
 *  finished example" opens its comparison. A live API answers from examples/<name>/. */
const sampleExamples: ExampleView[] = [
  {
    name: 'sample-prompt-heldout',
    title: 'Sample: prompt v1 vs v2 on the held-out tasks',
    description: 'One of the sample experiments, standing in for the example a live API loads from examples/.',
    experiment_id: 'exp_heldout',
    loaded: true,
    created_at: '2026-11-03T09:00:00.000Z',
    counts: { configs: 2, tasks: 0, trials: 0, spans: 0, grades: 0, files: 0 },
  },
];

function loadExample(name: string): LoadExampleResponse {
  const example = sampleExamples.find((e) => e.name === name);
  if (!example) throw new ApiError(404, 'unknown_example', `There is no example called ${name}.`);
  return { name, experiment_id: example.experiment_id, created: false };
}

type Handler = (match: RegExpExecArray, params: URLSearchParams, body: unknown) => unknown;
const id1 = (m: RegExpExecArray) => decodeURIComponent(m[1]);

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/harnesses$/, () => harnesses],
  ['GET', /^\/prompts$/, () => allPrompts()],
  ['POST', /^\/prompts$/, (_m, _p, body) => createPrompt(body as CreatePromptRequest)],
  ['GET', /^\/toolsets$/, () => toolsetsJson],
  ['GET', /^\/tasks$/, () => tasks],
  ['GET', /^\/models$/, () => modelsJson],
  ['GET', /^\/spend$/, () => spendJson],
  ['GET', /^\/spend\/system$/, (_m, p) => (systemSpendJson as { kind: string }[]).filter((r) => !p.get('kind') || r.kind === p.get('kind'))],
  ['GET', /^\/configs$/, () => allConfigs()],
  ['POST', /^\/configs$/, (_m, _p, body) => createConfig(body as CreateConfigRequest)],
  [
    'GET',
    /^\/configs\/([^/]+)\/diff\/([^/]+)$/,
    (m) => {
      const [a, b] = [m[1], m[2]].map((h) => findConfig(decodeURIComponent(h)));
      return diffConfigs(a, b);
    },
  ],
  ['GET', /^\/configs\/([^/]+)\/rendered-prompt$/, (m) => renderedPrompt(id1(m))],
  ['POST', /^\/configs\/([^/]+)\/rendered-prompt$/, (m) => renderedPrompt(id1(m))],
  ['GET', /^\/configs\/([^/]+)\/conflict-check$/, (m) => conflictCheck(id1(m), false)],
  ['POST', /^\/configs\/([^/]+)\/conflict-check$/, (m) => conflictCheck(id1(m), true)],
  ['GET', /^\/configs\/([^/]+)$/, (m) => configDetail(id1(m))],
  ['POST', /^\/experiments\/estimate$/, (_m, _p, body) => estimate(body as EstimateRequest)],
  ['POST', /^\/experiments$/, (_m, _p, body) => createExperiment(body as CreateExperimentRequest)],
  ['GET', /^\/experiments$/, () => [...created.experiments.values(), ...experiments]],
  ['POST', /^\/experiments\/([^/]+)\/start$/, (m, _p, body) => startExperiment(id1(m), body as StartExperimentRequest | undefined)],
  ['POST', /^\/experiments\/([^/]+)\/discard$/, (m) => discardExperiment(id1(m))],
  ['POST', /^\/experiments\/([^/]+)\/pause$/, (m) => control(id1(m), ['running', 'paused'], 'paused', 'paused', 'paused by hand: new claims stop; trials already running finish')],
  ['POST', /^\/experiments\/([^/]+)\/resume$/, (m) => control(id1(m), ['paused', 'running'], 'running', 'resumed', 'claims resume')],
  ['POST', /^\/experiments\/([^/]+)\/(?:stop|cancel)$/, (m) => control(id1(m), ['created', 'running', 'paused'], 'cancelled', 'cancelled', 'stopped: queued trials are cancelled; running ones finish and are kept')],
  ['POST', /^\/experiments\/([^/]+)\/arms\/([^/]+)\/pause$/, (m) => armControl(id1(m), decodeURIComponent(m[2]), true)],
  ['POST', /^\/experiments\/([^/]+)\/arms\/([^/]+)\/resume$/, (m) => armControl(id1(m), decodeURIComponent(m[2]), false)],
  [
    'GET',
    /^\/experiments\/([^/]+)\/trials$/,
    (m, p) =>
      trialsFor(id1(m)).filter(
        (t) => (!p.get('status') || t.status === p.get('status')) && (!p.get('config') || t.config_hash === p.get('config')) && (!p.get('task') || t.task_sha256 === p.get('task')),
      ),
  ],
  [
    'GET',
    /^\/experiments\/([^/]+)\/compare$/,
    (m) => {
      const id = id1(m);
      if (compares[id]) return compares[id];
      const d = experimentDetail(id);
      return { experiment_id: id, status: 'incomplete', reason: 'the experiment has not been started', arms: d.arms, rows: [], stats: null };
    },
  ],
  ['POST', /^\/experiments\/([^/]+)\/judge$/, (m, _p, body) => approveJudge(id1(m), body as JudgeApprovalRequest)],
  ['DELETE', /^\/experiments\/([^/]+)\/judge$/, (m) => revokeJudge(id1(m))],
  ['POST', /^\/experiments\/([^/]+)\/regrade$/, (m) => regrade(id1(m))],
  ['GET', /^\/experiments\/([^/]+)$/, (m) => ({ ...experimentDetail(id1(m)), judge: created.judges.get(id1(m)) ?? experimentDetail(id1(m)).judge ?? null })],
  ['GET', /^\/examples$/, () => sampleExamples],
  ['POST', /^\/examples\/([^/]+)\/load$/, (m) => loadExample(id1(m))],
  ['GET', /^\/trials$/, () => recordedTrialsJson],
  [
    'GET',
    /^\/trials\/([^/]+)\/spans$/,
    (m) => {
      const id = id1(m);
      if (id === trial.id) return trialSpansJson;
      if (id === recordedTrial.summary.trialId) return recordedTrialSpansJson;
      throw notFound(`the spans of trial ${id}`);
    },
  ],
  [
    'GET',
    /^\/trials\/([^/]+)\/files\/(.+)$/,
    (m) => {
      if (id1(m) === trial.id && decodeURIComponent(m[2]) === 'checks.json') return trialChecksJson;
      throw new ApiError(404, 'file_not_found', `no sample file ${decodeURIComponent(m[2])}`);
    },
  ],
  [
    'GET',
    /^\/trials\/([^/]+)$/,
    (m) => {
      const id = id1(m);
      if (id === trial.id) return trial;
      if (id === recordedTrial.summary.trialId) return recordedTrial;
      throw notFound(`trial ${id}. The sample covers one trial in full: fd-vs-sip-07, arm B, trial 3`);
    },
  ],
  ['GET', /^\/labels\/queue$/, (_m, p) => labelQueue[p.get('set') ?? ''] ?? []],
  ['POST', /^\/labels$/, (_m, _p, body) => saveLabel(body as CreateLabelRequest)],
  ['GET', /^\/judge\/agreement$/, (_m, p) => (p.get('set') === 'heldout' ? judgeJson : null)],
];

export function fixtureResponse(method: string, path: string, body?: unknown): unknown {
  const [pathname, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const match = pattern.exec(pathname);
    if (match) return clone(handler(match, params, body));
  }
  throw notFound(`${method} ${pathname}`);
}
