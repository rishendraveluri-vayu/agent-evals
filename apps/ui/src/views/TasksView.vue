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
const isCode = (t: TaskView) => !graderKinds(t.graders).includes('judge');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const arms = computed(() => (data.value?.run ? armsOf(data.value.run.detail, data.value.run.detail.configs) : []));

/** "15 personal-finance tasks and 2 engine tests": the engine tests check the platform, not an
 *  agent, so they are not counted as tasks. */
const taskCount = computed(() => {
  if (!tasks.value.length) return 'The personal-finance tasks';
  const engine = tasks.value.filter(isEngineTest).length;
  const real = plural(tasks.value.length - engine, 'personal-finance task', 'personal-finance tasks');
  return engine ? `${real} and ${plural(engine, 'engine test', 'engine tests')} (checks of the platform, not of an agent)` : real;
});

const glance = computed(() => {
  const all = tasks.value;
  const bySplit = splits.value.map((s) => `${all.filter((t) => t.split === s).length} ${splitName(s)}`).join(', ');
  const code = all.filter(isCode).length;
  const single = all.filter((t) => clientKind(t.kind) === 'Single prompt').length;
  const run = data.value?.run;
  const stats = run?.compare.stats;
  const separated = stats ? stats.tasks.filter((t) => t.significant).length : null;
  const runSplit = run ? new Set(run.detail.tasks.map((t) => splitName(t.split))) : null;
  return {
    bySplit,
    graded: `${code} code, ${all.length - code} judge`,
    client: `${plural(single, 'single prompt', 'single prompts')}, ${plural(all.length - single, 'conversation', 'conversations')}`,
    separatedLabel: arms.value.length === 2 ? `Separated ${arms.value[0].short} and ${arms.value[1].short}` : 'Separated the arms',
    separated: separated !== null && stats ? `${separated} of ${stats.tasks.length}${runSplit?.size === 1 ? ` ${[...runSplit][0]}` : ''}` : 'Not computed',
    separatedNote: stats
      ? stats.correction
        ? `After correcting for ${stats.tasks.length} comparisons`
        : 'Before correcting for many comparisons'
      : 'Which tasks tell the arms apart needs the statistics step, not built in this version',
  };
});

/** Above the table: which run the last column shows, its size, and what its words can claim. */
const runCaption = computed(() => {
  const run = data.value?.run;
  if (!run) return '';
  const n = run.detail.n;
  const tail = run.compare.stats ? ' No clear difference is not the same as unchanged.' : ' Pass counts only: this version does not compute a verdict per task.';
  return `Last run: ${experimentName(run.detail)}, ${n} ${n === 1 ? 'trial' : 'trials'} per arm.${tail}`;
});

/** A task's result in the last run, as its comparison writes it: each arm's passes ("2 of 3",
 *  "1 undecided"), and the verdict, or with no difference to show, how the arms stand
 *  ("Undecided", "B undecided"). */
const lastRun = (t: TaskView): { a: string; b: string; verdict: Verdict; label?: string } | null => {
  const run = data.value?.run;
  if (!run) return null;
  const rows = run.compare.rows.filter((r) => r.task === t.sha256 || r.task === t.id);
  const a = rows.find((r) => r.arm === 'A');
  const b = rows.find((r) => r.arm === 'B');
  if (!a || !b) return null;
  const stat = run.compare.stats?.tasks.find((x) => x.task === t.sha256 || x.task === t.id);
  const words = { a: passedText(a), b: passedText(b) };
  if (stat) return { ...words, verdict: stat.significant ? (stat.diff.estimate >= 0 ? 'better' : 'worse') : 'none' };
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
        <span class="stat-note smaller">Code means exact match, unit tests and state checks</span>
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
            <th
              scope="col"
              class="one-line"
            >
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
            <td class="one-line">
              {{ sentence(splitName(t.split)) }}
            </td>
            <td class="secondary one-line">
              {{ gradedBy(t) }}
            </td>
            <td class="secondary one-line">
              {{ clientKind(t.kind) }}
            </td>
            <td class="right num">
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

.tasks {
  min-width: 1000px;
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
</style>
