import type { JudgeCriterionTrust } from '../contract';
import { BAR, type JudgedItem, STATUS_ORDER, criterionTrust, judgeStatus } from './trust';

/**
 * D83's statuses, sentences and D8 on SYNTHETIC items only (made-up verdicts; labels/ holds human
 * judgments, never these).
 */

type Kind = 'tp' | 'fp' | 'fn' | 'tn';
const VALUES: Record<Kind, [string, string]> = { tp: ['yes', 'yes'], fp: ['no', 'yes'], fn: ['yes', 'no'], tn: ['no', 'no'] };

/** `counts` items of each kind in one set, task and arm (experiment `e1`). */
function items(set: 'tuning' | 'heldout', counts: Partial<Record<Kind, number>>, opts: { arm?: string; task?: string; prefix?: string } = {}): JudgedItem[] {
  const out: JudgedItem[] = [];
  for (const kind of ['tp', 'fp', 'fn', 'tn'] as const) {
    for (let i = 0; i < (counts[kind] ?? 0); i += 1) {
      const [human, judge] = VALUES[kind];
      out.push({
        trialId: `${opts.prefix ?? set}-${opts.arm ?? 'A'}-${kind}-${i}`,
        criterion: 'overall',
        taskId: opts.task ?? 'task-1',
        set,
        human,
        humanNote: kind === 'fp' ? 'misses the late fee' : null,
        judge,
        judgeReason: kind === 'fp' ? 'it answers the question' : null,
        arms: opts.arm === undefined ? [] : [{ experimentId: 'e1', arm: opts.arm }],
      });
    }
  }
  return out;
}

const trustOf = (list: JudgedItem[], retest: JudgeCriterionTrust['retest'] = null) => criterionTrust('fake/judge:configs/rubrics/advice.v4.md', { criterion: 'overall', text: 'Well served?', items: list, retest });

