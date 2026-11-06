<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { api } from '../api/client';
import { isFixtureMode } from '../api/mode';
import type { ConfigView, ConfigDiffEntry, Estimate, ExperimentDetail, TrialRowSummary, Harness, ModelView, PromptView, RenderedPromptStatus, TaskView } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import ConflictCheck from '../components/ConflictCheck.vue';
import LoadState from '../components/LoadState.vue';
import { ApiError } from '../api/errors';
import { armIndexOf, armsOf, namedByHash, timeLeft, totalTrials } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { causeView } from '../lib/causes';
import { armDifferences, armValue, armsCheck, axisChange, axisFromDiff, budgetCheck, capabilityCheck, changeWords, changesWords, contentDiff, keysCheck, planCheck, runAutoName, RUN_NAME_MAX, splitCheck, type Check } from '../lib/checks';
import { changedLineCount, lineChanges, sentenceChanges, type LineChange } from '../lib/diff';
import { capitalise, clock, minutes, money, plainText, plural, shortHash, wholeMoney } from '../lib/format';
import { experimentName, infraReason, modelName, splitName } from '../lib/names';
import { href, navigate, replaceRoute } from '../router';
import { eventView, pauseCause } from '../lib/runs';
import { setRunFlash, takeRunFlash } from '../lib/runFlash';
import { armPauseHelp, defaultArms, defaultBudget, defaultN, DEFAULT_N, isEngineTest, isLocalModel, missingKey, needsKeyWords, ownConfigs, plainRunError, taskSetWords, validateN, validateSeed, type ArmDefaults } from '../lib/runSetup';
import { FAKE_SIM_MODEL, isFake, simModels } from '../lib/models';
import { CHECKER_MODEL, ensureConflictChecks, needsConflictCheck } from '../lib/conflictGate';
import { text } from '../trials';

const props = defineProps<{ experimentId?: string; a?: string | null; b?: string | null; calibration?: boolean }>();
const draft = !props.experimentId;
const fixtures = isFixtureMode();

interface Loaded {
  configs: ConfigView[];
  allTasks: TaskView[];
  models: ModelView[];
  harnesses: Harness[];
  prompts: PromptView[];
  experiment: ExperimentDetail | null;
  trials: TrialRowSummary[];
}

/** The address names a run that does not exist (a mistyped or stale link). */
const missing = ref(false);
async function experimentOrMissing(id: string) {
  try {
    return await api.experiment(id);
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'unknown_experiment' || err.status === 404)) missing.value = true;
    throw err;
  }
}

const { data, error, loading, reload } = useLoad<Loaded>(async () => {
  const [harnesses, prompts] = await Promise.all([optional(api.harnesses(), [] as Harness[]), optional(api.prompts(), [] as PromptView[])]);
  if (props.experimentId) {
    const [experiment, trials, allTasks, models] = await Promise.all([
      experimentOrMissing(props.experimentId),
      optional(api.experimentTrials(props.experimentId), [] as TrialRowSummary[]),
      optional(api.tasks(), [] as TaskView[]),
      // Only to name each arm's provider when a config error pauses it.
      optional(api.models(), [] as ModelView[]),
    ]);
    return { configs: experiment.configs, allTasks: allTasks.length ? allTasks : experiment.tasks, models, harnesses, prompts, experiment, trials };
  }
  const [configs, allTasks, models] = await Promise.all([api.configs(), api.tasks(), optional(api.models(), [] as ModelView[])]);
  return { configs, allTasks, models, harnesses, prompts, experiment: null, trials: [] };
});

// ---------------------------------------------------------------- what is being run

/** `n` is what the number field holds: a number, or '' when what is typed is not one. */
interface Setup {
  a: string;
  b: string;
  split: string;
  n: number | string;
  simModel: string;
  budget: string;
  plan: string;
  name: string;
  seed: string;
  /** D44: an A/A calibration run, the same agent on both arms, to measure the setup's own noise. */
  calibration: boolean;
  /** D32's futility check as ticked by hand; null follows the default (futilityOn). */
  futility: boolean | null;
}
const setup = reactive<Setup>({ a: props.a ?? '', b: props.b ?? '', split: 'held_out', n: DEFAULT_N, simModel: '', budget: '', plan: '', name: '', seed: '', calibration: !!props.calibration, futility: null });
const touched = reactive({ budget: false, name: false, sim: false, n: false });
/** Tasks taken out of the run by hand, by sha256. Engine tests start out of it. */
const excluded = reactive(new Set<string>());
/** Why the arms could not both be filled in: one config only (a pilot), or none. */
const armNote = ref<ArmDefaults['note']>(null);

watch(data, (d) => {
  if (!d || !draft || setup.simModel) return;
  // A missing arm is the newest other config, the same harness first; never the config on the
  // other arm, and never an A/A run (lib/runSetup.ts).
  const arms = defaultArms(d.configs, props.a, props.b);
  setup.a = arms.a;
  // D44: a calibration runs arm A's agent on arm B too.
  setup.b = setup.calibration && arms.a ? arms.a : arms.b;
  armNote.value = setup.calibration ? null : arms.note;
  setup.simModel = defaultSim.value;
  if (!d.allTasks.some((t) => t.split === setup.split)) setup.split = 'all';
  for (const t of d.allTasks) if (isEngineTest(t)) excluded.add(t.sha256);
});

const hashes = computed<string[]>(() => (draft ? [setup.a, setup.b].filter(Boolean) : (data.value?.experiment?.config_hashes ?? [])));
/** Every arm on a fake model: the run tries the platform out, and the simulated client defaults to the fake one. */
const allFake = computed(() => hashes.value.length > 0 && hashes.value.every((h) => isFake(data.value?.configs.find((c) => c.hash === h)?.model)));
/** A real run's simulated client: the first real model whose key is set, else the first one. */
const defaultSim = computed(() => {
  if (allFake.value) return FAKE_SIM_MODEL;
  const models = data.value?.models ?? [];
  return (models.find((m) => !missingKey(m.name, models)) ?? models[0])?.name ?? FAKE_SIM_MODEL;
});
watch(defaultSim, (v) => {
  if (draft && !touched.sim && setup.simModel) setup.simModel = v;
});
const simGroups = computed(() => simModels(data.value?.models ?? []));
/** The simulated client's model, when a conversation task needs one. */
const simInUse = computed(() => {
  const model = draft ? setup.simModel : (data.value?.experiment?.sim_model ?? '');
  return model && tasks.value.some((t) => t.kind === 'conversation') ? model : '';
});
/** Every model this run calls, by role, for the paid-run confirmation. */
const runModels = computed(() => {
  const list = hashes.value.map((h, i) => ({ role: `Arm ${String.fromCharCode(65 + i)}`, model: data.value?.configs.find((c) => c.hash === h)?.model ?? '' }));
  if (simInUse.value) list.push({ role: 'Simulated client', model: simInUse.value });
  return list.filter((m) => m.model);
});
/** What this run calls that costs money, for the start panel. */
const realModels = computed(() => [...new Set(runModels.value.map((m) => m.model).filter((m) => !isFake(m)))]);
/** The local open-weight model among them: free per token and keyless, but it answers only while
 *  its Ollama container is up, which the API has no way to tell this page. Said by Start. */
const localModels = computed(() => realModels.value.filter((m) => isLocalModel(m, data.value?.models ?? [])));
const localNames = computed(() => localModels.value.map((m) => modelName(m)).join(' and '));
/** The models that cost money per token: every real one except the local one. */
const paidModels = computed(() => realModels.value.filter((m) => !localModels.value.includes(m)));
/** Every model this run calls whose provider key is not set in .env (GET /models' key_set). */
const keysMissing = computed(() =>
  // D75: a Hermes agent on a real model has its prompt checked first, on Claude Sonnet 5.5.
  [...runModels.value, ...(gatedConfigs.value.length ? [{ role: 'Prompt check', model: CHECKER_MODEL }] : [])].flatMap((m) => {
    const key = missingKey(m.model, data.value?.models ?? []);
    return key ? [{ ...m, key }] : [];
  }),
);
/** The arm pickers: your own configs, and a shipped example's only when the address names it. */
const pickable = computed(() => {
  const all = data.value?.configs ?? [];
  return { own: ownConfigs(all), example: all.filter((c) => c.example_only && (c.hash === setup.a || c.hash === setup.b)) };
});
/** No model costs anything real: the estimate is at made-up test prices, and no spending limit is needed. */
const fakeOnly = computed(() => hashes.value.length > 0 && realModels.value.length === 0);
/** A41: the futility check protects spend, so it starts off when every model is fake and on for a
 *  paid run, as the API's own default; ticked by hand, it stays as ticked. */
const futilityOn = computed({
  get: () => setup.futility ?? !fakeOnly.value,
  set: (on: boolean) => {
    setup.futility = on;
  },
});
// A run on fake models only starts at fewer trials (lib/runSetup.ts defaultN); a number typed by
// hand stays as typed. Before the configs load, nothing is known about the models.
watch(
  () => (data.value ? fakeOnly.value : null),
  (fake) => {
    if (draft && !touched.n && fake !== null) setup.n = defaultN(fake);
  },
  { immediate: true },
);
const configOf = (h: string) => data.value?.configs.find((c) => c.hash === h);
/** D75: this run's Hermes agents on a real model, whose prompt is checked against Hermes's own
 *  instructions before the run starts (the API refuses the start without that check). */
const gatedConfigs = computed(() => [...new Set(hashes.value)].map(configOf).filter((c): c is ConfigView => !!c && needsConflictCheck(c)));
/** What the start is doing while it runs those checks. */
const checkProgress = ref<string | null>(null);
/** Runs the missing checks; false, with the reason in actionError, when the run must not start. */
async function runGateChecks(): Promise<boolean> {
  if (!gatedConfigs.value.length) return true;
  try {
    await ensureConflictChecks(gatedConfigs.value, api, { onProgress: (t) => (checkProgress.value = t) });
    return true;
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err);
    return false;
  }
}
/** The rendered prompt's state per checked agent, for the findings on the run page. */
const renderedStatus = ref<Record<string, RenderedPromptStatus | 'unknown'>>({});
watch(
  () => (props.experimentId ? gatedConfigs.value.map((c) => c.hash).join(',') : ''),
  async (joined) => {
    for (const h of joined ? joined.split(',') : []) {
      try {
        renderedStatus.value = { ...renderedStatus.value, [h]: (await api.renderedPrompt(h)).status };
      } catch {
        renderedStatus.value = { ...renderedStatus.value, [h]: 'unknown' };
      }
    }
  },
  { immediate: true },
);
const sameConfig = computed(() => hashes.value.length === 2 && hashes.value[0] === hashes.value[1]);
/** The run is an A/A calibration (D44): the draft's box, or the saved experiment's own flag. */
const isCalibration = computed(() => (draft ? setup.calibration : !!data.value?.experiment?.calibration));
/** The same agent on both arms without the calibration box: refused, as the API refuses it (A30). */
const sameByMistake = computed(() => sameConfig.value && !isCalibration.value);
// Ticking the box puts arm A's agent on arm B; unticking it picks arm B again as the defaults would.
watch(
  () => [setup.calibration, setup.a] as const,
  ([on, a], before) => {
    if (!draft || !data.value) return;
    if (on) setup.b = a;
    else if (before?.[0] && setup.b === a) setup.b = defaultArms(data.value.configs, a, undefined).b;
  },
);
/** Arms whose config id is not a saved agent here (a mistyped or stale link): said plainly, and
 *  nothing else about the run is worked out or claimed until each is picked again. */
const unknownArms = computed(() =>
  draft && data.value
    ? hashes.value.flatMap((h, i) => (configOf(h) ? [] : [{ letter: String.fromCharCode(65 + i), hash: h }]))
    : [],
);
/** The tasks of the chosen split, before any is taken out by hand. */
const splitTasks = computed<TaskView[]>(() => {
  const d = data.value;
  if (!d || !draft) return [];
  return setup.split === 'all' ? d.allTasks : d.allTasks.filter((t) => t.split === setup.split);
});
const tasks = computed<TaskView[]>(() => {
  const d = data.value;
  if (!d) return [];
  if (!draft) return d.experiment?.tasks ?? [];
  return splitTasks.value.filter((t) => !excluded.has(t.sha256));
});
function toggleTask(sha: string) {
  if (excluded.has(sha)) excluded.delete(sha);
  else excluded.add(sha);
}
const splits = computed(() => [...new Set(data.value?.allTasks.map((t) => t.split) ?? [])]);
/** N as typed, checked: a whole number from 1 to 1,000, or the reason it is not. */
const nCheck = computed(() => validateN(setup.n));
/** The claim-order seed as typed, checked as the API checks it (empty is a random one). */
const seedCheck = computed(() => validateSeed(setup.seed));
/** The run name as typed, against the API's limit. */
const nameError = computed(() => (setup.name.trim().length > RUN_NAME_MAX ? `The run name is ${setup.name.trim().length} characters; the most is ${RUN_NAME_MAX}. Shorten it.` : null));
/** The validated N (the experiment's own once it exists); null while what is typed is not valid. */
const n = computed<number | null>(() => (draft ? nCheck.value.value : (data.value?.experiment?.n ?? 0)));
/** The trials a draft would create, from what is picked; null until it is a valid run. */
const plannedTrials = computed(() => (n.value !== null && !sameByMistake.value && hashes.value.length && !unknownArms.value.length ? tasks.value.length * hashes.value.length * n.value : null));

