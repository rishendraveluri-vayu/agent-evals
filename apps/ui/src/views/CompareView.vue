<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { BlindItem, Compare, CompareRow, ExperimentDetail, Harness, TrialRowSummary, Interval, JudgeTrust, TaskView } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import BehaviourPanel from '../components/BehaviourPanel.vue';
import IntervalStrip from '../components/IntervalStrip.vue';
import JudgePanel from '../components/JudgePanel.vue';
import LoadState from '../components/LoadState.vue';
import NotFound from '../components/NotFound.vue';
import TrustBadge from '../components/TrustBadge.vue';
import VerdictTag from '../components/VerdictTag.vue';
import { agreementWords, armDifferences, armIndexOf, armLetter, armsOf, armState, armWords, differingShort, namedByHash, noDiffWords as noDiffFor, excludesZero, noWidth, shownWidth, intervalText, judgeCaveat, NBSP, passedText, pointsWithInterval, setupOf, totalTrials, verdictTitle, type Arm, type ArmKey, type Verdict } from '../lib/arms';
import { optional, useLoad } from '../lib/async';
import { causeView, causeWord } from '../lib/causes';
import { armsCheck, budgetCheck, capabilityCheck, localDiff, planCheck, splitCheck, type Check } from '../lib/checks';
import { identParts, money, percent, plainText, plural, seconds, shortHash, shortRef, signed, signedMoney, thousands, tick } from '../lib/format';
import { isFake } from '../lib/models';
import { alsoGradedBy, experimentName, gradedBy, harnessShort, infraReason, isJudged, modelName } from '../lib/names';
import { domainFor, ticksFor, verdictTone, type StripRow } from '../lib/scale';
import { pauseCause } from '../lib/runs';
import { labelSetFor, rubricName } from '../lib/trust';
import { href } from '../router';

/** `panel`: `judge` opens the page at its judge panel (the trial page links there). */
const props = defineProps<{ experimentId: string; panel?: string | null }>();
const fixtures = isFixtureMode();

/** The address names an experiment that does not exist (a mistyped or stale link). */
const missing = ref(false);
async function experimentOrMissing(id: string): Promise<ExperimentDetail> {
  try {
    return await api.experiment(id);
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'unknown_experiment' || err.status === 404)) missing.value = true;
    throw err;
  }
}

interface Loaded {
  detail: ExperimentDetail;
  compare: Compare;
  trials: TrialRowSummary[];
  /** Held-out items still to label: while any remain, the judge's agreement is provisional. */
  queue: BlindItem[];
  /** How far to trust this experiment's judges (D83), with where labels dispute them; null when it
   *  could not be read. */
  trust: JudgeTrust[] | null;
  /** The harnesses' capabilities, for the run page's checks before the start; null when not read. */
  harnesses: Harness[] | null;
}

const { data, error, loading } = useLoad<Loaded>(async () => {
  // A shipped example has no judge panel and its trials are never in the label queue, so its page
  // does not fetch the held-out queue (every held-out output, a large reply). It does read its
  // judges' trust (D83), shown read-only, since a reviewer starts on this page.
  const detailP = experimentOrMissing(props.experimentId);
  const blindP = detailP.then(async (d): Promise<{ queue: BlindItem[]; trust: JudgeTrust[] | null }> => {
    if (d.example) return { queue: [], trust: await optional(api.judgeTrust(d.id).then((r) => r.judges), null) };
    const [queue, trust] = await Promise.all([optional(api.labelQueue('heldout'), [] as BlindItem[]), optional(api.judgeTrust(d.id).then((r) => r.judges), null)]);
    return { queue, trust };
  });
  const [detail, compare, trials, blind, harnesses] = await Promise.all([
    detailP,
    api.compare(props.experimentId),
    optional(api.experimentTrials(props.experimentId), [] as TrialRowSummary[]),
    blindP,
    optional(api.harnesses(), null),
  ]);
  return { detail, compare, trials, ...blind, harnesses };
});

const arms = computed(() => (data.value ? armsOf(data.value.detail, data.value.detail.configs) : []));

/** Which arms ran on a fake model, in words ("Both arms", "Arm A"), or null when none did. Their
 *  replies are scripted and their prices made up for testing. */
const fakeArms = computed(() => {
  const fake = arms.value.filter((a) => isFake(a.config?.model));
  if (!fake.length) return null;
  if (fake.length === arms.value.length) return arms.value.length === 1 ? 'Its one arm' : arms.value.length === 2 ? 'Both arms' : 'Every arm';
  return fake.length === 1 ? `Arm ${fake[0].key.toUpperCase()}` : `Arms ${fake.map((a) => a.key.toUpperCase()).join(' and ')}`;
});

/** What arms A and B differ in, each with both values ("Max steps: 10 in A, 12 in B"), read from
 *  the two saved configs. `same`: one config in both arms; `unnamed`: the configs differ only in
 *  something this list does not put in words. Null with one arm or a config that did not load. */
const differences = computed(() => {
  const [a, b] = arms.value;
  if (!a?.config || !b?.config) return null;
  if (a.hash === b.hash) return { list: [], same: true, unnamed: false };
  const list = armDifferences(a.config, b.config);
  return { list, same: false, unnamed: !list.length };
});

/** The judge panel's counts: tasks with a judge check, and the finished trials of those tasks. */
const judged = computed(() => {
  const d = data.value;
  if (!d) return { tasks: 0, trials: 0 };
  const tasks = d.detail.tasks.filter(isJudged);
  const keys = new Set(tasks.map((t) => t.sha256));
  const own = d.trials.filter((t) => t.status === 'done' && keys.has(t.task_sha256)).length;
  // D72: a regrade also judges the trials arm A reuses from its parent, which the trial list (this
  // experiment's own) leaves out; D34 reuses the same number for every task, so the paid-step count
  // includes them.
  const a = d.detail.arms[0];
  const reused = a?.reused_from && d.detail.tasks.length ? Math.round((a.reused_trials * tasks.length) / d.detail.tasks.length) : 0;
  return { tasks: tasks.length, trials: own + reused };
});

/** Where to label this experiment's outputs to calibrate its judge (D83): its held-out set when it
 *  ran held-out tasks, else tuning. */
const calibrateHref = computed(() => (data.value ? href.labels({ set: labelSetFor(data.value.detail.tasks), experiment: data.value.detail.id, calibrate: true }) : ''));

/** After an approval, a revoke or a regrade: the experiment again (its judge and spend), and its
 *  trials, without reloading the page around the panel. */
async function refreshJudge() {
  const d = data.value;
  if (!d) return;
  const [detail, trials] = await Promise.all([optional(api.experiment(props.experimentId), d.detail), optional(api.experimentTrials(props.experimentId), d.trials)]);
  data.value = { ...d, detail, trials };
}

// Opened from a trial's "Not judged" grade: bring the judge panel into view and give it focus.
watch(data, async (d, before) => {
  if (!d || before || props.panel !== 'judge') return;
  await nextTick();
  const panel = document.getElementById('judge-panel');
  panel?.scrollIntoView?.({ block: 'start' });
  panel?.focus({ preventScroll: true });
});
const stats = computed(() => data.value?.compare.stats ?? null);
/** D72: a required check was graded with different versions in the two arms, so the API gives no
 *  verdict; its stats_note names which and says to regrade. */
const notAlike = computed(() => (data.value?.compare.grader_versions?.blocking.length ?? 0) > 0);
/** D72: optional checks graded with different versions in the two arms; the verdict stands. */
const optionalVersionsNote = computed(() => (stats.value ? (data.value?.compare.grader_versions?.note ?? null) : null));
const taskOf = (key: string): TaskView | undefined => data.value?.detail.tasks.find((t) => t.sha256 === key || t.id === key);
const taskName = (key: string) => taskOf(key)?.id ?? key.replace(/^sha256:/, '').slice(0, 12);

/** A task's row for an arm, by the arm's letter, so an A/A run (one hash twice) keeps its arms apart. */
function cell(task: string, arm: 0 | 1): CompareRow | undefined {
  const letter = arm === 0 ? 'A' : 'B';
  return data.value?.compare.rows.find((r) => r.task === task && r.arm === letter);
}

/** D37: no comparison until every arm is complete; the API says why, and how each arm stands. The
 *  page adds that a verdict needs the full planned N, so a reason that already says so (a stopped
 *  run's does) loses its own copy. */
const incomplete = computed(() => {
  const d = data.value;
  if (d?.compare.status !== 'incomplete') return null;
  const tail = 'A verdict needs the full planned N, so no pass counts are shown off a partial run.';
  // A stopped run is over: it says so from the arms' counts, and an arm that had paused before the
  // stop is told apart below, its message whole (QA, 7 Nov: a cancelled run read "Arm A is
  // paused: ... allowed_opena", cut off mid-word).
  if (stoppedRun.value) {
    const counts = d.compare.arms.filter((a) => a.counts.cancelled > 0).map((a) => `${a.counts.cancelled} of arm ${a.arm}'s trials cancelled`);
    return `It was stopped before every trial ran${counts.length ? ` (${counts.join(', ')})` : ''}. ${tail}`;
  }
  const reason = withCutMark(plainText(d.compare.reason ?? 'not every arm is complete yet')
    .replace(/[;,.]?\s*a verdict needs the full planned N\.?\s*$/i, '')
    .trim());
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.…]$/.test(reason) ? '' : '.'} ${tail}`;
});

/** The experiment was stopped (its status is `cancelled`): no comparison will ever come. */
const stoppedRun = computed(() => data.value?.detail.status === 'cancelled' && data.value.compare.status === 'incomplete');

/** worker/report.ts keeps the first 300 characters of a provider's message in a config error: one
 *  that long was cut there, so it ends with an ellipsis rather than mid-word as if it ended. */
const PROVIDER_MESSAGE_KEPT = 300;
const CONFIG_ERROR = /infra:config_error \(LiteLLM status \w+\): ([\s\S]*)$/;
function withCutMark(reason: string): string {
  const m = CONFIG_ERROR.exec(reason);
  return m && m[1].length >= PROVIDER_MESSAGE_KEPT ? `${reason}…` : reason;
}

/** On a stopped run, each arm that had paused before the stop: why, and the provider's message in
 *  full as recorded, wrapped, never cut by the page. */
const pausedBeforeStop = computed(() => {
  if (!stoppedRun.value) return [];
  return (data.value?.compare.arms ?? [])
    .filter((a) => a.status === 'paused' && a.paused_reason)
    .map((a) => {
      const reason = plainText(a.paused_reason ?? '');
      const m = CONFIG_ERROR.exec(reason);
      const cut = !!m && m[1].length >= PROVIDER_MESSAGE_KEPT;
      return {
        letter: a.arm,
        lead: m ? `Arm ${a.arm} had paused before the stop, on ${pauseCause(reason)}. The provider's message, as recorded:` : `Arm ${a.arm} had paused before the stop: ${reason}`,
        message: m ? `${m[1]}${cut ? '…' : ''}` : null,
        cut,
      };
    });
});
const armProgress = computed(() => {
  const list = data.value?.compare.arms ?? [];
  // Two configs with one name are told apart by their arm names, as in the header.
  const namesClash = new Set(list.map((a) => a.config_name)).size < list.length;
  return list.map((a, i) => {
    const c = a.counts;
    const total = c.queued + c.running + c.done + c.infra_failed + c.abandoned + c.cancelled;
    const words: Record<string, string> = { not_started: 'not started', active: 'running', paused: stoppedRun.value ? 'stopped' : 'paused', stopped: 'stopped', complete: 'complete' };
    const name = namesClash && arms.value[i] ? arms.value[i].label : a.config_name;
    return { key: a.arm.toLowerCase(), letter: a.arm, name, status: words[a.status] ?? a.status, done: c.done, total, reason: a.status === 'paused' && a.paused_reason ? plainText(a.paused_reason) : null };
  });
});

