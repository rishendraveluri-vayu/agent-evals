<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api/client';
import type { Compare, Config, Experiment, ExperimentDetail, ExperimentTrial, Harness } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import IntervalStrip from '../components/IntervalStrip.vue';
import LoadState from '../components/LoadState.vue';
import VerdictTag from '../components/VerdictTag.vue';
import { armsOf, axisWords, doneCount, excludesZero, headline, intervalText, judgeCaveat, pointsWithInterval, setupOf, timeLeft, totalTrials, type Verdict } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { minutes, money, percent, relative, signed } from '../lib/format';
import { harnessShort, isJudged, modelName, settingLabel, splitName } from '../lib/names';
import { domainFor, ticksFor, verdictTone, type StripRow } from '../lib/scale';
import { href } from '../router';

interface Loaded {
  experiments: Experiment[];
  configs: Config[];
  harnesses: Harness[];
  heldoutToGo: number | null;
  compares: Map<string, Compare | null>;
  latest: ExperimentDetail | null;
  latestFailed: ExperimentTrial | null;
}

const updatedAt = (e: Experiment) => e.finished_at ?? e.started_at ?? e.created_at;
const twoArms = (e: Experiment) => e.config_hashes.length === 2;

const { data, error, loading } = useLoad<Loaded>(async () => {
  const [experiments, configs, harnesses, queue] = await Promise.all([
    api.experiments(),
    api.configs(),
    optional(api.harnesses(), [] as Harness[]),
    optional(api.labelQueue('heldout'), null),
  ]);
  const finished = experiments.filter((e) => e.status === 'done' && twoArms(e));
  const compares = new Map(await Promise.all(finished.map(async (e) => [e.id, await optional(api.compare(e.id), null)] as const)));
  const latestId = [...finished]
    .filter((e) => e.config_hashes[0] !== e.config_hashes[1] && compares.get(e.id)?.stats)
    .sort((x, y) => Date.parse(updatedAt(y)) - Date.parse(updatedAt(x)))[0]?.id;
  const latest = latestId ? await optional(api.experiment(latestId), null) : null;
  const trials = latestId ? await optional(api.experimentTrials(latestId, { status: 'done' }), [] as ExperimentTrial[]) : [];
  // Step 4 opens a failure of arm B on the task where B did worst: the most telling one to read.
  const worst = latestId ? [...(compares.get(latestId)?.stats?.tasks ?? [])].sort((x, y) => x.diff.estimate - y.diff.estimate)[0]?.task : undefined;
  const failedB = trials.filter((t) => t.passed === false && t.config === latest?.config_hashes[1]);
  const latestFailed = failedB.find((t) => t.task === worst) ?? failedB[0] ?? trials.find((t) => t.passed === false) ?? null;
  return { experiments, configs, harnesses, heldoutToGo: queue ? queue.length : null, compares, latest, latestFailed };
});

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
  // The A/A run is drawn as its own row under the result, so the caption does not repeat it.
  const noise = stats.aa ? '' : ' No A/A run on this setup yet, so the noise floor is not measured.';
  const main: StripRow = {
    estimate: stats.diff.estimate,
    low: stats.diff.low,
    high: stats.diff.high,
    tone: verdictTone(stats.verdict),
    label: arms.length === 2 ? `${arms[1].short} minus ${arms[0].short}, ${stats.tasks.length} tasks` : undefined,
  };
  const aa: StripRow[] = stats.aa ? [{ estimate: stats.aa.diff.estimate, low: stats.aa.diff.low, high: stats.aa.diff.high, tone: 'neutral', size: 'sm', label: 'A/A run, same config twice' }] : [];
  return {
    experiment: latest,
    stats,
    title: headline(stats, arms, latest.tasks),
    big: `${signed(stats.diff.estimate)} points`,
    rates: `pass rate, ${percent(stats.a.rate)} to ${percent(stats.b.rate)}`,
    min,
    max,
    ticks: ticksFor(min, max, 10),
    rows: [main, ...aa],
    caption: `${level}% interval ${intervalText(stats.diff)}, paired over ${latest.tasks.length}${split ? ` ${split}` : ''} tasks with ${latest.n} trials each.${noise}`,
    caveat: judgeCaveat({
      differing: stats.tasks.filter((t) => t.significant).map((t) => latest.tasks.find((x) => x.sha256 === t.task || x.id === t.task)),
      isJudged,
      judge: stats.judge,
      toGo: d.heldoutToGo ?? 0,
    }),
    aria: `Difference in pass rate: ${signed(stats.diff.estimate)} points, ${level}% interval ${intervalText(stats.diff)}, on a scale from ${min} to ${max}.${stats.aa ? ` An A/A run on the same setup gave ${signed(stats.aa.diff.estimate)}, interval ${intervalText(stats.aa.diff)}.` : ''}`,
  };
});

interface Attention {
  key: string;
  to: string;
  icon: 'plug' | 'tag' | 'alert';
  title: string;
  detail: string;
  infra: boolean;
}

