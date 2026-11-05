import type { GradeKind, GraderVersionChange, GraderVersionCheck, GraderVersionCount, GraderVersionDifference, Json } from '../contract';
import { canonicalJson } from '../common/hashing';

/**
 * D72, as Rishi decided it: a comparison gives no verdict when, on any task, a required grader's
 * current grades in the two arms come from different grader versions. A grader's version
 * (grading-core.ts graderVersion) already hashes its spec, the files it reads (a judge's rubric, a
 * unit test's grader.py) and the framework version; a judge's model is not in it, so it is checked
 * beside it.
 *
 * The rule as built: on each task, every grader's current grades over both arms' done trials must
 * be one version, and a judge's must have called one model. So arm A on one version and arm B on
 * another differs, and so does a mix inside an arm (grading that spanned an edit). A trial whose
 * current grading has no grade from a grader that other trials of the task have (the grader was
 * added or removed since) counts as a version of its own. A judge grade that called no model (not
 * approved, or it stopped before the call) has no model to compare, so it never differs by model
 * alone: it is incomplete, and the statistics already leave it out and count it. A grader required
 * in any of those gradings blocks the verdict; an optional one is reported, and the verdict stands.
 * Pure: no database, no clock.
 */

/** One grade of a trial's current grading, as the check reads it. */
export interface VersionGrade {
  grader_id: string;
  grader_version: string;
  spec_sha256: string | null;
  framework_version: string | null;
  required: boolean;
  kind: GradeKind;
  /** For a judge, the model the grade called; null when it called none, and for other kinds. */
  judge_model: string | null;
  /** The spec the grading froze for this grader, to tell a spec change from a file change. */
  spec: Json | null;
}

/** One done trial with a finished current grading (`done`, or `no_graders` with no grades). */
export interface VersionTrial {
  arm: 'A' | 'B';
  grades: VersionGrade[];
}

export interface VersionTask {
  task: string;
  task_id: string;
  trials: VersionTrial[];
}

/** How many examples a note names before "and N more". */
const EXAMPLES = 3;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function changesOf(held: (VersionGrade | null)[]): GraderVersionChange[] {
  const graded = held.filter((g): g is VersionGrade => g !== null);
  const out: GraderVersionChange[] = [];
  const specs = new Map<string, Set<string | null>>();
  for (const g of graded) {
    const key = canonicalJson(g.spec);
    specs.set(key, (specs.get(key) ?? new Set()).add(g.spec_sha256));
  }
  if (specs.size > 1) out.push('spec');
  // The same spec with two hashes: a file it reads changed (its spec hash covers the spec and those files).
  if ([...specs.values()].some((shas) => shas.size > 1)) out.push('files');
  if (new Set(graded.map((g) => g.framework_version)).size > 1) out.push('framework');
  if (new Set(graded.flatMap((g) => (g.judge_model ? [g.judge_model] : []))).size > 1) out.push('judge_model');
  if (held.includes(null)) out.push('not_graded');
  return out;
}

/** Every grader, task by task, whose current grades are not one version over both arms (D72). */
export function gradedAlike(tasks: VersionTask[]): GraderVersionCheck {
  const blocking: GraderVersionDifference[] = [];
  const optional: GraderVersionDifference[] = [];
  for (const t of tasks) {
    const ids: string[] = [];
    for (const tr of t.trials) for (const g of tr.grades) if (!ids.includes(g.grader_id)) ids.push(g.grader_id);
    for (const id of ids) {
      const held = t.trials.map((tr) => ({ arm: tr.arm, grade: tr.grades.find((g) => g.grader_id === id) ?? null }));
      const graded = held.flatMap((h) => (h.grade ? [h.grade] : []));
      const versions = new Set(held.map((h) => h.grade?.grader_version ?? null));
      const models = new Set(graded.flatMap((g) => (g.judge_model ? [g.judge_model] : [])));
      if (versions.size <= 1 && models.size <= 1) continue;
      const counts = new Map<string, GraderVersionCount>();
      for (const h of held) {
        const version = h.grade?.grader_version ?? null;
        const model = h.grade?.judge_model ?? null;
        const key = JSON.stringify([version, model]);
        const c = counts.get(key) ?? { grader_version: version, judge_model: model, a: 0, b: 0 };
        if (h.arm === 'A') c.a += 1;
        else c.b += 1;
        counts.set(key, c);
      }
      const diff: GraderVersionDifference = {
        task: t.task,
        task_id: t.task_id,
        grader_id: id,
        required: graded.some((g) => g.required),
        kind: graded[0].kind,
        changes: changesOf(held.map((h) => h.grade)),
        // Most trials first; ties by version, so the order is stable.
        versions: [...counts.values()].sort((x, y) => y.a + y.b - (x.a + x.b) || String(x.grader_version).localeCompare(String(y.grader_version)) || String(x.judge_model).localeCompare(String(y.judge_model))),
      };
      (diff.required ? blocking : optional).push(diff);
    }
  }
  return { alike: !blocking.length && !optional.length, blocking, optional, note: optionalNote(optional) };
}

