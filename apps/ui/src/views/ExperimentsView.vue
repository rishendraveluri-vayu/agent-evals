<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api/client';
import type { Compare, ConfigView, ExampleView, ExperimentSummary, ExperimentDetail, TrialRowSummary, Harness } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import IntervalStrip from '../components/IntervalStrip.vue';
import LoadState from '../components/LoadState.vue';
import VerdictTag from '../components/VerdictTag.vue';
import { armsOf, axisWords, checksToGo, doneCount, headline, HEADLINE_EXAMPLE, intervalText, judgeCaveat, NBSP, pickLatest, pointsWithInterval, setupOf, timeLeft, totalTrials, verdictWords, type Verdict } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { capitalise, identParts, minutes, money, percent, plainText, plural, relative, signed } from '../lib/format';
import { isFake } from '../lib/models';
import { pauseCause } from '../lib/runs';
import { alsoGradedBy, experimentName, harnessShort, isJudged, modelName, settingLabel, splitName } from '../lib/names';
import { domainFor, ticksFor, verdictTone, type StripRow } from '../lib/scale';
import { href } from '../router';

interface Loaded {
  experiments: ExperimentSummary[];
  configs: ConfigView[];
  harnesses: Harness[];
  /** GET /examples: which experiments are shipped examples, by id. */
  examples: ExampleView[];
  heldoutToGo: number | null;
  /** Tuning outputs still to label (open coding before any rubric). */
  tuningToGo: number;
  /** The same outputs counted in checks (one output, one question). */
  heldoutChecksToGo: number;
  compares: Map<string, Compare | null>;
  latest: ExperimentDetail | null;
  latestFailed: TrialRowSummary | null;
  /** Running and paused experiments in full, for what paused them and which arm (D32, D37). */
  live: Map<string, ExperimentDetail>;
}

/** The list carries only when an experiment was made; its detail has when it finished. */
const updatedAt = (e: ExperimentSummary, detail?: ExperimentDetail | null) => detail?.finished_at ?? detail?.started_at ?? e.created_at;
const twoArms = (e: ExperimentSummary) => e.config_hashes.length === 2;

const { data, error, loading, reload } = useLoad<Loaded>(async () => {
  const [experiments, configs, harnesses, queue, tuning, examples] = await Promise.all([
    api.experiments(),
    api.configs(),
    optional(api.harnesses(), [] as Harness[]),
    optional(api.labelQueue('heldout'), null),
    optional(api.labelQueue('tuning'), []),
    optional(api.examples(), [] as ExampleView[]),
  ]);
  const finished = experiments.filter((e) => e.status === 'done' && twoArms(e));
  const compares = new Map(await Promise.all(finished.map(async (e) => [e.id, await optional(api.compare(e.id), null)] as const)));
  // The list is newest first (by when each was made). The latest result is a finished A/B with
  // statistics, else one whose comparison is complete, read as counts: your own newest on a real
  // model, unless the shipped headline example is here and nothing of yours is newer (lib/arms.ts
  // pickLatest). A run on fake models only never leads.
  const shippedName = (e: ExperimentSummary) => shippedOf(e, examples);
  // The front door's example (OpenExampleView opens the first by name): the headline's.
  const pinned = examples[0]?.name ?? HEADLINE_EXAMPLE;
  const ab = finished.filter((e) => !e.calibration && e.config_hashes[0] !== e.config_hashes[1]);
  const latestId = (
    pickLatest(ab, configs, shippedName, (e) => !!compares.get(e.id)?.stats, pinned) ??
    pickLatest(ab, configs, shippedName, (e) => compares.get(e.id)?.status === 'complete', pinned)
  )?.id;
  const latest = latestId ? await optional(api.experiment(latestId), null) : null;
  const trials = latestId ? await optional(api.experimentTrials(latestId, { status: 'done' }), [] as TrialRowSummary[]) : [];
  // Step 4 opens a failure of arm B on the task where B did worst: the most telling one to read.
  const worst = latestId ? [...(compares.get(latestId)?.stats?.tasks ?? [])].sort((x, y) => x.diff.estimate - y.diff.estimate)[0]?.task : undefined;
  const failedB = trials.filter((t) => t.passed === false && t.config_hash === latest?.config_hashes[1]);
  const latestFailed = failedB.find((t) => t.task_sha256 === worst) ?? failedB[0] ?? trials.find((t) => t.passed === false) ?? null;
  const liveIds = experiments.filter((e) => e.status === 'running' || e.status === 'paused').map((e) => e.id);
  const live = new Map(
    (await Promise.all(liveIds.map(async (id) => [id, await optional(api.experiment(id), null)] as const))).filter((x): x is readonly [string, ExperimentDetail] => x[1] !== null),
  );
  return { experiments, configs, harnesses, examples, heldoutToGo: queue ? queue.length : null, tuningToGo: tuning.length, heldoutChecksToGo: checksToGo(queue ?? []), compares, latest, latestFailed, live };
});