const totals = computed(() => {
  const d = data.value;
  if (!d) return null;
  const sum = (arm: 0 | 1) =>
    d.detail.tasks.reduce(
      (acc, t) => {
        const c = cell(t.sha256, arm);
        return { passed: acc.passed + (c?.passed ?? 0), graded: acc.graded + (c?.graded ?? 0), incomplete: acc.incomplete + (c?.incomplete ?? 0) };
      },
      { passed: 0, graded: 0, incomplete: 0 },
    );
  return { a: sum(0), b: sum(1) };
});

const noVerdictText = computed(() => {
  const t = totals.value;
  if (!t) return '';
  const b = arms.value[1] ? `, B passed ${t.b.passed} of ${t.b.graded}` : '';
  const more = arms.value.length > 2 ? ` This experiment has ${arms.value.length} configs, made before experiments had two arms: only A and B are compared here; the run page shows every arm.` : '';
  if (!t.a.graded && !t.b.graded && !t.a.incomplete && !t.b.incomplete) {
    const ran = (letter: 'A' | 'B') => (data.value?.compare.rows ?? []).filter((r) => r.arm === letter).reduce((sum, r) => sum + r.trials, 0);
    return `Not graded yet: A has ${ran('A')} finished ${ran('A') === 1 ? 'trial' : 'trials'}${arms.value[1] ? ` and B ${ran('B')}` : ''}, and grading runs as its own step. The interval and the verdict come after it.${more}`;
  }
  const open = t.a.incomplete + t.b.incomplete;
  const undecided = open
    ? ` ${open} more ${open === 1 ? 'trial has' : 'trials have'} no outcome: a required check could not be decided (often the judge, when judging is not approved), so ${open === 1 ? 'it counts' : 'they count'} as neither a pass nor a fail.`
    : '';
  const why = data.value?.compare.stats_note ?? 'There is no verdict yet.';
  return `A passed ${t.a.passed} of ${t.a.graded} graded trials${b}.${undecided} ${why} Read these as counts, not a conclusion; the per-task results below are complete.${more}`;
});

/** In the verdict box of a run on a fake model: its outputs are a script, not an agent's. */
const fakeRunNote = computed(() => {
  const who = fakeArms.value;
  if (!who) return null;
  const all = arms.value.every((a) => isFake(a.config?.model));
  return all
    ? `${who} ran on a fake model, which makes the same calls whatever the task, so most trials fail. The counts test the platform, not an agent.`
    : `${who} ran on a fake model, which makes the same calls whatever the task, so most of its trials fail. This comparison tests the platform, not an agent.`;
});

/** Trials stopped on infra failures: listed, never dropped. When the trial list did not load,
 *  the experiment's counts still say how many there were. */
const infraTrials = computed(() => data.value?.trials.filter((t) => t.status === 'infra_failed' || t.status === 'abandoned') ?? []);
const infraCount = computed(() => {
  const d = data.value;
  if (!d) return 0;
  return infraTrials.value.length || d.detail.counts.infra_failed + d.detail.counts.abandoned;
});

/** Which arm a trial ran in. An A/A run has one hash twice: its second arm's repeats come after
 *  the first arm's. */
function armOfTrial(t: TrialRowSummary): ArmKey {
  const d = data.value;
  if (!d) return 'a';
  return armLetter(armIndexOf(t, d.detail)).toLowerCase();
}

/** The attempt that re-ran an infra-stopped trial: same task, config and repeat, one attempt on.
 *  An attempt abandoned for want of heartbeats is re-run too, so the next attempt is looked for
 *  first, whatever stopped this one. With none, the run is either still going (it may come) or
 *  over (the re-run cap was reached, or the run was stopped). */
function rerunWords(t: TrialRowSummary): string {
  const next = data.value?.trials.find((x) => x.task_sha256 === t.task_sha256 && x.config_hash === t.config_hash && x.repeat_index === t.repeat_index && x.attempt === t.attempt + 1);
  if (!next) {
    const status = data.value?.detail.status;
    return status === 'running' || status === 'paused' || status === 'created' ? 'not re-run yet' : 'not re-run';
  }
  if (next.status === 'queued' || next.status === 'claimed' || next.status === 'running') return 'not re-run yet';
  if (next.status === 'infra_failed' || next.status === 'abandoned') return 're-run also an infra failure';
  if (next.status === 'cancelled') return 're-run cancelled';
  if (next.passed === true) return 're-run passed';
  if (next.passed === false) return 're-run failed';
  return 're-run not graded yet';
}

/** Why an attempt stopped on infra: its runner label, or, for an attempt that was abandoned (it
 *  has no label), that its worker went quiet. */
const infraCause = (t: Pick<TrialRowSummary, 'status' | 'label'>) => infraReason(t.label) || (t.status === 'abandoned' ? 'its worker stopped sending heartbeats' : '');

const infraRows = computed(() =>
  infraTrials.value.map((t) => {
    const reason = infraCause(t);
    return { trial: t, arm: armOfTrial(t), task: taskName(t.task_sha256), cause: `infra failure${reason ? `: ${reason}` : ''}`, rerun: rerunWords(t) };
  }),
);

/** "Both were in arm B." when every listed infra failure is in one arm. */
const infraArmNote = computed(() => {
  const rows = infraRows.value;
  const armsHit = new Set(rows.map((r) => r.arm));
  if (!rows.length || armsHit.size !== 1) return '';
  const arm = rows[0].arm.toUpperCase();
  if (rows.length === 1) return `It was in arm ${arm}.`;
  return rows.length === 2 ? `Both were in arm ${arm}.` : `All ${rows.length} were in arm ${arm}.`;
});

/** "2 trials stopped on infra failures were re-run and are listed, not dropped. Both were in arm
 *  B." It says re-run only when every listed stop was, and the counts say so when the list did not
 *  load. */
const infraSentence = computed(() => {
  const n = infraCount.value;
  const rows = infraRows.value;
  const rerun = !rows.length || rows.every((r) => r.rerun === 're-run passed' || r.rerun === 're-run failed' || r.rerun === 're-run not graded yet');
  const one = n === 1;
  const done = rerun ? `${one ? 'was' : 'were'} re-run and ${one ? 'is' : 'are'}` : one ? 'is' : 'are';
  return `${n} ${one ? 'trial' : 'trials'} stopped on infra failures ${done} listed, not dropped.${infraArmNote.value ? ` ${infraArmNote.value}` : ''}`;
});

const commits = computed(() => {
  const d = data.value?.detail;
  return { plan: d?.plan_commit ? d.plan_commit.slice(0, 7) : null, platform: d?.platform_commit ? d.platform_commit.slice(0, 7) : null };
});

/** The harness pin from the configs: "Hermes 6112c2a" on line 2 when both arms share it, or each
 *  pin in its arm on line 1 when they differ (unless the arm's name already gives it). */
const pinOf = (arm: Arm | undefined) => (arm?.config ? shortRef(arm.config.harness_ref) : null);
const armPin = (arm: Arm) => {
  const pin = meta.value.perArm ? pinOf(arm) : null;
  return pin && !arm.label.includes(pin.slice(0, 7)) ? pin : null;
};
/** Line 2 names only what both arms share: the harness, then the model or the prompt. */
const meta = computed(() => {
  const d = data.value;
  const [a, b] = arms.value;
  const ca = a?.config;
  const cb = (b ?? a)?.config;
  if (!d || !ca) return { perArm: false, harness: '', pin: null as string | null, rest: setupOf(d?.detail ?? { axis: 'none' }, arms.value) };
  if (!cb) return { perArm: false, harness: harnessShort(ca.harness), pin: pinOf(a), rest: ` with ${modelName(ca.model)}` };
  const sameModel = ca.model === cb.model;
  const samePrompt = ca.prompt.sha256 === cb.prompt.sha256;
  const shared = ca.harness === cb.harness && ca.harness_ref === cb.harness_ref;
  if (!shared) return { perArm: true, harness: '', pin: null, rest: [sameModel ? modelName(ca.model) : '', samePrompt ? `prompt ${ca.prompt.version}` : ''].filter(Boolean).join(', ') };
  const rest = sameModel ? ` with ${modelName(ca.model)}` : samePrompt ? `, prompt ${ca.prompt.version}` : '';
  return { perArm: false, harness: harnessShort(ca.harness), pin: pinOf(a), rest };
});

/** The simulated client's model, which shapes every conversation in both arms: null when the
 *  experiment has none. */
const simClient = computed(() => (data.value?.detail.sim_model ? modelName(data.value.detail.sim_model) : null));

const hero = computed(() => {
  const s = stats.value;
  if (!s) return null;
  const values = [s.diff.low, s.diff.high, ...(s.aa ? [s.aa.diff.low, s.aa.diff.high] : [])];
  // A pass-rate difference lies between -100 and +100 points: no tick past either.
  const [min, max] = domainFor(values, -20, 30, 100);
  const level = Math.round(s.level * 100);
  const [a, b] = arms.value;
  const name = a && b && a.short !== b.short ? `${b.short} minus ${a.short}` : 'B minus A';
  // Arm colour only when the result holds up; a result with no clear difference is grey.
  const rows: StripRow[] = [{ estimate: s.diff.estimate, low: s.diff.low, high: s.diff.high, tone: verdictTone(s.verdict), label: `${name}, ${plural(s.tasks.length, 'task')}` }];
  const aa: StripRow[] = s.aa ? [{ estimate: s.aa.diff.estimate, low: s.aa.diff.low, high: s.aa.diff.high, tone: 'neutral', size: 'sm', label: 'A/A calibration, same config twice' }] : [];
  return {
    level,
    min,
    max,
    ticks: ticksFor(min, max, 10),
    rows: [...rows, ...aa],
    aria: `Difference ${signed(s.diff.estimate)} points, interval ${intervalText(s.diff)}.${s.aa ? ` The A/A calibration gave ${signed(s.aa.diff.estimate)}, interval ${intervalText(s.aa.diff)}.` : ''}`,
  };
});

/** The hero's sentence under the verdict: "+15 points of pass rate: v1 58%, v2 73%. The 95%
 *  interval runs from +7 to +23 points." Each arm's rate is named; "X to Y" is only an interval.
 *  Numbers stay on the line with their unit. */
