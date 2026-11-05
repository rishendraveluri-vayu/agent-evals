import type { Json, TrialCause, TrialStatus } from '../contract';
import type { Db } from '../database/db.service';
import { FIRST_RATER } from '../labels/raters';
import { type CauseCall, type CauseGrade, type CauseTrial, causeOf, needsCause, resolveLabels, wantedTools } from './causes';

/**
 * Reads what D64's rules need from what each trial already recorded, in a few batched queries:
 * the trial row (end state, stop reason, LiteLLM's model calls, the spec's limits and
 * required_tools), its execute_tool spans, its current grading's grades and their specs, and
 * Rishi's labels. Arguments, results, grades and labels are read only for the trials that need a
 * cause (a failed agent outcome, or one that ended other than answered). Nothing is written.
 */

type Query = Pick<Db, 'query'>;

export interface TrialFacts {
  id: string;
  task_sha256: string;
  config_hash: string;
  repeat_index: number;
  status: TrialStatus;
  end_state: string | null;
  model_calls: number | null;
  /** The tools the task wants (causes.ts wantedTools). */
  wanted: string[];
  calls: CauseCall[];
  cause: TrialCause | null;
}

interface FactRow {
  id: string;
  task_sha256: string;
  config_hash: string;
  repeat_index: number;
  status: TrialStatus;
  label: string | null;
  end_state: string | null;
  model_calls: number | null;
  harness: string;
  stop_reason: string | null;
  exception: string | null;
  has_answer: boolean;
  malformed: string | null;
  max_steps: string | null;
  timeout_s: string | null;
  max_output_tokens: string | null;
  required_tools: Json;
  job_graders: Json;
  task_graders: Json;
  grade_ids: string[] | null;
  graded_status: string | null;
  graded_outcome: string | null;
}

interface SpanRow {
  trial_id: string;
  tool: string;
  is_error: boolean;
  arguments: string | null;
  result: string | null;
}

interface GradeRow {
  trial_id: string;
  grader_id: string;
  type: string | null;
  required: boolean;
  verdict: string | null;
  reason: string | null;
  evidence: Json;
}

interface LabelRow {
  trial_id: string;
  criterion: string;
  value: string;
  second_look: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: string | null): number | null => (v !== null && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const strings = (v: Json): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Grader specs by id: the grading job's own (what was graded), else the task file's. */
function specsOf(jobGraders: Json, taskGraders: Json): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (Array.isArray(jobGraders) && jobGraders.length) {
    for (const g of jobGraders) if (isObj(g) && isObj(g.spec) && typeof g.spec.id === 'string') out.set(g.spec.id, g.spec);
  } else if (Array.isArray(taskGraders)) {
    for (const g of taskGraders) if (isObj(g) && typeof g.id === 'string') out.set(g.id, g);
  }
  return out;
}

const TRIALS_SQL = `
  SELECT t.id, t.task_sha256, t.config_hash, t.repeat_index, t.status, t.label, t.end_state, t.model_calls, c.harness,
         t.result -> 'end_detail' ->> 'harness_stop_reason' AS stop_reason,
         t.result -> 'end_detail' ->> 'exception_message' AS exception,
         coalesce(t.result ->> 'final_answer', '') <> '' AS has_answer,
         t.result -> 'counts' ->> 'malformed_tool_calls' AS malformed,
         t.spec -> 'settings' ->> 'max_steps' AS max_steps,
         t.spec -> 'settings' ->> 'timeout_s' AS timeout_s,
         t.spec -> 'settings' ->> 'max_output_tokens' AS max_output_tokens,
         coalesce(t.spec -> 'task' -> 'required_tools', k.body -> 'required_tools') AS required_tools,
         gd.graders AS job_graders, k.body -> 'graders' AS task_graders, gd.grade_ids::text[] AS grade_ids,
         gd.status AS graded_status, gd.outcome AS graded_outcome
  FROM trials t
  JOIN tasks k ON k.sha256 = t.task_sha256
  JOIN configs c ON c.hash = t.config_hash
  -- The current grading: the latest finished job, as the run grid and the comparison read it.
  LEFT JOIN LATERAL (
    SELECT j.status, j.outcome, j.graders, j.grade_ids FROM grading_jobs j
    WHERE j.trial_id = t.id AND j.status IN ('done', 'no_graders') ORDER BY j.created_at DESC, j.id DESC LIMIT 1
  ) gd ON true
  WHERE t.id = ANY($1)
  ORDER BY t.seq, t.attempt, t.id`;

// Only a judge grade's per-criterion verdicts, and the evidence of the graders the rules read: a
// judge's evidence holds its whole reply, which the rules never need.
const GRADES_SQL = `
  SELECT g.trial_id, g.grader_id, g.type, g.required, g.verdict, g.reason,
         CASE WHEN jsonb_typeof(g.evidence) <> 'array' THEN '[]'::jsonb
              WHEN g.type = 'judge' THEN coalesce((
                SELECT jsonb_agg(jsonb_build_object('criterion', e -> 'criterion', 'verdict', e -> 'verdict', 'required', e -> 'required'))
                FROM jsonb_array_elements(g.evidence) e WHERE jsonb_typeof(e) = 'object' AND e ? 'criterion'), '[]'::jsonb)
              WHEN g.type IN ('tool_called', 'tool_not_called', 'provenance') THEN g.evidence
              ELSE '[]'::jsonb END AS evidence
  FROM grades g WHERE g.id = ANY($1::bigint[]) ORDER BY g.id`;

