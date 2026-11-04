<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../api/client';
import type { BlindItem, ConfigView, ExperimentSummary, JudgeAgreement } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import IntervalStrip from '../components/IntervalStrip.vue';
import LoadState from '../components/LoadState.vue';
import { armsOf, checksToGo as countChecks, NBSP } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { percent, plural, shortHash, wilson } from '../lib/format';
import { href } from '../router';

const { data, error, loading } = useLoad(async () => {
  const [agreement, configs, experiments, queue] = await Promise.all([
    api.judgeAgreement('heldout'),
    optional(api.configs(), [] as ConfigView[]),
    optional(api.experiments(), [] as ExperimentSummary[]),
    optional(api.labelQueue('heldout'), [] as BlindItem[]),
  ]);
  return { agreement, configs, experiments, queue };
});

/** Held-out items still to label: until there are none, every number here is provisional. */
const toGo = computed(() => data.value?.queue.length ?? 0);
/** The same work counted in checks (one output, one question), the unit the agreement is measured in. */
const checksToGo = computed(() => countChecks(data.value?.queue ?? []));

const j = computed<JudgeAgreement | null>(() => data.value?.agreement ?? null);

const answer = computed(() => {
  const a = j.value;
  if (!a) return null;
  const k = a.kappa;
  // While held-out checks remain to label, the answer is only as good as the labels so far.
  const soFar = toGo.value > 0;
  const title =
    k.estimate >= a.bar && k.low >= a.bar
      ? soFar
        ? 'Yes so far'
        : 'Yes, on this evidence'
      : k.estimate >= a.bar
        ? soFar
          ? 'Mostly so far, with one caution'
          : 'Mostly, with one caution'
        : 'Not yet';
  const pos = k.estimate >= a.bar ? 'above the bar' : 'below the bar';
  const tail = k.low < a.bar && k.estimate >= a.bar ? `, but the interval runs from ${k.low.toFixed(2)} to ${k.high.toFixed(2)}, so its lower end is under ${a.bar}` : `, with an interval from ${k.low.toFixed(2)} to ${k.high.toFixed(2)}`;
  return {
    title,
    text: `The judge agrees with you on ${a.agree} of ${a.labels} labelled checks (one output, one question). Cohen's κ is ${k.estimate.toFixed(2)}, ${pos}${tail}.`,
    meaning:
      k.low >= a.bar
        ? 'Judge-graded tasks can be read like the others.'
        : "What this means for results: a difference on tasks that need the judge's pass is weaker evidence than one on code-graded tasks. Read those task rows with that in mind.",
  };
});

/** The experiment that compared exactly these configs, so each one gets its arm's name and colour. */
const pairExperiment = computed(() => {
  const hashes = j.value?.per_config.map((c) => c.config) ?? [];
  return (
    data.value?.experiments.find((e) => e.config_hashes.length === 2 && e.config_hashes[0] !== e.config_hashes[1] && hashes.every((h) => e.config_hashes.includes(h))) ?? null
  );
});

function armKey(hash: string): 'a' | 'b' | null {
  const e = pairExperiment.value;
  if (!e) return null;
  return e.config_hashes[0] === hash ? 'a' : e.config_hashes[1] === hash ? 'b' : null;
}

function configLabel(hash: string): string {
  const e = pairExperiment.value;
  const arm = e ? armsOf(e, data.value?.configs ?? []).find((a) => a.hash === hash) : null;
  return arm?.label ?? `Config ${shortHash(hash)}`;
}

const lede = computed(() => {
  const a = j.value;
  if (!a) return 'Measured on the held-out checks, which are never used to tune the rubric.';
  const on = checksToGo.value ? `${a.labels} of ${a.labels + checksToGo.value} held-out checks so far` : `the ${a.labels} held-out checks`;
  // The bar is stated, not dated: D8 (the judge threshold) is still open, so nothing on record
  // says when it was set.
  return `Measured on ${on}, which are never used to tune the rubric. The bar is ${a.bar}.`;
});

/** "3 held-out outputs (7 checks)" */
const toGoWords = computed(() => `${plural(toGo.value, 'held-out output')} (${plural(checksToGo.value, 'check')})`);