const diff = shallowRef<ConfigDiffEntry[]>([]);
watch(
  // Both ids, and whether each is a saved agent: the configs load after the address is read.
  () => [hashes.value[0], hashes.value[1], !!configOf(hashes.value[0] ?? ''), !!configOf(hashes.value[1] ?? '')] as const,
  async ([a, b, knownA, knownB]) => {
    // An id that is not a saved agent has no diff to ask for: the page says so instead.
    diff.value = a && b && a !== b && knownA && knownB ? await optional(api.configDiff(a, b), []) : [];
  },
  { immediate: true },
);
const axis = computed(() => axisFromDiff(diff.value, sameConfig.value) ?? 'mixed');
const arms = computed(() => armsOf({ axis: draft ? axis.value : (data.value?.experiment?.axis ?? axis.value), config_hashes: hashes.value }, data.value?.configs ?? []));

const draftEstimate = ref<Estimate | null>(null);
const estimateError = ref<string | null>(null);
/** What the draft would run, as one key; null when it is not a run yet (no arm, no task, a bad
 *  N, or the same config on both arms), so nothing is estimated and no stale figure is shown. */
const estimateKey = computed(() => {
  if (!draft || !hashes.value.length || !tasks.value.length || n.value === null || sameByMistake.value || unknownArms.value.length) return null;
  return JSON.stringify([hashes.value, tasks.value.map((t) => t.sha256), n.value, setup.simModel, isCalibration.value]);
});
/** Each estimate request is numbered, so an answer to an older one (a slow network) is dropped. */
let estimateSeq = 0;
watch(
  estimateKey,
  async (key) => {
    const mine = ++estimateSeq;
    draftEstimate.value = null;
    estimateError.value = null;
    if (key === null || n.value === null) return;
    try {
      const e = await api.estimate({ config_hashes: hashes.value, task_sha256s: tasks.value.map((t) => t.sha256), n: n.value, sim_model: setup.simModel || null, ...(isCalibration.value ? { calibration: true } : {}) });
      if (mine !== estimateSeq) return;
      draftEstimate.value = e;
      if (!touched.budget) setup.budget = String(defaultBudget(e.cost_usd.high));
    } catch (err) {
      if (mine !== estimateSeq) return;
      estimateError.value = plainRunError(err);
    }
  },
  { immediate: true },
);
const estimate = computed(() => (draft ? draftEstimate.value : (data.value?.experiment?.estimate ?? null)));
/** A draft on fake models only sends a budget that covers the estimate (the API raises it anyway). */
const budget = computed(() => {
  if (!draft) return data.value?.experiment?.budget_usd;
  if (fakeOnly.value) return draftEstimate.value ? defaultBudget(draftEstimate.value.cost_usd.high) : 0;
  return Number(setup.budget) || 0;
});

/** The run's default name says what the arms differ in ("Max steps 10 vs 12 on Own loop with
 *  Fake model finance-emi, 15 tasks"), never "X vs X" (lib/checks.ts runAutoName). */
const suggestedName = computed(() => {
  const [a, b] = hashes.value.map(configOf);
  if (!a || (hashes.value.length === 2 && !b)) return '';
  if (isCalibration.value && sameConfig.value) return `A/A calibration: ${a.name}`;
  return runAutoName(a, b, taskSetWords(tasks.value, data.value?.allTasks ?? [], setup.split));
});
watch(suggestedName, (v) => {
  if (!touched.name) setup.name = v;
});

// ---------------------------------------------------------------- checks

/** The plan commit the checks read: the draft's field, or an unstarted experiment's own (else its field). */
const planCommit = computed(() => (draft ? setup.plan : (data.value?.experiment?.plan_commit ?? setup.plan)));
/** An unstarted experiment without a plan commit can be given one before it starts. */
const needsPlanField = computed(() => !draft && !started.value && !allFake.value && !data.value?.experiment?.plan_commit);

const checks = computed<Check[]>(() => {
  const d = data.value;
  if (!d) return [];
  const unknown = unknownArms.value;
  if (unknown.length) {
    // Nothing is known about an agent that is not saved here, so nothing else is checked or claimed.
    const which = unknown.map((u) => `arm ${u.letter} (${u.hash})`).join(' and ');
    return [
      {
        ok: false,
        title: unknown.length === 1 ? 'No saved agent with that id' : 'No saved agents with those ids',
        detail: `The link names ${which}, which ${unknown.length === 1 ? 'is not a saved agent' : 'are not saved agents'} here: it may be mistyped, or from another database. Pick ${unknown.length === 1 ? `a saved agent for arm ${unknown[0].letter}` : 'saved agents for both arms'} above.`,
      },
    ];
  }
  const configs = hashes.value.map(configOf).filter((c): c is ConfigView => !!c);
  // The same config on both arms only as a marked A/A calibration (D44); otherwise it is refused.
  const pair = configs.length === 2 ? ([configs[0], configs[1]] as [ConfigView, ConfigView]) : undefined;
  const arms = armsCheck(diff.value, false, pair);
  const armRow: Check = sameByMistake.value
    ? { ok: false, title: 'Arm A and arm B are the same agent', detail: 'Pick a different agent for one of the arms, set arm B to None to run this agent on its own, or tick A/A calibration to measure the setup’s own noise.' }
    : isCalibration.value
      ? sameConfig.value
        ? { ok: true, title: 'A/A calibration: the same agent on both arms', detail: 'Any difference this run finds is the noise of the setup itself; it should come out "no detectable difference".' }
        : { ok: false, title: 'An A/A calibration needs the same agent on both arms', detail: 'Pick the same agent for arm B, or untick A/A calibration to compare two agents.' }
      : arms.ok || !hashes.value[1]
      ? arms
      : { ...arms, link: { href: href.fork(hashes.value[1]), text: 'Fork arm B’s agent to change one thing' } };
  // A model whose key is not set would fail every call: the run stays off until it is added.
  const keys = started.value ? null : keysCheck(keysMissing.value);
  const list: Check[] = [
    ...(draft && nCheck.value.error ? [{ ok: false, title: 'The number of trials is not valid', detail: nCheck.value.error }] : []),
    ...(draft && seedCheck.value.error ? [{ ok: false, title: 'The claim-order seed is not valid', detail: seedCheck.value.error }] : []),
    ...(draft && nameError.value ? [{ ok: false, title: 'The run name is too long', detail: nameError.value }] : []),
    ...(hashes.value.length === 2 ? [armRow] : []),
    ...(keys ? [keys] : []),
    capabilityCheck(configs, d.harnesses),
    // A plan is committed before a run that measures something; a run on fake models only tries the platform out.
    allFake.value ? { ok: true, title: 'No analysis plan needed: every arm runs on a fake model', detail: 'A fake run tries the platform out; it measures nothing about a real agent.' } : planCheck(planCommit.value),
    splitCheck(tasks.value, d.allTasks),
  ];
  if (fakeOnly.value) {
    list.push({ ok: true, title: 'No spending limit needed: every model here is fake', detail: 'Fake models spend nothing real; the estimate is at made-up test prices.' });
  } else if (!draft || (n.value !== null && !sameByMistake.value)) {
    list.push(budgetCheck(budget.value, estimate.value));
  }
  return list;
});
const allPass = computed(() => checks.value.length > 0 && checks.value.every((c) => c.ok));
/** Start needs every check passing and, for a draft, the estimate of exactly what would run. */
const canStart = computed(() => allPass.value && !busy.value && (!draft || (!!draftEstimate.value && draftEstimate.value.trials === plannedTrials.value)));

/** Under a disabled Start: which checks stand in the way, by name. */
const startHelper = computed(() => {
  const failing = checks.value.filter((c) => !c.ok);
  const n = failing.length;
  if (!n) return draft && !draftEstimate.value ? 'Waiting for the estimate of this run.' : 'Every check above has to pass first.';
  return `${n} check${n === 1 ? ' is' : 's are'} not passing: ${failing.map((c) => c.title).join('; ')}.`;
});

/** A diff value in the panel: a content hash in its short form, anything else as text. */
const diffValue = (v: unknown): string => (typeof v === 'string' && /^sha256:[0-9a-f]{7,}$/.test(v) ? shortHash(v) : text(v));

/** How the arms differ: the prompt's changed lines, or, in words, what differs, with each field
 *  and its values (`fields`) for a Details disclosure. */
const armDiff = computed<{ summary: string; lines: LineChange[]; fields: LineChange[] }>(() => {
  const content = contentDiff(diff.value);
  if (sameConfig.value) return { summary: isCalibration.value ? 'The same config on both arms, as an A/A calibration needs. Nothing differs.' : 'The same config on both arms. Nothing differs.', lines: [], fields: [] };
  if (!content.length) return { summary: 'Nothing differs.', lines: [], fields: [] };
  const [ca, cb] = hashes.value.map(configOf);
  const pa = data.value?.prompts.find((p) => p.sha256 === ca?.prompt.sha256);
  const pb = data.value?.prompts.find((p) => p.sha256 === cb?.prompt.sha256);
  const promptOnly = content.every((d) => d.path.startsWith('prompt'));
  if (promptOnly && pa && pb) {
    const changed = changedLineCount(lineChanges(pa.text, pb.text));
    return { summary: `The system prompt, ${changed} ${changed === 1 ? 'line' : 'lines'} changed. Nothing else differs.`, lines: sentenceChanges(pa.text, pb.text), fields: [] };
  }
  const changes = ca && cb ? armDifferences(ca, cb) : [];
  return {
    summary: `${changes.length ? changesWords(changes) : `${content.length} ${content.length === 1 ? 'field differs' : 'fields differ'}`}.${changes.length === 1 ? ' Nothing else differs.' : ''}`,
    lines: [],
    fields: content.flatMap((d) => [
      { side: 'a' as const, text: `${d.path}: ${diffValue(d.a)}` },
      { side: 'b' as const, text: `${d.path}: ${diffValue(d.b)}` },
    ]),
  };
});

// ---------------------------------------------------------------- start, cancel

const busy = ref(false);
const actionError = ref<string | null>(null);
onMounted(() => {
  // A run that was saved but did not start says why on its own page (lib/runFlash.ts).
  if (props.experimentId) actionError.value = takeRunFlash(props.experimentId) ?? actionError.value;
});

/** A run that calls a real model asks before it starts, with what it can cost (as the conflict check does). */
const confirmPaid = ref(false);

function requestStart() {
  if (!canStart.value) return;
  if (realModels.value.length) {
    confirmPaid.value = true;
    return;
  }
  void (draft ? startNew() : startCreated());
}

function confirmedStart() {
  confirmPaid.value = false;
  void (draft ? startNew() : startCreated());
}

/** False once this page is left: a start that finishes later never pulls you back to it. */
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});

async function startNew() {
  if (!canStart.value || n.value === null) return;
  // Where the start was asked from: it opens the run's page only if you are still here.
  const from = window.location.hash;
  const stillHere = () => alive && window.location.hash === from;
  busy.value = true;
  actionError.value = null;
  // D75: check the Hermes prompts first, so a check that fails leaves nothing half-made.
  if (!(await runGateChecks())) {
    busy.value = false;
    return;
  }
  let createdId: string | null = null;
  try {
    const created = await api.createExperiment({
      name: setup.name.trim() || suggestedName.value,
      axis: axis.value,
      config_hashes: hashes.value,
      task_sha256s: tasks.value.map((t) => t.sha256),
      n: n.value,
      sim_model: setup.simModel || null,
      budget_usd: budget.value ?? 0,
      plan_commit: setup.plan.trim() || null,
      ...(seedCheck.value.value !== null ? { order_seed: seedCheck.value.value } : {}),
      ...(isCalibration.value ? { calibration: true } : {}),
      // What the box shows is what the run records, whatever the API's default.
      futility: { enabled: futilityOn.value },
    });
    createdId = created.id;
    await api.startExperiment(created.id);
    // The run's own page replaces the setup in the address and in history, so neither a refresh
    // nor Back offers to start the same trials again. Left meanwhile, you stay where you went; the
    // run is listed on Experiments.
    if (stillHere()) replaceRoute(href.run(created.id));
  } catch (err) {
    if (createdId) {
      // Saved but not started: its own page can start it or discard it, so a retry never makes a second one.
      setRunFlash(createdId, `The run was saved but did not start: ${plainRunError(err)} Start it here, or discard it.`);
      if (stillHere()) replaceRoute(href.run(createdId));
    } else {
      actionError.value = plainRunError(err);
    }
  } finally {
    busy.value = false;
  }
}

