<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api/client';
import type { Compare, ExperimentSummary, ExperimentDetail, TaskView } from '../api/types';
import LoadState from '../components/LoadState.vue';
import VerdictTag from '../components/VerdictTag.vue';
import { armsOf, armState, noDiffWords, passedText, type Verdict } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { clientKind, experimentName, gradedBy, graderKinds, graderName, splitName } from '../lib/names';
import { isEngineTest } from '../lib/runSetup';
import { href } from '../router';

const { data, error, loading } = useLoad(async () => {
  const [tasks, experiments] = await Promise.all([api.tasks(), optional(api.experiments(), [] as ExperimentSummary[])]);
  // The list is newest first.
  const latest = experiments.find((e) => e.status === 'done' && e.config_hashes.length === 2 && e.config_hashes[0] !== e.config_hashes[1]);
  let run: { detail: ExperimentDetail; compare: Compare } | null = null;
  if (latest) {
    const [detail, compare] = await Promise.all([optional(api.experiment(latest.id), null), optional(api.compare(latest.id), null)]);
    if (detail && compare) run = { detail, compare };
  }
  return { tasks, run };
});

const split = ref<string>('all');
const grader = ref('any');

const tasks = computed(() => data.value?.tasks ?? []);
const splits = computed(() => [...new Set(tasks.value.map((t) => t.split))]);
const kinds = computed(() => [...new Set(tasks.value.flatMap((t) => graderKinds(t.graders)))]);
/** A judge grader that decides the outcome: one not marked optional. Judge criteria stay optional
 *  until they are trusted (D8), so a task with only an optional judge is decided by code. */
const isRequiredJudge = (g: unknown) => typeof g === 'object' && g !== null && !Array.isArray(g) && graderKinds([g as never])[0] === 'judge' && (g as { required?: unknown }).required !== false;
/** A task with graders whose outcome no required judge decides. Engine tests have no graders at all:
 *  they are graded by neither code nor a judge. */
const isCode = (t: TaskView) => t.graders.length > 0 && !t.graders.some(isRequiredJudge);
const hasOptionalJudge = (t: TaskView) => isCode(t) && graderKinds(t.graders).includes('judge');
/** A demo task (`demo-*`) shows one platform feature and is not part of the task set. */
const isDemo = (t: TaskView) => t.id.startsWith('demo-');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const arms = computed(() => (data.value?.run ? armsOf(data.value.run.detail, data.value.run.detail.configs) : []));

/** "15 personal-finance tasks and 2 engine tests": the engine tests check the platform, not an
 *  agent, so they are not counted as tasks. */
const taskCount = computed(() => {
  if (!tasks.value.length) return 'The personal-finance tasks';
  const engine = tasks.value.filter(isEngineTest).length;
  const demo = tasks.value.filter(isDemo).length;
  const real = plural(tasks.value.length - engine - demo, 'personal-finance task', 'personal-finance tasks');
  const extra = [demo ? plural(demo, 'demo', 'demos') : '', engine ? `${plural(engine, 'engine test', 'engine tests')} (checks of the platform, not of an agent)` : ''].filter(Boolean);
  return extra.length ? `${real}${extra.length === 2 ? ', ' : ' and '}${extra.join(' and ')}` : real;
});