/** Which shipped example an experiment is: its `example` field once loaded, or, on the machine it
 *  was exported from (where the load is refused and the run is its own), its id in GET /examples. */
function shippedOf(e: Pick<ExperimentSummary, 'id' | 'example'>, examples: ExampleView[]): string | null {
  return e.example?.name ?? examples.find((x) => x.experiment_id === e.id)?.name ?? null;
}

const show = ref<'all' | 'running' | 'done'>('all');

const latestResult = computed(() => {
  const d = data.value;
  const latest = d?.latest;
  const stats = latest ? d.compares.get(latest.id)?.stats : null;
  if (!d || !latest || !stats) return null;
  const arms = armsOf(latest, d.configs);
  const split = new Set(latest.tasks.map((t) => t.split)).size === 1 ? splitName(latest.tasks[0]?.split ?? '') : null;
  const values = [stats.diff.low, stats.diff.high, ...(stats.aa ? [stats.aa.diff.low, stats.aa.diff.high] : [])];
  const [min, max] = domainFor(values, -20, 30);
  const level = Math.round(stats.level * 100);
  // The A/A calibration is drawn as its own row under the result, so the caption does not repeat it.
  const noise = stats.aa ? '' : ' No A/A calibration run for these configs yet, so the setup’s own noise is not measured.';
  const main: StripRow = {
    estimate: stats.diff.estimate,
    low: stats.diff.low,
    high: stats.diff.high,
    tone: verdictTone(stats.verdict),
    label: arms.length === 2 ? `${arms[1].short} minus ${arms[0].short}, ${plural(stats.tasks.length, 'task')}` : undefined,
  };
  const aa: StripRow[] = stats.aa ? [{ estimate: stats.aa.diff.estimate, low: stats.aa.diff.low, high: stats.aa.diff.high, tone: 'neutral', size: 'sm', label: 'A/A calibration, same config twice' }] : [];
  return {
    experiment: latest,
    stats,
    // Read away from its comparison, the sentence names the harness and model, and the example.
    title: headline(stats, arms, latest.tasks, { axis: latest.axis, example: shippedOf(latest, d.examples) }),
    big: `${signed(stats.diff.estimate)}${NBSP}${Math.abs(Math.round(stats.diff.estimate)) === 1 ? 'point' : 'points'}`,
    // Each arm's rate by name: "X to Y" is kept for intervals.
    rates: arms.length === 2 ? `pass rate: ${arms[0].short} ${percent(stats.a.rate)}, ${arms[1].short} ${percent(stats.b.rate)}` : `pass rate: A ${percent(stats.a.rate)}, B ${percent(stats.b.rate)}`,
    min,
    max,
    ticks: ticksFor(min, max, 10),
    rows: [main, ...aa],
    caption: `${level}% interval ${intervalText(stats.diff)}, paired over ${latest.tasks.length}${split ? ` ${split}` : ''} ${latest.tasks.length === 1 ? 'task' : 'tasks'} with ${plural(latest.n, 'trial')} each.${noise}`,
    caveat: judgeCaveat({
      differing: stats.tasks.filter((t) => t.beyond_noise).map((t) => latest.tasks.find((x) => x.sha256 === t.task || x.id === t.task)),
      isJudged,
      judge: stats.judge,
      toGo: d.heldoutToGo ?? 0,
      alsoGraded: alsoGradedBy,
    }),
    aria: `Difference in pass rate: ${signed(stats.diff.estimate)} points, ${level}% interval ${intervalText(stats.diff)}, on a scale from ${min} to ${max}.${stats.aa ? ` An A/A calibration of the same config gave ${signed(stats.aa.diff.estimate)}, interval ${intervalText(stats.aa.diff)}.` : ''}`,
  };
});

