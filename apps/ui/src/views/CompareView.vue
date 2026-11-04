<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../api/client';
import { isFixtureMode } from '../api/mode';
import type { BlindItem, Compare, CompareRow, ExperimentDetail, ExperimentTrial, Interval, JudgeAgreement, TaskInfo } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import IntervalStrip from '../components/IntervalStrip.vue';
import LoadState from '../components/LoadState.vue';
import VerdictTag from '../components/VerdictTag.vue';
import { armsOf, excludesZero, intervalText, judgeCaveat, methodName, pointsWithInterval, setupOf, totalTrials, verdictTitle, type ArmKey, type Verdict } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { money, percent, seconds, signed, signedMoney, thousands, tick } from '../lib/format';
import { gradedBy, infraReason, isJudged } from '../lib/names';
import { domainFor, ticksFor, verdictTone, type StripRow } from '../lib/scale';
import { href } from '../router';

const props = defineProps<{ experimentId: string }>();
const fixtures = isFixtureMode();

interface Loaded {
  detail: ExperimentDetail;
  compare: Compare;
  trials: ExperimentTrial[];
  judge: JudgeAgreement | null;
  /** Held-out items still to label: while any remain, the judge's agreement is provisional. */
  queue: BlindItem[];
}

const { data, error, loading } = useLoad<Loaded>(async () => {
  const [detail, compare, trials, judge, queue] = await Promise.all([
    api.experiment(props.experimentId),
    api.compare(props.experimentId),
    optional(api.experimentTrials(props.experimentId), [] as ExperimentTrial[]),
    optional(api.judgeAgreement('heldout'), null),
    optional(api.labelQueue('heldout'), [] as BlindItem[]),
  ]);
  return { detail, compare, trials, judge, queue };
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

/** Trials stopped on infra failures: listed, never dropped. When the trial list did not load,
 *  the experiment's counts still say how many there were. */
const infraTrials = computed(() => data.value?.trials.filter((t) => t.status === 'infra_failed' || t.status === 'abandoned') ?? []);
const infraCount = computed(() => {
  const d = data.value;
  if (!d) return 0;
  return infraTrials.value.length || d.detail.counts.infra_failed + d.detail.counts.abandoned;
});

/** Which arm a trial ran in. An A/A run has one hash twice: its second arm's repeats come after
 *  the first arm's. */
function armOfTrial(t: ExperimentTrial): ArmKey {
  const d = data.value;
  if (!d) return 'a';
  const [ha, hb] = d.detail.config_hashes;
  if (ha === hb) return t.repeat_index >= d.detail.n ? 'b' : 'a';
  return t.config === hb ? 'b' : 'a';
}

const commits = computed(() => {
  const d = data.value?.detail;
  return { plan: d?.plan_commit ? d.plan_commit.slice(0, 7) : null, platform: d?.platform_commit ? d.platform_commit.slice(0, 7) : null };
});

const hero = computed(() => {
  const s = stats.value;
  if (!s) return null;
  const values = [s.diff.low, s.diff.high, ...(s.aa ? [s.aa.diff.low, s.aa.diff.high] : [])];
  const [min, max] = domainFor(values, -20, 30);
  const level = Math.round(s.level * 100);
  const [a, b] = arms.value;
  const name = a && b && a.short !== b.short ? `${b.short} minus ${a.short}` : 'B minus A';
  // Arm colour only when the result holds up; a result with no clear difference is grey.
  const rows: StripRow[] = [{ estimate: s.diff.estimate, low: s.diff.low, high: s.diff.high, tone: verdictTone(s.verdict), label: `${name}, ${s.tasks.length} tasks` }];
  const aa: StripRow[] = s.aa ? [{ estimate: s.aa.diff.estimate, low: s.aa.diff.low, high: s.aa.diff.high, tone: 'neutral', size: 'sm', label: 'A/A run, same config twice' }] : [];
  return {
    level,
    min,
    max,
    ticks: ticksFor(min, max, 10),
    rows: [...rows, ...aa],
    aria: `Difference ${signed(s.diff.estimate)} points, interval ${intervalText(s.diff)}.${s.aa ? ` The A/A run gave ${signed(s.aa.diff.estimate)}, interval ${intervalText(s.aa.diff)}.` : ''}`,
  };
});

/** Why the result is or is not noise: the interval, the check on the method (an A/A run), and
 *  the method itself, named only as the statistics step names it. */
const why = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const side = s.diff.low > 0 ? 'above' : 'below';
  const interval = excludesZero(s.diff)
    ? `The interval stays ${side} zero.`
    : 'The interval crosses zero, so these trials cannot rule out no difference at all.';
  let aa = 'No A/A run on this setup yet, so the method has not been checked on a run where nothing changed.';
  if (s.aa) {
    aa = excludesZero(s.aa.diff)
      ? `Check on the method: the same config run twice gave ${pointsWithInterval(s.aa.diff)}, a difference where there is none. Treat this result with caution.`
      : `Check on the method: the same config run twice gave ${pointsWithInterval(s.aa.diff)}, which includes zero, so the method did not invent a difference when nothing changed.`;
  }
  const p = s.p_value !== null ? `, p = ${s.p_value}` : '';
  const method = s.method === 'paired_task_bootstrap'
    ? `Paired by task: each task is compared with itself across the two arms. ${methodName(s.method)}${p}.`
    : `${methodName(s.method)}${p}.`;
  return [interval, aa, method];
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
    out.push({ name: 'Pass rate', delta: `${signed(s.diff.estimate)} points`, interval: `interval ${intervalText(s.diff)} points`, a: s.a.rate, b: s.b.rate, aText: percent(s.a.rate), bText: percent(s.b.rate), max: 1 });
  } else if (t.a.graded && t.b.graded) {
    const ra = t.a.passed / t.a.graded;
    const rb = t.b.passed / t.b.graded;
    out.push({ name: 'Pass rate', delta: `${signed((rb - ra) * 100)} points`, interval: `${t.a.passed} of ${t.a.graded} and ${t.b.passed} of ${t.b.graded}; no interval yet`, a: ra, b: rb, aText: percent(ra), bText: percent(rb), max: 1 });
  }
  const costs = s?.costs ?? [];
  if (costs.length) {
    for (const c of costs) {
      if (c.metric === 'cost_usd') out.push({ name: 'Cost per trial', delta: signedMoney(c.diff.estimate), interval: rel(c.relative, `interval ${signedMoney(c.diff.low)} to ${signedMoney(c.diff.high)}`), a: c.a, b: c.b, aText: money(c.a), bText: money(c.b), max: Math.max(c.a, c.b) });
      if (c.metric === 'wall_s') out.push({ name: 'Time per trial, median', delta: `${signed(c.diff.estimate)} s`, interval: rel(c.relative, `interval ${signed(c.diff.low)} to ${signed(c.diff.high)} s`), a: c.a, b: c.b, aText: `${Math.round(c.a)} s`, bText: `${Math.round(c.b)} s`, max: Math.max(c.a, c.b) });
      if (c.metric === 'tokens') out.push({ name: 'Tokens per trial', delta: signed(c.diff.estimate), interval: rel(c.relative, `interval ${signed(c.diff.low)} to ${signed(c.diff.high)}`), a: c.a, b: c.b, aText: thousands(c.a), bText: thousands(c.b), max: Math.max(c.a, c.b) });
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

/** A bar's share of its rail: the rail runs from 0 to 100% for pass rate, and from 0 to the
 *  larger arm's value for the rest. */
const barShare = (v: number, max: number) => `${Math.max(0, Math.min(100, (v / (max || 1)) * 100))}%`;

interface TaskRow {
  key: string;
  name: string;
  grader: string;
  a: CompareRow | undefined;
  b: CompareRow | undefined;
  diff: Interval | null;
  significant: boolean;
  link: string | null;
  linkTitle: string;
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
      // The same trial the "Worth a look" button opens: a failure your label does not dispute.
      const look = lookTrial(r.key);
      const name = taskName(r.key);
      const what = look && look.trial.passed === false ? 'a failed trial' : 'a trial';
      const linkTitle = look ? `Open ${what} of ${name}, arm ${armOfTrial(look.trial).toUpperCase()}${look.disputed ? ' (your label disagrees with the judge)' : ''}` : '';
      return {
        key: r.key,
        name,
        grader: gradedBy(taskOf(r.key)),
        a: cell(r.key, 0),
        b: cell(r.key, 1),
        diff: r.diff,
        significant: r.significant,
        link: look ? href.trial(look.trial.id) : null,
        linkTitle,
      };
    })
    .sort((x, y) => (y.diff?.estimate ?? -999) - (x.diff?.estimate ?? -999));
});