/** Your own consistency beside the judge's agreement with you, each with its 95% interval. Ten
 *  relabels give a wide interval, so the line says when the two cannot be told apart. */
const selfLine = computed(() => {
  const a = j.value;
  if (!a?.self) return '';
  const rate = (k: number, n: number) => {
    const i = wilson(k, n);
    return `${percent(k / Math.max(1, n))}, interval ${percent(i.low)} to ${percent(i.high)}`;
  };
  const self = wilson(a.self.same, a.self.total);
  const judgeRate = a.agree / Math.max(1, a.labels);
  const judge = `The judge matched you on ${a.agree} of ${a.labels} (${rate(a.agree, a.labels)})`;
  const relabels = a.self.total === 1 ? '1 relabel is' : `${a.self.total} relabels are`;
  const verdict =
    judgeRate >= self.low && judgeRate <= self.high
      ? `${judge}. ${relabels} too few to tell that apart from your own consistency.`
      : `${judge}, ${judgeRate < self.low ? 'below' : 'above'} your own consistency.`;
  return `relabelled checks got the same answer (${rate(a.self.same, a.self.total)}). ${verdict}`;
});

/** "20 checks", or "20 and 18 checks" when the arms differ. */
function checksWords(counts: number[]): string {
  if (!counts.length) return '';
  if (counts.every((c) => c === counts[0])) return `${counts.length > 1 ? `${counts[0]} checks each` : plural(counts[0], 'check')}`;
  return `${counts.slice(0, -1).join(', ')} and ${counts[counts.length - 1]} checks`;
}

/** Under the per-config rows: what kappa per arm can and cannot say. No interval comes per arm,
 *  and kappa cannot say which arm the judge is lenient on; the matrix's disagreements are not
 *  split by arm. */
const perConfigNote = computed(() => {
  const a = j.value;
  if (!a) return '';
  const rows = a.per_config;
  const within = `Cohen's κ within each arm, ${checksWords(rows.map((c) => c.labels))}.`;
  const gap =
    rows.length === 2 ? ` No interval is given per arm, and at this size the gap between ${rows[0].kappa.toFixed(2)} and ${rows[1].kappa.toFixed(2)} says little.` : ' No interval is given per arm.';
  const lean = ` κ also cannot show which arm the judge is lenient on: the ${a.matrix.judge_pass_you_fail} too-lenient and ${a.matrix.judge_fail_you_pass} too-strict checks are not split by arm here.`;
  return `${within}${gap}${lean}`;
});

/** "checks got the same verdict in all 3 runs (96%, interval 91% to 98%)", with its Wilson 95%
 *  interval, as the line beside it gives for your own relabels. */
const retestLine = computed(() => {
  const r = j.value?.retest;
  if (!r) return '';
  const i = wilson(r.identical, r.total);
  return `checks got the same verdict in all ${r.runs} runs (${percent(r.identical / Math.max(1, r.total))}, interval ${percent(i.low)} to ${percent(i.high)}).${r.note ? ` ${r.note}` : ''}`;
});

const kappaText = (k: number) => `κ${NBSP}${k.toFixed(2)}`;

/** The kappa scale: evenly spaced, so a phone can keep every other tick. */
const kappaTicks = computed(() => {
  const bar = j.value?.bar ?? 0.6;
  const values = [0, 0.2, 0.4, 0.6, 0.8, 1].filter((v) => Math.abs(v - bar) > 1e-9);
  return [
    ...values.map((v) => (v === 1 ? { value: 1, label: '1, full agreement', short: '1' } : { value: v, label: String(v) })),
    { value: bar, label: `bar ${bar}`, strong: true },
  ].sort((p, q) => p.value - q.value);
});

const valueWord = (v: string) => (v === 'yes' || v === 'pass' ? 'Yes' : v === 'no' || v === 'fail' ? 'No' : 'Not sure');
</script>

