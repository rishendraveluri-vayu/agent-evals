import type { AgreementFigures, AgreementInterval, JudgeCriterionTrust, JudgeTrustResponse, JudgeTrustStatus } from '../contract';
import {
  D8_KAPPA,
  D8_KAPPA_LOW,
  D8_RETEST,
  type HumanUnsurePolicy,
  type Interval,
  MAX_UNDEFINED_SHARE,
  MIN_HUMAN_NO,
  type Pair,
  RESAMPLES,
  agreementOf,
  bootstrap,
  d8Check,
  humanValue,
  includesZero,
  kappaOf,
  sensitivityOf,
  signedGap,
  specificityOf,
  table,
  tableN,
  undefinedShare,
  usable,
} from './agreement';

/**
 * D83: how far to trust a judge (judge model × rubric) on each criterion, from the labelled items
 * it graded. Pure: the service (trust.service.ts) reads the rows and hands them in here.
 */

/** D77's unsure policy as applied: the humans' "unsure" is left out (judge-validation decision 3). */
export const POLICY: HumanUnsurePolicy = 'exclude';

export const BAR: JudgeTrustResponse['bar'] = {
  kappa: D8_KAPPA,
  kappa_low: D8_KAPPA_LOW,
  retest: D8_RETEST,
  min_human_no: MIN_HUMAN_NO,
  max_undefined_share: MAX_UNDEFINED_SHARE,
  resamples: RESAMPLES,
  human_unsure: POLICY,
};

/** Least trusted first (D83): a judge's status is its `overall` criterion's, else its least trusted one's. */
export const STATUS_ORDER: readonly JudgeTrustStatus[] = ['uncalibrated', 'tuning_only', 'too_few', 'not_trusted', 'trusted'];

export type TrustSet = 'tuning' | 'heldout';

/** One labelled (trial, criterion) the judge graded: the humans' settled answer and the judge's. */
export interface JudgedItem extends Pair {
  taskId: string;
  set: TrustSet;
  /** The raters' majority: yes, no, unsure or tie. */
  human: string;
  humanNote: string | null;
  /** The judge's verdict on the criterion in the trial's current grade: yes, no, or what else it gave (missing when none). */
  judge: string;
  judgeReason: string | null;
  /** The experiments and arms the trial is in (its own, and any that reuse it, D34). */
  arms: { experimentId: string; arm: string }[];
}

export interface CriterionInput {
  criterion: string;
  text: string | null;
  items: JudgedItem[];
  retest: JudgeCriterionTrust['retest'];
}

const MAX_DISAGREEMENTS = 50;

const asInterval = (i: Interval): AgreementInterval => ({ low: i.low, high: i.high, undefined_share: undefinedShare(i) });
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The figures on one criterion in one set; null when no item of the set is labelled. `seed` names its streams. */
export function figuresOf(items: readonly JudgedItem[], seed: string): AgreementFigures | null {
  if (!items.length) return null;
  const used = items.filter((p) => usable(p, POLICY));
  const t = table(used, POLICY);
  const kappa = bootstrap(used, (s) => kappaOf(table(s, POLICY)), { seed: `${seed}:kappa` });
  return {
    n: tableN(t),
    ...t,
    agreement: agreementOf(t),
    kappa: kappaOf(t),
    kappa_interval: asInterval(kappa),
    sensitivity: sensitivityOf(t),
    specificity: specificityOf(t),
    human_no: t.fp + t.tn,
    human_left_out: items.filter((p) => humanValue(p.human, POLICY) === null).length,
    judge_undecided: items.filter((p) => p.judge !== 'yes' && p.judge !== 'no').length,
    false_pass_gap: falsePassGap(used, seed),
  };
}

/** The tasks of the items with a firm human answer and a judge yes or no (the comparison's `stats.judge.tasks`). */
export function tasksWithPairs(items: readonly JudgedItem[]): number {
  return new Set(items.filter((p) => usable(p, POLICY)).map((p) => p.taskId)).size;
}