/** The latest finished A/B as counts, when it has no statistics: each arm's passes of its graded
 *  trials, and the trials with no outcome, as its comparison page gives them. */
const latestCounts = computed(() => {
  const d = data.value;
  const latest = d?.latest;
  const compare = latest ? d.compares.get(latest.id) : null;
  if (!d || !latest || !compare || compare.stats || compare.status !== 'complete') return null;
  const sum = (letter: string) =>
    compare.rows.filter((r) => r.arm === letter).reduce((acc, r) => ({ passed: acc.passed + r.passed, graded: acc.graded + r.graded, incomplete: acc.incomplete + r.incomplete }), { passed: 0, graded: 0, incomplete: 0 });
  const a = sum('A');
  const b = sum('B');
  const open = a.incomplete + b.incomplete;
  const arms = armsOf(latest, d.configs);
  return {
    experiment: latest,
    name: experimentName(latest),
    arms: arms.slice(0, 2).map((arm, i) => ({ key: arm.key, label: arm.label, counts: `${(i ? b : a).passed} of ${(i ? b : a).graded} graded trials passed` })),
    undecided: open ? `${plural(open, 'trial')} ${open === 1 ? 'has' : 'have'} no outcome: a required check could not decide, so ${open === 1 ? 'it counts' : 'they count'} as neither a pass nor a fail.` : '',
    why: compare.stats_note ?? 'there is no verdict yet.',
  };
});

interface Attention {
  key: string;
  to: string;
  icon: 'plug' | 'tag' | 'alert';
  title: string;
  /** A count in brackets after the title, kept on one line: "(7 checks)". */
  titleNote?: string;
  detail: string;
  infra: boolean;
}

