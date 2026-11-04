<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, type AnyTrial } from '../api/client';
import { isFixtureMode } from '../api/mode';
import type { BlindItem, ExperimentDetail, ExperimentTrial, Grade, JudgeAgreement, Prompt, TrialResult } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import SpanTimeline from '../components/SpanTimeline.vue';
import { armsOf } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { capitalise, count, money, seconds } from '../lib/format';
import { endStateName, graderName, harnessShort, infraReason, modelName, settingLabel } from '../lib/names';
import { href } from '../router';
import { text, timelineRows, type SpanView } from '../trials';

const props = defineProps<{ trialId: string }>();
const fixtures = isFixtureMode();

interface Loaded {
  any: AnyTrial;
  spans: SpanView[];
  experiment: ExperimentDetail | null;
  siblings: ExperimentTrial[];
  prompts: Prompt[];
  /** Your held-out labels against the judge, to flag a judge verdict you disagree with. */
  judge: JudgeAgreement | null;
  /** Held-out outputs still to label. A failed load counts as none, as on the Judge page, so the
   *  two pages always agree on whether labelling is still blind. */
  queue: BlindItem[];
}

const { data, error, loading } = useLoad<Loaded>(async () => {
  const [any, spans, judge, queue] = await Promise.all([
    api.trial(props.trialId),
    optional(api.trialSpans(props.trialId), [] as SpanView[]),
    optional(api.judgeAgreement('heldout'), null),
    optional(api.labelQueue('heldout'), [] as BlindItem[]),
  ]);
  const experimentId = any.kind === 'experiment' ? any.trial.experiment_id : null;
  const [experiment, siblings, prompts] = experimentId
    ? await Promise.all([optional(api.experiment(experimentId), null), optional(api.experimentTrials(experimentId), [] as ExperimentTrial[]), optional(api.prompts(), [] as Prompt[])])
    : [null, [] as ExperimentTrial[], [] as Prompt[]];
  return { any, spans, experiment, siblings, prompts, judge, queue };
});

const EMPTY_RESULT: TrialResult = {};
/** The folder store's result is the same contract v2 file, typed loosely. */
function recordedResult(result: Record<string, unknown> | null): TrialResult {
  return result ?? EMPTY_RESULT;
}

/** One view of a trial, whichever store it came from. */
const vm = computed(() => {
  const d = data.value;
  if (!d) return null;
  if (d.any.kind === 'experiment') {
    const t = d.any.trial;
    const config = d.experiment?.configs.find((c) => c.hash === t.config);
    const task = d.experiment?.tasks.find((x) => x.sha256 === t.task || x.id === t.task);
    return {
      id: t.id,
      taskId: task?.id ?? t.task,
      harness: config?.harness ?? t.result?.harness?.name ?? null,
      label: t.label,
      status: t.status,
      endState: t.end_state ?? t.result?.end_state ?? null,
      result: t.result ?? EMPTY_RESULT,
      cost: t.usage?.cost_usd ?? null,
      costComplete: t.usage?.complete ?? null,
      inputTokens: t.usage?.input_tokens ?? null,
      outputTokens: t.usage?.output_tokens ?? null,
      wallS: t.timing?.wall_s ?? t.result?.timing?.wall_s ?? null,
      grades: t.grades,
      files: t.files.map((f) => f.path),
      repeatIndex: t.repeat_index,
      attempt: t.attempt,
      config,
      task: t.task,
    };
  }
  const { summary, result } = d.any.detail;
  return {
    id: summary.trialId,
    taskId: summary.taskId ?? 'unknown task',
    harness: summary.harness,
    label: summary.label,
    status: 'done',
    endState: summary.endState,
    result: recordedResult(result),
    cost: summary.proxyCostUsd,
    costComplete: summary.proxyComplete,
    inputTokens: summary.proxyInputTokens,
    outputTokens: summary.proxyOutputTokens,
    wallS: summary.wallS,
    grades: [] as Grade[],
    files: ['result.json', 'trace.jsonl', 'runner-report.json', 'stdout.log', 'stderr.log'],
    repeatIndex: null,
    attempt: 1,
    config: undefined,
    task: summary.taskId ?? '',
  };
});

const isInfra = computed(() => !!vm.value?.label?.startsWith('infra:'));

/** While held-out outputs remain to label, the page never says where your labels and the judge
 *  part ways. */
