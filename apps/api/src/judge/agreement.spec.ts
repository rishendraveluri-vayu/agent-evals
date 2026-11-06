import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { seededStream } from '../stats/random';
import {
  type LabelRow,
  MAX_UNDEFINED_SHARE,
  MIN_HUMAN_NO,
  type Pair,
  TIE,
  agreementOf,
  bootstrap,
  d8Check,
  falseFailRateOf,
  falsePassRateOf,
  firstLabels,
  humanMajority,
  humanValue,
  includesZero,
  itemKey,
  kappaOf,
  percentile,
  raterLabels,
  retestOf,
  sensitivityOf,
  signedGap,
  specificityOf,
  table,
  tableN,
  undefinedShare,
  usable,
} from './agreement';
import { type JudgedItem, figuresOf } from './trust';

/**
 * The port of stats/src/evals_stats/agreement.py, case by case against stats/tests/test_agreement.py.
 * All verdicts here are SYNTHETIC (made up to check arithmetic), except the golden test at the
 * end, which reads the repo's own judge-panel rows and labels/heldout.jsonl and checks the figures
 * against the Python tool's on the same files.
 */

function pairsFor(tp: number, fp: number, fn: number, tn: number, arm = 'A', crit = 'c'): Pair[] {
  const out: Pair[] = [];
  for (const [kind, n, human, judge] of [
    ['tp', tp, 'yes', 'yes'],
    ['fp', fp, 'no', 'yes'],
    ['fn', fn, 'yes', 'no'],
    ['tn', tn, 'no', 'no'],
  ] as const) {
    for (let i = 0; i < n; i += 1) out.push({ trialId: `${arm}-${kind}-${i}`, criterion: crit, human, judge, arm });
  }
  return out;
}

const kappaStat = (s: Pair[]): number | null => kappaOf(table(s, 'exclude'));

/** D8's gap check as `no_false_pass_gap` with two arms: the signed gap's interval holds 0 (null when unmeasurable). */
function gapHolds(pairs: Pair[], seed: string, resamples = 300): { gap: number | null; holds: boolean | null; high: number | null } {
  const used = pairs.filter((p) => usable(p, 'exclude'));
  const arms = [...new Set(used.map((p) => p.arm ?? '?'))].sort();
  if (arms.length < 2) return { gap: null, holds: null, high: null };
  const pair = [arms[0], arms[1]] as const;
  const iv = bootstrap(used, (s) => signedGap(s, pair, 'exclude'), { seed, resamples });
  return { gap: signedGap(used, pair, 'exclude'), holds: includesZero(iv), high: iv.high };
}

describe('the 2x2 table, kappa, sensitivity and specificity', () => {
  it('match a hand-worked example', () => {
    // 20 tp, 5 fp, 10 fn, 15 tn: po = 0.7; judge yes 25/50, human yes 30/50; pe = 0.5; kappa = 0.4.
    const t = table(pairsFor(20, 5, 10, 15), 'exclude');
    expect([t.tp, t.fp, t.fn, t.tn, tableN(t)]).toEqual([20, 5, 10, 15, 50]);
    expect(agreementOf(t)).toBeCloseTo(0.7, 12);
    expect(kappaOf(t)).toBeCloseTo(0.4, 12);
    expect(sensitivityOf(t)).toBeCloseTo(20 / 30, 12);
    expect(specificityOf(t)).toBeCloseTo(15 / 20, 12);
    expect(falsePassRateOf(t)).toBeCloseTo(5 / 20, 12);
    expect(falseFailRateOf(t)).toBeCloseTo(10 / 30, 12);
  });

  it('leave kappa undefined when both raters say one thing', () => {
    expect(kappaOf({ tp: 10, fp: 0, fn: 0, tn: 0 })).toBeNull();
    const empty = { tp: 0, fp: 0, fn: 0, tn: 0 };
    expect(kappaOf(empty)).toBeNull();
    expect(sensitivityOf(empty)).toBeNull();
    expect(kappaOf({ tp: 5, fp: 5, fn: 0, tn: 0 })).toBeCloseTo(0, 12); // judge always yes: no skill
  });

  it('take an explicit unsure policy, and never count a raters’ tie', () => {
    expect(humanValue('unsure', 'exclude')).toBeNull();
    expect(humanValue('unsure', 'no')).toBe('no');
    expect(humanValue(TIE, 'no')).toBeNull();
  });

  it('count the humans’ unsure and the judge’s non-answers next to the table, not in it', () => {
    const items: JudgedItem[] = [
      ...pairsFor(3, 1, 1, 3),
      { trialId: 'u1', criterion: 'c', human: 'unsure', judge: 'yes' },
      { trialId: 'j1', criterion: 'c', human: 'yes', judge: 'missing' },
      { trialId: 'j2', criterion: 'c', human: 'no', judge: 'unsure' },
    ].map((p) => ({ ...p, taskId: 'task', set: 'heldout', humanNote: null, judgeReason: null, arms: [] }));
    const f = figuresOf(items, 'test')!;
    expect([f.n, f.human_left_out, f.judge_undecided]).toEqual([8, 1, 2]);
    const asNo = table(items, 'no');
    expect([tableN(asNo), asNo.fp]).toEqual([9, 2]); // unsure counted as a human no
  });
});

