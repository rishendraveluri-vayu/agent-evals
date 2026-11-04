<script setup lang="ts">
/** One or more estimates with their intervals on a shared scale, with a reference line (zero,
 *  or a bar such as kappa 0.6). Drawn at its real pixel width so the labels stay readable on a
 *  phone. Every use also states the numbers in text; the figure never carries them alone. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { StripRow } from '../lib/scale';

const props = defineProps<{
  min: number;
  max: number;
  ticks: { value: number; label: string; strong?: boolean }[];
  rows: StripRow[];
  reference: { value: number; dashed?: boolean };
  summary: string;
}>();

const box = ref<HTMLElement | null>(null);
const width = ref(600);
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (!box.value || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w && w > 0) width.value = Math.round(w);
  });
  observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

const PAD = 20;
const x = (v: number) => PAD + ((Math.min(props.max, Math.max(props.min, v)) - props.min) / (props.max - props.min)) * (width.value - 2 * PAD);
const rowY = (i: number) => 22 + i * 24;
const lastY = computed(() => rowY(props.rows.length - 1));
const height = computed(() => lastY.value + 38);
/** About how wide a 13 px label is, to keep labels apart and inside the figure. */
const textWidth = (text: string) => text.length * 6.6;

/** Labels are placed in order of importance: the reference (zero or a bar), then the two
 *  ends, then the rest. A label that would touch one already placed is left out, which
 *  only happens at phone width. */
const shownTicks = computed(() => {
  const n = props.ticks.length;
  const placed = props.ticks.map((t, i) => {
    const at = i === 0 ? PAD : i === n - 1 ? width.value - PAD : x(t.value);
    const w = textWidth(t.label);
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const [from, to] = anchor === 'start' ? [at, at + w] : anchor === 'end' ? [at - w, at] : [at - w / 2, at + w / 2];
    return { ...t, at, anchor, from, to, rank: t.strong ? 0 : i === 0 || i === n - 1 ? 1 : 2 };
  });
  const kept: typeof placed = [];
  for (const t of [...placed].sort((p, q) => p.rank - q.rank)) {
    if (kept.every((k) => t.to + 8 < k.from || t.from > k.to + 8)) kept.push(t);
  }
  return kept;
});

/** A row's label goes right of its interval, else left of it, else it is left out: the
 *  surrounding text always states the same numbers. */
const labelAt = (r: StripRow) => {
  const w = textWidth(r.label ?? '');
  const right = x(r.high) + 10;
  if (right + w < width.value) return { x: right, anchor: 'start' };
  const left = x(r.low) - 10;
  if (left - w > 0) return { x: left, anchor: 'end' };
  return null;
};
</script>

<template>
  <div
    ref="box"
    class="strip"
  >
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      :width="width"
      :height="height"
      role="img"
      :aria-label="summary"
    >
      <line
        :x1="PAD"
        :x2="width - PAD"
        :y1="rowY(0)"
        :y2="rowY(0)"
        class="axis"
      />
      <line
        :x1="x(reference.value)"
        :x2="x(reference.value)"
        :y1="4"
        :y2="lastY + 14"
        :class="reference.dashed ? 'ref ref--dashed' : 'ref'"
      />
      <g
        v-for="(r, i) in rows"
        :key="i"
      >
        <line
          :x1="x(r.low)"
          :x2="x(r.high)"
          :y1="rowY(i)"
          :y2="rowY(i)"
          :class="`range range--${r.tone} range--${r.size ?? 'lg'}`"
        />
        <circle
          :cx="x(r.estimate)"
          :cy="rowY(i)"
          :r="(r.size ?? 'lg') === 'lg' ? 9 : 6"
          :class="`point point--${r.tone} point--${r.size ?? 'lg'}`"
        />
        <text
          v-if="r.label && labelAt(r)"
          :x="labelAt(r)?.x"
          :y="rowY(i) + 4"
          :text-anchor="labelAt(r)?.anchor"
          class="tick"
        >{{ r.label }}</text>
      </g>
      <text
        v-for="t in shownTicks"
        :key="t.value"
        :x="t.at"
        :y="height - 6"
        :text-anchor="t.anchor"
        :class="t.strong ? 'tick tick--strong' : 'tick'"
      >{{ t.label }}</text>
    </svg>
  </div>
</template>

<style scoped>
.strip {
  width: 100%;
  min-width: 0;
}

svg {
  display: block;
  max-width: 100%;
  height: auto;
}

.axis {
  stroke: var(--track);
  stroke-width: 2;
}

.ref {
  stroke: var(--ink);
  stroke-width: 1.5;
}

.ref--dashed {
  stroke: var(--ink-2);
  stroke-dasharray: 3 3;
}

.range {
  stroke-linecap: round;
}

.range--lg {
  stroke-width: 6;
}

.range--sm {
  stroke-width: 4;
}

.range--a {
  stroke: var(--arm-a);
}

.range--b {
  stroke: var(--arm-b);
}

.range--ink {
  stroke: var(--ink);
}

.range--neutral {
  stroke: var(--neutral-line);
}

.point {
  stroke: var(--surface);
}

.point--lg {
  stroke-width: 3;
}

.point--sm {
  stroke-width: 2;
}

.point--a {
  fill: var(--arm-a);
}

.point--b {
  fill: var(--arm-b);
}

.point--ink {
  fill: var(--ink);
}

.point--neutral {
  fill: var(--neutral-dot);
}

.tick {
  font-size: 13px;
  fill: var(--ink-2);
}

.tick--strong {
  fill: var(--ink);
}
</style>