const labelsDone = computed(() => (data.value?.queue.length ?? 0) === 0);
/** Outputs of this trial's task still in the held-out queue: while any remain, the judge's reasons
 *  for the task (quotes, rationale, highlights) stay hidden, so they cannot steer those labels. */
const queuedForTask = computed(() => {
  const id = vm.value?.taskId;
  return id ? (data.value?.queue ?? []).filter((q) => q.task_id === id).length : 0;
});
const hiddenReasons = computed(() => {
  const n = queuedForTask.value;
  if (!n) return '';
  return `The judge's reasons for this task are hidden while ${n} of its held-out outputs ${n === 1 ? 'is' : 'are'} still to label.`;
});

/** The harness and its pinned version from result.json: "Hermes 6112c2a". Contract v2 gives the
 *  version as a string; an object with a `ref` is read too. */
const harnessRef = computed(() => {
  const v = vm.value;
  const h = v?.result.harness as { name?: unknown; version?: unknown } | undefined;
  const version = h?.version;
  const ref = typeof version === 'string' ? version : version && typeof version === 'object' && typeof (version as { ref?: unknown }).ref === 'string' ? (version as { ref: string }).ref : null;
  if (!ref) return null;
  const name = v?.harness ?? (typeof h?.name === 'string' ? h.name : null);
  return { name: name ? harnessShort(name) : 'Harness', ref: ref.slice(0, 7) };
});

const arm = computed(() => {
  const v = vm.value;
  const e = data.value?.experiment;
  if (!v || !e || !v.config) return null;
  const arms = armsOf(e, e.configs);
  return arms.find((a) => a.hash === v.config?.hash) ?? null;
});

const title = computed(() => {
  const v = vm.value;
  if (!v) return '';
  if (arm.value && v.repeatIndex !== null && data.value?.experiment) {
    return `Arm ${arm.value.key.toUpperCase()}, trial ${v.repeatIndex + 1} of ${data.value.experiment.n}${v.attempt > 1 ? `, attempt ${v.attempt}` : ''}`;
  }
  return `${v.harness ? harnessShort(v.harness) : 'Trial'} on ${v.taskId}`;
});

const outcome = computed(() => {
  const v = vm.value;
  if (!v) return null;
  if (isInfra.value) return { kind: 'infra', text: `Infra failure: ${infraReason(v.label)}, not graded` };
  if (v.grades.length) {
    // The pill says what happened in the trial's own terms: how many checks it failed.
    const n = v.grades.length;
    const failed = v.grades.filter((g) => g.verdict !== 'pass').length;
    if (!failed) return { kind: 'pass', text: n === 1 ? 'Passed its one check' : `Passed all ${n} checks` };
    return { kind: 'fail', text: n === 1 ? 'Failed its one check' : `Failed ${failed} of ${n} checks` };
  }
  if (v.status === 'running' || v.status === 'claimed') return { kind: 'pending', text: 'Running' };
  if (v.status === 'queued') return { kind: 'pending', text: 'Queued' };
  return { kind: 'pending', text: 'Not graded yet' };
});

// Spans give the start-up time and the model calls by role.
const startupS = computed(() => {
  const { rows } = timelineRows(data.value?.spans ?? []);
  const children = rows.filter((r) => r.depth > 0);
  return children.length ? Math.min(...children.map((r) => r.startMs)) / 1000 : null;
});
const calls = computed(() => {
  const rows = timelineRows(data.value?.spans ?? []).rows;
  return { agent: rows.filter((r) => r.role === 'chat').length, client: rows.filter((r) => r.role === 'chat-sim').length };
});

const facts = computed(() => {
  const v = vm.value;
  if (!v) return [];
  const conv = v.result.conversation;
  const detail = v.result.end_detail ?? {};
  const endNote = conv?.ended_by === 'client' ? 'Then the client ended it' : typeof detail.exception_type === 'string' ? text(detail.exception_type) : typeof detail.harness_stop_reason === 'string' ? `Harness said ${detail.harness_stop_reason}` : '';
  const harnessCount = v.result.counts?.model_calls;
  // The simulated client's model shapes the conversation too, so it is named beside the counts.
  const sim = data.value?.experiment?.sim_model;
  const callsNote = [
    harnessCount !== undefined ? `${v.harness ? harnessShort(v.harness) : 'The harness'} counted ${harnessCount}` : '',
    sim ? `client ${modelName(sim)}` : '',
  ].filter(Boolean);
  return [
    { k: 'Ended because', v: endStateName(v.endState), n: endNote },
    { k: 'Counted as', v: isInfra.value ? 'Infra failure' : v.label === 'agent' ? 'Agent outcome' : (v.label ?? 'Not reported'), n: isInfra.value ? infraReason(v.label) : 'Not an infra failure' },
    { k: 'Time', v: seconds(v.wallS), n: startupS.value !== null ? `${startupS.value.toFixed(1)} s of it start-up` : '' },
    { k: 'Cost', v: money(v.cost), n: v.cost === null ? 'Not logged' : v.costComplete === false ? "LiteLLM's log is incomplete" : 'From LiteLLM' },
    {
      k: 'Model calls',
      v: data.value?.spans.length ? `${calls.value.agent} agent, ${calls.value.client} client` : '–',
      n: capitalise(callsNote.join('; ')),
    },
    { k: 'Tokens', v: v.inputTokens !== null && v.outputTokens !== null ? count(v.inputTokens + v.outputTokens) : '–', n: v.inputTokens !== null ? `In ${count(v.inputTokens)}, out ${count(v.outputTokens)}` : '' },
  ];
});

