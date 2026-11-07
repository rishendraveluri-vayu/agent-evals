<script setup lang="ts">
/**
 * How far to trust each LLM judge (D83, GET /judge/trust). A judge is a judge model × rubric; its
 * trust is worked out criterion by criterion from the human labels on outputs it graded, and its
 * own status is its overall criterion's. Each judge shows its status and summary, the figures per
 * criterion, where it and people disagree, and a link to label more of its outputs blind.
 *
 * Where it and people disagree lists every labelled output the judge got wrong, open to anyone, with
 * a caution to label first: reading the judge's reasons can steer the labels still to come (7 Nov).
 * The labels page stays blind; it never shows the judge's verdicts.
 */
import { computed } from 'vue';
import { api } from '../api/client';
import type { AgreementFigures, ExperimentDetail, ExperimentSummary, JudgeCriterionTrust, JudgeTrust, JudgeTrustResponse, JudgeTrustStatus, TaskView } from '../api/types';
import IntervalStrip from '../components/IntervalStrip.vue';
import LoadState from '../components/LoadState.vue';
import TrustBadge from '../components/TrustBadge.vue';
import { optional, useLoad } from '../lib/async';
import { capitalise, minus, percent, plainText, plural } from '../lib/format';
import { experimentName, modelName } from '../lib/names';
import type { StripRow, Tick } from '../lib/scale';
import { intervalWords, kappaWords, labelSetFor, minusSigns, rubricName } from '../lib/trust';
import { href } from '../router';

type TrustSet = 'heldout' | 'tuning';
type Disagreement = JudgeCriterionTrust['disagreements'][number] & { criterion: string };

const { data, error, loading } = useLoad(async () => {
  const [trust, experiments, tasks] = await Promise.all([
    api.judgeTrust(),
    optional(api.experiments(), [] as ExperimentSummary[]),
    optional(api.tasks(), [] as TaskView[]),
  ]);
  // Each judge's experiment to calibrate on, in full: the tasks as it ran them say which label set
  // its outputs go to. The task list can't once a task has a newer version (the held-out tasks
  // each got one with rubric v4, D83), as its hashes no longer match the experiment's.
  const ids = [...new Set(trust.judges.map((j) => ownExperimentOf(j, experiments)).filter((id): id is string => id !== null))];
  const details = new Map(await Promise.all(ids.map(async (id) => [id, await optional(api.experiment(id), null as ExperimentDetail | null)] as const)));
  return { trust, experiments, tasks, details };
});

const trust = computed<JudgeTrustResponse | null>(() => data.value?.trust ?? null);
const bar = computed(() => trust.value?.bar ?? null);

const SET_NAMES: Record<TrustSet, string> = { heldout: 'held-out', tuning: 'tuning' };

/** The judge's newest experiment of your own: a shipped example is never labelled. */
function ownExperimentOf(j: JudgeTrust, experiments: readonly ExperimentSummary[]): string | null {
  return j.experiments.find((id) => experiments.some((x) => x.id === id && !x.example)) ?? null;
}

/** Where to calibrate the judge: on its newest experiment of your own, in the held-out set when
 *  that experiment ran held-out tasks, else tuning. Its tasks as it ran them, else the current
 *  tasks with the same hashes. */
function calibrateOf(j: JudgeTrust): { href: string; name: string } | null {
  const d = data.value;
  if (!d) return null;
  const id = ownExperimentOf(j, d.experiments);
  const e = d.experiments.find((x) => x.id === id);
  if (!id || !e) return null;
  const ran = d.details.get(id)?.tasks ?? d.tasks.filter((t) => e.task_sha256s.includes(t.sha256));
  if (!ran.length) return null;
  return { href: href.labels({ set: labelSetFor(ran), experiment: id, calibrate: true }), name: experimentName(e) };
}

/** Held-out kappa per criterion with its interval, on one scale with the bar; only the criteria
 *  whose kappa and interval are both defined. */
