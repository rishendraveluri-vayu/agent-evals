<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { api } from '../api/client';
import { errorText, errorWithFix } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { ConfigView, ConfigDiffEntry, Estimate, ExperimentDetail, TrialRowSummary, Harness, ModelView, PromptView, TaskView } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import { armIndexOf, armsOf, timeLeft, totalTrials } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { armsCheck, axisFromDiff, budgetCheck, capabilityCheck, contentDiff, planCheck, splitCheck, type Check } from '../lib/checks';
import { changedLineCount, lineChanges, sentenceChanges, type LineChange } from '../lib/diff';
import { capitalise, clock, minutes, money, plural, shortHash, wholeMoney } from '../lib/format';
import { modelName, splitName } from '../lib/names';
import { href, navigate } from '../router';
import { eventView, pauseCause } from '../lib/runs';
import { FAKE_SIM_MODEL, isFake, simModels } from '../lib/models';
import { text } from '../trials';

const props = defineProps<{ experimentId?: string; a?: string | null; b?: string | null }>();
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

const { data, error, loading, reload } = useLoad<Loaded>(async () => {
  const [harnesses, prompts] = await Promise.all([optional(api.harnesses(), [] as Harness[]), optional(api.prompts(), [] as PromptView[])]);
  if (props.experimentId) {
    const [experiment, trials, allTasks] = await Promise.all([
      api.experiment(props.experimentId),
      optional(api.experimentTrials(props.experimentId), [] as TrialRowSummary[]),
      optional(api.tasks(), [] as TaskView[]),
    ]);
    return { configs: experiment.configs, allTasks: allTasks.length ? allTasks : experiment.tasks, models: [], harnesses, prompts, experiment, trials };
  }
  const [configs, allTasks, models] = await Promise.all([api.configs(), api.tasks(), optional(api.models(), [] as ModelView[])]);
  return { configs, allTasks, models, harnesses, prompts, experiment: null, trials: [] };
});

// ---------------------------------------------------------------- what is being run

const setup = reactive({ a: props.a ?? '', b: props.b ?? '', split: 'held_out', n: 5, simModel: '', budget: '', plan: '', name: '', seed: '' });
const touched = reactive({ budget: false, name: false, sim: false });
/** Tasks taken out of the run by hand, by sha256. Engine tests start out of it. */
const excluded = reactive(new Set<string>());
const isEngineTest = (t: TaskView) => t.summary.startsWith('ENGINE TEST ONLY');

watch(data, (d) => {
  if (!d || !draft || setup.simModel) return;
  // GET /configs lists the oldest first: arm A defaults to the oldest, the baseline.
  if (!setup.a) setup.a = d.configs[0]?.hash ?? '';
  // An arm B passed as empty in the address means a one-arm run.
  if (!setup.b && props.b !== '') setup.b = d.configs.find((c) => c.hash !== setup.a)?.hash ?? setup.a;
  setup.simModel = defaultSim.value;
  if (!d.allTasks.some((t) => t.split === setup.split)) setup.split = 'all';
  for (const t of d.allTasks) if (isEngineTest(t)) excluded.add(t.sha256);
});