/** What changed, in a few words: "its rubric changed", "judge models a and b". */
export function changeWords(d: GraderVersionDifference): string {
  const models = [...new Set(d.versions.flatMap((v) => (v.judge_model ? [v.judge_model] : [])))];
  const words = d.changes.map((c) => {
    switch (c) {
      case 'spec':
        return 'its spec changed';
      case 'files':
        return d.kind === 'judge' ? 'its rubric changed' : d.kind === 'unit' ? 'its grader file changed' : 'a file it reads changed';
      case 'framework':
        return 'the grader framework version changed';
      case 'judge_model':
        return `judge models ${models.join(' and ')}`;
      case 'not_graded':
        return 'some trials have no grade from it';
    }
  });
  return words.join('; ');
}

/** "advice on stat-1 (its rubric changed); tone on stat-2 (...); and 2 more". */
function examples(diffs: GraderVersionDifference[]): string {
  const named = diffs.slice(0, EXAMPLES).map((d) => `${d.grader_id} on ${d.task_id} (${changeWords(d) || 'its version changed'})`);
  const rest = diffs.length - named.length;
  return named.join('; ') + (rest ? `; and ${rest} more` : '');
}

const taskCount = (diffs: GraderVersionDifference[]): number => new Set(diffs.map((d) => d.task)).size;

function optionalNote(diffs: GraderVersionDifference[]): string | null {
  if (!diffs.length) return null;
  const n = diffs.length;
  return (
    `${plural(n, 'optional check')} on ${plural(taskCount(diffs), 'task')} ${n === 1 ? 'has' : 'have'} grades from different versions in the two arms (D72): ${examples(diffs)}. ` +
    "Optional checks do not decide a trial's outcome, so the verdict stands; the regression list's pass rates for them compare different versions. " +
    'A regrade brings them onto one version.'
  );
}

/**
 * Why there is no verdict, when a required grader differs (D72): which graders and tasks, a few by
 * name and the rest counted, and the fix, a regrade (which covers a reused arm A's trials too).
 */
export function noVerdictNote(check: GraderVersionCheck, ctx: { experimentId: string; tasks: number; reused: { trials: number; parent: string } | null }): string {
  const d = check.blocking;
  const n = d.length;
  const reused = ctx.reused && ctx.reused.trials ? `, which also regrades the ${plural(ctx.reused.trials, 'trial')} arm A reuses from ${ctx.reused.parent}` : '';
  // Other screens put "No verdict yet." before a stats_note, so it opens with the reason.
  return (
    `The two arms were not graded alike (D72): ${plural(n, 'required check')} on ${taskCount(d)} of ${plural(ctx.tasks, 'task')} ` +
    `${n === 1 ? 'has' : 'have'} current grades from different grader versions, which would score the arms by different rules: ${examples(d)}. ` +
    `Regrade the experiment (POST /api/experiments/${ctx.experimentId}/regrade)${reused} so every trial is graded with the graders as they are now; ` +
    'the verdict comes back once those grades are in.'
  );
}