/**
 * D8's false-pass gap, arm B minus arm A, in the experiment with the most usable pairs on its arms
 * A and B among those with a human "no" on both (ties: the later id); null when there is none.
 * The bootstrap resamples that experiment's pairs.
 */
function falsePassGap(used: readonly JudgedItem[], seed: string): AgreementFigures['false_pass_gap'] {
  const byExperiment = new Map<string, Pair[]>();
  for (const p of used) {
    for (const m of p.arms) {
      if (m.arm !== 'A' && m.arm !== 'B') continue;
      const list = byExperiment.get(m.experimentId) ?? [];
      list.push({ trialId: p.trialId, criterion: p.criterion, human: p.human, judge: p.judge, arm: m.arm });
      byExperiment.set(m.experimentId, list);
    }
  }
  let best: { id: string; pairs: Pair[] } | null = null;
  for (const [id, pairs] of [...byExperiment.entries()].sort(([a], [b]) => byText(a, b))) {
    const no = (arm: string): number => pairs.filter((p) => p.arm === arm && humanValue(p.human, POLICY) === 'no').length;
    if (!no('A') || !no('B')) continue;
    if (!best || pairs.length >= best.pairs.length) best = { id, pairs };
  }
  if (!best) return null;
  const arms = ['A', 'B'] as const;
  const interval = bootstrap(best.pairs, (s) => signedGap(s, arms, POLICY), { seed: `${seed}:false_pass_gap` });
  return { experiment_id: best.id, estimate: signedGap(best.pairs, arms, POLICY), interval: asInterval(interval), includes_zero: includesZero(interval) };
}

/** One criterion's trust: figures per set, D8 on the held-out ones, the status and its sentence. `judgeSeed` names the judge. */
export function criterionTrust(judgeSeed: string, c: CriterionInput): JudgeCriterionTrust {
  const figures = (set: TrustSet) =>
    figuresOf(
      c.items.filter((p) => p.set === set),
      `judge-trust:${judgeSeed}:${c.criterion}:${set}`,
    );
  const heldout = figures('heldout');
  const tuning = figures('tuning');
  const d8 = heldout ? d8Check(heldout, heldout.kappa_interval, heldout.false_pass_gap?.includes_zero ?? null, c.retest?.share ?? null) : null;
  const humanNo = heldout?.human_no ?? 0;
  let status: JudgeTrustStatus;
  if (!heldout && !tuning) status = 'uncalibrated';
  else if (!heldout) status = 'tuning_only';
  else if (humanNo < MIN_HUMAN_NO || heldout.kappa === null || heldout.kappa_interval.low === null) status = 'too_few';
  else status = d8?.trusted ? 'trusted' : 'not_trusted';
  return {
    criterion: c.criterion,
    text: c.text,
    status,
    summary: criterionSummary(status, heldout, tuning, c.retest),
    heldout,
    tuning,
    d8,
    retest: c.retest,
    needs_human_no: humanNo < MIN_HUMAN_NO ? MIN_HUMAN_NO - humanNo : null,
    disagreements: disagreementsOf(c.items),
  };
}