/** Starts an experiment that was created but never started, with its plan commit when it lacked one. */
async function startCreated() {
  const id = props.experimentId;
  if (!id) return;
  const commit = needsPlanField.value ? setup.plan.trim() : '';
  busy.value = true;
  actionError.value = null;
  const checked = await runGateChecks();
  busy.value = false;
  if (!checked) return;
  await act('start', commit ? { plan_commit: commit } : undefined);
}

type RunAction = 'start' | 'pause' | 'resume' | 'stop';
const RUN_ACTIONS: Record<RunAction, (id: string, plan?: { plan_commit: string }) => Promise<unknown>> = {
  start: (id, plan) => (plan ? api.startExperiment(id, plan) : api.startExperiment(id)),
  pause: (id) => api.pauseExperiment(id),
  resume: (id) => api.resumeExperiment(id),
  stop: (id) => api.stopExperiment(id),
};

/** Stop cancels every waiting trial for good, so it asks first. */
const confirmStop = ref(false);

async function act(kind: RunAction, plan?: { plan_commit: string }) {
  const id = props.experimentId;
  if (!id) return;
  busy.value = true;
  actionError.value = null;
  try {
    await RUN_ACTIONS[kind](id, plan);
    confirmStop.value = false;
    await reload();
  } catch (err) {
    actionError.value = plainRunError(err);
  } finally {
    busy.value = false;
  }
}

/** An experiment that never started can be thrown away: the API marks it cancelled, nothing is deleted. */
const confirmDiscard = ref(false);
async function discard() {
  const id = props.experimentId;
  if (!id) return;
  busy.value = true;
  actionError.value = null;
  try {
    await api.discardExperiment(id);
    // Left meanwhile, you stay where you went.
    if (alive) navigate(href.experiments());
  } catch (err) {
    actionError.value = plainRunError(err);
  } finally {
    busy.value = false;
    confirmDiscard.value = false;
  }
}

/** Per-arm pause and resume (D37), by the arm's letter. */
const armBusy = ref<string | null>(null);
const armError = ref<{ arm: string; text: string } | null>(null);
async function armAct(letter: string, pause: boolean) {
  const id = props.experimentId;
  if (!id) return;
  armBusy.value = letter;
  armError.value = null;
  try {
    await (pause ? api.pauseArm(id, letter) : api.resumeArm(id, letter));
    await reload();
  } catch (err) {
    armError.value = { arm: letter, text: plainRunError(err) };
  } finally {
    armBusy.value = null;
  }
}

// ---------------------------------------------------------------- progress

type CellState = 'pass' | 'fail' | 'incomplete' | 'ungraded' | 'nograders' | 'running' | 'waiting' | 'infra' | 'final' | 'abandoned' | 'cancelled';
const CELL_WORDS: Record<Exclude<CellState, 'abandoned' | 'final'>, string> = {
  pass: 'passed',
  fail: 'failed',
  incomplete: 'graded, incomplete: a required check gave no verdict',
  ungraded: 'done, waiting for its grades',
  nograders: 'done, its task has no graders',
  running: 'running',
  waiting: 'waiting',
  infra: 'infra failure, re-queued',
  cancelled: 'cancelled',
};

const isInfraStop = (t: TrialRowSummary) => t.status === 'infra_failed' || t.status === 'abandoned';
/** D26: never re-queued. Any other infra failure is re-queued once (D16), so a second is final too. */
const NEVER_REQUEUED = ['infra:config_error', 'infra:budget_net'];
const isFinalInfra = (t: TrialRowSummary) => t.status === 'infra_failed' && (NEVER_REQUEUED.includes(t.label ?? '') || t.attempt >= 2);

/** A done trial's cell, from its grading (GET /experiments/:id/trials, SP4), so the grid shows
 *  what the comparison counts; `passed` alone for an API from before `grading`. */
function doneState(t: TrialRowSummary): CellState {
  switch (t.grading) {
    case 'pass':
      return 'pass';
    case 'fail':
      return 'fail';
    case 'incomplete':
    case 'grading_failed':
      return 'incomplete';
    case 'no_graders':
      return 'nograders';
    case 'waiting':
      return 'ungraded';
    default:
      return t.passed === true ? 'pass' : t.passed === false ? 'fail' : 'ungraded';
  }
}

/** A slot's state is its latest attempt's; `hadInfra` keeps the history, so a slot that was
 *  stopped by an infra failure and then re-run still says so once it has passed or failed. */
function slotState(attempts: TrialRowSummary[]): { state: CellState; hadInfra: boolean } {
  if (!attempts.length) return { state: 'waiting', hadInfra: false };
  const hadInfra = attempts.some(isInfraStop);
  const latest = attempts.reduce((x, y) => (y.attempt > x.attempt ? y : x));
  const state = ((): CellState => {
    switch (latest.status) {
      case 'done':
        return doneState(latest);
      case 'running':
      case 'claimed':
        return 'running';
      case 'queued':
        return attempts.length > 1 ? 'infra' : 'waiting';
      case 'cancelled':
        return 'cancelled';
      case 'abandoned':
        return 'abandoned';
      default:
        return isFinalInfra(latest) ? 'final' : 'infra';
    }
  })();
  return { state, hadInfra };
}

/** The slot's latest attempt when it is done: the one its cell shows. */
function latestDone(attempts: TrialRowSummary[]): TrialRowSummary | null {
  if (!attempts.length) return null;
  const latest = attempts.reduce((x, y) => (y.attempt > x.attempt ? y : x));
  return latest.status === 'done' ? latest : null;
}

const grid = computed(() => {
  const e = data.value?.experiment;
  if (!e) return [];
  const trials = data.value?.trials ?? [];
  const twice = sameConfig.value;
  return e.tasks.map((t) => ({
    task: t,
    arms: e.config_hashes.map((_h, arm) =>
      Array.from({ length: e.n }, (_, r) => {
        const repeat = twice ? r + arm * e.n : r;
        const attempts = trials
          .filter((x) => x.task_sha256 === t.sha256 && armIndexOf(x, e) === arm && x.repeat_index === repeat)
          .sort((x, y) => x.attempt - y.attempt);
        const { state, hadInfra } = slotState(attempts);
        const tries = attempts.length ? Math.max(...attempts.map((x) => x.attempt)) : 0;
        const last = attempts[attempts.length - 1];
        const words =
          state === 'abandoned'
            ? `infra failure, gave up after ${tries} ${tries === 1 ? 'attempt' : 'attempts'}`
            : state === 'final'
              ? `infra failure (${infraReason(last?.label) || 'infra'}), not re-run`
              : CELL_WORDS[state];
        const retried = hadInfra && (state === 'pass' || state === 'fail');
        // D64: a failed or stopped-short trial's cause. This page does not load the label queue, so
        // it keeps labelling blind: the judge against your label reads as a judge check that failed.
        const cause = latestDone(attempts)?.cause ? causeView(latestDone(attempts)?.cause, false) : null;
        const why = cause ? `; ${cause.name.toLowerCase()}` : '';
        return { state, retried, attempts, label: `${t.id}, arm ${String.fromCharCode(65 + arm)}, trial ${r + 1}: ${words}${retried ? ', after an infra failure' : ''}${why}` };
      }),
    ),
  }));
});

/** Infra failures are counted from the attempts, not from the latest states, so a finished run
 *  still reports them. Each was re-run, is re-queued, or gave up; `byArm` says where they fell. */
const tally = computed(() => {
  const all = grid.value.flatMap((row) => row.arms.flat());
  const of = (...s: CellState[]) => all.filter((c) => s.includes(c.state)).length;
  const stops = { total: 0, rerun: 0, requeued: 0, gaveUp: 0, notRerun: 0 };
  const byArm: Record<string, number> = {};
  for (const row of grid.value) {
    row.arms.forEach((cells, arm) => {
      for (const c of cells) {
        c.attempts.forEach((a, k) => {
          if (!isInfraStop(a)) return;
          stops.total += 1;
          const letter = String.fromCharCode(65 + arm);
          byArm[letter] = (byArm[letter] ?? 0) + 1;
          const next = c.attempts[k + 1];
          if (a.status === 'abandoned') stops.gaveUp += 1;
          else if (!next && isFinalInfra(a)) stops.notRerun += 1;
          else if (!next || next.status === 'queued') stops.requeued += 1;
          else stops.rerun += 1;
        });
      }
    });
  }
  return { done: of('pass', 'fail', 'incomplete', 'ungraded', 'nograders'), running: of('running'), waiting: of('waiting'), stops, byArm, cancelled: of('cancelled') };
});

/** "both in arm B", "all in arm A", "in arm B" when every infra failure fell in one arm; "A 1, B 2"
 *  otherwise. */
function armsWords(byArm: Record<string, number>, total: number): string {
  const hit = Object.entries(byArm).filter(([, n]) => n > 0);
  const only = hit.length === 1 ? hit[0][0] : null;
  if (!only) return hit.map(([letter, n]) => `${letter} ${n}`).join(', ');
  if (total === 1) return `in arm ${only}`;
  return `${total === 2 ? 'both' : 'all'} in arm ${only}`;
}

const slotCount = computed(() => grid.value.reduce((sum, row) => sum + row.arms.flat().length, 0));

/** The line under a started run's h1: time left first, then what is running and waiting, the
 *  infra failures (with where they fell) and what was cancelled. The done count is left out: every
 *  started run's h1 already states it. */
const tallyText = computed(() => {
  const t = tally.value;
  const parts: string[] = [];
  const e = data.value?.experiment;
  if (e?.status === 'running') {
    const left = timeLeft(e.estimate, t.done, slotCount.value || totalTrials(e));
    if (left !== null) parts.push(capitalise(`about ${minutes(left)} left`));
  }
  if (!started.value) parts.push(`${t.done} done`);
  parts.push(`${t.running} running`, `${t.waiting} waiting`);
  const s = t.stops;
  if (s.total) {
    const noun = `${s.total} infra ${s.total === 1 ? 'failure' : 'failures'}`;
    const how =
      s.requeued === s.total
        ? `${noun} re-queued`
        : s.notRerun === s.total
          ? `${noun}, not re-run`
          : `${noun}: ${[s.rerun ? `${s.rerun} re-run` : '', s.requeued ? `${s.requeued} re-queued` : '', s.notRerun ? `${s.notRerun} not re-run` : '', s.gaveUp ? `${s.gaveUp} gave up` : ''].filter(Boolean).join(', ')}`;
    parts.push(`${how}, ${armsWords(t.byArm, s.total)}`);
  }
  if (t.cancelled) parts.push(`${t.cancelled} cancelled`);
  return parts.join(' · ');
});

/** Which infra states the grid holds, for the legend's second row: only those present. */
const infraInGrid = computed(() => {
  const cells = grid.value.flatMap((row) => row.arms.flat());
  return {
    requeued: cells.some((c) => c.state === 'infra'),
    retried: cells.some((c) => c.retried),
    gaveUp: cells.some((c) => c.state === 'abandoned'),
    notRerun: cells.some((c) => c.state === 'final'),
  };
});
/** The grading states the grid holds beyond pass and fail (grading is its own step), for the
 *  legend: only those present. */
const gradingInGrid = computed(() => {
  const cells = grid.value.flatMap((row) => row.arms.flat());
  return { ungraded: cells.some((c) => c.state === 'ungraded'), incomplete: cells.some((c) => c.state === 'incomplete'), noGraders: cells.some((c) => c.state === 'nograders') };
});
const showInfraLegend = computed(() => infraInGrid.value.requeued || infraInGrid.value.retried || infraInGrid.value.gaveUp || infraInGrid.value.notRerun);

/** The run's log, oldest first, so it reads in the order things happened. Claims are many and
 *  routine, so they are counted, and listed only on request. */
const allEvents = computed(() => [...(data.value?.experiment?.events ?? [])].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).map(eventView));
const showClaims = ref(false);
const claimCount = computed(() => (data.value?.experiment?.events ?? []).filter((e) => e.kind === 'claim').length);
const events = computed(() => (showClaims.value ? allEvents.value : allEvents.value.filter((e) => e.title !== 'Trial claimed')));

/** What paused the whole run (D32), and the arms that are paused on their own (D37). */
const pause = computed(() => {
  const e = data.value?.experiment;
  if (!e || e.status !== 'paused') return null;
  const reason = e.paused_reason ?? 'No new trials start until it is resumed; trials already running finish.';
  return { ...pauseWords(reason), at: e.paused_at };
});
/**
 * A whole-run pause as a heading and the rest of its reason, never the same words twice: "futility
 * check (D32): arm B passed 0 of its first 3 graded trials, fewer than ..." is headed "Paused by the
 * futility check" and goes on "Arm B passed 0 of its first 3 graded trials, fewer than ...".
 */