const heroText = computed(() => {
  const s = stats.value;
  const h = hero.value;
  if (!s || !h) return null;
  const [a, b] = armWords(arms.value);
  const unit = (v: number) => (Math.abs(Math.round(v)) === 1 ? 'point' : 'points');
  // A zero-width interval does not "run" anywhere: say it has no width (D55).
  const interval = noWidth(s.diff)
    ? `The ${h.level}% interval has no width: ${signed(s.diff.low)} to ${signed(s.diff.high)}${NBSP}points.`
    : `The ${h.level}% interval runs from ${signed(s.diff.low)} to ${signed(s.diff.high)}${NBSP}points.`;
  return {
    big: `${signed(s.diff.estimate)}${NBSP}${unit(s.diff.estimate)}`,
    rest: ` of pass rate: ${a} ${percent(s.a.rate)}, ${b} ${percent(s.b.rate)}. ${interval}`,
  };
});

/** The tasks whose two arms passed at different rates. Only these move the paired sign-flip test:
 *  over K of them its smallest possible p is 2/2^K, so below 6 it cannot reach p < 0.05 (D50). */
const tasksThatDiffer = computed(() => stats.value?.tasks.filter((t) => t.diff.estimate !== 0).length ?? 0);

/** Under the hero: what the verdict rests on, in a sentence. "No detectable difference" always
 *  says how large a difference is not ruled out (D42); equivalence names its margin. */
const verdictSub = computed(() => {
  const s = stats.value;
  if (!s) return null;
  const k = tasksThatDiffer.value;
  const few =
    s.tasks.length < 6
      ? ` With ${plural(s.tasks.length, 'task')} in the comparison no other verdict is possible: the paired test needs at least 6 tasks to reach p${NBSP}<${NBSP}0.05.`
      : k > 0 && k < 6
        ? ` Only ${k} of the ${s.tasks.length} tasks passed at different rates in the two arms, and only those count in the paired test: over ${plural(k, 'task')} its smallest possible p is ${2 / 2 ** k}, so it could not reach p${NBSP}<${NBSP}0.05 however large the difference.`
        : '';
  if (s.verdict === 'equivalent') return `The whole interval lies inside the ±${s.margin_points}-point margin set before the run, so any difference is too small to matter.`;
  if (s.verdict === 'held_back') return 'The pass rate alone would say better, but critical failures rose beyond noise, so it is not called better.';
  if (s.verdict !== 'no_detectable_difference') return null;
  const hiding = s.not_ruled_out_points !== null
    ? `Differences as large as ${Math.round(s.not_ruled_out_points)}${NBSP}points are not ruled out.`
    : 'Every task gave the same difference, so the interval has no width and cannot say how large a difference could be hiding.';
  return `${hiding}${few}`;
});

/** D44: the latest A/A calibration of these configs, or a link to set one up for arm A's agent. */
const aaSetup = computed(() => {
  const a = arms.value[0];
  return a ? href.runNew(a.hash, a.hash, { calibration: true }) : null;
});

/** Why the result is or is not noise: the interval, the check on the method (an A/A calibration),
 *  and the method itself, in plain words. */
const why = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const side = s.diff.low > 0 ? 'above' : 'below';
  const points = (v: number) => `${signed(v)}${NBSP}${Math.abs(Math.round(v)) === 1 ? 'point' : 'points'}`;
  // D55: an interval with no width (0 to 0 included) neither crosses zero nor stays clear of it in
  // any useful sense: every task gave the same difference, so there is no spread to show.
  const alpha = Number((1 - s.level).toFixed(2));
  // Practical equivalence rests on the margin, not on zero: an interval inside it may still stay
  // clear of zero, but the difference it shows is too small to matter.
  const interval = noWidth(s.diff)
    ? `Every task gave the same difference, ${points(s.diff.estimate)}, so no spread can be shown: an interval with no width is not a narrow one.`
    : s.verdict === 'equivalent'
      ? `The whole interval, ${signed(s.diff.low)} to ${signed(s.diff.high)}${NBSP}points, lies inside the ±${s.margin_points}-point margin set before the run${excludesZero(s.diff) ? `. It stays ${side} zero, but a difference that small is not one that matters.` : '.'}`
      : excludesZero(s.diff)
      ? notCalled(s)
        ? `The interval stays ${side} zero, but the verdict rests on the paired sign-flip test, and it gives p${NBSP}=${NBSP}${s.p_value}, not below ${alpha}.`
        : `The interval stays ${side} zero.`
      : // An interval that only touches zero (0 to +100) reaches it; one with zero inside crosses it.
        `The interval ${s.diff.low === 0 || s.diff.high === 0 ? 'reaches' : 'crosses'} zero, so these trials cannot rule out no difference at all.`;
  let aa = '';
  if (s.aa) {
    aa = excludesZero(s.aa.diff)
      ? `Check on the method: the latest A/A calibration of this config gave ${pointsWithInterval(s.aa.diff)}, a difference where there is none. Treat this result with caution.`
      : noWidth(s.aa.diff)
        ? `Check on the method: the latest A/A calibration of this config gave ${pointsWithInterval(s.aa.diff)}: every task gave the same difference, so it did not invent one, but with no spread it cannot show how much the setup varies.`
        : `Check on the method: the latest A/A calibration of this config gave ${pointsWithInterval(s.aa.diff)}, which includes zero, so the setup did not invent a difference when nothing changed.`;
  }
  const count = (v: number) => v.toLocaleString('en-US');
  const flips = s.test.exact ? `every one of the ${count(s.test.flips)} ways to flip the tasks' signs` : `${count(s.test.flips)} random sign flips`;
  const method = `Paired by task: each task is compared with itself across the two arms, and the ${Math.round(s.level * 100)}% interval comes from resampling the tasks ${count(s.resamples)} times. The sign-flip test over ${flips} gives p${NBSP}=${NBSP}${s.p_value}.`;
  return [interval, ...(aa ? [aa] : []), method];
});

/** An interval clear of zero (with width) while the paired test, which the verdict rests on, does
 *  not reach the threshold: the page must not call it unlikely to be noise beside "no detectable
 *  difference". */
function notCalled(s: NonNullable<typeof stats.value>): boolean {
  return s.pass_rate_verdict === 'no_detectable_difference' && !noWidth(s.diff) && excludesZero(s.diff);
}

/** The aside's heading. An interval clear of zero is unlikely to be noise; one with no width shows
 *  no spread either way, so there only the paired test's verdict can say (D55). When the interval
 *  is clear but the test is not, the heading says why it is not called better (or worse). A
 *  practically equivalent result is headed by that, whatever side of zero its interval lies on. */
const whyTitle = computed(() => {
  const s = stats.value;
  if (!s) return '';
  if (s.verdict === 'equivalent') return 'Why this counts as practically equivalent';
  if (notCalled(s)) return s.diff.low > 0 ? 'Why this is not called better' : 'Why this is not called worse';
  const clear = noWidth(s.diff) ? s.pass_rate_verdict === 'better' || s.pass_rate_verdict === 'worse' : excludesZero(s.diff);
  return clear ? 'Why this is unlikely to be noise' : 'Why this could be noise';
});

/** The statistics' sentences write a negative number with a hyphen; the page uses a minus sign. */
const minus = (text: string) => text.replace(/(^|[\s(])-(?=\d)/g, '$1\u2212');

/** D10's guardrail beside the verdict: what happened to critical failures, or that no check is
 *  marked critical (nothing is claimed about them then). */
const critical = computed(() => {
  const c = stats.value?.critical;
  if (!c) return null;
  return { text: minus(c.text), alarm: c.status === 'rose', none: c.status === 'no_critical_checks' };
});

/** The run page's checks before the start, as it makes them for a started run (lib/checks.ts), and
 *  the ones that failed: a run can start with one failing only from the API, and its result rests
 *  on that, so "What it rests on" says so (QA, 7 Nov: the retrieval run mixed discovery and
 *  held-out tasks, and its verdict said nothing of it). The plan commit is recorded, not checked,
 *  so only a missing or malformed one counts. */
const preStart = computed<{ failed: Check[]; total: number } | null>(() => {
  const d = data.value;
  if (!d) return null;
  const e = d.detail;
  const configs = e.config_hashes.map((h) => e.configs.find((c) => c.hash === h)).filter((c): c is NonNullable<typeof c> => !!c);
  const list: Check[] = [];
  if (e.config_hashes.length === 2 && configs.length === 2) {
    const [a, b] = configs;
    const same = a.hash === b.hash;
    if (same) list.push(e.calibration ? { ok: true, title: 'A/A calibration: the same agent on both arms', detail: '' } : { ok: false, title: 'Arm A and arm B are the same agent', detail: 'Two arms of one config compare an agent with itself; only a marked A/A calibration should.' });
    else list.push(armsCheck(localDiff(a, b), false, [a, b]));
  }
  if (d.harnesses) list.push(capabilityCheck(configs, d.harnesses));
  const fake = configs.length > 0 && configs.every((c) => isFake(c.model)) && (!e.sim_model || isFake(e.sim_model));
  if (!configs.every((c) => isFake(c.model))) list.push(planCheck(e.plan_commit));
  list.push(splitCheck(e.tasks, e.tasks));
  if (!fake) list.push(budgetCheck(e.budget_usd, e.estimate));
  const counted = list.filter((c) => !c.recorded);
  return { failed: counted.filter((c) => !c.ok), total: counted.length };
});

/** D44: on a calibration run, whether it came out as it should. */
const calibrationText = computed(() => (stats.value?.calibration ? minus(stats.value.calibration.text) : ''));

/** D10: where B dropped or a check got worse, critical first, as the statistics list them. Only a
 *  required critical check is one the guardrail counts, so only it tags a task "critical check got
 *  worse"; an optional one rated critical (the untrusted judge's `overall`) reads "optional". */
const regressions = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const sev = (x: string | null) => (x ? `${x}` : 'not rated');
  const words = (g: { severity: string | null; required: boolean }) => (g.required ? sev(g.severity) : g.severity ? `optional, rated ${g.severity}` : 'optional, not rated');
  const rate = (c: { passed: number; graded: number }) => (c.graded ? `${c.passed} of ${c.graded}` : 'none decided');
  return s.regressions.map((r) => {
    const failedB = r.failed_trials.find((t) => t.arm === 'B') ?? r.failed_trials[0];
    // D64: the causes more common in B than in A on this task, the judge against your label among
    // them, shown at once (7 Nov).
    const grew = (r.causes_grew ?? []).map((c) => ({ key: c.cause, words: causeWord(c.cause), a: c.a, b: c.b }));
    const linked = causeView(failedB?.cause);
    return {
      key: r.task,
      name: r.task_id,
      critical: r.critical && r.graders.some((g) => g.required && g.severity === 'critical'),
      // The list also holds tasks where only a check got worse: B may have passed more there, and
      // such a task holding up beyond noise is a rise, so the tag shows only on a drop.
      beyond: r.beyond_noise && !!r.diff && r.diff.estimate < 0,
      counts: `A ${passedText({ ...r.a, trials: r.a.graded + r.a.incomplete })}, B ${passedText({ ...r.b, trials: r.b.graded + r.b.incomplete })}`,
      diff: r.diff ? `${signed(r.diff.estimate)} (${intervalText(r.diff)})` : 'not in the comparison: an arm has no decided trial',
      graders: r.graders.map((g) => ({ id: g.grader_id, words: `${rate(g.a)} in A, ${rate(g.b)} in B`, severity: words(g) })),
      link: failedB ? href.trial(failedB.trial_id) : null,
      linkText: failedB ? `Open a failed trial (arm ${failedB.arm})` : '',
      linkCause: linked ? linked.name.toLowerCase() : null,
      grew,
    };
  });
});

