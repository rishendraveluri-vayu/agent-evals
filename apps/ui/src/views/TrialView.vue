<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, bareToolName, type AnyTrial } from '../api/client';
import { ApiError } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { ExperimentDetail, TrialRowSummary, JudgeCriterionTrust, JudgeTrust, JudgeTrustStatus, PromptView, TrialResult, VersionRef } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import NotFound from '../components/NotFound.vue';
import ReplyPieces from '../components/ReplyPieces.vue';
import SpanTimeline from '../components/SpanTimeline.vue';
import TrustBadge from '../components/TrustBadge.vue';
import { armIndexOf, armLetter, armsOf, namedByHash } from '../lib/arms';
import { amountHits, failureQuotes, gradeView, outcomeOf, provenanceOf, unsourcedFigures, type AmountCheck, type FailureQuote, type FigureView, type GradeView, type ProvenanceView } from '../lib/grading';
import { optional, useLoad } from '../lib/async';
import { causeView, sentence } from '../lib/causes';
import { capitalise, count, harnessVersion, money, plainText, seconds, shortVersion } from '../lib/format';
import { findQuote, messageBlocks, piecesOf, quoteText, stylesOf, type Align, type Mark, type Piece, type QuoteMark, type Span } from '../lib/trialMarkdown';
import { endStateName, experimentName, graderName, harnessName, harnessShort, infraReason, modelName, settingLabel } from '../lib/names';
import { isModelCallFile, jsonForDisplay, modelCalls, reasonParts, shortReason } from '../lib/trialDisplay';
import { judgeFor, rubricName, rubricOf, trustLabel } from '../lib/trust';
import { href } from '../router';
import { text, timelineRows, type SpanView } from '../trials';

const props = defineProps<{ trialId: string }>();
const fixtures = isFixtureMode();

interface Loaded {
  any: AnyTrial;
  spans: SpanView[];
  experiment: ExperimentDetail | null;
  siblings: TrialRowSummary[];
  prompts: PromptView[];
  /** The number-provenance check from the trial's checks.json, when it has one. */
  checks: ProvenanceView | null;
  /** How far to trust the judges of this trial's experiment (D83), with where each disagrees with
   *  the human labels; null when unknown. */
  trust: JudgeTrust[] | null;
}

/** The address names a trial that does not exist (a mistyped or stale link). */
const missing = ref(false);
async function trialOrMissing(id: string): Promise<AnyTrial> {
  try {
    return await api.trial(id);
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'unknown_trial' || err.status === 404)) missing.value = true;
    throw err;
  }
}

const { data, error, loading } = useLoad<Loaded>(async () => {
  const [any, spans] = await Promise.all([trialOrMissing(props.trialId), optional(api.trialSpans(props.trialId), [] as SpanView[])]);
  const experimentId = any.kind === 'experiment' ? any.trial.experiment_id : null;
  const hasChecks = any.kind === 'experiment' && any.trial.files.some((f) => f.path === 'checks.json');
  const hasJudge = any.kind === 'experiment' && any.trial.grades.some((g) => g.kind === 'judge' || !!g.judge_model);
  const [experiment, siblings, prompts, checks, trust] = await Promise.all([
    experimentId ? optional(api.experiment(experimentId), null) : Promise.resolve(null),
    experimentId ? optional(api.experimentTrials(experimentId), [] as TrialRowSummary[]) : Promise.resolve([] as TrialRowSummary[]),
    any.kind === 'experiment' ? optional(api.prompts(), [] as PromptView[]) : Promise.resolve([] as PromptView[]),
    hasChecks ? optional(api.trialJson(props.trialId, 'checks.json').then(provenanceOf), null) : Promise.resolve(null),
    experimentId && hasJudge ? optional(api.judgeTrust(experimentId).then((r) => r.judges), null) : Promise.resolve(null),
  ]);
  return { any, spans, experiment, siblings, prompts, checks, trust };
});

const EMPTY_RESULT: TrialResult = {};
/** result.json is contract v2's result, which the API carries as loose JSON. */
function resultOf(result: unknown): TrialResult {
  return typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as TrialResult) : EMPTY_RESULT;
}

/** One view of a trial, whichever store it came from. */
const vm = computed(() => {
  const d = data.value;
  if (!d) return null;
  if (d.any.kind === 'experiment') {
    const t = d.any.trial;
    const result = resultOf(t.result);
    return {
      id: t.id,
      probe: t.probe,
      taskId: t.task.id,
      harness: t.config.harness,
      configName: t.config.name,
      label: t.label,
      status: t.status,
      endState: t.end_state ?? result.end_state ?? null,
      result,
      cost: t.usage?.cost_usd ?? null,
      simCost: t.usage?.sim_cost_usd ?? null,
      costComplete: t.usage?.complete ?? null,
      inputTokens: t.usage?.input_tokens ?? null,
      outputTokens: t.usage?.output_tokens ?? null,
      wallS: t.timing.wall_s ?? result.timing?.wall_s ?? null,
      grades: t.grades.map(gradeView),
      /** A regrade on its way (SP4), if any. */
      gradingPending: t.grading?.pending ?? null,
      files: t.files.map((f) => f.path),
      badFiles: t.files.filter((f) => f.ok === false).map((f) => `${f.path}${f.problem ? `: ${f.problem}` : ''}`),
      problems: t.problems,
      repeatIndex: t.repeat_index,
      attempt: t.attempt,
      configHash: t.config.hash,
      prompt: t.config.prompt,
      task: t.task.sha256,
    };
  }
  const { summary } = d.any.detail;
  const result = resultOf(d.any.detail.result);
  return {
    id: summary.trialId,
    probe: false,
    taskId: summary.taskId ?? 'unknown task',
    harness: summary.harness,
    configName: null as string | null,
    label: summary.label,
    status: 'done',
    endState: summary.endState,
    result,
    cost: summary.proxyCostUsd,
    simCost: null as number | null,
    costComplete: summary.proxyComplete,
    inputTokens: summary.proxyInputTokens,
    outputTokens: summary.proxyOutputTokens,
    wallS: summary.wallS,
    grades: [] as GradeView[],
    gradingPending: null,
    files: ['result.json', 'trace.jsonl', 'runner-report.json', 'stdout.log', 'stderr.log'],
    badFiles: [] as string[],
    problems: [] as string[],
    repeatIndex: null,
    attempt: 1,
    configHash: summary.configHash,
    prompt: null as VersionRef | null,
    task: summary.taskId ?? '',
  };
});

/** An infra stop: a runner label of infra:..., or an attempt stopped by the engine itself, which
 *  has no label (abandoned: its worker stopped sending heartbeats). Neither says anything about
 *  the agent, and neither is graded. */
const isInfra = computed(() => !!vm.value?.label?.startsWith('infra:') || vm.value?.status === 'abandoned' || vm.value?.status === 'infra_failed');
/** Why the attempt stopped on infra, in words. */
const infraWhy = computed(() => {
  const v = vm.value;
  if (!v) return '';
  return infraReason(v.label) || (v.status === 'abandoned' ? 'its worker stopped sending heartbeats' : 'stopped before it reported');
});
/** Whether an infra-stopped attempt was run again: the same task, config and repeat, one attempt
 *  on. With none, a run still going may yet re-run it; a finished one did not. */