describe('the percentile and the bootstrap', () => {
  it('interpolates between order statistics, as numpy does by default', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5], 0.975)).toBe(5);
    expect(percentile([0, 10], 0.25)).toBe(2.5);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5); // sorts first
  });

  it('is seeded, and brackets the estimate', () => {
    const ps = pairsFor(20, 5, 10, 15);
    const a = bootstrap(ps, kappaStat, { seed: 's3', resamples: 500 });
    const b = bootstrap(ps, kappaStat, { seed: 's3', resamples: 500 });
    expect(a).toEqual(b);
    expect(a.defined).toBe(500);
    expect(a.low!).toBeLessThan(0.4);
    expect(a.high!).toBeGreaterThan(0.4);
    expect(bootstrap([], kappaStat, { seed: 'x' })).toEqual({ low: null, high: null, defined: 0, drawn: 0 });
    expect(undefinedShare({ low: null, high: null, defined: 0, drawn: 0 })).toBeNull();
  });

  it('makes an interval undefined when more than 5% of its resamples have no value (D77)', () => {
    // One human "no" and the judge agrees on all 30: kappa 1, but about a third of the resamples
    // leave the one "no" out, where kappa is undefined. Dropping them silently gave [1, 1].
    const ps: Pair[] = Array.from({ length: 30 }, (_, i) => ({ trialId: `t${i}`, criterion: 'c', human: i === 0 ? 'no' : 'yes', judge: i === 0 ? 'no' : 'yes' }));
    const t = table(ps, 'exclude');
    expect([t.tn, t.tp]).toEqual([1, 29]);
    expect(kappaOf(t)).toBeCloseTo(1, 12);
    const k = bootstrap(ps, kappaStat, { seed: 'one-no' });
    expect(k.low).toBeNull();
    expect(k.high).toBeNull();
    expect(k.drawn).toBe(2000);
    expect(undefinedShare(k)!).toBeGreaterThan(0.3);
    expect(undefinedShare(k)!).toBeLessThan(0.42);
    const { reasons, trusted } = d8Check(t, { low: k.low, undefined_share: undefinedShare(k) }, null, null);
    expect(reasons[0]).toBe('1 human "no" labels, fewer than 5');
    expect(reasons.some((r) => r.startsWith("kappa's interval is undefined ("))).toBe(true);
    expect(trusted).toBe(false);
  });

  it('keeps an interval with a few undefined resamples, and says how many', () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    // Undefined when the resample's first item is 0..2: about 3% of resamples.
    let iv = bootstrap(values, (s) => (s[0] < 3 ? null : s.reduce((a, b) => a + b, 0) / s.length), { seed: 'few', resamples: 1000 });
    expect(iv.low).not.toBeNull();
    expect(undefinedShare(iv)!).toBeGreaterThan(0);
    expect(undefinedShare(iv)!).toBeLessThanOrEqual(MAX_UNDEFINED_SHARE);
    iv = bootstrap(values, (s) => (s[0] < 10 ? null : 1), { seed: 'many', resamples: 1000 });
    expect(iv.low).toBeNull();
    expect(undefinedShare(iv)!).toBeGreaterThan(MAX_UNDEFINED_SHARE);
  });
});

