/**
 * Fixture mode: answers the client's calls from the JSON in this folder, which is sample data
 * copied from the approved SP7 artboards (scripts/make-fixtures.mjs writes it). Writes such as
 * a new config or experiment live in memory for the session only; a label is checked and then
 * dropped, never stored, because labels are Rishi's own judgments.
 */
import { ApiError } from '../api/errors';
import type {
  Compare,
  Config,
  ConfigCreate,
  ConfigDiffEntry,
  EstimateRequest,
  Experiment,
  ExperimentCreate,
  ExperimentDetail,
  ExperimentTrial,
  Harness,
  LabelCreate,
  SettingName,
  TaskInfo,
} from '../api/types';
import comparesJson from './compares.json';
import configsJson from './configs.json';
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
import tasksJson from './tasks.json';
import toolsetsJson from './toolsets.json';
import trialJson from './trial.json';
import trialSpansJson from './trial-spans.json';

export const meta = metaJson;

const harnesses = harnessesJson as unknown as Harness[];
const tasks = tasksJson as unknown as TaskInfo[];
const configs = configsJson as unknown as Config[];
const experiments = experimentsJson as unknown as Experiment[];
const details = experimentDetailsJson as unknown as Record<string, ExperimentDetail>;
const experimentTrials = experimentTrialsJson as unknown as Record<string, ExperimentTrial[]>;
const compares = comparesJson as unknown as Record<string, Compare>;
const labelQueue = labelQueueJson as unknown as Record<string, unknown[]>;
const trial = trialJson as unknown as { id: string };
const recordedTrial = recordedTrialJson as unknown as { summary: { trialId: string } };

/** Session-only writes. */
const created = { configs: [] as Config[], experiments: new Map<string, ExperimentDetail>() };

const clone = <T>(value: T): T => structuredClone(value);
const notFound = (what: string) => new ApiError(404, 'not_found', `No sample data for ${what}.`);

function allConfigs(): Config[] {
  return [...created.configs, ...configs];
}

function experimentDetail(id: string): ExperimentDetail {
  const d = created.experiments.get(id) ?? details[id];
  if (!d) throw notFound(`experiment ${id}`);
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

function configContent(c: Pick<Config, 'harness' | 'model' | 'settings' | 'harness_options'> & { prompt: string; toolset: string }) {
  return canonical({ harness: c.harness, model: c.model, prompt: c.prompt, toolset: c.toolset, settings: c.settings, harness_options: c.harness_options });
}

function createConfig(body: ConfigCreate): Config {
  const harness = harnesses.find((h) => h.name === body.harness);
  if (!harness) throw new ApiError(400, 'unknown_harness', `There is no harness called ${body.harness}.`);
  for (const [name, value] of Object.entries(body.settings)) {
    const cap = harness.capabilities.settings[name as SettingName];
    if (value !== undefined && cap && !cap.supported) {
      throw new ApiError(400, 'unsupported_setting', `${harness.name} does not support ${name}, so it cannot be set.`);
    }
  }
  const content = configContent({ ...body, prompt: body.prompt_sha256, toolset: body.toolset_sha256 });
  const existing = allConfigs().find((c) => configContent({ ...c, prompt: c.prompt.sha256, toolset: c.toolset.sha256 }) === content);
  if (existing) return existing;
  const prompt = (promptsJson as { id: string; version: string; sha256: string }[]).find((p) => p.sha256 === body.prompt_sha256);
  const toolset = (toolsetsJson as { id: string; version: string; sha256: string }[]).find((t) => t.sha256 === body.toolset_sha256);
  if (!prompt || !toolset) throw new ApiError(400, 'unknown_file', 'The prompt or toolset is not in the catalogue.');
  const config: Config = {
    hash: sampleHash(`${harness.ref}|${content}`),
    name: body.name,
    harness: body.harness,
    harness_ref: harness.ref,
    model: body.model,
    prompt: { id: prompt.id, version: prompt.version, sha256: prompt.sha256 },
    toolset: { id: toolset.id, version: toolset.version, sha256: toolset.sha256 },
    settings: body.settings,
    settings_sources: Object.fromEntries(Object.keys(body.settings).map((k) => [k, 'config'])),
    harness_options: body.harness_options,
    created_at: meta.now,
  };
  created.configs.unshift(config);
  return config;
}

function diffConfigs(a: Config, b: Config): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  const walk = (path: string, x: unknown, y: unknown) => {
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort()) walk(path ? `${path}.${k}` : k, (x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]);
    } else if (canonical(x) !== canonical(y)) {
      out.push({ path, a: x ?? null, b: y ?? null });
    }
  };
  const fields = (c: Config) => ({ harness: c.harness, harness_ref: c.harness_ref, model: c.model, prompt: c.prompt, toolset: c.toolset, settings: c.settings, harness_options: c.harness_options });
  walk('', fields(a), fields(b));
  return out;
}