const hashes = computed<string[]>(() => (draft ? [setup.a, setup.b].filter(Boolean) : (data.value?.experiment?.config_hashes ?? [])));
/** Every arm on a fake model: the run is free, and the simulated client defaults to the fake one. */
const allFake = computed(() => hashes.value.length > 0 && hashes.value.every((h) => isFake(data.value?.configs.find((c) => c.hash === h)?.model)));
const defaultSim = computed(() => (allFake.value ? FAKE_SIM_MODEL : (data.value?.models[0]?.name ?? FAKE_SIM_MODEL)));
watch(defaultSim, (v) => {
  if (draft && !touched.sim && setup.simModel) setup.simModel = v;
});
const simGroups = computed(() => simModels(data.value?.models ?? []));
/** What this run calls that costs money, for the start panel. */
const realModels = computed(() => {
  const models = hashes.value.map((h) => data.value?.configs.find((c) => c.hash === h)?.model).filter((m): m is string => !!m && !isFake(m));
  const conversation = tasks.value.some((t) => t.kind === 'conversation');
  if (conversation && setup.simModel && !isFake(setup.simModel)) models.push(setup.simModel);
  return [...new Set(models)];
});
const configOf = (h: string) => data.value?.configs.find((c) => c.hash === h);
const sameConfig = computed(() => hashes.value.length === 2 && hashes.value[0] === hashes.value[1]);
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
const n = computed(() => (draft ? Math.max(1, Math.round(Number(setup.n) || 1)) : (data.value?.experiment?.n ?? 0)));

const diff = shallowRef<ConfigDiffEntry[]>([]);
watch(
  () => [hashes.value[0], hashes.value[1]],
  async ([a, b]) => {
    diff.value = a && b && a !== b ? await optional(api.configDiff(a, b), []) : [];
  },
  { immediate: true },
);
const axis = computed(() => axisFromDiff(diff.value, sameConfig.value) ?? 'mixed');
const arms = computed(() => armsOf({ axis: draft ? axis.value : (data.value?.experiment?.axis ?? axis.value), config_hashes: hashes.value }, data.value?.configs ?? []));

const draftEstimate = ref<Estimate | null>(null);
const estimateError = ref<string | null>(null);
watch(
  () => [draft, hashes.value.join(','), tasks.value.map((t) => t.sha256).join(','), n.value, setup.simModel] as const,
  async () => {
    if (!draft || !hashes.value.length || !tasks.value.length) return;
    try {
      draftEstimate.value = await api.estimate({ config_hashes: hashes.value, task_sha256s: tasks.value.map((t) => t.sha256), n: n.value, sim_model: setup.simModel || null });
      estimateError.value = null;
      if (!touched.budget) setup.budget = String(Math.max(10, Math.round((draftEstimate.value.cost_usd.expected * 2) / 10) * 10));
    } catch (err) {
      estimateError.value = errorText(err);
    }
  },
  { immediate: true },
);
const estimate = computed(() => (draft ? draftEstimate.value : (data.value?.experiment?.estimate ?? null)));
const budget = computed(() => (draft ? Number(setup.budget) || 0 : data.value?.experiment?.budget_usd));

const suggestedName = computed(() => {
  const [a, b] = arms.value;
  if (!a) return '';
  const split = setup.split === 'all' ? 'all tasks' : splitName(setup.split);
  if (sameConfig.value) return `A/A check, ${a.label}`;
  return b ? `${a.label} vs ${b.short}, ${split}` : `${a.label}, ${split}`;
});
watch(suggestedName, (v) => {
  if (!touched.name) setup.name = v;
});

// ---------------------------------------------------------------- checks

const checks = computed<Check[]>(() => {
  const d = data.value;
  if (!d) return [];
  const configs = hashes.value.map(configOf).filter((c): c is ConfigView => !!c);
  const plan = draft ? setup.plan : d.experiment?.plan_commit;
  const list = [
    ...(hashes.value.length === 2 ? [armsCheck(diff.value, sameConfig.value)] : []),
    capabilityCheck(configs, d.harnesses),
    // A plan is committed before a run that measures something; a run on fake models only tries the platform out.
    allFake.value && draft ? { ok: true, title: 'No analysis plan needed: every arm runs on a fake model', detail: 'A fake run tries the platform out; it measures nothing about a real agent.' } : planCheck(plan),
    splitCheck(tasks.value, d.allTasks),
  ];
  list.push(budgetCheck(budget.value, estimate.value));
  return list;
});
const allPass = computed(() => checks.value.length > 0 && checks.value.every((c) => c.ok));

