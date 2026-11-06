import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { CompareStats } from '../contract';
import { isFakeModel } from '../experiments/estimate';
import { statsTasks, versionTasks } from '../experiments/experiments.service';
import { spanRows } from '../worker/report';
import { analyse } from './analysis';
import { gradedAlike } from './graded-alike';

/**
 * The five shipped examples' results, recomputed from their bundles (`examples/<name>/rows.json.gz`)
 * the way `statsOf` reads them from the database after a load: the done trials, each one's latest
 * finished grading and its grades, LiteLLM's retries from the chat spans. A change to the
 * statistics that moves a shipped verdict, interval or p-value fails here (destructive review, 6 Nov).
 */

const EXAMPLES = path.resolve(__dirname, '../../../../examples');

type Row = Record<string, unknown>;
type TrialRows = Parameters<typeof statsTasks>[1];
type GradeRows = Parameters<typeof statsTasks>[2];

const str = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The latest grading job of a trial with a status in `statuses`, as the SQL's LATERAL picks it. */
function latestJob(jobs: Row[], statuses: (s: string) => boolean): Row | null {
  const sorted = jobs.filter((j) => statuses(String(j.status))).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || String(y.id).localeCompare(String(x.id)));
  return sorted[0] ?? null;
}

function judgeModel(g: Row): string | null {
  if (g.kind !== 'judge') return null;
  if (typeof g.judge_model === 'string' && g.judge_model) return g.judge_model;
  for (const e of Array.isArray(g.evidence) ? (g.evidence as Row[]) : []) if (e && e.source === 'judge_call' && typeof e.model === 'string' && e.model) return e.model;
  return null;
}

export function shippedAnalysis(name: string): { stats: CompareStats; alike: boolean } {
  const bundle = JSON.parse(gunzipSync(readFileSync(path.join(EXAMPLES, name, 'rows.json.gz'))).toString('utf8')) as { tables: Record<string, Row[]> };
  const t = bundle.tables;
  const e = t.experiments[0] as { id: string; n: number; calibration: boolean; task_sha256s: string[]; config_hashes: string[] };
  const jobsOf = new Map<string, Row[]>();
  for (const j of t.grading_jobs) jobsOf.set(String(j.trial_id), [...(jobsOf.get(String(j.trial_id)) ?? []), j]);
  const rawSpans = new Map<string, unknown[]>();
  for (const s of t.spans) rawSpans.set(String(s.trial_id), [...(rawSpans.get(String(s.trial_id)) ?? []), s.raw]);
  const trials: TrialRows = t.trials
    .filter((x) => x.status === 'done')
    .map((x) => {
      const id = String(x.id);
      const jobs = jobsOf.get(id) ?? [];
      const gd = latestJob(jobs, (s) => s === 'done' || s === 'no_graders');
      const gl = latestJob(jobs, (s) => s !== 'superseded');
      const chats = spanRows(rawSpans.get(id) ?? []).rows.filter((s) => s.name.startsWith('chat '));
      const attempts = chats.map((s) => str(s.attributes['evals.proxy.attempts'])).filter((v): v is string => v !== null && /^[0-9]+$/.test(v));
      const usage = (x.runner_report as Row | null)?.proxy_usage as Row | undefined;
      return {
        id,
        task_sha256: String(x.task_sha256),
        config_hash: String(x.config_hash),
        repeat_index: Number(x.repeat_index),
        cost_usd: num(x.cost_usd),
        input_tokens: num(x.input_tokens),
        output_tokens: num(x.output_tokens),
        wall_s: num(x.wall_s),
        retried_calls: str(usage?.retried_calls),
        job_id: gd ? String(gd.id) : null,
        job_status: gd ? (gd.status as TrialRows[number]['job_status']) : null,
        outcome: gd ? (gd.outcome as TrialRows[number]['outcome']) : null,
        graders: gd ? (gd.graders as TrialRows[number]['graders']) : null,
        grade_ids: gd ? (gd.grade_ids as unknown[]).map(String) : null,
        latest_status: gl ? (gl.status as TrialRows[number]['latest_status']) : null,
        attempts_known: chats.length ? attempts.length > 0 : null,
        span_retried: chats.length ? attempts.some((v) => Number(v) > 1) : null,
        attempt: Number(x.attempt),
      };
    })
    .sort((a, b) => a.task_sha256.localeCompare(b.task_sha256) || a.repeat_index - b.repeat_index || a.attempt - b.attempt || a.id.localeCompare(b.id));
  const current = new Set(trials.flatMap((x) => x.grade_ids ?? []));
  const grades: GradeRows = t.grades
    .filter((g) => current.has(String(g.id)))
    .sort((x, y) => Number(x.id) - Number(y.id))
    .map((g) => ({
      trial_id: String(g.trial_id),
      grader_id: String(g.grader_id),
      required: g.required === true,
      verdict: str(g.verdict),
      grader_version: String(g.grader_version),
      spec_sha256: str(g.spec_sha256),
      framework_version: str(g.framework_version),
      kind: g.kind as GradeRows[number]['kind'],
      judge_model: judgeModel(g),
    }));
  const taskIds = new Map(t.tasks.map((k) => [String(k.sha256), String(k.id)]));
  const alike = gradedAlike(versionTasks(e, trials, grades, taskIds)).alike;
  const models = t.configs.filter((c) => e.config_hashes.slice(0, 2).includes(String(c.hash))).map((c) => String(c.model));
  const { stats } = analyse({ seed: e.id, tasks: statsTasks(e, trials, grades, taskIds), madeUpPrices: models.some(isFakeModel), calibration: e.calibration });
  if (!stats) throw new Error(`${name}: no statistics`);
  return { stats, alike };
}

