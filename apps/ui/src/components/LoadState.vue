<script setup lang="ts">
/** Loading and error states for a screen: a status while waiting, an alert on failure. */
defineProps<{ loading: boolean; error: string | null; what: string }>();
</script>

<template>
  <p
    v-if="error"
    class="state state--error"
    role="alert"
    data-test="load-error"
  >
    Could not load {{ what }}: {{ error }}
  </p>
  <p
    v-else-if="loading"
    class="state"
    role="status"
    data-test="load-loading"
  >
    Loading {{ what }}
  </p>
  <slot v-else />
</template>

<style scoped>
.state {
  padding: 18px 20px;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 12px;
  color: var(--ink-2);
}

.state--error {
  color: var(--error);
  border-color: var(--error);
}
</style>