/** Under a disabled Start: which checks stand in the way, by name. */
const startHelper = computed(() => {
  const failing = checks.value.filter((c) => !c.ok);
  const n = failing.length;
  if (!n) return 'Every check above has to pass first.';
  return `${n} check${n === 1 ? ' is' : 's are'} not passing: ${failing.map((c) => c.title).join('; ')}.`;
});

/** How the arms differ: the prompt's changed lines, or each differing field. */
const armDiff = computed<{ summary: string; lines: LineChange[] }>(() => {
  const content = contentDiff(diff.value);
  if (sameConfig.value) return { summary: 'The same config on both arms. Nothing differs.', lines: [] };
  if (!content.length) return { summary: 'Nothing differs.', lines: [] };
  const [ca, cb] = hashes.value.map(configOf);
  const pa = data.value?.prompts.find((p) => p.sha256 === ca?.prompt.sha256);
  const pb = data.value?.prompts.find((p) => p.sha256 === cb?.prompt.sha256);
  const promptOnly = content.every((d) => d.path.startsWith('prompt'));
  if (promptOnly && pa && pb) {
    const changed = changedLineCount(lineChanges(pa.text, pb.text));
    return { summary: `The system prompt, ${changed} ${changed === 1 ? 'line' : 'lines'} changed. Nothing else differs.`, lines: sentenceChanges(pa.text, pb.text) };
  }
  return {
    summary: `${content.length} ${content.length === 1 ? 'field differs' : 'fields differ'}.`,
    lines: content.flatMap((d) => [
      { side: 'a' as const, text: `${d.path}: ${text(d.a)}` },
      { side: 'b' as const, text: `${d.path}: ${text(d.b)}` },
    ]),
  };
});

// ---------------------------------------------------------------- start, cancel

const busy = ref(false);
const actionError = ref<string | null>(null);

async function startNew() {
  if (!allPass.value || !estimate.value) return;
  busy.value = true;
  actionError.value = null;
  try {
    const created = await api.createExperiment({
      name: setup.name.trim() || suggestedName.value,
      axis: axis.value,
      config_hashes: hashes.value,
      task_sha256s: tasks.value.map((t) => t.sha256),
      n: n.value,
      sim_model: setup.simModel || null,
      budget_usd: Number(setup.budget),
      plan_commit: setup.plan.trim() || null,
      ...(setup.seed.trim() !== '' && Number.isInteger(Number(setup.seed)) ? { order_seed: Number(setup.seed) } : {}),
    });
    await api.startExperiment(created.id);
    navigate(href.run(created.id));
  } catch (err) {
    actionError.value = errorText(err);
  } finally {
    busy.value = false;
  }
}

type RunAction = 'start' | 'pause' | 'resume' | 'stop';
const RUN_ACTIONS: Record<RunAction, (id: string) => Promise<unknown>> = {
  start: (id) => api.startExperiment(id),
  pause: (id) => api.pauseExperiment(id),
  resume: (id) => api.resumeExperiment(id),
  stop: (id) => api.stopExperiment(id),
};

/** Stop cancels every waiting trial for good, so it asks first. */
const confirmStop = ref(false);

async function act(kind: RunAction) {
  const id = props.experimentId;
  if (!id) return;
  busy.value = true;
  actionError.value = null;
  try {
    await RUN_ACTIONS[kind](id);
    confirmStop.value = false;
    await reload();
  } catch (err) {
    actionError.value = errorWithFix(err);
  } finally {
    busy.value = false;
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
    armError.value = { arm: letter, text: errorWithFix(err) };
  } finally {
    armBusy.value = null;
  }
}

// ---------------------------------------------------------------- progress

type CellState = 'pass' | 'fail' | 'ungraded' | 'running' | 'waiting' | 'infra' | 'abandoned' | 'cancelled';
const CELL_WORDS: Record<Exclude<CellState, 'abandoned'>, string> = {
  pass: 'passed',
  fail: 'failed',
  ungraded: 'done, not graded',
  running: 'running',
  waiting: 'waiting',
  infra: 'infra failure, re-queued',
  cancelled: 'cancelled',
};