const rerun = computed(() => {
  const v = vm.value;
  const d = data.value;
  if (!v || !d || !isInfra.value || v.repeatIndex === null) return '';
  const next = d.siblings.find((t) => t.task_sha256 === v.task && t.config_hash === v.configHash && t.repeat_index === v.repeatIndex && t.attempt === v.attempt + 1);
  if (!next) {
    const status = d.experiment?.status;
    if (!status) return '';
    return status === 'running' || status === 'paused' || status === 'created' ? 'not re-run yet' : 'not re-run';
  }
  const as = `re-run as attempt ${next.attempt}`;
  if (next.status === 'queued' || next.status === 'claimed') return `${as}, not started yet`;
  if (next.status === 'running') return `${as}, running now`;
  if (next.status === 'infra_failed' || next.status === 'abandoned') return `${as}, also an infra failure`;
  if (next.status === 'cancelled') return `${as}, cancelled`;
  if (next.passed === true) return `${as}, which passed`;
  if (next.passed === false) return `${as}, which failed`;
  return `${as}, not graded yet`;
});

/** D64: why a failed trial failed, or why it stopped short, by the API's rules; null otherwise.
 *  Each reason in its short form: a check's patterns are in its grade card, never cut here. */
const cause = computed(() => {
  const d = data.value;
  if (!d || d.any.kind !== 'experiment') return null;
  const c = causeView(d.any.trial.cause);
  if (!c) return null;
  const contributing = c.contributing.map((x) => ({ ...x, reason: sentence(shortReason(x.reason)) }));
  return { ...c, contributing, lead: outcome.value?.kind === 'fail' ? 'Why it failed' : 'Why it stopped short', reason: sentence(shortReason(c.reason)) };
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
  // A pinned SHA to 7 characters; a version with its libraries in brackets to the version alone.
  return { name: name ? harnessShort(name) : 'Harness', ref: harnessVersion(ref), full: ref };
});

/** Workers send their adapter code's hash with each claim since 7 Nov (D85). */
const ADAPTER_HASH_SINCE = Date.parse('2026-11-07T00:00:00Z');

/** What pins the code an experiment trial ran, beside its config: the adapter code's hash, which its
 *  worker sent with the claim (D85), and the platform commit its experiment recorded (G2). Each is
 *  short, with the full value in a title. An attempt not claimed yet has no adapter code to show,
 *  and a probe no experiment, so no platform commit. A missing hash is put down to the date only
 *  when the attempt was claimed before workers sent one; a later one's worker did not send it. */
interface CodePart {
  key: 'adapter-code' | 'platform-commit';
  label: string;
  short: string | null;
  full: string | null;
  missing: string;
}
const codeParts = computed<CodePart[]>(() => {
  const d = data.value;
  if (!d || d.any.kind !== 'experiment') return [];
  const t = d.any.trial;
  const parts: CodePart[] = [];
  if (t.timing.claimed_at) {
    const sha = t.adapter_sha256;
    const early = Date.parse(t.timing.claimed_at) < ADAPTER_HASH_SINCE;
    const missing = early ? 'not recorded (trials before 7 Nov)' : 'not sent by its worker';
    parts.push({ key: 'adapter-code', label: 'adapter code', short: sha ? sha.replace('sha256:', '').slice(0, 7) : null, full: sha, missing });
  }
  if (d.experiment) {
    const commit = d.experiment.platform_commit;
    parts.push({ key: 'platform-commit', label: 'platform commit', short: commit ? commit.slice(0, 7) : null, full: commit, missing: 'not recorded' });
  }
  return parts;
});

const arm = computed(() => {
  const v = vm.value;
  const e = data.value?.experiment;
  if (!v || !e || !v.configHash) return null;
  const arms = armsOf(e, e.configs);
  return arms.find((a) => a.hash === v.configHash) ?? null;
});

/** The arm is named by its harness (a harness experiment), so the subtitle gives the harness once,
 *  with its pinned version: "Own loop 0.1.0, config 90a6761", not "Own loop, config 90a6761, Own
 *  loop 0.1.0". */
const armIsHarness = computed(() => !!arm.value?.config && arm.value.label === harnessName(arm.value.config.harness));

/** A shipped example: read-only, never judged or regraded here, so its grades point nowhere else. */
const isExample = computed(() => !!data.value?.experiment?.example);

const title = computed(() => {
  const v = vm.value;
  if (!v) return '';
  if (arm.value && v.repeatIndex !== null && data.value?.experiment) {
    return `Arm ${arm.value.key.toUpperCase()}, trial ${v.repeatIndex + 1} of ${data.value.experiment.n}${v.attempt > 1 ? `, attempt ${v.attempt}` : ''}`;
  }
  if (v.probe) return `Prompt probe for ${v.configName ?? 'a config'}`;
  return `${v.harness ? harnessShort(v.harness) : 'Trial'} on ${v.taskId}`;
});