<template>
  <div class="page-head">
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a :href="href.labels()">Labels</a> / Judge agreement
    </nav>
    <h1 tabindex="-1">
      Can we trust the judge?
    </h1>
    <p class="lede">
      {{ lede }}
    </p>
    <p
      v-if="toGo"
      class="caveat"
      data-test="provisional"
    >
      <AppIcon
        name="alert"
        :size="14"
      />
      <span><strong class="caveat-lead">Provisional:</strong> {{ toGoWords }} still to label. These numbers will change.</span>
    </p>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    what="the judge check"
  >
    <section
      v-if="!j"
      class="panel panel--pad"
      data-test="judge-empty"
    >
      <h2 class="section-title">
        Not measured yet
      </h2>
      <p class="secondary not-yet">
        The judge's agreement with the held-out human labels comes from the judge validation step, which has not reported yet. Until it does, judge-graded results carry no measured trust.
      </p>
    </section>
    <template v-else-if="answer">
      <section
        aria-labelledby="answer"
        class="panel answer"
        data-test="judge-answer"
      >
        <div class="answer-main">
          <h2
            id="answer"
            class="answer-title"
          >
            {{ answer.title }}
          </h2>
          <p class="answer-text">
            {{ answer.text }}
          </p>
          <IntervalStrip
            :min="0"
            :max="1"
            :ticks="kappaTicks"
            :rows="[{ estimate: j.kappa.estimate, low: j.kappa.low, high: j.kappa.high, tone: 'ink', label: `κ ${j.kappa.estimate.toFixed(2)}, ${j.labels} labelled checks` }]"
            :reference="{ value: j.bar }"
            :summary="`Kappa ${j.kappa.estimate.toFixed(2)}, interval ${j.kappa.low.toFixed(2)} to ${j.kappa.high.toFixed(2)}, bar at ${j.bar}`"
          />
          <p class="secondary small meaning">
            {{ answer.meaning }}
          </p>
        </div>
        <div class="answer-side">
          <h3 class="sub-title">
            Where you and the judge land
          </h3>
          <table
            class="matrix small"
            data-test="judge-matrix"
          >
            <thead>
              <tr>
                <td />
                <th scope="col">
                  You: pass
                </th>
                <th scope="col">
                  You: fail
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  Judge: pass
                </th>
                <td
                  class="agree"
                  data-test="matrix-cell"
                >
                  <span class="n">{{ j.matrix.judge_pass_you_pass }}</span>agree
                </td>
                <td
                  class="disagree"
                  data-test="matrix-cell"
                >
                  <span class="n">{{ j.matrix.judge_pass_you_fail }}</span>too lenient
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Judge: fail
                </th>
                <td
                  class="disagree"
                  data-test="matrix-cell"
                >
                  <span class="n">{{ j.matrix.judge_fail_you_pass }}</span>too strict
                </td>
                <td
                  class="agree"
                  data-test="matrix-cell"
                >
                  <span class="n">{{ j.matrix.judge_fail_you_fail }}</span>agree
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="stat-strip three">
        <section aria-labelledby="perconfig">
          <h2
            id="perconfig"
            class="cell-title"
          >
            Per config
          </h2>
          <div class="per-config small">
            <div
              v-for="c in j.per_config"
              :key="c.config"
              class="per-row"
            >
              <span
                class="arm"
                data-test="per-config-row"
              ><span
                class="dot"
                :class="armKey(c.config) ? `dot--${armKey(c.config)}` : ''"
              /><span>{{ configLabel(c.config) }} · <span class="num">{{ kappaText(c.kappa) }}</span> · {{ plural(c.labels, 'check') }}</span></span>
            </div>
            <p
              class="secondary"
              data-test="per-config-note"
            >
              {{ perConfigNote }}
            </p>
          </div>
        </section>
        <section aria-labelledby="retest">
          <h2
            id="retest"
            class="cell-title"
          >
            Same input, judged {{ j.retest?.runs ?? 3 }} times
          </h2>
          <template v-if="j.retest">
            <span class="figure num">{{ j.retest.identical }} of {{ j.retest.total }}</span>
            <p
              class="secondary small"
              data-test="retest-line"
            >
              {{ retestLine }}
            </p>
          </template>
          <p
            v-else
            class="secondary small"
          >
            Not run yet.
          </p>
        </section>
        <section aria-labelledby="self">
          <h2
            id="self"
            class="cell-title"
          >
            You, a day later
          </h2>
          <template v-if="j.self">
            <span class="figure num">{{ j.self.same }} of {{ j.self.total }}</span>
            <p
              class="secondary small"
              data-test="self-line"
            >
              {{ selfLine }}
            </p>
          </template>
          <p
            v-else
            class="secondary small"
          >
            No relabelling yet.
          </p>
        </section>
      </div>

      <section
        aria-labelledby="disagree"
        class="stack"
      >
        <h2
          id="disagree"
          class="section-title"
        >
          The {{ j.disagreements.length }} disagreements
        </h2>
        <!-- Until the held-out set is labelled, the judge's reasons stay closed, so they cannot
             steer the labels still to come. The numbers above stay, marked provisional. -->
        <p
          v-if="toGo > 0"
          class="secondary"
          data-test="disagreements-later"
        >
          These open when the held-out set is done ({{ toGo }} to go), so the judge's reasons cannot steer the labels still to come.
        </p>
        <div
          v-else
          class="table-wrap"
        >
          <table class="table disagreements">
            <thead>
              <tr>
                <th scope="col">
                  Task
                </th>
                <th scope="col">
                  Question
                </th>
                <th scope="col">
                  You
                </th>
                <th scope="col">
                  Judge
                </th>
                <th scope="col">
                  Judge's evidence
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(r, i) in j.disagreements"
                :key="i"
                data-test="disagreement-row"
              >
                <th scope="row">
                  <a
                    v-if="r.trial_id"
                    :href="href.trial(r.trial_id)"
                    class="mono task-link"
                  >{{ r.task }}</a>
                  <span
                    v-else
                    class="mono"
                  >{{ r.task }}</span>
                </th>
                <td>{{ r.criterion }}</td>
                <td class="strong">
                  {{ valueWord(r.you) }}
                </td>
                <td class="strong">
                  {{ valueWord(r.judge) }}
                </td>
                <td class="secondary">
                  {{ r.evidence }}
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
.not-yet {
  margin-top: 8px;
  max-width: 72ch;
}