const attention = computed<Attention[]>(() => {
  const d = data.value;
  if (!d) return [];
  const out: Attention[] = [];
  for (const e of d.experiments) {
    const detail = d.live.get(e.id);
    if (e.status === 'paused') {
      const reason = detail?.paused_reason ?? 'no new trials start until it is resumed';
      out.push({
        key: `paused-${e.id}`,
        to: href.run(e.id),
        icon: 'alert',
        infra: false,
        title: `${experimentName(e)} is paused`,
        detail: `${capitalise(plainText(pauseCause(reason)))}. Review it, then resume or stop.`,
      });
    }
    for (const a of detail?.arms ?? []) {
      if (a.status !== 'paused') continue;
      out.push({
        key: `arm-${e.id}-${a.arm}`,
        to: href.run(e.id),
        icon: 'alert',
        infra: false,
        title: `Arm ${a.arm} of ${experimentName(e)} is paused`,
        detail: `${capitalise(plainText(pauseCause(a.paused_reason ?? 'paused')))}. ${a.fix ? 'The run page says how to fix it.' : 'Resume it on the run page.'}`,
      });
    }
    // A config error pauses its arm (listed above) and is never re-queued, so it is not counted here.
    const retried = e.counts.infra_failed - (e.counts.by_label['infra:config_error'] ?? 0) - (e.counts.by_label['infra:budget_net'] ?? 0);
    if (e.status === 'running' && retried > 0) {
      out.push({
        key: `infra-${e.id}`,
        to: href.run(e.id),
        icon: 'plug',
        infra: true,
        title: plural(retried, 'infra failure'),
        detail: `${experimentName(e)}. Each is re-queued once. Not counted as agent failures.`,
      });
    }
  }
  if (d.tuningToGo) {
    out.push({
      key: 'labels-tuning',
      to: '#/labels?set=tuning',
      icon: 'tag',
      infra: false,
      title: `${plural(d.tuningToGo, 'output')} waiting for a human label`,
      titleNote: '(tuning set)',
      detail: 'Open coding before any rubric: a person’s pass or fail, and a line on why.',
    });
  }
  if (d.heldoutToGo) {
    out.push({
      key: 'labels',
      to: href.labels(),
      icon: 'tag',
      infra: false,
      title: `${plural(d.heldoutToGo, 'held-out output')} waiting for a human label`,
      titleNote: `(${plural(d.heldoutChecksToGo, 'check')})`,
      detail: "The judge's agreement with the human labels is final once all of them are labelled.",
    });
  }
  for (const h of d.harnesses) {
    for (const [name, setting] of Object.entries(h.capabilities.settings)) {
      for (const [model, effect] of Object.entries(setting.effect ?? {})) {
        if (effect.status !== 'inert') continue;
        out.push({
          key: `inert-${h.name}-${name}-${model}`,
          to: href.harnesses(),
          icon: 'alert',
          infra: false,
          title: `${settingLabel(name)} looks inert on ${harnessShort(h.name)}`,
          detail: `The effect check saw no change on ${modelName(model)}. Review before using it as an axis.`,
        });
      }
    }
  }
  return out;
});

interface Row {
  e: ExperimentSummary;
  to: string;
  axis: string;
  a: string;
  b: string;
  /** Arms past B, in experiments made before D35. */
  more: { key: string; label: string }[];
  setup: string;
  trials: string;
  share: number;
  live: boolean;
  updated: string;
  status: string;
  verdict: Verdict | null;
  /** The verdict's words when the tag's default would not say it (equivalent, held back, A/A). */
  verdictLabel?: string;
  detail: string;
  estimate: string;
  /** Under the spend of a run on a fake model: its prices are made up for testing, not money. */
  fakePrices: string;
}

/** "Made-up prices: fake model", or which arm's are, as the comparison says it; '' on real models. */
function fakePricesWords(arms: { key: string; config?: { model: string } }[]): string {
  const fake = arms.filter((a) => isFake(a.config?.model));
  if (!fake.length) return '';
  if (fake.length === arms.length) return 'Made-up prices: fake model';
  return `Made-up prices in arm ${fake.map((a) => a.key.toUpperCase()).join(' and ')}: fake model`;
}