function pauseWords(reason: string): { cause: string; reason: string } {
  const plain = plainText(reason).trim();
  const rule = plain.match(/^(futility check|infra guard|spend guard):\s*(.*)$/s);
  if (rule) return { cause: `Paused by the ${rule[1]}`, reason: capitalise(rule[2]) };
  const cause = capitalise(pauseCause(reason));
  // The heading is the reason's first clause: the text below keeps only what comes after it.
  const rest = plain.toLowerCase().startsWith(cause.toLowerCase()) ? plain.slice(cause.length).replace(/^[\s.;:,]+/, '') : plain;
  return { cause, reason: capitalise(rest) };
}
const ARM_STATUS: Record<string, string> = { not_started: 'Not started', active: 'Running', paused: 'Paused', stopped: 'Stopped', complete: 'Complete' };
const armCards = computed(() =>
  (data.value?.experiment?.arms ?? []).map((a) => {
    const c = a.counts;
    const total = c.queued + c.running + c.done + c.infra_failed + c.abandoned + c.cancelled;
    const parts = [`${c.done} done`, c.running ? `${c.running} running` : '', c.queued ? `${c.queued} waiting` : '', c.infra_failed + c.abandoned ? `${c.infra_failed + c.abandoned} infra` : '', c.cancelled ? `${c.cancelled} cancelled` : ''];
    // While the whole run is paused (by hand, the futility check or a guard), an arm with trials
    // left claims nothing either, so it says Paused, not Running.
    const runPaused = data.value?.experiment?.status === 'paused' && (a.status === 'active' || a.status === 'not_started');
    return {
      view: a,
      key: a.arm.toLowerCase(),
      status: runPaused ? 'Paused' : (ARM_STATUS[a.status] ?? a.status),
      shownStatus: runPaused ? 'paused' : a.status,
      counts: `${parts.filter(Boolean).join(', ')} of ${plural(total, 'trial row')}`,
      reused: a.reused_from ? `Reuses ${plural(a.reused_trials, 'finished trial')} of ${a.reused_from}` : '',
      // While the whole run is paused the arm already claims nothing: the run's Resume is what to press.
      canPause: !runPaused && (a.status === 'active' || a.status === 'not_started'),
      canResume: a.status === 'paused',
      help: a.status === 'paused' ? armPauseHelp(a, configOf(a.config_hash)?.model ?? null, data.value?.models ?? []) : null,
    };
  }),
);
/** "Set up the same run again", for an arm a config error left with nothing to run. */
const rerunHref = computed(() => {
  const [a, b] = data.value?.experiment?.config_hashes ?? [];
  return a ? href.runNew(a, b ?? '') : href.runNew();
});
const pausedArms = computed(() => armCards.value.filter((a) => a.view.status === 'paused'));

/** What the two arms differ in, with both values, once both configs are known: the one rule the
 *  comparison's header reads too (armDifferences in lib/arms.ts). */
const armChanges = computed(() => {
  const [a, b] = hashes.value.map(configOf);
  return a && b && a.hash !== b.hash ? armDifferences(a, b) : [];
});
/** The arms' names come from armsOf, as on the comparison ("Max steps 10", "Prompt v2"). When two
 *  configs share a name and the arms are named by their configs (they differ in several things),
 *  each arm's own values say which is which: "max steps 10, temperature not sent". '' otherwise. */
function armDistinct(i: number): string {
  const [a, b] = hashes.value.map(configOf);
  const arm = arms.value[i];
  if (!a || !b || !arm || a.name.trim() !== b.name.trim() || !namedByHash(arm)) return '';
  return armChanges.value.map((c) => armValue(c, i === 0 ? 'a' : 'b')).join(', ');
}
/** An arm card's name: its config's, then the arm's own name when the two configs share theirs. */
function armCardName(letter: string, configName: string): string {
  const i = letter.charCodeAt(0) - 65;
  const [a, b] = hashes.value.map(configOf);
  const arm = arms.value[i];
  if (!a || !b || a.name.trim() !== b.name.trim() || !arm) return configName;
  const own = namedByHash(arm) ? armDistinct(i) : arm.label;
  return own ? `${configName} (${own})` : configName;
}

/** "A: Prompt v2, config 7f3a9c2", or "A: Prompt v1 on Hermes, config 3b81e04" when the arm would
 *  otherwise be named by its hash alone, so the hash is never said twice; with its own values when
 *  that name is the other arm's too. An id that is not a saved agent is said so. */
const armLine = (arm: (typeof arms.value)[number], i: number): string => {
  if (!arm.config && draft) return 'no saved agent with id';
  if (!namedByHash(arm)) return `${arm.label}, config`;
  const distinct = armDistinct(i);
  return arm.config?.name ? `${arm.config.name}${distinct ? ` (${distinct})` : ''}, config` : 'config';
};

/** The run's name: a shipped example's own title, else the name it was given. */
const runTitle = computed(() => (data.value?.experiment ? experimentName(data.value.experiment) : null));

/** The simulated client's model, which every conversation in both arms runs against. */
const simClient = computed(() => (data.value?.experiment?.sim_model ? modelName(data.value.experiment.sim_model) : null));

/** The power tile's note. The API has no power estimate yet (SP6 adds `min_detectable_effect`). */
const powerNote = 'Not computed before a run (docs/known-limits.md, Statistics, has the simulated power table); a verdict needs at least 6 tasks that differ between the arms';

/** "2 workers per harness", from the workers the estimate's time assumes. */
const workersNote = computed(() => {
  const w = estimate.value?.basis_detail.workers;
  if (!w) return '';
  const used = Object.entries(w).map(([h, x]) => `${x.used} ${h}`);
  const n = Object.values(w).reduce((sum, x) => sum + x.used, 0);
  return used.length ? `${plural(n, 'worker')} at a time (${used.join(', ')})` : '';
});

/** Item 8: what the run has cost and taken so far, next to the estimate. */
const actualNote = computed(() => {
  const a = data.value?.experiment?.actual;
  if (!a) return '';
  const per = a.cost_per_trial_usd !== null ? `${money(a.cost_per_trial_usd)} a trial` : '';
  const wall = a.wall_s_per_trial !== null ? `${Math.round(a.wall_s_per_trial)} s a trial` : '';
  return [`${plural(a.finished_trials, 'trial')} finished`, per, wall, `projected ${money(a.projected_spend_usd)}`].filter(Boolean).join(', ');
});

const spend = computed(() => {
  const e = data.value?.experiment;
  if (!e) return null;
  const expected = e.estimate?.cost_usd.expected ?? null;
  const cap = e.budget_usd ?? null;
  const max = Math.max(e.spend_usd, expected ?? 0, cap ?? 0) || 1;
  const x = (v: number) => Math.round((v / max) * 296) + 2;
  return { spent: e.spend_usd, expected, cap, w: x(e.spend_usd) - 2, ex: expected !== null ? x(expected) : null, cx: cap !== null ? x(cap) : null };
});

let timer: ReturnType<typeof setInterval> | null = null;
watch(
  () => data.value?.experiment?.status,
  (status) => {
    if (timer) clearInterval(timer);
    timer = null;
    if ((status === 'running' || status === 'paused') && !fixtures) timer = setInterval(() => void reload(), 5000);
  },
);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const budgetNote = computed(() => {
  // A fake-only run spends nothing real, so its LiteLLM cap (in made-up money) is not news.
  if (fakeOnly.value) return '';
  const b = budget.value;
  if (!b) return '';
  const e = estimate.value;
  const times = e && e.cost_usd.expected > 0 ? `, about ${Math.round((b / e.cost_usd.expected) * 10) / 10} times the estimate` : '';
  return `LiteLLM stops all spending at ${wholeMoney(b)}${times}. If it ever trips, the trials it stopped are reported as infra failures, not agent failures.`;
});
/** Under the estimated cost: the likely range, or for a fake-only run that the price is made up. */
const costNote = computed(() => {
  const e = estimate.value;
  if (!e)
    return draft
      ? unknownArms.value.length
        ? 'Pick a saved agent for each arm first.'
        : (estimateError.value ?? (nCheck.value.error ? 'Set a valid number of trials first.' : sameConfig.value ? 'Pick two different agents first.' : ''))
      : '';
  if (fakeOnly.value) return 'A made-up test price: fake models spend nothing real';
  return `Likely ${money(e.cost_usd.low)} to ${money(e.cost_usd.high)}`;
});

// ---------------------------------------------------------------- a started run

/** Once a run has started, the page leads with its progress; before that, with the checks. */
const started = computed(() => !draft && (data.value?.experiment?.status ?? 'created') !== 'created');

const heading = computed(() => {
  const e = data.value?.experiment;
  if (!started.value || !e) return 'Check and run';
  const total = slotCount.value || totalTrials(e);
  const done = tally.value.done;
  if (e.status === 'running') return `Running: ${done} of ${total} trials done`;
  if (e.status === 'done') return `Run finished: ${done} of ${total}`;
  if (e.status === 'cancelled') return `Run stopped: ${done} of ${total} done`;
  if (e.status === 'paused') return `Paused: ${done} of ${total} trials done`;
  return `Run ${e.status}: ${done} of ${total} done`;
});

const checksSummary = computed(() => {
  // A plan commit is recorded as given, not checked: it is not counted as a check that passed.
  const checked = checks.value.filter((c) => !c.recorded);
  const passed = checked.filter((c) => c.ok).length;
  const plan = data.value?.experiment?.plan_commit;
  return `Checked before the start: ${passed} of ${checked.length} passed${plan ? `; plan commit ${plan.slice(0, 7)}, as given` : ''}`;
});

const diffSummary = computed(() => {
  if (sameConfig.value) return 'How the two arms differ: nothing, the same config twice';
  const [a, b] = hashes.value.map(configOf);
  const one = a && b && a.hash !== b.hash ? axisChange(a, b) : null;
  const words = one ? changeWords(one) : changesWords(armChanges.value);
  if (words) return `How the two arms differ: ${words}`;
  const n = contentDiff(diff.value).length;
  return `How the two arms differ: ${n} ${n === 1 ? 'field' : 'fields'}`;
});

const planNote = computed(() => {
  const e = estimate.value;
  if (!e || n.value === null) return '';
  const t = tasks.value.length;
  return `${t} ${t === 1 ? 'task' : 'tasks'} × ${hashes.value.length} ${hashes.value.length === 1 ? 'arm' : 'arms'} × ${n.value} ${n.value === 1 ? 'trial' : 'trials'}`;
});

/** The Start button's words: the trial count only once it is valid and estimated. */
const startLabel = computed(() => {
  const fresh = !!draftEstimate.value && draftEstimate.value.trials === plannedTrials.value;
  const count = draft ? (fresh ? plannedTrials.value : null) : (estimate.value?.trials ?? null);
  return count ? `Start ${count} trials` : 'Start';
});

/** The paid-run confirmation's facts (D38's pattern): trials, models, the most it can cost, the limit. */
const paidFacts = computed(() => {
  const e = estimate.value;
  return {
    trials: draft ? plannedTrials.value : (e?.trials ?? null),
    models: runModels.value.map((m) => `${m.role}: ${modelName(m.model)}${isFake(m.model) ? ' (fake, free)' : ''}`),
    expected: e ? money(e.cost_usd.expected) : '–',
    high: e ? money(e.cost_usd.high) : '–',
    budget: wholeMoney(budget.value ?? null),
  };
});

// ---------------------------------------------------------------- the task list's scroll cue

/** The task list scrolls once it is long: say how many are in view, and fade its lower edge,
 *  until it is scrolled to the end. */
const taskPick = ref<HTMLElement | null>(null);
const taskScroll = reactive({ overflow: false, atEnd: true, shown: 0 });
function measureTasks() {
  const el = taskPick.value;
  if (!el) return;
  const overflow = el.scrollHeight > el.clientHeight + 1;
  const bottom = el.scrollTop + el.clientHeight;
  const options = [...el.querySelectorAll<HTMLElement>('.task-option')];
  taskScroll.overflow = overflow;
  taskScroll.atEnd = !overflow || bottom >= el.scrollHeight - 2;
  taskScroll.shown = options.filter((o) => o.offsetTop >= el.scrollTop - 1 && o.offsetTop + o.offsetHeight <= bottom + 1).length;
}
const taskHint = computed(() => (taskScroll.overflow && !taskScroll.atEnd ? `${taskScroll.shown} of ${splitTasks.value.length} shown, scroll for more` : ''));
let taskObserver: ResizeObserver | null = null;
watch(
  taskPick,
  (el) => {
    taskObserver?.disconnect();
    taskObserver = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      taskObserver = new ResizeObserver(() => measureTasks());
      taskObserver.observe(el);
    }
    void nextTick(measureTasks);
  },
  { flush: 'post' },
);
watch(splitTasks, () => void nextTick(measureTasks), { flush: 'post' });
onBeforeUnmount(() => taskObserver?.disconnect());
</script>

