<script setup lang="ts">
/** A run of an agent's reply with its Markdown styles (lib/markdown.ts inlineParts): bold and
 *  italic runs as <strong> and <em>, every run a text node. Nothing is rendered as HTML, so a tag
 *  or a script in a reply shows as the characters it is. */
import type { InlinePart } from '../lib/markdown';

defineProps<{ parts: InlinePart[] }>();
</script>

<template>
  <template
    v-for="(p, i) in parts"
    :key="i"
  >
    <strong
      v-if="p.bold && p.italic"
      class="reply-strong"
    ><em>{{ p.text }}</em></strong>
    <strong
      v-else-if="p.bold"
      class="reply-strong"
    >{{ p.text }}</strong>
    <em v-else-if="p.italic">{{ p.text }}</em>
    <template v-else>
      {{ p.text }}
    </template>
  </template>
</template>

<style scoped>
.reply-strong {
  font-weight: 600;
}
</style>