// The conversation, with each agent turn's tool calls placed before its reply.
interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  summary: string;
  at: string;
  title: string;
  args: string;
  result: string;
  error: boolean;
}
interface Segment {
  text: string;
  /** The failed check that quoted this passage: its index in the grades and its name. */
  quote: { index: number; name: string } | null;
}

interface Quote {
  text: string;
  index: number;
  name: string;
}
interface MessageItem {
  kind: 'message';
  id: string;
  who: string;
  client: boolean;
  paragraphs: Segment[][];
  /** Whether any passage in it is highlighted, so the key goes under it. */
  marked: boolean;
}

function pretty(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? null, null, 2);
}

function summarise(args: unknown): string {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return args.slice(0, 60);
    }
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length) return 'No arguments';
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${text(v)}`)
    .join(', ');
}

/** Splits a reply into paragraphs and marks the passages a failed check quoted, each tied to the
 *  check that quoted it. */
function segments(body: string, quotes: Quote[]): Segment[][] {
  return body.split(/\n{2,}/).map((para) => {
    const hits = quotes
      .map((q) => ({ q, at: para.indexOf(q.text) }))
      .filter((h) => h.q.text && h.at >= 0)
      .sort((x, y) => x.at - y.at);
    const out: Segment[] = [];
    let pos = 0;
    for (const h of hits) {
      if (h.at < pos) continue;
      if (h.at > pos) out.push({ text: para.slice(pos, h.at), quote: null });
      out.push({ text: h.q.text, quote: { index: h.q.index, name: h.q.name } });
      pos = h.at + h.q.text.length;
    }
    if (pos < para.length) out.push({ text: para.slice(pos), quote: null });
    return out;
  });
}

const failedQuotes = computed<Quote[]>(() =>
  queuedForTask.value ? [] : (vm.value?.grades ?? []).flatMap((g, index) => (g.verdict === 'fail' ? g.evidence.map((text) => ({ text, index, name: g.name })) : [])),
);

const conversation = computed<(ToolItem | MessageItem)[]>(() => {
  const v = vm.value;
  const d = data.value;
  if (!v || !d) return [];
  const { rows } = timelineRows(d.spans);
  const turns = rows.filter((r) => r.role === 'turn');
  const toolsOf = (turnId: string | null) =>
    rows
      .filter((r) => r.role === 'tool' && (turnId === null || r.span.parentSpanId === turnId))
      .map<ToolItem>((r) => ({
        kind: 'tool',
        id: r.span.spanId,
        name: text(r.span.attributes['gen_ai.tool.name'] ?? r.span.name.replace(/^execute_tool /, '')),
        summary: summarise(r.span.attributes['evals.tool.arguments']),
        at: `at ${(r.startMs / 1000).toFixed(1)} s`,
        title: `Started ${(r.startMs / 1000).toFixed(1)} s in, took ${(r.durationMs / 1000).toFixed(1)} s`,
        args: pretty(r.span.attributes['evals.tool.arguments']),
        result: pretty(r.span.attributes['evals.tool.result']),
        error: r.span.attributes['evals.tool.is_error'] === true || r.span.statusCode === 2,
      }));
  const out: (ToolItem | MessageItem)[] = [];
  let agentIndex = 0;
  const transcript = v.result.conversation?.transcript ?? [];
  transcript.forEach((m, i) => {
    const isAgent = m.role === 'assistant';
    if (isAgent) {
      // Without turn spans, every tool call goes before the first reply.
      const turnId = turns.length ? (turns[agentIndex]?.span.spanId ?? '__none__') : agentIndex === 0 ? null : '__none__';
      out.push(...toolsOf(turnId));
      agentIndex += 1;
    }
    const paragraphs = segments(m.content, isAgent ? failedQuotes.value : []);
    out.push({
      kind: 'message',
      id: `m${i}`,
      who: isAgent ? 'Agent' : m.source === 'client_sim' ? 'Client, simulated' : 'Client',
      client: !isAgent,
      paragraphs,
      marked: paragraphs.some((p) => p.some((x) => x.quote)),
    });
  });
  if (!transcript.length) out.push(...toolsOf(null));
  return out;
});

const ending = computed(() => {
  const v = vm.value;
  if (!v) return '';
  const conv = v.result.conversation;
  const applied = v.result.applied_settings ?? {};
  const parts: string[] = [];
  if (conv?.ended_by === 'client') parts.push('The client ended the conversation after this reply.');
  else if (v.endState === 'step_limit') parts.push('The agent stopped at the step limit.');
  else if (v.endState === 'timeout') parts.push('The trial was stopped at its timeout.');
  const off = (k: string) => applied[k] && (applied[k].value === false || applied[k].value === null);
  if (off('memory') && off('skills')) parts.push('No memory was read or written and no skills were loaded: both are off in this config.');
  else if (applied.memory || applied.skills) {
    const tools = timelineRows(data.value?.spans ?? []).rows.filter((r) => r.role === 'tool').map((r) => text(r.span.attributes['gen_ai.tool.name']));
    const memory = tools.filter((t) => t.includes('memory')).length;
    const skills = tools.filter((t) => t.includes('skill')).length;
    parts.push(`Memory tool calls: ${memory}. Skill tool calls: ${skills}.`);
  }
  return parts.join(' ');
});

const systemPrompt = computed(() => {
  const config = vm.value?.config;
  if (!config) return null;
  const prompt = data.value?.prompts.find((p) => p.sha256 === config.prompt.sha256);
  return { name: `${config.prompt.id} ${config.prompt.version}`, text: prompt?.text ?? null };
});

const applied = computed(() =>
  Object.entries(vm.value?.result.applied_settings ?? {}).map(([k, s]) => {
    const value = s.value === true ? 'On' : s.value === false ? 'Off' : s.value === null || s.value === undefined ? 'Not set' : text(s.value);
    const who = vm.value?.harness ? harnessShort(vm.value.harness) : 'Harness';
    const source =
      s.source === 'config' ? 'Config' : s.source === 'platform_default' ? 'Platform default' : s.source === 'harness_default' ? `${who} default` : s.source === 'unsupported' ? 'Not supported' : s.source;
    // Cache markers change what a call costs and how long it takes, never what the model replies.
    const note = k === 'prompt_cache_markers' ? 'Affects cost and time, not the reply.' : '';
    return { key: k, k: settingLabel(k), v: value, src: s.observed ? `${source}, ${s.observed}` : source, note };
  }),
);

const files = computed(() => {
  const all = vm.value?.files ?? [];
  return { requests: all.filter((f) => f.startsWith('requests/')), other: all.filter((f) => !f.startsWith('requests/') && !f.startsWith('responses/')) };
});
const fileUrl = (path: string) => api.trialFileUrl(props.trialId, path);

const gradeKind = (g: Grade) => (g.kind === 'judge' ? `Judge, rubric ${g.grader_version}` : graderName(g.kind));
const isJudge = (g: Grade) => g.kind === 'judge' || !!g.judge_model;

/** Where your held-out label disagrees with the judge on this trial's check: shown only once the
 *  held-out set is labelled. */
const disputeOf = (g: Grade) => (labelsDone.value ? (data.value?.judge?.disagreements.find((x) => x.trial_id === props.trialId && x.criterion === g.name) ?? null) : null);
const labelWord = (v: string) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : 'Not sure');

/** "Failed on" names each failed check, says which the judge graded, and which you dispute. */
const failedOn = computed(() =>
  (vm.value?.grades ?? [])
    .map((g, index) => ({ g, index }))
    .filter(({ g }) => g.verdict === 'fail')
    .map(({ g, index }) => {
      const dispute = disputeOf(g);
      let note = '';
      if (isJudge(g)) note = dispute ? (dispute.you === 'yes' ? ' (judge; your label passes it)' : ` (judge; your label: ${labelWord(dispute.you).toLowerCase()})`) : ' (judge)';
      return { name: g.name, index, note };
    }),
);

function jumpToGrade(index: number) {
  const el = document.getElementById(`grade-${index}`);
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  el?.focus({ preventScroll: true });
}

// Previous and next failed trial in the same experiment, in task, arm and repeat order.
const failures = computed(() => {
  const d = data.value;
  const e = d?.experiment;
  if (!d || !e) return { prev: null as string | null, next: null as string | null };
  const order = (t: ExperimentTrial) => [e.tasks.findIndex((x) => x.sha256 === t.task), e.config_hashes.indexOf(t.config), t.repeat_index, t.attempt];
  const failed = d.siblings
    .filter((t) => t.passed === false)
    .sort((x, y) => {
      const a = order(x);
      const b = order(y);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    });
  const i = failed.findIndex((t) => t.id === props.trialId);
  if (i === -1) return { prev: failed[failed.length - 1]?.id ?? null, next: failed[0]?.id ?? null };
  return { prev: failed[i - 1]?.id ?? null, next: failed[i + 1]?.id ?? null };
});

// Span detail below the timeline.
const selectedId = ref<string | null>(null);
const selected = computed(() => data.value?.spans.find((s) => s.spanId === selectedId.value) ?? null);
const refs = (span: SpanView) => (['evals.request_ref', 'evals.response_ref'] as const).filter((k) => typeof span.attributes[k] === 'string');
</script>

<template>
  <LoadState
    :loading="loading"
    :error="error"
    :what="`trial ${trialId}`"
  >
    <template v-if="vm && data">
      <div class="head-row">
        <div class="page-head">
          <nav
            aria-label="Breadcrumb"
            class="crumbs"
          >
            <a :href="href.experiments()">Experiments</a> /
            <template v-if="data.experiment">
              <a :href="href.compare(data.experiment.id)">{{ data.experiment.name }}</a> /
            </template>
            <template v-else>
              <a :href="href.recorded()">Recorded runs</a> /
            </template>
            <span class="mono">{{ vm.taskId }}</span>
          </nav>
          <div class="title-row">
            <h1
              tabindex="-1"
              data-test="trial-title"
            >
              {{ title }}
            </h1>
            <span
              v-if="outcome"
              class="pill"
              :class="{ 'pill--pass': outcome.kind === 'pass', 'pill--fail': outcome.kind === 'fail', 'pill--dashed': outcome.kind === 'infra', 'pill--outline': outcome.kind === 'pending' }"
              data-test="trial-outcome"
            >
              <AppIcon
                v-if="outcome.kind !== 'pending'"
                :name="outcome.kind === 'pass' ? 'check' : outcome.kind === 'fail' ? 'cross' : 'plug'"
                :size="14"
              />
              {{ outcome.text }}
            </span>
          </div>
          <p
            v-if="arm || harnessRef"
            class="secondary small arm-line"
            data-test="trial-meta"
          >
            <span
              v-if="arm"
              :class="`dot dot--${arm.key}`"
            /><span><template v-if="arm">{{ arm.label }}, config <span class="mono">{{ arm.hash.replace('sha256:', '').slice(0, 7) }}</span></template><template v-if="arm && harnessRef">, </template><template v-if="harnessRef">{{ harnessRef.name }} <span class="mono">{{ harnessRef.ref }}</span></template></span>
          </p>
          <p
            v-if="outcome?.kind === 'fail' && failedOn.length"
            class="small failed-on"
            data-test="failed-on"
          >
            Failed on:
            <template
              v-for="(f, fi) in failedOn"
              :key="f.index"
            >
              <a
                :href="`#grade-${f.index}`"
                @click.prevent="jumpToGrade(f.index)"
              >{{ f.name }}</a>{{ f.note }}<template v-if="fi < failedOn.length - 1">
                ,
              </template>
            </template>
          </p>
        </div>
        <div
          v-if="data.experiment"
          class="actions"
        >
          <a
            v-if="failures.prev"
            :href="href.trial(failures.prev)"
            class="btn btn--quiet"
          >Previous failure</a>
          <a
            v-if="failures.next"
            :href="href.trial(failures.next)"
            class="btn btn--quiet"
          >Next failure</a>
        </div>
      </div>

      <dl
        class="stat-strip facts"
        data-test="trial-facts"
      >
        <div
          v-for="f in facts"
          :key="f.k"
        >
          <dt class="secondary smaller">
            {{ f.k }}
          </dt>
          <dd class="fact-value num">
            {{ f.v }}
          </dd>
          <dd class="secondary smaller fact-note">
            {{ f.n }}
          </dd>
        </div>
      </dl>

      <div class="split">
        <div class="grow stack story">
          <section
            aria-labelledby="convo"
            class="stack"
          >
            <h2
              id="convo"
              class="section-title"
            >
              What happened
            </h2>

            <details
              v-if="systemPrompt"
              class="disclosure"
            >
              <summary>
                <span class="summary-text">
                  <span class="strong">System prompt</span>
                  <span class="secondary small">{{ systemPrompt.name }}, plus any text {{ vm.harness ? harnessShort(vm.harness) : 'the harness' }} adds itself</span>
                </span>
              </summary>
              <p class="secondary small gap-below">
                What the harness adds is kept as it ships it, and is the same in both arms. The first model request shows the full text.
              </p>
              <pre
                v-if="systemPrompt.text"
                class="code-block prompt-text"
              >{{ systemPrompt.text }}</pre>
            </details>

            <template
              v-for="item in conversation"
              :key="item.id"
            >
              <article
                v-if="item.kind === 'message'"
                class="bubble"
                :class="item.client ? 'bubble--client' : 'bubble--agent'"
                data-test="message"
              >
                <span class="bubble-who">{{ item.who }}</span>
                <p
                  v-for="(para, pi) in item.paragraphs"
                  :key="pi"
                  class="bubble-text"
                >
                  <template
                    v-for="(seg, si) in para"
                    :key="si"
                  >
                    <a
                      v-if="seg.quote"
                      :href="`#grade-${seg.quote.index}`"
                      class="quote-link"
                      data-test="quote-link"
                      @click.prevent="jumpToGrade(seg.quote.index)"
                    ><span class="visually-hidden">Quoted by the judge for {{ seg.quote.name }}: </span><mark>{{ seg.text }}</mark></a>
                    <template v-else>
                      {{ seg.text }}
                    </template>
                  </template>
                </p>
              </article>
              <p
                v-if="item.kind === 'message' && item.marked"
                class="mark-key"
                data-test="mark-key"
              >
                Highlighted: text the judge quoted for a failed check.
              </p>
              <details
                v-else-if="item.kind === 'tool'"
                class="disclosure tool-call"
                data-test="tool-call"
              >
                <summary>
                  <AppIcon
                    name="tool"
                    :size="16"
                    class="tool-icon"
                  />
                  <span class="summary-text">
                    <span class="mono strong">{{ item.name }}</span>
                    <span class="secondary small tool-args">{{ item.summary }}</span>
                    <span
                      v-if="item.error"
                      class="pill pill--fail pill--small"
                    ><AppIcon
                      name="cross"
                      :size="12"
                    />Error</span>
                    <span
                      class="secondary smaller num at"
                      :title="item.title"
                    >{{ item.at }}</span>
                  </span>
                </summary>
                <div class="tool-body">
                  <div>
                    <span class="secondary smaller block">Arguments</span>
                    <pre class="code-block">{{ item.args }}</pre>
                  </div>
                  <div>
                    <span class="secondary smaller block">Result</span>
                    <pre class="code-block">{{ item.result }}</pre>
                  </div>
                </div>
              </details>
            </template>
            <p
              v-if="!conversation.length"
              class="secondary"
            >
              No conversation was recorded{{ isInfra ? ': the trial stopped before the agent replied' : '' }}.
            </p>

            <p
              v-if="ending"
              class="secondary small ending"
            >
              {{ ending }}
            </p>
          </section>

          <section
            aria-labelledby="timeline"
            class="stack"
          >
            <h2
              id="timeline"
              class="section-title"
            >
              Timeline
            </h2>
            <SpanTimeline
              :spans="data.spans"
              :selected="selectedId"
              :harness="vm.harness ?? undefined"
              @select="selectedId = selectedId === $event ? null : $event"
            />
            <div
              v-if="selected"
              class="panel panel--pad span-detail"
              data-test="span-detail"
            >
              <h3 class="span-title mono">
                {{ selected.name }}
              </h3>
              <p
                v-if="selected.statusMessage"
                class="secondary"
              >
                {{ selected.statusMessage }}
              </p>
              <p
                v-if="refs(selected).length && !fixtures"
                class="small"
              >
                <a
                  v-for="k in refs(selected)"
                  :key="k"
                  :href="fileUrl(text(selected.attributes[k]))"
                  target="_blank"
                  rel="noopener"
                  class="ref-link"
                >{{ k === 'evals.request_ref' ? 'Request body' : 'Response body' }}</a>
              </p>
              <div class="table-scroll">
                <table class="table attrs">
                  <tbody>
                    <tr
                      v-for="(v, k) in selected.attributes"
                      :key="k"
                    >
                      <th
                        scope="row"
                        class="mono"
                      >
                        {{ k }}
                      </th>
                      <td class="value-cell mono">
                        {{ text(v) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        <aside
          aria-labelledby="graders"
          class="stack grading"
        >
          <h2
            id="graders"
            class="section-title"
          >
            How it was graded
          </h2>
          <div
            v-for="(g, gi) in vm.grades"
            :id="`grade-${gi}`"
            :key="`${g.grader_id}-${g.run_index}`"
            class="grade"
            tabindex="-1"
            data-test="grade"
          >
            <div class="grade-head">
              <span class="strong">{{ g.name }}</span>
              <span
                class="pill pill--small"
                :class="g.verdict === 'pass' ? 'pill--pass' : 'pill--fail'"
              ><AppIcon
                :name="g.verdict === 'pass' ? 'check' : 'cross'"
                :size="12"
              />{{ g.verdict === 'pass' ? 'Pass' : 'Fail' }}</span>
            </div>
            <span
              class="secondary smaller"
              data-test="grade-kind"
            ><template v-if="g.judge_model">Judge <span class="mono">{{ g.judge_model }}</span>, rubric {{ g.grader_version }}</template><template v-else>{{ gradeKind(g) }}</template></span>
            <p
              v-if="isJudge(g) && hiddenReasons"
              class="small hidden-reasons"
              data-test="hidden-reasons"
            >
              {{ hiddenReasons }}
            </p>
            <template v-else>
              <blockquote
                v-for="(q, qi) in g.evidence"
                :key="qi"
                class="quote small"
              >
                “{{ q }}”
              </blockquote>
              <p
                v-if="g.rationale"
                class="small"
              >
                {{ g.rationale }}
              </p>
            </template>
            <p
              v-if="disputeOf(g)"
              class="small dispute"
              data-test="dispute"
            >
              Your held-out label: {{ labelWord(disputeOf(g)?.you ?? 'unsure') }}. You and the judge disagree on this check.
              <a :href="href.judge()">See judge agreement</a>
            </p>
          </div>
          <p
            v-if="!vm.grades.length"
            class="secondary small"
          >
            {{ isInfra ? 'Infra failures are not graded: they say nothing about the agent.' : 'No grades yet. Grading runs as its own step after the trial.' }}
          </p>
          <p
            v-else
            class="secondary smaller"
          >
            A task passes only when every check passes. The judge never sees the harness, the model or the arm.
          </p>
        </aside>

        <section
          aria-labelledby="applied-title"
          class="stack applied"
          data-test="applied"
        >
          <h2
            id="applied-title"
            class="section-title"
          >
            Settings as applied
          </h2>
          <table
            v-if="applied.length"
            class="table applied-table"
          >
            <tbody>
              <tr
                v-for="s in applied"
                :key="s.k"
              >
                <th scope="row">
                  {{ s.k }}
                </th>
                <td class="num">
                  {{ s.v }}
                </td>
                <td
                  class="secondary"
                  :data-test="`applied-source-${s.key}`"
                >
                  {{ s.src }}
                  <span
                    v-if="s.note"
                    class="block setting-note"
                  >{{ s.note }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p
            v-else
            class="secondary small"
          >
            The result does not list applied settings.
          </p>
          <h3
            class="sub-title"
            data-test="files-title"
          >
            Files
          </h3>
          <div
            class="files small"
            data-test="trial-files"
          >
            <template v-if="!fixtures">
              <a
                v-for="f in files.other"
                :key="f"
                :href="fileUrl(f)"
                class="mono"
                target="_blank"
                rel="noopener"
              >{{ f }}</a>
            </template>
            <span
              v-for="f in fixtures ? files.other : []"
              :key="f"
              class="mono secondary"
            >{{ f }}</span>
            <details
              v-if="files.requests.length"
              class="requests"
            >
              <summary><span class="summary-text">Model requests ({{ files.requests.length }})</span></summary>
              <ul>
                <li
                  v-for="f in files.requests"
                  :key="f"
                >
                  <a
                    v-if="!fixtures"
                    :href="fileUrl(f)"
                    class="mono"
                    target="_blank"
                    rel="noopener"
                  >{{ f }}</a>
                  <span
                    v-else
                    class="mono secondary"
                  >{{ f }}</span>
                </li>
              </ul>
            </details>
            <p
              v-if="fixtures"
              class="secondary smaller"
            >
              Files open from the API; sample data has none to open.
            </p>
          </div>
        </section>
      </div>
    </template>
  </LoadState>
</template>

<style scoped>
/* The story on the left; on the right the grading, then the settings and files under it. A
   phone reads grading, story, then settings: why it failed, what happened, how it was set up. */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  grid-template-areas:
    'story grading'
    'story applied';
  grid-template-rows: auto 1fr;
  column-gap: 28px;
  row-gap: 24px;
  align-items: start;
}

.story {
  grid-area: story;
  min-width: 0;
}

.grading {
  grid-area: grading;
  min-width: 0;
}

.applied {
  grid-area: applied;
  align-self: start;
  min-width: 0;
}

.title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  margin-top: 8px;
}

.title-row h1 {
  margin-top: 0;
  font-size: 30px;
}

.arm-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.failed-on {
  margin-top: 6px;
}

.story {
  gap: 28px;
}

.grade:focus-visible {
  outline-offset: 2px;
}

.dispute {
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--rule-soft);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.facts {
  margin: 0;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
}

.facts > div {
  padding: 14px 18px;
}

.fact-value {
  margin: 2px 0 0;
  font-weight: 500;
}

.fact-note {
  margin: 0;
}

.strong {
  font-weight: 500;
}

.block {
  display: block;
}

.gap-below {
  margin-bottom: 12px;
}

.prompt-text {
  max-height: 320px;
  overflow: auto;
  margin-bottom: 16px;
  font-size: 12px;
}

.tool-icon {
  flex: none;
  align-self: flex-start;
  margin-top: 16px;
  color: var(--ink-2);
}

/* The time sits at the right of the text, before the chevron; only the text wraps. */
.at {
  margin-left: auto;
}

/* A quoted passage is a link to the check that quoted it, styled as the highlight alone. */
.quote-link {
  color: inherit;
  text-decoration: none;
}

.quote-link:hover mark {
  box-shadow: inset 0 -2px 0 var(--rule-strong);
}

.mark-key {
  margin-top: -6px;
  margin-left: auto;
  font-size: 12px;
  color: var(--ink-2);
}

.tool-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  padding-bottom: 16px;
}