function stripOf(j: JudgeTrust) {
  const b = bar.value;
  const shown = j.criteria.filter((c) => c.heldout && c.heldout.kappa !== null && c.heldout.kappa_interval.low !== null && c.heldout.kappa_interval.high !== null);
  if (!b || !shown.length) return null;
  const rows: StripRow[] = shown.map((c) => {
    const f = c.heldout as AgreementFigures;
    return { estimate: f.kappa as number, low: f.kappa_interval.low as number, high: f.kappa_interval.high as number, tone: 'ink', label: `${c.criterion} ${kappaWords(f.kappa)}` };
  });
  const min = Math.min(0, Math.floor(Math.min(...rows.map((r) => r.low)) * 5) / 5);
  const values: number[] = [];
  for (let v = min; v <= 1 + 1e-9; v += 0.2) values.push(Math.round(v * 10) / 10);
  const ticks: Tick[] = [
    ...values.filter((v) => Math.abs(v - b.kappa) > 1e-9).map((v) => (v === 1 ? { value: 1, label: '1, full agreement', short: '1' } : { value: v, label: minus(String(v)) })),
    { value: b.kappa, label: `bar ${b.kappa}`, strong: true },
  ].sort((p, q) => p.value - q.value);
  const parts = shown.map((c) => `${c.criterion} ${kappaWords(c.heldout?.kappa ?? null)} (${intervalWords(c.heldout?.kappa_interval)})`);
  return { rows, ticks, min, summary: `Held-out kappa by question, with its interval: ${parts.join('; ')}. The bar is ${b.kappa}.` };
}

/** Where the judge and people disagree, held-out first, and how many: each is one question on one
 *  output, so an output wrong on two questions is listed twice and counted as one output. */
function disagreementsOf(j: JudgeTrust) {
  const all: Disagreement[] = j.criteria.flatMap((c) => c.disagreements.map((d) => ({ ...d, criterion: c.criterion })));
  all.sort((p, q) => (p.set === q.set ? 0 : p.set === 'heldout' ? -1 : 1));
  const outputs = new Set(all.map((d) => d.trial_id)).size;
  // Always both counts, so two judges' lines read alike ("20 disagreements on 17 outputs" beside
  // "4 disagreements on 4 outputs", not "4 outputs"; QA, 7 Nov).
  const count = `${plural(all.length, 'disagreement')} on ${plural(outputs, 'output')}`;
  // From the figures, not the list (which the API caps): labelled outputs, and how many it got wrong.
  const figures = j.criteria.flatMap((c) => [c.heldout, c.tuning]).filter((f): f is AgreementFigures => f !== null);
  const pairs = figures.reduce((sum, f) => sum + f.n, 0);
  const counted = figures.reduce((sum, f) => sum + f.fp + f.fn, 0);
  return { all, count, agrees: pairs > 0 && counted === 0, capped: j.criteria.some((c) => c.disagreements.length >= 50) };
}

/** Whether the judge graded any output of a discovery task, the tuning set's outputs: false only
 *  when every question says so (an API without `asked_on` gives no answer, null). */
function gradedTuning(j: JudgeTrust): boolean | null {
  if (!j.criteria.length || j.criteria.some((c) => !c.asked_on)) return null;
  return j.criteria.some((c) => (c.asked_on?.discovery_tasks ?? 0) > 0);
}

const judges = computed(() =>
  (trust.value?.judges ?? []).map((j, i) => ({
    key: `${j.judge_model} ${j.rubric}`,
    id: `judge-${i}`,
    judge: j,
    calibrate: calibrateOf(j),
    strip: stripOf(j),
    disagreements: disagreementsOf(j),
    gradedTuning: gradedTuning(j),
  })),
);

const yesNo = (v: 'yes' | 'no') => (v === 'yes' ? 'Yes' : 'No');

/** One set's figures as lines of text: how many labels, kappa and its interval, and how the judge
 *  answers where people say yes and where they say no. */
function figureLines(f: AgreementFigures | null): string[] {
  if (!f) return [];
  const iv = intervalWords(f.kappa_interval);
  const lines = [`${plural(f.n, 'label')}, ${f.human_no} of them "no"`, `Kappa ${kappaWords(f.kappa)}${iv ? ` (${iv})` : f.kappa === null ? '' : ', no interval yet'}`];
  const sides = [f.sensitivity !== null ? `yes to ${percent(f.sensitivity)} of people's yes` : '', f.specificity !== null ? `no to ${percent(f.specificity)} of their no` : ''].filter(Boolean);
  if (sides.length) lines.push(`Says ${sides.join(', ')}`);
  const out = [f.human_left_out ? `${f.human_left_out} not sure or tied` : '', f.judge_undecided ? `${f.judge_undecided} the judge did not decide` : ''].filter(Boolean);
  if (out.length) lines.push(`Left out: ${out.join(', ')}`);
  return lines;
}