describe("D8's false-pass gap between arms (signed, B - A)", () => {
  it('is the second arm’s false-pass rate minus the first’s, with an interval around it', () => {
    // arm A: false-pass rate 1/10; arm B: 5/10. Gap 0.4.
    const ps = [...pairsFor(10, 1, 0, 9, 'A'), ...pairsFor(10, 5, 0, 5, 'B')];
    expect(falsePassRateOf(table(ps.filter((p) => p.arm === 'A'), 'exclude'))).toBeCloseTo(0.1, 12);
    expect(signedGap(ps, ['A', 'B'], 'exclude')).toBeCloseTo(0.4, 12);
    const iv = bootstrap(ps, (s) => signedGap(s, ['A', 'B'], 'exclude'), { seed: 'gap', resamples: 300 });
    expect(iv.low!).toBeLessThanOrEqual(0.4);
    expect(iv.high!).toBeGreaterThanOrEqual(0.4);
  });

  it('is signed: a kinder arm A gives a negative gap whose interval leaves out 0', () => {
    // arm A: 5/10; arm B: 1/10. B - A = -0.4; the old max - min said +0.4.
    const g = gapHolds([...pairsFor(10, 5, 0, 5, 'A'), ...pairsFor(10, 1, 0, 9, 'B')], 'signed');
    expect(g.gap).toBeCloseTo(-0.4, 12);
    expect(g.high!).toBeLessThan(0);
    expect(g.holds).toBe(false);
    const t = table([...pairsFor(10, 5, 0, 5, 'A'), ...pairsFor(10, 1, 0, 9, 'B')], 'exclude');
    expect(d8Check(t, { low: 0.5, undefined_share: 0 }, g.holds, 1).reasons.join('; ')).toContain('the false-pass rate differs between arms');
  });

  it('passes an unbiased judge about 95 times in 100', () => {
    // The reviewer's simulation: the same false-pass rate in both arms, 20 human "no" per arm.
    const rand = seededStream('unbiased');
    let held = 0;
    const signs = new Set<boolean>();
    const runs = 40;
    for (let run = 0; run < runs; run += 1) {
      const ps: Pair[] = [];
      for (const arm of ['A', 'B']) for (let i = 0; i < 20; i += 1) ps.push({ trialId: `${arm}${i}`, criterion: 'c', human: 'no', judge: rand() < 0.3 ? 'yes' : 'no', arm });
      const g = gapHolds(ps, `unbiased:${run}`);
      if (g.holds === true) held += 1;
      if (g.gap) signs.add(g.gap > 0);
    }
    expect(held / runs).toBeGreaterThanOrEqual(0.85);
    expect([...signs].sort()).toEqual([false, true]);
  });

  it('cannot be measured with one arm', () => {
    const ps = pairsFor(10, 1, 1, 10, 'A');
    expect(gapHolds(ps, 'one').holds).toBeNull();
    expect(d8Check(table(ps, 'exclude'), { low: 0.5, undefined_share: 0 }, null, 1).reasons).toContain('the false-pass gap between arms could not be measured');
  });

  it('is undefined in a resample where an arm has no human "no"', () => {
    expect(signedGap(pairsFor(3, 0, 0, 0, 'A').concat(pairsFor(1, 1, 0, 0, 'B')), ['A', 'B'], 'exclude')).toBeNull();
  });
});

describe('D8, the trust bar', () => {
  it('trusts a good judge only with test-retest measured', () => {
    const ps = [...pairsFor(20, 1, 1, 18, 'A'), ...pairsFor(20, 1, 1, 18, 'B')];
    const t = table(ps, 'exclude');
    const k = bootstrap(ps, kappaStat, { seed: 'good', resamples: 500 });
    expect(kappaOf(t)!).toBeGreaterThan(0.85);
    expect(k.low!).toBeGreaterThan(0.6);
    const holds = gapHolds(ps, 'good-gap', 500).holds;
    const ki = { low: k.low, undefined_share: undefinedShare(k) };
    expect(d8Check(t, ki, holds, 0.95)).toEqual({ trusted: true, reasons: [] });
    expect(d8Check(t, ki, holds, null)).toEqual({ trusted: false, reasons: ['test-retest agreement is not measured'] });
    expect(d8Check(t, ki, holds, 0.85).reasons).toEqual(['test-retest agreement 85% is below 90%']);
  });

  it('needs five human "no" labels (D77)', () => {
    expect(MIN_HUMAN_NO).toBe(5);
    const t = table([...pairsFor(30, 0, 1, 2, 'A'), ...pairsFor(30, 0, 1, 2, 'B')], 'exclude');
    expect(t.fp + t.tn).toBe(4);
    expect(d8Check(t, { low: 0.5, undefined_share: 0 }, true, 1).reasons[0]).toBe('4 human "no" labels, fewer than 5');
  });

  it('words kappa below the bar and an interval that reaches below 0.4', () => {
    const t = table(pairsFor(10, 5, 5, 10), 'exclude');
    expect(d8Check(t, { low: 0.1, undefined_share: 0 }, true, 1).reasons).toEqual(['kappa 0.33 is below 0.6', "kappa's interval reaches 0.10, below 0.4"]);
    expect(d8Check(table(pairsFor(5, 0, 0, 0), 'exclude'), null, true, 1).reasons).toEqual(['0 human "no" labels, fewer than 5', 'kappa is undefined', "kappa's interval is undefined"]);
  });
});

