<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../api/client';
import { isFixtureMode } from '../api/mode';
import type { Compare, CompareRow, ExperimentDetail, ExperimentTrial, Interval, TaskInfo } from '../api/types';
import IntervalStrip from '../components/IntervalStrip.vue';
import LoadState from '../components/LoadState.vue';
import { armsOf, excludesZero, intervalText, setupOf, totalTrials, verdictTitle } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { money, percent, seconds, signed, signedMoney, thousands, tick } from '../lib/format';
import { gradedBy, isJudged } from '../lib/names';
import { domainFor, leanTone, ticksFor, type StripRow } from '../lib/scale';
import { href } from '../router';

const props = defineProps<{ experimentId: string }>();
const fixtures = isFixtureMode();

interface Loaded {
  detail: ExperimentDetail;
  compare: Compare;
  trials: ExperimentTrial[];
}

const { data, error, loading } = useLoad<Loaded>(async () => {
  const [detail, compare, trials] = await Promise.all([
    api.experiment(props.experimentId),
    api.compare(props.experimentId),
    optional(api.experimentTrials(props.experimentId), [] as ExperimentTrial[]),
  ]);
  return { detail, compare, trials };
});

const arms = computed(() => (data.value ? armsOf(data.value.detail, data.value.detail.configs) : []));
const stats = computed(() => data.value?.compare.stats ?? null);
const taskOf = (key: string): TaskInfo | undefined => data.value?.detail.tasks.find((t) => t.sha256 === key || t.id === key);
const taskName = (key: string) => taskOf(key)?.id ?? key.replace(/^sha256:/, '').slice(0, 12);

function cell(task: string, arm: 0 | 1): CompareRow | undefined {
  const hash = data.value?.detail.config_hashes[arm];
  const rows = data.value?.compare.rows.filter((r) => r.task === task && r.config === hash) ?? [];
  // An A/A run has the same hash twice: the rows come in arm order.
  if (data.value && data.value.detail.config_hashes[0] === data.value.detail.config_hashes[1]) return rows[arm];
  return rows[0];
}

const totals = computed(() => {
  const d = data.value;
  if (!d) return null;
  const sum = (arm: 0 | 1) =>
    d.detail.tasks.reduce(
      (acc, t) => {
        const c = cell(t.sha256, arm);
        return { passed: acc.passed + (c?.passed ?? 0), graded: acc.graded + (c?.graded ?? 0) };
      },
      { passed: 0, graded: 0 },
    );
  return { a: sum(0), b: sum(1) };
});

const noVerdictText = computed(() => {
  const t = totals.value;
  if (!t) return '';
  const b = arms.value[1] ? `, B passed ${t.b.passed} of ${t.b.graded}` : '';
  return `A passed ${t.a.passed} of ${t.a.graded} graded trials${b}. The interval and the verdict come from the statistics step, which has not reported on this experiment yet.`;
});

const infraCount = computed(() => data.value?.trials.filter((t) => t.status === 'infra_failed' || t.status === 'abandoned').length ?? data.value?.detail.counts.infra_failed ?? 0);

const hero = computed(() => {
  const s = stats.value;
  if (!s) return null;
  const values = [s.diff.low, s.diff.high, ...(s.aa ? [s.aa.diff.low, s.aa.diff.high] : [])];
  const [min, max] = domainFor(values, -20, 30);
  const level = Math.round(s.level * 100);
  const rows: StripRow[] = [{ estimate: s.diff.estimate, low: s.diff.low, high: s.diff.high, tone: leanTone(s.diff.estimate) }];
  const aa: StripRow[] = s.aa ? [{ estimate: s.aa.diff.estimate, low: s.aa.diff.low, high: s.aa.diff.high, tone: 'neutral', size: 'sm', label: 'A/A run, same config twice' }] : [];
  return {
    level,
    min,
    max,
    ticks: ticksFor(min, max, 20, '0', ' points'),
    rows: [...rows, ...aa],
    aria: `Difference ${signed(s.diff.estimate)} points, interval ${intervalText(s.diff)}.${s.aa ? ` The A/A run gave ${signed(s.aa.diff.estimate)}, interval ${intervalText(s.aa.diff)}.` : ''}`,
  };
});

