<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../api/client';
import type { BlindItem, Config, Experiment, JudgeAgreement } from '../api/types';
import IntervalStrip from '../components/IntervalStrip.vue';
import LoadState from '../components/LoadState.vue';
import { armsOf } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { shortHash } from '../lib/format';
import { href } from '../router';

const { data, error, loading } = useLoad(async () => {
  const [agreement, configs, experiments, queue] = await Promise.all([
    api.judgeAgreement('heldout'),
    optional(api.configs(), [] as Config[]),
    optional(api.experiments(), [] as Experiment[]),
    optional(api.labelQueue('heldout'), [] as BlindItem[]),
  ]);
  return { agreement, configs, experiments, queue };
});

/** Held-out items still to label: until there are none, every number here is provisional. */
const toGo = computed(() => data.value?.queue.length ?? 0);

const j = computed<JudgeAgreement | null>(() => data.value?.agreement ?? null);

const answer = computed(() => {
  const a = j.value;
  if (!a) return null;
  const k = a.kappa;
  const title = k.estimate >= a.bar && k.low >= a.bar ? 'Yes, on this evidence' : k.estimate >= a.bar ? 'Mostly, with one caution' : 'Not yet';
  const pos = k.estimate >= a.bar ? 'above the bar' : 'below the bar';
  const tail = k.low < a.bar && k.estimate >= a.bar ? `, but the interval runs from ${k.low.toFixed(2)} to ${k.high.toFixed(2)}, so its lower end is under ${a.bar}` : `, with an interval from ${k.low.toFixed(2)} to ${k.high.toFixed(2)}`;
  return {
    title,
    text: `The judge agrees with you on ${a.agree} of ${a.labels} labelled checks (one output, one question). Cohen's κ is ${k.estimate.toFixed(2)}, ${pos}${tail}.`,
    meaning:
      k.low >= a.bar
        ? 'Judge-graded tasks can be read like the others.'
        : 'What this means for results: a difference that rests only on judge-graded tasks is weaker evidence than one the code graders also see. Read those task rows with that in mind.',
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

const lede = computed(() =>
  j.value
    ? `Measured on the ${j.value.labels} held-out labels, which are never used to tune the rubric. The bar of ${j.value.bar} was set before any results came in.`
    : 'Measured on the held-out labels, which are never used to tune the rubric.',
);

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
    <p
      v-if="toGo"
      class="provisional"
      data-test="provisional"
    >
      Provisional: {{ toGo }} held-out {{ toGo === 1 ? 'item' : 'items' }} still to label. These numbers will change.
    </p>
    <p class="lede">
      {{ lede }}
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
        The judge's agreement with your held-out labels is computed by the judge validation step (SP5), which has not reported yet. Until then, judge-graded results carry no measured trust.
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
            :ticks="[{ value: 0, label: '0' }, { value: j.bar, label: `bar ${j.bar}`, strong: true }, { value: 1, label: '1, full agreement' }]"
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
                <td class="agree">
                  <span class="n">{{ j.matrix.judge_pass_you_pass }}</span>agree
                </td>
                <td class="disagree">
                  <span class="n">{{ j.matrix.judge_pass_you_fail }}</span>too lenient
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Judge: fail
                </th>
                <td class="disagree">
                  <span class="n">{{ j.matrix.judge_fail_you_pass }}</span>too strict
                </td>
                <td class="agree">
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
              <span class="arm"><span
                class="dot"
                :class="armKey(c.config) ? `dot--${armKey(c.config)}` : ''"
              />{{ configLabel(c.config) }}, {{ c.labels }} labels</span>
              <span class="num strong">κ {{ c.kappa.toFixed(2) }}</span>
            </div>
            <p class="secondary">
              If the judge favoured one arm, the headline would be biased. Compare these two with the noise of {{ Math.min(...j.per_config.map((c) => c.labels)) }} labels each before reading anything into a gap.
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
            <p class="secondary small">
              verdicts were identical across all {{ j.retest.runs }} runs. {{ j.retest.note ?? '' }}
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
            <p class="secondary small">
              relabelled the same way. The ceiling for any judge is roughly your own consistency.
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
        <div class="table-wrap">
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

.provisional {
  margin-top: 8px;
  color: var(--ink-2);
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
  padding: 14px 0;
  border-radius: 8px;
  color: var(--ink);
}

.agree {
  background: var(--pass-soft);
}

.disagree {
  background: var(--fail-soft);
}

.n {
  display: block;
  font-size: 24px;
  font-weight: 600;
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