describe('test-retest', () => {
  it('compares the two latest gradings of each trial judged twice', () => {
    const gradings: Record<string, string>[][] = [
      [{ c: 'yes' }, { c: 'yes' }, { c: 'no' }], // the third (oldest) is not compared
      [{ c: 'yes' }, { c: 'no' }],
      [{ c: 'no' }], // judged once: left out
      [{ other: 'yes' }, { other: 'yes' }], // never answered c
      [{ c: 'yes' }, {}], // the older grading left c out: missing, not the same
    ];
    expect(retestOf(gradings, 'c')).toEqual({ identical: 1, total: 3, share: 1 / 3 });
    expect(retestOf(gradings, 'nothing')).toBeNull();
  });
});

describe("each rater's settled label and the raters' majority (D46, D73)", () => {
  const row = (trial: string, value: string, at: string, extra: Partial<LabelRow> = {}): LabelRow => ({ trial_id: trial, criterion: 'c', value, rater: 'rishi', second_look: false, labelled_at: at, note: null, ...extra });

  it('keeps the first label; a later one is a relabel and does not count', () => {
    const first = firstLabels([row('t1', 'no', '2026-11-06T09:00Z'), row('t1', 'yes', '2026-11-05T09:00Z'), row('t2', 'unsure', '2026-11-05T10:00Z')]);
    expect(Object.fromEntries([...first].map(([k, v]) => [k, v.value]))).toEqual({ [itemKey('t1', 'c')]: 'yes', [itemKey('t2', 'c')]: 'unsure' });
  });

  it('takes a second look in place of an unsure, once, and only of an unsure', () => {
    const first = firstLabels([
      row('t1', 'unsure', '2026-11-05T09:00Z'),
      row('t1', 'no', '2026-11-05T10:00Z', { second_look: true, note: 'on a second look' }),
      row('t2', 'unsure', '2026-11-05T09:00Z'),
      row('t2', 'unsure', '2026-11-05T10:00Z', { second_look: true }),
      row('t3', 'yes', '2026-11-05T09:00Z'),
      row('t3', 'no', '2026-11-05T10:00Z', { second_look: true }),
      row('t1', 'yes', '2026-11-05T11:00Z', { second_look: true }),
    ]);
    expect(Object.fromEntries([...first].map(([k, v]) => [k, v.value]))).toEqual({ [itemKey('t1', 'c')]: 'no', [itemKey('t2', 'c')]: 'unsure', [itemKey('t3', 'c')]: 'yes' });
    expect(first.get(itemKey('t1', 'c'))!.note).toBe('on a second look');
  });

  it('reads each rater apart: another rater’s answer is never a relabel', () => {
    const byRater = raterLabels([
      row('t1', 'yes', '2026-11-05T01:00Z'),
      row('t1', 'no', '2026-11-05T02:00Z', { rater: 'asha' }),
      row('t1', 'no', '2026-11-05T03:00Z'),
    ]);
    expect([...byRater.keys()]).toEqual(['asha', 'rishi']);
    expect(byRater.get('rishi')!.get(itemKey('t1', 'c'))!.value).toBe('yes');
    expect(byRater.get('asha')!.get(itemKey('t1', 'c'))!.value).toBe('no');
  });

  it('takes the majority, leaves a tie out, and lets a firm answer decide over an unsure', () => {
    const labels = (m: Record<string, string>) => new Map(Object.entries(m).map(([t, value]) => [itemKey(t, 'c'), { value, note: null }]));
    const a = labels({ t1: 'yes', t2: 'no', t3: 'yes' });
    const b = labels({ t1: 'yes', t2: 'yes', t3: 'unsure' });
    const m = humanMajority(
      new Map([
        ['a', a],
        ['b', b],
      ]),
      'exclude',
    );
    expect(Object.fromEntries([...m].map(([k, v]) => [k, v.value]))).toEqual({ [itemKey('t1', 'c')]: 'yes', [itemKey('t2', 'c')]: TIE, [itemKey('t3', 'c')]: 'yes' });
    // S11: a firm tie is left out under either policy; two unsure raters are "unsure", which the policy decides.
    for (const policy of ['exclude', 'no'] as const) {
      const tie = humanMajority(
        new Map([
          ['rishi', labels({ t1: 'yes' })],
          ['asha', labels({ t1: 'no' })],
        ]),
        policy,
      );
      expect(tie.get(itemKey('t1', 'c'))!.value).toBe(TIE);
      expect(table([{ trialId: 't1', criterion: 'c', human: TIE, judge: 'yes' }], policy).fp).toBe(0);
    }
    const unsure = new Map([
      ['rishi', labels({ t1: 'unsure' })],
      ['asha', labels({ t1: 'unsure' })],
    ]);
    expect(humanMajority(unsure, 'exclude').get(itemKey('t1', 'c'))!.value).toBe('unsure');
    expect(humanMajority(unsure, 'no').get(itemKey('t1', 'c'))!.value).toBe('no');
  });

  it('carries the notes of the raters who gave the majority’s answer', () => {
    const one = new Map([['rishi', new Map([[itemKey('t1', 'c'), { value: 'no', note: 'misses the fee' }]])]]);
    expect(humanMajority(one, 'exclude').get(itemKey('t1', 'c'))!.note).toBe('misses the fee');
    const two = new Map([
      ['asha', new Map([[itemKey('t1', 'c'), { value: 'no', note: 'wrong rate' }]])],
      ['rishi', new Map([[itemKey('t1', 'c'), { value: 'no', note: 'misses the fee' }]])],
      ['ravi', new Map([[itemKey('t1', 'c'), { value: 'yes', note: 'fine' }]])],
    ]);
    expect(humanMajority(two, 'exclude').get(itemKey('t1', 'c'))!.note).toBe('asha: wrong rate; rishi: misses the fee');
  });
});