const why = computed(() => {
  const s = stats.value;
  const d = data.value;
  if (!s || !d) return [];
  const out: string[] = [];
  const side = s.diff.low > 0 ? 'above' : 'below';
  let first = excludesZero(s.diff)
    ? `The interval stays ${side} zero.`
    : 'The interval crosses zero, so these trials cannot rule out no difference at all.';
  if (s.aa) {
    const wobble = Math.max(Math.abs(s.aa.diff.low), Math.abs(s.aa.diff.high));
    first += ` Running the same config twice moved only ${signed(s.aa.diff.estimate)} ${Math.abs(s.aa.diff.estimate) === 1 ? 'point' : 'points'}, so the setup's own wobble is ${Math.abs(s.diff.estimate) > wobble ? 'far smaller than' : 'about as large as'} this difference.`;
  } else {
    first += ' There is no A/A run on this setup yet, so its own wobble is not measured.';
  }
  out.push(first);
  if (s.method === 'paired_task_bootstrap') {
    out.push(`Paired by task: each task is compared with itself across the two arms, then the ${s.tasks.length} task differences are resampled.${s.p_value !== null ? ` Permutation test p = ${s.p_value}.` : ''}`);
  } else {
    out.push(`Method: ${s.method}.${s.p_value !== null ? ` p = ${s.p_value}.` : ''}`);
  }
  return out;
});

const judgeLine = computed(() => {
  const j = stats.value?.judge;
  const d = data.value;
  if (!j || !d) return null;
  const judged = d.detail.tasks.filter(isJudged).length;
  return `The judge scored ${judged} of the ${d.detail.tasks.length} tasks. It agrees with your held-out labels at κ ${j.kappa.toFixed(2)}, ${j.kappa >= j.bar ? 'above' : 'below'} the ${j.bar} bar set before the run${j.low < j.bar ? ', though its interval dips below it' : ''}.`;
});