const fx = (v: number) => 200 + Math.max(-100, Math.min(100, v)) * 2;
/** Arm colour only for a task whose difference holds up after correction; every other row is grey. */
const lean = (r: TaskRow) => (!r.diff || !r.significant ? 'neutral' : r.diff.estimate >= 0 ? 'b' : 'a');
function verdictOf(r: TaskRow): { kind: Verdict; label?: string } {
  if (!r.diff || !stats.value) return { kind: 'pending' };
  if (r.significant) return { kind: r.diff.estimate >= 0 ? 'better' : 'worse' };
  // Clear of zero on its own, but not once the other comparisons are accounted for.
  if (excludesZero(r.diff)) return { kind: 'none', label: 'No clear difference after correction' };
  return { kind: 'none' };
}
const labelOf = (r: TaskRow) => (!r.diff ? 'Not graded yet' : stats.value ? `${signed(r.diff.estimate)} (${intervalText(r.diff)})` : `${signed(r.diff.estimate)}, no interval`);
const passedText = (c: CompareRow | undefined) => (c ? `${c.passed} of ${c.graded}` : '–');

const differing = computed(() => taskRows.value.filter((r) => r.significant).length);

const correctionWords = computed(() => {
  const c = stats.value?.correction;
  if (!c) return null;
  if (c.toLowerCase() === 'holm') return "Holm's correction";
  if (c.toLowerCase() === 'bonferroni') return 'the Bonferroni correction';
  return `the ${c} correction`;
});

