import { type Rand, seededStream } from '../stats/random';

/**
 * The judge against the humans' labels (SP5, D8, D77, D83), ported from
 * stats/src/evals_stats/agreement.py and agreement_cli.py so the API can show it live. The point
 * figures are the Python's exactly; the intervals use the API's seeded stream (stats/random.ts)
 * instead of Python's Mersenne Twister, so they agree to within resampling noise.
 *
 * "Positive" is a pass (yes): tp judge yes and human yes; fp judge yes and human no (a false
 * pass); fn judge no and human yes (a false fail); tn judge no and human no. Cohen's kappa is
 * (po - pe) / (1 - pe), undefined when pe is 1 (both gave one answer to everything). The judge's
 * own non-answers (unsure, missing, error) are never tabled; they are counted.
 */

export type HumanUnsurePolicy = 'exclude' | 'no';

/** D77: an interval is undefined when more than this share of its resamples had no value. */
export const MAX_UNDEFINED_SHARE = 0.05;
export const RESAMPLES = 2000;
export const LEVEL = 0.95;

/** D8, the trust bar, on the held-out labels. */
export const D8_KAPPA = 0.6;
export const D8_KAPPA_LOW = 0.4;
export const D8_RETEST = 0.9;
/** D77: fewer human "no" labels than this and D8 cannot be applied. */
export const MIN_HUMAN_NO = 5;

/** D73: the raters' majority on an item where as many said yes as no. Always left out. */
export const TIE = 'tie';

const YES_NO: readonly string[] = ['yes', 'no'];

/** One trial's answer on one criterion, from the humans and from the judge. */
export interface Pair {
  trialId: string;
  criterion: string;
  /** yes, no, unsure or tie */
  human: string;
  /** yes, no, or anything else the judge gave (unsure, missing, error) */
  judge: string;
  arm?: string | null;
}

/** yes, no, or null (left out) for a human label under the unsure policy. A tie is always left out. */
export function humanValue(label: string, policy: HumanUnsurePolicy): 'yes' | 'no' | null {
  if (label === 'yes' || label === 'no') return label;
  if (label === TIE) return null;
  return policy === 'no' ? 'no' : null;
}

export interface Table {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export const tableN = (t: Table): number => t.tp + t.fp + t.fn + t.tn;
export const agreementOf = (t: Table): number | null => (tableN(t) ? (t.tp + t.tn) / tableN(t) : null);
export const sensitivityOf = (t: Table): number | null => (t.tp + t.fn ? t.tp / (t.tp + t.fn) : null);
export const specificityOf = (t: Table): number | null => (t.tn + t.fp ? t.tn / (t.tn + t.fp) : null);
export const falsePassRateOf = (t: Table): number | null => (t.fp + t.tn ? t.fp / (t.fp + t.tn) : null);
export const falseFailRateOf = (t: Table): number | null => (t.fn + t.tp ? t.fn / (t.fn + t.tp) : null);

/** Cohen's kappa, in the Python's order of operations so the floats come out the same. */
export function kappaOf(t: Table): number | null {
  const n = tableN(t);
  if (!n) return null;
  const po = (t.tp + t.tn) / n;
  const judgeYes = (t.tp + t.fp) / n;
  const humanYes = (t.tp + t.fn) / n;
  const pe = judgeYes * humanYes + (1 - judgeYes) * (1 - humanYes);
  return pe >= 1 ? null : (po - pe) / (1 - pe);
}

export function table(pairs: Iterable<Pair>, policy: HumanUnsurePolicy): Table {
  const t: Table = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const p of pairs) {
    const h = humanValue(p.human, policy);
    if (h === null || !YES_NO.includes(p.judge)) continue;
    if (p.judge === 'yes') {
      if (h === 'yes') t.tp += 1;
      else t.fp += 1;
    } else if (h === 'yes') t.fn += 1;
    else t.tn += 1;
  }
  return t;
}

export const usable = (p: Pair, policy: HumanUnsurePolicy): boolean => humanValue(p.human, policy) !== null && YES_NO.includes(p.judge);

export interface Interval {
  low: number | null;
  high: number | null;
  /** Resamples that gave a value. */
  defined: number;
  /** Resamples drawn. */
  drawn: number;
}

/** The share of drawn resamples with no value; null when none was drawn. */
export const undefinedShare = (i: Interval): number | null => (i.drawn ? (i.drawn - i.defined) / i.drawn : null);
export const includesZero = (i: Interval): boolean | null => (i.low === null || i.high === null ? null : i.low <= 0 && 0 <= i.high);