<template>
  <div
    v-if="missing"
    class="page-head"
    data-test="run-missing"
  >
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a :href="href.experiments()">Experiments</a> / Not found
    </nav>
    <h1 tabindex="-1">
      No run with that id
    </h1>
    <p class="lede">
      Nothing is saved as <span class="mono">{{ experimentId }}</span>: the link may be mistyped, or from another database. <a :href="href.experiments()">Experiments</a> lists every run, and <a :href="href.runNew()">Set up a run</a> starts a new one.
    </p>
  </div>
  <div
    v-else
    class="head-row"
  >
    <div class="page-head">
      <nav
        aria-label="Breadcrumb"
        class="crumbs"
      >
        <a :href="href.experiments()">Experiments</a> / {{ runTitle ?? (draft ? setup.name || 'New experiment' : 'Run') }}
      </nav>
      <h1
        tabindex="-1"
        data-test="run-title"
      >
        {{ heading }}
      </h1>
      <p
        v-if="started && data?.experiment"
        class="tally num"
        data-test="tally"
      >
        {{ tallyText }}
      </p>
      <p
        v-if="!draft && !started && data?.experiment"
        class="lede unstarted"
        data-test="unstarted"
      >
        This run was set up but never started, so nothing has run. Check what it still needs below, then start it, or discard it.
      </p>
      <p
        v-if="!started"
        class="lede"
      >
        Nothing starts unless the run can finish. The estimates come from {{ estimate?.basis ? (estimate.basis.charAt(0).toLowerCase() + estimate.basis.slice(1)).replace(/[.\s]+$/, '') : 'earlier trials and the prices in LiteLLM' }}.
      </p>
    </div>
    <div
      v-if="started && data?.experiment"
      class="head-actions"
      data-test="run-actions"
    >
      <template v-if="data.experiment.status === 'running' || data.experiment.status === 'paused'">
        <div
          class="control-buttons"
          role="group"
          aria-label="Run controls"
        >
          <button
            v-if="data.experiment.status === 'running'"
            type="button"
            class="btn btn--quiet"
            :disabled="busy"
            data-test="pause"
            @click="act('pause')"
          >
            Pause
          </button>
          <button
            v-else
            type="button"
            class="btn"
            :disabled="busy"
            data-test="resume"
            @click="act('resume')"
          >
            Resume
          </button>
          <button
            v-if="!confirmStop"
            type="button"
            class="btn btn--quiet"
            :disabled="busy"
            data-test="stop"
            @click="confirmStop = true"
          >
            Stop
          </button>
          <template v-else>
            <button
              type="button"
              class="btn"
              :disabled="busy"
              data-test="stop-confirm"
              @click="act('stop')"
            >
              Stop and cancel {{ plural(data.experiment.counts.queued, 'waiting trial') }}
            </button>
            <button
              type="button"
              class="btn btn--quiet"
              :disabled="busy"
              data-test="stop-keep"
              @click="confirmStop = false"
            >
              Keep running
            </button>
          </template>
        </div>
        <p class="secondary smaller">
          {{ data.experiment.status === 'running' ? 'Pause stops new claims; running trials finish. ' : '' }}Stop cancels the waiting trials for good; running ones finish and are kept.
        </p>
      </template>
      <a
        v-else
        :href="href.compare(data.experiment.id)"
        class="btn"
      >Open the comparison</a>
      <p
        v-if="actionError"
        class="error small"
        role="alert"
      >
        {{ actionError }}
      </p>
    </div>
  </div>

  <LoadState
    v-if="!missing"
    :loading="loading && !data"
    :error="error"
    what="the run"
  >
    <template v-if="data && !started">
      <section
        aria-label="Plan"
        class="stat-strip plan"
        data-test="plan"
      >
        <div>
          <span class="stat-label">Trials</span>
          <span class="stat-value">{{ estimate?.trials ?? '–' }}</span>
          <span class="stat-note">{{ planNote }}</span>
        </div>
        <div>
          <span class="stat-label">Estimated cost</span>
          <span class="stat-value">{{ estimate ? money(estimate.cost_usd.expected) : '–' }}</span>
          <span
            class="stat-note"
            data-test="cost-note"
          >{{ costNote }}</span>
        </div>
        <div>
          <span class="stat-label">Estimated time</span>
          <span class="stat-value">{{ estimate ? minutes(estimate.minutes) : '–' }}</span>
          <span class="stat-note">{{ workersNote }}</span>
        </div>
        <div>
          <span class="stat-label">Smallest overall difference it can see</span>
          <span class="stat-value">–</span>
          <span
            class="stat-note"
            data-test="power-note"
          >{{ powerNote }}</span>
        </div>
      </section>

      <div class="split">
        <div class="grow stack">
          <section
            v-if="draft"
            aria-labelledby="setup"
            class="panel panel--pad setup"
          >
            <h2
              id="setup"
              class="section-title"
            >
              What to run
            </h2>
            <p
              v-if="armNote"
              class="arm-note small"
              data-test="arm-note"
            >
              <template v-if="armNote === 'only_one' || armNote === 'no_baseline'">
                <template v-if="armNote === 'only_one'">
                  A comparison needs a baseline: a second agent that differs from this one in one thing. There is only one agent so far, so this run tests it on its own (a pilot).
                </template>
                <template v-else>
                  A comparison needs a baseline: an agent that differs from {{ configOf(setup.a)?.name ?? 'this one' }} in just one thing, and no saved agent does, so this run tests it on its own (a pilot).
                </template>
                <a
                  v-if="setup.a"
                  :href="href.fork(setup.a)"
                  data-test="arm-note-fork"
                >Fork this agent</a><template v-else>
                  Fork an agent
                </template> to make one: change one setting, the prompt or the model, save, and set up the run again.
              </template>
              <template v-else>
                There are no agents of your own to run yet{{ data.configs.some((c) => c.example_only) ? "; the shipped example's are kept as they were run, not run again" : '' }}. <a :href="href.build()">Build an agent</a> first.
              </template>
            </p>
            <div class="setup-grid">
              <label class="field">
                <span class="arm"><span class="dot dot--a" />Arm A</span>
                <select
                  v-model="setup.a"
                  data-test="arm-a"
                >
                  <option
                    v-for="c in pickable.own"
                    :key="c.hash"
                    :value="c.hash"
                  >{{ c.name }} · {{ shortHash(c.hash) }}</option>
                  <optgroup
                    v-if="pickable.example.length"
                    label="From the shipped example"
                  >
                    <option
                      v-for="c in pickable.example"
                      :key="c.hash"
                      :value="c.hash"
                    >{{ c.name }} · {{ shortHash(c.hash) }}</option>
                  </optgroup>
                </select>
              </label>
              <label class="field">
                <span class="arm"><span class="dot dot--b" />Arm B</span>
                <select
                  v-model="setup.b"
                  :disabled="setup.calibration"
                  :title="setup.calibration ? 'An A/A calibration runs arm A’s agent on arm B too' : undefined"
                  data-test="arm-b"
                >
                  <option value="">
                    None: one arm, a pilot
                  </option>
                  <option
                    v-for="c in pickable.own"
                    :key="c.hash"
                    :value="c.hash"
                  >{{ c.name }} · {{ shortHash(c.hash) }}</option>
                  <optgroup
                    v-if="pickable.example.length"
                    label="From the shipped example"
                  >
                    <option
                      v-for="c in pickable.example"
                      :key="c.hash"
                      :value="c.hash"
                    >{{ c.name }} · {{ shortHash(c.hash) }}</option>
                  </optgroup>
                </select>
              </label>
              <p
                v-if="pickable.example.length"
                class="secondary smaller example-arms"
                data-test="example-arms"
              >
                A shipped example's agent was made elsewhere, with the files of its day: its tools or prompt may differ from today's. To run it again, fork it on its page; the fork gets today's files.
              </p>
              <p
                v-if="unknownArms.length"
                class="error small same-config"
                role="alert"
                data-test="unknown-arms"
              >
                <template
                  v-for="(u, ui) in unknownArms"
                  :key="u.letter"
                >
                  {{ ui ? ' ' : '' }}No saved agent with the id <span class="mono">{{ u.hash }}</span>, so arm {{ u.letter }} is empty.
                </template>
                The link may be mistyped, or from another database. Pick a saved agent above; <a :href="href.config()">Configs</a> lists every one.
              </p>
              <label
                class="aa-option small"
                data-test="calibration"
              >
                <input
                  v-model="setup.calibration"
                  type="checkbox"
                  data-test="calibration-box"
                >
                <span><strong>A/A calibration</strong>: runs one agent on both arms to measure this setup’s own noise; it should come out “no detectable difference”.</span>
              </label>
              <p
                v-if="sameByMistake"
                class="error small same-config"
                role="alert"
                data-test="same-config"
              >
                Arm A and arm B are the same agent. Pick a different agent for one of them, set arm B to None to run it on its own, or tick A/A calibration above.
              </p>
              <fieldset class="field fieldset">
                <legend class="field-label">
                  Tasks
                </legend>
                <div
                  class="seg"
                  role="group"
                  aria-label="Tasks"
                >
                  <button
                    v-for="s in [...splits, 'all']"
                    :key="s"
                    type="button"
                    :aria-pressed="setup.split === s"
                    @click="setup.split = s"
                  >
                    {{ s === 'all' ? 'All' : splitName(s).charAt(0).toUpperCase() + splitName(s).slice(1) }}
                  </button>
                </div>
              </fieldset>
              <label class="field">
                <span class="field-label">Simulated client model</span>
                <select
                  v-model="setup.simModel"
                  data-test="sim-model"
                  @change="touched.sim = true"
                >
                  <optgroup label="Fake: scripted, free">
                    <option
                      v-for="m in simGroups.fake"
                      :key="m.name"
                      :value="m.name"
                    >{{ modelName(m.name) }}</option>
                  </optgroup>
                  <optgroup label="Real: each call costs money">
                    <option
                      v-for="m in simGroups.real"
                      :key="m.name"
                      :value="m.name"
                    >{{ modelName(m.name) }}{{ needsKeyWords(m.name, data.models) ? ` (${needsKeyWords(m.name, data.models)})` : '' }}</option>
                  </optgroup>
                </select>
                <span class="secondary smaller">Plays the client in conversation tasks only.</span>
              </label>
              <label class="field">
                <span class="field-label">Name</span>
                <input
                  v-model="setup.name"
                  type="text"
                  :maxlength="RUN_NAME_MAX"
                  :aria-invalid="nameError ? 'true' : undefined"
                  :aria-describedby="nameError ? 'run-name-error' : undefined"
                  data-test="run-name"
                  @input="touched.name = true"
                >
                <span
                  v-if="nameError"
                  id="run-name-error"
                  class="error smaller"
                  data-test="run-name-error"
                >{{ nameError }}</span>
                <span
                  v-else
                  class="secondary smaller"
                >Up to {{ RUN_NAME_MAX }} characters. It says what the arms differ in until you change it.</span>
              </label>
              <label class="field">
                <span class="field-label">Analysis plan commit</span>
                <input
                  v-model="setup.plan"
                  type="text"
                  class="mono"
                  placeholder="The commit of docs/experiment.md"
                  data-test="plan-commit"
                >
                <span
                  class="secondary smaller"
                  data-test="plan-why"
                >The git commit where the hypothesis and how to read the result were written down before the run, so the result is judged against a plan made in advance.</span>
              </label>
              <label class="field">
                <span class="field-label">Claim-order seed, optional</span>
                <input
                  v-model="setup.seed"
                  type="text"
                  inputmode="numeric"
                  class="mono"
                  placeholder="Random, and recorded"
                  :aria-invalid="seedCheck.error ? 'true' : undefined"
                  :aria-describedby="seedCheck.error ? 'seed-error' : undefined"
                  data-test="order-seed"
                >
                <span
                  v-if="seedCheck.error"
                  id="seed-error"
                  class="error smaller"
                  data-test="seed-error"
                >{{ seedCheck.error }}</span>
                <span class="secondary smaller">A whole number from 0 to 4,294,967,295. The trials run in an order shuffled from it, arms interleaved.</span>
              </label>
              <label
                class="aa-option small"
                data-test="futility"
              >
                <input
                  v-model="futilityOn"
                  type="checkbox"
                  data-test="futility-box"
                >
                <span><strong>Futility check</strong>: pauses the run for review if an arm passes none of its first 3 graded trials, so a broken agent stops spending; it never stops on an apparent win. {{ fakeOnly ? 'Off to start with here: every model is fake, so the run spends nothing.' : 'On to start with: this run calls a real model.' }}</span>
              </label>
              <div class="task-pick-wrap">
                <div class="task-pick-frame">
                  <fieldset
                    ref="taskPick"
                    class="field fieldset task-pick"
                    :class="{ 'task-pick--more': taskHint }"
                    data-test="task-pick"
                    @scroll.passive="measureTasks"
                  >
                    <legend class="field-label">
                      {{ tasks.length }} of {{ splitTasks.length }} tasks in the run
                    </legend>
                    <label
                      v-for="t in splitTasks"
                      :key="t.sha256"
                      class="task-option small"
                    >
                      <input
                        type="checkbox"
                        :checked="!excluded.has(t.sha256)"
                        :data-test="`task-${t.id}`"
                        @change="toggleTask(t.sha256)"
                      >
                      <span><span class="mono">{{ t.id }}</span> <span class="secondary">{{ t.kind === 'conversation' ? 'conversation' : 'one prompt' }}{{ isEngineTest(t) ? ', engine test' : '' }}</span></span>
                    </label>
                  </fieldset>
                  <!-- More below: the lower edge fades into the panel until the list is scrolled to its end. -->
                  <span
                    v-if="taskHint"
                    class="task-fade"
                    aria-hidden="true"
                  />
                </div>
                <p
                  v-if="taskHint"
                  class="secondary smaller task-hint"
                  data-test="task-hint"
                >
                  {{ taskHint }}
                </p>
              </div>
            </div>
          </section>

          <section
            aria-labelledby="checks"
            class="checks"
          >
            <h2
              id="checks"
              class="section-title checks-title"
            >
              Before it starts
            </h2>
            <div
              v-for="c in checks"
              :key="c.title"
              class="check-row"
              data-test="check"
              :data-state="c.recorded ? 'recorded' : c.ok ? 'pass' : 'fail'"
            >
              <AppIcon
                :name="c.recorded ? 'info' : c.ok ? 'pass-badge' : 'fail-badge'"
                :size="22"
              />
              <span>
                <strong>{{ c.title }}</strong>
                <span class="visually-hidden">{{ c.recorded ? 'Recorded, not checked.' : c.ok ? 'Check passed.' : 'Check failed.' }}</span>
                <span class="secondary small block">{{ c.detail }}<template v-if="c.link">
                  {{ ' ' }}<a
                    :href="c.link.href"
                    data-test="check-link"
                  >{{ c.link.text }}</a>.
                </template></span>
                <details
                  v-if="c.raw"
                  class="check-details smaller"
                  data-test="check-details"
                >
                  <summary>Details</summary>
                  <pre class="mono check-raw">{{ c.raw }}</pre>
                </details>
              </span>
            </div>
          </section>

          <section
            v-if="hashes.length === 2 && !unknownArms.length"
            aria-labelledby="armdiff"
            class="panel panel--pad arm-diff"
          >
            <h3
              id="armdiff"
              class="diff-title"
            >
              How the two arms differ
            </h3>
            <div class="diff-body">
              <div
                class="secondary"
                data-test="arm-diff-summary"
              >
                {{ armDiff.summary }}
              </div>
              <div
                v-for="(l, i) in armDiff.lines"
                :key="i"
                :class="`mono line line--${l.side}`"
              >
                <span class="side">{{ l.side.toUpperCase() }}</span>&nbsp; {{ l.text }}
              </div>
              <details
                v-if="armDiff.fields.length"
                class="check-details smaller"
                data-test="arm-diff-details"
              >
                <summary>Details: each field and its value</summary>
                <div
                  v-for="(l, i) in armDiff.fields"
                  :key="i"
                  :class="`mono line line--${l.side}`"
                >
                  <span class="side">{{ l.side.toUpperCase() }}</span>&nbsp; {{ l.text }}
                </div>
              </details>
            </div>
          </section>
        </div>

        <aside
          aria-labelledby="start"
          class="side panel panel--pad start"
        >
          <h2
            id="start"
            class="section-title"
          >
            Start the run
          </h2>
          <div
            class="stack arm-list"
            data-test="start-arms"
          >
            <span
              v-for="(arm, i) in arms"
              :key="arm.key"
              class="arm"
            ><span :class="`dot dot--${arm.key}`" /><span>{{ arm.key.toUpperCase() }}: {{ armLine(arm, i) }} <span class="mono">{{ shortHash(arm.hash) }}</span></span></span>
          </div>
          <template v-if="draft">
            <div class="n-field">
              <label class="row-field">
                <span><span class="block strong">Trials per task and arm</span><span
                  class="secondary smaller block"
                  data-test="n-hint"
                >{{ fakeOnly && !touched.n ? 'Fewer to start with here: every model is fake, so a short run tries the platform out' : 'More trials, narrower intervals' }}</span></span>
                <input
                  v-model="setup.n"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  class="small-input num"
                  :aria-invalid="nCheck.error ? 'true' : undefined"
                  :aria-describedby="nCheck.error ? 'n-error' : undefined"
                  data-test="n-input"
                  @input="touched.n = true"
                >
              </label>
              <p
                v-if="nCheck.error"
                id="n-error"
                class="error smaller"
                data-test="n-error"
              >
                {{ nCheck.error }}
              </p>
            </div>
            <label
              v-if="!fakeOnly"
              class="row-field"
            >
              <span><span class="block strong">Spending limit</span><span class="secondary smaller block">Set in LiteLLM for the whole run</span></span>
              <input
                v-model="setup.budget"
                type="number"
                min="1"
                class="small-input num"
                data-test="budget-input"
                @input="touched.budget = true"
              >
            </label>
          </template>
          <label
            v-if="needsPlanField"
            class="field"
          >
            <span class="field-label">Analysis plan commit</span>
            <input
              v-model="setup.plan"
              type="text"
              class="mono"
              placeholder="The commit of docs/experiment.md"
              data-test="plan-commit"
            >
            <span class="secondary smaller">The git commit where the hypothesis and how to read the result were written down before the run, so the result is judged against a plan made in advance.</span>
          </label>
          <p
            v-if="!started"
            class="small spend-kind"
            :class="{ 'spend-kind--real': realModels.length }"
            data-test="spend-kind"
          >
            <template v-if="realModels.length">
              <AppIcon
                name="alert"
                :size="14"
              /> Real models: {{ realModels.map(modelName).join(' and ') }}. This run costs real money; you confirm the cost before it starts.
            </template>
            <template v-else>
              Every model here is fake, so the run is free: its prices are made up for testing, and nothing it finds is about a real model.
            </template>
          </p>
          <p
            v-if="budgetNote"
            class="secondary small"
          >
            {{ budgetNote }}
          </p>
          <p
            v-if="actionError"
            class="error small"
            role="alert"
            data-test="action-error"
          >
            {{ actionError }}
          </p>
          <template v-if="draft || data.experiment">
            <p
              v-if="localModels.length && !started"
              class="local-note small"
              role="note"
              data-test="local-model-warning"
            >
              <AppIcon
                name="alert"
                :size="14"
              />
              <span>{{ localNames }} runs on this machine through Ollama, and this page cannot tell whether Ollama is up. Start it first with <span class="mono">docker compose --profile local-model up -d ollama</span> and pull the model once (the README, Add a model, has both steps); if it is not running, every trial on it fails. It costs nothing per token, but on a CPU one call can take minutes.</span>
            </p>
            <div
              v-if="confirmPaid"
              class="confirm"
              role="group"
              aria-labelledby="paid-title"
              data-test="confirm-paid"
            >
              <p
                id="paid-title"
                class="small strong"
              >
                <AppIcon
                  name="alert"
                  :size="14"
                /> {{ paidModels.length ? 'This run calls real models and costs real money.' : 'This run calls a local model: free per token, but slow on a CPU.' }}
              </p>
              <ul class="small confirm-facts">
                <li v-if="paidFacts.trials">
                  {{ paidFacts.trials }} trials
                </li>
                <li
                  v-for="m in paidFacts.models"
                  :key="m"
                >
                  {{ m }}
                </li>
                <li>Estimated cost {{ paidFacts.expected }}, likely at most {{ paidFacts.high }}</li>
                <li>
                  The most it can cost: {{ paidFacts.budget }}, the spending limit. LiteLLM stops all spending there.
                </li>
                <li
                  v-if="gatedConfigs.length"
                  data-test="confirm-prompt-check"
                >
                  First, each Hermes agent's prompt is checked against Hermes's own instructions: one call to {{ modelName(CHECKER_MODEL) }} per agent not checked before (typically $0.02 to $0.03, at most about $0.08), from the prompt-check allowance, not this run's limit. The findings show on the run page and do not stop the run.
                </li>
              </ul>
              <div class="confirm-buttons">
                <button
                  type="button"
                  class="btn"
                  :disabled="busy"
                  data-test="confirm-paid-start"
                  @click="confirmedStart"
                >
                  Start the paid run
                </button>
                <button
                  type="button"
                  class="btn btn--quiet"
                  :disabled="busy"
                  data-test="confirm-paid-cancel"
                  @click="confirmPaid = false"
                >
                  Cancel
                </button>
              </div>
            </div>
            <button
              v-else
              type="button"
              class="btn btn--big"
              :disabled="!canStart"
              data-test="start"
              @click="requestStart"
            >
              {{ startLabel }}
            </button>
            <p
              v-if="checkProgress"
              class="secondary small"
              role="status"
              data-test="check-progress"
            >
              {{ checkProgress }}
            </p>
            <p
              v-if="!canStart && !busy && !confirmPaid"
              class="secondary smaller"
              data-test="start-helper"
            >
              {{ startHelper }}
            </p>
          </template>
          <div
            v-if="!draft && data.experiment && data.experiment.status === 'created'"
            class="discard"
            data-test="discard"
          >
            <button
              v-if="!confirmDiscard"
              type="button"
              class="btn btn--quiet"
              :disabled="busy"
              data-test="discard-ask"
              @click="confirmDiscard = true"
            >
              Discard this run
            </button>
            <template v-else>
              <p class="small">
                Discard it? Nothing has run; it is marked stopped and kept in the list, and nothing is deleted.
              </p>
              <div class="confirm-buttons">
                <button
                  type="button"
                  class="btn"
                  :disabled="busy"
                  data-test="discard-confirm"
                  @click="discard"
                >
                  Discard it
                </button>
                <button
                  type="button"
                  class="btn btn--quiet"
                  :disabled="busy"
                  data-test="discard-keep"
                  @click="confirmDiscard = false"
                >
                  Keep it
                </button>
              </div>
            </template>
          </div>
        </aside>
      </div>
    </template>

    <template v-else-if="data && data.experiment">
      <section
        v-if="gatedConfigs.length && !data.experiment.example"
        aria-labelledby="prompt-checks-title"
        class="prompt-checks"
        data-test="prompt-checks"
      >
        <h2 id="prompt-checks-title">
          Prompt checked against Hermes's own instructions
        </h2>
        <p class="secondary small">
          Hermes wraps your prompt in its own instructions; this check lists where they pull against each other. It ran before the run started, as every Hermes run on a real model must. It is one model's reading, never validated: read the findings as things to look at. They did not stop the run.
        </p>
        <details class="prompt-check-details">
          <summary>Show the findings{{ gatedConfigs.length > 1 ? ` for the ${gatedConfigs.length} Hermes agents` : '' }}</summary>
          <ConflictCheck
            v-for="c in gatedConfigs"
            :key="c.hash"
            :config-hash="c.hash"
            :harness="c.harness"
            :rendered-status="renderedStatus[c.hash] ?? null"
            :allowance="null"
          />
        </details>
      </section>
      <section
        v-if="pause"
        class="pause-banner"
        role="status"
        data-test="pause-banner"
      >
        <AppIcon
          name="alert"
          :size="18"
        />
        <div>
          <h2 class="pause-title">
            {{ pause.cause }}
          </h2>
          <p class="small">
            {{ pause.reason }}
          </p>
          <p class="secondary smaller">
            <template v-if="pause.at">
              Since {{ clock(pause.at) }}.
            </template> Trials already running finish; nothing new starts until you resume. Resume, or stop it, above.
          </p>
        </div>
      </section>

      <section
        v-if="armCards.length"
        aria-labelledby="arms-title"
        class="arms-panel"
        data-test="arms"
      >
        <h2
          id="arms-title"
          class="section-title"
        >
          Arms
        </h2>
        <div class="arm-cards">
          <div
            v-for="card in armCards"
            :key="card.view.arm"
            class="panel panel--pad arm-card"
            :class="{ 'arm-card--paused': card.view.status === 'paused' }"
            :data-test="`arm-${card.view.arm}`"
          >
            <div class="arm-card-head">
              <span class="arm"><span :class="`dot dot--${card.key}`" /><span><strong>Arm {{ card.view.arm }}</strong>: {{ armCardName(card.view.arm, card.view.config_name) }}</span></span>
              <span
                class="pill pill--small pill--outline arm-status"
                :data-status="card.shownStatus"
              >{{ card.status }}</span>
            </div>
            <p class="secondary small num">
              {{ card.counts }}<template v-if="card.reused">
                . {{ card.reused }}
              </template>
            </p>
            <template v-if="card.help">
              <p
                class="small arm-reason"
                data-test="arm-reason"
              >
                <strong>Why:</strong> {{ card.help.why }}
              </p>
              <p
                class="small arm-fix"
                data-test="arm-fix"
              >
                <strong>How to fix it:</strong> {{ card.help.fix }}<template v-if="card.help.rerun">
                  {{ ' ' }}<a
                    :href="rerunHref"
                    data-test="arm-rerun"
                  >Set up the same run again</a>.
                </template>
              </p>
              <details
                v-if="card.help.raw"
                class="arm-details smaller"
                data-test="arm-details"
              >
                <summary>Details</summary>
                <p class="mono arm-raw">
                  {{ card.help.raw }}
                </p>
              </details>
            </template>
            <div
              v-if="data.experiment.status !== 'done' && data.experiment.status !== 'cancelled' && (card.canPause || card.canResume)"
              class="arm-actions"
            >
              <button
                v-if="card.canResume"
                type="button"
                class="btn btn--quiet"
                :disabled="armBusy !== null"
                :data-test="`resume-arm-${card.view.arm}`"
                @click="armAct(card.view.arm, false)"
              >
                Resume arm {{ card.view.arm }}
              </button>
              <button
                v-else
                type="button"
                class="btn btn--quiet"
                :disabled="armBusy !== null"
                :data-test="`pause-arm-${card.view.arm}`"
                @click="armAct(card.view.arm, true)"
              >
                Pause arm {{ card.view.arm }}
              </button>
            </div>
            <p
              v-if="armError && armError.arm === card.view.arm"
              class="error small"
              role="alert"
            >
              {{ armError.text }}
            </p>
          </div>
        </div>
        <p
          v-if="pausedArms.length"
          class="secondary small"
        >
          A paused arm claims nothing more; the other arm keeps running. There is no comparison until every arm is complete.
        </p>
      </section>

      <section
        aria-labelledby="progress"
        class="progress"
      >
        <h2
          id="progress"
          class="section-title"
        >
          Progress
        </h2>
        <div class="split">
          <div class="grow panel grid-wrap">
            <!-- Two rows: the outcomes, always; then only the infra states this grid holds. -->
            <div
              class="legend smaller"
              data-test="grid-legend"
            >
              <div
                class="legend-row"
                data-test="legend-outcomes"
              >
                <span class="legend-item"><span class="cell cell--pass"><AppIcon
                  name="check"
                  :size="13"
                /></span>Pass</span>
                <span class="legend-item"><span class="cell cell--fail"><AppIcon
                  name="cross"
                  :size="12"
                /></span>Fail</span>
                <span class="legend-item"><span class="cell cell--running" />Running</span>
                <span class="legend-item"><span class="cell cell--waiting" />Waiting</span>
                <span
                  v-if="gradingInGrid.ungraded"
                  class="legend-item"
                  data-test="legend-ungraded"
                ><span class="cell cell--ungraded" />Done, waiting for grades</span>
                <span
                  v-if="gradingInGrid.incomplete"
                  class="legend-item"
                  data-test="legend-incomplete"
                ><span class="cell cell--incomplete">?</span>Graded, incomplete</span>
                <span
                  v-if="gradingInGrid.noGraders"
                  class="legend-item"
                  data-test="legend-nograders"
                ><span class="cell cell--nograders">·</span>No graders</span>
              </div>
              <div
                v-if="showInfraLegend"
                class="legend-row"
                data-test="legend-infra"
              >
                <span
                  v-if="infraInGrid.requeued"
                  class="legend-item"
                ><span class="cell cell--infra">!</span>Infra, re-queued</span>
                <span
                  v-if="infraInGrid.retried"
                  class="legend-item"
                ><span class="cell cell--pass cell--retried"><AppIcon
                  name="check"
                  :size="13"
                /></span>Re-run after infra</span>
                <span
                  v-if="infraInGrid.gaveUp"
                  class="legend-item"
                ><span class="cell cell--abandoned">–</span>Infra, gave up</span>
                <span
                  v-if="infraInGrid.notRerun"
                  class="legend-item"
                  data-test="legend-final"
                ><span class="cell cell--final">–</span>Infra, not re-run</span>
              </div>
            </div>
            <div class="grid-scroll">
              <table
                class="run-grid"
                data-test="run-grid"
              >
                <thead>
                  <tr>
                    <th
                      scope="col"
                      class="task-col"
                    >
                      Task
                    </th>
                    <th
                      v-for="(arm, i) in arms"
                      :key="arm.key"
                      scope="col"
                      class="arm-col"
                      :class="{ gap: i > 0 }"
                    >
                      <!-- On a phone only the dot and the letter show; the rest of the label stays for
                           screen readers. -->
                      <span class="arm"><span :class="`dot dot--${arm.key}`" /><span><span class="arm-letter">{{ arm.key.toUpperCase() }}</span><span
                        class="arm-rest"
                        data-test="arm-rest"
                      >, {{ arm.label }}</span></span></span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in grid"
                    :key="row.task.sha256"
                  >
                    <th
                      scope="row"
                      class="mono task-name"
                    >
                      {{ row.task.id }}
                    </th>
                    <td
                      v-for="(cells, ai) in row.arms"
                      :key="ai"
                      class="arm-cells"
                      :class="{ gap: ai > 0 }"
                    >
                      <span class="cells">
                        <span
                          v-for="(c, ci) in cells"
                          :key="ci"
                          :class="['cell', `cell--${c.state}`, { 'cell--retried': c.retried }]"
                          :title="c.label"
                          :data-state="c.state"
                          :data-retried="c.retried ? 'true' : undefined"
                        ><AppIcon
                          v-if="c.state === 'pass'"
                          name="check"
                          :size="13"
                        /><AppIcon
                          v-else-if="c.state === 'fail'"
                          name="cross"
                          :size="12"
                        /><template v-else-if="c.state === 'infra'">!</template><template v-else-if="c.state === 'abandoned' || c.state === 'final'">–</template><template v-else-if="c.state === 'incomplete'">?</template><template v-else-if="c.state === 'nograders'">·</template><span class="visually-hidden">{{ c.label }}</span></span>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="side stack side-col">
            <div v-if="spend">
              <h3 class="sub-title">
                Spend so far
              </h3>
              <span class="spend-now num">{{ money(spend.spent) }}</span>
              <span
                v-if="spend.expected !== null"
                class="secondary"
              > of {{ money(spend.expected) }} estimated</span>
              <span
                v-if="fakeOnly"
                class="secondary small block"
                data-test="fake-spend"
              >Made-up test prices: fake models spend nothing real.</span>
              <svg
                viewBox="0 0 300 40"
                width="100%"
                role="img"
                :aria-label="`Spend ${money(spend.spent)}${spend.expected !== null ? `, estimate ${money(spend.expected)}` : ''}${spend.cap !== null ? `, spending stops at ${money(spend.cap)}` : ''}`"
                class="spend-bar"
              >
                <rect
                  x="0"
                  y="10"
                  width="300"
                  height="10"
                  rx="5"
                  class="track"
                />
                <rect
                  x="0"
                  y="10"
                  :width="Math.max(4, spend.w)"
                  height="10"
                  rx="5"
                  class="fill"
                />
                <template v-if="spend.ex !== null">
                  <line
                    :x1="spend.ex"
                    :x2="spend.ex"
                    y1="4"
                    y2="26"
                    class="mark"
                  />
                  <text
                    :x="spend.ex"
                    y="38"
                    text-anchor="middle"
                    class="mark-label mark-label--ink"
                  >estimate</text>
                </template>
                <template v-if="spend.cx !== null && spend.cap !== null">
                  <line
                    :x1="spend.cx"
                    :x2="spend.cx"
                    y1="4"
                    y2="26"
                    class="mark mark--cap"
                  />
                  <text
                    :x="spend.cx"
                    y="38"
                    text-anchor="end"
                    class="mark-label"
                  >stop at {{ wholeMoney(spend.cap) }}</text>
                </template>
              </svg>
              <div
                class="stack arm-list run-arms small"
                data-test="run-arms"
              >
                <span
                  v-for="(arm, i) in arms"
                  :key="arm.key"
                  class="arm"
                ><span :class="`dot dot--${arm.key}`" /><span>{{ arm.key.toUpperCase() }}: {{ armLine(arm, i) }} <span class="mono">{{ shortHash(arm.hash) }}</span></span></span>
                <span
                  v-if="simClient"
                  class="sim-client"
                  data-test="run-sim-client"
                >Simulated client: {{ simClient }}</span>
              </div>
              <p
                v-if="actualNote"
                class="secondary small budget-note"
                data-test="actual"
              >
                So far: {{ actualNote }}.
              </p>
              <p
                v-if="budgetNote"
                class="secondary small budget-note"
              >
                {{ budgetNote }}
              </p>
            </div>
            <div>
              <h3 class="sub-title">
                What happened
              </h3>
              <ol
                class="events small"
                data-test="events"
              >
                <li
                  v-for="(e, i) in events"
                  :key="i"
                  :class="`event event--${e.tone}`"
                  :data-tone="e.tone"
                >
                  <span class="secondary num">{{ clock(e.at) }}</span>
                  <span>
                    <span class="event-title"><AppIcon
                      v-if="e.tone === 'pause'"
                      name="alert"
                      :size="14"
                    />{{ e.title }}<template v-if="e.arm && !e.title.includes(`Arm ${e.arm}`)">, arm {{ e.arm }}</template></span>
                    <span class="secondary block event-detail">{{ e.detail }}</span>
                  </span>
                </li>
              </ol>
              <button
                v-if="claimCount"
                type="button"
                class="link-button smaller"
                :aria-expanded="showClaims"
                data-test="toggle-claims"
                @click="showClaims = !showClaims"
              >
                {{ showClaims ? 'Hide' : 'Show' }} the {{ plural(claimCount, 'claim') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="planned"
        class="stack"
      >
        <h2
          id="planned"
          class="section-title"
        >
          Planned
        </h2>
        <p
          class="secondary small plan-facts"
          data-test="plan-facts"
        >
          <span v-if="data.experiment.order_seed !== null && data.experiment.order_seed !== undefined">Claim order shuffled from seed <span class="mono">{{ data.experiment.order_seed }}</span>, arms interleaved. </span>
          <span v-if="data.experiment.futility">{{ data.experiment.futility.enabled ? `Futility check on: pauses for review if an arm passes fewer than ${data.experiment.futility.min_passed} of its first ${data.experiment.futility.after} graded trials (a trial counts once its grades are in; an incomplete grading does not count); it never stops on an apparent win.` : 'Futility check off.' }} </span>
          <span v-if="data.experiment.parent_experiment_id">Follows from <a :href="href.compare(data.experiment.parent_experiment_id)">{{ data.experiment.parent_experiment_id }}</a><template v-if="data.experiment.baseline">: {{ data.experiment.baseline.reason }}</template>.</span>
        </p>
        <div
          class="stat-strip plan plan--past"
          data-test="plan"
        >
          <div>
            <span class="stat-label">Trials</span>
            <span class="stat-value">{{ estimate?.trials ?? '–' }}</span>
            <span class="stat-note">{{ planNote }}</span>
          </div>
          <div>
            <span class="stat-label">Estimated cost</span>
            <span class="stat-value">{{ estimate ? money(estimate.cost_usd.expected) : '–' }}</span>
            <span class="stat-note">{{ costNote }}</span>
          </div>
          <div>
            <span class="stat-label">Estimated time</span>
            <span class="stat-value">{{ estimate ? minutes(estimate.minutes) : '–' }}</span>
            <span class="stat-note">{{ workersNote }}</span>
          </div>
          <div>
            <span class="stat-label">Smallest overall difference it can see</span>
            <span class="stat-value">–</span>
            <span
              class="stat-note"
              data-test="power-note"
            >{{ powerNote }}</span>
          </div>
        </div>
      </section>

      <details
        class="disclosure run-details"
        data-test="checks-details"
      >
        <summary class="strong">
          <span class="summary-text">{{ checksSummary }}</span>
        </summary>
        <div class="checks checks--inside">
          <div
            v-for="c in checks"
            :key="c.title"
            class="check-row"
            data-test="check"
            :data-state="c.recorded ? 'recorded' : c.ok ? 'pass' : 'fail'"
          >
            <AppIcon
              :name="c.recorded ? 'info' : c.ok ? 'pass-badge' : 'fail-badge'"
              :size="22"
            />
            <span>
              <strong>{{ c.title }}</strong>
              <span class="visually-hidden">{{ c.recorded ? 'Recorded, not checked.' : c.ok ? 'Check passed.' : 'Check failed.' }}</span>
              <span class="secondary small block">{{ c.detail }}</span>
              <pre
                v-if="c.raw"
                class="mono check-raw smaller"
              >{{ c.raw }}</pre>
            </span>
          </div>
        </div>
      </details>

      <details
        v-if="hashes.length === 2"
        class="disclosure run-details"
        data-test="diff-details"
      >
        <summary class="strong">
          <span class="summary-text">{{ diffSummary }}</span>
        </summary>
        <div class="mono diff-body diff-body--inside">
          <div class="secondary">
            {{ armDiff.summary }}
          </div>
          <div
            v-for="(l, i) in [...armDiff.lines, ...armDiff.fields]"
            :key="i"
            :class="`line line--${l.side}`"
          >
            <span class="side">{{ l.side.toUpperCase() }}</span>&nbsp; {{ l.text }}
          </div>
        </div>
      </details>
    </template>
  </LoadState>
</template>

<style scoped>
.task-pick-wrap {
  min-width: 0;
}

/* position: relative, so each option's offsetTop is measured from the list for the scroll cue. */
.task-pick {
  position: relative;
  display: grid;
  gap: 4px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;
}

/* An overlay rather than a mask: a mask on the fieldset would also clip its legend, which sits
   partly above the fieldset's box. */
.task-pick-frame {
  position: relative;
}

.task-fade {
  position: absolute;
  left: 0;
  right: 12px;
  bottom: 0;
  height: 40px;
  background: linear-gradient(to bottom, transparent, var(--surface));
  pointer-events: none;
}

.task-hint {
  margin: 6px 0 0;
}

@media (min-width: 720px) {
  .task-pick-wrap,
  .same-config {
    grid-column: 1 / -1;
  }

  .task-pick {
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  }
}

.same-config {
  margin: 0;
}

.arm-note {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-left: 4px solid var(--ink);
  background: var(--surface-muted);
  border-radius: 6px;
}

.n-field .error {
  margin: 4px 0 0;
}

/* The local model's note by Start: a warning, never a block. */
.local-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 10px 12px;
  border-left: 4px solid var(--ink);
  background: var(--surface-muted);
  border-radius: 6px;
}

.local-note > :deep(svg),
.local-note > svg {
  flex: none;
  margin-top: 3px;
}

/* The paid-run confirmation, as the conflict check asks before its paid call. */
.confirm {
  padding: 12px 14px;
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--ink);
  border-radius: 8px;
}

