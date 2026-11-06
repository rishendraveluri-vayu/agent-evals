<script setup lang="ts">
/** Loading and error states for a screen: a status while waiting, an alert on failure, in plain
 *  words (the API's references to its own decision log are left out), with a way to try again:
 *  the screen's own reload when it gives one (`retry`), else a reload of the page. */
import { plainText } from '../lib/format';

const props = defineProps<{ loading: boolean; error: string | null; what: string; retry?: () => unknown }>();

function tryAgain() {
  if (props.retry) void props.retry();
  else window.location.reload();
}
</script>

<template>
  <div
    v-if="error"
    class="state state--error"
    data-test="load-error"
  >
    <p
      class="state-text"
      role="alert"
    >
      Could not load {{ what }}: {{ plainText(error) }}
    </p>
    <button
      type="button"
      class="btn btn--quiet retry"
      data-test="load-retry"
      @click="tryAgain"
    >
      Try again
    </button>
  </div>
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  color: var(--error);
  border-color: var(--error);
}

.state-text {
  flex: 1 1 280px;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.retry {
  flex: none;
}
</style>