/** The pinned part of a result: the aggregate, the verdict, the guardrail and each task's figures. */
function summary(s: CompareStats) {
  return {
    a: s.a,
    b: s.b,
    diff: s.diff,
    p: s.p_value,
    verdict: s.verdict,
    pass_rate_verdict: s.pass_rate_verdict,
    critical: { status: s.critical.status, tasks: s.critical.tasks, diff: s.critical.diff, blocks_better: s.critical.blocks_better },
    calibration: s.calibration?.as_expected ?? null,
    excluded: s.excluded_tasks.length,
    /** [task id, B - A in points, Fisher's p, BH q, beyond noise] */
    tasks: s.tasks.map((t) => [t.task_id, t.diff.estimate, t.p_value, t.q_value, t.beyond_noise]),
  };
}

const names = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const counts = (rate: number, passed: number, graded: number) => ({ rate, passed, graded, incomplete: 0 });
const same = (ids: string[], at: Record<string, [number, number, number, boolean]>) => ids.map((id) => [id, ...(at[id] ?? [0, 1, 1, false])]);
const HELD_OUT = ['draft-college-cost-stepup', 'draft-convo-consolidation', 'draft-convo-job-loss', 'draft-convo-phone-loan', 'draft-first-year-interest', 'draft-loan-to-clear-card', 'draft-otp-scam', 'draft-prepay-personal-loan', 'draft-sip-education-goal', 'draft-spending-review'];
const ONLY_FIVE = 'Only 5 of the 10 tasks passed at different rates in the two arms, and only those count in the paired test: over 5 its smallest possible p is 0.0625, so it could not reach p < 0.05 however large the difference.';
const NO_CRITICAL_CHANGE = 'Critical failures: 0.0 points (95% interval 0.0 to 0.0) over 8 tasks with 13 critical checks. No rise beyond noise.';