/** Tasks left out of the comparison, each with why (an arm has no decided trial). */
const excludedTasks = computed(() => stats.value?.excluded_tasks.map((t) => ({ key: t.task, name: t.task_id, why: t.why })) ?? []);

interface Metric {
  name: string;
  delta: string;
  interval: string;
  a: number;
  b: number;
  aText: string;
  bText: string;
  max: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (values: number[]) => (values.length ? values.reduce((x, y) => x + y, 0) / values.length : null);
/** A token difference in the arms' own format: "+23.6k" beside "79.3k", "−420" below a thousand. */
function signedThousands(v: number): string {
  const shown = thousands(Math.abs(v));
  if (shown === '0') return '0';
  return v > 0 ? `+${shown}` : `−${shown}`;
}

const metrics = computed<Metric[]>(() => {
  const d = data.value;
  const t = totals.value;
  if (!d || !t) return [];
  const s = stats.value;
  const out: Metric[] = [];
  const rel = (i: Interval | null, abs: string) => (i ? `${signed(i.estimate)}%, interval ${signed(i.low)}% to ${signed(i.high)}%` : abs);
  if (s) {
    out.push({ name: 'Pass rate', delta: `${signed(s.diff.estimate)} ${Math.abs(Math.round(s.diff.estimate)) === 1 ? 'point' : 'points'}`, interval: `interval ${intervalText(s.diff)} points`, a: s.a.rate, b: s.b.rate, aText: percent(s.a.rate), bText: percent(s.b.rate), max: 1 });
  } else if (t.a.graded && t.b.graded) {
    const ra = t.a.passed / t.a.graded;
    const rb = t.b.passed / t.b.graded;
    out.push({ name: 'Pass rate', delta: `${signed((rb - ra) * 100)} points`, interval: `${t.a.passed} of ${t.a.graded} and ${t.b.passed} of ${t.b.graded}; no interval yet`, a: ra, b: rb, aText: percent(ra), bText: percent(rb), max: 1 });
  }
  // D61's figures written without a tool are shown with each arm's behaviour (BehaviourPanel).
  const costs = s?.costs ?? [];
  if (costs.length) {
    for (const c of costs) {
      if (c.metric === 'cost_usd') out.push({ name: 'Cost per trial', delta: signedMoney(c.diff.estimate), interval: rel(c.relative, `interval ${signedMoney(c.diff.low)} to ${signedMoney(c.diff.high)}`), a: c.a, b: c.b, aText: money(c.a), bText: money(c.b), max: Math.max(c.a, c.b) });
      if (c.metric === 'wall_s') {
        // Retry backoff skews latency: trials whose model call LiteLLM retried waited out its backoff.
        const left = (c.left_out_retried?.a ?? 0) + (c.left_out_retried?.b ?? 0);
        const note = left ? `; ${plural(left, 'trial')} left out: a model call was retried, and its wait would skew the time` : '';
        out.push({ name: 'Time per trial', delta: `${signed(c.diff.estimate, 1)} s`, interval: `${rel(c.relative, `interval ${signed(c.diff.low, 1)} to ${signed(c.diff.high, 1)} s`)}${note}`, a: c.a, b: c.b, aText: seconds(c.a), bText: seconds(c.b), max: Math.max(c.a, c.b) });
      }
      if (c.metric === 'tokens') out.push({ name: 'Tokens per trial', delta: signedThousands(c.diff.estimate), interval: rel(c.relative, `interval ${signedThousands(c.diff.low)} to ${signedThousands(c.diff.high)}`), a: c.a, b: c.b, aText: thousands(c.a), bText: thousands(c.b), max: Math.max(c.a, c.b) });
    }
    return out;
  }
  // Until the statistics step reports costs, show the arm means from the trials, with their N.
  const done = d.trials.filter((x) => x.status === 'done');
  const ta = done.filter((x) => armIndexOf(x, d.detail) === 0);
  const tb = done.filter((x) => armIndexOf(x, d.detail) === 1);
  const n = `N = ${ta.length} and ${tb.length} trials; no interval yet`;
  const pairs: [string, (x: TrialRowSummary) => number | null | undefined, 'mean' | 'median', (v: number) => string, (v: number) => string][] = [
    ['Cost per trial', (x) => x.cost_usd, 'mean', money, signedMoney],
    // The mean, as the statistics' tile gives it once the run is complete, under the same name.
    ['Time per trial', (x) => x.wall_s, 'mean', (v) => seconds(v), (v) => `${signed(v, 1)} s`],
    ['Tokens per trial', (x) => (x.input_tokens ?? 0) + (x.output_tokens ?? 0) || null, 'mean', thousands, signedThousands],
  ];
  for (const [name, pick, how, fmt, fmtDelta] of pairs) {
    const va = ta.map(pick).filter((v): v is number => typeof v === 'number');
    const vb = tb.map(pick).filter((v): v is number => typeof v === 'number');
    const a = how === 'mean' ? mean(va) : median(va);
    const b = how === 'mean' ? mean(vb) : median(vb);
    if (a === null || b === null) continue;
    out.push({ name, delta: fmtDelta(b - a), interval: n, a, b, aText: fmt(a), bText: fmt(b), max: Math.max(a, b) });
  }
  return out;
});

/** A bar's share of its rail: the rail runs from 0 to 100% for pass rate, and from 0 to the
 *  larger arm's value for the rest. */
const barShare = (v: number, max: number) => `${Math.max(0, Math.min(100, (v / (max || 1)) * 100))}%`;

/** Under cost, tokens and time, once the statistics give them intervals: they get no verdict and
 *  no paired test, and a task bootstrap over few tasks covers a little less than it says. On an
 *  A/A run (one config on both arms) an interval of theirs that stays clear of zero is the setup's
 *  own noise, never a finding. Null until the statistics report costs. */
const costsNote = computed(() => {
  const s = stats.value;
  const costs = s?.costs ?? [];
  if (!s || !costs.length) return null;
  const level = Math.round(s.level * 100);
  const tasks = Math.max(...costs.map((c) => c.tasks));
  const general = `Cost, tokens and time get an interval but no verdict: only the pass rate is tested. With ${plural(tasks, 'task')}, a ${level}% interval here holds the true difference a little less often than ${level}% of the time.`;
  const words: Record<string, string> = { cost_usd: 'cost', tokens: 'token', wall_s: 'time' };
  const clear = costs.filter((c) => !noWidth(c.diff) && excludesZero(c.diff)).map((c) => words[c.metric]).filter(Boolean);
  const calibration = !!s.calibration || !!data.value?.detail.calibration;
  const which = clear.length > 1 ? `the ${clear.slice(0, -1).join(', ')} and ${clear[clear.length - 1]} intervals clear of zero here are` : `the ${clear[0]} interval clear of zero here is`;
  const aa = calibration && clear.length ? `Both arms ran the same config, so ${which} the setup's own noise (such as which arm's trials were claimed first, or how loaded the machine was) or chance, not a finding.` : '';
  return { general, aa };
});

interface TaskRow {
  key: string;
  name: string;
  grader: string;
  a: CompareRow | undefined;
  b: CompareRow | undefined;
  diff: Interval | null;
  significant: boolean;
  link: string | null;
  linkTitle: string;
  /** Per arm, a link into that arm's trials of this task (a failed one first); the trial page
   *  lists the arm's other trials of the task. */
  armLinks: [string | null, string | null];
}

/** The trial a per-arm cell opens: that arm's first failed trial of the task, else its first
 *  finished one, else its first at all. */
function armTrial(task: string, arm: 0 | 1): TrialRowSummary | undefined {
  const d = data.value;
  if (!d) return undefined;
  const mine = d.trials.filter((t) => t.task_sha256 === task && armIndexOf(t, d.detail) === arm).sort((x, y) => x.repeat_index - y.repeat_index || x.attempt - y.attempt);
  return mine.find((t) => t.passed === false) ?? mine.find((t) => t.status === 'done') ?? mine[0];
}

function failedTrial(task: string, prefer: 0 | 1): TrialRowSummary | undefined {
  const d = data.value;
  if (!d) return undefined;
  const of = (arm: 0 | 1) => d.trials.find((t) => t.task_sha256 === task && armIndexOf(t, d.detail) === arm && t.passed === false);
  return of(prefer) ?? of(prefer === 1 ? 0 : 1) ?? d.trials.find((t) => t.task_sha256 === task && t.status === 'done');
}

const taskRows = computed<TaskRow[]>(() => {
  const d = data.value;
  if (!d) return [];
  const s = stats.value;
  const base = s
    ? s.tasks.map((t) => ({ key: t.task, diff: t.diff, significant: t.beyond_noise }))
    : d.detail.tasks.map((t) => {
        const a = cell(t.sha256, 0);
        const b = cell(t.sha256, 1);
        const est = a?.graded && b?.graded ? (b.passed / b.graded - a.passed / a.graded) * 100 : null;
        return { key: t.sha256, diff: est === null ? null : { estimate: est, low: est, high: est }, significant: false };
      });
  return base
    .map((r) => {
      // The same trial the "Worth a look" button opens: a failure your label does not dispute.
      const look = lookTrial(r.key);
      const name = taskName(r.key);
      const what = look && look.trial.passed === false ? 'a failed trial' : 'a trial';
      const linkTitle = look ? `Open ${what} of ${name}, arm ${armOfTrial(look.trial).toUpperCase()}${look.disputed ? ' (your label disagrees with the judge)' : ''}` : '';
      return {
        key: r.key,
        name,
        grader: gradedBy(taskOf(r.key)),
        a: cell(r.key, 0),
        b: cell(r.key, 1),
        diff: r.diff,
        significant: r.significant,
        link: look ? href.trial(look.trial.id) : null,
        linkTitle,
        armLinks: [0, 1].map((arm) => {
          const t = armTrial(r.key, arm as 0 | 1);
          return t ? href.trial(t.id) : null;
        }) as [string | null, string | null],
      };
    })
    .sort((x, y) => (y.diff?.estimate ?? -999) - (x.diff?.estimate ?? -999));
});

/** The task plot's x for a difference: ±100 land at 18 and 382, so a round cap at either end
 *  stays inside the cell and sits under the centre of its axis label. */
const fx = (v: number) => 200 + Math.max(-100, Math.min(100, v)) * 1.82;
/** The axis labels, each centred on its tick at the same x the intervals use. */
const AXIS_TICKS = [-100, -50, 0, 50, 100].map((v) => ({ value: v, x: fx(v), label: tick(v) }));
/** Arm colour only for a task whose difference holds up after correction; every other row is grey. */
const lean = (r: TaskRow) => (!r.diff || !r.significant ? 'neutral' : r.diff.estimate >= 0 ? 'b' : 'a');
/** A task row with no difference to show, in words: which arm is still grading, which is
 *  undecided, or which has no trial. "Not graded yet" only while grading has not finished. */
function noDiffWords(r: TaskRow): { tag: string; detail: string } {
  return noDiffFor([armState(r.a), armState(r.b)].slice(0, Math.max(1, Math.min(2, arms.value.length))));
}

/** While the comparison waits for the run, the API gives no counts per task (D37): a task row says
 *  that, never "no finished trial" of a task that has some (QA, 7 Nov). */
const runWait = computed(() =>
  data.value?.compare.status !== 'incomplete' ? null : stoppedRun.value ? { tag: 'No comparison', detail: 'the run was stopped before every trial ran' } : { tag: 'Run not finished', detail: 'the comparison waits for every arm to finish' },
);

function verdictOf(r: TaskRow): { kind: Verdict; label?: string } {
  if (runWait.value) return { kind: 'pending', label: runWait.value.tag };
  if (!r.diff) return { kind: 'pending', label: noDiffWords(r).tag };
  if (!stats.value) return { kind: 'pending' };
  if (r.significant) return { kind: r.diff.estimate >= 0 ? 'better' : 'worse' };
  // Clear of zero on its own, but not once the other comparisons are accounted for.
  if (excludesZero(r.diff)) return { kind: 'none', label: 'Within noise after correction' };
  return { kind: 'none', label: 'Within noise' };
}
const labelOf = (r: TaskRow) => (runWait.value ? runWait.value.detail : !r.diff ? noDiffWords(r).detail : stats.value ? `${signed(r.diff.estimate)} (${intervalText(r.diff)})` : `${signed(r.diff.estimate)}, no interval`);

const differing = computed(() => taskRows.value.filter((r) => r.significant).length);

/** How many tasks differ, and how wide the rest's intervals are: no clear difference at this N is
 *  an absence of evidence, not a finding of no change. */
const taskSummary = computed(() => {
  const d = data.value;
  if (!d || !stats.value) return '';
  const total = taskRows.value.length;
  const n = differing.value;
  const first = `${n} ${n === 1 ? 'task differs' : 'tasks differ'} ${correctionWords.value ? `after ${correctionWords.value} for ${plural(total, 'comparison')}` : 'before any correction for many comparisons'}.`;
  const other = total - n;
  if (!other) return first;
  let line = `${first} The other ${other} ${other === 1 ? 'is' : 'are'} within noise.`;
  // The width of the bounds as shown ("−79 to +79" is 158 wide), not of the unrounded ones.
  const widths = taskRows.value.flatMap((r) => (!r.significant && r.diff ? [shownWidth(r.diff)] : []));
  if (widths.length) {
    const lo = Math.min(...widths);
    const hi = Math.max(...widths);
    const range = lo === hi ? `${lo}` : `${lo} to ${hi}`;
    const per = `At ${plural(d.detail.n, 'trial')} per arm`;
    line += widths.length === 1
      ? ` ${per} its interval is ${range} points wide, so a real change on that task can hide here.`
      : ` ${per} their intervals are ${range} points wide, so a real change on one task can hide here.`;
  }
  return line;
});

const correctionWords = computed(() => {
  // D41: Benjamini-Hochberg is the one correction the statistics apply.
  return stats.value?.correction === 'benjamini_hochberg' ? 'the Benjamini-Hochberg correction' : null;
});

/** What it rests on: how much the judge graded. When the caveat under the figure shows, it already
 *  gives kappa, the bar and whether it is provisional, so this line does not repeat them. */
const judgeLine = computed(() => {
  const j = stats.value?.judge;
  const d = data.value;
  if (!j || !d) return null;
  const scored = `The judge scored ${d.detail.tasks.filter(isJudged).length} of the ${d.detail.tasks.length} tasks`;
  if (caveat.value) return `${scored}, including ${differingShort(differing.value)}.`;
  return `${scored}. Its agreement with you${agreementWords(j, d.queue.length)}`;
});

/** Under the figure: when every task that differs needs the judge's pass, the verdict rests on the judge. */
const caveat = computed(() => {
  const s = stats.value;
  const d = data.value;
  if (!s || !d) return null;
  return judgeCaveat({ differing: taskRows.value.filter((r) => r.significant).map((r) => taskOf(r.key)), isJudged, judge: s.judge, toGo: d.queue.length, alsoGraded: alsoGradedBy });
});

/** When a required LLM judge decided the outcome of some trials in the tasks that differ (review S12). */
const judgeDecided = computed(() => {
  const r = stats.value?.rests_on_judge;
  if (!r || !r.tasks.length) return null;
  const names = r.tasks.map((t) => t.task_id).join(', ');
  if (r.all) return `every task that differs between the arms (${names}) had at least one outcome decided by the LLM judge, so this verdict rests on the judge.`;
  return `${r.tasks.length} of the ${r.differing} tasks that differ (${names}) had at least one outcome decided by the LLM judge.`;
});

/** On a phone the column heads are hidden, so the shared axis says what its intervals are. */
const axisCaption = computed(() => {
  const level = stats.value ? Math.round(stats.value.level * 100) : 95;
  const verdicts = correctionWords.value ? `verdicts after ${correctionWords.value} for ${plural(taskRows.value.length, 'task')}.` : 'verdicts not corrected either.';
  return `B minus A, in points. ${level}% intervals, not corrected; ${verdicts}`;
});

/** Trials whose failure a human label disputes: where it says yes and the judge no, from the judges'
 *  trust (D83), which lists every disagreement with its trial. A label that says no where the judge
 *  said yes is stricter than the judge: it agrees the output is bad, so it disputes no failure. */
const disputedTrials = computed(() => {
  const d = data.value;
  const fromTrust = (d?.trust ?? []).flatMap((j) => j.criteria.flatMap((c) => c.disagreements.filter((x) => x.human === 'yes' && x.judge === 'no').map((x) => x.trial_id)));
  return new Set(fromTrust.filter((id): id is string => !!id));
});

/** The failed trial to open for a task: arm B first, then arm A, skipping any trial whose judge
 *  verdict a label disputes, since that failure may not be the agent's. When every failure is
 *  disputed, the disputed one is still offered, and the button says so. */
function lookTrial(task: string): { trial: TrialRowSummary; disputed: boolean } | null {
  const d = data.value;
  if (!d) return null;
  const disputed = disputedTrials.value;
  const failedIn = (arm: 0 | 1) => d.trials.filter((t) => t.task_sha256 === task && armIndexOf(t, d.detail) === arm && t.passed === false);
  const failed = [...failedIn(1), ...failedIn(0)];
  const clean = failed.find((t) => !disputed.has(t.id));
  if (clean) return { trial: clean, disputed: false };
  if (failed[0]) return { trial: failed[0], disputed: true };
  const any = failedTrial(task, 1);
  return any ? { trial: any, disputed: false } : null;
}

/** The drop with the strongest evidence: one that holds up after correction, then one whose interval
 *  stays below zero, then the lower p-value, and only then the larger drop. Two drops of −40 were
 *  told apart by order alone, and the one whose interval crossed zero (p 0.17) was picked over the
 *  one below zero (p 0.087) (QA, 7 Nov). */
const worthALook = computed(() => {
  const s = stats.value;
  const p = (r: TaskRow) => s?.tasks.find((t) => t.task === r.key)?.p_value ?? 1;
  const below = (r: TaskRow) => (r.diff && r.diff.high < 0 ? 1 : 0);
  const candidates = taskRows.value.filter((r) => r.diff && r.diff.estimate < 0);
  const worst = [...candidates].sort((x, y) => Number(y.significant) - Number(x.significant) || below(y) - below(x) || p(x) - p(y) || (x.diff?.estimate ?? 0) - (y.diff?.estimate ?? 0))[0];
  if (!worst || !worst.diff || !s) return null;
  // The heading claims no more than the statistics: "got worse" only when it holds up.
  const title = worst.significant ? `Worth a look: ${worst.name} got worse` : `Worth a look: ${worst.name} fell from ${passedText(worst.a)} to ${passedText(worst.b)}`;
  const numbers = `(${signed(worst.diff.estimate)}, interval ${intervalText(worst.diff)})`;
  const finding = worst.significant
    ? `B passed ${passedText(worst.b)}, A passed ${passedText(worst.a)}. This difference holds up ${numbers}.`
    : excludesZero(worst.diff)
      ? `Within noise after correcting for ${s.tasks.length} tasks ${numbers}.`
      : `Within noise: its interval includes zero even before correcting for ${s.tasks.length} tasks ${numbers}.`;
  const look = lookTrial(worst.key);
  return {
    row: worst,
    title,
    text: `${finding} Open the failed trials to see whether the agent or the grader is behind it.`,
    link: look ? href.trial(look.trial.id) : null,
    button: look?.disputed ? 'Open a failed trial (your label disagrees with the judge)' : 'Open a failed trial',
  };
});

/** A shipped example's judge, read-only: whether its verdicts count, and when a judge may (D63, D83).
 *  A judge check counts only where its task file marks it required (a grader spec is required unless
 *  it says false, as the grader reads it); trust never changes a grade or a verdict. */
const exampleJudgeWords = computed(() => {
  const tasks = data.value?.detail.tasks ?? [];
  const counted = tasks.filter((t) => t.graders.some((g) => typeof g === 'object' && g !== null && !Array.isArray(g) && (g.kind === 'judge' || g.type === 'judge') && g.required !== false)).length;
  const on = counted === tasks.length ? (counted === 1 ? 'its one task' : `all ${counted} tasks`) : `${counted} of the ${tasks.length} tasks`;
  const where = counted
    ? `and they count in the verdicts on ${on}, where the task file marks the judge check required.`
    : 'but no task here marks its judge check required, so they count in nothing.';
  return `This run's trials were also graded by an LLM judge. Its verdicts are on each trial page, ${where} A judge criterion may count in a verdict only once it agrees with people's labels well enough, and then only where its task file marks it required; nothing does that by itself, and the badges below change no grade.`;
});
</script>

<template>
  <NotFound
    v-if="missing"
    :crumbs="[{ href: href.experiments(), text: 'Experiments' }]"
    title="No experiment with that id"
    :item-id="experimentId"
  >
    <a :href="href.experiments()">Experiments</a> lists every run, and <a :href="href.runNew()">Set up a run</a> starts a new one.
  </NotFound>
  <LoadState
    v-else
    :loading="loading"
    :error="error"
    what="this comparison"
  >
    <template v-if="data">
      <div class="head-row">
        <div class="page-head">
          <nav
            aria-label="Breadcrumb"
            class="crumbs"
          >
            <a :href="href.experiments()">Experiments</a> / {{ experimentName(data.detail) }}
          </nav>
          <h1 tabindex="-1">
            {{ experimentName(data.detail) }}
          </h1>
          <p
            v-if="data.detail.example"
            class="caveat example-note"
            data-test="example-note"
          >
            <AppIcon
              name="info"
              :size="14"
            />
            <span><strong class="caveat-lead">Shipped example:</strong> a finished run that came with the repo, loaded into your local database as it was recorded. It is read-only: nothing here runs, regrades or judges it, and it is left out of your spend and the label queue.</span>
          </p>
          <div
            class="arms-line small"
            data-test="arms-line"
          >
            <span
              v-for="arm in arms"
              :key="arm.key"
              class="arm"
              data-test="arm-name"
            ><span :class="`dot dot--${arm.key}`" /><span>{{ arm.key.toUpperCase() }}: {{ arm.label }}<template v-if="armPin(arm)">{{ ' ' }}<span
              class="mono"
              data-test="arm-pin"
            >{{ armPin(arm) }}</span></template><template v-if="!namedByHash(arm)"> (config <span class="mono">{{ shortHash(arm.hash) }}</span>)</template></span></span>
          </div>
          <!-- What A and B differ in, with both values, from the two saved configs. -->
          <div
            v-if="differences"
            class="differs small"
            data-test="arm-differences"
          >
            <span class="differs-lead">What differs</span>
            <ul
              v-if="differences.list.length"
              class="differs-list"
            >
              <li
                v-for="d in differences.list"
                :key="d.what"
                data-test="arm-difference"
              >
                {{ d.what }}: <span class="differs-value">{{ d.a }}</span> in A, <span class="differs-value">{{ d.b }}</span> in B
              </li>
            </ul>
            <p
              v-else-if="differences.same"
              class="differs-list"
            >
              Nothing: both arms run the same config, so any difference between them is the noise of the setup.
            </p>
            <p
              v-else
              class="differs-list"
            >
              Nothing this page can name, though the two configs are not the same. Open <a :href="href.configPage(arms[0].hash)">arm A's config</a> and <a :href="href.configPage(arms[1].hash)">arm B's</a> to compare them.
            </p>
          </div>
          <!-- Line 2: what the arms share, then the run's size and commits. Each group stays whole;
               the line breaks only between groups. -->
          <p
            class="meta-line small secondary"
            data-test="meta-line"
          >
            <template v-if="meta.harness || meta.rest">
              <span
                class="nowrap"
                data-test="setup"
              >{{ meta.harness }}<template v-if="meta.pin">{{ ' ' }}<span class="mono">{{ meta.pin }}</span></template>{{ meta.rest }}</span> ·
            </template><template v-if="simClient">
              <span
                class="nowrap"
                data-test="sim-client"
              >simulated client {{ simClient }}</span> ·
            </template><span class="nowrap">{{ plural(totalTrials(data.detail), 'trial') }}</span><template v-if="commits.plan">
              · <a
                :href="href.run(data.detail.id)"
                class="secondary nowrap"
                data-test="plan-commit"
              >plan <span class="mono">{{ commits.plan }}</span> (recorded, not checked)</a>
            </template><template v-if="commits.platform">
              · <span
                class="nowrap"
                data-test="platform-commit"
              >platform <span class="mono">{{ commits.platform }}</span></span>
            </template>
          </p>
        </div>
        <div class="actions">
          <div class="action-buttons">
            <a
              v-if="data.detail.status === 'running' || data.detail.status === 'created' || data.detail.status === 'paused'"
              :href="href.run(data.detail.id)"
              class="btn btn--quiet"
            >See the run</a>
            <template v-if="!fixtures">
              <a
                :href="api.exportUrl(data.detail.id, 'csv')"
                class="btn btn--quiet"
                download
              >Export CSV</a>
              <a
                :href="api.exportUrl(data.detail.id, 'json')"
                class="btn btn--quiet"
                download
              >Export JSON</a>
            </template>
            <button
              v-else
              type="button"
              class="btn btn--quiet"
              disabled
              title="Export needs the API; sample data has nothing to export"
            >
              Export CSV
            </button>
          </div>
          <p
            v-if="fixtures"
            class="secondary smaller export-note"
            data-test="export-note"
          >
            Export needs the API
          </p>
        </div>
      </div>

