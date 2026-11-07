<script setup lang="ts">
/**
 * One block of a reply on the Trial page (lib/trialMarkdown.ts piecesOf): plain runs, passages a
 * check quoted as evidence of a failure (a link to the check, highlighted) and amounts with no
 * source (highlighted and underlined). Every run is a text node (ReplyText), so nothing in a reply
 * becomes markup. Only a highlight's first piece is a link a keyboard reaches and a screen reader
 * hears, with its words; the rest of it (in the next table cell, say) is a link for the mouse alone.
 */
import type { Piece } from '../lib/trialMarkdown';
import ReplyText from './ReplyText.vue';

defineProps<{ pieces: Piece[] }>();
const emit = defineEmits<{ jump: [index: number] }>();
</script>

<template>
  <template
    v-for="(p, i) in pieces"
    :key="i"
  >
    <a
      v-if="p.quote"
      :href="`#grade-${p.quote.index}`"
      class="quote-link"
      data-test="quote-link"
      :tabindex="p.quoteFirst ? undefined : -1"
      :aria-hidden="p.quoteFirst ? undefined : 'true'"
      @click.prevent="emit('jump', p.quote.index)"
    ><span
      v-if="p.quoteFirst"
      class="visually-hidden"
    >{{ p.quote.label }}: </span><mark><mark
      v-if="p.amount"
      class="amount-mark"
      data-test="unsupported-amount"
    ><span
      v-if="p.amountFirst"
      class="visually-hidden"
    >Amount with no source found: </span><ReplyText :parts="p.parts" /></mark><ReplyText
      v-else
      :parts="p.parts"
    /></mark></a>
    <mark
      v-else-if="p.amount"
      class="amount-mark"
      data-test="unsupported-amount"
      title="No tool result or client message gives this amount"
    ><span
      v-if="p.amountFirst"
      class="visually-hidden"
    >Amount with no source found: </span><ReplyText :parts="p.parts" /></mark>
    <ReplyText
      v-else
      :parts="p.parts"
    />
  </template>
</template>

<style scoped>
/* A quoted passage is a link to the check that quoted it, styled as the highlight alone. */
.quote-link {
  color: inherit;
  text-decoration: none;
}

.quote-link:hover mark {
  box-shadow: inset 0 -2px 0 var(--rule-strong);
}

/* An amount with no source: the highlight and a wavy underline, so it reads apart from a check's
   quote, and the words say what it means. */
.amount-mark {
  background: var(--mark);
  color: var(--ink);
  text-decoration: underline wavy;
  text-decoration-color: var(--ink);
  text-underline-offset: 3px;
  padding: 0 2px;
  border-radius: 3px;
}
</style>
