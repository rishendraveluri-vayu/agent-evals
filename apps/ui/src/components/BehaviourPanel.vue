<script setup lang="ts">
import { computed } from 'vue';
import type { BehaviourArm, BehaviourStat, CauseKind, CompareBehaviour, ProseFiguresArm } from '../api/types';
import { CAUSE_NAME, CAUSE_ORDER, CAUSE_RULE } from '../lib/causes';
import { endStateName } from '../lib/names';
import { percent, plural, signed } from '../lib/format';

/**
 * D64: how each arm behaved, beside the pass rate and never a verdict on its own. Tool calls per
 * trial overall and by tool (tools as rows, the arms side by side, differences marked), how often
 * the tools the tasks need were called, steps and step-limit hits, tool errors, figures written
 * without a tool (D61), end states, and why trials failed (the rule-based causes).
 */
const props = defineProps<{
  behaviour: CompareBehaviour;
  prose: ProseFiguresArm[];
  /** While held-out outputs remain to label, where the judge and your labels disagree stays hidden. */
  labelsDone: boolean;
}>();

const arms = computed(() => props.behaviour.arms);
const two = computed(() => arms.value.length >= 2);
const letters = computed(() => arms.value.map((a) => a.arm));
const keyOf = (arm: string) => arm.toLowerCase();

/** A per-trial figure: one decimal, two when it is small but not zero. */
function perTrial(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  if (v !== 0 && Math.abs(v) < 0.1) return v.toFixed(2);
  return v.toFixed(1);
}
function signedPerTrial(v: number): string {
  return v !== 0 && Math.abs(v) < 0.1 ? signed(v, 2) : signed(v, 1);
}

interface Tile {
  name: string;
  delta: string;
  note: string;
  values: { arm: string; value: number; text: string }[];
  max: number;
}

const paired = (metric: BehaviourStat['metric']) => props.behaviour.paired.find((p) => p.metric === metric) ?? null;

/** "interval −0.4 to +0.8, B minus A per task over 12 tasks" for a paired row. */
function pairedNote(p: BehaviourStat | null): string {
  if (!p) return '';
  return `interval ${signedPerTrial(p.diff.low)} to ${signedPerTrial(p.diff.high)}, B minus A per task over ${plural(p.tasks, 'task')}; no verdict`;
}

const tiles = computed<Tile[]>(() => {
  const [a, b] = arms.value;
  if (!a) return [];
  const out: Tile[] = [];
  const vals = (pick: (x: BehaviourArm) => number | null) =>
    arms.value.flatMap((x) => {
      const v = pick(x);
      return v === null ? [] : [{ arm: x.arm, value: v, text: perTrial(v) }];
    });
  const delta = (p: BehaviourStat | null, pick: (x: BehaviourArm) => number | null) => {
    if (p) return `${signedPerTrial(p.diff.estimate)} per trial`;
    const va = pick(a);
    const vb = b ? pick(b) : null;
    return va !== null && vb !== null ? `${signedPerTrial(vb - va)} per trial` : `${perTrial(va)} per trial`;
  };
  const callsVals = vals((x) => x.tool_calls.per_trial);
  out.push({
    name: 'Tool calls per trial',
    delta: delta(paired('tool_calls'), (x) => x.tool_calls.per_trial),
    note: pairedNote(paired('tool_calls')) || `${plural(a.tool_calls.total, 'call')} in ${plural(a.trials, 'trial')}`,
    values: callsVals,
    max: Math.max(0, ...callsVals.map((v) => v.value)),
  });
  const stepVals = vals((x) => x.steps.per_trial);
  const limits = arms.value.map((x) => `${x.arm} ${x.steps.step_limit} of ${x.steps.trials_measured}`).join(', ');
  out.push({
    name: 'Steps per trial',
    delta: delta(paired('steps'), (x) => x.steps.per_trial),
    note: `${pairedNote(paired('steps')) ? `${pairedNote(paired('steps'))}. ` : ''}Stopped at the step limit: ${limits}`,
    values: stepVals,
    max: Math.max(0, ...stepVals.map((v) => v.value)),
  });
  const errVals = vals((x) => x.tool_errors.per_trial);
  out.push({
    name: 'Tool errors per trial',
    delta: delta(null, (x) => x.tool_errors.per_trial),
    note: arms.value.map((x) => `${x.arm}: ${plural(x.tool_errors.total, 'error')} in ${plural(x.tool_errors.trials, 'trial')}`).join('; '),
    values: errVals,
    max: Math.max(0, ...errVals.map((v) => v.value)),
  });
  // D61: figures written without a tool, once every arm has trials whose checks count them.
  const prose = letters.value.map((l) => props.prose.find((p) => p.arm === l));
  if (prose.length && prose.every((p) => p?.per_trial != null)) {
    const ps = prose as ProseFiguresArm[];
    const unmeasured = ps.reduce((s, p) => s + p.trials_unmeasured, 0);
    const left = unmeasured ? `; ${plural(unmeasured, 'trial')} whose checks predate this measure not counted` : '';
    const pv = ps.map((p) => ({ arm: p.arm, value: p.per_trial as number, text: (p.per_trial as number).toFixed(1) }));
    out.push({
      name: 'Figures written without a tool',
      delta: ps.length === 2 ? `${signed((ps[1].per_trial as number) - (ps[0].per_trial as number), 1)} per trial` : `${pv[0].text} per trial`,
      note: `${ps.map((p) => `${p.derived_in_prose} of ${plural(p.amounts, 'figure')}`).join(' and ')}, checked by recomputing them; a measure, not a gate${left}`,
      values: pv,
      max: Math.max(0, ...pv.map((v) => v.value)),
    });
  }
  return out;
});

