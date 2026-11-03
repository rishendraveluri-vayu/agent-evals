<script setup lang="ts">
import { computed, ref } from 'vue';
import { duration, text, timelineRows, type SpanRole, type SpanView } from '../trials';

/** One trial's spans as a timeline: one row per span in tree order, indented by depth, with a
 *  bar from its start to its end. Model calls come from LiteLLM (evals.source = proxy). */
const props = defineProps<{ spans: SpanView[]; selected: string | null }>();
const emit = defineEmits<{ select: [spanId: string] }>();

const layout = computed(() => timelineRows(props.spans));
const ROW = 22;
const NAME_W = 300;
const PLOT_W = 620;
const height = computed(() => layout.value.rows.length * ROW + 28);
/** Skip start-up: begin the axis at the first span under the root, so harness start-up (several
 *  seconds for Hermes) does not squash the agent's activity. The root bar is clipped, not lost. */
const skipStartup = ref(true);
const offset = computed(() => {
  if (!skipStartup.value) return 0;
  const inner = layout.value.rows.filter((r) => r.depth > 0).map((r) => r.startMs);
  return inner.length ? Math.min(...inner) : 0;
});
const span = computed(() => Math.max(1e-6, layout.value.totalMs - offset.value));
const scale = (ms: number) => (Math.max(0, ms) / span.value) * PLOT_W;
const barX = (startMs: number) => NAME_W + scale(startMs - offset.value);
const barW = (startMs: number, durationMs: number) =>
  Math.max(3, scale(Math.min(startMs + durationMs, layout.value.totalMs) - Math.max(startMs, offset.value)));
const tip = ref<{ x: number; y: number; lines: string[] } | null>(null);

const ROLE_FILL: Record<SpanRole, string> = {
  trial: 'var(--neutral-mark)',
  turn: 'var(--neutral-mark-strong)',
  chat: 'var(--series-1)',
  tool: 'var(--series-2)',
  client: 'var(--series-3)',
  'chat-sim': 'var(--series-5)',
};
const LEGEND: [SpanRole, string][] = [
  ['chat', 'agent model call (LiteLLM)'],
  ['tool', 'tool call'],
  ['client', 'simulated client turn'],
  ['chat-sim', 'simulator model call'],
  ['turn', 'agent turn'],
];

const ticks = computed(() => {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    x: NAME_W + f * PLOT_W,
    label: duration(offset.value + f * span.value),
  }));
});

function label(span: SpanView): string {
  const a = span.attributes;
  if (span.name.startsWith('chat ')) {
    const attempt = Number(a['evals.attempt'] ?? 1);
    return `${span.name}${attempt > 1 ? ` (attempt ${attempt})` : ''}`;
  }
  if (span.name === 'agent.turn') return `agent turn ${text(a['evals.turn.index'])}`;
  if (span.name === 'client_sim.turn') return `client turn ${text(a['evals.sim.index'])}`;
  return span.name;
}

function tipLines(span: SpanView, durationMs: number): string[] {
  const a = span.attributes;
  const lines = [label(span), duration(durationMs)];
  if (a['gen_ai.usage.input_tokens'] !== undefined) {
    lines.push(`tokens ${text(a['gen_ai.usage.input_tokens'])} in / ${text(a['gen_ai.usage.output_tokens'])} out, $${Number(a['evals.cost_usd'] ?? 0).toFixed(6)}`);
  }
  if (a['evals.proxy.status'] && a['evals.proxy.status'] !== '200') lines.push(`status ${text(a['evals.proxy.status'])}`);
  if (a['evals.tool.is_error'] === true) lines.push(`tool error: ${text(a['evals.error.kind'])}`);
  if (span.statusCode === 2) lines.push(`error: ${span.statusMessage ?? ''}`);
  if (span.events.length) lines.push(`${span.events.length} event(s): ${span.events.map((e) => e.name).join(', ')}`);
  return lines;
}
</script>

<template>
  <div>
    <label class="zoom">
      <input
        v-model="skipStartup"
        type="checkbox"
      > Skip start-up ({{ duration(offset) }} before the first turn)
    </label>
    <div class="legend">
      <span
        v-for="[role, legendText] in LEGEND"
        :key="role"
      ><span
        class="swatch"
        :style="{ background: ROLE_FILL[role] }"
      />{{ legendText }}</span>
    </div>
    <p
      v-if="!layout.rows.length"
      class="muted"
    >
      No spans.
    </p>
    <svg
      v-else
      :viewBox="`0 0 ${NAME_W + PLOT_W + 10} ${height}`"
      class="timeline"
      role="img"
      aria-label="Span timeline for this trial"
    >
      <g
        v-for="t in ticks"
        :key="t.x"
      >
        <line
          :x1="t.x"
          :x2="t.x"
          y1="18"
          :y2="height"
          class="grid"
        />
        <text
          :x="t.x"
          y="12"
          class="tick"
          text-anchor="middle"
        >{{ t.label }}</text>
      </g>
      <g
        v-for="(row, i) in layout.rows"
        :key="row.span.spanId"
        class="row"
        :class="{ 'row--selected': row.span.spanId === selected }"
        tabindex="0"
        @click="emit('select', row.span.spanId)"
        @keydown.enter="emit('select', row.span.spanId)"
        @mousemove="tip = { x: $event.clientX + 12, y: $event.clientY + 12, lines: tipLines(row.span, row.durationMs) }"
        @mouseleave="tip = null"
      >
        <rect
          x="0"
          :y="22 + i * ROW"
          :width="NAME_W + PLOT_W"
          :height="ROW"
          class="hit"
        />
        <text
          :x="4 + row.depth * 14"
          :y="22 + i * ROW + 15"
          class="name"
        >{{ row.span.statusCode === 2 ? '✕ ' : '' }}{{ label(row.span) }}</text>
        <rect
          :x="barX(row.startMs)"
          :y="22 + i * ROW + 5"
          :width="barW(row.startMs, row.durationMs)"
          height="12"
          rx="3"
          :fill="ROLE_FILL[row.role]"
        />
      </g>
    </svg>
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
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 0.8rem;
  margin-bottom: 0.5rem;
}

.zoom {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.4rem;
}

.timeline {
  width: 100%;
  height: auto;
}

.grid {
  stroke: var(--grid);
  stroke-width: 1;
}

.tick {
  font-size: 11px;
  fill: var(--text-muted);
}

.name {
  font-size: 12px;
  fill: var(--text-primary);
}

.hit {
  fill: transparent;
  cursor: pointer;
}

.row:hover .hit,
.row--selected .hit {
  fill: var(--surface-2);
}

.row:focus {
  outline: none;
}

.row:focus .hit {
  stroke: var(--link);
}
</style>