const glance = computed(() => {
  const all = tasks.value;
  const bySplit = splits.value.map((s) => `${all.filter((t) => t.split === s).length} ${splitName(s)}`).join(', ');
  const graded = all.filter((t) => t.graders.length > 0);
  const code = graded.filter(isCode).length;
  const ungraded = all.length - graded.length;
  // "The 2 engine tests have no graders": they check the platform, so nothing grades an agent there.
  const engineOnly = ungraded > 0 && all.filter((t) => !t.graders.length).every(isEngineTest);
  const noGraders = !ungraded
    ? ''
    : engineOnly
      ? `${ungraded === 1 ? 'The engine test has' : `The ${ungraded} engine tests have`} no graders`
      : `${plural(ungraded, 'task has', 'tasks have')} no graders`;
  const optionalJudge = all.filter(hasOptionalJudge).length;
  const single = all.filter((t) => clientKind(t.kind) === 'Single prompt').length;
  const run = data.value?.run;
  const stats = run?.compare.stats;
  const separated = stats ? stats.tasks.filter((t) => t.beyond_noise).length : null;
  const runSplit = run ? new Set(run.detail.tasks.map((t) => splitName(t.split))) : null;
  return {
    bySplit,
    graded: `${code} code, ${graded.length - code} judge`,
    gradedNote: [noGraders, optionalJudge ? `${optionalJudge} of the code-graded also have a judge that does not count until it is trusted` : !noGraders ? 'Code means exact match, unit tests and state checks' : '']
      .filter(Boolean)
      .join('. '),
    client: `${plural(single, 'single prompt', 'single prompts')}, ${plural(all.length - single, 'conversation', 'conversations')}`,
    separatedLabel: arms.value.length === 2 ? `Separated ${arms.value[0].short} and ${arms.value[1].short}` : 'Separated the arms',
    separated: separated !== null && stats ? `${separated} of ${stats.tasks.length}${runSplit?.size === 1 ? ` ${[...runSplit][0]}` : ''}` : 'No verdict yet',
    separatedNote: stats
      ? `Beyond noise after correcting for ${stats.tasks.length} comparisons`
      : (run?.compare.stats_note ?? 'The last run has no verdict yet, so which tasks tell the arms apart is not known'),
  };
});

/** Above the table: which run the last column shows, its size, and what its words can claim. */
const runCaption = computed(() => {
  const run = data.value?.run;
  if (!run) return '';
  const n = run.detail.n;
  const tail = run.compare.stats ? ' No detectable difference is not the same as unchanged.' : ' Pass counts only: this run has no verdict yet.';
  return `Last run: ${experimentName(run.detail)}, ${n} ${n === 1 ? 'trial' : 'trials'} per arm.${tail}`;
});

/** A task's result in the last run, as its comparison writes it: each arm's passes ("2 of 3",
 *  "1 undecided"), and the verdict, or with no difference to show, how the arms stand
 *  ("Undecided", "B undecided"). The run is matched to the task file by hash, else by the task's id:
 *  a task file edited since the run (a newer version) still shows what the run measured, and says
 *  the run used an earlier version (fresh-clone review, 7 Nov: every row read "Not in this run"). */
const lastRun = (t: TaskView): { a: string; b: string; verdict: Verdict; label?: string; earlier: string | null } | null => {
  const run = data.value?.run;
  if (!run) return null;
  const same = run.compare.rows.some((r) => r.task === t.sha256);
  const rows = run.compare.rows.filter((r) => (same ? r.task === t.sha256 : r.task_id === t.id));
  const a = rows.find((r) => r.arm === 'A');
  const b = rows.find((r) => r.arm === 'B');
  if (!a || !b) return null;
  const ran = run.detail.tasks.find((x) => x.sha256 === a.task);
  const earlier = same ? null : `Ran an earlier version${ran && ran.version !== t.version ? ` (v${ran.version}; this file is v${t.version})` : ''}`;
  const stat = run.compare.stats?.tasks.find((x) => x.task === a.task);
  const words = { a: passedText(a), b: passedText(b), earlier };
  // D41's words per task: beyond noise (better or worse), else within noise.
  if (stat) return { ...words, verdict: stat.beyond_noise ? (stat.diff.estimate >= 0 ? 'better' : 'worse') : 'none', label: stat.beyond_noise ? undefined : 'Within noise' };
  // No statistics: a difference only when both arms have outcomes; otherwise say how they stand.
  const both = a.graded && b.graded;
  return { ...words, verdict: 'pending', label: both ? undefined : noDiffWords([armState(a), armState(b)]).tag };
};