const outcome = computed(() => {
  const v = vm.value;
  if (!v) return null;
  if (isInfra.value) return { kind: 'infra', text: `Infra failure: ${infraWhy.value}, not graded` };
  if (v.probe) return { kind: 'pending', text: 'Probe: never graded or counted' };
  // The pill says what happened in the trial's own terms: how many required checks it failed, or
  // how many could not decide (an error, not applicable, the unbuilt judge), so nothing counts as a
  // pass or a fail by default. It names them required checks: the grades list the optional ones
  // too, each tagged as not counted.
  const o = outcomeOf(v.grades);
  if (o) {
    const n = o.required;
    if (o.kind === 'pass') return { kind: 'pass', text: n === 1 ? 'Passed its one required check' : `Passed all ${n} required checks` };
    if (o.kind === 'fail') return { kind: 'fail', text: n === 1 ? 'Failed its one required check' : `Failed ${o.failed} of ${n} required checks` };
    return { kind: 'pending', text: o.required ? `Incomplete: ${o.undetermined} of ${n} required checks undecided` : 'Incomplete: no required check' };
  }
  if (v.status === 'running' || v.status === 'claimed') return { kind: 'pending', text: 'Running' };
  if (v.status === 'queued') return { kind: 'pending', text: 'Queued' };
  if (v.gradingPending) return { kind: 'pending', text: 'Grading queued' };
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
    { k: 'Counted as', v: isInfra.value ? 'Infra failure' : v.label === 'agent' ? 'Agent outcome' : (v.label ?? 'Not reported'), n: isInfra.value ? capitalise([infraWhy.value, rerun.value].filter(Boolean).join('; ')) : 'Not an infra failure' },
    { k: 'Time', v: seconds(v.wallS), n: startupS.value !== null ? `${startupS.value.toFixed(1)} s of it start-up` : '' },
    {
      k: 'Cost',
      v: money(v.cost),
      n: v.probe
        ? 'Made-up money: a probe runs on the fake model'
        : v.cost === null
          ? 'Not logged'
          : v.costComplete === false
            ? "LiteLLM's log is incomplete"
            : `From LiteLLM${v.simCost ? `; the client's calls ${money(v.simCost)} more` : ''}`,
    },
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
/** A block of a message as shown (lib/trialMarkdown.ts): a paragraph, a rule, or a table, each
 *  paragraph and cell as its pieces. */
type ShownBlock = { kind: 'para'; pieces: Piece[] } | { kind: 'rule' } | { kind: 'table'; head: Piece[][]; rows: Piece[][][]; align: Align[] };

interface MessageItem {
  kind: 'message';
  id: string;
  who: string;
  client: boolean;
  blocks: ShownBlock[];
  /** Who quoted the passages highlighted in it, for the key under it; empty when none is. */
  quotedBy: string[];
  /** Whether it shows an amount the sourcing check found no source for. */
  amounts: boolean;
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

/** A message in blocks, with the passages quoted as evidence of a failure marked, each tied to the
 *  check that quoted it and named by who quoted it, and the amounts the sourcing check could not
 *  trace to a source. Each quote is placed once, where it first occurs, and one that overlaps a
 *  quote already placed is left out; an amount inside a quote is marked as both. With `markdown`
 *  (an agent's reply), its tables, rules and inline styles show; each paragraph's and cell's
 *  styles are worked out on the whole of it, so a highlight inside bold text stays bold. */
function shownBlocks(body: string, quotes: FailureQuote[], amounts: AmountCheck[], markdown: boolean): ShownBlock[] {
  const placed: Mark<QuoteMark>[] = [];
  for (const q of quotes) {
    const hit = findQuote(body, q.text);
    if (!hit || placed.some((p) => hit.start < p.end && p.start < hit.end)) continue;
    placed.push({ ...hit, value: { index: q.index, by: q.by } });
  }
  const amountMarks = amountHits(body, amounts);
  const started = new Set<object>();
  const pieces = (span: Span) => piecesOf(body, span, markdown ? stylesOf(body, span) : null, placed, amountMarks, started);
  return messageBlocks(body, markdown).map((b): ShownBlock => {
    if (b.kind === 'para') return { kind: 'para', pieces: pieces(b) };
    if (b.kind === 'rule') return b;
    return { kind: 'table', head: b.head.map(pieces), rows: b.rows.map((r) => r.map(pieces)), align: b.align };
  });
}

/** Every piece of a message's blocks, to ask what it shows. */
const piecesIn = (blocks: ShownBlock[]): Piece[] => blocks.flatMap((b) => (b.kind === 'para' ? b.pieces : b.kind === 'table' ? [...b.head, ...b.rows.flat()].flat() : []));

/** What to highlight in the replies as evidence of a failure (lib/grading.ts failureQuotes). */
const failedQuotes = computed(() => failureQuotes(vm.value?.grades ?? []));
/** The amounts with no source: the runner's checks.json lists them; without it, the ones a failed
 *  sourcing check names. An amount the check verified by recomputing it is never among them. */
const unsupportedAmounts = computed(() => data.value?.checks?.unsupported ?? unsourcedFigures(vm.value?.grades ?? []));

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
        // The tool as the server names it; a harness's prefix (Hermes: mcp__finance__) is in the timeline and the request files.
        name: bareToolName(text(r.span.attributes['gen_ai.tool.name'] ?? r.span.name.replace(/^execute_tool /, ''))),
        summary: summarise(r.span.attributes['evals.tool.arguments']),
        at: `at ${(r.startMs / 1000).toFixed(1)} s`,
        title: `Started ${(r.startMs / 1000).toFixed(1)} s in, took ${(r.durationMs / 1000).toFixed(1)} s`,
        args: jsonForDisplay(r.span.attributes['evals.tool.arguments']),
        result: jsonForDisplay(r.span.attributes['evals.tool.result']),
        error: r.span.attributes['evals.tool.is_error'] === true || r.span.statusCode === 2,
      }));
  const out: (ToolItem | MessageItem)[] = [];
  let agentIndex = 0;
  const transcript = v.result.conversation?.transcript ?? [];
  const lastReply = transcript.map((m) => m.role).lastIndexOf('assistant');
  // A quote goes in the message its evidence names, the last reply for the final answer, and
  // any reply when the evidence does not say.
  const quotesFor = (i: number) => failedQuotes.value.filter((q) => (q.at !== null ? q.at === i : q.final ? i === lastReply : true));
  transcript.forEach((m, i) => {
    const isAgent = m.role === 'assistant';
    if (isAgent) {
      // Without turn spans, every tool call goes before the first reply.
      const turnId = turns.length ? (turns[agentIndex]?.span.spanId ?? '__none__') : agentIndex === 0 ? null : '__none__';
      out.push(...toolsOf(turnId));
      agentIndex += 1;
    }
    const blocks = shownBlocks(m.content, isAgent ? quotesFor(i) : [], isAgent ? unsupportedAmounts.value : [], isAgent);
    const shown = piecesIn(blocks);
    out.push({
      kind: 'message',
      id: `m${i}`,
      who: isAgent ? 'Agent' : m.source === 'client_sim' ? 'Client, simulated' : 'Client',
      client: !isAgent,
      blocks,
      quotedBy: [...new Set(shown.flatMap((x) => (x.quote ? [x.quote.by] : [])))],
      amounts: shown.some((x) => x.amount),
    });
  });
  if (!transcript.length) out.push(...toolsOf(null));
  return out;
});

/** Contract v2's memory and skill span events (brief item 6), in time order, in words. Hermes
 *  records them from its own memory, skill_view and skill_manage calls; a harness without memory
 *  or skills records none. */
const memorySkills = computed(() => {
  const out: { key: string; kind: 'memory' | 'skill'; title: string; detail: string }[] = [];
  const events = (data.value?.spans ?? []).flatMap((s) => s.events.map((e, i) => ({ e, key: `${s.spanId}:${i}` })));
  events.sort((x, y) => (BigInt(x.e.timeNs) < BigInt(y.e.timeNs) ? -1 : BigInt(x.e.timeNs) > BigInt(y.e.timeNs) ? 1 : 0));
  for (const { e, key } of events) {
    const a = (k: string) => text(e.attributes[k] ?? '');
    const profile = a('evals.memory.target') === 'user' ? ' (user profile)' : '';
    if (e.name === 'evals.memory.read') {
      const n = Number(a('evals.memory.entries')) || 0;
      out.push({ key, kind: 'memory', title: `Memory read into the prompt at the start${profile}: ${n} ${n === 1 ? 'entry' : 'entries'}`, detail: a('evals.memory.content') });
    } else if (e.name === 'evals.memory.write') {
      out.push({ key, kind: 'memory', title: `Memory written${profile}: ${a('evals.memory.action') || 'change'}`, detail: a('evals.memory.content') });
    } else if (e.name === 'evals.skill.load') {
      const file = a('evals.skill.file');
      out.push({ key, kind: 'skill', title: `Skill loaded: ${a('evals.skill.name')}${file ? `, file ${file}` : ''}`, detail: '' });
    } else if (e.name === 'evals.skill.write') {
      out.push({ key, kind: 'skill', title: `Skill written: ${a('evals.skill.name')} (${a('evals.skill.action') || 'change'})`, detail: '' });
    }
  }
  return out;
});

/** Memory or skills on in this trial's applied settings. */
const memoryOrSkillsOn = computed(() => {
  const applied = vm.value?.result.applied_settings ?? {};
  const on = (k: string) => !!applied[k] && toggleOf(applied[k].value) === true;
  return on('memory') || on('skills');
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
  const off = (k: string) => applied[k] && (applied[k].value === false || applied[k].value === null || toggleOf(applied[k].value) === false);
  if (off('memory') && off('skills')) parts.push('No memory was read or written and no skills were loaded: both are off in this config.');
  else if (applied.memory || applied.skills) {
    const n = (kind: 'memory' | 'skill') => memorySkills.value.filter((x) => x.kind === kind).length;
    parts.push(`Memory events: ${n('memory')}. Skill events: ${n('skill')}. They are listed under Memory and skills.`);
  }
  return parts.join(' ');
});