const tuningLine = (f: AgreementFigures | null) => (f ? `${plural(f.n, 'label')}, kappa ${kappaWords(f.kappa)}` : '');
/** No tuning labels, and why when it is not for want of labelling: the judge graded no tuning
 *  output at all, or none that asks this question (QA, 7 Nov: every question of a judge that
 *  graded only held-out tasks read "None yet"). */
function noTuningWords(c: JudgeCriterionTrust, gradedAny: boolean | null): string {
  if (gradedAny === false) return 'None: this judge graded no tuning outputs';
  if (gradedAny && c.asked_on && !c.asked_on.discovery_tasks) return 'None: no tuning output it graded asks this';
  return 'None yet';
}
/** Above a question asked on several tasks in different words: its labels pool answers to each
 *  task's own wording, and the text shown is one of them (QA, 7 Nov). */
function askedWords(c: JudgeCriterionTrust): string {
  const a = c.asked_on;
  if (!a || a.tasks < 2 || a.wordings < 2) return '';
  return a.wordings >= a.tasks ? `Asked on ${a.tasks} tasks, worded for each; for example:` : `Asked on ${a.tasks} tasks in ${a.wordings} wordings; for example:`;
}
const retestLine = (r: JudgeCriterionTrust['retest']) => (r ? `${r.identical} of ${r.total} the same${r.share !== null ? ` (${percent(r.share)})` : ''}` : '');
const reasonsOf = (c: JudgeCriterionTrust) => (c.status === 'not_trusted' ? (c.d8?.reasons ?? []).map((r) => capitalise(minusSigns(plainText(r)))) : []);
const needsLine = (c: JudgeCriterionTrust) => (c.status === 'too_few' && c.needs_human_no ? `Needs ${c.needs_human_no} more "no" ${c.needs_human_no === 1 ? 'label' : 'labels'} on held-out outputs.` : '');

/** What each badge means, with the bar as the API applies it. */
const statuses = computed<{ status: JudgeTrustStatus; text: string }[]>(() => {
  const b = bar.value;
  const trusted = b
    ? `Tested on held-out labels, and it clears the bar: kappa at least ${b.kappa}, the low end of its interval at least ${b.kappa_low}, at least ${b.min_human_no} "no" labels from people, no gap between the arms in how often it passes what people fail, and the same verdict at least ${percent(b.retest)} of the time when it grades an output again.`
    : 'Tested on held-out labels, and it clears the bar.';
  return [
    { status: 'uncalibrated', text: 'No one has labelled an output this judge graded. Its verdicts are a hint.' },
    { status: 'tuning_only', text: 'Labelled only in the tuning set, which shapes the rubric. Its agreement is shown, but it has not been tested blind.' },
    { status: 'too_few', text: `Held-out labels exist, but fewer than ${b?.min_human_no ?? 5} of them are "no", or kappa cannot be worked out yet, so the bar cannot be applied.` },
    { status: 'trusted', text: trusted },
    { status: 'not_trusted', text: 'Tested on held-out labels, and it misses the bar. The reasons are listed with it.' },
  ];
});
</script>