const attention = computed<Attention[]>(() => {
  const d = data.value;
  if (!d) return [];
  const out: Attention[] = [];
  for (const e of d.experiments) {
    if (e.status === 'running' && e.counts.infra_failed > 0) {
      out.push({
        key: `infra-${e.id}`,
        to: href.run(e.id),
        icon: 'plug',
        infra: true,
        title: `${e.counts.infra_failed} ${e.counts.infra_failed === 1 ? 'trial' : 'trials'} stopped on infra failures`,
        detail: `${e.name}. Each is re-queued once. Not counted as agent failures.`,
      });
    }
  }
  if (d.heldoutToGo) {
    out.push({
      key: 'labels',
      to: href.labels(),
      icon: 'tag',
      infra: false,
      title: `${d.heldoutToGo} held-out ${d.heldoutToGo === 1 ? 'label' : 'labels'} to go`,
      detail: "The judge's agreement with you is final once all of them are labelled.",
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
  e: Experiment;
  to: string;
  axis: string;
  a: string;
  b: string;
  setup: string;
  trials: string;
  share: number;
  live: boolean;
  status: string;
  verdict: Verdict | null;
  detail: string;
  estimate: string;
}

const rows = computed<Row[]>(() => {
  const d = data.value;
  if (!d) return [];
  return d.experiments
    .filter((e) => show.value === 'all' || (show.value === 'running' ? e.status === 'running' || e.status === 'created' : e.status === 'done'))
    .map((e) => {
      const arms = armsOf(e, d.configs);
      const total = totalTrials(e);
      const done = doneCount(e.counts);
      const stats = d.compares.get(e.id)?.stats ?? null;
      const sameTwice = twoArms(e) && e.config_hashes[0] === e.config_hashes[1];
      let status = 'Finished';
      let verdict: Verdict | null = null;
      let detail = 'Verdict not computed yet';
      if (e.status === 'running') {
        status = 'Running';
        const left = timeLeft(e.estimate, done, total);
        detail = left !== null ? `About ${minutes(left)} left` : `${done} of ${total} done`;
      } else if (e.status === 'created') {
        status = 'Not started';
        detail = 'Waiting for you to start it';
      } else if (e.status === 'cancelled') {
        status = 'Cancelled';
        detail = `${done} of ${total} ran`;
      } else if (!twoArms(e)) {
        status = 'One arm';
        detail = 'Nothing to compare';
      } else if (stats) {
        verdict = stats.verdict === 'better' ? 'better' : stats.verdict === 'worse' ? 'worse' : 'none';
        detail = `${pointsWithInterval(stats.diff)}${sameTwice && !excludesZero(stats.diff) ? ', as expected' : ''}`;
      }
      return {
        e,
        to: e.status === 'running' || e.status === 'created' ? href.run(e.id) : href.compare(e.id),
        axis: axisWords(e),
        a: arms[0]?.label ?? '–',
        b: arms[1]?.label ?? '–',
        setup: setupOf(e, arms),
        trials: `${done} of ${total}`,
        share: total ? (done / total) * 100 : 0,
        live: e.status === 'running',
        status,
        verdict,
        detail,
        estimate: e.estimate ? `of ${money(e.estimate.cost_usd.expected)} estimated` : '',
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
        Each experiment changes one thing and measures whether the agent got better, worse or stayed the same, and how sure we can be.
      </p>
    </div>
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

  <LoadState
    :loading="loading"
    :error="error"
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
            Latest result, finished {{ relative(latestResult.experiment.finished_at ?? latestResult.experiment.created_at).toLowerCase() }}
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
          <span>{{ latestResult.caveat.before }}<a :href="href.judge()">{{ latestResult.caveat.link }}</a>{{ latestResult.caveat.after }}</span>
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
          When an experiment with two arms finishes and its statistics are in, its verdict shows here first.
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
          Needs you
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
            <span class="attention-head">{{ item.title }}</span>
            <span class="secondary small block">{{ item.detail }}</span>
          </span>
        </a>
        <p
          v-if="!attention.length"
          class="secondary small"
        >
          Nothing needs you right now.
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
            <span class="secondary small block">See trials, cost, time and whether N is enough before anything starts.</span>
          </a>
        </li>
        <li>
          <a :href="data?.latest ? href.compare(data.latest.id) : href.experiments()">
            <span class="secondary small num block">3</span>
            <span class="flow-head">Compare</span>
            <span class="secondary small block">One verdict with its interval, then the per-task differences behind it.</span>
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
                >{{ r.e.name }}</a>
                <span class="secondary block changes">Changes {{ r.axis }}</span>
              </td>
              <td class="c-arms">
                <span class="arm"><span class="dot dot--a" />{{ r.a }}</span>
                <span
                  v-if="r.e.config_hashes.length > 1"
                  class="arm block-flex"
                ><span class="dot dot--b" />{{ r.b }}</span>
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
                />
                <span
                  v-else
                  class="result-plain"
                  data-test="status"
                >{{ r.status }}</span>
                <span class="result-detail detail">{{ r.detail }}</span>
              </td>
              <td class="right num c-spend">
                {{ money(r.e.spend_usd) }}<span class="secondary block estimate">{{ r.estimate }}</span>
              </td>
              <td class="right secondary c-updated">
                {{ relative(updatedAt(r.e)) }}
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

.latest-title {
  font-size: 26px;
  letter-spacing: -0.01em;
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

/* What the result rests on, right under the caption: an icon and words, never colour alone. */
.caveat {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  max-width: 72ch;
  margin-top: -6px;
  font-size: 14px;
  color: var(--ink-2);
}

.caveat .icon {
  margin-top: 4px;
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