.confirm p {
  margin: 0 0 6px;
}

.confirm-facts {
  margin: 0 0 10px;
  padding-left: 18px;
}

.confirm-facts li + li {
  margin-top: 2px;
}

.confirm-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.discard {
  padding-top: 12px;
  border-top: 1px solid var(--rule);
}

.discard p {
  margin: 0 0 8px;
}

.arm-details {
  margin-top: 6px;
}

.arm-details summary {
  cursor: pointer;
  min-height: 32px;
  display: flex;
  align-items: center;
}

.arm-raw {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
  font-size: 12px;
}

.aa-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 2px 0 10px;
  color: var(--ink-2);
}

.aa-option input {
  margin-top: 3px;
  flex: none;
}

.aa-option strong {
  font-weight: 600;
  color: var(--ink);
}

.task-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  min-height: 32px;
}

.spend-kind--real {
  font-weight: 600;
}

.control-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* A paused run: an alert icon and words, in ink, so colour keeps meaning A, B, pass and fail. */
.pause-banner {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 16px 20px;
  margin-bottom: 20px;
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--ink);
  border-radius: 12px;
}

.pause-title {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 600;
}

.pause-banner p {
  margin: 0 0 4px;
}

.arms-panel {
  margin-bottom: 24px;
}

.prompt-checks {
  margin-bottom: 24px;
}