/** Linear interpolation between order statistics (numpy's default). */
export function percentile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) throw new Error('no values');
  const pos = (s.length - 1) * q;
  const lo = Math.trunc(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** The percentile interval of the defined values, or undefined when none is, or too many resamples were not (D77). */
function intervalOf(values: number[], drawn: number, level: number): Interval {
  if (!values.length || (drawn - values.length) / drawn > MAX_UNDEFINED_SHARE) return { low: null, high: null, defined: values.length, drawn };
  const tail = (1 - level) / 2;
  return { low: percentile(values, tail), high: percentile(values, 1 - tail), defined: values.length, drawn };
}

/**
 * Percentile bootstrap: resample the items with replacement, recompute, take the tails. A
 * resample where the statistic is undefined is counted, and too many make the interval undefined.
 * `seed` is text for the API's seeded stream, so the same data always gives the same interval.
 */
export function bootstrap<T>(items: readonly T[], statistic: (sample: T[]) => number | null, opts: { seed: string | Rand; resamples?: number; level?: number }): Interval {
  if (!items.length) return { low: null, high: null, defined: 0, drawn: 0 };
  const rand = typeof opts.seed === 'string' ? seededStream(opts.seed) : opts.seed;
  const resamples = opts.resamples ?? RESAMPLES;
  const n = items.length;
  const values: number[] = [];
  const sample = new Array<T>(n);
  for (let r = 0; r < resamples; r += 1) {
    for (let i = 0; i < n; i += 1) sample[i] = items[Math.floor(rand() * n)];
    const v = statistic(sample);
    if (v !== null) values.push(v);
  }
  return intervalOf(values, resamples, opts.level ?? LEVEL);
}

/** D8's gap: the second arm's false-pass rate minus the first's (B - A); null when either arm has no human "no". */
export function signedGap(sample: readonly Pair[], arms: readonly [string, string], policy: HumanUnsurePolicy): number | null {
  const first = falsePassRateOf(table(sample.filter((p) => (p.arm ?? '?') === arms[0]), policy));
  const second = falsePassRateOf(table(sample.filter((p) => (p.arm ?? '?') === arms[1]), policy));
  return first === null || second === null ? null : second - first;
}

/** Python's f"{v:.0%}". */
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * D8 on one criterion's held-out pairs, as `d8_check`: kappa >= 0.6 with its interval's lower end
 * >= 0.4, at least 5 human "no" labels (D77), the false-pass gap's interval holding 0, and
 * test-retest >= 90%. Anything that cannot be measured fails it, with the reason. The interval is
 * given as {low, undefined_share} (an Interval through `undefinedShare`, or AgreementInterval).
 * `gapHoldsZero`: true when the gap's interval holds 0, false when it leaves 0 out, null when it
 * could not be measured (one arm, no human "no" in an arm, or the interval undefined).
 */
/** Two decimals; a value that rounds to zero is "0.00", never "-0.00". */
const two = (v: number): string => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);

export function d8Check(
  t: Table,
  kappaInterval: { low: number | null; undefined_share: number | null } | null,
  gapHoldsZero: boolean | null,
  retestShare: number | null,
): { trusted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const humanNo = t.fp + t.tn;
  if (humanNo < MIN_HUMAN_NO) reasons.push(`${humanNo} human "no" labels, fewer than ${MIN_HUMAN_NO}`);
  const k = kappaOf(t);
  if (k === null) reasons.push('kappa is undefined');
  else if (k < D8_KAPPA) reasons.push(`kappa ${two(k)} is below ${D8_KAPPA}`);
  if (kappaInterval === null || kappaInterval.low === null) {
    const share = kappaInterval?.undefined_share ?? null;
    reasons.push(`kappa's interval is undefined${share ? ` (${pct(share)} of resamples undefined)` : ''}`);
  } else if (kappaInterval.low < D8_KAPPA_LOW) reasons.push(`kappa's interval reaches ${two(kappaInterval.low)}, below ${D8_KAPPA_LOW}`);
  if (gapHoldsZero === null) reasons.push('the false-pass gap between arms could not be measured');
  else if (!gapHoldsZero) reasons.push("the false-pass rate differs between arms (a gap's interval leaves out 0)");
  if (retestShare === null) reasons.push('test-retest agreement is not measured');
  else if (retestShare < D8_RETEST) reasons.push(`test-retest agreement ${pct(retestShare)} is below ${pct(D8_RETEST)}`);
  return { trusted: !reasons.length, reasons };
}

// ---- the labels: each rater's settled label, and the raters' majority (D46, D73) -------------