<template>
  <div class="page-head">
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a :href="href.labels()">Labels</a> / Judge trust
    </nav>
    <h1 tabindex="-1">
      Can we trust the judge?
    </h1>
    <p
      class="lede"
      data-test="judge-lede"
    >
      A judge is only as good as its agreement with people. Each one here is measured against human labels on the outputs it graded, one question at a time. Label a few outputs blind and its agreement updates as you go.
    </p>
    <p
      class="secondary small kappa-note"
      data-test="kappa-note"
    >
      Kappa is agreement beyond chance: 1 is perfect, 0 is no better than chance.
    </p>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    what="how far to trust each judge"
  >
    <section
      v-if="!judges.length"
      class="panel panel--pad"
      data-test="judge-empty"
    >
      <h2 class="section-title">
        No judge has graded any output yet.
      </h2>
      <p class="secondary empty-text">
        Approve judging on an experiment's comparison page. Once its grades are in, each judge shows here with how far to trust it.
      </p>
    </section>

    <section
      v-for="j in judges"
      :key="j.key"
      :aria-labelledby="j.id"
      class="panel judge"
      data-test="judge"
    >
      <div class="judge-head">
        <div class="judge-name">
          <h2
            :id="j.id"
            class="section-title"
            data-test="judge-name"
          >
            {{ modelName(j.judge.judge_model) }}, rubric <span
              class="mono"
              :title="j.judge.rubric"
            >{{ rubricName(j.judge.rubric) }}</span>
          </h2>
          <p class="secondary small">
            {{ plural(j.judge.trials_judged, 'trial') }} judged, in {{ plural(j.judge.experiments.length, 'experiment') }}
          </p>
        </div>
        <TrustBadge :status="j.judge.status" />
      </div>
      <p
        class="judge-summary"
        data-test="judge-summary"
      >
        {{ minusSigns(plainText(j.judge.summary)) }}
      </p>
      <p
        v-if="j.calibrate"
        class="calibrate-row"
      >
        <a
          class="btn btn--quiet"
          :href="j.calibrate.href"
          data-test="judge-calibrate"
        >Calibrate this judge</a>
        <span class="secondary small">Label outputs from {{ j.calibrate.name }}, without seeing its verdicts.</span>
      </p>

      <IntervalStrip
        v-if="j.strip"
        class="strip"
        :min="j.strip.min"
        :max="1"
        :ticks="j.strip.ticks"
        :rows="j.strip.rows"
        :reference="{ value: bar?.kappa ?? 0.6 }"
        :summary="j.strip.summary"
      />

      <div class="table-wrap criteria-wrap">
        <table
          class="table criteria"
          data-test="criteria-table"
        >
          <caption class="visually-hidden">
            How far to trust {{ modelName(j.judge.judge_model) }} on each question
          </caption>
          <thead>
            <tr>
              <th scope="col">
                Question
              </th>
              <th scope="col">
                Trust
              </th>
              <th scope="col">
                Held-out labels
              </th>
              <th scope="col">
                Tuning labels
              </th>
              <th scope="col">
                Same verdict twice
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in j.judge.criteria"
              :key="c.criterion"
              :data-criterion="c.criterion"
              data-test="criterion-row"
            >
              <th scope="row">
                <span class="mono strong">{{ c.criterion }}</span>
                <span
                  v-if="c.text && askedWords(c)"
                  class="secondary smaller block asked"
                  data-test="criterion-asked"
                >{{ askedWords(c) }}</span>
                <span
                  v-if="c.text"
                  class="secondary small block question"
                  data-test="criterion-question"
                >{{ c.text }}</span>
              </th>
              <td data-test="criterion-trust">
                <span class="cell-label">Trust</span>
                <TrustBadge
                  :status="c.status"
                  :summary="c.summary"
                />
                <ul
                  v-if="reasonsOf(c).length"
                  class="reasons small"
                  data-test="criterion-reasons"
                >
                  <li
                    v-for="(r, ri) in reasonsOf(c)"
                    :key="ri"
                  >
                    {{ r }}
                  </li>
                </ul>
                <p
                  v-if="needsLine(c)"
                  class="small needs"
                  data-test="criterion-needs"
                >
                  {{ needsLine(c) }}
                </p>
              </td>
              <td data-test="criterion-heldout">
                <span class="cell-label">Held-out labels</span>
                <template v-if="c.heldout">
                  <span
                    v-for="(line, li) in figureLines(c.heldout)"
                    :key="li"
                    class="block"
                    :class="{ 'secondary small': li > 1 }"
                  >{{ line }}</span>
                </template>
                <span
                  v-else
                  class="secondary"
                >None yet</span>
              </td>
              <td data-test="criterion-tuning">
                <span class="cell-label">Tuning labels</span>
                <span v-if="c.tuning">{{ tuningLine(c.tuning) }}</span>
                <span
                  v-else
                  class="secondary"
                >{{ noTuningWords(c, j.gradedTuning) }}</span>
              </td>
              <td data-test="criterion-retest">
                <span class="cell-label">Same verdict twice</span>
                <span v-if="c.retest">{{ retestLine(c.retest) }}</span>
                <span
                  v-else
                  class="secondary"
                >Not measured yet</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details
        v-if="j.disagreements.all.length"
        class="disclosure disagreements"
        data-test="disagreements"
      >
        <summary>
          <span class="summary-text">
            <span class="strong">Where it and people disagree</span>
            <span
              class="secondary small"
              data-test="disagreements-count"
            >{{ j.disagreements.count }}</span>
          </span>
        </summary>
        <p
          class="secondary small held"
          data-test="disagreements-caution"
        >
          If you will label this judge's outputs, label them first: its reasons here can steer the labels you give.
        </p>
        <ul class="dis-list">
          <li
            v-for="(d, di) in j.disagreements.all"
            :key="di"
            class="dis"
            data-test="disagreement"
          >
            <p class="dis-head small">
              <a
                :href="href.trial(d.trial_id)"
                class="mono"
              >{{ d.task_id }}</a> · <span class="mono">{{ d.criterion }}</span> · <span class="secondary">{{ capitalise(SET_NAMES[d.set]) }} label</span>
            </p>
            <p
              class="small"
              data-test="disagreement-verdicts"
            >
              People said <strong>{{ yesNo(d.human) }}</strong>, the judge said <strong>{{ yesNo(d.judge) }}</strong>.
            </p>
            <p
              v-if="d.judge_reason"
              class="small secondary"
              data-test="disagreement-reason"
            >
              The judge's reason: {{ d.judge_reason }}
            </p>
            <p
              v-if="d.human_note"
              class="small secondary"
              data-test="disagreement-note"
            >
              The label's note: {{ d.human_note }}
            </p>
          </li>
        </ul>
        <p
          v-if="j.disagreements.capped"
          class="secondary smaller held"
        >
          Up to 50 are listed for each question.
        </p>
      </details>
      <p
        v-else-if="j.disagreements.agrees"
        class="secondary small"
        data-test="no-disagreements"
      >
        It matches people on every labelled output so far.
      </p>
    </section>

    <section
      aria-labelledby="badges"
      class="panel panel--pad legend"
      data-test="trust-legend"
    >
      <h2
        id="badges"
        class="section-title"
      >
        What the badges mean
      </h2>
      <p class="secondary small legend-lede">
        Held-out labels test the judge, on tasks its rubric was never tuned on. Tuning labels only help write the rubric. A badge never changes a grade: it says how far to read one.
      </p>
      <dl class="statuses">
        <div
          v-for="s in statuses"
          :key="s.status"
          data-test="legend-row"
        >
          <dt><TrustBadge :status="s.status" /></dt>
          <dd class="small">
            {{ s.text }}
          </dd>
        </div>
      </dl>
    </section>
  </LoadState>