interface Metric {
  name: string;
  delta: string;
  interval: string;
  a: number;
  b: number;
  aText: string;
  bText: string;
  max: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (values: number[]) => (values.length ? values.reduce((x, y) => x + y, 0) / values.length : null);

const metrics = computed<Metric[]>(() => {
  const d = data.value;
  const t = totals.value;
  if (!d || !t) return [];
  const s = stats.value;
  const out: Metric[] = [];
  const rel = (i: Interval | null, abs: string) => (i ? `${signed(i.estimate)}%, interval ${signed(i.low)}% to ${signed(i.high)}%` : abs);
  if (s) {
    out.push({ name: 'Pass rate', delta: `${signed(s.diff.estimate)} points`, interval: intervalText(s.diff), a: s.a.rate, b: s.b.rate, aText: percent(s.a.rate), bText: percent(s.b.rate), max: 1 });
  } else if (t.a.graded && t.b.graded) {
    const ra = t.a.passed / t.a.graded;
    const rb = t.b.passed / t.b.graded;
    out.push({ name: 'Pass rate', delta: `${signed((rb - ra) * 100)} points`, interval: `${t.a.passed} of ${t.a.graded} and ${t.b.passed} of ${t.b.graded}; no interval yet`, a: ra, b: rb, aText: percent(ra), bText: percent(rb), max: 1 });
  }
  const costs = s?.costs ?? [];
  if (costs.length) {
    for (const c of costs) {
      if (c.metric === 'cost_usd') out.push({ name: 'Cost per trial', delta: signedMoney(c.diff.estimate), interval: rel(c.relative, `Interval ${signedMoney(c.diff.low)} to ${signedMoney(c.diff.high)}`), a: c.a, b: c.b, aText: money(c.a), bText: money(c.b), max: Math.max(c.a, c.b) });
      if (c.metric === 'wall_s') out.push({ name: 'Time per trial, median', delta: `${signed(c.diff.estimate)} s`, interval: rel(c.relative, `Interval ${signed(c.diff.low)} to ${signed(c.diff.high)} s`), a: c.a, b: c.b, aText: `${Math.round(c.a)} s`, bText: `${Math.round(c.b)} s`, max: Math.max(c.a, c.b) });
      if (c.metric === 'tokens') out.push({ name: 'Tokens per trial', delta: signed(c.diff.estimate), interval: rel(c.relative, `Interval ${signed(c.diff.low)} to ${signed(c.diff.high)}`), a: c.a, b: c.b, aText: thousands(c.a), bText: thousands(c.b), max: Math.max(c.a, c.b) });
    }
    return out;
  }
  // Until the statistics step reports costs, show the arm means from the trials, with their N.
  const [ha, hb] = d.detail.config_hashes;
  const done = d.trials.filter((x) => x.status === 'done');
  const byArm = (h: string) => done.filter((x) => x.config === h);
  const ta = byArm(ha);
  const tb = ha === hb ? [] : byArm(hb);
  const n = `N = ${ta.length} and ${tb.length} trials; no interval yet`;
  const pairs: [string, (x: ExperimentTrial) => number | null | undefined, 'mean' | 'median', (v: number) => string, (v: number) => string][] = [
    ['Cost per trial', (x) => x.cost_usd, 'mean', money, signedMoney],
    ['Time per trial, median', (x) => x.wall_s, 'median', (v) => seconds(v), (v) => `${signed(v, 1)} s`],
    ['Tokens per trial', (x) => (x.input_tokens ?? 0) + (x.output_tokens ?? 0) || null, 'mean', thousands, (v) => signed(v)],
  ];
  for (const [name, pick, how, fmt, fmtDelta] of pairs) {
    const va = ta.map(pick).filter((v): v is number => typeof v === 'number');
    const vb = tb.map(pick).filter((v): v is number => typeof v === 'number');
    const a = how === 'mean' ? mean(va) : median(va);
    const b = how === 'mean' ? mean(vb) : median(vb);
    if (a === null || b === null) continue;
    out.push({ name, delta: fmtDelta(b - a), interval: n, a, b, aText: fmt(a), bText: fmt(b), max: Math.max(a, b) });
  }
  return out;
});

const barW = (v: number, max: number) => Math.max(2, Math.round((v / (max || 1)) * 150));

interface TaskRow {
  key: string;
  name: string;
  grader: string;
  a: CompareRow | undefined;
  b: CompareRow | undefined;
  diff: Interval | null;
  significant: boolean;
  link: string | null;
}

function failedTrial(task: string, prefer: 0 | 1): ExperimentTrial | undefined {
  const d = data.value;
  if (!d) return undefined;
  const of = (arm: 0 | 1) => d.trials.find((t) => t.task === task && t.config === d.detail.config_hashes[arm] && t.passed === false);
  return of(prefer) ?? of(prefer === 1 ? 0 : 1) ?? d.trials.find((t) => t.task === task && t.status === 'done');
}

const taskRows = computed<TaskRow[]>(() => {
  const d = data.value;
  if (!d) return [];
  const s = stats.value;
  const base = s
    ? s.tasks.map((t) => ({ key: t.task, diff: t.diff, significant: t.significant }))
    : d.detail.tasks.map((t) => {
        const a = cell(t.sha256, 0);
        const b = cell(t.sha256, 1);
        const est = a?.graded && b?.graded ? (b.passed / b.graded - a.passed / a.graded) * 100 : null;
        return { key: t.sha256, diff: est === null ? null : { estimate: est, low: est, high: est }, significant: false };
      });
  return base
    .map((r) => {
      const failed = failedTrial(r.key, 1);
      return {
        key: r.key,
        name: taskName(r.key),
        grader: gradedBy(taskOf(r.key)),
        a: cell(r.key, 0),
        b: cell(r.key, 1),
        diff: r.diff,
        significant: r.significant,
        link: failed ? href.trial(failed.id) : null,
      };
    })
    .sort((x, y) => (y.diff?.estimate ?? -999) - (x.diff?.estimate ?? -999));
});

const fx = (v: number) => 200 + Math.max(-100, Math.min(100, v)) * 2;
const lean = (r: TaskRow) => (!r.diff ? 'neutral' : r.significant ? (r.diff.estimate >= 0 ? 'b' : 'a') : r.diff.estimate < 0 ? 'a' : 'neutral');
const verdictOf = (r: TaskRow) => (!r.diff || !stats.value ? 'No interval yet' : r.significant ? (r.diff.estimate >= 0 ? 'Better' : 'Worse') : 'Within noise');
const pillOf = (r: TaskRow) => (r.significant ? (r.diff && r.diff.estimate >= 0 ? 'pill--pass' : 'pill--fail') : '');
const labelOf = (r: TaskRow) => (!r.diff ? 'Not graded yet' : stats.value ? `${signed(r.diff.estimate)} (${intervalText(r.diff)})` : `${signed(r.diff.estimate)}, no interval`);
const passedText = (c: CompareRow | undefined) => (c ? `${c.passed} of ${c.graded}` : '–');

const differing = computed(() => taskRows.value.filter((r) => r.significant).length);

const worthALook = computed(() => {
  const candidates = taskRows.value.filter((r) => r.diff && r.diff.estimate < 0);
  const worst = candidates.sort((x, y) => (x.diff?.estimate ?? 0) - (y.diff?.estimate ?? 0))[0];
  if (!worst || !worst.diff || !stats.value) return null;
  const failed = failedTrial(worst.key, 1);
  return {
    row: worst,
    text: `B passed ${passedText(worst.b)}, A passed ${passedText(worst.a)}. ${worst.significant ? 'This difference holds up' : 'Not significant on its own'} (${signed(worst.diff.estimate)}, interval ${intervalText(worst.diff)}). The failed trials show what went wrong.`,
    link: failed ? href.trial(failed.id) : null,
  };
});
</script>

<template>
  <LoadState
    :loading="loading"
    :error="error"
    what="this comparison"
  >
    <template v-if="data">
      <div class="head-row">
        <div class="page-head">
          <nav
            aria-label="Breadcrumb"
            class="crumbs"
          >
            <a :href="href.experiments()">Experiments</a> / {{ data.detail.name }}
          </nav>
          <h1 tabindex="-1">
            {{ data.detail.name }}
          </h1>
          <div class="arms-line small">
            <span
              v-for="arm in arms"
              :key="arm.key"
              class="arm"
            ><span :class="`dot dot--${arm.key}`" /><span>{{ arm.key.toUpperCase() }}: {{ arm.label }} (config <span class="mono">{{ arm.hash.replace('sha256:', '').slice(0, 7) }}</span>)</span></span>
            <span class="secondary">{{ setupOf(data.detail, arms) }}, {{ totalTrials(data.detail) }} trials</span>
          </div>
        </div>
        <div class="actions">
          <a
            v-if="data.detail.status === 'running' || data.detail.status === 'created'"
            :href="href.run(data.detail.id)"
            class="btn btn--quiet"
          >See the run</a>
          <template v-if="!fixtures">
            <a
              :href="api.exportUrl(data.detail.id, 'csv')"
              class="btn btn--quiet"
              download
            >Export CSV</a>
            <a
              :href="api.exportUrl(data.detail.id, 'json')"
              class="btn btn--quiet"
              download
            >Export JSON</a>
          </template>
          <button
            v-else
            type="button"
            class="btn btn--quiet"
            disabled
            title="Export needs the API; sample data has nothing to export"
          >
            Export CSV
          </button>
        </div>
      </div>

