import type { GradeKind, GradeVerdict, GradingOutcome, Json, JsonObject } from '../contract';
import { badRequest } from '../common/api-error';
import { hashCanonical, sha256Ref } from '../common/hashing';

/**
 * Pure parts of grading (SP4, R14): which graders a trial is graded with, each grader's version,
 * and checking a grader worker's report. The grader format is a draft for Rishi
 * (docs/proposals/grader-format.md); the Python framework is graders/ (evals_graders).
 */

export const GRADING_LEASE_S = 120;
/** A job whose lease lapses this many times is marked failed, so a grading crash never loops. */
export const MAX_GRADING_CLAIMS = 3;
export const MAX_GRADER_FILE_BYTES = 256 * 1024;
const GRADER_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.py$/;
const VERDICTS: readonly GradeVerdict[] = ['pass', 'fail', 'not_applicable', 'error', 'not_implemented'];

const KIND: Record<string, GradeKind> = {
  number: 'exact',
  regex_present: 'exact',
  regex_absent: 'exact',
  tool_called: 'state',
  tool_not_called: 'state',
  end_state: 'state',
  provenance: 'state',
  required_tools: 'state',
  unit_test: 'unit',
  judge: 'judge',
};

export function kindOf(type: unknown): GradeKind {
  return typeof type === 'string' && type in KIND ? KIND[type] : 'invalid';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The file a unit_test grader runs (next to task.json), or null for every other type. */
export function graderFileOf(spec: Json): string | null {
  if (!isObject(spec) || spec.type !== 'unit_test') return null;
  const name = spec.file === undefined ? 'grader.py' : spec.file;
  return typeof name === 'string' && GRADER_FILE.test(name) ? name : null;
}

/** A judge's rubric, as a repo-relative path: one file directly under configs/rubrics/, nothing else. */
export const RUBRIC_PATH = /^configs\/rubrics\/[A-Za-z0-9._-]+\.md$/;

/**
 * The rubric file a judge grader reads, as a repo-relative path, or null for every other type
 * and for a rubric that is not a file under configs/rubrics/ (like an invalid unit_test file
 * name: no file, so nothing outside that folder is ever read). A string `rubric` is the path;
 * `{id, version}` is `configs/rubrics/<id>.<version>.md`, as prompts are named.
 */
export function rubricPathOf(spec: Json): string | null {
  if (!isObject(spec) || spec.type !== 'judge') return null;
  const r = spec.rubric;
  const rel = typeof r === 'string' ? r : isObject(r) && typeof r.id === 'string' && typeof r.version === 'string' ? `configs/rubrics/${r.id}.${r.version}.md` : null;
  return rel !== null && RUBRIC_PATH.test(rel) ? rel : null;
}

/** The spec plus the sha256 of each file it runs. Equal to evals_graders.canonical.spec_sha256. */
export function specSha256(spec: Json, files: Record<string, string | null>): string {
  return hashCanonical({ spec, files });
}

/** Equal to evals_graders.canonical.grader_version. Both inputs are strings, so no number formatting is involved. */
export function graderVersion(specSha: string, frameworkVersion: string): string {
  return hashCanonical({ framework: frameworkVersion, spec: specSha });
}

/**
 * What identifies a task apart from its graders: a task.json whose graders (or version or
 * summary) changed is the same task for grading, so its new graders may grade old trials. Any
 * other change (the messages, the simulated client, the client file) makes it a different task.
 */
export function taskCoreSha(body: JsonObject, clientStateSha256: string | null): string {
  const rest: JsonObject = {};
  for (const [k, v] of Object.entries(body)) if (k !== 'graders' && k !== 'version' && k !== 'summary') rest[k] = v;
  return hashCanonical({ task: rest, client_state: clientStateSha256 });
}

export interface GraderEntry {
  spec: Json;
  spec_sha256: string;
}

export interface GraderFile {
  sha256: string;
  base64: string;
}

type Reader = ((name: string) => Promise<Buffer | null>) | null;

/**
 * The frozen grader set of one job. `readFile` returns a file next to task.json (a unit_test's
 * grader file), `readRepoFile` a repo file by its repo-relative path (a judge's rubric under
 * configs/rubrics/); each gives the bytes, or null. A grader's files are keyed in `files` and in
 * its spec hash by that name or path, so editing a grader.py or a rubric gives new versions.
 */
export async function graderSet(
  specs: Json[],
  readFile: Reader,
  readRepoFile: Reader = null,
): Promise<{ graders: GraderEntry[]; files: Record<string, GraderFile | null> }> {
  const files: Record<string, GraderFile | null> = {};
  const graders: GraderEntry[] = [];
  for (const spec of specs) {
    const hashes: Record<string, string | null> = {};
    const name = graderFileOf(spec);
    const rubric = rubricPathOf(spec);
    for (const [key, read] of [
      [name, readFile],
      [rubric, readRepoFile],
    ] as const) {
      if (!key) continue;
      if (!(key in files)) {
        const data = read ? await read(key) : null;
        files[key] = data && data.length <= MAX_GRADER_FILE_BYTES ? { sha256: sha256Ref(data), base64: data.toString('base64') } : null;
      }
      hashes[key] = files[key]?.sha256 ?? null;
    }
    graders.push({ spec, spec_sha256: specSha256(spec, hashes) });
  }
  return { graders, files };
}

/** The task's outcome from its grades: the same rule as evals_graders.graders.outcome. */
export function outcomeOf(grades: { required: boolean; verdict: GradeVerdict }[]): { passed: boolean | null; outcome: GradingOutcome } {
  const required = grades.filter((g) => g.required);
  if (!required.length) return { passed: null, outcome: 'incomplete' };
  if (required.some((g) => g.verdict === 'fail')) return { passed: false, outcome: 'fail' };
  if (required.some((g) => g.verdict !== 'pass')) return { passed: null, outcome: 'incomplete' };
  return { passed: true, outcome: 'pass' };
}

export interface ReportedGrade {
  grader_id: string;
  grader_version: string;
  type: string;
  kind: GradeKind;
  required: boolean;
  verdict: GradeVerdict;
  score: number | null;
  reason: string | null;
  evidence: Json[];
  spec_sha256: string;
}

export interface GradesReport {
  worker_id: string;
  job_id: string;
  attempt: number;
  framework_version: string;
  grades: ReportedGrade[];
  problems: string[];
}

const MAX_REASON = 4000;
const MAX_EVIDENCE = 50;
const MAX_EVIDENCE_JSON = 64 * 1024;

/**
 * Checks a report against the job it is for: one grade per grader, in order, each with the
 * version the API computes from the job's spec hash and the reported framework version, so a
 * worker cannot record a grade for a spec it did not run.
 */
export function parseGradesReport(raw: unknown, graders: GraderEntry[]): GradesReport {
  if (!isObject(raw)) throw badRequest('invalid_report', 'the report must be a JSON object');
  const { worker_id, job_id, attempt, framework_version, grades, problems } = raw;
  if (typeof worker_id !== 'string' || !worker_id) throw badRequest('invalid_report', 'worker_id is required');
  if (typeof job_id !== 'string' || !job_id) throw badRequest('invalid_report', 'job_id is required');
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) throw badRequest('invalid_report', 'attempt must be the claim number');
  if (typeof framework_version !== 'string' || !framework_version || framework_version.length > 64) {
    throw badRequest('invalid_report', 'framework_version is required');
  }
  if (!Array.isArray(grades)) throw badRequest('invalid_report', 'grades must be a list');
  if (grades.length !== graders.length) {
    throw badRequest('grades_mismatch', `the job has ${graders.length} grader(s); the report has ${grades.length} grade(s)`);
  }
  const out: ReportedGrade[] = grades.map((g, i) => {
    const entry = graders[i];
    const specId = isObject(entry.spec) && typeof entry.spec.id === 'string' ? entry.spec.id : '?';
    const where = `grades[${i}]`;
    if (!isObject(g)) throw badRequest('invalid_grade', `${where} must be an object`);
    if (g.grader_id !== specId) throw badRequest('grades_mismatch', `${where} is ${String(g.grader_id)}, but the job's grader ${i} is ${specId}`);
    const expected = graderVersion(entry.spec_sha256, framework_version);
    if (g.grader_version !== expected) {
      throw badRequest('grader_version_mismatch', `${where} (${specId}) has version ${String(g.grader_version)}; the job's spec and framework ${framework_version} give ${expected}`);
    }
    if (typeof g.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(g.verdict)) {
      throw badRequest('invalid_grade', `${where}.verdict must be one of ${VERDICTS.join(', ')}`);
    }
    const score = g.score ?? null;
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      throw badRequest('invalid_grade', `${where}.score must be a number from 0 to 1, or null`);
    }
    if (typeof g.required !== 'boolean') throw badRequest('invalid_grade', `${where}.required must be true or false`);
    const reason = g.reason ?? null;
    if (reason !== null && typeof reason !== 'string') throw badRequest('invalid_grade', `${where}.reason must be a string`);
    const evidence = g.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE || !evidence.every(isObject)) {
      throw badRequest('invalid_grade', `${where}.evidence must be a list of at most ${MAX_EVIDENCE} objects`);
    }
    if (JSON.stringify(evidence).length > MAX_EVIDENCE_JSON) throw badRequest('invalid_grade', `${where}.evidence is over ${MAX_EVIDENCE_JSON} characters`);
    const type = typeof g.type === 'string' ? g.type.slice(0, 64) : isObject(entry.spec) && typeof entry.spec.type === 'string' ? entry.spec.type : 'unknown';
    return {
      grader_id: specId,
      grader_version: expected,
      type,
      kind: kindOf(isObject(entry.spec) ? entry.spec.type : undefined),
      required: g.required,
      verdict: g.verdict as GradeVerdict,
      score,
      reason: reason === null ? null : reason.slice(0, MAX_REASON),
      evidence: evidence as Json[],
      spec_sha256: entry.spec_sha256,
    };
  });
  const notes = Array.isArray(problems) ? problems.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 500)).slice(0, 50) : [];
  return { worker_id, job_id, attempt, framework_version, grades: out, problems: notes };
}
