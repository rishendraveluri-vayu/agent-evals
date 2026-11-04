<script setup lang="ts">
import { computed, ref } from 'vue';
import { duration, spanBars, type SpanBar } from '../trials';
import AppIcon from './AppIcon.vue';

/** One trial's spans as bars on a shared time axis: agent model calls (from LiteLLM), tool
 *  calls, simulated client turns, and the harness's own start-up and shut-down around them.
 *  Each bar is a button; choosing one shows its attributes below the chart. */
const props = defineProps<{ spans: import('../trials').SpanView[]; selected: string | null; harness?: string }>();
const emit = defineEmits<{ select: [spanId: string] }>();

const skipStartup = ref(false);
const layout = computed(() => spanBars(props.spans, props.harness));
const startup = computed(() => layout.value.bars.find((b) => b.role === 'harness' && b.startMs === 0 && b.derived)?.durationMs ?? 0);
const offset = computed(() => (skipStartup.value ? startup.value : 0));
const span = computed(() => Math.max(1, layout.value.totalMs - offset.value));
const rows = computed(() => layout.value.bars.filter((b) => !(skipStartup.value && b.derived && b.startMs === 0)));

const pct = (ms: number) => `${(Math.max(0, ms - offset.value) / span.value) * 100}%`;
const width = (b: SpanBar) => `${(Math.max(0, Math.min(b.startMs + b.durationMs, layout.value.totalMs) - Math.max(b.startMs, offset.value)) / span.value) * 100}%`;

/** Ticks every 1, 2, 5, 10... seconds, about five across. */
const ticks = computed(() => {
  const total = span.value / 1000;
  const raw = total / 5;
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 0.001)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const out: { left: string; label: string }[] = [];
  for (let t = 0; t <= total + 1e-9; t += step) {
    const decimals = step < 1 ? 1 : 0;
    out.push({ left: `${(t / total) * 100}%`, label: `${(t + offset.value / 1000).toFixed(decimals)} s` });
  }
  return out;
});

const LEGEND: [SpanBar['role'], string][] = [
  ['agent', 'Agent model call'],
  ['tool', 'Tool call'],
  ['client', 'Simulated client'],
  ['harness', 'Harness overhead'],
];
</script>

<template>
  <div class="timeline">
    <div class="timeline-head">
      <div class="legend smaller">
        <span
          v-for="[role, text] in LEGEND"
          :key="role"
          class="legend-item"
        ><span :class="`swatch-bar swatch-bar--${role}`" />{{ text }}</span>
        <label class="legend-item skip">
          <input
            v-model="skipStartup"
            type="checkbox"
            data-test="skip-startup"
          >Skip start-up<span
            v-if="startup"
            class="secondary"
          >&nbsp;({{ duration(startup) }})</span>
        </label>
      </div>
    </div>
    <p
      v-if="!rows.length"
      class="secondary"
    >
      No spans were recorded for this trial.
    </p>
    <div
      v-else
      class="panel chart-wrap"
    >
      <div class="chart">
        <template
          v-for="b in rows"
          :key="b.id"
        >
          <div
            v-if="b.derived"
            class="row row--static"
          >
            <span
              class="label"
              :title="b.title"
            >{{ b.label }}</span>
            <span class="track"><span
              v-for="t in ticks"
              :key="t.label"
              class="gridline"
              :style="{ left: t.left }"
            /><span
              :class="`bar bar--${b.role}`"
              :style="{ left: pct(b.startMs), width: width(b) }"
            /></span>
            <span class="dur num">{{ duration(b.durationMs) }}</span>
          </div>
          <button
            v-else
            type="button"
            class="row"
            :aria-pressed="b.id === selected"
            :aria-label="`${b.title}, ${duration(b.durationMs)}${b.error ? ', failed' : ''}. Show its details`"
            data-test="span-row"
            @click="emit('select', b.id)"
          >
            <span
              class="label"
              :title="b.title"
            ><AppIcon
              v-if="b.error"
              name="cross"
              :size="14"
              class="err"
            />{{ b.label }}</span>
            <span class="track"><span
              v-for="t in ticks"
              :key="t.label"
              class="gridline"
              :style="{ left: t.left }"
            /><span
              :class="`bar bar--${b.role}`"
              :style="{ left: pct(b.startMs), width: width(b) }"
            /></span>
            <span class="dur num">{{ duration(b.durationMs) }}</span>
          </button>
        </template>
        <div
          class="row row--axis"
          aria-hidden="true"
        >
          <span class="axis-pad" />
          <span class="axis">
            <span
              v-for="t in ticks"
              :key="t.label"
              class="axis-tick"
              :style="{ left: t.left }"
            >{{ t.label }}</span>
          </span>
          <span class="axis-pad" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-head {
  margin-bottom: 10px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  color: var(--ink-2);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.skip {
  color: var(--ink);
  min-height: 44px;
}

.swatch-bar {
  width: 14px;
  height: 10px;
  border-radius: 3px;
}

.chart-wrap {
  overflow-x: auto;
  padding: 14px 20px;
}

.chart {
  display: flex;
  flex-direction: column;
}

/* A 180 px label, the bars, and a 48 px duration: about 800 px fits beside the grading column. */
.row {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) 48px;
  gap: 12px;
  align-items: stretch;
  min-height: 32px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.row:hover,
.row[aria-pressed='true'] {
  background: var(--surface-muted);
}

.row--static {
  cursor: default;
}

.row--static:hover {
  background: transparent;
}

.row--axis {
  cursor: default;
  min-height: 22px;
}

.row--axis:hover {
  background: transparent;
}

.label {
  display: block;
  align-self: center;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.label .err {
  vertical-align: -2px;
  margin-right: 4px;
}

.err {
  color: var(--error);
}

/* No fill behind the bars: thin verticals at each axis tick run down through every row. */
.track {
  position: relative;
  display: block;
  min-height: 32px;
}

.gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--grid);
}

.bar {
  position: absolute;
  top: 50%;
  height: 14px;
  margin-top: -7px;
  min-width: 3px;
  border-radius: 4px;
}

/* Four kinds told apart by lightness and outline, never by hue: the agent dark, tools mid grey,
   the harness's own overhead light grey with an edge (so it shows in the dark theme too), and
   the simulated client an outline. Never dashed: dashes mean infra. */
.bar--agent,
.swatch-bar--agent {
  background: var(--span-agent);
}

.bar--tool,
.swatch-bar--tool {
  background: var(--neutral-mark-strong);
}

.bar--client,
.swatch-bar--client {
  background: transparent;
  border: 1.5px solid var(--ink);
}

.bar--harness,
.swatch-bar--harness {
  background: var(--neutral-mark);
  box-shadow: inset 0 0 0 1px var(--neutral-mark-strong);
}

.dur {
  align-self: center;
  text-align: right;
  color: var(--ink-2);
}

.axis {
  position: relative;
  display: block;
  height: 18px;
  font-size: 12px;
  color: var(--ink-2);
}

.axis-tick {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}

.axis-tick:first-child {
  transform: none;
}

/* On a phone each span is two lines: its name and duration, then its bar across the full width,
   with the time axis under the last bar. */
@media (max-width: 640px) {
  .chart-wrap {
    padding: 10px 12px;
  }

  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 10px;
    padding: 4px 6px 0;
  }

  .row .track {
    grid-column: 1 / -1;
    grid-row: 2;
    min-height: 22px;
  }

  .row--axis {
    grid-template-columns: minmax(0, 1fr);
    padding-top: 2px;
  }

  .row--axis .axis {
    grid-column: 1 / -1;
  }

  .axis-pad {
    display: none;
  }
}
</style>