      <section
        aria-labelledby="verdict"
        class="panel verdict"
        data-test="verdict"
      >
        <div class="verdict-main">
          <template v-if="stats && hero">
            <h2
              id="verdict"
              class="verdict-title"
              data-test="verdict-title"
            >
              {{ verdictTitle(stats, arms) }}
            </h2>
            <p class="verdict-text">
              <strong class="num">{{ signed(stats.diff.estimate) }} points</strong> of pass rate, from {{ percent(stats.a.rate) }} to {{ percent(stats.b.rate) }}. The {{ hero.level }}% interval runs from {{ signed(stats.diff.low) }} to {{ signed(stats.diff.high) }} points.
            </p>
            <IntervalStrip
              :min="hero.min"
              :max="hero.max"
              :ticks="hero.ticks"
              :rows="hero.rows"
              :reference="{ value: 0, dashed: true }"
              :summary="hero.aria"
            />
          </template>
          <template v-else>
            <h2
              id="verdict"
              class="verdict-title"
              data-test="verdict-title"
            >
              No verdict yet
            </h2>
            <p
              v-if="totals"
              class="verdict-text"
            >
              {{ noVerdictText }}
            </p>
          </template>
        </div>
        <div
          v-if="stats"
          class="verdict-why small"
        >
          <h3 class="why-title">
            {{ excludesZero(stats.diff) ? 'Why this is not noise' : 'Why this could be noise' }}
          </h3>
          <p
            v-for="(line, i) in why"
            :key="i"
          >
            {{ line }}
          </p>
          <p v-if="judgeLine">
            {{ judgeLine }} <a :href="href.judge()">See the check</a>
          </p>
          <p class="secondary">
            <template v-if="infraCount">
              {{ infraCount }} {{ infraCount === 1 ? 'trial' : 'trials' }} stopped on infra failures {{ infraCount === 1 ? 'was' : 'were' }} re-run and {{ infraCount === 1 ? 'is' : 'are' }} listed, not dropped.
            </template>
            <template v-else>
              No trial stopped on an infra failure.
            </template>
          </p>
        </div>
      </section>