const systemPrompt = computed(() => {
  const ref = vm.value?.prompt;
  if (!ref) return null;
  const prompt = data.value?.prompts.find((p) => p.sha256 === ref.sha256);
  return { name: `${ref.id} ${ref.version}`, text: prompt?.text ?? null };
});

/** A memory, skills or compression setting is `{enabled}`; anything else is not a toggle. */
function toggleOf(value: unknown): boolean | null {
  return typeof value === 'object' && value !== null && typeof (value as { enabled?: unknown }).enabled === 'boolean' ? (value as { enabled: boolean }).enabled : null;
}

const applied = computed(() =>
  Object.entries(vm.value?.result.applied_settings ?? {}).map(([k, s]) => {
    const toggle = toggleOf(s.value);
    const value =
      s.value === true || toggle === true
        ? 'On'
        : s.value === false || toggle === false
          ? 'Off'
          : s.value === null || s.value === undefined
            ? 'Not sent'
            : k === 'timeout_s' && typeof s.value === 'number'
              ? `${s.value} s`
              : text(s.value);
    const who = vm.value?.harness ? harnessShort(vm.value.harness) : 'Harness';
    const source =
      s.source === 'config' ? 'Config' : s.source === 'platform_default' ? 'Platform default' : s.source === 'harness_default' ? `${who} default` : s.source === 'unsupported' ? 'Not supported' : s.source;
    // Cache markers change what a call costs and how long it takes, never what the model replies.
    const note = k === 'prompt_cache_markers' ? 'Affects cost and time, not the reply.' : '';
    // What the adapter observed comes from result.json, which may carry the authors' references.
    const observed = s.observed ? plainText(s.observed) : '';
    return { key: k, k: settingLabel(k), v: value, src: observed ? `${source}, ${observed}` : source, note };
  }),
);

const files = computed(() => {
  const all = vm.value?.files ?? [];
  // Model requests and responses: requests/ in older runs, artifacts/proxy/ since the API stores
  // them. One row per call, counted by its requests, never its request and response files.
  const calls = modelCalls(all);
  return { calls, requests: calls.filter((c) => c.request).length, other: all.filter((f) => !isModelCallFile(f)) };
});
const fileUrl = (path: string) => api.trialFileUrl(props.trialId, path);

const gradeKind = (g: GradeView) => {
  if (g.kind === 'judge') {
    const rubric = rubricLabel(g);
    return `Judge${rubric ? `, rubric ${rubric}` : ''}, grader version ${shortVersion(g.graderVersion)}`;
  }
  const type = g.type && g.type !== g.kind ? `, ${g.type.replace(/_/g, ' ')}` : '';
  return `${graderName(g.kind)}${type}`;
};
/** A check's verdict pill: green and red only for a required check, the ones the trial's outcome
 *  rests on. An optional check's verdict is outlined, beside its "optional, not counted" tag, so a
 *  failed one never reads as the trial failing. */
const verdictPill = (g: GradeView) => (!g.required || g.verdict === 'other' ? 'pill--outline' : g.verdict === 'pass' ? 'pill--pass' : 'pill--fail');
const isJudge = (g: GradeView) => g.kind === 'judge' || !!g.judgeModel;
/** A judge check that was never judged: judging was not approved when the trial was graded. */
const notJudged = (g: GradeView) => isJudge(g) && g.rawVerdict === 'not_implemented';
/** Where to approve judging, or to regrade once it is: the comparison page's judge panel. */
const judgePanelHref = computed(() => (data.value?.experiment && !isExample.value ? href.compareJudge(data.value.experiment.id) : null));
const verdictWord = (g: GradeView) => g.verdictWord;

/** The rubric a judge check used: as its grade records it, else from its task's grader spec. */
function rubricOfGrade(g: GradeView): string | null {
  if (g.rubric) return g.rubric;
  const task = data.value?.experiment?.tasks.find((t) => t.sha256 === vm.value?.task);
  const spec = task?.graders.find((x) => typeof x === 'object' && x !== null && !Array.isArray(x) && x.id === g.graderId);
  return spec ? rubricOf(spec) : null;
}
/** The rubric by its name, `advice.v4`; the grade's version is the grader's, a hash, never the
 *  rubric's. */
function rubricLabel(g: GradeView): string | null {
  const path = rubricOfGrade(g);
  return path ? rubricName(path) : null;
}

type Dispute = JudgeCriterionTrust['disagreements'][number] & { criterion: string };

/** How far to trust the judge behind each judge check (D83), matched by its model and rubric: per
 *  criterion it answered, or, for a check it never answered (not judged, a failed call), the
 *  judge's own status. A check not judged takes the model approved for the experiment, if any.
 *  `disputes`: where a human label on this trial disagrees with the judge, from the same trust
 *  reply, on the questions this check answered (the one named as the check when it lists none),
 *  shown at once, whatever is left to label (7 Nov). */
const gradeTrust = computed(() =>
  (vm.value?.grades ?? []).map((g) => {
    const judges = data.value?.trust;
    if (!judges || !isJudge(g)) return null;
    const model = g.judgeModel ?? (notJudged(g) ? (data.value?.experiment?.judge?.model ?? null) : null);
    const judge = judgeFor(judges, model, rubricOfGrade(g));
    if (!judge) return null;
    const onThisTrial = (c: JudgeCriterionTrust) => c.disagreements.filter((x) => x.trial_id === props.trialId).map((x): Dispute => ({ ...x, criterion: c.criterion }));
    const asked = g.criteria.length ? g.criteria.map((c) => c.criterion) : [g.graderId];
    const disputes = judge.criteria.filter((c) => asked.includes(c.criterion)).flatMap(onThisTrial);
    const criteria = g.criteria.map((c) => {
      const trust = judge.criteria.find((x) => x.criterion === c.criterion) ?? null;
      return { ...c, trust, dispute: disputes.find((x) => x.criterion === c.criterion) ?? null };
    });
    return { judge, criteria, disputes };
  }),
);
/** Each judge check's answers as its card lists them: per question the judge's answer, its quote
 *  and its reason, with the question's trust badge and your label where they are known. A
 *  question the check's verdict does not rest on (an optional one beside required ones) is marked
 *  not counted. */
const judgeRows = computed(() =>
  (vm.value?.grades ?? []).map((g, gi) => {
    const t = gradeTrust.value[gi];
    const anyRequired = g.criteria.some((c) => c.required);
    return g.criteria.map((c) => {
      const row = t?.criteria.find((x) => x.criterion === c.criterion);
      return { ...c, counted: !anyRequired || c.required, trust: row?.trust ?? null, dispute: row?.dispute ?? null };
    });
  }),
);
/** Least trusted first, as the API orders statuses when it words a judge's own status
 *  (apps/api/src/judge/trust.ts judgeStatus). */
const TRUST_ORDER: readonly JudgeTrustStatus[] = ['uncalibrated', 'tuning_only', 'too_few', 'not_trusted', 'trusted'];
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The one trust sentence a judge card shows, as visible text (the badges carry only their word):
 * a check never answered gets its judge's own; a check of one question that question's; a check
 * of several the overall question's when it asked it, else its least trusted question's, named.
 * `badgeRepeats`: the sentence opens with the badge's own word ("Not trusted: …"), so a badge
 * beside it is hidden from screen readers rather than read twice.
 */
