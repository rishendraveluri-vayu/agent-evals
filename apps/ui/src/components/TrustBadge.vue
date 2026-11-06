<script setup lang="ts">
/**
 * How far to trust a judge on one criterion, or overall (D83): a word in a pill, never colour
 * alone. Trusted is ink-ruled with a tick, not trusted takes the warning amber with an alert, and
 * the three not-yet-measured states are grey. Pass green and fail red stay with graded outcomes:
 * trust is about the judge, not about an output. With `summary`, the one-sentence reason is the
 * pill's tooltip and is read out after the status.
 */
import { computed } from 'vue';
import type { JudgeTrustStatus } from '../api/types';
import { plainText } from '../lib/format';
import { trustLabel } from '../lib/trust';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ status: JudgeTrustStatus; summary?: string | null }>();

const label = computed(() => trustLabel(props.status));
const summaryText = computed(() => (props.summary ? plainText(props.summary) : ''));
const icon = computed<'check' | 'alert' | null>(() => (props.status === 'trusted' ? 'check' : props.status === 'not_trusted' ? 'alert' : null));
</script>

<template>
  <span
    class="trust-badge"
    :class="`trust-badge--${status}`"
    :data-status="status"
    :title="summaryText || undefined"
    data-test="trust-badge"
  ><AppIcon
    v-if="icon"
    :name="icon"
    :size="12"
  /><span data-test="trust-label">{{ label }}</span><span
    v-if="summaryText"
    class="visually-hidden"
  >: {{ summaryText }}</span></span>
</template>

<style scoped>
.trust-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
  background: var(--surface-muted);
  color: var(--ink);
}

/* Nothing measured yet: the quietest, an outline in grey. */
.trust-badge--uncalibrated {
  background: var(--surface);
  border-color: var(--rule-strong);
  color: var(--ink-2);
}

.trust-badge--trusted {
  background: var(--surface);
  border-color: var(--ink);
  font-weight: 600;
}

.trust-badge--not_trusted {
  background: var(--surface);
  border-color: var(--warning);
  color: var(--warning);
  font-weight: 600;
}
</style>