.answer {
  display: flex;
  flex-wrap: wrap;
  border-radius: 14px;
}

.answer-main {
  flex: 999 1 560px;
  min-width: 0;
  padding: 28px 32px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.answer-title {
  font-size: 30px;
  letter-spacing: -0.01em;
}

.answer-text {
  font-size: 17px;
  max-width: 62ch;
}

.meaning {
  max-width: 72ch;
}

.answer-side {
  flex: 1 1 320px;
  min-width: 0;
  padding: 28px 30px;
  border-left: 1px solid var(--rule-soft);
}

.sub-title {
  font-size: 15px;
  margin-bottom: 12px;
}

.matrix {
  width: 100%;
  border-collapse: separate;
  border-spacing: 6px;
  text-align: center;
}

.matrix th {
  font-weight: 500;
  color: var(--ink-2);
}

.matrix tbody th {
  text-align: right;
}

.matrix td {
  padding: 14px 8px;
  border-radius: 8px;
  color: var(--ink);
}

/* Neutral on purpose: the words agree, too lenient and too strict carry the meaning. The
   disagreements are the cells to read, so they get the ink outline and the heavier count. */
.agree {
  background: var(--surface-muted);
}

.disagree {
  background: var(--surface);
  box-shadow: inset 0 0 0 2px var(--ink);
}

.n {
  display: block;
  font-size: 24px;
  font-weight: 600;
  color: var(--ink);
}

.disagree .n {
  font-weight: 700;
}

.three {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.three > section {
  padding: 22px 24px;
}

.cell-title {
  font-size: 16px;
  margin-bottom: 12px;
}

.per-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.per-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.strong {
  font-weight: 600;
}

.figure {
  display: block;
  font-size: 28px;
  font-weight: 600;
}

.disagreements {
  min-width: 820px;
}

.task-link {
  color: var(--ink);
}

@media (max-width: 640px) {
  .answer-main {
    padding: 22px 20px;
  }

  .answer-side {
    padding: 20px;
    border-left: 0;
    border-top: 1px solid var(--rule-soft);
  }

  .answer-title {
    font-size: 26px;
  }
}
</style>