export interface LabelRow {
  trial_id: string;
  criterion: string;
  value: string;
  rater: string;
  second_look: boolean;
  /** When it was labelled: ISO text or epoch milliseconds, compared in order. */
  labelled_at: string | number | Date;
  note?: string | null;
}

export interface SettledLabel {
  value: string;
  note: string | null;
}

/** `${trial}\u0000${criterion}`: a map key for one labelled item. */
export const itemKey = (trial: string, criterion: string): string => `${trial}\u0000${criterion}`;
export const splitKey = (key: string): [string, string] => key.split('\u0000') as [string, string];

const when = (v: string | number | Date): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));

/**
 * One rater's settled label per (trial, criterion), as `_first_labels`: in labelled order, the
 * first label counts and a later one is a relabel (left out here); a second look (D46) replaces a
 * first "unsure", once, and is not a relabel (a second-look "unsure" stays "unsure"). Rows of
 * equal time keep their given order.
 */
export function firstLabels(rows: readonly LabelRow[]): Map<string, SettledLabel> {
  const sorted = rows.map((r, i) => ({ r, i, t: when(r.labelled_at) })).sort((a, b) => a.t - b.t || a.i - b.i);
  const first = new Map<string, SettledLabel>();
  const second = new Set<string>();
  for (const { r } of sorted) {
    const key = itemKey(r.trial_id, r.criterion);
    if (r.second_look) {
      const prior = first.get(key);
      if (prior?.value === 'unsure' && !second.has(key)) {
        first.set(key, { value: r.value, note: r.note ?? prior.note });
        second.add(key);
      }
      continue;
    }
    if (!first.has(key)) first.set(key, { value: r.value, note: r.note ?? null });
  }
  return first;
}

/** D73: every rater's settled labels, as `read_rater_labels`. */
export function raterLabels(rows: readonly LabelRow[]): Map<string, Map<string, SettledLabel>> {
  const byRater = new Map<string, LabelRow[]>();
  for (const r of rows) byRater.set(r.rater, [...(byRater.get(r.rater) ?? []), r]);
  return new Map([...byRater.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([rater, rs]) => [rater, firstLabels(rs)]));
}

/**
 * D73, as `human_majority`: per item, what more than half of the raters with a firm answer said;
 * TIE when they split evenly; `unsure` when nobody gave a firm answer. `note` joins the notes of
 * the raters who said the majority's answer (each named when more than one rater labelled it).
 */
export function humanMajority(byRater: Map<string, Map<string, SettledLabel>>, policy: HumanUnsurePolicy): Map<string, SettledLabel> {
  const keys = new Set<string>();
  for (const labels of byRater.values()) for (const k of labels.keys()) keys.add(k);
  const out = new Map<string, SettledLabel>();
  for (const key of [...keys].sort()) {
    const given: { rater: string; label: SettledLabel; firm: 'yes' | 'no' | null }[] = [];
    for (const [rater, labels] of byRater) {
      const label = labels.get(key);
      if (label) given.push({ rater, label, firm: humanValue(label.value, policy) });
    }
    const firm = given.filter((g) => g.firm !== null);
    const yes = firm.filter((g) => g.firm === 'yes').length;
    const no = firm.length - yes;
    const value = !firm.length ? 'unsure' : yes * 2 > firm.length ? 'yes' : no * 2 > firm.length ? 'no' : TIE;
    const backing = given.filter((g) => (value === 'unsure' || value === TIE ? true : g.firm === value) && g.label.note);
    const note = backing.length ? backing.map((g) => (given.length > 1 ? `${g.rater}: ${g.label.note}` : (g.label.note as string))).join('; ') : null;
    out.set(key, { value, note });
  }
  return out;
}

// ---- the judge with itself: test-retest (D8) ---------------------------------------------------

/**
 * D8's test-retest on one criterion: for each trial judged at least twice, whether the two latest
 * gradings gave the same verdict on it. `gradings` holds, per trial, its gradings newest first,
 * each as {criterion: verdict}; a criterion one of the two left out reads as `missing`.
 */
export function retestOf(gradings: readonly (readonly Record<string, string>[])[], criterion: string): { identical: number; total: number; share: number | null } | null {
  let identical = 0;
  let total = 0;
  for (const runs of gradings) {
    if (runs.length < 2) continue;
    const [a, b] = runs;
    if (!(criterion in a) && !(criterion in b)) continue;
    total += 1;
    if ((a[criterion] ?? 'missing') === (b[criterion] ?? 'missing')) identical += 1;
  }
  return total ? { identical, total, share: identical / total } : null;
}