      <section
        aria-labelledby="verdict"
        class="panel verdict"
        data-test="verdict"
      >
        <div class="verdict-main">
          <template v-if="stats && hero">
            <h2
              id="verdict"
              class="verdict-title"
              data-test="verdict-title"
            >
              {{ verdictTitle(stats, arms) }}
            </h2>
            <p class="verdict-text">
              <strong class="num">{{ heroText?.big }}</strong>{{ heroText?.rest }}
            </p>
            <p
              v-if="verdictSub"
              class="verdict-sub"
              data-test="verdict-sub"
            >
              {{ verdictSub }}
            </p>
            <IntervalStrip
              :min="hero.min"
              :max="hero.max"
              :ticks="hero.ticks"
              :rows="hero.rows"
              :reference="{ value: 0, dashed: true }"
              :summary="hero.aria"
            />
            <p
              v-if="stats.calibration"
              class="caveat"
              :class="{ 'caveat--alarm': !stats.calibration.as_expected }"
              data-test="calibration-note"
            >
              <AppIcon
                :name="stats.calibration.as_expected ? 'info' : 'alert'"
                :size="14"
              />
              <span><strong class="caveat-lead">{{ stats.calibration.as_expected ? 'A/A calibration, as it should be' : 'A/A calibration found a difference' }}:</strong> {{ calibrationText }}</span>
            </p>
            <p
              v-if="critical"
              class="caveat"
              :class="{ 'caveat--alarm': critical.alarm }"
              data-test="critical"
            >
              <AppIcon
                :name="critical.alarm ? 'alert' : 'info'"
                :size="14"
              />
              <span><strong class="caveat-lead">Guardrail:</strong> {{ critical.text }}</span>
            </p>
            <p
              v-if="stats.unequal_decided"
              class="caveat caveat--alarm"
              data-test="unequal-decided"
            >
              <AppIcon
                name="alert"
                :size="14"
              />
              <span><strong class="caveat-lead">Uneven trial counts:</strong> {{ stats.unequal_decided.text }}</span>
            </p>
            <p
              v-if="stats.missing_trials"
              class="caveat caveat--alarm"
              data-test="missing-trials"
            >
              <AppIcon
                name="alert"
                :size="14"
              />
              <span><strong class="caveat-lead">Missing trials:</strong> {{ stats.missing_trials.text }}</span>
            </p>
            <p
              v-if="judgeDecided"
              class="caveat"
              data-test="judge-decided"
            >
              <AppIcon
                name="alert"
                :size="14"
              />
              <span><strong class="caveat-lead">Decided by the judge:</strong> {{ judgeDecided }}</span>
            </p>
            <p
              v-if="caveat"
              class="caveat"
              data-test="judge-caveat"
            >
              <AppIcon
                name="alert"
                :size="14"
              />
              <span><strong class="caveat-lead">{{ caveat.lead }}:</strong> <template
                v-for="(part, pi) in identParts(caveat.before, caveat.idents)"
                :key="pi"
              ><span
                v-if="part.ident"
                class="mono"
              >{{ part.text }}</span><template v-else>{{ part.text }}</template></template><a :href="href.judge()">{{ caveat.link }}</a>{{ caveat.after }}</span>
            </p>
            <p
              v-if="optionalVersionsNote"
              class="caveat"
              data-test="grader-versions-note"
            >
              <AppIcon
                name="info"
                :size="14"
              />
              <span><strong class="caveat-lead">Optional checks graded differently:</strong> {{ optionalVersionsNote }}</span>
            </p>
          </template>
          <template v-else-if="incomplete">
            <h2
              id="verdict"
              class="verdict-title"
              data-test="verdict-title"
            >
              {{ stoppedRun ? 'No comparison: this run was cancelled' : 'No comparison until every arm is complete' }}
            </h2>
            <p
              class="verdict-text"
              data-test="incomplete-reason"
            >
              {{ incomplete }}
            </p>
            <div
              v-for="p in pausedBeforeStop"
              :key="p.letter"
              class="paused-note small"
              data-test="paused-before-stop"
            >
              <p>{{ p.lead }}</p>
              <p
                v-if="p.message"
                class="provider-message"
                data-test="provider-message"
              >
                {{ p.message }}
              </p>
              <p
                v-if="p.cut"
                class="secondary smaller"
              >
                The record keeps the first {{ PROVIDER_MESSAGE_KEPT }} characters of it.
              </p>
            </div>
            <ul
              class="arm-progress small"
              data-test="arm-progress"
            >
              <li
                v-for="a in armProgress"
                :key="a.letter"
              >
                <span class="arm"><span :class="`dot dot--${a.key}`" /><span><strong>{{ a.letter }}</strong>: {{ a.name }}, {{ a.status }}, <span class="num">{{ a.done }} of {{ a.total }}</span> done</span></span>
              </li>
            </ul>
            <a
              :href="href.run(data.detail.id)"
              class="btn btn--quiet incomplete-link"
            >Open the run</a>
          </template>
          <template v-else>
            <h2
              id="verdict"
              class="verdict-title"
              data-test="verdict-title"
            >
              {{ notAlike ? 'No verdict: the arms were not graded alike' : 'No verdict yet' }}
            </h2>
            <p
              v-if="totals"
              class="verdict-text"
            >
              {{ noVerdictText }}
            </p>
          </template>
          <p
            v-if="fakeRunNote"
            class="caveat"
            data-test="fake-run-note"
          >
            <AppIcon
              name="info"
              :size="14"
            />
            <span><strong class="caveat-lead">Scripted test outputs:</strong> {{ fakeRunNote }}</span>
          </p>
          <template v-if="worthALook">
            <!-- Takes the free height, so the next step sits at the foot of the answer column. -->
            <div
              class="push"
              aria-hidden="true"
            />
            <div
              class="look"
              data-test="worth-a-look"
            >
              <h3
                id="look"
                class="look-title"
              >
                {{ worthALook.title }}
              </h3>
              <p class="look-body">
                {{ worthALook.text }}
              </p>
              <a
                v-if="worthALook.link"
                :href="worthALook.link"
                class="btn look-btn"
                data-test="look-link"
              >{{ worthALook.button }}</a>
            </div>
          </template>
        </div>
        <div
          v-if="stats"
          class="verdict-why small"
        >
          <h3
            class="why-title"
            data-test="why-title"
          >
            {{ whyTitle }}
          </h3>
          <p
            v-for="(line, i) in why"
            :key="i"
            data-test="why-line"
          >
            {{ line }}
          </p>
          <p
            v-if="!stats.aa && !stats.calibration"
            data-test="no-aa"
          >
            No A/A calibration run for these configs yet, so the setup’s own noise has not been measured on a run where nothing changed.
            <a
              v-if="aaSetup && !data.detail.example"
              :href="aaSetup"
              data-test="aa-setup"
            >Set one up</a>
          </p>
          <h3
            class="why-title rests-title"
            data-test="why-title"
          >
            What it rests on
          </h3>
          <p
            v-if="judgeLine"
            data-test="judge-line"
          >
            {{ judgeLine }} <a :href="href.judge()">See judge agreement</a>
          </p>
          <div
            v-if="preStart && preStart.failed.length"
            class="caveat caveat--alarm prestart"
            data-test="prestart-failed"
          >
            <AppIcon
              name="alert"
              :size="14"
            />
            <div>
              <p>
                <strong class="caveat-lead">Checked before the start:</strong> {{ preStart.failed.length }} of {{ preStart.total }} failed, so read the result with that in mind. <a :href="href.run(data.detail.id)">See the checks</a>
              </p>
              <ul class="prestart-list">
                <li
                  v-for="c in preStart.failed"
                  :key="c.title"
                  data-test="prestart-check"
                >
                  <strong>{{ c.title }}.</strong> {{ c.detail }}
                </li>
              </ul>
            </div>
          </div>
          <div class="infra">
            <p
              class="secondary"
              data-test="infra-sentence"
            >
              <template v-if="infraCount">
                {{ infraSentence }}<template v-if="!infraTrials.length">
                  {{ ' ' }}<a :href="href.run(data.detail.id)">See them on the run page</a>
                </template>
              </template>
              <template v-else>
                No trial stopped on an infra failure.
              </template>
            </p>
            <ul
              v-if="infraTrials.length"
              class="infra-list"
              data-test="infra-list"
            >
              <li
                v-for="r in infraRows"
                :key="r.trial.id"
                data-test="infra-row"
              >
                <a
                  :href="href.trial(r.trial.id)"
                  class="infra-link"
                ><span
                  :class="`dot dot--${r.arm}`"
                  aria-hidden="true"
                /><span class="infra-text">{{ r.arm.toUpperCase() }} · <span class="mono infra-task">{{ r.task }}</span> · attempt {{ r.trial.attempt }} · <span class="secondary nowrap">{{ r.cause }}</span> · {{ r.rerun }}</span></a>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <!-- How the judge checks get graded, by the verdict they feed; the task table stays last. -->
      <!-- Nothing to judge on a run with no finished trial of a judged task: no approval is offered. -->
      <JudgePanel
        v-if="!data.detail.example && (data.detail.judge || (judged.tasks && judged.trials))"
        :experiment-id="data.detail.id"
        :judge="data.detail.judge ?? null"
        :judged-trials="judged.trials"
        :judged-tasks="judged.tasks"
        :fake-arms="fakeArms"
        :trust="data.trust"
        :calibrate-href="calibrateHref"
        @changed="refreshJudge"
      />