.prompt-checks > p {
  margin: 0 0 8px;
  max-width: 72ch;
}

.prompt-check-details > summary {
  cursor: pointer;
  margin-bottom: 8px;
}

.arm-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin-bottom: 8px;
}

.arm-card p {
  margin: 6px 0 0;
}

.arm-card--paused {
  border-color: var(--rule-strong);
  border-left: 4px solid var(--ink);
}

.arm-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.arm-status[data-status='paused'] {
  border-color: var(--ink);
  color: var(--ink);
  font-weight: 600;
}

.arm-actions {
  margin-top: 10px;
}

.plan-facts {
  margin: 0;
}

.event-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
}

.event--pause .event-title {
  font-weight: 600;
}

.event-detail {
  overflow-wrap: anywhere;
}

.link-button {
  margin-top: 6px;
  padding: 4px 0;
  min-height: 32px;
  background: none;
  border: 0;
  color: var(--ink);
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
  cursor: pointer;
  font: inherit;
}

.plan {
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
}

.plan .stat-value {
  font-size: 34px;
}

/* Once a run has started the plan is history: it steps back behind the live state above it. */
.plan.plan--past .stat-value {
  font-size: 20px;
}

.plan--past > * {
  padding: 14px 18px;
}

/* The line under a started run's h1, in the lede's voice. */
.tally {
  margin-top: 8px;
  font-size: 15px;
  color: var(--ink-2);
}