/** As computed at 30ce17c, before the destructive review's statistics fixes, and checked against the reviewer's own recomputation. */
const PINNED: Record<string, { summary: ReturnType<typeof summary>; text: string; critical: string; calibration: string | null }> = {
  'headline-prompt-v1-vs-v2': {
    summary: {
      a: counts(0.64, 64, 100),
      b: counts(0.73, 73, 100),
      diff: { estimate: 9, low: 3, high: 16 },
      p: 0.0625,
      verdict: 'no_detectable_difference',
      pass_rate_verdict: 'no_detectable_difference',
      critical: { status: 'did_not_rise', tasks: 8, diff: { estimate: 0, low: 0, high: 0 }, blocks_better: false },
      calibration: null,
      excluded: 0,
      tasks: same(HELD_OUT, {
        'draft-college-cost-stepup': [10, 1, 1, false],
        'draft-convo-consolidation': [30, 0.3498, 1, false],
        'draft-convo-job-loss': [10, 1, 1, false],
        'draft-convo-phone-loan': [30, 0.3498, 1, false],
        'draft-loan-to-clear-card': [10, 1, 1, false],
      }),
    },
    text: `No detectable difference: +9.0 points (95% interval +3.0 to +16.0), p = 0.0625 by the paired sign-flip test over 10 tasks. Differences as large as 16 points are not ruled out. ${ONLY_FIVE}`,
    critical: NO_CRITICAL_CHANGE,
    calibration: null,
  },
  'headline-prompt-v1-vs-v2-zz-aa-calibration': {
    summary: {
      a: counts(0.62, 62, 100),
      b: counts(0.58, 58, 100),
      diff: { estimate: -4, low: -12, high: 3 },
      p: 0.5,
      verdict: 'no_detectable_difference',
      pass_rate_verdict: 'no_detectable_difference',
      critical: { status: 'did_not_rise', tasks: 8, diff: { estimate: 0, low: 0, high: 0 }, blocks_better: false },
      calibration: true,
      excluded: 0,
      tasks: same(HELD_OUT, {
        'draft-convo-consolidation': [-20, 0.4737, 1, false],
        'draft-convo-job-loss': [10, 1, 1, false],
        'draft-convo-phone-loan': [-10, 1, 1, false],
        'draft-loan-to-clear-card': [-30, 0.3698, 1, false],
        'draft-sip-education-goal': [10, 1, 1, false],
      }),
    },
    text: `No detectable difference: -4.0 points (95% interval -12.0 to +3.0), p = 0.5 by the paired sign-flip test over 10 tasks. Differences as large as 12 points are not ruled out. ${ONLY_FIVE}`,
    critical: NO_CRITICAL_CHANGE,
    calibration: "As it should, this A/A run found no detectable difference: the same config on both arms gave -4.0 points (95% interval -12.0 to +3.0). Its interval, 15 points wide, is this setup's own noise at this N and task count.",
  },
  'positive-control-calculators-down': {
    summary: {
      a: counts(0.2095, 22, 105),
      b: counts(0.6571, 69, 105),
      diff: { estimate: 44.76, low: 23.81, high: 65.71 },
      p: 0.001099,
      verdict: 'better',
      pass_rate_verdict: 'better',
      critical: { status: 'did_not_rise', tasks: 13, diff: { estimate: -40, low: -63.08, high: -16.92 }, blocks_better: false },
      calibration: null,
      excluded: 0,
      tasks: [
        ['draft-car-loan-afford', 80, 0.04762, 0.1111, false],
        ['draft-college-cost-stepup', 100, 0.007937, 0.02381, true],
        ['draft-convo-car', 0, 1, 1, false],
        ['draft-convo-consolidation', 0, 1, 1, false],
        ['draft-convo-distress', -20, 1, 1, false],
        ['draft-convo-job-loss', -40, 0.5238, 0.8462, false],
        ['draft-convo-payoff', 40, 0.4444, 0.7778, false],
        ['draft-convo-phone-loan', 40, 0.4444, 0.7778, false],
        ['draft-convo-where-to-start', 0, 1, 1, false],
        ['draft-distress-helpline', 0, 1, 1, false],
        ['draft-emi-home-loan', 100, 0.007937, 0.02381, true],
        ['draft-fd-real-value', 100, 0.007937, 0.02381, true],
        ['draft-first-year-interest', 100, 0.007937, 0.02381, true],
        ['draft-loan-to-clear-card', 60, 0.1667, 0.35, false],
        ['draft-mba-loan-missing-info', 0, 1, 1, false],
        ['draft-otp-scam', 0, 1, 1, false],
        ['draft-payoff-order', 100, 0.007937, 0.02381, true],
        ['draft-prepay-bonus', 100, 0.007937, 0.02381, true],
        ['draft-prepay-personal-loan', 100, 0.007937, 0.02381, true],
        ['draft-sip-education-goal', 80, 0.04762, 0.1111, false],
        ['draft-spending-review', 0, 1, 1, false],
      ],
    },
    text: 'B passes more than A: +44.8 points (95% interval +23.8 to +65.7), p = 0.001099 by the paired sign-flip test over 21 tasks.',
    critical: 'Critical failures: -40.0 points (95% interval -63.1 to -16.9) over 13 tasks with 20 critical checks. No rise beyond noise.',
    calibration: null,
  },
  'replication-langgraph-prompt-v1-vs-v2': {
    summary: {
      a: counts(0.55, 55, 100),
      b: counts(0.72, 72, 100),
      diff: { estimate: 17, low: 5, high: 29 },
      p: 0.04688,
      verdict: 'better',
      pass_rate_verdict: 'better',
      critical: { status: 'did_not_rise', tasks: 8, diff: { estimate: 0, low: 0, high: 0 }, blocks_better: false },
      calibration: null,
      excluded: 0,
      tasks: same(HELD_OUT, {
        'draft-college-cost-stepup': [10, 1, 1, false],
        'draft-convo-consolidation': [50, 0.06978, 0.4334, false],
        'draft-convo-job-loss': [20, 0.582, 1, false],
        'draft-convo-phone-loan': [20, 0.582, 1, false],
        'draft-loan-to-clear-card': [40, 0.1409, 0.4696, false],
        'draft-sip-education-goal': [-10, 1, 1, false],
        'draft-spending-review': [40, 0.08669, 0.4334, false],
      }),
    },
    text: 'B passes more than A: +17.0 points (95% interval +5.0 to +29.0), p = 0.04688 by the paired sign-flip test over 10 tasks.',
    critical: NO_CRITICAL_CHANGE,
    calibration: null,
  },
  'replication-own-loop-prompt-v1-vs-v2': {
    summary: {
      a: counts(0.56, 56, 100),
      b: counts(0.64, 64, 100),
      diff: { estimate: 8, low: -4, high: 23.02 },
      p: 0.4375,
      verdict: 'no_detectable_difference',
      pass_rate_verdict: 'no_detectable_difference',
      critical: { status: 'did_not_rise', tasks: 8, diff: { estimate: 2.5, low: 0, high: 6.25 }, blocks_better: false },
      calibration: null,
      excluded: 0,
      tasks: same(HELD_OUT, {
        'draft-convo-consolidation': [40, 0.1698, 0.849, false],
        'draft-convo-job-loss': [-10, 1, 1, false],
        'draft-loan-to-clear-card': [60, 0.01977, 0.1977, false],
        'draft-sip-education-goal': [-20, 0.6285, 1, false],
        'draft-spending-review': [10, 1, 1, false],
      }),
    },
    text: `No detectable difference: +8.0 points (95% interval -4.0 to +23.0), p = 0.4375 by the paired sign-flip test over 10 tasks. Differences as large as 23 points are not ruled out. ${ONLY_FIVE}`,
    critical: 'Critical failures: +2.5 points (95% interval 0.0 to +6.3) over 8 tasks with 13 critical checks. No rise beyond noise.',
    calibration: null,
  },
};

describe('the shipped examples recompute exactly', () => {
  it('ships the five examples this test pins', () => {
    expect(names).toEqual(Object.keys(PINNED).sort());
  });

  it.each(names)('%s', (name) => {
    const { stats, alike } = shippedAnalysis(name);
    const pinned = PINNED[name];
    expect(alike).toBe(true);
    expect(summary(stats)).toEqual(pinned.summary);
    expect(stats.verdict_text).toBe(pinned.text);
    expect(stats.critical.text).toBe(pinned.critical);
    expect(stats.calibration?.text ?? null).toBe(pinned.calibration);
  });
});