</template>

<style scoped>
.kappa-note {
  margin-top: 6px;
  max-width: 72ch;
}

.empty-text {
  margin-top: 8px;
  max-width: 72ch;
}

.judge {
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.judge-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 16px;
}

.judge-name {
  min-width: 0;
}

.judge-name .mono {
  font-size: 15px;
}

.judge-summary {
  max-width: 72ch;
}

.calibrate-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}

.strip {
  max-width: 760px;
}

.strong {
  font-weight: 600;
}

.question {
  margin-top: 2px;
  max-width: 40ch;
}

.asked {
  margin-top: 2px;
  max-width: 40ch;
}

.criteria .mono {
  white-space: normal;
}

.reasons {
  margin: 8px 0 0;
  padding-left: 18px;
  max-width: 40ch;
}

.reasons li + li {
  margin-top: 4px;
}

.needs {
  margin-top: 6px;
}

.cell-label {
  display: none;
}

.disagreements {
  padding-bottom: 6px;
}

.held {
  margin: 4px 0 10px;
  max-width: 72ch;
}

.dis-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.dis {
  padding: 12px 0;
  border-top: 1px solid var(--rule-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 80ch;
}

.dis-head .mono {
  white-space: nowrap;
}

.legend-lede {
  margin: 6px 0 12px;
  max-width: 72ch;
}

.statuses {
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 10px 16px;
  align-items: baseline;
}

.statuses > div {
  display: contents;
}

.statuses dd {
  margin: 0;
  max-width: 72ch;
}

/* A phone reads each question as a card: one figure under another, each with its name, so the
   page never scrolls sideways. */
@media (max-width: 760px) {
  .judge {
    padding: 18px 16px;
  }

  .criteria thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .criteria,
  .criteria tbody,
  .criteria tr,
  .criteria th,
  .criteria td {
    display: block;
    width: 100%;
  }

  .criteria tr {
    padding: 10px 0;
    border-bottom: 1px solid var(--rule-soft);
  }

  .criteria tbody tr:last-child {
    border-bottom: 0;
  }

  .table.criteria th,
  .table.criteria td {
    border-bottom: 0;
    padding: 4px 16px;
  }

  .cell-label {
    display: block;
    color: var(--ink-2);
    font-size: 13px;
  }

  .statuses {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }

  .statuses dd {
    margin-bottom: 8px;
  }
}
</style>