      <!-- A shipped example's judges, read-only (D83): no approval, regrade or calibrating here. -->
      <section
        v-if="data.detail.example && data.trust && data.trust.length"
        aria-labelledby="example-judge"
        class="stack"
        data-test="example-judge-trust"
      >
        <h2
          id="example-judge"
          class="section-title"
        >
          LLM judge
        </h2>
        <p
          class="small"
          data-test="example-judge-words"
        >
          {{ exampleJudgeWords }}
        </p>
        <ul class="example-trust-list">
          <li
            v-for="j in data.trust"
            :key="`${j.judge_model} ${j.rubric}`"
            data-test="example-judge-row"
          >
            <span class="small"><span class="strong">{{ modelName(j.judge_model) }}</span>, rubric <span class="mono">{{ rubricName(j.rubric) }}</span></span>
            <TrustBadge :status="j.status" />
            <span class="small secondary example-trust-summary">{{ plainText(j.summary) }}</span>
          </li>
        </ul>
        <a
          class="small"
          :href="href.judge()"
          data-test="example-judge-link"
        >Every question, on the judge page</a>
      </section>

      <section
        v-if="metrics.length"
        aria-labelledby="costs"
        class="stack"
      >
        <h2
          id="costs"
          class="section-title"
        >
          Pass rate and what it costs
        </h2>
        <p
          v-if="fakeArms"
          class="caveat"
          data-test="fake-cost-note"
        >
          <AppIcon
            name="info"
            :size="14"
          />
          <span><strong class="caveat-lead">Made-up prices:</strong> {{ fakeArms }} ran on a fake model, whose replies are scripted and whose prices are invented for testing. These costs show how the platform counts, not what a real model would cost.</span>
        </p>
        <div class="stat-strip metrics">
          <div
            v-for="m in metrics"
            :key="m.name"
          >
            <span class="stat-label">{{ m.name }}</span>
            <span class="metric-delta num">{{ m.delta }}</span>
            <span class="secondary smaller num block">{{ m.interval }}</span>
            <!-- Each bar sits on a rail that is the tile's scale: 0 to 100% for pass rate, 0 to the
                 larger arm's value for the rest. -->
            <div
              class="bars"
              role="img"
              :aria-label="`${m.name}: A ${m.aText}, B ${m.bText}`"
            >
              <span class="bar-label num">A {{ m.aText }}</span>
              <span class="rail"><span
                class="bar bar--a"
                data-test="bar-a"
                :style="{ width: barShare(m.a, m.max) }"
              /></span>
              <span class="bar-label num">B {{ m.bText }}</span>
              <span class="rail"><span
                class="bar bar--b"
                data-test="bar-b"
                :style="{ width: barShare(m.b, m.max) }"
              /></span>
            </div>
          </div>
        </div>
        <p
          v-if="costsNote"
          class="secondary small"
          data-test="costs-note"
        >
          {{ costsNote.general }}
        </p>
        <p
          v-if="costsNote?.aa"
          class="caveat"
          data-test="costs-aa-note"
        >
          <AppIcon
            name="info"
            :size="14"
          />
          <span><strong class="caveat-lead">A/A run:</strong> {{ costsNote.aa }}</span>
        </p>
      </section>