      <section
        v-if="metrics.length"
        aria-labelledby="costs"
        class="stack"
      >
        <h2
          id="costs"
          class="section-title"
        >
          What it costs
        </h2>
        <div class="stat-strip metrics">
          <div
            v-for="m in metrics"
            :key="m.name"
          >
            <span class="stat-label">{{ m.name }}</span>
            <span class="metric-delta num">{{ m.delta }}</span>
            <span class="secondary smaller num block">{{ m.interval }}</span>
            <svg
              viewBox="0 0 220 44"
              width="100%"
              role="img"
              :aria-label="`${m.name}: A ${m.aText}, B ${m.bText}`"
              class="bars"
            >
              <rect
                x="0"
                y="4"
                :width="barW(m.a, m.max)"
                height="12"
                rx="4"
                class="bar bar--a"
              />
              <text
                :x="barW(m.a, m.max) + 8"
                y="14"
                class="bar-label"
              >A {{ m.aText }}</text>
              <rect
                x="0"
                y="26"
                :width="barW(m.b, m.max)"
                height="12"
                rx="4"
                class="bar bar--b"
              />
              <text
                :x="barW(m.b, m.max) + 8"
                y="36"
                class="bar-label"
              >B {{ m.bText }}</text>
            </svg>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="tasks"
        class="stack"
      >
        <div class="head-row head-row--baseline">
          <h2
            id="tasks"
            class="section-title"
          >
            Task by task
          </h2>
          <p
            v-if="stats"
            class="secondary small"
            data-test="task-summary"
          >
            {{ differing }} {{ differing === 1 ? 'task differs' : 'tasks differ' }} {{ stats.correction ? `after correcting for ${taskRows.length} comparisons` : 'before any correction for many comparisons' }}. The other {{ taskRows.length - differing }} {{ taskRows.length - differing === 1 ? 'is' : 'are' }} within noise.
          </p>
        </div>
        <div class="table-wrap">
          <table
            class="table forest"
            data-test="forest"
          >
            <thead>
              <tr>
                <th scope="col">
                  Task
                </th>
                <th scope="col">
                  Graded by
                </th>
                <th
                  scope="col"
                  class="right"
                >
                  A passed
                </th>
                <th
                  scope="col"
                  class="right"
                >
                  B passed
                </th>
                <th
                  scope="col"
                  class="plot-col"
                >
                  Difference, B minus A, with {{ stats ? Math.round(stats.level * 100) : 95 }}% interval
                </th>
                <th scope="col">
                  Verdict
                </th>
              </tr>
              <tr aria-hidden="true">
                <td colspan="4" />
                <td class="axis-cell">
                  <svg
                    viewBox="0 0 400 18"
                    width="100%"
                  >
                    <text
                      x="0"
                      y="13"
                      class="axis-label"
                    >{{ tick(-100) }}</text>
                    <text
                      x="200"
                      y="13"
                      class="axis-label axis-label--zero"
                      text-anchor="middle"
                    >0</text>
                    <text
                      x="400"
                      y="13"
                      class="axis-label"
                      text-anchor="end"
                    >+100</text>
                  </svg>
                </td>
                <td />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in taskRows"
                :key="r.key"
                data-test="forest-row"
              >
                <th scope="row">
                  <a
                    v-if="r.link"
                    :href="r.link"
                    class="mono task-link"
                  >{{ r.name }}</a>
                  <span
                    v-else
                    class="mono"
                  >{{ r.name }}</span>
                </th>
                <td class="secondary">
                  {{ r.grader }}
                </td>
                <td class="right num">
                  {{ passedText(r.a) }}
                </td>
                <td class="right num">
                  {{ passedText(r.b) }}
                </td>
                <td class="plot-cell">
                  <svg
                    v-if="r.diff"
                    viewBox="0 0 400 26"
                    width="100%"
                    role="img"
                    :aria-label="`${r.name}: ${signed(r.diff.estimate)} points${stats ? `, interval ${intervalText(r.diff)}` : ''}`"
                  >
                    <line
                      x1="200"
                      y1="0"
                      x2="200"
                      y2="26"
                      class="zero"
                    />
                    <line
                      :x1="fx(r.diff.low)"
                      :x2="fx(r.diff.high)"
                      y1="13"
                      y2="13"
                      :class="`ci ci--${r.significant ? lean(r) : 'neutral'}`"
                    />
                    <circle
                      :cx="fx(r.diff.estimate)"
                      cy="13"
                      r="6"
                      :class="`pt pt--${lean(r)}`"
                    />
                  </svg>
                </td>
                <td>
                  <span
                    class="pill pill--small"
                    :class="pillOf(r)"
                  >{{ verdictOf(r) }}</span>
                  <span class="secondary smaller num block">{{ labelOf(r) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        v-if="worthALook"
        aria-labelledby="look"
        class="panel panel--dashed look"
      >
        <div class="look-text">
          <h2
            id="look"
            class="section-title"
          >
            Worth a look: {{ worthALook.row.name }} got worse
          </h2>
          <p class="look-body">
            {{ worthALook.text }}
          </p>
        </div>
        <a
          v-if="worthALook.link"
          :href="worthALook.link"
          class="btn"
        >Open a failed trial</a>
      </section>
    </template>
  </LoadState>
</template>

<style scoped>
.arms-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin-top: 10px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.verdict {
  display: flex;
  flex-wrap: wrap;
  border-radius: 14px;
}

.verdict-main {
  flex: 999 1 620px;
  min-width: 0;
  padding: 30px 34px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.verdict-title {
  font-size: 40px;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.verdict-text {
  font-size: 18px;
  max-width: 60ch;
}

.verdict-text strong {
  font-weight: 600;
}

.verdict-why {
  flex: 1 1 400px;
  min-width: 0;
  padding: 30px;
  border-left: 1px solid var(--rule-soft);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.why-title {
  font-size: 15px;
}

.metrics {
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
}

.metric-delta {
  display: block;
  margin-top: 2px;
  font-size: 22px;
  font-weight: 600;
}

.block {
  display: block;
}

.bars {
  margin-top: 10px;
  display: block;
}

.bar--a {
  fill: var(--arm-a);
}

.bar--b {
  fill: var(--arm-b);
}

.bar-label {
  font-size: 12px;
  fill: var(--ink);
}

.head-row--baseline {
  align-items: baseline;
}

.forest {
  min-width: 980px;
}

.forest th,
.forest td {
  vertical-align: middle;
}

.plot-col {
  width: 420px;
}

.axis-cell,
.plot-cell {
  padding-top: 4px;
  padding-bottom: 4px;
}

.axis-label {
  font-size: 11px;
  fill: var(--ink-2);
}

.axis-label--zero {
  fill: var(--ink);
}

.task-link {
  color: var(--ink);
}

.zero {
  stroke: var(--neutral-line);
  stroke-dasharray: 2 3;
}

.ci {
  stroke-width: 3;
  stroke-linecap: round;
}

.ci--a {
  stroke: var(--arm-a);
}

.ci--b {
  stroke: var(--arm-b);
}

.ci--neutral {
  stroke: var(--neutral-line);
}

.pt {
  stroke: var(--surface);
  stroke-width: 2;
}

.pt--a {
  fill: var(--arm-a);
}

.pt--b {
  fill: var(--arm-b);
}

.pt--neutral {
  fill: var(--neutral-dot);
}

.look {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  align-items: flex-start;
  padding: 22px 26px;
}

.look-text {
  flex: 999 1 520px;
  min-width: 0;
}

.look-body {
  margin-top: 6px;
  max-width: 72ch;
}

@media (max-width: 640px) {
  .verdict-main {
    padding: 22px 20px;
  }

  .verdict-why {
    padding: 20px;
    border-left: 0;
    border-top: 1px solid var(--rule-soft);
  }

  .verdict-title {
    font-size: 32px;
  }

  .verdict-text {
    font-size: 16px;
  }

  .look {
    padding: 20px;
  }
}
</style>