const filtered = computed(() =>
  tasks.value.filter((t) => (split.value === 'all' || t.split === split.value) && (grader.value === 'any' || graderKinds(t.graders).includes(grader.value))),
);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Every matching task. Under "All" they are grouped by split, each group with its own heading
 *  row; under one split there is a single group with no heading. */
const groups = computed(() => {
  if (split.value !== 'all') return [{ key: split.value, title: null as string | null, tasks: filtered.value }];
  return splits.value
    .map((s) => {
      const list = filtered.value.filter((t) => t.split === s);
      return { key: s, title: `${sentence(splitName(s))} (${list.length})` as string | null, tasks: list };
    })
    .filter((g) => g.tasks.length);
});
</script>

<template>
  <div class="page-head">
    <h1 tabindex="-1">
      Tasks
    </h1>
    <p class="lede">
      {{ taskCount }}, each needing both a correct tool call and judgment. Tasks are files in the repo; this page shows how each is graded and where it sits in the experiment.
    </p>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    what="the tasks"
  >
    <section
      aria-label="Task set at a glance"
      class="stat-strip glance"
      data-test="task-glance"
    >
      <div>
        <span class="stat-label">Split</span>
        <span class="glance-value">{{ glance.bySplit }}</span>
        <span class="stat-note smaller">Prompt changes are made on discovery only</span>
      </div>
      <div>
        <span class="stat-label">Graded by</span>
        <span class="glance-value">{{ glance.graded }}</span>
        <span class="stat-note smaller">{{ glance.gradedNote }}</span>
      </div>
      <div>
        <span class="stat-label">Client</span>
        <span class="glance-value">{{ glance.client }}</span>
        <span class="stat-note smaller">Conversations use the simulated client</span>
      </div>
      <div>
        <span class="stat-label">{{ glance.separatedLabel }}</span>
        <span class="glance-value">{{ glance.separated }}</span>
        <span class="stat-note smaller">{{ glance.separatedNote }}</span>
      </div>
    </section>

    <div class="filters">
      <div
        role="group"
        aria-label="Split"
        class="seg"
      >
        <button
          type="button"
          :aria-pressed="split === 'all'"
          @click="split = 'all'"
        >
          All
        </button>
        <button
          v-for="s in splits"
          :key="s"
          type="button"
          :aria-pressed="split === s"
          @click="split = s"
        >
          {{ sentence(splitName(s)) }}
        </button>
      </div>
      <label class="inline-field">Graded by
        <select v-model="grader">
          <option value="any">Any</option>
          <option
            v-for="k in kinds"
            :key="k"
            :value="k"
          >{{ graderName(k) }}</option>
        </select>
      </label>
    </div>
    <p
      v-if="runCaption"
      class="result-detail run-caption"
      data-test="run-caption"
    >
      {{ runCaption }}
    </p>

    <div class="table-wrap">
      <table
        class="table tasks"
        data-test="tasks-table"
      >
        <thead>
          <tr>
            <th scope="col">
              Task
            </th>
            <th scope="col">
              What it checks
            </th>
            <th
              scope="col"
              class="one-line"
            >
              Split
            </th>
            <th scope="col">
              Graded by
            </th>
            <th
              scope="col"
              class="one-line"
            >
              Client
            </th>
            <th
              scope="col"
              class="right last-run-head"
              data-test="last-run-head"
            >
              Last run
            </th>
          </tr>
        </thead>
        <tbody
          v-for="g in groups"
          :key="g.key"
        >
          <tr
            v-if="g.title"
            class="group-row"
            data-test="group-row"
          >
            <th
              colspan="6"
              scope="rowgroup"
            >
              {{ g.title }}
            </th>
          </tr>
          <tr
            v-for="t in g.tasks"
            :key="t.sha256"
            data-test="task-row"
          >
            <th scope="row">
              <a
                v-if="lastRun(t) && data?.run"
                :href="href.compare(data.run.detail.id)"
                class="mono task-link"
              >{{ t.id }}</a>
              <span
                v-else
                class="mono"
              >{{ t.id }}</span>
            </th>
            <td class="what">
              {{ t.summary }}
            </td>
            <td class="one-line c-split">
              <span class="cell-label">Split</span>{{ sentence(splitName(t.split)) }}
            </td>
            <td class="secondary c-graded">
              <span class="cell-label">Graded by</span>{{ gradedBy(t) }}
            </td>
            <td class="secondary one-line c-client">
              <span class="cell-label">Client</span>{{ clientKind(t.kind) }}
            </td>
            <td class="right num c-last">
              <span class="cell-label">Last run</span>
              <template v-if="lastRun(t)">
                <VerdictTag
                  :verdict="lastRun(t)?.verdict ?? 'pending'"
                  :label="lastRun(t)?.label"
                />
                <span
                  class="result-detail arm-counts"
                  data-test="last-run"
                ><span class="arm"><span
                  class="dot dot--a"
                  aria-hidden="true"
                />A {{ lastRun(t)?.a }}</span> · <span class="arm"><span
                  class="dot dot--b"
                  aria-hidden="true"
                />B {{ lastRun(t)?.b }}</span></span>
                <span
                  v-if="lastRun(t)?.earlier"
                  class="result-detail earlier"
                  data-test="earlier-version"
                >{{ lastRun(t)?.earlier }}</span>
              </template>
              <span
                v-else
                class="secondary"
              >Not in this run</span>
            </td>
          </tr>
        </tbody>
        <tbody v-if="!filtered.length">
          <tr>
            <td
              colspan="6"
              class="secondary"
            >
              No task matches these filters.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </LoadState>
