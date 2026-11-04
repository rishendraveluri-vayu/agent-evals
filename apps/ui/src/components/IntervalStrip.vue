<script setup lang="ts">
/** One or more estimates with their intervals on a shared scale, with a reference line (zero,
 *  or a bar such as kappa 0.6). Drawn at its real pixel width so the labels stay readable on a
 *  phone. Every use also states the numbers in text; the figure never carries them alone. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { StripRow, Tick } from '../lib/scale';

const props = defineProps<{
  min: number;
  max: number;
  ticks: Tick[];
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
/** A main row is a 6 px line with a 10 px-radius dot; a small one (such as an A/A run) is a 4 px
 *  line with a 6 px dot. Rows sit about 12 px apart, edge to edge. */
const RADIUS = { lg: 10, sm: 6 } as const;
const STROKE = { lg: 3, sm: 2 } as const;
const sizeOf = (r: StripRow) => r.size ?? 'lg';
const outer = (r: StripRow) => RADIUS[sizeOf(r)] + STROKE[sizeOf(r)] / 2;
/** About how wide a 13 px label is, to keep labels apart and inside the figure. */
const textWidth = (text: string) => text.length * 6.6;
/** Room a label above its row takes: the row, and every row under it, moves down this far. */
const ABOVE = 16;
/** No label comes nearer the reference line than this, so the line never runs through a letter. */
const REF_CLEAR = 6;

interface Placement {
  x: number;
  anchor: 'start' | 'end';
  above: boolean;
  from: number;
  to: number;
}

const refX = computed(() => x(props.reference.value));
const fits = (p: Placement) => p.from >= PAD && p.to <= width.value - PAD && (p.to < refX.value - REF_CLEAR || p.from > refX.value + REF_CLEAR);

/** A row's label goes right of its interval, else left of it, else above it (from its low end,
 *  or back from its high end), wherever it stays inside the figure and clear of the reference
 *  line. A row with no such place is named in the legend under the figure. */
const placements = computed<(Placement | null)[]>(() =>
  props.rows.map((r) => {
    if (!r.label) return null;
    const w = textWidth(r.label);
    const lo = x(r.low);
    const hi = x(r.high);
    const candidates: Placement[] = [
      { x: hi + 10, anchor: 'start', above: false, from: hi + 10, to: hi + 10 + w },
      { x: lo - 10, anchor: 'end', above: false, from: lo - 10 - w, to: lo - 10 },
      { x: lo, anchor: 'start', above: true, from: lo, to: lo + w },
      { x: hi, anchor: 'end', above: true, from: hi - w, to: hi },
    ];
    return candidates.find(fits) ?? null;
  }),
);

const ys = computed(() => {
  const out: number[] = [];
  props.rows.forEach((r, i) => {
    const lift = placements.value[i]?.above ? ABOVE : 0;
    out.push((i === 0 ? 22 : out[i - 1] + outer(props.rows[i - 1]) + 12 + outer(r)) + lift);
  });
  return out;
});
const rowY = (i: number) => ys.value[i] ?? 22;
const lastY = computed(() => rowY(props.rows.length - 1));
const height = computed(() => lastY.value + 38);
const labelY = (r: StripRow, i: number) => (placements.value[i]?.above ? rowY(i) - outer(r) - 6 : rowY(i) + 4);

/** Every tick when they all fit 8 px apart. Otherwise the reference tick (in its short form) and
 *  the ticks an even number of steps from it, so the shown ticks stay evenly spaced; any that
 *  still collide are left out. Each is centred on its value, kept inside the figure. */
const shownTicks = computed(() => {
  const sorted = [...props.ticks].sort((p, q) => p.value - q.value);
  const place = (t: Tick, text: string) => {
    const w = textWidth(text);
    const at = Math.min(Math.max(x(t.value), w / 2), width.value - w / 2);
    return { ...t, text, at, from: at - w / 2, to: at + w / 2 };
  };
  const all = sorted.map((t) => place(t, t.label));
  if (all.every((t, i) => i === 0 || all[i - 1].to + 8 <= t.from) || sorted.length < 2) return all;
  const anchor = sorted.find((t) => t.strong) ?? [...sorted].sort((p, q) => Math.abs(p.value - props.reference.value) - Math.abs(q.value - props.reference.value))[0];
  const gaps = sorted.slice(1).map((t, i) => t.value - sorted[i].value).filter((g) => g > 1e-9);
  const step = Math.min(...gaps);
  const even = sorted.filter((t) => {
    const k = (t.value - anchor.value) / step;
    return Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) % 2 === 0;
  });
  const kept: ReturnType<typeof place>[] = [];
  for (const t of [...even].sort((p, q) => Math.abs(p.value - anchor.value) - Math.abs(q.value - anchor.value))) {
    const c = place(t, t.short ?? t.label);
    if (kept.every((k) => c.to + 8 <= k.from || c.from >= k.to + 8)) kept.push(c);
  }
  return kept.sort((p, q) => p.value - q.value);
});

/** Rows whose label has no room in the figure are named in a legend under it, so no row is ever
 *  left unlabelled. */
const legend = computed(() => props.rows.filter((r, i) => r.label && !placements.value[i]));
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
          :class="`range range--${r.tone} range--${sizeOf(r)}`"
        />
        <circle
          :cx="x(r.estimate)"
          :cy="rowY(i)"
          :r="RADIUS[sizeOf(r)]"
          :class="`point point--${r.tone} point--${sizeOf(r)}`"
        />
        <text
          v-if="r.label && placements[i]"
          :x="placements[i]?.x"
          :y="labelY(r, i)"
          :text-anchor="placements[i]?.anchor"
          :data-place="placements[i]?.above ? 'above' : 'beside'"
          class="tick row-label"
          data-test="strip-label"
        >{{ r.label }}</text>
      </g>
      <text
        v-for="t in shownTicks"
        :key="t.value"
        :x="t.at"
        :y="height - 6"
        text-anchor="middle"
        :class="t.strong ? 'tick tick--strong' : 'tick'"
        data-test="strip-tick"
      >{{ t.text }}</text>
    </svg>
    <ul
      v-if="legend.length"
      class="strip-legend"
      data-test="strip-legend"
    >
      <li
        v-for="(r, i) in legend"
        :key="i"
      >
        <span
          :class="`swatch-line swatch-line--${r.tone}`"
          aria-hidden="true"
        />{{ r.label }}
      </li>
    </ul>
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

/* A label beside the first row sits on the grey axis track; a halo in the surface colour keeps it
   readable there. The reference line needs no halo: placement keeps every label clear of it. */
.row-label {
  paint-order: stroke;
  stroke: var(--surface);
  stroke-width: 4px;
  stroke-linejoin: round;
}

.strip-legend {
  list-style: none;
  margin: 2px 0 0;
  padding: 0 0 0 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 13px;
  color: var(--ink-2);
}

.strip-legend li {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* The row in miniature: its line with its dot in the middle. */
.swatch-line {
  position: relative;
  display: inline-block;
  width: 20px;
  height: 4px;
  border-radius: 2px;
  background: var(--neutral-line);
}

.swatch-line::after {
  content: '';
  position: absolute;
  left: 6px;
  top: -2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--neutral-dot);
}

.swatch-line--a,
.swatch-line--a::after {
  background: var(--arm-a);
}

.swatch-line--b,
.swatch-line--b::after {
  background: var(--arm-b);
}

.swatch-line--ink,
.swatch-line--ink::after {
  background: var(--ink);
}
</style>
