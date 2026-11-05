import type { GradeKind, Json } from '../contract';
import { type VersionGrade, type VersionTask, type VersionTrial, changeWords, gradedAlike, noVerdictNote } from './graded-alike';

/** D72: both arms graded alike, or no verdict. Synthetic grades only. */

const JUDGE: Json = { id: 'advice', type: 'judge', required: true, rubric: 'configs/rubrics/advice.v1.md', criteria: ['c'] };
const NUMBER: Json = { id: 'emi', type: 'number', expected: 5 };

/** A grade of `spec` at a version made of its spec hash (`sha`) and the framework. */
function grade(spec: Json, sha: string, over: Partial<VersionGrade> = {}): VersionGrade {
  const s = spec as { id: string; type: string; required?: boolean };
  const kind: GradeKind = s.type === 'judge' ? 'judge' : s.type === 'unit_test' ? 'unit' : 'exact';
  const framework = over.framework_version ?? '0.6.0';
  return {
    grader_id: s.id,
    grader_version: `v:${sha}:${framework}`,
    spec_sha256: sha,
    framework_version: framework,
    required: s.required !== false,
    kind,
    judge_model: kind === 'judge' ? 'fake/judge' : null,
    spec,
    ...over,
  };
}

const trial = (arm: 'A' | 'B', ...grades: VersionGrade[]): VersionTrial => ({ arm, grades });
const task = (id: string, ...trials: VersionTrial[]): VersionTask => ({ task: `sha256:${id}`, task_id: id, trials });