export async function loadTrialFacts(db: Query, ids: readonly string[]): Promise<TrialFacts[]> {
  if (!ids.length) return [];
  const rows = await db.query<FactRow>(TRIALS_SQL, [ids]);
  const outcomeOf = (r: FactRow): CauseTrial['outcome'] => (r.graded_status === 'done' && (r.graded_outcome === 'pass' || r.graded_outcome === 'fail' || r.graded_outcome === 'incomplete') ? r.graded_outcome : r.graded_status === 'done' ? 'incomplete' : null);
  const candidates = rows.filter((r) => needsCause({ status: r.status, label: r.label, outcome: outcomeOf(r), end_state: r.end_state })).map((r) => r.id);
  const spans = await db.query<SpanRow>(
    `SELECT s.trial_id, coalesce(s.attributes ->> 'gen_ai.tool.name', substr(s.name, 14)) AS tool,
            coalesce(s.attributes ->> 'evals.tool.is_error', 'false') = 'true' AS is_error,
            CASE WHEN s.trial_id = ANY($2) THEN left(s.attributes ->> 'evals.tool.arguments', 400) END AS arguments,
            CASE WHEN s.trial_id = ANY($2) THEN left(s.attributes ->> 'evals.tool.result', 400) END AS result
     FROM spans s WHERE s.trial_id = ANY($1) AND s.name LIKE 'execute_tool%'
     ORDER BY s.trial_id, s.start_ns, s.span_id`,
    [ids, candidates],
  );
  const wanting = new Set(candidates);
  const gradeIds = rows.filter((r) => wanting.has(r.id)).flatMap((r) => r.grade_ids ?? []);
  const grades = gradeIds.length ? await db.query<GradeRow>(GRADES_SQL, [gradeIds]) : [];
  // A45 reads Rishi's labels. D73: other raters' labels are not read here, so a cause never
  // mixes two people's answers (nor one's second look with another's "unsure").
  const labels = candidates.length
    ? await db.query<LabelRow>('SELECT trial_id, criterion, value, second_look FROM labels WHERE trial_id = ANY($1) AND rater = $2 ORDER BY labelled_at, id', [candidates, FIRST_RATER])
    : [];

  const group = <T extends { trial_id: string }>(list: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const x of list) m.set(x.trial_id, [...(m.get(x.trial_id) ?? []), x]);
    return m;
  };
  const spansBy = group(spans);
  const gradesBy = group(grades);
  const labelsBy = group(labels);

  return rows.map((r) => {
    const specs = specsOf(r.job_graders, r.task_graders);
    const required = strings(r.required_tools);
    const calls: CauseCall[] = (spansBy.get(r.id) ?? []).map((s) => ({ name: s.tool, is_error: s.is_error, arguments: s.arguments, result: s.result }));
    const facts: TrialFacts = {
      id: r.id,
      task_sha256: r.task_sha256,
      config_hash: r.config_hash,
      repeat_index: r.repeat_index,
      status: r.status,
      end_state: r.end_state,
      model_calls: r.model_calls,
      wanted: wantedTools(required, [...specs.values()]),
      calls,
      cause: null,
    };
    if (!wanting.has(r.id)) return facts;
    const causeGrades: CauseGrade[] = (gradesBy.get(r.id) ?? []).map((g) => ({
      grader_id: g.grader_id,
      type: g.type,
      required: g.required,
      verdict: g.verdict,
      reason: g.reason,
      evidence: Array.isArray(g.evidence) ? g.evidence : [],
      spec: specs.get(g.grader_id) ?? null,
    }));
    facts.cause = causeOf({
      status: r.status,
      label: r.label,
      outcome: outcomeOf(r),
      end_state: r.end_state,
      harness: r.harness,
      stop_reason: r.stop_reason,
      exception: r.exception,
      has_answer: r.has_answer,
      model_calls: r.model_calls,
      max_steps: num(r.max_steps),
      timeout_s: num(r.timeout_s),
      max_output_tokens: num(r.max_output_tokens),
      malformed_tool_calls: num(r.malformed),
      required_tools: required,
      calls,
      grades: causeGrades,
      labels: resolveLabels(labelsBy.get(r.id) ?? []),
    });
    return facts;
  });
}

/** The causes of these trials, by id; a trial that needs none is not in the map. */
export async function causesFor(db: Query, ids: readonly string[]): Promise<Map<string, TrialCause>> {
  const out = new Map<string, TrialCause>();
  for (const f of await loadTrialFacts(db, ids)) if (f.cause) out.set(f.id, f.cause);
  return out;
}