const cardTrust = computed(() =>
  (vm.value?.grades ?? []).map((g, gi) => {
    const t = gradeTrust.value[gi];
    if (!t) return null;
    let status: JudgeTrustStatus;
    let summary: string;
    const measured = judgeRows.value[gi].filter((r) => r.trust).map((r) => ({ criterion: r.criterion, trust: r.trust as JudgeCriterionTrust }));
    if (!g.criteria.length) {
      ({ status, summary } = t.judge);
    } else if (!measured.length) {
      return null;
    } else if (measured.length === 1) {
      ({ status, summary } = measured[0].trust);
    } else {
      const overall = measured.find((r) => r.criterion === 'overall');
      const pick = overall ?? [...measured].sort((a, b) => TRUST_ORDER.indexOf(a.trust.status) - TRUST_ORDER.indexOf(b.trust.status))[0];
      status = pick.trust.status;
      summary = `On ${pick.criterion}${overall ? '' : ', its least trusted question'}, ${lowerFirst(plainText(pick.trust.summary))}`;
    }
    const text = plainText(summary);
    return { status, text, badgeRepeats: text.toLowerCase().startsWith(trustLabel(status).toLowerCase()) };
  }),
);
const answerWord = (v: string | null) => (v === 'yes' ? 'answered yes' : v === 'no' ? 'answered no' : 'no answer');
const sourceWords = (source: string | null, tool: string | null) =>
  ({ tool_result: `${tool ?? 'a tool'}'s result`, span: `${tool ?? 'a tool'} call`, result: 'result.json', checks: 'the sourcing check' })[source ?? ''] ?? source ?? 'the trial';

/** The sourcing check's amounts as its card lists them: the ones with no source first, then the
 *  ones it verified by recomputing them, each once, with how many times the replies give it. */
function figureRows(figures: FigureView[]) {
  const rows: { text: string; verified: boolean; derivation: string | null; count: number }[] = [];
  for (const f of [...figures.filter((x) => !x.verified), ...figures.filter((x) => x.verified)]) {
    const same = rows.find((r) => r.text === f.text && r.verified === f.verified && r.derivation === f.derivation);
    if (same) same.count += 1;
    else rows.push({ text: f.text, verified: f.verified, derivation: f.derivation, count: 1 });
  }
  return rows;
}

/** The number check in words: how many amounts trace to a source, and which do not. */
const numberCheck = computed(() => {
  const c = data.value?.checks;
  if (!c) return null;
  const n = c.unsupportedCount;
  const of = c.total !== null ? ` of ${c.total}` : '';
  return {
    summary: c.total === 0
      ? "The agent's replies give no money amount, so there is nothing to trace."
      : n
      ? `${n}${of} ${n === 1 && !of ? 'amount' : 'amounts'} in the answer ${n === 1 ? 'comes' : 'come'} from no tool result and not from the client's own words.`
      : `Every amount${of ? ` (${c.total})` : ''} in the answer comes from a tool result or the client's own words.`,
    unsupported: c.unsupported,
    supported: c.amounts.filter((a) => a.supported),
  };
});

const SET_WORDS: Record<Dispute['set'], string> = { heldout: 'held-out', tuning: 'tuning' };
const yesNo = (v: string) => (v === 'yes' ? 'Yes' : 'No');

/** A check's disputes in words: "Your held-out label disagrees with the judge on overall: you said
 *  No, the judge said Yes." With more than one: "Your held-out labels disagree with the judge on 2
 *  questions: overall (you said No, the judge said Yes); …". The set is named when all share one. */
function disputeWords(list: Dispute[]): { lead: string; items: { criterion: string; words: string }[] } {
  const sets = [...new Set(list.map((x) => x.set))];
  const set = sets.length === 1 ? `${SET_WORDS[sets[0]]} ` : '';
  const answers = (x: Dispute) => `you said ${yesNo(x.human)}, the judge said ${yesNo(x.judge)}`;
  if (list.length === 1) return { lead: `Your ${set}label disagrees with the judge on `, items: [{ criterion: list[0].criterion, words: `: ${answers(list[0])}` }] };
  return { lead: `Your ${set}labels disagree with the judge on ${list.length} questions: `, items: list.map((x) => ({ criterion: x.criterion, words: ` (${answers(x)})` })) };
}
const gradeDisputes = computed(() => gradeTrust.value.map((t) => (t?.disputes.length ? disputeWords(t.disputes) : null)));