const judgeLine = computed(() => {
  const j = stats.value?.judge;
  const d = data.value;
  if (!j || !d) return null;
  const judged = d.detail.tasks.filter(isJudged).length;
  let line = `The judge scored ${judged} of the ${d.detail.tasks.length} tasks. It agrees with your held-out labels at κ ${j.kappa.toFixed(2)}, ${j.kappa >= j.bar ? 'above' : 'below'} the ${j.bar} bar set before the run${j.low < j.bar ? ', though its interval dips below it' : ''}.`;
  const toGo = d.queue.length;
  if (toGo) line += ` Provisional: ${toGo} held-out ${toGo === 1 ? 'output' : 'outputs'} still to label.`;
  return line;
});

/** Under the figure: when every task that differs is judge-graded, the verdict rests on the judge. */
const caveat = computed(() => {
  const s = stats.value;
  const d = data.value;
  if (!s || !d) return null;
  return judgeCaveat({ differing: taskRows.value.filter((r) => r.significant).map((r) => taskOf(r.key)), isJudged, judge: s.judge, toGo: d.queue.length });
});

/** On a phone the column heads are hidden, so the shared axis says what its intervals are. */
const axisCaption = computed(() => {
  const level = stats.value ? Math.round(stats.value.level * 100) : 95;
  const verdicts = correctionWords.value ? `verdicts after ${correctionWords.value} for ${taskRows.value.length} tasks.` : 'verdicts not corrected either.';
  return `B minus A, in points. ${level}% intervals, not corrected; ${verdicts}`;
});

/** The failed trial to open for a task: arm B first, then arm A, skipping any trial whose judge
 *  verdict your held-out label disputes, since that failure may not be the agent's. When every
 *  failure is disputed, the disputed one is still offered, and the button says so. */