const rows = computed<Row[]>(() => {
  const d = data.value;
  if (!d) return [];
  return d.experiments
    .filter((e) => show.value === 'all' || (show.value === 'running' ? e.status === 'running' || e.status === 'created' || e.status === 'paused' : e.status === 'done'))
    .map((e) => {
      const arms = armsOf(e, d.configs);
      const total = totalTrials(e);
      const done = doneCount(e.counts);
      const compare = d.compares.get(e.id) ?? null;
      const stats = compare?.stats ?? null;
      let status = e.calibration ? 'A/A calibration' : 'Finished';
      let verdict: Verdict | null = null;
      let verdictLabel: string | undefined;
      let detail = compare?.stats_note ? `No verdict yet. ${compare.stats_note}` : 'Pass counts only: no verdict yet';
      if (e.status === 'running') {
        status = 'Running';
        const left = timeLeft(e.estimate, done, total);
        detail = left !== null ? `About ${minutes(left)} left` : `${done} of ${total} done`;
      } else if (e.status === 'paused') {
        status = 'Paused';
        detail = `${done} of ${total} done. ${capitalise(plainText(pauseCause(d.live.get(e.id)?.paused_reason ?? 'paused')))}`;
      } else if (e.status === 'created') {
        status = 'Not started';
        detail = 'Waiting for you to start it';
      } else if (e.status === 'cancelled') {
        status = 'Cancelled';
        detail = `${done} of ${total} ran`;
      } else if (e.config_hashes.length === 1) {
        status = 'One arm';
        detail = 'Nothing to compare';
      } else if (e.config_hashes.length > 2) {
        status = 'Finished';
        detail = `${e.config_hashes.length} configs, made before experiments had two arms`;
      } else if (stats?.calibration) {
        // D44: an A/A calibration should find nothing; say whether it did.
        verdict = 'none';
        verdictLabel = stats.calibration.as_expected ? 'No difference, as it should' : 'Found a difference: check the setup';
        detail = `A/A calibration: ${pointsWithInterval(stats.diff)}`;
      } else if (stats) {
        verdict = stats.verdict === 'better' ? 'better' : stats.verdict === 'worse' ? 'worse' : 'none';
        verdictLabel = verdict === 'none' ? verdictWords(stats.verdict) : undefined;
        detail = pointsWithInterval(stats.diff);
      }
      return {
        e,
        to: e.status === 'running' || e.status === 'created' || e.status === 'paused' ? href.run(e.id) : href.compare(e.id),
        axis: axisWords(e),
        a: arms[0]?.label ?? '–',
        b: arms[1]?.label ?? '–',
        more: arms.slice(2).map((x) => ({ key: x.key, label: x.label })),
        setup: setupOf(e, arms),
        trials: `${done} of ${total}`,
        share: total ? (done / total) * 100 : 0,
        live: e.status === 'running',
        updated: updatedAt(e, d.live.get(e.id) ?? (d.latest?.id === e.id ? d.latest : null)),
        status,
        verdict,
        verdictLabel,
        detail,
        estimate: e.estimate ? `of ${money(e.estimate.cost_usd.expected)} estimated` : '',
        fakePrices: fakePricesWords(arms),
      };
    });
});
</script>

