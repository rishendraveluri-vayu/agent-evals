<script setup lang="ts">
/** One way to say how arm B did against arm A, wherever a verdict shows. Better and worse are a
 *  tinted pill with an arrow, so the meaning never rests on colour alone. No detectable difference is
 *  plain ink text with no pill, at regular weight (.result-plain[data-verdict='none'] in
 *  theme.css): it is the absence of evidence, not a finding, so it reads lighter than the pills.
 *  No interval yet keeps the medium weight of the status words. */
import { computed } from 'vue';
import type { Verdict } from '../lib/arms';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ verdict: Verdict; label?: string }>();

const DEFAULTS: Record<Verdict, string> = {
  better: 'Better',
  worse: 'Worse',
  none: 'No detectable difference',
  pending: 'No interval yet',
};

const text = computed(() => props.label ?? DEFAULTS[props.verdict]);
</script>

<template>
  <span
    v-if="verdict === 'better' || verdict === 'worse'"
    class="verdict-tag"
    :class="verdict === 'better' ? 'verdict-tag--better' : 'verdict-tag--worse'"
    :data-verdict="verdict"
  ><AppIcon
    :name="verdict === 'better' ? 'arrow-up' : 'arrow-down'"
    :size="13"
  />{{ text }}</span>
  <span
    v-else
    class="result-plain"
    :data-verdict="verdict"
  >{{ text }}</span>
</template>

<style scoped>
.verdict-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 9px 1px 7px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.verdict-tag--better {
  background: var(--pass-soft);
  color: var(--pass);
}

.verdict-tag--worse {
  background: var(--fail-soft);
  color: var(--fail);
}
</style>