// ---- golden: the repo's own D74 held-out panel, against the Python tool on the same files ----

const REPO = path.resolve(__dirname, '../../../..');
const jsonl = (rel: string): Record<string, unknown>[] =>
  readFileSync(path.join(REPO, rel), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

/**
 * The pairs `evals-panel` builds for one judge model: each (trial, criterion) of the panel rows
 * (a later row replaces an earlier one; a failed call, with no criterion, is `error` on every
 * criterion its trial has; a judge that left a criterion out is `missing` on it), joined to the
 * raters' settled labels.
 */
interface PanelRow {
  trial_id: string;
  task_id: string;
  model: string;
  criterion: string | null;
  verdict: string | null;
}

function panelItems(rows: PanelRow[], labelRows: LabelRow[], model: string): JudgedItem[] {
  const models = [...new Set(rows.map((r) => r.model))];
  const table = new Map<string, Map<string, string>>();
  const failed = new Map<string, Set<string>>();
  const task = new Map<string, string>();
  for (const r of rows) {
    task.set(r.trial_id, r.task_id);
    if (r.criterion === null || r.criterion === undefined) {
      failed.set(r.trial_id, new Set([...(failed.get(r.trial_id) ?? []), r.model]));
      continue;
    }
    const key = itemKey(r.trial_id, r.criterion);
    const byModel = table.get(key) ?? new Map<string, string>();
    byModel.set(r.model, String(r.verdict));
    table.set(key, byModel);
  }
  for (const [key, byModel] of table) {
    for (const m of failed.get(key.split('\u0000')[0]) ?? []) if (!byModel.has(m)) byModel.set(m, 'error');
    for (const m of models) if (!byModel.has(m)) byModel.set(m, 'missing');
  }
  const labels = humanMajority(raterLabels(labelRows), 'exclude');
  const out: JudgedItem[] = [];
  for (const [key, byModel] of table) {
    const human = labels.get(key);
    if (!human) continue;
    const [trialId, criterion] = key.split('\u0000');
    out.push({ trialId, criterion, human: human.value, judge: byModel.get(model) ?? 'missing', taskId: task.get(trialId)!, set: 'heldout', humanNote: human.note, judgeReason: null, arms: [] });
  }
  return out;
}

describe('golden: gemini-3.8-flash on the D74 held-out panel (judge-panel/d74-test-heldout-advice-v4-framed.jsonl, labels/heldout.jsonl)', () => {
  const labelRows: LabelRow[] = jsonl('labels/heldout.jsonl')
    .filter((r) => typeof r.labelled_at === 'string' && r.labelled_at && typeof (r.trial_id ?? r.item_id) === 'string' && typeof r.criterion === 'string' && typeof r.value === 'string')
    .map((r) => ({
      trial_id: String(r.trial_id ?? r.item_id),
      criterion: String(r.criterion),
      value: String(r.value),
      rater: typeof r.rater === 'string' && r.rater ? r.rater : 'rishi',
      second_look: r.second_look === true,
      labelled_at: String(r.labelled_at),
      note: typeof r.note === 'string' ? r.note : null,
    }));
  const items = panelItems(jsonl('judge-panel/d74-test-heldout-advice-v4-framed.jsonl') as unknown as PanelRow[], labelRows, 'gemini-3.8-flash');
  const of = (criterion: string) => figuresOf(
    items.filter((p) => p.criterion === criterion),
    `golden:${criterion}`,
  )!;

  // From `cd stats && uv run evals-panel ../judge-panel/d74-test-heldout-advice-v4-framed.jsonl
  // --labels ../labels/heldout.jsonl --json` (6 Nov), judges["gemini-3.8-flash"].
  it('overall: n 37, 25 / 9 / 3 / 0, kappa -0.14, its interval -0.25 to 0.00', () => {
    const f = of('overall');
    expect({ n: f.n, tp: f.tp, fp: f.fp, fn: f.fn, tn: f.tn, human_no: f.human_no, human_left_out: f.human_left_out, judge_undecided: f.judge_undecided }).toEqual({
      n: 37,
      tp: 25,
      fp: 9,
      fn: 3,
      tn: 0,
      human_no: 9,
      human_left_out: 0,
      judge_undecided: 3,
    });
    expect(f.kappa).toBe(-0.13846153846153872);
    expect(f.agreement).toBe(0.6756756756756757);
    expect(f.sensitivity).toBe(0.8928571428571429);
    expect(f.specificity).toBe(0);
    expect(Math.abs(f.kappa_interval.low! - -0.2542372881355934)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(f.kappa_interval.high! - 0)).toBeLessThanOrEqual(0.05);
    expect(f.kappa_interval.undefined_share).toBe(0);
    // No arms in the panel rows, so the gap cannot be measured.
    expect(f.false_pass_gap).toBeNull();
  });

  it('explains-plainly and asks-deciding-fact: kappa 0, intervals undefined by D77 (14% and 37% of resamples)', () => {
    const e = of('explains-plainly');
    expect([e.n, e.tp, e.fp, e.fn, e.tn, e.judge_undecided]).toEqual([37, 35, 0, 2, 0, 3]);
    expect(e.kappa).toBe(0);
    expect(e.agreement).toBe(0.9459459459459459);
    expect(e.specificity).toBeNull();
    expect(e.kappa_interval.low).toBeNull();
    expect(Math.abs(e.kappa_interval.undefined_share! - 0.1385)).toBeLessThanOrEqual(0.05);
    const a = of('asks-deciding-fact');
    expect([a.n, a.tp, a.fp, a.fn, a.tn, a.judge_undecided]).toEqual([10, 9, 0, 1, 0, 2]);
    expect(a.kappa).toBe(0);
    expect(a.kappa_interval.low).toBeNull();
    expect(Math.abs(a.kappa_interval.undefined_share! - 0.37)).toBeLessThanOrEqual(0.05);
  });

  it('gives the same interval for the same data and seed', () => {
    expect(of('overall').kappa_interval).toEqual(of('overall').kappa_interval);
  });
});