<template>
  <div class="head-row">
    <div class="page-head">
      <h1 tabindex="-1">
        Experiments
      </h1>
      <p class="lede">
        Each experiment changes one thing and runs both versions on the same tasks. Its comparison says whether the change made the agent better, worse or practically the same, or whether the difference is too small to tell from noise, with a 95% interval, task by task, and with cost and time beside it.
      </p>
    </div>
    <div class="head-actions">
      <a
        :href="href.build()"
        class="btn btn--quiet"
        data-test="build-agent"
      >
        Build an agent, step by step
      </a>
      <a
        :href="href.config()"
        class="btn"
      >
        <AppIcon
          name="plus"
          :size="16"
        />
        New experiment
      </a>
    </div>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    :retry="reload"
    what="the experiments"
  >
    <div class="lead-row">
      <section
        v-if="latestResult"
        aria-labelledby="latest"
        class="panel latest"
        data-test="latest-result"
      >
        <div class="latest-top">
          <p class="secondary small">
            Latest result, finished {{ relative(updatedAt(latestResult.experiment, latestResult.experiment)).toLowerCase() }}
          </p>
          <a
            :href="href.compare(latestResult.experiment.id)"
            class="small strong-link"
          >Open the comparison</a>
        </div>
        <h2
          id="latest"
          class="latest-title"
        >
          {{ latestResult.title }}
        </h2>
        <div class="latest-figure">
          <span class="big num">{{ latestResult.big }}</span>
          <span class="secondary">{{ latestResult.rates }}</span>
        </div>
        <figure class="fig">
          <IntervalStrip
            :min="latestResult.min"
            :max="latestResult.max"
            :ticks="latestResult.ticks"
            :reference="{ value: 0, dashed: true }"
            :rows="latestResult.rows"
            :summary="latestResult.aria"
          />
          <figcaption class="secondary small caption">
            {{ latestResult.caption }}
          </figcaption>
        </figure>
        <p
          v-if="latestResult.caveat"
          class="caveat"
          data-test="judge-caveat"
        >
          <AppIcon
            name="alert"
            :size="14"
          />
          <span><strong class="caveat-lead">{{ latestResult.caveat.lead }}:</strong> <template
            v-for="(part, pi) in identParts(latestResult.caveat.before, latestResult.caveat.idents)"
            :key="pi"
          ><span
            v-if="part.ident"
            class="mono"
          >{{ part.text }}</span><template v-else>{{ part.text }}</template></template><a :href="href.judge()">{{ latestResult.caveat.link }}</a>{{ latestResult.caveat.after }}</span>
        </p>
      </section>
      <section
        v-else-if="latestCounts"
        aria-labelledby="latest"
        class="panel latest"
        data-test="latest-counts"
      >
        <div class="latest-top">
          <p class="secondary small">
            Latest finished, {{ relative(updatedAt(latestCounts.experiment, latestCounts.experiment)).toLowerCase() }}
          </p>
          <a
            :href="href.compare(latestCounts.experiment.id)"
            class="small strong-link"
          >Open the comparison</a>
        </div>
        <h2
          id="latest"
          class="latest-title"
        >
          {{ latestCounts.name }}
        </h2>
        <ul class="latest-arms">
          <li
            v-for="arm in latestCounts.arms"
            :key="arm.key"
            class="arm"
          >
            <span :class="`dot dot--${arm.key}`" /><span><strong>{{ arm.key.toUpperCase() }}</strong>: {{ arm.label }}, <span class="num">{{ arm.counts }}</span></span>
          </li>
        </ul>
        <p class="secondary small">
          <template v-if="latestCounts.undecided">
            {{ latestCounts.undecided }}{{ ' ' }}
          </template>These are counts, not a conclusion: {{ latestCounts.why }}
        </p>
      </section>
      <section
        v-else
        class="panel latest"
        aria-labelledby="latest"
      >
        <h2
          id="latest"
          class="section-title"
        >
          No finished comparison yet
        </h2>
        <p class="secondary">
          When an experiment with two arms finishes and its trials are graded, its verdict and interval show here.
        </p>
      </section>

      <section
        aria-labelledby="attention"
        class="attention"
      >
        <h2
          id="attention"
          class="attention-title"
        >
          Needs attention
        </h2>
        <a
          v-for="item in attention"
          :key="item.key"
          :href="item.to"
          class="attention-item"
          :class="{ 'attention-item--infra': item.infra }"
          data-test="attention"
        >
          <AppIcon
            :name="item.icon"
            class="secondary"
          />
          <span>
            <span class="attention-head">{{ item.title }}<template v-if="item.titleNote">
              {{ ' ' }}<span class="nowrap">{{ item.titleNote }}</span>
            </template></span>
            <span class="secondary small block">{{ item.detail }}</span>
          </span>
        </a>
        <p
          v-if="!attention.length"
          class="secondary small"
        >
          Nothing needs attention right now.
        </p>
      </section>
    </div>

    <section
      aria-labelledby="flow"
      class="stack"
    >
      <h2
        id="flow"
        class="attention-title"
      >
        From a change to an answer
      </h2>
      <ol class="flow">
        <li>
          <a :href="href.config()">
            <span class="secondary small num block">1</span>
            <span class="flow-head">Define a config</span>
            <span class="secondary small block">Harness, model, prompt, tools and settings. Saved under a content hash.</span>
          </a>
        </li>
        <li>
          <a :href="href.runNew()">
            <span class="secondary small num block">2</span>
            <span class="flow-head">Check and run</span>
            <span class="secondary small block">See the trials, models, cost and time before anything starts.</span>
          </a>
        </li>
        <li>
          <a :href="data?.latest ? href.compare(data.latest.id) : href.experiments()">
            <span class="secondary small num block">3</span>
            <span class="flow-head">Compare</span>
            <span class="secondary small block">The verdict with its interval, then pass counts, cost and time per version, task by task.</span>
          </a>
        </li>
        <li>
          <a :href="data?.latestFailed ? href.trial(data.latestFailed.id) : href.recorded()">
            <span class="secondary small num block">4</span>
            <span class="flow-head">Inspect a trial</span>
            <span class="secondary small block">Every message, tool call, grader verdict and model request.</span>
          </a>
        </li>
      </ol>
    </section>

    <section
      aria-labelledby="all"
      class="stack"
    >
      <div class="head-row head-row--center">
        <h2
          id="all"
          class="attention-title"
        >
          All experiments
        </h2>
        <label class="inline-field">Show
          <select
            v-model="show"
            data-test="show-filter"
          >
            <option value="all">All</option>
            <option value="running">Running</option>
            <option value="done">Finished</option>
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table
          class="table experiments"
          data-test="experiments-table"
        >
          <thead>
            <tr>
              <th scope="col">
                Experiment
              </th>
              <th scope="col">
                Arms
              </th>
              <th scope="col">
                Trials
              </th>
              <th scope="col">
                Result
              </th>
              <th
                scope="col"
                class="right"
              >
                Spend
              </th>
              <th
                scope="col"
                class="right"
              >
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.e.id"
              data-test="experiment-row"
            >
              <td class="c-name">
                <a
                  :href="r.to"
                  class="row-link"
                >{{ experimentName(r.e) }}</a>
                <span class="secondary block changes"><span
                  v-if="r.e.example"
                  class="tag"
                  data-test="example-tag"
                >Shipped example</span><template v-if="r.e.example">{{ ' ' }}</template>Changes {{ r.axis }}</span>
              </td>
              <td class="c-arms">
                <span class="arm"><span class="dot dot--a" />{{ r.a }}</span>
                <span
                  v-if="r.e.config_hashes.length > 1"
                  class="arm block-flex"
                ><span class="dot dot--b" />{{ r.b }}</span>
                <span
                  v-for="m in r.more"
                  :key="m.key"
                  class="arm block-flex"
                ><span :class="`dot dot--${m.key}`" />{{ m.label }}</span>
                <span class="secondary block setup">{{ r.setup }}</span>
              </td>
              <td class="num c-trials">
                <span class="block">{{ r.trials }}<span class="phone-only"> trials</span></span>
                <span
                  class="meter trials-meter"
                  :class="{ 'meter--live': r.live }"
                  aria-hidden="true"
                ><span :style="{ width: `${r.share}%` }" /></span>
              </td>
              <td
                class="c-result"
                data-test="result"
              >
                <VerdictTag
                  v-if="r.verdict"
                  :verdict="r.verdict"
                  :label="r.verdictLabel"
                />
                <span
                  v-else
                  class="result-plain"
                  data-test="status"
                >{{ r.status }}</span>
                <span class="result-detail detail">{{ r.detail }}</span>
              </td>
              <td class="right num c-spend">
                {{ money(r.e.spend_usd) }}<span class="secondary block estimate">{{ r.estimate }}</span><span
                  v-if="r.fakePrices"
                  class="secondary block estimate"
                  data-test="fake-prices"
                  title="A fake model's replies are scripted and its prices invented for testing: these amounts show how the platform counts, not what a real model would cost."
                >{{ r.fakePrices }}</span>
              </td>
              <td class="right secondary c-updated">
                {{ relative(r.updated) }}
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td
                colspan="6"
                class="secondary"
              >
                No experiments here yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="secondary small">
        Gate and smoke runs recorded outside an experiment are under <a :href="href.recorded()">recorded runs</a>.
      </p>
    </section>
  </LoadState>
