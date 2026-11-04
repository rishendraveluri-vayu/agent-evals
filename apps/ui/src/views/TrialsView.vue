<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import SpendChart from '../components/SpendChart.vue';
import { fetchTrials, harnessSlot, spendByConfig, usd, type TrialSummary } from '../trials';

const trials = ref<TrialSummary[] | null>(null);
const error = ref<string | null>(null);
const configs = computed(() => spendByConfig(trials.value ?? []));
const newestFirst = computed(() => [...(trials.value ?? [])].reverse());

onMounted(async () => {
  try {
    trials.value = await fetchTrials();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    trials.value = [];
  }
});
</script>

<template>
  <div class="page-head">
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a href="#/">Experiments</a> / Recorded runs
    </nav>
    <h1 tabindex="-1">
      Recorded runs
    </h1>
    <p class="lede">
      Gate and smoke runs recorded outside any experiment, read from their trial folders. Spend comes from LiteLLM's own records.
    </p>
  </div>
  <section
    class="card"
    aria-labelledby="spend-heading"
  >
    <h2 id="spend-heading">
      Spend
    </h2>
    <p
      v-if="error"
      class="muted"
      role="alert"
    >
      Could not load trials: {{ error }}
    </p>
    <p
      v-else-if="trials === null"
      class="muted"
      role="status"
    >
      Loading trials…
    </p>
    <template v-else>
      <SpendChart :trials="trials" />
      <div
        v-if="configs.length"
        class="scroll-x"
      >
        <table
          class="data"
          data-test="config-table"
        >
          <thead>
            <tr>
              <th>Config</th>
              <th class="num">
                Trials
              </th>
              <th class="num">
                Total
              </th>
              <th class="num">
                Mean / trial
              </th>
              <th class="num">
                Model calls (proxy)
              </th>
              <th class="num">
                Model calls (harness)
              </th>
              <th class="num">
                Infra failures
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in configs"
              :key="c.key"
            >
              <td>
                <span
                  class="swatch"
                  :style="{ background: `var(--series-${harnessSlot(c.harness)})` }"
                />{{ c.label }}
              </td>
              <td class="num">
                {{ c.trials }}
              </td>
              <td class="num">
                {{ usd(c.totalUsd) }}
              </td>
              <td class="num">
                {{ usd(c.meanUsd) }}
              </td>
              <td class="num">
                {{ c.meanProxyCalls?.toFixed(1) ?? '–' }}
              </td>
              <td class="num">
                {{ c.meanHarnessCalls?.toFixed(1) ?? '–' }}
              </td>
              <td class="num">
                {{ c.infra }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>

  <section
    v-if="trials && trials.length"
    class="card"
    aria-labelledby="trials-heading"
  >
    <h2 id="trials-heading">
      Trials
    </h2>
    <div class="scroll-x">
      <table
        class="data"
        data-test="trials-table"
      >
        <thead>
          <tr>
            <th>Trial</th>
            <th>Harness</th>
            <th>Model</th>
            <th>Task</th>
            <th>End state</th>
            <th>Label</th>
            <th class="num">
              Turns
            </th>
            <th class="num">
              Calls (proxy / harness)
            </th>
            <th class="num">
              Tools (errors)
            </th>
            <th class="num">
              Cost
            </th>
            <th class="num">
              Wall
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in newestFirst"
            :key="t.trialId"
          >
            <td>
              <a :href="`#/trials/${encodeURIComponent(t.trialId)}`">{{ t.trialId }}</a>
            </td>
            <td>
              <span
                class="swatch"
                :style="{ background: `var(--series-${harnessSlot(t.harness)})` }"
              />{{ t.harness }}
            </td>
            <td>{{ t.model }}</td>
            <td>{{ t.taskId }}</td>
            <td><span class="tag">{{ t.endState ?? 'none' }}</span></td>
            <td>
              <span
                class="tag"
                :class="{ 'tag--infra': t.label.startsWith('infra:') }"
              >{{ t.label }}</span>
            </td>
            <td class="num">
              {{ t.agentTurns ?? '–' }}
            </td>
            <td class="num">
              {{ t.proxyCalls ?? '–' }} / {{ t.harnessCalls ?? '–' }}<span
                v-if="t.proxyComplete === false"
                title="LiteLLM's log never caught up: not trusted"
              > (log incomplete)</span>
            </td>
            <td class="num">
              {{ t.toolCalls ?? '–' }} ({{ t.toolErrors ?? 0 }})
            </td>
            <td class="num">
              {{ usd(t.proxyCostUsd) }}
            </td>
            <td class="num">
              {{ t.wallS?.toFixed(1) ?? '–' }} s
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
/* A wide table scrolls inside its card on a phone, never the page. */
.scroll-x {
  position: relative;
  overflow-x: auto;
}
</style>