function lookTrial(task: string): { trial: ExperimentTrial; disputed: boolean } | null {
  const d = data.value;
  if (!d) return null;
  const disputed = new Set((d.judge?.disagreements ?? []).map((x) => x.trial_id).filter((id): id is string => !!id));
  const failedIn = (arm: 0 | 1) => d.trials.filter((t) => t.task === task && t.config === d.detail.config_hashes[arm] && t.passed === false);
  const failed = [...failedIn(1), ...failedIn(0)];
  const clean = failed.find((t) => !disputed.has(t.id));
  if (clean) return { trial: clean, disputed: false };
  if (failed[0]) return { trial: failed[0], disputed: true };
  const any = failedTrial(task, 1);
  return any ? { trial: any, disputed: false } : null;
}

const worthALook = computed(() => {
  const s = stats.value;
  const candidates = taskRows.value.filter((r) => r.diff && r.diff.estimate < 0);
  const worst = candidates.sort((x, y) => (x.diff?.estimate ?? 0) - (y.diff?.estimate ?? 0))[0];
  if (!worst || !worst.diff || !s) return null;
  // The heading claims no more than the statistics: "got worse" only when it holds up.
  const title = worst.significant ? `Worth a look: ${worst.name} got worse` : `Worth a look: ${worst.name} fell from ${passedText(worst.a)} to ${passedText(worst.b)}`;
  const numbers = `(${signed(worst.diff.estimate)}, interval ${intervalText(worst.diff)})`;
  const finding = worst.significant
    ? `B passed ${passedText(worst.b)}, A passed ${passedText(worst.a)}. This difference holds up ${numbers}.`
    : excludesZero(worst.diff)
      ? `No clear difference after correcting for ${s.tasks.length} tasks ${numbers}.`
      : `No clear difference: its interval includes zero even before correcting for ${s.tasks.length} tasks ${numbers}.`;
  const look = lookTrial(worst.key);
  return {
    row: worst,
    title,
    text: `${finding} The failed trials show what went wrong.`,
    link: look ? href.trial(look.trial.id) : null,
    button: look?.disputed ? 'Open a failed trial (your label disagrees with the judge)' : 'Open a failed trial',
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
            <a
              v-if="commits.plan"
              :href="href.run(data.detail.id)"
              class="secondary"
              data-test="plan-commit"
            >plan <span class="mono">{{ commits.plan }}</span>, committed before the run</a>
            <span
              v-if="commits.platform"
              class="secondary"
              data-test="platform-commit"
            >platform <span class="mono">{{ commits.platform }}</span></span>
          </div>
        </div>
        <div class="actions">
          <div class="action-buttons">
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
          <p
            v-if="fixtures"
            class="secondary smaller export-note"
            data-test="export-note"
          >
            Export needs the API
          </p>
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
            <p
              v-if="caveat"
              class="caveat"
              data-test="judge-caveat"
            >
              <AppIcon
                name="alert"
                :size="14"
              />
              <span>{{ caveat.before }}<a :href="href.judge()">{{ caveat.link }}</a>{{ caveat.after }}</span>
            </p>
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
          <template v-if="worthALook">
            <!-- Takes the free height, so the next step sits at the foot of the answer column. -->
            <div
              class="push"
              aria-hidden="true"
            />
            <div
              class="look"
              data-test="worth-a-look"
            >
              <h3
                id="look"
                class="look-title"
              >
                {{ worthALook.title }}
              </h3>
              <p class="look-body">
                {{ worthALook.text }}
              </p>
              <a
                v-if="worthALook.link"
                :href="worthALook.link"
                class="btn look-btn"
                data-test="look-link"
              >{{ worthALook.button }}</a>
            </div>
          </template>
        </div>
        <div
          v-if="stats"
          class="verdict-why small"
        >
          <h3
            class="why-title"
            data-test="why-title"
          >
            {{ excludesZero(stats.diff) ? 'Why this is not noise' : 'Why this could be noise' }}
          </h3>
          <p
            v-for="(line, i) in why"
            :key="i"
            data-test="why-line"
          >
            {{ line }}
          </p>
          <h3
            class="why-title rests-title"
            data-test="why-title"
          >
            What it rests on
          </h3>
          <p v-if="judgeLine">
            {{ judgeLine }} <a :href="href.judge()">See the check</a>
          </p>
          <div class="infra">
            <p
              class="secondary"
              data-test="infra-sentence"
            >
              <template v-if="infraCount">
                {{ infraCount }} {{ infraCount === 1 ? 'trial' : 'trials' }} stopped on infra failures {{ infraCount === 1 ? 'was' : 'were' }} re-run and {{ infraCount === 1 ? 'is' : 'are' }} listed, not dropped.<template v-if="!infraTrials.length">
                  <a :href="href.run(data.detail.id)">See them on the run page</a>
                </template>
              </template>
              <template v-else>
                No trial stopped on an infra failure.
              </template>
            </p>
            <ul
              v-if="infraTrials.length"
              class="infra-list"
              data-test="infra-list"
            >
              <li
                v-for="t in infraTrials"
                :key="t.id"
              >
                <a
                  :href="href.trial(t.id)"
                  class="infra-link"
                ><span
                  :class="`dot dot--${armOfTrial(t)}`"
                  aria-hidden="true"
                /><span class="visually-hidden">Arm {{ armOfTrial(t).toUpperCase() }}, </span><span class="mono infra-task">{{ taskName(t.task) }}</span> <span>attempt {{ t.attempt }}</span> <span class="secondary">{{ infraReason(t.label) || t.status.replace('_', ' ') }}</span></a>
              </li>
            </ul>
          </div>
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
          Pass rate and what it costs
        </h2>
        <div class="stat-strip metrics">
          <div
            v-for="m in metrics"
            :key="m.name"
          >
            <span class="stat-label">{{ m.name }}</span>
            <span class="metric-delta num">{{ m.delta }}</span>
            <span class="secondary smaller num block">{{ m.interval }}</span>
            <!-- Each bar sits on a rail that is the tile's scale: 0 to 100% for pass rate, 0 to the
                 larger arm's value for the rest. -->
            <div
              class="bars"
              role="img"
              :aria-label="`${m.name}: A ${m.aText}, B ${m.bText}`"
            >
              <span class="bar-label num">A {{ m.aText }}</span>
              <span class="rail"><span
                class="bar bar--a"
                data-test="bar-a"
                :style="{ width: barShare(m.a, m.max) }"
              /></span>
              <span class="bar-label num">B {{ m.bText }}</span>
              <span class="rail"><span
                class="bar bar--b"
                data-test="bar-b"
                :style="{ width: barShare(m.b, m.max) }"
              /></span>
            </div>
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
            {{ differing }} {{ differing === 1 ? 'task differs' : 'tasks differ' }} {{ correctionWords ? `after ${correctionWords} for ${taskRows.length} comparisons` : 'before any correction for many comparisons' }}. The other {{ taskRows.length - differing }} {{ taskRows.length - differing === 1 ? 'shows' : 'show' }} no clear difference.
          </p>
        </div>
        <div class="table-wrap">
          <table
            class="table forest"
            data-test="forest"
          >
            <thead>
              <tr class="col-heads">
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
                  Difference, B minus A, {{ stats ? Math.round(stats.level * 100) : 95 }}% interval (not corrected)
                </th>
                <th scope="col">
                  Verdict
                </th>
              </tr>
              <tr
                aria-hidden="true"
                class="axis-row"
              >
                <td colspan="4" />
                <td class="axis-cell">
                  <span
                    class="axis-caption"
                    data-test="axis-caption"
                  >{{ axisCaption }}</span>
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
                <th
                  scope="row"
                  class="c-task"
                >
                  <a
                    v-if="r.link"
                    :href="r.link"
                    :title="r.linkTitle"
                    :aria-label="r.linkTitle"
                    class="mono task-link"
                  >{{ r.name }}</a>
                  <span
                    v-else
                    class="mono"
                  >{{ r.name }}</span>
                </th>
                <td class="secondary c-grader">
                  {{ r.grader }}
                </td>
                <td class="right num c-a">
                  <span class="phone-only">A </span>{{ passedText(r.a) }}
                </td>
                <td class="right num c-b">
                  <span class="phone-only">B </span>{{ passedText(r.b) }}
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
                      :class="`ci ci--${lean(r)}`"
                    />
                    <circle
                      :cx="fx(r.diff.estimate)"
                      cy="13"
                      r="6"
                      :class="`pt pt--${lean(r)}`"
                    />
                  </svg>
                </td>
                <td
                  class="c-verdict"
                  data-test="task-verdict"
                >
                  <VerdictTag
                    :verdict="verdictOf(r).kind"
                    :label="verdictOf(r).label"
                  />
                  <span class="result-detail">{{ labelOf(r) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
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

/* The export controls sit top right, level with the h1. */
.page-head {
  flex: 1 1 560px;
  min-width: 0;
}

.actions {
  flex: none;
  margin-left: auto;
  margin-top: 26px;
  align-self: flex-start;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.action-buttons {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.export-note {
  text-align: right;
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

.rests-title {
  margin-top: 20px;
}

/* What the result rests on, right under the figure: an icon and words, never colour alone. */
.caveat {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  max-width: 72ch;
  font-size: 14px;
  color: var(--ink-2);
}

.caveat .icon {
  margin-top: 4px;
}

.push {
  flex: 1 0 0;
}

/* The next step, at the foot of the answer column. */
.look {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  border-top: 1px solid var(--rule);
  padding-top: 16px;
}

.look-title {
  font-size: 15px;
}

.look-body {
  max-width: 72ch;
  font-size: 15px;
}

.look-btn {
  margin-top: 8px;
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
  margin-top: 12px;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 6px 10px;
}

.rail {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.bar {
  display: block;
  height: 6px;
  border-radius: 3px;
}

.bar--a {
  background: var(--arm-a);
}

.bar--b {
  background: var(--arm-b);
}

.bar-label {
  font-size: 12px;
  color: var(--ink);
}

.axis-caption {
  display: none;
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

.infra {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.infra-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* One underline, on the task id: the arm, attempt and reason read as plain text beside it. */
.infra-link {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-height: 32px;
  color: var(--ink);
  text-decoration: none;
}

.infra-task {
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
}

.infra-link:hover .infra-task {
  text-decoration-color: var(--ink);
}

.phone-only {
  display: none;
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

  .actions {
    margin-top: 0;
  }

  .table.forest .axis-caption {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--ink-2);
  }

  /* Task by task stacks: the shared axis once at the top, then for each task its name and
     verdict, its interval across the full width, and the counts with the grader underneath. */
  .table.forest,
  .table.forest thead,
  .table.forest tbody {
    display: block;
    min-width: 0;
  }

  .table.forest .col-heads {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .table.forest .axis-row {
    display: block;
  }

  .table.forest .axis-row > td {
    display: none;
  }

  .table.forest .axis-row > td.axis-cell {
    display: block;
    padding: 10px 16px 4px;
    border-bottom: 1px solid var(--rule);
  }

  .table.forest tbody tr {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 0;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rule-soft);
  }

  .table.forest tbody tr:last-child {
    border-bottom: 0;
  }

  .table.forest tbody tr > * {
    padding: 0;
    border: 0;
    text-align: left;
  }

  .table.forest .c-task {
    order: 1;
    flex: 1 1 0;
    min-width: 0;
    padding-right: 12px;
  }

  .table.forest .c-verdict {
    order: 2;
    flex: none;
    text-align: right;
  }

  .table.forest .plot-cell {
    order: 3;
    flex: 0 0 100%;
  }

  .table.forest .c-a,
  .table.forest .c-b,
  .table.forest .c-grader {
    font-size: 13px;
    color: var(--ink-2);
  }

  .table.forest .c-a {
    order: 4;
  }

  .table.forest .c-b {
    order: 5;
  }

  .table.forest .c-grader {
    order: 6;
  }

  .table.forest .c-b::before,
  .table.forest .c-grader::before {
    content: '·';
    padding: 0 6px;
  }

  .phone-only {
    display: inline;
  }
}
</style>