/** Where the judge's yes or no differs from the humans' firm answer: held-out first, by task and trial; at most 50. */
function disagreementsOf(items: readonly JudgedItem[]): JudgeCriterionTrust['disagreements'] {
  const out: JudgeCriterionTrust['disagreements'] = [];
  for (const set of ['heldout', 'tuning'] as const) {
    const off = items
      .filter((p) => p.set === set && usable(p, POLICY) && p.judge !== humanValue(p.human, POLICY))
      .sort((a, b) => byText(a.taskId, b.taskId) || byText(a.trialId, b.trialId));
    for (const p of off) {
      if (out.length >= MAX_DISAGREEMENTS) return out;
      out.push({ trial_id: p.trialId, task_id: p.taskId, set, human: humanValue(p.human, POLICY)!, judge: p.judge as 'yes' | 'no', judge_reason: p.judgeReason, human_note: p.humanNote });
    }
  }
  return out;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Two decimals; a value that rounds to zero is "0.00", never "-0.00". */
const f2 = (v: number): string => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** One plain sentence for the screen: what the status means and what to do next. */
export function criterionSummary(status: JudgeTrustStatus, heldout: AgreementFigures | null, tuning: AgreementFigures | null, retest: JudgeCriterionTrust['retest']): string {
  const untested = 'has never been tested on held-out labels, which decide trust';
  switch (status) {
    case 'uncalibrated':
      return 'No human labels on outputs this judge graded yet. Treat its verdicts as a hint, and label a few to calibrate it.';
    case 'tuning_only': {
      const t = tuning!;
      if (!t.n) return `Its tuning labels are all unsure, tied or not judged, so there is nothing to compare yet, and it ${untested}.`;
      if (t.kappa === null) return `Has ${plural(t.n, 'tuning label')}, all one answer from both, so kappa is undefined, and it ${untested}.`;
      return `Agrees with ${plural(t.n, 'tuning label')} at kappa ${f2(t.kappa)}, but ${untested}.`;
    }
    case 'too_few': {
      const h = heldout!;
      const so = `${plural(h.n, 'held-out label')} so far`;
      if (h.human_no < MIN_HUMAN_NO) {
        const more = MIN_HUMAN_NO - h.human_no;
        return `${so}; needs ${more} more human "no" ${more === 1 ? 'label' : 'labels'} before the trust bar can be applied.`;
      }
      if (h.kappa === null) return `${so}, but the judge and the humans gave one answer to all of them, so kappa is undefined and the trust bar cannot be applied yet.`;
      const s = h.kappa_interval.undefined_share;
      return `${so}, but kappa's interval is undefined (${s === null ? 'no resamples' : `${pct(s)} of resamples had no kappa`}), so the trust bar cannot be applied yet; label more outputs.`;
    }
    case 'not_trusted': {
      const h = heldout!;
      const k = h.kappa!;
      const on = plural(h.n, 'held-out label');
      if (k < D8_KAPPA) return `Not trusted: kappa ${f2(k)} on ${on} is below ${D8_KAPPA}.`;
      const low = h.kappa_interval.low!;
      if (low < D8_KAPPA_LOW) return `Not trusted: kappa ${f2(k)} on ${on}, but its interval reaches ${f2(low)}, below ${D8_KAPPA_LOW}.`;
      const gap = h.false_pass_gap;
      if (gap?.includes_zero === false) return `Not trusted: on ${on} it passes bad answers more often in one arm than the other (false-pass gap ${f2(gap.estimate ?? 0)}, B minus A).`;
      if (!gap || gap.includes_zero === null) return `Not trusted yet: kappa ${f2(k)} on ${on} clears the bar, but the false-pass gap between arms could not be measured; label outputs it should fail in both arms of one experiment.`;
      if (!retest || retest.share === null) return `Not trusted yet: kappa ${f2(k)} on ${on} clears the bar, but its test-retest agreement is not measured; regrade a few judged trials to measure it.`;
      return `Not trusted: it gives the same verdict on a regrade only ${pct(retest.share)} of the time, below ${pct(D8_RETEST)}.`;
    }
    case 'trusted': {
      const h = heldout!;
      return `Trusted: kappa ${f2(h.kappa!)} (interval ${f2(h.kappa_interval.low!)} to ${f2(h.kappa_interval.high!)}) on ${plural(h.n, 'held-out label')}, no false-pass gap between arms, and ${pct(retest!.share!)} test-retest agreement.`;
    }
  }
}

/** A judge's own status and sentence: its `overall` criterion's, else its least trusted criterion's. */
export function judgeStatus(criteria: readonly JudgeCriterionTrust[]): { status: JudgeTrustStatus; summary: string } {
  const overall = criteria.find((c) => c.criterion === 'overall');
  if (overall) return { status: overall.status, summary: overall.summary };
  if (!criteria.length) return { status: 'uncalibrated', summary: criterionSummary('uncalibrated', null, null, null) };
  const least = [...criteria].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))[0];
  return { status: least.status, summary: `On ${least.criterion}, its least trusted criterion: ${least.summary.charAt(0).toLowerCase()}${least.summary.slice(1)}` };
}
