import { statsTasks } from './experiments.service';

/** statsTasks: the trial rows the statistics read, turned into the analysis input. Synthetic rows. */

type TrialRows = Parameters<typeof statsTasks>[1];
type GradeRows = Parameters<typeof statsTasks>[2];

const exp = { task_sha256s: ['sha256:t'], config_hashes: ['sha256:a', 'sha256:b'], n: 2, calibration: false };
const row = (id: string, config: string, input: number | null, output: number | null): TrialRows[number] => ({
  id,
  task_sha256: 'sha256:t',
  config_hash: config,
  repeat_index: 0,
  cost_usd: 0.01,
  input_tokens: input,
  output_tokens: output,
  wall_s: 5,
  retried_calls: '0',
  job_id: `j-${id}`,
  job_status: 'done',
  outcome: 'pass',
  graders: [{ spec: { id: 'advice', severity: 'major' } }],
  grade_ids: [`g-${id}`],
  latest_status: 'done',
  attempts_known: true,
  span_retried: false,
});
const grade = (trial: string): GradeRows[number] => ({ trial_id: trial, grader_id: 'advice', required: true, verdict: 'pass', grader_version: 'v1', spec_sha256: null, framework_version: null, kind: 'judge', judge_model: 'm' });

describe('statsTasks', () => {
  it('sums tokens only when both counts are recorded: a missing half is not a 0', () => {
    const rows = [row('both', 'sha256:a', 1000, 200), row('no-output', 'sha256:a', 1000, null), row('no-input', 'sha256:b', null, 200), row('none', 'sha256:b', null, null)];
    const [t] = statsTasks(exp, rows, [], new Map([['sha256:t', 't']]));
    expect(t.trials.map((x) => [x.trial_id, x.tokens])).toEqual([
      ['both', 1200],
      ['no-output', null],
      ['no-input', null],
      ['none', null],
    ]);
  });

  it("carries each grade's kind and its severity from the grading's frozen spec", () => {
    const [t] = statsTasks(exp, [row('x', 'sha256:a', 1, 1)], [grade('x')], new Map([['sha256:t', 't']]));
    expect(t.trials[0].grades).toEqual([{ grader_id: 'advice', required: true, verdict: 'pass', severity: 'major', kind: 'judge' }]);
  });
});
