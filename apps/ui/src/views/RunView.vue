<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { api } from '../api/client';
import { errorText } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { Config, ConfigDiffEntry, Estimate, ExperimentDetail, ExperimentTrial, Harness, ModelInfo, Prompt, TaskInfo } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import { armsOf } from '../lib/arms';
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

type CellState = 'pass' | 'fail' | 'ungraded' | 'running' | 'waiting' | 'infra' | 'cancelled';
const CELL_WORDS: Record<CellState, string> = {
  pass: 'passed',
  fail: 'failed',
  ungraded: 'done, not graded',
  running: 'running',
  waiting: 'waiting',
  infra: 'stopped on an infra failure, re-queued',
  cancelled: 'cancelled',
};

function slotState(attempts: ExperimentTrial[]): CellState {
  if (!attempts.length) return 'waiting';
  const latest = attempts.reduce((x, y) => (y.attempt > x.attempt ? y : x));
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
    default:
      return 'infra';
  }
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
        const attempts = trials.filter((x) => (x.task === t.sha256 || x.task === t.id) && x.config === h && x.repeat_index === repeat);
        const state = slotState(attempts);
        return { state, label: `${t.id}, arm ${arm === 0 ? 'A' : 'B'}, trial ${r + 1}: ${CELL_WORDS[state]}` };
      }),
    ),
  }));
});

const tally = computed(() => {
  const all = grid.value.flatMap((row) => row.arms.flat());
  const of = (...s: CellState[]) => all.filter((c) => s.includes(c.state)).length;
  const infraTrials = (data.value?.trials ?? []).filter((t) => t.status === 'infra_failed' || t.status === 'abandoned');
  const provider = infraTrials.length > 0 && infraTrials.every((t) => t.label === 'infra:provider_error');
  return { done: of('pass', 'fail', 'ungraded'), running: of('running'), waiting: of('waiting'), infra: of('infra'), cancelled: of('cancelled'), provider };
});

const tallyText = computed(() => {
  const t = tally.value;
  const parts = [`${t.done} done`, `${t.running} running`, `${t.waiting} waiting`];
  if (t.infra) parts.push(`${t.infra} stopped ${t.provider ? 'by the provider' : 'on infra failures'} and re-queued`);
  if (t.cancelled) parts.push(`${t.cancelled} cancelled`);
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

const planNote = computed(() => {
  const e = estimate.value;
  if (!e) return '';
  const t = tasks.value.length;
  return `${t} ${t === 1 ? 'task' : 'tasks'} × ${hashes.value.length} ${hashes.value.length === 1 ? 'arm' : 'arms'} × ${n.value} ${n.value === 1 ? 'trial' : 'trials'}`;
});
</script>

<template>
  <div class="page-head">
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a :href="href.experiments()">Experiments</a> / {{ data?.experiment?.name ?? (setup.name || 'New experiment') }}
    </nav>
    <h1 tabindex="-1">
      Check and run
    </h1>
    <p class="lede">
      Nothing starts unless the run can finish. The estimates come from {{ estimate?.basis ? estimate.basis.charAt(0).toLowerCase() + estimate.basis.slice(1) : 'earlier trials and the prices in LiteLLM' }}.
    </p>
  </div>

  <LoadState
    :loading="loading && !data"
    :error="error"
    what="the run"
  >
    <template v-if="data">
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
                  >Config {{ shortHash(c.hash) }}, {{ c.name }}</option>
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
                  >Config {{ shortHash(c.hash) }}, {{ c.name }}</option>
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
            {{ draft || data.experiment?.status === 'created' ? 'Start the run' : 'The run' }}
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
            >
              Every check above has to pass first.
            </p>
          </template>
          <template v-else-if="data.experiment">
            <button
              v-if="data.experiment.status === 'created'"
              type="button"
              class="btn btn--big"
              :disabled="busy || !allPass"
              data-test="start"
              @click="act('start')"
            >
              Start {{ estimate?.trials ?? '' }} trials
            </button>
            <template v-else-if="data.experiment.status === 'running'">
              <p class="small">
                Running since {{ clock(data.experiment.started_at ?? data.experiment.created_at) }}.
              </p>
              <button
                type="button"
                class="btn btn--quiet"
                :disabled="busy"
                @click="act('cancel')"
              >
                Cancel the waiting trials
              </button>
              <p class="secondary smaller">
                Running trials finish; waiting ones are marked cancelled and kept.
              </p>
            </template>
            <template v-else>
              <p class="small">
                {{ data.experiment.status === 'cancelled' ? 'Cancelled.' : 'Finished.' }}
              </p>
              <a
                :href="href.compare(data.experiment.id)"
                class="btn"
              >Open the comparison</a>
            </template>
          </template>
        </aside>
      </div>

      <section
        v-if="data.experiment && data.experiment.status !== 'created'"
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
            <div class="legend smaller">
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
                          :class="`cell cell--${c.state}`"
                          :title="c.label"
                          :data-state="c.state"
                        ><AppIcon
                          v-if="c.state === 'pass'"
                          name="check"
                          :size="13"
                        /><AppIcon
                          v-else-if="c.state === 'fail'"
                          name="cross"
                          :size="12"
                        /><template v-else-if="c.state === 'infra'">!</template><span class="visually-hidden">{{ c.label }}</span></span>
                      </td>
                    </template>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="side stack">
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

.setup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px 20px;
  margin-top: 14px;
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
  color: var(--fail);
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-top: 1px solid var(--rule);
  padding-top: 28px;
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
  background: var(--fail-cell);
  color: var(--fail);
}

.cell--ungraded {
  background: var(--surface-muted);
  box-shadow: inset 0 0 0 1px var(--rule-strong);
}

.cell--running {
  box-shadow: inset 0 0 0 2px var(--arm-a);
}

.cell--waiting,
.cell--cancelled {
  background: var(--surface-muted);
}

.cell--infra {
  border: 1px dashed var(--ink-2);
  color: var(--ink-2);
}

.sub-title {
  font-size: 15px;
  margin-bottom: 8px;
}

@media (max-width: 640px) {
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
}

.spend-now {
  font-size: 26px;
  font-weight: 600;
}

.spend-bar {
  margin-top: 8px;
  display: block;
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