describe('a judge criterion’s trust status (D83)', () => {
  it('is uncalibrated with no labels on what the judge graded', () => {
    const c = trustOf([]);
    expect(c).toMatchObject({ status: 'uncalibrated', heldout: null, tuning: null, d8: null, retest: null, needs_human_no: 5, disagreements: [] });
    expect(c.summary).toBe('No human labels on outputs this judge graded yet. Treat its verdicts as a hint, and label a few to calibrate it.');
  });

  it('is tuning_only with tuning labels alone, and says it was never tested blind', () => {
    const c = trustOf(items('tuning', { tp: 20, fp: 4, fn: 5, tn: 4 }));
    expect(c.status).toBe('tuning_only');
    expect(c.heldout).toBeNull();
    expect(c.d8).toBeNull();
    expect(c.tuning).toMatchObject({ n: 33, tp: 20, fp: 4, fn: 5, tn: 4, human_no: 8 });
    expect(c.summary).toBe(`Agrees with 33 tuning labels at kappa ${c.tuning!.kappa!.toFixed(2)}, but has never been tested on held-out labels, which decide trust.`);
  });

  it('is too_few with fewer than 5 human "no" labels held out, and says how many more', () => {
    const c = trustOf(items('heldout', { tp: 8, fp: 1, fn: 1, tn: 1 }).concat({ ...items('heldout', { tp: 1 }, { prefix: 'x' })[0], human: 'unsure' }));
    expect(c.status).toBe('too_few');
    expect(c.heldout).toMatchObject({ n: 11, human_no: 2, human_left_out: 1 });
    expect(c.needs_human_no).toBe(3);
    expect(c.summary).toBe('11 held-out labels so far; needs 3 more human "no" labels before the trust bar can be applied.');
    // D8 is still worked out on the held-out pairs, with every reason.
    expect(c.d8!.trusted).toBe(false);
    expect(c.d8!.reasons[0]).toBe('2 human "no" labels, fewer than 5');
  });

  it('is too_few when kappa’s interval is undefined, even with 5 human "no" labels', () => {
    // Humans and judge both say no to 5 and yes to 1: a third or so of resamples miss the one yes.
    const c = trustOf(items('heldout', { tn: 5, tp: 1 }));
    expect(c.heldout!.kappa).toBe(1);
    expect(c.heldout!.kappa_interval.low).toBeNull();
    expect(c.status).toBe('too_few');
    expect(c.needs_human_no).toBeNull();
    expect(c.summary).toMatch(/^6 held-out labels so far, but kappa's interval is undefined \(\d+% of resamples had no kappa\), so the trust bar cannot be applied yet; label more outputs\.$/);
  });

  it('is not_trusted below the bar, with the reasons and the disagreements, held-out first', () => {
    const list = [...items('heldout', { tp: 25, fp: 9, fn: 3 }), ...items('tuning', { fp: 2, fn: 1 })];
    const c = trustOf(list);
    expect(c.status).toBe('not_trusted');
    expect(c.heldout).toMatchObject({ n: 37, tp: 25, fp: 9, fn: 3, tn: 0 });
    expect(c.summary).toBe(`Not trusted: kappa ${c.heldout!.kappa!.toFixed(2)} on 37 held-out labels is below 0.6.`);
    expect(c.d8!.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^kappa -0\.\d\d is below 0\.6$/), 'the false-pass gap between arms could not be measured', 'test-retest agreement is not measured']));
    expect(c.disagreements).toHaveLength(15);
    expect(c.disagreements.slice(0, 12).every((d) => d.set === 'heldout')).toBe(true);
    expect(c.disagreements.slice(12).every((d) => d.set === 'tuning')).toBe(true);
    expect(c.disagreements[0]).toEqual({ trial_id: 'heldout-A-fn-0', task_id: 'task-1', set: 'heldout', human: 'yes', judge: 'no', judge_reason: null, human_note: null });
    expect(c.disagreements.find((d) => d.trial_id === 'heldout-A-fp-0')).toMatchObject({ human: 'no', judge: 'yes', judge_reason: 'it answers the question', human_note: 'misses the late fee' });
  });

  it('never lists more than 50 disagreements', () => {
    expect(trustOf(items('heldout', { fp: 40, fn: 30, tp: 5 })).disagreements).toHaveLength(50);
  });

  it('is trusted only when D8 holds on every count, test-retest included', () => {
    const list = [...items('heldout', { tp: 20, fp: 1, fn: 1, tn: 18 }, { arm: 'A' }), ...items('heldout', { tp: 20, fp: 1, fn: 1, tn: 18 }, { arm: 'B' })];
    const without = trustOf(list);
    expect(without.status).toBe('not_trusted');
    expect(without.d8).toEqual({ trusted: false, reasons: ['test-retest agreement is not measured'] });
    expect(without.summary).toMatch(/^Not trusted yet: kappa 0\.\d\d on 80 held-out labels clears the bar, but its test-retest agreement is not measured; regrade a few judged trials to measure it\.$/);
    expect(without.heldout!.false_pass_gap).toMatchObject({ experiment_id: 'e1', estimate: 0, includes_zero: true });

    const c = trustOf(list, { identical: 19, total: 20, share: 0.95 });
    expect(c.status).toBe('trusted');
    expect(c.d8).toEqual({ trusted: true, reasons: [] });
    expect(c.needs_human_no).toBeNull();
    const h = c.heldout!;
    expect(c.summary).toBe(`Trusted: kappa ${h.kappa!.toFixed(2)} (interval ${h.kappa_interval.low!.toFixed(2)} to ${h.kappa_interval.high!.toFixed(2)}) on 80 held-out labels, no false-pass gap between arms, and 95% test-retest agreement.`);

    const flaky = trustOf(list, { identical: 17, total: 20, share: 0.85 });
    expect(flaky.status).toBe('not_trusted');
    expect(flaky.summary).toBe('Not trusted: it gives the same verdict on a regrade only 85% of the time, below 90%.');
  });

  it('is not trusted when one arm’s false passes rise: the gap’s interval leaves out 0', () => {
    const list = [...items('heldout', { tp: 20, fp: 0, tn: 20 }, { arm: 'A' }), ...items('heldout', { tp: 20, fp: 12, tn: 8 }, { arm: 'B' })];
    const c = trustOf(list, { identical: 10, total: 10, share: 1 });
    expect(c.heldout!.false_pass_gap).toMatchObject({ experiment_id: 'e1', estimate: 0.6, includes_zero: false });
    // D86: the reason names the experiment.
    expect(c.d8!.reasons).toContain("the false-pass rate differs between arms in experiment e1 (a gap's interval leaves out 0)");
  });

  // D86 (review 7 Nov, F6; Rishi: "Match the Python reference"): the gap must hold 0 in every
  // experiment, as `no_false_pass_gap` in stats/agreement.py, not only in the one with most pairs.
  describe('the false-pass gap on every experiment (D86)', () => {
    /** `counts` held-out items of each kind on one arm of one experiment. */
    const inArm = (experimentId: string, arm: 'A' | 'B', counts: Partial<Record<Kind, number>>): JudgedItem[] =>
      items('heldout', counts, { arm, prefix: `${experimentId}-${arm}` }).map((p) => ({ ...p, arms: [{ experimentId, arm }] }));
    // e_small: the judge passes every arm-B output the humans failed, and no arm-A one.
    const small = [...inArm('e_small', 'A', { tp: 10, tn: 10 }), ...inArm('e_small', 'B', { tp: 10, fp: 10 })];
    // e_big: the judge agrees with the humans everywhere, on five times the pairs.
    const big = [...inArm('e_big', 'A', { tp: 50, tn: 50 }), ...inArm('e_big', 'B', { tp: 50, tn: 50 })];
    const retest = { identical: 20, total: 20, share: 1 };

    it('does not trust a judge 100 points kinder to one arm of a small experiment because a larger one is clean (F6)', () => {
      const c = trustOf([...small, ...big], retest);
      // Kappa clears the bar on the pooled pairs: only the gap can catch it.
      expect(c.heldout!.kappa!).toBeGreaterThanOrEqual(0.6);
      expect(c.heldout!.kappa_interval.low!).toBeGreaterThanOrEqual(0.4);
      expect(c.status).toBe('not_trusted');
      expect(c.heldout!.false_pass_gap).toMatchObject({ experiment_id: 'e_small', estimate: 1, includes_zero: false });
      expect(c.d8).toEqual({ trusted: false, reasons: ["the false-pass rate differs between arms in experiment e_small (a gap's interval leaves out 0)"] });
      expect(c.summary).toBe('Not trusted: on 240 held-out labels it passes bad answers more often in one arm than the other in experiment e_small (false-pass gap 1.00, B minus A).');
    });

    it('names every experiment whose gap leaves 0 out', () => {
      const other = [...inArm('e_other', 'A', { tp: 10, tn: 10 }), ...inArm('e_other', 'B', { tp: 10, fp: 10 })];
      const c = trustOf([...small, ...big, ...other], retest);
      expect(c.d8!.reasons).toEqual(["the false-pass rate differs between arms in experiments e_other and e_small (a gap's interval leaves out 0)"]);
      expect(c.heldout!.false_pass_gap!.experiment_id).toBe('e_other');
    });

    it('trusts the judge when every experiment’s gap holds 0, reading the gap of the one with most pairs', () => {
      const fair = [...inArm('e_small', 'A', { tp: 10, tn: 10 }), ...inArm('e_small', 'B', { tp: 10, tn: 10 })];
      const c = trustOf([...fair, ...big], retest);
      expect(c.status).toBe('trusted');
      expect(c.heldout!.false_pass_gap).toMatchObject({ experiment_id: 'e_big', estimate: 0, includes_zero: true });
    });

    it('fails D8 when one experiment’s gap cannot be measured, and says which', () => {
      // e_thin: one human "no" per arm among 20 pairs, so most resamples miss one: the interval is undefined.
      const thin = [...inArm('e_thin', 'A', { tp: 19, tn: 1 }), ...inArm('e_thin', 'B', { tp: 19, tn: 1 })];
      const c = trustOf([...big, ...thin], retest);
      expect(c.heldout!.false_pass_gap).toMatchObject({ experiment_id: 'e_thin', includes_zero: null });
      expect(c.status).toBe('not_trusted');
      expect(c.d8!.reasons).toEqual(['the false-pass gap between arms could not be measured in experiment e_thin']);
      expect(c.summary).toMatch(/^Not trusted yet: kappa \d\.\d\d on 240 held-out labels clears the bar, but the false-pass gap between arms could not be measured in experiment e_thin; label more outputs it should fail in both its arms\.$/);
    });

    it('leaves out an experiment without a human "no" on both arms, as before', () => {
      const oneSided = [...inArm('e_one', 'A', { tp: 10, tn: 10 }), ...inArm('e_one', 'B', { tp: 10, fn: 2 })];
      const c = trustOf([...big, ...oneSided], retest);
      expect(c.heldout!.false_pass_gap!.experiment_id).toBe('e_big');
      expect(c.status).toBe('trusted');
    });
  });

  it('is computed the same way twice: the intervals are seeded by judge, criterion and set', () => {
    const list = items('heldout', { tp: 10, fp: 3, fn: 2, tn: 6 });
    expect(trustOf(list)).toEqual(trustOf(list));
  });
});

