<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchHealth, type DbState, type HealthResult } from './health';
import TrialView from './views/TrialView.vue';
import TrialsView from './views/TrialsView.vue';

const result = ref<HealthResult | null>(null);
const hash = ref(typeof window === 'undefined' ? '' : window.location.hash);

const dbLabels: Record<DbState, string> = {
  up: 'up',
  down: 'down',
  not_configured: 'not configured',
};

/** #/trials/<id> shows one trial; anything else shows the list. */
const trialId = computed(() => {
  const m = /^#\/trials\/(.+)$/.exec(hash.value);
  return m ? decodeURIComponent(m[1]) : null;
});

const onHash = () => {
  hash.value = window.location.hash;
};

onMounted(async () => {
  window.addEventListener('hashchange', onHash);
  result.value = await fetchHealth();
});

onBeforeUnmount(() => window.removeEventListener('hashchange', onHash));
</script>

<template>
  <main class="page">
    <header class="top">
      <h1>Agent Evals Platform</h1>
      <section
        class="health"
        aria-labelledby="health-heading"
      >
        <h2
          id="health-heading"
          class="visually-hidden"
        >
          API health
        </h2>
        <p
          v-if="result === null"
          class="state"
          data-test="health-loading"
          role="status"
        >
          Checking the API…
        </p>
        <p
          v-else-if="result.kind === 'unreachable'"
          class="state state--error"
          data-test="health-unreachable"
          role="alert"
        >
          API unreachable ({{ result.reason }})
        </p>
        <dl
          v-else
          class="facts"
          data-test="health-ok"
        >
          <dt>API</dt>
          <dd data-test="health-status">
            {{ result.health.status }}
          </dd>
          <dt>Database</dt>
          <dd
            data-test="health-db"
            :class="{ 'state--error': result.health.db === 'down' }"
          >
            {{ dbLabels[result.health.db] }}
          </dd>
        </dl>
      </section>
    </header>

    <TrialView
      v-if="trialId"
      :key="trialId"
      :trial-id="trialId"
    />
    <TrialsView v-else />
  </main>
</template>

<style scoped>
.page {
  max-width: 72rem;
  margin: 1.5rem auto;
  padding: 0 1rem;
}

.top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

h1 {
  font-size: 1.4rem;
  margin: 0;
}

.health {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.health p {
  margin: 0;
}

.facts {
  display: flex;
  gap: 0.4rem;
  margin: 0;
}

.facts dt {
  font-weight: 600;
}

.facts dd {
  margin: 0 0.75rem 0 0;
}

.state--error {
  color: var(--critical);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