function estimate(body: EstimateRequest) {
  const trials = new Set(body.config_hashes).size * body.task_sha256s.length * body.n;
  const scale = trials / 120;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    trials,
    cost_usd: { expected: round(21.3 * scale), low: round(16 * scale), high: round(27 * scale) },
    minutes: Math.max(1, Math.round(38 * scale)),
    basis: 'Mean tokens of the pilot trials (40 trials on Hermes with Claude Haiku 5.5); prices from LiteLLM',
    concurrency: 4,
    min_detectable_effect: { points: Math.round(10 * Math.sqrt(5 / Math.max(1, body.n))), power: 0.8 },
  };
}

function createExperiment(body: ExperimentCreate): Experiment {
  const id = `exp_new_${created.experiments.size + 1}`;
  const est = estimate({ config_hashes: body.config_hashes, task_sha256s: body.task_sha256s, n: body.n, sim_model: body.sim_model });
  const detail: ExperimentDetail = {
    id,
    name: body.name,
    axis: body.axis,
    status: 'created',
    config_hashes: body.config_hashes,
    n: body.n,
    counts: { queued: est.trials, running: 0, done: 0, infra_failed: 0, abandoned: 0, cancelled: 0 },
    spend_usd: 0,
    estimate: est,
    created_at: meta.now,
    task_sha256s: body.task_sha256s,
    budget_usd: body.budget_usd,
    plan_commit: body.plan_commit,
    sim_model: body.sim_model,
    tasks: tasks.filter((t) => body.task_sha256s.includes(t.sha256)),
    configs: allConfigs().filter((c) => body.config_hashes.includes(c.hash)),
    events: [{ at: meta.now, kind: 'created', trial_id: null, message: `Created ${est.trials} trials. Nothing runs until it is started.` }],
  };
  created.experiments.set(id, detail);
  return detail;
}

function trialsFor(id: string): ExperimentTrial[] {
  if (experimentTrials[id]) return experimentTrials[id];
  const d = created.experiments.get(id);
  if (!d) return [];
  const status = d.status === 'cancelled' ? 'cancelled' : 'queued';
  return d.tasks.flatMap((t) =>
    d.config_hashes.flatMap((c, arm) =>
      Array.from({ length: d.n }, (_, r) => ({
        id: `${id}_${t.id}_${arm}_${r + 1}`,
        task: t.sha256,
        config: c,
        repeat_index: r,
        attempt: 1,
        status,
        label: null,
        end_state: null,
        passed: null,
        cost_usd: null,
        wall_s: null,
      })),
    ),
  );
}

function setStatus(id: string, status: string, message: string): Experiment {
  const d = created.experiments.get(id);
  if (!d) throw new ApiError(409, 'sample_data', 'The sample experiments are read-only; create one to start it.');
  d.status = status;
  d.events.unshift({ at: meta.now, kind: status, trial_id: null, message });
  return d;
}