const isInfraStop = (t: TrialRowSummary) => t.status === 'infra_failed' || t.status === 'abandoned';

/** A slot's state is its latest attempt's; `hadInfra` keeps the history, so a slot that was
 *  stopped by an infra failure and then re-run still says so once it has passed or failed. */
function slotState(attempts: TrialRowSummary[]): { state: CellState; hadInfra: boolean } {
  if (!attempts.length) return { state: 'waiting', hadInfra: false };
  const hadInfra = attempts.some(isInfraStop);
  const latest = attempts.reduce((x, y) => (y.attempt > x.attempt ? y : x));
  const state = ((): CellState => {
    switch (latest.status) {
      case 'done':
        return latest.passed === true ? 'pass' : latest.passed === false ? 'fail' : 'ungraded';
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
        return 'infra';
    }
  })();
  return { state, hadInfra };
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
        const words = state === 'abandoned' ? `infra failure, gave up after ${tries} ${tries === 1 ? 'attempt' : 'attempts'}` : CELL_WORDS[state];
        const retried = hadInfra && (state === 'pass' || state === 'fail');
        return { state, retried, attempts, label: `${t.id}, arm ${String.fromCharCode(65 + arm)}, trial ${r + 1}: ${words}${retried ? ', after an infra failure' : ''}` };
      }),
    ),
  }));
});

/** Infra failures are counted from the attempts, not from the latest states, so a finished run
 *  still reports them. Each was re-run, is re-queued, or gave up; `byArm` says where they fell. */
const tally = computed(() => {
  const all = grid.value.flatMap((row) => row.arms.flat());
  const of = (...s: CellState[]) => all.filter((c) => s.includes(c.state)).length;
  const stops = { total: 0, rerun: 0, requeued: 0, gaveUp: 0 };
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
          else if (!next || next.status === 'queued') stops.requeued += 1;
          else stops.rerun += 1;
        });
      }
    });
  }
  return { done: of('pass', 'fail', 'ungraded'), running: of('running'), waiting: of('waiting'), stops, byArm, cancelled: of('cancelled') };
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
        : `${noun}: ${[s.rerun ? `${s.rerun} re-run` : '', s.requeued ? `${s.requeued} re-queued` : '', s.gaveUp ? `${s.gaveUp} gave up` : ''].filter(Boolean).join(', ')}`;
    parts.push(`${how}, ${armsWords(t.byArm, s.total)}`);
  }
  if (t.cancelled) parts.push(`${t.cancelled} cancelled`);
  return parts.join(' · ');
});

/** Which infra states the grid holds, for the legend's second row: only those present. */
const infraInGrid = computed(() => {
  const cells = grid.value.flatMap((row) => row.arms.flat());
  return { requeued: cells.some((c) => c.state === 'infra'), retried: cells.some((c) => c.retried), gaveUp: cells.some((c) => c.state === 'abandoned') };
});
const showInfraLegend = computed(() => infraInGrid.value.requeued || infraInGrid.value.retried || infraInGrid.value.gaveUp);

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
  return { cause: capitalise(pauseCause(reason)), reason, at: e.paused_at };
});
const ARM_STATUS: Record<string, string> = { not_started: 'Not started', active: 'Running', paused: 'Paused', stopped: 'Stopped', complete: 'Complete' };
const armCards = computed(() =>
  (data.value?.experiment?.arms ?? []).map((a) => {
    const c = a.counts;
    const total = c.queued + c.running + c.done + c.infra_failed + c.abandoned + c.cancelled;
    const parts = [`${c.done} done`, c.running ? `${c.running} running` : '', c.queued ? `${c.queued} waiting` : '', c.infra_failed + c.abandoned ? `${c.infra_failed + c.abandoned} infra` : '', c.cancelled ? `${c.cancelled} cancelled` : ''];
    return {
      view: a,
      key: a.arm.toLowerCase(),
      status: ARM_STATUS[a.status] ?? a.status,
      counts: `${parts.filter(Boolean).join(', ')} of ${plural(total, 'trial row')}`,
      reused: a.reused_from ? `Reuses ${plural(a.reused_trials, 'finished trial')} of ${a.reused_from}` : '',
      canPause: a.status === 'active' || a.status === 'not_started',
      canResume: a.status === 'paused',
    };
  }),
);
const pausedArms = computed(() => armCards.value.filter((a) => a.view.status === 'paused'));