</template>

<style scoped>
.head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.lead-row {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: start;
}

.latest {
  flex: 999 1 640px;
  min-width: 0;
  padding: 28px 32px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.latest-top {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: baseline;
  justify-content: space-between;
}

.strong-link {
  font-weight: 500;
}

.nowrap {
  white-space: nowrap;
}

.latest-title {
  font-size: 26px;
  letter-spacing: -0.01em;
}

.latest-arms {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.latest-figure {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 14px;
  font-size: 16px;
}

.big {
  font-size: 44px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.fig {
  margin: 0;
}

.caption {
  margin-top: 10px;
  max-width: 70ch;
}

/* What the result rests on, right under the caption (the shared .caveat in theme.css). */
.caveat {
  margin-top: -6px;
}

.attention {
  flex: 1 1 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.attention-title {
  font-size: 17px;
}

.attention-item {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--rule);
  background: var(--surface);
  text-decoration: none;
  color: var(--ink);
}

.attention-item:hover {
  color: var(--ink);
  border-color: var(--rule-strong);
}

.attention-item--infra {
  border-style: dashed;
  border-color: var(--rule-dashed);
}

.attention-item .icon {
  margin-top: 2px;
}

.attention-head {
  display: block;
  font-weight: 500;
}

.block {
  display: block;
}

.block-flex {
  display: flex;
}

.flow {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  border-top: 2px solid var(--ink);
}

.flow li {
  padding: 14px 20px 0 0;
}

.flow a {
  display: block;
  text-decoration: none;
  color: var(--ink);
  min-height: 44px;
}

.flow a:hover .flow-head {
  text-decoration: underline;
}

.flow-head {
  display: block;
  font-weight: 600;
}

.head-row--center {
  align-items: center;
}

.experiments {
  min-width: 900px;
}

.experiments td {
  padding-top: 14px;
  padding-bottom: 14px;
}

.trials-meter {
  width: 120px;
  margin-top: 6px;
}

.detail {
  margin-top: 4px;
}

.phone-only {
  display: none;
}

@media (max-width: 640px) {
  .latest {
    padding: 22px 20px;
  }

  /* Each experiment stacks into four lines: the name, the verdict with its interval, the arms,
     then trials, spend and when, so the answer is never off to the side. The header stays for
     screen readers. */
  .table.experiments {
    min-width: 0;
  }

  .table.experiments thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .table.experiments tbody tr {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    align-items: baseline;
    gap: 6px 0;
    padding: 14px 16px;
    border-bottom: 1px solid var(--rule-soft);
  }

  .table.experiments tbody tr:last-child {
    border-bottom: 0;
  }

  .table.experiments tbody tr > td {
    padding: 0;
    border: 0;
    text-align: left;
  }

  .table.experiments tbody tr > td[colspan] {
    grid-column: 1 / -1;
  }

  .c-name {
    order: 1;
    grid-column: 1 / -1;
  }

  .c-result {
    order: 2;
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
  }

  .c-result .detail {
    margin-top: 0;
  }

  .c-arms {
    order: 3;
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .c-trials {
    order: 4;
    color: var(--ink-2);
    font-size: 13px;
  }

  .c-spend {
    order: 5;
    color: var(--ink-2);
    font-size: 13px;
  }

  .c-updated {
    order: 6;
    font-size: 13px;
  }

  .c-spend::before,
  .c-updated::before {
    content: '·';
    padding: 0 6px;
    color: var(--ink-2);
  }

  .changes,
  .setup,
  .estimate,
  .trials-meter {
    display: none;
  }

  .phone-only {
    display: inline;
  }

  .big {
    font-size: 36px;
  }

  .latest-title {
    font-size: 22px;
  }
}
</style>
