<script setup lang="ts">
import { computed, ref } from 'vue';
import { harnessSlot, spendByConfig, usd, type TrialSummary } from '../trials';

/** Spend from LiteLLM's records (R10.9): total per config as horizontal bars, then one column
 *  per trial in run order. Colour is the harness; a legend names it, and the table below
 *  carries every number, so identity never rests on colour alone. */
const props = defineProps<{ trials: TrialSummary[] }>();

const tip = ref<{ x: number; y: number; lines: string[] } | null>(null);
const configs = computed(() => spendByConfig(props.trials));
const harnesses = computed(() => [...new Set(props.trials.map((t) => t.harness))].sort((a, b) => harnessSlot(a) - harnessSlot(b)));
const color = (h: string) => `var(--series-${harnessSlot(h)})`;

const BAR = 18;
const GAP = 10;
const LABEL_W = 260;
const CHART_W = 640;
const maxConfig = computed(() => Math.max(1e-9, ...configs.value.map((c) => c.totalUsd)));
const configHeight = computed(() => configs.value.length * (BAR + GAP) + 24);

const priced = computed(() => props.trials.filter((t) => t.proxyCostUsd !== null));
const maxTrial = computed(() => Math.max(1e-9, ...priced.value.map((t) => t.proxyCostUsd ?? 0)));
const COL_H = 140;
const colW = computed(() => Math.max(3, Math.min(24, (CHART_W - 40) / Math.max(1, priced.value.length) - 2)));

/** A bar with a 4px rounded data end and a square base (horizontal: base on the left). */
function hbar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}
/** A column with a 4px rounded top and a square base on the baseline. */
function vbar(x: number, base: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const top = base - h;
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

function show(e: MouseEvent, lines: string[]) {
  tip.value = { x: e.clientX + 12, y: e.clientY + 12, lines };
}
</script>

<template>
  <div class="spend">
    <div
      class="legend"
      aria-label="Harness colours"
    >
      <span
        v-for="h in harnesses"
        :key="h"
      ><span
        class="swatch"
        :style="{ background: color(h) }"
      />{{ h }}</span>
    </div>

    <h3>Total spend per config</h3>
    <p
      v-if="!configs.length"
      class="muted"
    >
      No trials yet.
    </p>
    <svg
      v-else
      :viewBox="`0 0 ${LABEL_W + CHART_W} ${configHeight}`"
      role="img"
      aria-label="Total spend per config, from LiteLLM records"
      class="chart"
    >
      <g
        v-for="(c, i) in configs"
        :key="c.key"
        @mousemove="show($event, [c.key, `${c.trials} trials, total ${usd(c.totalUsd)}, mean ${usd(c.meanUsd)}`, `proxy calls/trial ${c.meanProxyCalls?.toFixed(1) ?? '–'}, harness-counted ${c.meanHarnessCalls?.toFixed(1) ?? '–'}`])"
        @mouseleave="tip = null"
      >
        <rect
          x="0"
          :y="i * (BAR + GAP)"
          :width="LABEL_W + CHART_W"
          :height="BAR + GAP"
          fill="transparent"
        />
        <text
          x="0"
          :y="i * (BAR + GAP) + BAR - 4"
          class="label"
        >{{ c.harness }} · {{ c.model }} · prompt {{ c.promptVersion }}</text>
        <path
          :d="hbar(LABEL_W, i * (BAR + GAP), Math.max(2, (c.totalUsd / maxConfig) * (CHART_W - 90)), BAR)"
          :fill="color(c.harness)"
        />
        <text
          :x="LABEL_W + Math.max(2, (c.totalUsd / maxConfig) * (CHART_W - 90)) + 6"
          :y="i * (BAR + GAP) + BAR - 4"
          class="value"
        >{{ usd(c.totalUsd) }}</text>
      </g>
      <line
        :x1="LABEL_W"
        :x2="LABEL_W"
        y1="0"
        :y2="configs.length * (BAR + GAP)"
        class="axis"
      />
    </svg>

    <h3>Spend per trial, in run order</h3>
    <svg
      v-if="priced.length"
      :viewBox="`0 0 ${CHART_W + 60} ${COL_H + 24}`"
      role="img"
      aria-label="Spend per trial in run order"
      class="chart chart--cols"
    >
      <line
        x1="50"
        :x2="CHART_W + 60"
        :y1="COL_H"
        :y2="COL_H"
        class="axis"
      />
      <line
        x1="50"
        :x2="CHART_W + 60"
        y1="10"
        y2="10"
        class="grid"
      />
      <text
        x="44"
        y="14"
        class="tick"
        text-anchor="end"
      >{{ usd(maxTrial) }}</text>
      <text
        x="44"
        :y="COL_H"
        class="tick"
        text-anchor="end"
      >$0</text>
      <g
        v-for="(t, i) in priced"
        :key="t.trialId"
        @mousemove="show($event, [t.trialId, `${t.harness} · ${t.taskId}`, `${usd(t.proxyCostUsd)}, ${t.proxyCalls} proxy calls, ${t.endState} (${t.label})`])"
        @mouseleave="tip = null"
      >
        <rect
          :x="52 + i * (colW + 2)"
          y="0"
          :width="colW + 2"
          :height="COL_H"
          fill="transparent"
        />
        <a :href="`#/trials/${encodeURIComponent(t.trialId)}`">
          <path
            :d="vbar(52 + i * (colW + 2), COL_H, colW, Math.max(1, ((t.proxyCostUsd ?? 0) / maxTrial) * (COL_H - 12)))"
            :fill="color(t.harness)"
          />
        </a>
      </g>
    </svg>
    <p
      v-else
      class="muted"
    >
      No trial went through the proxy yet, so there is no recorded spend.
    </p>

    <div
      v-if="tip"
      class="tooltip"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      <div
        v-for="(line, i) in tip.lines"
        :key="i"
        :class="{ muted: i > 0 }"
      >
        {{ line }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.legend {
  display: flex;
  gap: 1rem;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}

h3 {
  font-size: 0.9rem;
  margin: 0.75rem 0 0.25rem;
  color: var(--text-secondary);
}

.chart {
  width: 100%;
  max-width: 900px;
  height: auto;
}

.label,
.value,
.tick {
  font-size: 12px;
  fill: var(--text-secondary);
}

.value {
  fill: var(--text-primary);
}

.tick {
  fill: var(--text-muted);
}

.axis {
  stroke: var(--axis);
  stroke-width: 1;
}

.grid {
  stroke: var(--grid);
  stroke-width: 1;
}
</style>