/** The simulated client's model, which every conversation in both arms runs against. */
const simClient = computed(() => (data.value?.experiment?.sim_model ? modelName(data.value.experiment.sim_model) : null));

/** The power tile's note. The API has no power estimate yet (SP6 adds `min_detectable_effect`). */
const powerNote = 'Not estimated yet: the power estimate comes with the statistics step';

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
  const b = budget.value;
  if (!b) return '';
  const e = estimate.value;
  const times = e && e.cost_usd.expected > 0 ? `, about ${Math.round((b / e.cost_usd.expected) * 10) / 10} times the estimate` : '';
  return `LiteLLM stops all spending at ${wholeMoney(b)}${times}. If it ever trips, the trials it stopped are reported as infra failures, not agent failures.`;
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
  const passed = checks.value.filter((c) => c.ok).length;
  const plan = data.value?.experiment?.plan_commit;
  return `Checked before the start: ${passed} of ${checks.value.length} passed${plan ? `, plan ${plan.slice(0, 7)}` : ''}`;
});

const diffSummary = computed(() => {
  if (sameConfig.value) return 'How the two arms differ: nothing, the same config twice';
  const n = contentDiff(diff.value).length;
  return `How the two arms differ: ${n} ${n === 1 ? 'field' : 'fields'}`;
});

const planNote = computed(() => {
  const e = estimate.value;
  if (!e) return '';
  const t = tasks.value.length;
  return `${t} ${t === 1 ? 'task' : 'tasks'} × ${hashes.value.length} ${hashes.value.length === 1 ? 'arm' : 'arms'} × ${n.value} ${n.value === 1 ? 'trial' : 'trials'}`;
});
</script>

