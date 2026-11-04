<script setup lang="ts">
/** A platform allowance (D38): how much of it is used, by settled calls and open reservations,
 *  with the numbers in words beside the bar, never the bar alone. */
import { computed } from 'vue';
import type { AllowanceView } from '../api/types';
import { money, plural, wholeMoney } from '../lib/format';

const props = withDefaults(defineProps<{ allowance: AllowanceView; label?: string; compact?: boolean }>(), { label: 'Conflict-check allowance', compact: false });

const share = computed(() => (props.allowance.limit_usd > 0 ? Math.min(100, (props.allowance.used_usd / props.allowance.limit_usd) * 100) : 0));
const words = computed(() => {
  const a = props.allowance;
  return `${props.label}: ${money(a.used_usd)} of ${wholeMoney(a.limit_usd)} used, ${money(a.remaining_usd)} left, ${plural(a.calls, 'call')}`;
});
</script>

<template>
  <span
    class="allowance"
    :class="{ 'allowance--compact': compact }"
    data-test="allowance"
  >
    <span
      class="meter allowance-meter"
      role="img"
      :aria-label="words"
    ><span :style="{ width: `${share}%` }" /></span>
    <span
      class="allowance-text"
      aria-hidden="true"
    ><template v-if="!compact">{{ label }}: </template><span class="num">{{ money(allowance.used_usd) }}</span> of <span class="num">{{ wholeMoney(allowance.limit_usd) }}</span> used<template v-if="!compact">, <span class="num">{{ money(allowance.remaining_usd) }}</span> left, {{ plural(allowance.calls, 'call') }}</template></span>
    <span
      v-if="allowance.half_reached && !compact"
      class="allowance-half"
    >More than half used</span>
  </span>
</template>

<style scoped>
.allowance {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.allowance-meter {
  width: 72px;
}

.allowance--compact .allowance-meter {
  width: 48px;
}

.allowance-half {
  font-weight: 600;
  color: var(--ink);
}
</style>