.tool-body .block {
  margin-bottom: 4px;
}

.ending {
  padding: 10px 0;
  border-top: 1px solid var(--track);
}

.grade {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.grade-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.quote {
  margin: 4px 0 0;
  padding: 8px 12px;
  background: var(--ground);
  border-radius: 6px;
}

/* While the task's held-out outputs are still to label, this one line stands in for the judge's
   quotes and rationale. */
.hidden-reasons {
  color: var(--ink-2);
}

.applied-table {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 10px;
  border-collapse: separate;
  border-spacing: 0;
}

.applied-table th,
.applied-table td {
  padding: 8px 14px;
}

.setting-note {
  margin-top: 2px;
  font-size: 13px;
  color: var(--ink-2);
}

.sub-title {
  font-size: 15px;
  margin-top: 8px;
}

.applied-table tr > :first-child {
  padding-left: 14px;
}

.applied-table tr > :last-child {
  padding-right: 14px;
}

.files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  align-items: baseline;
}

.files a,
.requests > summary {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
}

/* A disclosure, not a link: ink, medium weight, and the chevron from theme.css. */
.requests > summary {
  cursor: pointer;
  gap: 8px;
  color: var(--ink);
  font-weight: 500;
  text-decoration: none;
}

.requests {
  flex-basis: 100%;
}

.requests ul {
  margin: 0;
  padding-left: 18px;
}

.span-title {
  font-size: 15px;
  margin-bottom: 8px;
}

.ref-link {
  margin-right: 16px;
}

.table-scroll {
  overflow-x: auto;
}

.attrs th {
  white-space: nowrap;
  font-size: 12px;
}

.value-cell {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

@media (max-width: 640px) {
  .title-row h1 {
    font-size: 24px;
  }

  /* On a phone the grading comes first: it says why the trial failed before the transcript. The
     settings and files come last. */
  .split {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'grading'
      'story'
      'applied';
    grid-template-rows: auto;
    row-gap: 28px;
  }

  /* A tool row on a phone: its name and time on the first line, its arguments under them. */
  .tool-args {
    order: 1;
    flex-basis: 100%;
  }
}
</style>
