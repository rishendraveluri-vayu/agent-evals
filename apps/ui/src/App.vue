<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fetchHealth, type DbState, type HealthResult } from './health';

const result = ref<HealthResult | null>(null);

const dbLabels: Record<DbState, string> = {
  up: 'up',
  down: 'down',
  not_configured: 'not configured',
};

onMounted(async () => {
  result.value = await fetchHealth();
});
</script>

<template>
  <main class="page">
    <h1>Agent Evals Platform</h1>

    <section
      class="health"
      aria-labelledby="health-heading"
    >
      <h2 id="health-heading">
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
        <dt>Status</dt>
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
  </main>
</template>

<style scoped>
.page {
  max-width: 40rem;
  margin: 3rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}

.health {
  border: 1px solid #d0d4da;
  border-radius: 6px;
  padding: 1rem 1.25rem;
}

h2 {
  margin-top: 0;
  font-size: 1.1rem;
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
}

.facts dt {
  font-weight: 600;
}

.facts dd {
  margin: 0;
}

.state--error {
  color: #b42318;
}
</style>