/** A tool's name in pieces that may break after each underscore, so a phone never splits a word. */
const nameParts = (tool: string): string[] => tool.split(/(?<=_)/);

const barShare = (v: number, max: number) => `${Math.max(0, Math.min(100, (v / (max || 1)) * 100))}%`;

/** Tools as rows, the arms side by side; marked when one arm never called it, or the arms are half a call per trial or more apart. */
const toolRows = computed(() => {
  const names = new Set(arms.value.flatMap((x) => x.by_tool.map((t) => t.tool)));
  const rows = [...names].map((tool) => {
    const cells = arms.value.map((x) => x.by_tool.find((t) => t.tool === tool) ?? null);
    const per = cells.map((c) => c?.per_trial ?? 0);
    const errors = cells.map((c) => c?.errors ?? 0);
    let mark = '';
    if (two.value) {
      if (per[0] === 0 && per[1] > 0) mark = `only in ${letters.value[1]}`;
      else if (per[1] === 0 && per[0] > 0) mark = `only in ${letters.value[0]}`;
      else if (Math.abs(per[1] - per[0]) >= 0.5) mark = 'differs';
    }
    return { tool, per, errors, diff: two.value ? signedPerTrial(per[1] - per[0]) : '', mark, total: per.reduce((s, v) => s + v, 0) };
  });
  return rows.sort((x, y) => y.total - x.total || x.tool.localeCompare(y.tool));
});
const errorsAnywhere = computed(() => toolRows.value.some((r) => r.errors.some((e) => e > 0)));

/** Per tool a task needs: of the trials of tasks that need it, how many called it, per arm. */
const requiredRows = computed(() => {
  const names = [...new Set(arms.value.flatMap((x) => x.required_tools.map((t) => t.tool)))].sort();
  return names.map((tool) => {
    const cells = arms.value.map((x) => x.required_tools.find((t) => t.tool === tool) ?? null);
    const shares = cells.map((c) => (c ? c.share : null));
    const differs = two.value && shares[0] !== null && shares[1] !== null && Math.abs(shares[1] - shares[0]) >= 0.1;
    return { tool, cells: cells.map((c) => (c ? { text: `${c.called} of ${c.trials}`, share: percent(c.share) } : null)), differs };
  });
});

const endRows = computed(() => {
  const names = [...new Set(arms.value.flatMap((x) => x.end_states.map((e) => e.end_state)))];
  const total = (s: string) => arms.value.reduce((n, x) => n + (x.end_states.find((e) => e.end_state === s)?.trials ?? 0), 0);
  names.sort((x, y) => Number(y === 'answered') - Number(x === 'answered') || total(y) - total(x) || x.localeCompare(y));
  return names.map((s) => ({ state: s, name: endStateName(s), cells: arms.value.map((x) => `${x.end_states.find((e) => e.end_state === s)?.trials ?? 0} of ${x.trials}`) }));
});

/** Causes in rule order. While labelling is blind, the judge against your label shows only as a judge check that failed. */
const causeRows = computed(() => {
  const kinds = new Set<CauseKind>(arms.value.flatMap((x) => x.causes.by_cause.map((c) => c.cause)));
  return CAUSE_ORDER.filter((k) => kinds.has(k)).flatMap((k) => {
    const cells = arms.value.map((x) => x.causes.by_cause.find((c) => c.cause === k) ?? { primary: 0, contributing: 0 });
    const blind = k === 'judge_vs_label' && !props.labelsDone;
    if (blind && cells.every((c) => !c.primary)) return [];
    return [
      {
        kind: k,
        name: blind ? 'A judge check failed' : CAUSE_NAME[k],
        cells: cells.map((c) => ({ primary: c.primary, also: blind ? 0 : c.contributing })),
        grew: two.value && cells[1].primary > cells[0].primary,
      },
    ];
  });
});
const withCause = computed(() => arms.value.map((x) => `${x.arm} ${x.causes.trials} of ${x.trials}`).join(', '));
const rules = computed(() => CAUSE_ORDER.filter((k) => props.labelsDone || k !== 'judge_vs_label').map((k) => ({ kind: k, name: CAUSE_NAME[k], rule: CAUSE_RULE[k] })));
</script>