const listWords = (xs: string[], last: 'and' | 'or') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${last} ${xs[xs.length - 1]}`);

/** What your label says of a failed judge check, from its disputes on this trial. The check failed
 *  on the questions the judge answered no that its verdict rests on (the required ones, as the
 *  grader counts them; the check itself when it lists none). Your label passes it only when it says
 *  yes on every one of those and no on none; it fails it too when it says no where the judge said
 *  yes. A label that says yes on some of those questions passes them but not the rest, which it
 *  either agrees fail or left unanswered: no disagreement is listed for them. */
function labelNote(g: GradeView, disputes: Dispute[]): string {
  const counted = g.criteria.some((c) => c.required) ? g.criteria.filter((c) => c.required) : g.criteria;
  const ids = new Set(counted.length ? counted.map((c) => c.criterion) : [g.graderId]);
  const mine = disputes.filter((x) => ids.has(x.criterion));
  if (mine.some((x) => x.human === 'no')) return ' (judge; your label: no)';
  const failing = counted.length ? counted.filter((c) => c.verdict === 'no').map((c) => c.criterion) : [g.graderId];
  const passed = new Set(mine.filter((x) => x.human === 'yes').map((x) => x.criterion));
  const disputed = failing.filter((c) => passed.has(c));
  const kept = failing.filter((c) => !passed.has(c));
  if (!disputed.length) return ' (judge)';
  if (!kept.length) return ' (judge; your label passes it)';
  return ` (judge; your label passes ${listWords(disputed, 'and')} but not ${listWords(kept, 'or')})`;
}

/** "Failed on" names each failed required check (the ones the outcome rests on: an optional one that
 *  failed decided nothing, and stays in the grades alone), says which the judge graded, and what your
 *  label says of it. */
const failedOn = computed(() =>
  (vm.value?.grades ?? [])
    .map((g, gi) => ({ g, index: g.index, disputes: gradeTrust.value[gi]?.disputes ?? [] }))
    .filter(({ g }) => g.required && g.verdict === 'fail')
    .map(({ g, index, disputes }) => ({ name: g.name, index, note: isJudge(g) ? labelNote(g, disputes) : '' })),
);

function jumpToGrade(index: number) {
  const el = document.getElementById(`grade-${index}`);
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  el?.focus({ preventScroll: true });
}

/** This task's trials in this trial's arm, in repeat order, each with how it ended: the
 *  comparison's per-arm counts open here, and this steps through them. */
const sameCell = computed(() => {
  const d = data.value;
  const e = d?.experiment;
  const me = d?.siblings.find((t) => t.id === props.trialId);
  if (!d || !e || !me) return null;
  const arm = armIndexOf(me, e);
  const words = (t: TrialRowSummary) => {
    if (t.status === 'infra_failed' || t.status === 'abandoned') return 'infra failure';
    if (t.status === 'cancelled') return 'cancelled';
    if (t.status === 'queued' || t.status === 'claimed') return 'not run yet';
    if (t.status === 'running') return 'running';
    return t.passed === true ? 'passed' : t.passed === false ? 'failed' : 'not graded';
  };
  const trials = d.siblings
    .filter((t) => t.task_sha256 === me.task_sha256 && armIndexOf(t, e) === arm)
    .sort((x, y) => x.repeat_index - y.repeat_index || x.attempt - y.attempt)
    .map((t) => ({ id: t.id, current: t.id === props.trialId, label: `Trial ${t.repeat_index + 1}${t.attempt > 1 ? `, attempt ${t.attempt}` : ''}`, outcome: words(t) }));
  return trials.length > 1 ? { arm: armLetter(arm), task: me.task_id, trials } : null;
});

// Previous and next failed trial in the same experiment, in task, arm and repeat order.
const failures = computed(() => {
  const d = data.value;
  const e = d?.experiment;
  if (!d || !e) return { prev: null as string | null, next: null as string | null };
  const order = (t: TrialRowSummary) => [e.tasks.findIndex((x) => x.sha256 === t.task_sha256), armIndexOf(t, e), t.repeat_index, t.attempt];
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
  <NotFound
    v-if="missing"
    :crumbs="[{ href: href.experiments(), text: 'Experiments' }]"
    title="No trial with that id"
    :item-id="trialId"
  >
    <a :href="href.experiments()">Experiments</a> lists every run, and each comparison opens its trials; <a :href="href.recorded()">Recorded runs</a> lists the gate and smoke runs.
    <template v-if="fixtures && error">
      {{ plainText(error) }}
    </template>
  </NotFound>
  <LoadState
    v-else
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
            <a :href="vm.probe ? href.config() : href.experiments()">{{ vm.probe ? 'Configs' : 'Experiments' }}</a> /
            <template v-if="data.experiment">
              <a :href="href.compare(data.experiment.id)">{{ experimentName(data.experiment) }}</a> /
            </template>
            <template v-else-if="vm.probe && vm.configHash">
              <a :href="href.configPage(vm.configHash)">{{ vm.configName ?? 'Config' }}</a> /
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
            /><span v-if="arm && harnessRef && armIsHarness">{{ arm.label }} <span
              class="mono"
              :title="harnessRef.full"
            >{{ harnessRef.ref }}</span>, config <span class="mono">{{ arm.hash.replace('sha256:', '').slice(0, 7) }}</span></span><span v-else><template v-if="arm && namedByHash(arm)">Config <span class="mono">{{ arm.hash.replace('sha256:', '').slice(0, 7) }}</span></template><template v-else-if="arm">{{ arm.label }}, config <span class="mono">{{ arm.hash.replace('sha256:', '').slice(0, 7) }}</span></template><template v-if="arm && harnessRef">, </template><template v-if="harnessRef">{{ harnessRef.name }} <span
              class="mono"
              :title="harnessRef.full"
            >{{ harnessRef.ref }}</span></template></span>
          </p>
          <p
            v-if="codeParts.length"
            class="secondary small code-line"
            data-test="trial-code"
          >
            <template
              v-for="(p, pi) in codeParts"
              :key="p.key"
            >
              <span>{{ pi ? p.label : capitalise(p.label) }}</span> <span
                v-if="p.short"
                class="mono"
                :title="p.full ?? undefined"
                :data-test="p.key"
              >{{ p.short }}</span><span
                v-else
                :data-test="`${p.key}-missing`"
              >{{ p.missing }}</span>{{ pi < codeParts.length - 1 ? ', ' : '' }}
            </template>
          </p>
          <nav
            v-if="sameCell"
            class="small same-cell"
            :aria-label="`Trials of ${sameCell.task} in arm ${sameCell.arm}`"
            data-test="same-cell"
          >
            <span class="secondary">Arm {{ sameCell.arm }} on <span class="mono">{{ sameCell.task }}</span>:</span>
            <ol>
              <li
                v-for="t in sameCell.trials"
                :key="t.id"
              >
                <strong
                  v-if="t.current"
                  aria-current="page"
                >{{ t.label }}</strong><a
                  v-else
                  :href="href.trial(t.id)"
                >{{ t.label }}</a> <span class="secondary">{{ t.outcome }}</span>
              </li>
            </ol>
          </nav>
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
              >{{ f.name }}</a>{{ f.note }}{{ fi < failedOn.length - 1 ? ', ' : '' }}
            </template>
          </p>
          <div
            v-if="cause"
            class="small trial-cause"
            data-test="trial-cause"
          >
            <p>
              <span class="secondary">{{ cause.lead }}:</span> <strong data-test="trial-cause-name">{{ cause.name }}</strong>. <span class="cause-reason">{{ cause.reason }}</span>
            </p>
            <ul
              v-if="cause.contributing.length"
              class="cause-also secondary"
              data-test="trial-cause-also"
            >
              <li
                v-for="(c, ci) in cause.contributing"
                :key="ci"
              >
                Also {{ c.name.toLowerCase() }}: <span class="cause-reason">{{ c.reason }}</span>
              </li>
            </ul>
          </div>
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
                <template
                  v-for="(block, bi) in item.blocks"
                  :key="bi"
                >
                  <p
                    v-if="block.kind === 'para'"
                    class="bubble-text"
                  >
                    <ReplyPieces
                      :pieces="block.pieces"
                      @jump="jumpToGrade"
                    />
                  </p>
                  <hr
                    v-else-if="block.kind === 'rule'"
                    class="reply-rule"
                  >
                  <div
                    v-else
                    class="table-scroll reply-table-wrap"
                  >
                    <table
                      class="reply-table"
                      data-test="reply-table"
                    >
                      <thead>
                        <tr>
                          <th
                            v-for="(cell, ci) in block.head"
                            :key="ci"
                            scope="col"
                            :class="block.align[ci] ? `align-${block.align[ci]}` : undefined"
                          >
                            <ReplyPieces
                              :pieces="cell"
                              @jump="jumpToGrade"
                            />
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="(row, ri) in block.rows"
                          :key="ri"
                        >
                          <td
                            v-for="(cell, ci) in row"
                            :key="ci"
                            :class="block.align[ci] ? `align-${block.align[ci]}` : undefined"
                          >
                            <ReplyPieces
                              :pieces="cell"
                              @jump="jumpToGrade"
                            />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </article>
              <p
                v-if="item.kind === 'message' && item.quotedBy.length"
                class="mark-key"
                data-test="mark-key"
              >
                Highlighted: evidence quoted by {{ item.quotedBy.join('; ') }}.
              </p>
              <p
                v-if="item.kind === 'message' && item.amounts"
                class="mark-key"
                data-test="amount-key"
              >
                <mark class="amount-mark">Underlined</mark>: amounts the sourcing check found no source for, in any tool result or the client's own words.
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
            v-if="memoryOrSkillsOn || memorySkills.length"
            aria-labelledby="memory-skills"
            class="stack"
            data-test="memory-skills"
          >
            <h2
              id="memory-skills"
              class="section-title"
            >
              Memory and skills
            </h2>
            <p
              v-if="!memorySkills.length"
              class="secondary"
            >
              Memory or skills were on, but the agent read no memory and loaded or wrote no skill.
            </p>
            <ol
              v-else
              class="memory-skills"
            >
              <li
                v-for="m in memorySkills"
                :key="m.key"
                :data-kind="m.kind"
              >
                <span class="memory-skills__title">{{ m.title }}</span>
                <span
                  v-if="m.detail"
                  class="memory-skills__detail secondary small"
                >{{ m.detail }}</span>
              </li>
            </ol>
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
            :key="`${g.graderId}-${g.runIndex}-${gi}`"
            class="grade"
            tabindex="-1"
            data-test="grade"
          >
            <div class="grade-head">
              <span class="strong">{{ g.name }}</span>
              <span class="grade-verdicts">
                <span
                  v-if="!g.required"
                  class="optional-tag"
                  data-test="grade-optional"
                >optional, not counted</span>
                <span
                  class="pill pill--small"
                  :class="verdictPill(g)"
                  data-test="grade-verdict"
                ><AppIcon
                  v-if="g.verdict !== 'other'"
                  :name="g.verdict === 'pass' ? 'check' : 'cross'"
                  :size="12"
                />{{ verdictWord(g) }}</span>
              </span>
            </div>
            <span
              class="secondary smaller"
              data-test="grade-kind"
              :title="isJudge(g) ? `${rubricOfGrade(g) ? `Rubric ${rubricOfGrade(g)}, grader` : 'Grader'} version ${g.graderVersion}` : undefined"
            ><template v-if="g.judgeModel">Judge <span class="mono">{{ g.judgeModel }}</span><template v-if="rubricLabel(g)">, rubric <span
              class="mono"
              data-test="grade-rubric"
            >{{ rubricLabel(g) }}</span></template>, grader version <span class="mono">{{ shortVersion(g.graderVersion) }}</span></template><template v-else>{{ gradeKind(g) }}</template><template v-if="g.score !== null && g.verdict === 'other'">, score {{ g.score }}</template></span>
            <p
              v-if="notJudged(g) && isExample"
              class="small"
              data-test="not-judged"
            >
              Not judged: judging was not approved when this example was run, and judging does not apply to a shipped example, which is read-only here. The check counts as undecided.
            </p>
            <p
              v-else-if="notJudged(g) && judgePanelHref"
              class="small"
              data-test="not-judged"
            >
              <template v-if="data.experiment?.judge">
                Not judged: judging was approved after this trial was graded. <a :href="judgePanelHref">Regrade from the judge panel</a> on the comparison page to judge it now.
              </template>
              <template v-else>
                Not judged: judging is not approved for this experiment, so the judge was not called and nothing was spent. Approving it is a paid step, on the comparison page's <a :href="judgePanelHref">judge panel</a>; the regrade that follows fills this in.
              </template>
            </p>
            <template v-else>
              <p
                v-if="g.reason"
                class="small grade-reason"
                data-test="grade-reason"
              >
                <template
                  v-for="(r, ri) in reasonParts(g.reason)"
                  :key="ri"
                >
                  <code
                    v-if="r.pattern"
                    class="mono reason-pattern"
                    data-test="reason-pattern"
                  >{{ r.text }}</code><span v-else>{{ plainText(r.text) }}</span>
                </template>
              </p>
              <ul
                v-if="judgeRows[gi]?.length"
                class="judge-criteria"
                data-test="judge-criteria"
              >
                <li
                  v-for="c in judgeRows[gi]"
                  :key="c.criterion"
                  data-test="judge-criterion"
                >
                  <p class="small criterion-head">
                    <span><span class="mono">{{ c.criterion }}</span><span
                      class="secondary"
                      data-test="criterion-answer"
                    >, {{ answerWord(c.verdict) }}</span><span
                      v-if="!c.counted"
                      class="secondary"
                    >, not counted</span><span
                      v-if="c.dispute"
                      class="strong"
                      data-test="grade-trust-dispute"
                    >, your label: {{ c.dispute.human }}</span></span>
                    <TrustBadge
                      v-if="c.trust"
                      :status="c.trust.status"
                    />
                    <span
                      v-else-if="gradeTrust[gi]"
                      class="secondary smaller"
                    >Not measured</span>
                  </p>
                  <blockquote
                    v-if="c.quote"
                    class="quote small"
                    data-test="grade-quote"
                  >
                    “{{ quoteText(c.quote) }}”
                  </blockquote>
                  <p
                    v-if="c.quote && c.quoteFound === false"
                    class="secondary smaller"
                    data-test="quote-not-found"
                  >
                    The grader did not find this quote word for word in the conversation.
                  </p>
                  <p
                    v-if="c.reason"
                    class="small"
                    data-test="criterion-reason"
                  >
                    {{ c.reason }}
                  </p>
                </li>
              </ul>
              <blockquote
                v-for="(q, qi) in g.quotes"
                :key="qi"
                class="quote small"
                data-test="grade-quote"
              >
                “{{ quoteText(q.text) }}”
              </blockquote>
              <ul
                v-if="g.figures.length"
                class="figures small"
                data-test="grade-figures"
              >
                <li
                  v-for="f in figureRows(g.figures)"
                  :key="`${f.verified}:${f.text}:${f.derivation}`"
                  :data-test="f.verified ? 'figure-verified' : 'figure-unsourced'"
                >
                  <mark
                    v-if="!f.verified"
                    class="amount-mark mono"
                  >{{ f.text }}</mark><span
                    v-else
                    class="mono"
                  >{{ f.text }}</span>{{ f.count > 1 ? ` (${f.count} times)` : '' }} <span class="secondary">{{ f.verified ? `verified by recomputing it${f.derivation ? `: ${f.derivation}` : ''}` : 'no source found' }}</span>
                </li>
              </ul>
              <div
                v-for="(ev, ei) in g.evidence"
                :key="`e${ei}`"
                class="small"
                data-test="grade-evidence"
              >
                <span class="secondary smaller block">From {{ sourceWords(ev.source, ev.tool) }}</span>
                <code class="mono evidence-quote">{{ ev.quote }}</code>
              </div>
            </template>
            <div
              v-if="gradeTrust[gi]"
              class="grade-trust"
              data-test="grade-trust"
            >
              <p
                v-if="!g.criteria.length"
                class="small trust-line"
                data-test="grade-trust-line"
              >
                <TrustBadge
                  :status="gradeTrust[gi]?.judge.status ?? 'uncalibrated'"
                  :aria-hidden="cardTrust[gi]?.badgeRepeats ? 'true' : undefined"
                />
                <span data-test="grade-trust-summary">{{ cardTrust[gi]?.text }}</span>
              </p>
              <p
                v-else-if="cardTrust[gi]"
                class="small secondary trust-summary"
                data-test="grade-trust-summary"
              >
                {{ cardTrust[gi]?.text }}
              </p>
              <a
                :href="href.judge()"
                class="smaller"
                data-test="grade-trust-link"
              >How far to trust this judge</a>
            </div>
            <p
              v-if="gradeDisputes[gi]"
              class="small dispute"
              data-test="dispute"
            >
              {{ gradeDisputes[gi]?.lead }}<span
                v-for="(x, xi) in gradeDisputes[gi]?.items"
                :key="xi"
              >{{ xi ? '; ' : '' }}<span class="mono">{{ x.criterion }}</span>{{ x.words }}</span>.
              <a :href="href.judge()">See judge agreement</a>
            </p>
          </div>
          <p
            v-if="!vm.grades.length"
            class="secondary small"
            data-test="not-graded"
          >
            {{ isInfra ? 'Infra failures are not graded: they say nothing about the agent.' : vm.probe ? 'A probe only renders the prompt; it is never graded.' : vm.gradingPending ? 'Grading is queued: it runs as its own step after the trial, and this page shows it once it is done.' : 'Not graded yet. Grading runs as its own step after the trial.' }}
          </p>
          <p
            v-else
            class="secondary smaller"
          >
            A trial passes only when every required check passes; a check that could not decide leaves it incomplete. The judge never sees the harness, the model or the arm.
          </p>

          <section
            v-if="numberCheck"
            aria-labelledby="numbers"
            class="number-check"
            data-test="number-check"
          >
            <h3
              id="numbers"
              class="sub-title"
            >
              Where the numbers come from
            </h3>
            <p class="small">
              {{ numberCheck.summary }}
            </p>
            <ul
              v-if="numberCheck.unsupported.length"
              class="amounts small"
              data-test="unsupported-list"
            >
              <li
                v-for="a in numberCheck.unsupported"
                :key="a.text"
              >
                <mark class="amount-mark mono">{{ a.text }}</mark> no source found<span
                  v-if="a.note"
                  class="secondary"
                  data-test="unsupported-note"
                >: {{ a.note }}</span>
              </li>
            </ul>
            <details
              v-if="numberCheck.supported.length"
              class="disclosure"
            >
              <summary><span class="summary-text small">Amounts with a source ({{ numberCheck.supported.length }})</span></summary>
              <ul class="amounts small">
                <li
                  v-for="a in numberCheck.supported"
                  :key="a.text"
                >
                  <span class="mono">{{ a.text }}</span> <span class="secondary">from {{ a.source ?? 'a tool result' }}</span>
                </li>
              </ul>
            </details>
          </section>
          <p
            v-else-if="vm.files.length && !isInfra && !vm.probe && data.any.kind === 'experiment'"
            class="secondary smaller"
            data-test="no-number-check"
          >
            {{
              vm.files.includes('checks.json')
                ? 'No sourcing check shown: this trial’s checks.json could not be read.'
                : 'No sourcing check: this trial has no checks.json. The runner writes one after each trial; trials from before it did, and any whose check failed, have none.'
            }}
          </p>
          <p
            v-if="vm.problems.length || vm.badFiles.length"
            class="small problems"
            role="note"
            data-test="trial-problems"
          >
            <strong>The API flagged this trial:</strong> {{ plainText([...vm.problems, ...vm.badFiles].join('; ')) }}
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
              v-if="files.calls.length"
              class="requests"
              data-test="model-requests"
            >
              <summary><span class="summary-text">Model requests ({{ files.requests }})</span></summary>
              <ul>
                <li
                  v-for="c in files.calls"
                  :key="c.key"
                  data-test="model-call"
                >
                  <template
                    v-for="(f, fi) in [c.request, c.response].filter((x): x is string => !!x)"
                    :key="f"
                  >
                    {{ fi ? ', ' : '' }}<a
                      v-if="!fixtures"
                      :href="fileUrl(f)"
                      class="mono"
                      target="_blank"
                      rel="noopener"
                    >{{ fi ? 'response' : f }}</a><span
                      v-else
                      class="mono secondary"
                    >{{ fi ? 'response' : f }}</span>
                  </template>
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
/* A grader's reason in full, with any pattern it printed set in mono: a long regular expression
   wraps anywhere rather than widening the card. */
.grade-reason {
  overflow-wrap: anywhere;
}

.reason-pattern {
  font-size: 12px;
  padding: 0 3px;
  background: var(--ground);
  border-radius: 3px;
  overflow-wrap: anywhere;
  word-break: break-all;
}

.evidence-quote {
  display: block;
  padding: 4px 8px;
  background: var(--ground);
  border-radius: 4px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

/* An amount with no source: the highlight and a wavy underline, so it reads apart from a judge's
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

.number-check {
  border-top: 1px solid var(--rule);
  padding-top: 12px;
}

.amounts,
.figures {
  list-style: none;
  margin: 6px 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.figures {
  margin: 0;
  overflow-wrap: anywhere;
}

.problems {
  border-left: 3px solid var(--ink);
  padding-left: 10px;
}

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
  /* Its table reads its own width (below), not the window's. */
  container-type: inline-size;
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

/* D85: the adapter code and platform commit, under the arm and config they sit beside. */
.code-line {
  margin-top: 2px;
}

/* The rule-based cause under the checks it failed: a pointer, the trial below is the evidence. */
.trial-cause {
  margin-top: 6px;
  max-width: 90ch;
  display: grid;
  gap: 2px;
}

.cause-reason {
  overflow-wrap: anywhere;
}

.cause-also {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 2px;
}

.same-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  margin-top: 6px;
}

.same-cell ol {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.same-cell a,
.same-cell strong {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
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
  overflow-wrap: anywhere;
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

/* A reply's table and rule (lib/trialMarkdown.ts): a light grid that scrolls inside the bubble
   rather than widening it, its numbers in tabular figures. */
.reply-table-wrap {
  margin: 8px 0;
}

.reply-table {
  border-collapse: collapse;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.reply-table th,
.reply-table td {
  padding: 4px 12px 4px 0;
  border-bottom: 1px solid var(--rule-soft);
  text-align: left;
  vertical-align: top;
}

.reply-table thead th {
  font-weight: 600;
  border-bottom-color: var(--rule);
}

.reply-table .align-right {
  text-align: right;
}

.reply-table .align-center {
  text-align: center;
}

.reply-rule {
  border: 0;
  border-top: 1px solid var(--rule);
  margin: 12px 0;
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

.memory-skills {
  margin: 0;
  padding-left: 1.25rem;
  display: grid;
  gap: 0.5rem;
}

.memory-skills__detail {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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

/* An optional check's tag sits before its verdict, and goes under it when the name is long. */
.grade-verdicts {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 4px 8px;
}

.optional-tag {
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
}

/* A quote keeps its line breaks (a numbered list reads as one), its Markdown markers dropped. */
.quote {
  margin: 4px 0 0;
  padding: 8px 12px;
  background: var(--ground);
  border-radius: 6px;
  white-space: pre-line;
}

/* How far to trust the judge behind a judge check (D83): one line per question it answered. */
.grade-trust {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--rule-soft);
}

/* A judge check's answers, one block per question: the answer and its trust, then the judge's
   quote and its reason for that answer. */
.judge-criteria {
  list-style: none;
  margin: 2px 0 0;
  padding: 8px 0 0;
  border-top: 1px solid var(--rule-soft);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.judge-criteria li {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.judge-criteria .quote {
  margin: 0;
}

.criterion-head,
.trust-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.applied-table {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 10px;
  border-collapse: separate;
  border-spacing: 0;
}

/* Fixed columns, so the table never widens its column: a word breaks only when it is longer than
   its column (a long value or source), never a short one such as Temperature. */
.applied-table {
  table-layout: fixed;
  width: 100%;
}

.applied-table th,
.applied-table td {
  padding: 8px 14px;
  overflow-wrap: anywhere;
}

.applied-table th {
  width: 38%;
}

.applied-table td.num {
  width: 22%;
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

/* In a narrow column (a 320 px phone) three columns leave a setting's name too little room, and
   it would break mid-word ("Compressio n"). Each row stacks instead: the name and its value on one
   line, where the value came from under them. */
@container (max-width: 340px) {
  .applied .applied-table,
  .applied .applied-table tbody {
    display: block;
  }

  .applied .applied-table tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 12px;
  }

  .applied .applied-table tr > th,
  .applied .applied-table tr > td.num {
    width: auto;
    padding-bottom: 0;
    border-bottom: 0;
    overflow-wrap: break-word;
  }

  .applied .applied-table tr > td.num {
    padding-left: 0;
    padding-right: 14px;
    text-align: right;
  }

  .applied .applied-table tr > td:last-child {
    grid-column: 1 / -1;
    padding: 2px 14px 8px;
  }
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

/* Arguments are often one long JSON line: it wraps anywhere rather than widening the page. */
.tool-args {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
