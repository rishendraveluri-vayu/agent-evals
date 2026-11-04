<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { api } from '../api/client';
import { errorText } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { Config, ConfigDiffEntry, Estimate, ExperimentDetail, ExperimentTrial, Harness, ModelInfo, Prompt, TaskInfo } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import { armsOf, timeLeft, totalTrials } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { armsCheck, axisFromDiff, budgetCheck, capabilityCheck, contentDiff, planCheck, splitCheck, type Check } from '../lib/checks';
import { changedLineCount, lineChanges, sentenceChanges, type LineChange } from '../lib/diff';
import { clock, minutes, money, shortHash, wholeMoney } from '../lib/format';
import { modelName, splitName } from '../lib/names';
import { href, navigate } from '../router';
import { text } from '../trials';

const props = defineProps<{ experimentId?: string; a?: string | null; b?: string | null }>();
const draft = !props.experimentId;
const fixtures = isFixtureMode();

interface Loaded {
  configs: Config[];
  allTasks: TaskInfo[];
  models: ModelInfo[];
  harnesses: Harness[];
  prompts: Prompt[];
  experiment: ExperimentDetail | null;
  trials: ExperimentTrial[];
}

const { data, error, loading, reload } = useLoad<Loaded>(async () => {
  const [harnesses, prompts] = await Promise.all([optional(api.harnesses(), [] as Harness[]), optional(api.prompts(), [] as Prompt[])]);
  if (props.experimentId) {
    const [experiment, trials, allTasks] = await Promise.all([
      api.experiment(props.experimentId),
      optional(api.experimentTrials(props.experimentId), [] as ExperimentTrial[]),
      optional(api.tasks(), [] as TaskInfo[]),
    ]);
    return { configs: experiment.configs, allTasks: allTasks.length ? allTasks : experiment.tasks, models: [], harnesses, prompts, experiment, trials };
  }
  const [configs, allTasks, models] = await Promise.all([api.configs(), api.tasks(), optional(api.models(), [] as ModelInfo[])]);
  return { configs, allTasks, models, harnesses, prompts, experiment: null, trials: [] };
});

// ---------------------------------------------------------------- what is being run

const setup = reactive({ a: props.a ?? '', b: props.b ?? '', split: 'heldout', n: 5, simModel: '', budget: '', plan: '', name: '' });
const touched = reactive({ budget: false, name: false });

watch(data, (d) => {
  if (!d || !draft || setup.simModel) return;
  if (!setup.a) setup.a = d.configs[d.configs.length - 1]?.hash ?? '';
  if (!setup.b) setup.b = d.configs.find((c) => c.hash !== setup.a)?.hash ?? setup.a;
  setup.simModel = d.models[0]?.name ?? '';
  if (!d.allTasks.some((t) => t.split === setup.split)) setup.split = 'all';
});

const hashes = computed<string[]>(() => (draft ? [setup.a, setup.b].filter(Boolean) : (data.value?.experiment?.config_hashes ?? [])));
const configOf = (h: string) => data.value?.configs.find((c) => c.hash === h);
const sameConfig = computed(() => hashes.value.length === 2 && hashes.value[0] === hashes.value[1]);
const tasks = computed<TaskInfo[]>(() => {
  const d = data.value;
  if (!d) return [];
  if (!draft) return d.experiment?.tasks ?? [];
  return setup.split === 'all' ? d.allTasks : d.allTasks.filter((t) => t.split === setup.split);
});
const splits = computed(() => [...new Set(data.value?.allTasks.map((t) => t.split) ?? [])]);
const n = computed(() => (draft ? Math.max(1, Math.round(Number(setup.n) || 1)) : (data.value?.experiment?.n ?? 0)));

const diff = ref<ConfigDiffEntry[]>([]);
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
  const configs = hashes.value.map(configOf).filter((c): c is Config => !!c);
  const plan = draft ? setup.plan : d.experiment?.plan_commit;
  const list = [
    ...(hashes.value.length === 2 ? [armsCheck(diff.value, sameConfig.value)] : []),
    capabilityCheck(configs, d.harnesses),
    planCheck(plan),
    splitCheck(tasks.value, d.allTasks),
  ];
  if (draft || d.experiment?.budget_usd !== undefined) list.push(budgetCheck(budget.value, estimate.value));
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
      plan_commit: setup.plan.trim(),
    });
    await api.startExperiment(created.id);
    navigate(href.run(created.id));
  } catch (err) {
    actionError.value = errorText(err);
  } finally {
    busy.value = false;
  }
}