      <BehaviourPanel
        v-if="data.compare.behaviour"
        :behaviour="data.compare.behaviour"
        :prose="data.compare.prose_figures ?? []"
      />

      <section
        v-if="stats"
        aria-labelledby="regressions"
        class="stack"
        data-test="regressions"
      >
        <h2
          id="regressions"
          class="section-title"
        >
          Where B dropped
        </h2>
        <p
          v-if="!regressions.length"
          class="secondary"
        >
          No task where B passed less than A, and no check that got worse.
        </p>
        <template v-else>
          <p class="secondary small">
            Every task where B passed less, or where a check passed less often in B, whether or not it holds up after correction; required checks marked critical first. An optional check decides no outcome. A flag means look here, not a verdict.
          </p>
          <ul class="regression-list">
            <li
              v-for="r in regressions"
              :key="r.key"
              class="regression"
              data-test="regression"
            >
              <div class="regression-head">
                <span class="mono regression-name">{{ r.name }}</span>
                <span
                  v-if="r.critical"
                  class="regression-tag regression-tag--critical"
                >critical check got worse</span>
                <span
                  v-if="r.beyond"
                  class="regression-tag"
                >beyond noise</span>
                <span class="secondary small num">{{ r.counts }}; {{ r.diff }}</span>
              </div>
              <ul
                v-if="r.graders.length"
                class="regression-graders small"
              >
                <li
                  v-for="g in r.graders"
                  :key="g.id"
                  data-test="regression-grader"
                >
                  <span class="mono">{{ g.id }}</span> ({{ g.severity }}): <span class="num">{{ g.words }}</span>
                </li>
              </ul>
              <p
                v-if="r.grew.length"
                class="small regression-causes"
                data-test="regression-causes"
              >
                <span class="secondary">More common in B:</span>{{ ' ' }}<template
                  v-for="(c, ci) in r.grew"
                  :key="c.key"
                >
                  <span class="nowrap">{{ c.words }}, <span class="num">{{ c.a }} → {{ c.b }}</span></span>{{ ci < r.grew.length - 1 ? '; ' : '' }}
                </template>
              </p>
              <p
                v-if="r.link"
                class="small"
              >
                <a :href="r.link">{{ r.linkText }}</a><span
                  v-if="r.linkCause"
                  class="secondary"
                  data-test="regression-link-cause"
                > · {{ r.linkCause }}</span>
              </p>
            </li>
          </ul>
        </template>
      </section>