describe('both arms graded alike (D72)', () => {
  it('finds nothing when every grader has one version over both arms', () => {
    const t = task('t1', trial('A', grade(NUMBER, 's1'), grade(JUDGE, 'r1')), trial('B', grade(NUMBER, 's1'), grade(JUDGE, 'r1')));
    expect(gradedAlike([t])).toEqual({ alike: true, blocking: [], optional: [], note: null });
  });

  it('blocks on a required judge whose rubric changed between the arms, and says so', () => {
    const t = task('t1', trial('A', grade(JUDGE, 'r1')), trial('A', grade(JUDGE, 'r1')), trial('B', grade(JUDGE, 'r2')), trial('B', grade(JUDGE, 'r2')));
    const check = gradedAlike([t]);
    expect(check.alike).toBe(false);
    expect(check.optional).toEqual([]);
    expect(check.blocking).toEqual([
      {
        task: 'sha256:t1',
        task_id: 't1',
        grader_id: 'advice',
        required: true,
        kind: 'judge',
        changes: ['files'],
        versions: [
          { grader_version: 'v:r1:0.6.0', judge_model: 'fake/judge', a: 2, b: 0 },
          { grader_version: 'v:r2:0.6.0', judge_model: 'fake/judge', a: 0, b: 2 },
        ],
      },
    ]);
    expect(changeWords(check.blocking[0])).toBe('its rubric changed');
  });

  it('blocks on a mix inside the arms too: grading that spanned an edit is not alike', () => {
    const t = task('t1', trial('A', grade(NUMBER, 's1')), trial('A', grade(NUMBER, 's2')), trial('B', grade(NUMBER, 's1')), trial('B', grade(NUMBER, 's2')));
    const [d] = gradedAlike([t]).blocking;
    expect(d.versions.map((v) => [v.a, v.b])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it('reports an optional grader that differs, and leaves the verdict to stand', () => {
    const tone: Json = { id: 'tone', type: 'judge', required: false, rubric: 'configs/rubrics/advice.v1.md', criteria: ['c'] };
    const tasks = [task('t1', trial('A', grade(NUMBER, 's1'), grade(tone, 'r1')), trial('B', grade(NUMBER, 's1'), grade(tone, 'r2')))];
    const check = gradedAlike(tasks);
    expect(check.blocking).toEqual([]);
    expect(check.optional.map((d) => [d.grader_id, d.required, d.changes])).toEqual([['tone', false, ['files']]]);
    expect(check.alike).toBe(false);
    expect(check.note).toBe(
      "1 optional check on 1 task has grades from different versions in the two arms (D72): tone on t1 (its rubric changed). Optional checks do not decide a trial's outcome, so the verdict stands; the regression list's pass rates for them compare different versions. A regrade brings them onto one version.",
    );
  });

  it('blocks when the judge called different models under one version, but not for a judge that called none', () => {
    const one = task('t1', trial('A', grade(JUDGE, 'r1', { judge_model: 'gemini-3.8-flash' })), trial('B', grade(JUDGE, 'r1', { judge_model: 'claude-haiku-5-5' })));
    const [d] = gradedAlike([one]).blocking;
    expect(d.changes).toEqual(['judge_model']);
    expect(changeWords(d)).toBe('judge models claude-haiku-5-5 and gemini-3.8-flash');
    // Not approved for some trials: no call, so no model to differ by (those trials are incomplete).
    const unjudged = task('t2', trial('A', grade(JUDGE, 'r1', { judge_model: null })), trial('B', grade(JUDGE, 'r1')));
    expect(gradedAlike([unjudged]).alike).toBe(true);
  });

  it('tells a spec change from a file change and a framework change', () => {
    const changed: Json = { ...(NUMBER as object), expected: 6 };
    const spec = gradedAlike([task('t1', trial('A', grade(NUMBER, 's1')), trial('B', grade(changed, 's2')))]).blocking[0];
    expect(spec.changes).toEqual(['spec']);
    expect(changeWords(spec)).toBe('its spec changed');
    const framework = gradedAlike([task('t1', trial('A', grade(NUMBER, 's1')), trial('B', grade(NUMBER, 's1', { framework_version: '0.7.0' })))]).blocking[0];
    expect(framework.changes).toEqual(['framework']);
    const unit: Json = { id: 'unit', type: 'unit_test' };
    expect(changeWords(gradedAlike([task('t1', trial('A', grade(unit, 'u1')), trial('B', grade(unit, 'u2')))]).blocking[0])).toBe('its grader file changed');
  });

  it('counts a trial graded without a grader the others have as a version of its own', () => {
    // Arm A was graded before a required check was added (or with no graders at all), arm B after.
    const t = task('t1', trial('A', grade(NUMBER, 's1')), trial('A'), trial('B', grade(NUMBER, 's1'), grade(JUDGE, 'r1')), trial('B', grade(NUMBER, 's1'), grade(JUDGE, 'r1')));
    const check = gradedAlike([t]);
    expect(check.blocking.map((d) => [d.grader_id, d.changes])).toEqual([
      ['emi', ['not_graded']],
      ['advice', ['not_graded']],
    ]);
    expect(check.blocking[1].versions).toEqual([
      { grader_version: null, judge_model: null, a: 2, b: 0 },
      { grader_version: 'v:r1:0.6.0', judge_model: 'fake/judge', a: 0, b: 2 },
    ]);
  });

  it('blocks when a grader is required in either version', () => {
    const optional: Json = { ...(JUDGE as object), required: false };
    const t = task('t1', trial('A', grade(optional, 'r1')), trial('B', grade(JUDGE, 'r2')));
    expect(gradedAlike([t]).blocking.map((d) => [d.grader_id, d.required, d.changes])).toEqual([['advice', true, ['spec']]]);
  });

  it('says why there is no verdict: a few graders and tasks by name, the rest counted, and to regrade', () => {
    const tasks = ['t1', 't2', 't3', 't4'].map((id) => task(id, trial('A', grade(JUDGE, 'r1')), trial('B', grade(JUDGE, 'r2'))));
    const check = gradedAlike(tasks);
    expect(noVerdictNote(check, { experimentId: 'e_1', tasks: 7, reused: null })).toBe(
      'The two arms were not graded alike (D72): 4 required checks on 4 of 7 tasks have current grades from different grader versions, which would score the arms by different rules: ' +
        'advice on t1 (its rubric changed); advice on t2 (its rubric changed); advice on t3 (its rubric changed); and 1 more. ' +
        'Regrade the experiment (POST /api/experiments/e_1/regrade) so every trial is graded with the graders as they are now; the verdict comes back once those grades are in.',
    );
    const one = gradedAlike(tasks.slice(0, 1));
    const note = noVerdictNote(one, { experimentId: 'e_2', tasks: 1, reused: { trials: 10, parent: 'e_parent' } });
    expect(note).toContain('1 required check on 1 of 1 task has current grades');
    expect(note).toContain('Regrade the experiment (POST /api/experiments/e_2/regrade), which also regrades the 10 trials arm A reuses from e_parent so every trial');
  });
});