/* Under the arms, level with their text (past the 10 px dot and the 8 px gap). */
.sim-client {
  padding-left: 18px;
}

/* Two columns from 720 px: the arms, then tasks and the client model, then the name and the
   plan commit. One column below that. */
.setup-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px 20px;
  margin-top: 14px;
}

@media (min-width: 720px) {
  .setup-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

.grow > * + .checks,
.grow > * + .arm-diff {
  margin-top: 32px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
  min-width: 0;
}

.fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}

.field-label {
  padding: 0;
  font-weight: 500;
}

.field .arm {
  font-weight: 500;
}

.checks-title {
  margin-bottom: 8px;
}

.block {
  display: block;
}

.strong {
  font-weight: 500;
}

.diff-title {
  font-size: 15px;
  margin-bottom: 10px;
}

.diff-body {
  font-size: 13px;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-wrap: anywhere;
}

/* The summary is a sentence, so it is set in Plex Sans; only the changed lines are literal. */
.diff-body > .secondary {
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  font-size: 14px;
}

.line {
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--ink);
}

.line--a {
  background: var(--arm-a-soft);
}

.line--b {
  background: var(--arm-b-soft);
}

.line--a .side {
  color: var(--arm-a-ink);
  font-weight: 500;
}

.line--b .side {
  color: var(--arm-b-ink);
  font-weight: 500;
}

.start {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.arm-list {
  gap: 8px;
}

.row-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.small-input {
  width: 88px;
}

.btn--big {
  min-height: 48px;
  font-weight: 600;
}

.error {
  color: var(--error);
}

.head-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: 320px;
  text-align: right;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.side-col {
  gap: 24px;
}

.run-arms {
  margin-top: 14px;
}

.budget-note {
  margin-top: 10px;
}

.checks--inside {
  padding-bottom: 8px;
}

.checks--inside .check-row:last-child {
  border-bottom: 0;
}

.diff-body--inside {
  padding-bottom: 16px;
}

/* The API's own terms (field paths, short hashes), kept behind a Details disclosure. */
.check-details {
  margin-top: 6px;
  display: grid;
  gap: 4px;
}

.check-details summary {
  cursor: pointer;
  color: var(--ink-2);
}

.check-raw {
  margin: 6px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--ink-2);
}

.example-arms {
  grid-column: 1 / -1;
  margin: 0;
}

.grid-wrap {
  padding: 18px 20px;
  min-width: 0;
}

.legend {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
  color: var(--ink-2);
}

.legend-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
}

/* The ring around a re-run cell clears its own label. */
.legend .cell--retried {
  margin-inline: 4px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.grid-scroll {
  position: relative;
  overflow-x: auto;
}

.run-grid {
  border-collapse: separate;
  border-spacing: 4px;
  font-size: 13px;
}

.run-grid thead th {
  color: var(--ink-2);
  font-weight: 500;
  text-align: left;
}

.task-col {
  padding-right: 12px;
}

.task-name {
  text-align: left;
  font-weight: 400;
  font-size: 12px;
  padding-right: 12px;
  white-space: nowrap;
}

.run-grid td {
  padding: 0;
  vertical-align: top;
}

.run-grid .gap {
  padding-left: 14px;
}

/* An arm's trials, in a row that wraps when the screen is too narrow for both arms side by side. */
.cells {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  vertical-align: middle;
}

.cell--pass {
  background: var(--pass);
  color: var(--on-pass);
}

.cell--fail {
  background: var(--fail);
  color: var(--on-pass);
}

.cell--ungraded {
  background: var(--surface-muted);
  box-shadow: inset 0 0 0 1px var(--rule-strong);
}

.cell--running {
  box-shadow: inset 0 0 0 2px var(--ink);
}

.cell--waiting,
.cell--cancelled {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--rule);
}

/* Pending, so an outline: re-queued after an infra failure. */
.cell--infra {
  border: 1px dashed var(--ink-2);
  color: var(--ink-2);
}

/* Finished states are filled: the slot gave up, or its infra failure is never re-run (D26), with
   no result (an en dash). */
.cell--abandoned,
.cell--final {
  background: var(--neutral-mark-strong);
  color: var(--surface);
  border: 1px dashed var(--ink-2);
}

/* Done and graded, but a required check gave no verdict: neither pass nor fail. */
.cell--incomplete {
  background: var(--surface-muted);
  box-shadow: inset 0 0 0 1px var(--ink-2);
  color: var(--ink);
}

/* Done, and its task has no graders: nothing to pass or fail. */
.cell--nograders {
  background: var(--surface-muted);
  color: var(--ink-2);
}

/* Passed or failed on a re-run after an infra failure: the history stays visible as a ring. */
.cell--retried {
  outline: 1.5px dashed var(--ink-2);
  outline-offset: 2px;
}

/* The legend's own width never sets the panel's: the panel hugs the grid. */
.legend {
  width: 0;
  min-width: 100%;
}

@media (min-width: 1024px) {
  .cell {
    width: 28px;
    height: 28px;
  }

  .cell :deep(svg) {
    width: 16px;
    height: 16px;
  }

  .run-grid {
    border-spacing: 6px;
  }

  .cells {
    flex-wrap: nowrap;
    gap: 6px;
  }

  .run-grid .gap {
    padding-left: 28px;
  }

  .split > .grid-wrap {
    flex: 0 1 auto;
    width: fit-content;
    max-width: 100%;
  }
}

.sub-title {
  font-size: 15px;
  margin-bottom: 8px;
}

@media (max-width: 640px) {
  .head-actions {
    align-items: flex-start;
    text-align: left;
  }

  /* The draft's figures never outgrow the 26 px phone h1. */
  .plan .stat-value {
    font-size: 26px;
  }

  /* A 2 x 2 grid, kept to about a third of the screen. */
  .plan.plan--past {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .plan--past > * {
    padding: 12px 14px;
  }

  .plan--past .stat-label,
  .plan--past .stat-note {
    font-size: 13px;
  }

  .run-grid .arm-col {
    white-space: nowrap;
  }

  .run-grid .arm-rest {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  .grid-wrap {
    padding: 14px 12px;
  }

  .run-grid {
    border-spacing: 3px;
  }

  .cells {
    gap: 3px;
  }

  .run-grid .gap {
    padding-left: 8px;
  }

  /* The task name may break after a hyphen, so the arms keep the width. */
  .task-name {
    font-size: 11px;
    padding-right: 6px;
    white-space: normal;
    overflow-wrap: anywhere;
    min-width: 8ch;
  }

  .run-grid .cell {
    width: 16px;
    height: 16px;
  }

  .run-grid .cell :deep(svg) {
    width: 11px;
    height: 11px;
  }

  .run-grid .cell--retried {
    outline-offset: 1px;
  }
}

.spend-now {
  font-size: 26px;
  font-weight: 600;
}

/* Drawn at about its own scale: the column can be wide, and the labels grow with the drawing. */
.spend-bar {
  margin-top: 8px;
  display: block;
  max-width: 360px;
  overflow: visible;
}

.track {
  fill: var(--track);
}

.fill {
  fill: var(--ink);
}

.mark {
  stroke: var(--ink);
  stroke-width: 1.5;
}

/* Solid grey: dashes mean infra and zero lines only. */
.mark--cap {
  stroke: var(--ink-2);
}

.mark-label {
  font-size: 11px;
  fill: var(--ink-2);
}

.mark-label--ink {
  fill: var(--ink);
}

.events {
  list-style: none;
  margin: 0;
  padding: 0;
}

.events li {
  display: grid;
  grid-template-columns: 48px 1fr;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--track);
}
</style>