      <section
        aria-labelledby="tasks"
        class="stack"
      >
        <div class="head-row head-row--baseline">
          <h2
            id="tasks"
            class="section-title"
          >
            Task by task
          </h2>
          <p
            v-if="stats"
            class="secondary small task-summary"
            data-test="task-summary"
          >
            {{ taskSummary }}
          </p>
        </div>
        <div class="table-wrap">
          <table
            class="table forest"
            data-test="forest"
          >
            <thead>
              <tr class="col-heads">
                <th scope="col">
                  Task
                </th>
                <th scope="col">
                  Graded by
                </th>
                <th
                  scope="col"
                  class="right"
                >
                  A passed
                </th>
                <th
                  scope="col"
                  class="right"
                >
                  B passed
                </th>
                <th
                  scope="col"
                  class="plot-col"
                >
                  Difference in points, B minus A, {{ stats ? Math.round(stats.level * 100) : 95 }}% interval (not corrected)
                </th>
                <th scope="col">
                  Verdict
                </th>
              </tr>
              <tr
                aria-hidden="true"
                class="axis-row"
              >
                <td colspan="4" />
                <td class="axis-cell">
                  <span
                    class="axis-caption"
                    data-test="axis-caption"
                  >{{ axisCaption }}</span>
                  <svg
                    viewBox="0 0 400 18"
                    width="100%"
                    data-test="axis"
                  >
                    <template
                      v-for="t in AXIS_TICKS"
                      :key="t.value"
                    >
                      <text
                        :x="t.x"
                        y="13"
                        :class="t.value === 0 ? 'axis-label axis-label--zero' : 'axis-label'"
                        text-anchor="middle"
                        data-test="axis-label"
                      >{{ t.label }}</text>
                      <!-- A stub under each label; at zero it is the top of the zero line, which the
                           cells below carry on. -->
                      <line
                        :x1="t.x"
                        :x2="t.x"
                        y1="15"
                        y2="18"
                        :class="t.value === 0 ? 'zero-stub' : 'tick-stub'"
                        data-test="axis-stub"
                      />
                    </template>
                  </svg>
                </td>
                <td />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in taskRows"
                :key="r.key"
                data-test="forest-row"
              >
                <th
                  scope="row"
                  class="c-task"
                >
                  <a
                    v-if="r.link"
                    :href="r.link"
                    :title="r.linkTitle"
                    :aria-label="r.linkTitle"
                    class="mono task-link"
                  >{{ r.name }}</a>
                  <span
                    v-else
                    class="mono"
                  >{{ r.name }}</span>
                </th>
                <td class="secondary c-grader">
                  <span class="phone-only">Graded by </span>{{ r.grader }}
                </td>
                <td class="right num c-a">
                  <a
                    v-if="r.armLinks[0]"
                    :href="r.armLinks[0]"
                    class="cell-link"
                    :aria-label="`Arm A on ${r.name}: ${passedText(r.a)} passed. Open its trials of this task`"
                    data-test="cell-a"
                  ><span class="phone-only">A{{ NBSP }}</span>{{ passedText(r.a) }}</a>
                  <template v-else>
                    <span class="phone-only">A{{ NBSP }}</span>{{ passedText(r.a) }}
                  </template>
                </td>
                <td class="right num c-b">
                  <a
                    v-if="r.armLinks[1]"
                    :href="r.armLinks[1]"
                    class="cell-link"
                    :aria-label="`Arm B on ${r.name}: ${passedText(r.b)} passed. Open its trials of this task`"
                    data-test="cell-b"
                  ><span class="phone-only">B{{ NBSP }}</span>{{ passedText(r.b) }}</a>
                  <template v-else>
                    <span class="phone-only">B{{ NBSP }}</span>{{ passedText(r.b) }}
                  </template>
                </td>
                <td
                  class="plot-cell"
                  :class="{ 'plot-cell--empty': !r.diff }"
                >
                  <svg
                    v-if="r.diff"
                    viewBox="0 0 400 26"
                    width="100%"
                    role="img"
                    :aria-label="`${r.name}: ${signed(r.diff.estimate)} points${stats ? `, interval ${intervalText(r.diff)}` : ''}`"
                  >
                    <line
                      :x1="fx(r.diff.low)"
                      :x2="fx(r.diff.high)"
                      y1="13"
                      y2="13"
                      :class="`ci ci--${lean(r)}`"
                    />
                    <circle
                      :cx="fx(r.diff.estimate)"
                      cy="13"
                      r="6"
                      :class="`pt pt--${lean(r)}`"
                    />
                  </svg>
                </td>
                <td
                  class="c-verdict"
                  data-test="task-verdict"
                >
                  <VerdictTag
                    :verdict="verdictOf(r).kind"
                    :label="verdictOf(r).label"
                  />
                  <span class="result-detail">{{ labelOf(r) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div
          v-if="excludedTasks.length"
          class="secondary small"
          data-test="excluded-tasks"
        >
          <p>Left out of the comparison, because an arm has no decided trial on them:</p>
          <ul class="excluded-list">
            <li
              v-for="t in excludedTasks"
              :key="t.key"
            >
              <span class="mono">{{ t.name }}</span>: {{ t.why }}
            </li>
          </ul>
        </div>
      </section>
    </template>
  </LoadState>
</template>

<style scoped>
.prestart-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

.prestart-list li + li {
  margin-top: 4px;
}

.arm-progress {
  list-style: none;
  margin: 4px 0 14px;
  padding: 0;
  display: grid;
  gap: 6px;
}

.incomplete-link {
  align-self: flex-start;
}

.paused-note {
  display: grid;
  gap: 6px;
  margin: 0 0 14px;
  max-width: 72ch;
}

/* A provider's message is one long line of text: it wraps anywhere rather than run off the box. */
.provider-message {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--ground);
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.arms-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin-top: 10px;
}

.meta-line {
  margin-top: 6px;
}

/* What the arms differ in: a label, then one line per difference, each with both values. */
.differs {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  margin-top: 8px;
}

.differs-lead {
  flex: none;
  color: var(--ink-2);
}

.differs-list {
  flex: 1 1 260px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 2px;
  text-wrap: pretty;
}

.differs-value {
  font-weight: 500;
}

.nowrap {
  white-space: nowrap;
}

/* The export controls sit top right, level with the h1. */
.page-head {
  flex: 1 1 560px;
  min-width: 0;
}

.actions {
  flex: none;
  margin-left: auto;
  margin-top: 26px;
  align-self: flex-start;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.action-buttons {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.export-note {
  text-align: right;
}

.verdict {
  display: flex;
  flex-wrap: wrap;
  border-radius: 14px;
}

.verdict-main {
  flex: 999 1 620px;
  min-width: 0;
  padding: 30px 34px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.verdict-title {
  font-size: 40px;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.verdict-text {
  font-size: 18px;
  max-width: 60ch;
}

.verdict-text strong {
  font-weight: 600;
}

.verdict-sub {
  max-width: 60ch;
  color: var(--ink-2);
}

/* A caveat that changes the reading (critical failures rose; an A/A run found a difference). */
.caveat--alarm .caveat-lead {
  color: var(--warning);
}

.regression-list,
.excluded-list,
.regression-graders {
  list-style: none;
  margin: 0;
  padding: 0;
}

.regression-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--rule-soft);
}

.regression {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 0;
  border-bottom: 1px solid var(--rule-soft);
  min-width: 0;
}

.regression-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  min-width: 0;
}

.regression-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.regression-tag {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--rule);
  color: var(--ink-2);
}

.regression-tag--critical {
  border-color: var(--warning);
  color: var(--warning);
  font-weight: 600;
}

.regression-graders li,
.excluded-list li {
  overflow-wrap: anywhere;
}

.regression-causes {
  text-wrap: pretty;
}

.verdict-why {
  flex: 1 1 400px;
  min-width: 0;
  padding: 30px;
  border-left: 1px solid var(--rule-soft);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.why-title {
  font-size: 15px;
}

.rests-title {
  margin-top: 20px;
}

.push {
  flex: 1 0 0;
}

/* The next step, at the foot of the answer column. */
.look {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  border-top: 1px solid var(--rule);
  padding-top: 16px;
}

.look-title {
  font-size: 15px;
}

.look-body {
  max-width: 72ch;
  font-size: 15px;
}

.look-btn {
  margin-top: 8px;
}

.metrics {
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
}

.metric-delta {
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

.axis-caption {
  display: none;
}

.head-row--baseline {
  align-items: baseline;
}

/* No single word left on a line of its own. */
.task-summary {
  text-wrap: pretty;
}

.forest {
  min-width: 980px;
}

.forest th,
.forest td {
  vertical-align: middle;
}

.plot-col {
  width: 420px;
}

/* One dashed zero line down the whole plot column. Each cell draws its piece at the SVG's x = 200,
   which is the cell's centre because its left and right padding are equal, and reaches over the
   row rule below it. The SVG sits above the line, so dots and intervals cover it. */
.axis-cell,
.plot-cell {
  position: relative;
  padding-top: 4px;
  padding-bottom: 4px;
}

.axis-cell::before,
.plot-cell::before {
  content: '';
  position: absolute;
  z-index: 0;
  top: 0;
  bottom: -1px;
  left: 50%;
  border-left: 1px dashed var(--ink-2);
  pointer-events: none;
}

/* In the axis row the line starts under the zero label, at the foot of the axis. */
.axis-cell::before {
  top: auto;
  height: 5px;
}

.axis-cell svg {
  display: block;
}

.axis-cell svg,
.plot-cell svg {
  position: relative;
  z-index: 1;
}

.zero-stub {
  stroke: var(--ink-2);
  stroke-dasharray: 3 3;
}

.tick-stub {
  stroke: var(--ink-2);
}

.axis-label {
  font-size: 12px;
  fill: var(--ink-2);
}

.axis-label--zero {
  fill: var(--ink);
}

.task-link {
  color: var(--ink);
}

.ci {
  stroke-width: 3;
  stroke-linecap: round;
}

.ci--a {
  stroke: var(--arm-a);
}

.ci--b {
  stroke: var(--arm-b);
}

.ci--neutral {
  stroke: var(--neutral-line);
}

.pt {
  stroke: var(--surface);
  stroke-width: 2;
}

.pt--a {
  fill: var(--arm-a);
}

.pt--b {
  fill: var(--arm-b);
}

.pt--neutral {
  fill: var(--neutral-dot);
}

.infra {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.infra-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* One underline, on the task id: the arm, attempt, cause and re-run read as plain text beside it. */
.infra-link {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 32px;
  padding: 5px 0;
  color: var(--ink);
  text-decoration: none;
}

.infra-link .dot {
  /* Level with the first line of a row that wraps. */
  margin-top: 0.45em;
  margin-top: calc((1lh - 10px) / 2);
}

.infra-task {
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
}

.infra-link:hover .infra-task {
  text-decoration-color: var(--ink);
}

.phone-only {
  display: none;
}

@media (max-width: 640px) {
  .verdict-main {
    padding: 22px 20px;
  }

  .verdict-why {
    padding: 20px;
    border-left: 0;
    border-top: 1px solid var(--rule-soft);
  }

  .verdict-title {
    font-size: 32px;
  }

  .verdict-text {
    font-size: 16px;
  }

  .actions {
    margin-top: 0;
  }
}

/* Below the width the six columns need (980 px of table inside the page's padding), Task by task
   becomes one card per task, with no column hidden and nothing to scroll sideways: the shared axis
   once at the top, then for each task its id (wrapping at its hyphens), its verdict, its interval
   across the card, the two arms' counts, and its graders. Each card draws its own piece of the
   zero line, inside the plot only, so it never runs through text. */
@media (max-width: 1099px) {
  .table.forest .axis-caption {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--ink-2);
  }

  .table.forest,
  .table.forest thead,
  .table.forest tbody {
    display: block;
    min-width: 0;
  }

  .table.forest .col-heads {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .table.forest .axis-row {
    display: block;
  }

  .table.forest .axis-row > td {
    display: none;
  }

  .table.forest .axis-row > td.axis-cell {
    display: block;
    padding: 10px 16px 4px;
    border-bottom: 1px solid var(--rule);
  }

  /* The plot keeps a readable height on a wide card: at most 640 px across, centred, so its zero
     stays at the card's centre like the axis's. */
  .table.forest .axis-cell svg,
  .table.forest .plot-cell svg {
    display: block;
    max-width: 640px;
    margin: 0 auto;
  }

  .table.forest tbody tr {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 0;
    padding: 14px 16px;
    border-bottom: 1px solid var(--rule-soft);
  }

  .table.forest tbody tr:last-child {
    border-bottom: 0;
  }

  .table.forest tbody tr > * {
    padding: 0;
    border: 0;
    text-align: left;
  }

  .table.forest .c-task {
    order: 1;
    flex: 0 0 100%;
    min-width: 0;
  }

  /* The whole id, broken at its hyphens when the card is narrower than it. */
  .table.forest .c-task .mono {
    font-size: 14px;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .table.forest .c-verdict {
    order: 2;
    flex: 0 0 100%;
  }

  .table.forest .c-verdict .result-detail {
    display: inline;
  }

  .table.forest .c-verdict .result-detail::before {
    content: '·';
    padding: 0 6px;
  }

  .table.forest .plot-cell {
    order: 3;
    flex: 0 0 100%;
    padding: 4px 0;
  }

  .table.forest .plot-cell::before {
    bottom: 0;
  }

  .table.forest .plot-cell--empty {
    display: none;
  }

  .table.forest .c-a,
  .table.forest .c-b,
  .table.forest .c-grader {
    font-size: 13px;
    color: var(--ink-2);
  }

  .table.forest .c-a {
    order: 4;
  }

  .table.forest .c-b {
    order: 5;
  }

  .table.forest .c-b::before {
    content: '·';
    padding: 0 8px;
  }

  .table.forest .c-grader {
    order: 6;
    flex: 0 0 100%;
  }

  .table.forest .phone-only {
    display: inline;
  }
}

/* On a tablet each card has the room for three lines: the id with its verdict, the interval, and
   the counts with the graders. */
@media (min-width: 641px) and (max-width: 1099px) {
  .table.forest .c-task {
    flex: 1 1 auto;
    padding-right: 16px;
  }

  .table.forest .c-verdict {
    flex: 0 1 auto;
    text-align: right;
  }

  .table.forest .c-grader {
    flex: 1 1 auto;
  }

  /* The counts always start a line of their own, even on a task with no interval to draw. */
  .table.forest tbody tr::after {
    content: '';
    order: 3;
    flex: 0 0 100%;
    margin-top: -4px;
  }

  .table.forest .c-grader::before {
    content: '·';
    padding: 0 8px;
  }
}


/* A per-arm count opens that arm's trials of the task: an ordinary link, the numbers in ink. */
.cell-link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  color: var(--ink);
}
.example-trust-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.example-trust-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.5rem;
}
.example-trust-summary {
  flex-basis: 100%;
}
</style>