<template>
  <div class="head-row">
    <div class="page-head">
      <nav
        aria-label="Breadcrumb"
        class="crumbs"
      >
        <a :href="href.experiments()">Experiments</a> / {{ data?.experiment?.name ?? (setup.name || 'New experiment') }}
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
        v-if="!started"
        class="lede"
      >
        Nothing starts unless the run can finish. The estimates come from {{ estimate?.basis ? estimate.basis.charAt(0).toLowerCase() + estimate.basis.slice(1) : 'earlier trials and the prices in LiteLLM' }}.
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
          <span class="stat-note">{{ estimate ? `Likely ${money(estimate.cost_usd.low)} to ${money(estimate.cost_usd.high)}` : (estimateError ?? '') }}</span>
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
            <div class="setup-grid">
              <label class="field">
                <span class="arm"><span class="dot dot--a" />Arm A</span>
                <select
                  v-model="setup.a"
                  data-test="arm-a"
                >
                  <option
                    v-for="c in data.configs"
                    :key="c.hash"
                    :value="c.hash"
                  >{{ c.name }} · {{ shortHash(c.hash) }}</option>
                </select>
              </label>
              <label class="field">
                <span class="arm"><span class="dot dot--b" />Arm B</span>
                <select
                  v-model="setup.b"
                  data-test="arm-b"
                >
                  <option value="">
                    None: one arm, a pilot
                  </option>
                  <option
                    v-for="c in data.configs"
                    :key="c.hash"
                    :value="c.hash"
                  >{{ c.name }} · {{ shortHash(c.hash) }}</option>
                </select>
              </label>
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
                    >{{ modelName(m.name) }}</option>
                  </optgroup>
                </select>
                <span class="secondary smaller">Plays the client in conversation tasks only.</span>
              </label>
              <label class="field">
                <span class="field-label">Name</span>
                <input
                  v-model="setup.name"
                  type="text"
                  @input="touched.name = true"
                >
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
              </label>
              <label class="field">
                <span class="field-label">Claim-order seed, optional</span>
                <input
                  v-model="setup.seed"
                  type="text"
                  inputmode="numeric"
                  class="mono"
                  placeholder="Random, and recorded"
                  data-test="order-seed"
                >
                <span class="secondary smaller">The trials run in an order shuffled from it, arms interleaved (D32).</span>
              </label>
              <fieldset
                class="field fieldset task-pick"
                data-test="task-pick"
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
            >
              <AppIcon
                :name="c.ok ? 'pass-badge' : 'fail-badge'"
                :size="22"
              />
              <span>
                <strong>{{ c.title }}</strong>
                <span class="visually-hidden">{{ c.ok ? 'Check passed.' : 'Check failed.' }}</span>
                <span class="secondary small block">{{ c.detail }}</span>
              </span>
            </div>
          </section>

          <section
            v-if="hashes.length === 2"
            aria-labelledby="armdiff"
            class="panel panel--pad arm-diff"
          >
            <h3
              id="armdiff"
              class="diff-title"
            >
              How the two arms differ
            </h3>
            <div class="mono diff-body">
              <div class="secondary">
                {{ armDiff.summary }}
              </div>
              <div
                v-for="(l, i) in armDiff.lines"
                :key="i"
                :class="`line line--${l.side}`"
              >
                <span class="side">{{ l.side.toUpperCase() }}</span>&nbsp; {{ l.text }}
              </div>
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
          <div class="stack arm-list">
            <span
              v-for="arm in arms"
              :key="arm.key"
              class="arm"
            ><span :class="`dot dot--${arm.key}`" /><span>{{ arm.key.toUpperCase() }}: {{ arm.label }}, config <span class="mono">{{ shortHash(arm.hash) }}</span></span></span>
          </div>
          <template v-if="draft">
            <label class="row-field">
              <span><span class="block strong">Trials per task and arm</span><span class="secondary smaller block">More trials, narrower intervals</span></span>
              <input
                v-model="setup.n"
                type="number"
                min="1"
                class="small-input num"
                data-test="n-input"
              >
            </label>
            <label class="row-field">
              <span><span class="block strong">Spending limit</span><span class="secondary smaller block">Set in LiteLLM for the whole run</span></span>
              <input
                v-model="setup.budget"
                type="number"
                min="1"
                class="small-input num"
                @input="touched.budget = true"
              >
            </label>
          </template>
          <p
            v-if="draft"
            class="small spend-kind"
            :class="{ 'spend-kind--real': realModels.length }"
            data-test="spend-kind"
          >
            <template v-if="realModels.length">
              <AppIcon
                name="alert"
                :size="14"
              /> Real models: {{ realModels.map(modelName).join(' and ') }}. This run costs real money and needs Rishi's go-ahead first (R8).
            </template>
            <template v-else>
              Every model here is fake: the run is free, and nothing it finds is about a real agent.
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
          >
            {{ actionError }}
          </p>
          <template v-if="draft">
            <button
              type="button"
              class="btn btn--big"
              :disabled="!allPass || busy"
              data-test="start"
              @click="startNew"
            >
              Start {{ estimate?.trials ?? '' }} trials
            </button>
            <p
              v-if="!allPass"
              class="secondary smaller"
              data-test="start-helper"
            >
              {{ startHelper }}
            </p>
          </template>
          <button
            v-else-if="data.experiment"
            type="button"
            class="btn btn--big"
            :disabled="busy || !allPass"
            data-test="start"
            @click="act('start')"
          >
            Start {{ estimate?.trials ?? '' }} trials
          </button>
        </aside>
      </div>
    </template>

    <template v-else-if="data && data.experiment">
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
              <span class="arm"><span :class="`dot dot--${card.key}`" /><span><strong>Arm {{ card.view.arm }}</strong>: {{ card.view.config_name }}</span></span>
              <span
                class="pill pill--small pill--outline arm-status"
                :data-status="card.view.status"
              >{{ card.status }}</span>
            </div>
            <p class="secondary small num">
              {{ card.counts }}<template v-if="card.reused">
                . {{ card.reused }}
              </template>
            </p>
            <template v-if="card.view.status === 'paused'">
              <p
                class="small arm-reason"
                data-test="arm-reason"
              >
                <strong>Why:</strong> {{ card.view.paused_reason ?? 'paused' }}
              </p>
              <p
                v-if="card.view.fix"
                class="small arm-fix"
                data-test="arm-fix"
              >
                <strong>How to fix it:</strong> {{ card.view.fix }}
              </p>
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
          A paused arm claims nothing more; the other arm keeps running. There is no comparison until every arm is complete (D37).
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
                      v-for="arm in arms"
                      :key="arm.key"
                      scope="colgroup"
                      :colspan="data.experiment.n"
                      class="arm-col"
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
                    <template
                      v-for="(cells, ai) in row.arms"
                      :key="ai"
                    >
                      <td
                        v-for="(c, ci) in cells"
                        :key="ci"
                        :class="{ gap: ai > 0 && ci === 0 }"
                      >
                        <span
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
                        /><template v-else-if="c.state === 'infra'">!</template><template v-else-if="c.state === 'abandoned'">–</template><span class="visually-hidden">{{ c.label }}</span></span>
                      </td>
                    </template>
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
                  v-for="arm in arms"
                  :key="arm.key"
                  class="arm"
                ><span :class="`dot dot--${arm.key}`" /><span>{{ arm.key.toUpperCase() }}: {{ arm.label }}, config <span class="mono">{{ shortHash(arm.hash) }}</span></span></span>
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
          <span v-if="data.experiment.order_seed !== null && data.experiment.order_seed !== undefined">Claim order shuffled from seed <span class="mono">{{ data.experiment.order_seed }}</span>, arms interleaved (D32). </span>
          <span v-if="data.experiment.futility">{{ data.experiment.futility.enabled ? `Futility check on: pauses for review if an arm passes fewer than ${data.experiment.futility.min_passed} of its first ${data.experiment.futility.after} finished trials; it never stops on an apparent win.` : 'Futility check off.' }} </span>
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
            <span class="stat-note">{{ estimate ? `Likely ${money(estimate.cost_usd.low)} to ${money(estimate.cost_usd.high)}` : '' }}</span>
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
          >
            <AppIcon
              :name="c.ok ? 'pass-badge' : 'fail-badge'"
              :size="22"
            />
            <span>
              <strong>{{ c.title }}</strong>
              <span class="visually-hidden">{{ c.ok ? 'Check passed.' : 'Check failed.' }}</span>
              <span class="secondary small block">{{ c.detail }}</span>
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
            v-for="(l, i) in armDiff.lines"
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
.task-pick {
  display: grid;
  gap: 4px;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;
}

@media (min-width: 720px) {
  .task-pick {
    grid-column: 1 / -1;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  }
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
}

.run-grid td.gap {
  padding-left: 14px;
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

/* Finished states are filled: the slot gave up, with no result (an en dash). */
.cell--abandoned {
  background: var(--neutral-mark-strong);
  color: var(--surface);
  border: 1px dashed var(--ink-2);
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

  .run-grid td.gap {
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

  .run-grid td.gap {
    padding-left: 8px;
  }

  .task-name {
    font-size: 11px;
    padding-right: 6px;
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
