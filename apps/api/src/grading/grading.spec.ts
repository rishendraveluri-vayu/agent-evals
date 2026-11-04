import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Json, JsonObject } from '../contract';
import type { AppConfig } from '../common/app-config';
import type { TaskFile } from '../catalogue/catalogue-files';
import type { Db } from '../database/db.service';
import { type GraderEntry, graderSet, graderVersion, kindOf, outcomeOf, parseGradesReport, specSha256, taskCoreSha } from './grading-core';
import { GradingService } from './grading.service';

const REPO = path.resolve(__dirname, '../../../..');

interface Vectors {
  framework_version: string;
  cases: { spec: Json; files: Record<string, string | null>; spec_sha256: string; grader_version: string }[];
}

describe('grader versions', () => {
  // The same file graders/tests/test_canonical.py checks with the Python framework's hashing.
  const vectors = JSON.parse(readFileSync(path.join(REPO, 'graders/tests/hash_vectors.json'), 'utf8')) as Vectors;

  it.each(vectors.cases.map((c) => [(c.spec as { id: string }).id, c] as const))('matches the Python framework on %s', (_id, c) => {
    expect(specSha256(c.spec, c.files)).toBe(c.spec_sha256);
    expect(graderVersion(c.spec_sha256, vectors.framework_version)).toBe(c.grader_version);
  });

  it('covers a unit test grader file, and says when it is missing', async () => {
    const spec = { id: 'u', type: 'unit_test' };
    const set = await graderSet([spec, { id: 'n', type: 'number', expected: 1 }], (name) => Promise.resolve(name === 'grader.py' ? Buffer.from('test') : null));
    expect(set.files['grader.py']).toEqual({
      sha256: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      base64: Buffer.from('test').toString('base64'),
    });
    expect(set.graders[0].spec_sha256).toBe(specSha256(spec, { 'grader.py': 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }));
    expect(set.graders[1].spec_sha256).toBe(specSha256({ id: 'n', type: 'number', expected: 1 }, {}));
    const missing = await graderSet([{ id: 'u', type: 'unit_test', file: 'checks.py' }], () => Promise.resolve(null));
    expect(missing.files).toEqual({ 'checks.py': null });
    expect(missing.graders[0].spec_sha256).toBe(specSha256({ id: 'u', type: 'unit_test', file: 'checks.py' }, { 'checks.py': null }));
  });

  it('maps types to the data model kinds', () => {
    expect(['number', 'regex_absent', 'tool_called', 'end_state', 'provenance', 'required_tools', 'unit_test', 'judge', 'nonsense', undefined].map(kindOf)).toEqual([
      'exact',
      'exact',
      'state',
      'state',
      'state',
      'state',
      'unit',
      'judge',
      'invalid',
      'invalid',
    ]);
  });
});

describe('the task core', () => {
  const body: JsonObject = { id: 'emi', version: '1', summary: 'a', messages: [{ role: 'user', content: 'EMI?' }], graders: [{ id: 'a' }] };

  it('ignores graders, version and summary', () => {
    expect(taskCoreSha({ ...body, version: '2', summary: 'b', graders: [] }, null)).toBe(taskCoreSha(body, null));
  });

  it('changes with the messages or the client file', () => {
    expect(taskCoreSha({ ...body, messages: [{ role: 'user', content: 'EMI now?' }] }, null)).not.toBe(taskCoreSha(body, null));
    expect(taskCoreSha(body, 'sha256:aa')).not.toBe(taskCoreSha(body, null));
  });
});

describe('the outcome', () => {
  const g = (verdict: 'pass' | 'fail' | 'error' | 'not_applicable' | 'not_implemented', required = true) => ({ verdict, required });
  it('is the same rule as the Python framework', () => {
    expect(outcomeOf([g('pass'), g('fail', false)])).toEqual({ passed: true, outcome: 'pass' });
    expect(outcomeOf([g('pass'), g('fail')])).toEqual({ passed: false, outcome: 'fail' });
    expect(outcomeOf([g('fail'), g('error')])).toEqual({ passed: false, outcome: 'fail' });
    expect(outcomeOf([g('pass'), g('error')])).toEqual({ passed: null, outcome: 'incomplete' });
    expect(outcomeOf([g('not_implemented')])).toEqual({ passed: null, outcome: 'incomplete' });
    expect(outcomeOf([g('pass', false)])).toEqual({ passed: null, outcome: 'incomplete' });
  });
});