function saveLabel(body: LabelCreate) {
  const values = ['yes', 'no', 'unsure'];
  if (!body.item_id || !body.criterion || !values.includes(body.value)) {
    throw new ApiError(400, 'invalid_label', 'A label needs an item, a criterion and yes, no or unsure.');
  }
  // Deliberately not stored: in sample mode nothing is written to labels/.
  return { saved: false, reason: 'sample data' };
}

type Handler = (match: RegExpExecArray, params: URLSearchParams, body: unknown) => unknown;

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/harnesses$/, () => harnesses],
  ['GET', /^\/prompts$/, () => promptsJson],
  ['GET', /^\/toolsets$/, () => toolsetsJson],
  ['GET', /^\/tasks$/, () => tasks],
  ['GET', /^\/models$/, () => modelsJson],
  ['GET', /^\/configs$/, () => allConfigs()],
  ['POST', /^\/configs$/, (_m, _p, body) => createConfig(body as ConfigCreate)],
  [
    'GET',
    /^\/configs\/([^/]+)\/diff\/([^/]+)$/,
    (m) => {
      const [a, b] = [m[1], m[2]].map((h) => allConfigs().find((c) => c.hash === decodeURIComponent(h)));
      if (!a || !b) throw notFound('that config');
      return diffConfigs(a, b);
    },
  ],
  [
    'GET',
    /^\/configs\/([^/]+)$/,
    (m) => {
      const c = allConfigs().find((x) => x.hash === decodeURIComponent(m[1]));
      if (!c) throw notFound('that config');
      return c;
    },
  ],
  ['POST', /^\/experiments\/estimate$/, (_m, _p, body) => estimate(body as EstimateRequest)],
  ['POST', /^\/experiments$/, (_m, _p, body) => createExperiment(body as ExperimentCreate)],
  ['GET', /^\/experiments$/, () => [...created.experiments.values(), ...experiments]],
  ['POST', /^\/experiments\/([^/]+)\/start$/, (m) => setStatus(decodeURIComponent(m[1]), 'running', 'Started. In sample mode nothing actually runs.')],
  ['POST', /^\/experiments\/([^/]+)\/cancel$/, (m) => setStatus(decodeURIComponent(m[1]), 'cancelled', 'Cancelled: queued trials will not run.')],
  [
    'GET',
    /^\/experiments\/([^/]+)\/trials$/,
    (m, p) =>
      trialsFor(decodeURIComponent(m[1])).filter(
        (t) => (!p.get('status') || t.status === p.get('status')) && (!p.get('config') || t.config === p.get('config')) && (!p.get('task') || t.task === p.get('task')),
      ),
  ],
  [
    'GET',
    /^\/experiments\/([^/]+)\/compare$/,
    (m) => {
      const id = decodeURIComponent(m[1]);
      if (compares[id]) return compares[id];
      experimentDetail(id);
      return { rows: [], stats: null };
    },
  ],
  ['GET', /^\/experiments\/([^/]+)$/, (m) => experimentDetail(decodeURIComponent(m[1]))],
  ['GET', /^\/trials$/, () => recordedTrialsJson],
  [
    'GET',
    /^\/trials\/([^/]+)\/spans$/,
    (m) => {
      const id = decodeURIComponent(m[1]);
      if (id === trial.id) return trialSpansJson;
      if (id === recordedTrial.summary.trialId) return recordedTrialSpansJson;
      throw notFound(`the spans of trial ${id}`);
    },
  ],
  [
    'GET',
    /^\/trials\/([^/]+)$/,
    (m) => {
      const id = decodeURIComponent(m[1]);
      if (id === trial.id) return trial;
      if (id === recordedTrial.summary.trialId) return recordedTrial;
      throw notFound(`trial ${id}. The sample covers one trial in full: fd-vs-sip-07, arm B, trial 3`);
    },
  ],
  ['GET', /^\/labels\/queue$/, (_m, p) => labelQueue[p.get('set') ?? ''] ?? []],
  ['POST', /^\/labels$/, (_m, _p, body) => saveLabel(body as LabelCreate)],
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