<template>
  <section
    aria-labelledby="behaviour"
    class="stack"
    data-test="behaviour"
  >
    <h2
      id="behaviour"
      class="section-title"
    >
      How the arms behaved
    </h2>
    <p class="secondary small intro">
      What each arm’s agent did in its finished trials, from the recorded tool calls, end states and checks. These explain the pass rate; none of them is a verdict.
    </p>
    <div class="stat-strip tiles">
      <div
        v-for="t in tiles"
        :key="t.name"
        data-test="behaviour-tile"
      >
        <span class="stat-label">{{ t.name }}</span>
        <span class="tile-delta num">{{ t.delta }}</span>
        <span class="secondary smaller num block">{{ t.note }}</span>
        <div
          class="bars"
          role="img"
          :aria-label="`${t.name}: ${t.values.map((v) => `${v.arm} ${v.text}`).join(', ')}`"
        >
          <template
            v-for="v in t.values"
            :key="v.arm"
          >
            <span class="bar-label num">{{ v.arm }} {{ v.text }}</span>
            <span class="rail"><span
              :class="`bar bar--${keyOf(v.arm)}`"
              :data-test="`bar-${keyOf(v.arm)}`"
              :style="{ width: barShare(v.value, t.max) }"
            /></span>
          </template>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="part">
        <h3 class="sub">
          Tool calls per trial, by tool
        </h3>
        <p class="secondary smaller">
          Every tool either arm called, most called first.<template v-if="two">
            Marked where one arm never called it, or the arms are half a call per trial or more apart.
          </template>
        </p>
        <div class="table-wrap">
          <table
            class="table compact"
            data-test="tool-table"
          >
            <thead>
              <tr>
                <th scope="col">
                  Tool
                </th>
                <th
                  v-for="l in letters"
                  :key="l"
                  scope="col"
                  class="right"
                >
                  <span :class="`dot dot--${keyOf(l)}`" /> {{ l }}
                </th>
                <th
                  v-if="two"
                  scope="col"
                  class="right"
                >
                  B − A
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in toolRows"
                :key="r.tool"
                :class="{ marked: r.mark }"
                data-test="tool-row"
              >
                <th scope="row">
                  <span class="mono name"><template
                    v-for="(part, pi) in nameParts(r.tool)"
                    :key="pi"
                  >{{ part }}<wbr></template></span>{{ r.mark ? ' ' : '' }}<span
                    v-if="r.mark"
                    class="mark"
                    data-test="tool-mark"
                  >{{ r.mark }}</span>{{ ' ' }}
                </th>
                <td
                  v-for="(v, i) in r.per"
                  :key="i"
                  class="right num"
                >
                  {{ perTrial(v) }}<span
                    v-if="r.errors[i]"
                    class="secondary smaller block nowrap"
                  >{{ plural(r.errors[i], 'error') }}</span>
                </td>
                <td
                  v-if="two"
                  class="right num"
                  :class="{ strong: r.mark }"
                >
                  {{ r.diff }}
                </td>
              </tr>
              <tr v-if="!toolRows.length">
                <td
                  :colspan="letters.length + (two ? 2 : 1)"
                  class="secondary"
                >
                  No tool was called in any finished trial.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-if="errorsAnywhere"
          class="secondary smaller"
        >
          Errors are the calls that returned one, counted under the arm.
        </p>
      </div>

      <div class="part">
        <h3 class="sub">
          Tools the tasks need
        </h3>
        <p class="secondary smaller">
          A task needs a tool when it lists it as required or a required check wants it called. Of the trials of those tasks, how many called it.
        </p>
        <div
          v-if="requiredRows.length"
          class="table-wrap"
        >
          <table
            class="table compact"
            data-test="required-table"
          >
            <thead>
              <tr>
                <th scope="col">
                  Tool
                </th>
                <th
                  v-for="l in letters"
                  :key="l"
                  scope="col"
                  class="right"
                >
                  <span :class="`dot dot--${keyOf(l)}`" /> {{ l }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in requiredRows"
                :key="r.tool"
                :class="{ marked: r.differs }"
                data-test="required-row"
              >
                <th scope="row">
                  <span class="mono name"><template
                    v-for="(part, pi) in nameParts(r.tool)"
                    :key="pi"
                  >{{ part }}<wbr></template></span>
                </th>
                <td
                  v-for="(c, i) in r.cells"
                  :key="i"
                  class="right num"
                >
                  <template v-if="c">
                    {{ c.share }}<span class="secondary smaller block nowrap">{{ c.text }}</span>
                  </template>
                  <template v-else>
                    –
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-else
          class="secondary small"
        >
          No task in this run needs a particular tool.
        </p>
      </div>

      <div class="part">
        <h3 class="sub">
          How trials ended
        </h3>
        <div class="table-wrap">
          <table
            class="table compact"
            data-test="end-table"
          >
            <thead>
              <tr>
                <th scope="col">
                  Ended
                </th>
                <th
                  v-for="l in letters"
                  :key="l"
                  scope="col"
                  class="right"
                >
                  <span :class="`dot dot--${keyOf(l)}`" /> {{ l }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in endRows"
                :key="r.state"
                data-test="end-row"
              >
                <th scope="row">
                  {{ r.name }}
                </th>
                <td
                  v-for="(c, i) in r.cells"
                  :key="i"
                  class="right num"
                >
                  {{ c }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="part">
        <h3 class="sub">
          Why trials failed
        </h3>
        <p class="secondary smaller">
          A trial that failed, or stopped short, has one cause: the first rule below that fits. “Also” counts the trials where it fit after another. Trials with a cause: {{ withCause }}.
        </p>
        <div
          v-if="causeRows.length"
          class="table-wrap"
        >
          <table
            class="table compact"
            data-test="cause-table"
          >
            <thead>
              <tr>
                <th scope="col">
                  Cause
                </th>
                <th
                  v-for="l in letters"
                  :key="l"
                  scope="col"
                  class="right"
                >
                  <span :class="`dot dot--${keyOf(l)}`" /> {{ l }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in causeRows"
                :key="r.kind"
                :class="{ marked: r.grew }"
                data-test="cause-row"
              >
                <th scope="row">
                  {{ r.name }}
                </th>
                <td
                  v-for="(c, i) in r.cells"
                  :key="i"
                  class="right num"
                >
                  {{ c.primary }}<span
                    v-if="c.also"
                    class="secondary smaller block nowrap"
                  >also {{ c.also }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-else
          class="secondary small"
        >
          No trial failed or stopped short.
        </p>
        <details
          class="disclosure rules"
          data-test="cause-rules"
        >
          <summary><span class="summary-text small">How causes are decided</span></summary>
          <ol class="rule-list small">
            <li
              v-for="r in rules"
              :key="r.kind"
            >
              <strong>{{ r.name }}.</strong> {{ r.rule }}
            </li>
          </ol>
          <p class="secondary small">
            Rules over what each trial recorded (its end state, tool calls, check results and your labels), so they cost nothing and give the same cause every time. They point where to look; the trial page is the evidence. Where a harness reports an ending its own way, the reason on the trial says so.
          </p>
        </details>
        <p
          v-if="!labelsDone"
          class="secondary smaller"
          data-test="cause-blind"
        >
          Where the judge and the human labels disagree stays hidden until the held-out outputs are labelled.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.intro {
  max-width: 80ch;
  text-wrap: pretty;
}

.tiles {
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
}

.tile-delta {
  display: block;
  margin-top: 2px;
  font-size: 22px;
  font-weight: 600;
}

.block {
  display: block;
}

.bars {
  margin-top: 12px;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 6px 10px;
}

.rail {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.bar {
  display: block;
  height: 6px;
  border-radius: 3px;
}

.bar--a {
  background: var(--arm-a);
}

.bar--b {
  background: var(--arm-b);
}

.bar-label {
  font-size: 12px;
  color: var(--ink);
}

/* Two columns of tables on a wide screen, one on a phone. */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr));
  gap: 20px 28px;
  align-items: start;
}

.part {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.sub {
  font-size: 15px;
}

/* A tool's name wraps rather than widen the table on a phone. */
.compact .name {
  white-space: normal;
  overflow-wrap: anywhere;
}

.nowrap {
  white-space: nowrap;
}

.compact th,
.compact td {
  padding-top: 8px;
  padding-bottom: 8px;
}

.compact thead th {
  white-space: nowrap;
}

.mark {
  display: inline-block;
  margin-left: 8px;
  font-size: 12px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--rule-strong);
  color: var(--ink);
  white-space: nowrap;
}

.marked > th,
.marked > td {
  background: var(--surface-muted);
}

.strong {
  font-weight: 600;
}

.rule-list {
  margin: 8px 0;
  padding-left: 20px;
  display: grid;
  gap: 4px;
}

.rules p {
  margin-top: 6px;
}
</style>