describe('a grades report', () => {
  const graders: GraderEntry[] = [
    { spec: { id: 'a', type: 'end_state', states: ['answered'] }, spec_sha256: 'sha256:' + '1'.repeat(64) },
    { spec: { id: 'b', type: 'number', expected: 5 }, spec_sha256: 'sha256:' + '2'.repeat(64) },
  ];
  const grade = (i: number, over: Record<string, unknown> = {}) => ({
    grader_id: (graders[i].spec as { id: string }).id,
    type: (graders[i].spec as { type: string }).type,
    required: true,
    verdict: 'pass',
    score: 1,
    reason: 'ok',
    evidence: [{ source: 'final_answer', quote: 'x' }],
    grader_version: graderVersion(graders[i].spec_sha256, '0.1.0'),
    ...over,
  });
  const report = (grades: unknown[], over: Record<string, unknown> = {}) => ({ worker_id: 'g1', job_id: 'g_1', attempt: 1, framework_version: '0.1.0', grades, ...over });

  it('is accepted with one grade per grader, in order, at the versions the API computes', () => {
    const r = parseGradesReport(report([grade(0), grade(1)]), graders);
    expect(r.grades.map((g) => [g.grader_id, g.kind, g.verdict])).toEqual([
      ['a', 'state', 'pass'],
      ['b', 'exact', 'pass'],
    ]);
  });

  it.each([
    ['a missing grade', () => report([grade(0)]), 'grades_mismatch'],
    ['grades out of order', () => report([grade(1), grade(0)]), 'grades_mismatch'],
    ['a version from another spec', () => report([grade(0), grade(1, { grader_version: graderVersion(graders[0].spec_sha256, '0.1.0') })]), 'grader_version_mismatch'],
    ['another framework version than claimed', () => report([grade(0), grade(1)], { framework_version: '0.2.0' }), 'grader_version_mismatch'],
    ['an unknown verdict', () => report([grade(0, { verdict: 'maybe' }), grade(1)]), 'invalid_grade'],
    ['a score over 1', () => report([grade(0, { score: 2 }), grade(1)]), 'invalid_grade'],
    ['evidence that is not objects', () => report([grade(0, { evidence: ['x'] }), grade(1)]), 'invalid_grade'],
    ['no claim number', () => report([grade(0), grade(1)], { attempt: 0 }), 'invalid_report'],
  ])('is refused with %s', (_what, build, code) => {
    expect(() => parseGradesReport(build(), graders)).toThrow(expect.objectContaining({ code }) as Error);
  });
});

describe('which graders grade a trial', () => {
  const service = new GradingService({ tasksDir: '/repo/tasks' } as AppConfig, null as unknown as Db);
  const body: JsonObject = { id: 'emi', version: '1', messages: [{ role: 'user', content: 'EMI?' }], graders: [{ id: 'old', type: 'end_state', states: ['answered'] }] };
  const trial = { trial_id: 't1', task_sha256: 'sha256:old', task_id: 'emi', body, client_state_sha256: null };
  const file = (b: JsonObject, sha: string, dir = 'emi', version = b.version as string): TaskFile =>
    ({ sha256: sha, id: 'emi', version, body: b, graders: b.graders, clientStateSha256: null, sourcePath: `tasks/${dir}/task.json`, problems: [] }) as unknown as TaskFile;

  it('takes the current graders when only the graders changed', () => {
    const fixed = { ...body, version: '2', graders: [{ id: 'new', type: 'end_state', states: ['answered', 'step_limit'] }] };
    const c = service.choose(trial, [file(fixed, 'sha256:new')]);
    expect(c.source).toBe('catalogue');
    expect(c.taskSha256).toBe('sha256:new');
    expect(c.specs).toEqual(fixed.graders);
    expect(c.folder).toBe(path.join('/repo/tasks', 'emi'));
    expect(c.note).toContain('differs from the trial\'s task only in its graders');
  });

  it('keeps the trial\'s own graders when the task itself changed, or is gone', () => {
    const changed = { ...body, version: '2', messages: [{ role: 'user', content: 'EMI on 20 lakh?' }] };
    const c = service.choose(trial, [file(changed, 'sha256:changed')]);
    expect(c.source).toBe('trial_task');
    expect(c.specs).toEqual(body.graders);
    expect(c.folder).toBeNull();
    expect(c.note).toContain('changed beyond its graders');
    expect(service.choose(trial, []).note).toContain('not in the catalogue');
  });
});
