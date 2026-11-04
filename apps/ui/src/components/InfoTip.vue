<script setup lang="ts">
/**
 * An "i" button that opens a short note beside it: a real <button> with an aria-label and
 * aria-expanded. Escape closes the note and puts focus back on the button; a click or a tab
 * outside closes it too. The note never runs past the window's 16 px gutters, so it works at
 * phone width.
 */
import { nextTick, onBeforeUnmount, ref, useId } from 'vue';
import AppIcon from './AppIcon.vue';

defineProps<{ label: string }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const note = ref<HTMLElement | null>(null);
/** Sideways shift that keeps the note inside the window, in px. */
const shift = ref(0);
const id = `info-${useId()}`;
const GUTTER = 16;

function place() {
  const el = note.value;
  const width = document.documentElement.clientWidth || window.innerWidth;
  if (!el || !width) return;
  const box = el.getBoundingClientRect();
  if (!box.width) return;
  const left = box.left - shift.value;
  let next = 0;
  if (left + box.width > width - GUTTER) next = width - GUTTER - box.width - left;
  if (left + next < GUTTER) next = GUTTER - left;
  shift.value = next;
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !open.value) return;
  e.preventDefault();
  close(true);
}

function onPointer(e: Event) {
  if (root.value && e.target instanceof Node && !root.value.contains(e.target)) close(false);
}

function listen(on: boolean) {
  if (on) {
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', place);
  } else {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('resize', place);
  }
}

async function show() {
  open.value = true;
  shift.value = 0;
  listen(true);
  await nextTick();
  place();
}

function close(refocus: boolean) {
  open.value = false;
  listen(false);
  if (refocus) button.value?.focus();
}

/** Tabbing past the note closes it; a click inside it (focus to nothing) does not. */
function onFocusOut(e: FocusEvent) {
  const next = e.relatedTarget;
  if (open.value && next instanceof Node && root.value && !root.value.contains(next)) close(false);
}

onBeforeUnmount(() => listen(false));
</script>

<template>
  <div
    ref="root"
    class="info"
    @focusout="onFocusOut"
  >
    <button
      ref="button"
      type="button"
      class="info-button"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="id"
      data-test="info-button"
      @click="open ? close(false) : show()"
    >
      <AppIcon
        name="info"
        :size="18"
      />
    </button>
    <div
      v-show="open"
      :id="id"
      ref="note"
      class="info-note"
      :style="shift ? { transform: `translateX(${shift}px)` } : undefined"
      data-test="info-note"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.info {
  position: relative;
  display: inline-flex;
  flex: none;
}

/* A 44 px target around an 18 px mark, pulled in so it does not push the line apart. */
.info-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin: -12px -10px -12px -6px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}

.info-button:hover,
.info-button[aria-expanded='true'] {
  color: var(--ink);
  background: var(--surface-muted);
}

.info-note {
  position: absolute;
  top: calc(100% + 12px);
  left: -6px;
  z-index: 30;
  width: max-content;
  max-width: min(340px, calc(100vw - 32px));
  padding: 12px 14px;
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--rule-strong);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.12);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  cursor: auto;
}
</style>