</template>

<style scoped>
.glance {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.glance > div {
  padding: 18px 22px;
}

.glance-value {
  display: block;
  font-size: 17px;
  font-weight: 600;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

/* Fits a 1216 px column without scrolling: the grader list wraps, and "What it checks" takes the
   room the one-line columns leave. */
.tasks .what {
  min-width: 14em;
}

.tasks .c-graded {
  min-width: 11em;
  max-width: 16em;
}

.cell-label {
  display: none;
}

/* Close under the filters and close over the table it describes (the page puts 32 px between
   blocks). */
.run-caption {
  margin-top: -18px;
  margin-bottom: -20px;
}

.last-run-head {
  white-space: nowrap;
}

/* Short labels stay on one line on a wide screen; "What it checks" takes the room they leave. */
@media (min-width: 641px) {
  .one-line {
    white-space: nowrap;
  }
}

.task-link {
  color: var(--ink);
}

.block {
  display: block;
}

.arm-counts {
  white-space: nowrap;
}

.arm-counts .arm {
  gap: 6px;
}

.earlier {
  white-space: normal;
}

/* A full-width heading row for each split when "All" is shown. */
.group-row th {
  padding-top: 10px;
  padding-bottom: 10px;
  background: var(--ground);
  border-top: 1px solid var(--rule);
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

tbody:first-of-type .group-row th {
  border-top: 0;
}

/* A phone reads each task as a card, every field under its name, so nothing sits off to the side
   (fresh-clone review, 7 Nov: at 390 px only the Task column showed, with no sign of the rest). */
@media (max-width: 760px) {
  .tasks thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .tasks,
  .tasks tbody,
  .tasks tr,
  .tasks th,
  .tasks td {
    display: block;
    width: 100%;
  }

  .tasks tr {
    padding: 10px 0;
    border-bottom: 1px solid var(--rule-soft);
  }

  .tasks tr.group-row {
    padding: 0;
  }

  .table.tasks th,
  .table.tasks td {
    border-bottom: 0;
    padding: 3px 16px;
    max-width: none;
    min-width: 0;
    text-align: left;
  }

  .table.tasks .group-row th {
    padding: 10px 16px;
  }

  .tasks .what {
    padding-bottom: 6px;
  }

  .cell-label {
    display: block;
    color: var(--ink-2);
    font-size: 12px;
  }
}
</style>