describe("a judge's own status (D83)", () => {
  const crit = (criterion: string, status: JudgeCriterionTrust['status']): JudgeCriterionTrust => ({ ...trustOf([]), criterion, status, summary: `${status} summary.` });

  it('is its overall criterion’s when it has one', () => {
    expect(judgeStatus([crit('plain', 'uncalibrated'), crit('overall', 'trusted')])).toEqual({ status: 'trusted', summary: 'trusted summary.' });
  });

  it('is otherwise its least trusted criterion’s, in the order uncalibrated, tuning_only, too_few, not_trusted, trusted', () => {
    expect(STATUS_ORDER).toEqual(['uncalibrated', 'tuning_only', 'too_few', 'not_trusted', 'trusted']);
    expect(judgeStatus([crit('a', 'trusted'), crit('b', 'too_few'), crit('c', 'not_trusted')])).toEqual({ status: 'too_few', summary: 'On b, its least trusted criterion: too_few summary.' });
    expect(judgeStatus([]).status).toBe('uncalibrated');
  });

  it('states the bar it applies', () => {
    expect(BAR).toEqual({ kappa: 0.6, kappa_low: 0.4, retest: 0.9, min_human_no: 5, max_undefined_share: 0.05, resamples: 2000, human_unsure: 'exclude' });
  });
});