async function act(kind: 'start' | 'cancel') {
  const id = props.experimentId;
  if (!id) return;
  busy.value = true;
  actionError.value = null;
  try {
    await (kind === 'start' ? api.startExperiment(id) : api.cancelExperiment(id));
    await reload();
  } catch (err) {
    actionError.value = errorText(err);
  } finally {
    busy.value = false;
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

const isInfraStop = (t: ExperimentTrial) => t.status === 'infra_failed' || t.status === 'abandoned';

/** A slot's state is its latest attempt's; `hadInfra` keeps the history, so a slot that was
 *  stopped by an infra failure and then re-run still says so once it has passed or failed. */
function slotState(attempts: ExperimentTrial[]): { state: CellState; hadInfra: boolean } {
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
    arms: e.config_hashes.slice(0, 2).map((h, arm) =>
      Array.from({ length: e.n }, (_, r) => {
        const repeat = twice ? r + arm * e.n : r;
        const attempts = trials
          .filter((x) => (x.task === t.sha256 || x.task === t.id) && x.config === h && x.repeat_index === repeat)
          .sort((x, y) => x.attempt - y.attempt);
        const { state, hadInfra } = slotState(attempts);
        const tries = attempts.length ? Math.max(...attempts.map((x) => x.attempt)) : 0;
        const words = state === 'abandoned' ? `infra failure, gave up after ${tries} ${tries === 1 ? 'attempt' : 'attempts'}` : CELL_WORDS[state];
        const retried = hadInfra && (state === 'pass' || state === 'fail');
        return { state, retried, attempts, label: `${t.id}, arm ${arm === 0 ? 'A' : 'B'}, trial ${r + 1}: ${words}${retried ? ', after an infra failure' : ''}` };
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
  const byArm = { a: 0, b: 0 };
  for (const row of grid.value) {
    row.arms.forEach((cells, arm) => {
      for (const c of cells) {
        c.attempts.forEach((a, k) => {
          if (!isInfraStop(a)) return;
          stops.total += 1;
          byArm[arm === 0 ? 'a' : 'b'] += 1;
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
function armsWords(byArm: { a: number; b: number }, total: number): string {
  const only = byArm.a === 0 ? 'B' : byArm.b === 0 ? 'A' : null;
  if (!only) return `A ${byArm.a}, B ${byArm.b}`;
  if (total === 1) return `in arm ${only}`;
  return `${total === 2 ? 'both' : 'all'} in arm ${only}`;
}

const slotCount = computed(() => grid.value.reduce((sum, row) => sum + row.arms.flat().length, 0));

const tallyText = computed(() => {
  const t = tally.value;
  const parts = [`${t.done} done`, `${t.running} running`, `${t.waiting} waiting`];
  const s = t.stops;
  if (s.total) {
    const noun = `${s.total} infra ${s.total === 1 ? 'failure' : 'failures'}`;
    if (s.requeued === s.total) parts.push(`${noun} re-queued`);
    else parts.push(`${noun}: ${[s.rerun ? `${s.rerun} re-run` : '', s.requeued ? `${s.requeued} re-queued` : '', s.gaveUp ? `${s.gaveUp} gave up` : ''].filter(Boolean).join(', ')}`);
    parts.push(armsWords(t.byArm, s.total));
  }
  if (t.cancelled) parts.push(`${t.cancelled} cancelled`);
  const e = data.value?.experiment;
  if (e?.status === 'running') {
    const left = timeLeft(e.estimate, t.done, slotCount.value || totalTrials(e));
    if (left !== null) parts.push(`about ${minutes(left)} left`);
  }
  return parts.join(', ');
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
    if (status === 'running' && !fixtures) timer = setInterval(() => void reload(), 5000);
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
  if (e.status === 'done' || e.status === 'finished') return `Run finished: ${done} of ${total}`;
  if (e.status === 'cancelled') return `Run cancelled: ${done} of ${total} done`;
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
      <template v-if="data.experiment.status === 'running'">
        <button
          type="button"
          class="btn btn--quiet"
          :disabled="busy"
          data-test="cancel"
          @click="act('cancel')"
        >
          Cancel the waiting trials
        </button>
        <p class="secondary smaller">
          Running trials finish; waiting ones are marked cancelled and kept.
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
          <span class="stat-note">{{ estimate?.concurrency ? `${estimate.concurrency} trials at a time` : '' }}</span>
        </div>
        <div>
          <span class="stat-label">Smallest difference it can see</span>
          <span class="stat-value">{{ estimate?.min_detectable_effect ? `${estimate.min_detectable_effect.points} points` : '–' }}</span>
          <span class="stat-note">{{ estimate?.min_detectable_effect ? `${Math.round(estimate.min_detectable_effect.power * 10)} times in 10, from the pilot's spread` : 'Not estimated yet: the power estimate comes with the statistics step' }}</span>
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
                <select v-model="setup.simModel">
                  <option
                    v-for="m in data.models"
                    :key="m.name"
                    :value="m.name"
                  >{{ modelName(m.name) }}</option>
                </select>
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
        aria-labelledby="progress"
        class="progress"
      >
        <div class="head-row head-row--baseline">
          <h2
            id="progress"
            class="section-title"
          >
            Progress
          </h2>
          <p
            class="secondary small num"
            data-test="tally"
          >
            {{ tallyText }}
          </p>
        </div>
        <div class="split">
          <div class="grow panel grid-wrap">
            <div
              class="legend smaller"
              data-test="grid-legend"
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
              <span class="legend-item"><span class="cell cell--infra">!</span>Infra, re-queued</span>
              <span class="legend-item"><span class="cell cell--pass cell--retried"><AppIcon
                name="check"
                :size="13"
              /></span>Re-run after infra</span>
              <span class="legend-item"><span class="cell cell--abandoned">!</span>Infra, gave up</span>
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
                      <span class="arm"><span :class="`dot dot--${arm.key}`" />{{ arm.key.toUpperCase() }}, {{ arm.label }}</span>
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
                        /><template v-else-if="c.state === 'infra' || c.state === 'abandoned'">!</template><span class="visually-hidden">{{ c.label }}</span></span>
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
              </div>
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
                  v-for="(e, i) in data.experiment.events"
                  :key="i"
                >
                  <span class="secondary num">{{ clock(e.at) }}</span>
                  <span>{{ e.message }}</span>
                </li>
              </ol>
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
        <div
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
            <span class="stat-note">{{ estimate ? `Likely ${money(estimate.cost_usd.low)} to ${money(estimate.cost_usd.high)}` : '' }}</span>
          </div>
          <div>
            <span class="stat-label">Estimated time</span>
            <span class="stat-value">{{ estimate ? minutes(estimate.minutes) : '–' }}</span>
            <span class="stat-note">{{ estimate?.concurrency ? `${estimate.concurrency} trials at a time` : '' }}</span>
          </div>
          <div>
            <span class="stat-label">Smallest difference it can see</span>
            <span class="stat-value">{{ estimate?.min_detectable_effect ? `${estimate.min_detectable_effect.points} points` : '–' }}</span>
            <span class="stat-note">{{ estimate?.min_detectable_effect ? `${Math.round(estimate.min_detectable_effect.power * 10)} times in 10, from the pilot's spread` : 'Not estimated yet: the power estimate comes with the statistics step' }}</span>
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
.plan {
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
}

.plan .stat-value {
  font-size: 34px;
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

.head-row--baseline {
  align-items: baseline;
}

.grid-wrap {
  padding: 18px 20px;
  min-width: 0;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-bottom: 14px;
  color: var(--ink-2);
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

.cell--infra,
.cell--abandoned {
  border: 1px dashed var(--ink-2);
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

.mark--cap {
  stroke: var(--ink-2);
  stroke-dasharray: 3 2;
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
