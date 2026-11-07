import { Injectable, Logger } from '@nestjs/common';
import type { CompareStats, Json, JudgeTrust, JudgeTrustResponse } from '../contract';
import { badRequest, notFound } from '../common/api-error';
import { Db } from '../database/db.service';
import { TRIAL_IN_ARM } from '../experiments/run-state';
import { JUDGE_MODEL_SQL, rubricPathOf } from '../grading/grading-core';
import { LabelsService } from '../labels/labels.service';
import { D8_KAPPA, type LabelRow, type SettledLabel, humanMajority, raterLabels, retestOf, splitKey } from './agreement';
import { BAR, type JudgedItem, POLICY, type TrustSet, criterionTrust, judgeStatus, tasksWithPairs } from './trust';

/** One judge grade of a done grading job, with what trust reads of it. */
interface GradingRow {
  job_id: string;
  trial_id: string;
  experiment_id: string | null;
  task_id: string;
  /** The job is the trial's current grading (the latest done one). */
  current: boolean;
  judge_model: string | null;
  /** The job's frozen spec for this grader, or null. */
  spec: Json | null;
  /** The criterion items of the evidence: reason and quote only on a current grading. */
  items: { criterion: string; verdict: string | null; reason: string | null; quote: string | null }[];
}

interface CurrentGrade {
  taskId: string;
  experimentId: string | null;
  /** criterion -> the judge's verdict and its reason or quote */
  verdicts: Map<string, { verdict: string; reason: string | null }>;
  /** The criteria of the judge's spec on this trial. */
  criteria: Set<string>;
}

interface JudgeAcc {
  model: string;
  rubric: string;
  /** trial -> its current grade by this judge */
  current: Map<string, CurrentGrade>;
  /** trial -> its gradings by this judge, newest first: job id and {criterion: verdict} */
  gradings: Map<string, { job: string; verdicts: Record<string, string> }[]>;
  /** criterion -> its text (first seen), in first-seen order */
  criteria: Map<string, string | null>;
}

/** A judge's trust, with what the comparison also needs. */
interface Computed {
  trust: JudgeTrust;
  /** experiment -> trials of it with a current grade from this judge */
  perExperiment: Map<string, number>;
  /** The held-out tasks with pairs on `overall`. */
  overallTasks: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A judge spec's criteria as {id, text}: strings or {id, text|description}, as labels.service's judgeCriteria reads them. */
function specCriteria(spec: Json | null): { id: string; text: string | null }[] {
  if (!isObj(spec) || !Array.isArray(spec.criteria)) return [];
  const out: { id: string; text: string | null }[] = [];
  for (const c of spec.criteria) {
    if (typeof c === 'string') out.push({ id: c, text: c });
    else if (isObj(c) && typeof c.id === 'string') out.push({ id: c.id, text: typeof c.text === 'string' ? c.text : typeof c.description === 'string' ? c.description : null });
  }
  return out;
}

function rubricOf(spec: Json | null): string {
  const path = rubricPathOf(spec ?? null);
  if (path) return path;
  if (isObj(spec) && typeof spec.rubric === 'string' && spec.rubric) return spec.rubric;
  return 'unknown';
}

/**
 * D83: how far to trust each LLM judge, computed live from the humans' labels and the judge's
 * grades (GET /judge/trust). Reads only; never changes a grade or a verdict.
 */
@Injectable()
export class JudgeTrustService {
  private readonly logger = new Logger(JudgeTrustService.name);
  private cache: { key: string; judges: Computed[] } | null = null;

  constructor(
    private readonly db: Db,
    private readonly labels: LabelsService,
  ) {}

  /** GET /judge/trust[?experiment=<id>]: every judge, or the experiment's judges; trust always over all labels. */
  async trust(experimentInput?: unknown): Promise<JudgeTrustResponse> {
    if (experimentInput !== undefined && typeof experimentInput !== 'string') throw badRequest('invalid_query', 'give experiment once', 'Send one experiment parameter.');
    const experimentId = experimentInput === '' ? undefined : experimentInput;
    if (experimentId !== undefined) await this.requireExperiment(experimentId);
    const judges = await this.compute();
    return { bar: BAR, judges: judges.filter((j) => experimentId === undefined || (j.perExperiment.get(experimentId) ?? 0) > 0).map((j) => j.trust) };
  }

  /**
   * The comparison's `stats.judge` (D83): the held-out figures of `overall` for the experiment's
   * judge, the one with the most current grades on its trials; null without held-out pairs, or
   * when kappa or its interval is undefined. It sits beside the verdict and never changes it, so
   * an error working it out leaves it null (logged) rather than failing the comparison (review
   * 7 Nov, F2).
   */
  async forComparison(experimentId: string): Promise<CompareStats['judge']> {
    try {
      return await this.comparisonJudge(experimentId);
    } catch (err) {
      this.logger.warn(`the judge trust for the comparison of ${experimentId} failed, so stats.judge is null: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async comparisonJudge(experimentId: string): Promise<CompareStats['judge']> {
    let best: Computed | null = null;
    for (const j of await this.compute()) {
      const n = j.perExperiment.get(experimentId) ?? 0;
      if (n > 0 && (!best || n > (best.perExperiment.get(experimentId) ?? 0))) best = j;
    }
    const held = best?.trust.criteria.find((c) => c.criterion === 'overall')?.heldout;
    if (!best || !held || held.kappa === null || held.kappa_interval.low === null || held.kappa_interval.high === null || !best.overallTasks) return null;
    return { kappa: held.kappa, low: held.kappa_interval.low, high: held.kappa_interval.high, bar: D8_KAPPA, tasks: best.overallTasks };
  }

  private async requireExperiment(id: string): Promise<void> {
    const [e] = await this.db.query<{ id: string }>('SELECT id FROM experiments WHERE id = $1', [id]);
    if (!e) throw notFound('unknown_experiment', `no experiment ${id}`, 'Use an experiment id from GET /experiments.');
  }

  /** Every judge's trust, cached until a label, a finished grading job or an arm changes. */
  private async compute(): Promise<Computed[]> {
    // The label files stay the source (R14): import any line not in the table yet, as the queue does.
    for (const set of ['tuning', 'heldout'] as const) await this.labels.importFile(set);
    const [{ key }] = await this.db.query<{ key: string }>(
      `SELECT (SELECT count(*) || ':' || coalesce(max(id), 0) FROM labels) || '|' ||
              (SELECT count(*) || ':' || coalesce(max(reported_at)::text, '') FROM grading_jobs WHERE status = 'done') || '|' ||
              (SELECT count(*) || ':' || coalesce(sum(cardinality(reused_trial_ids)), 0) FROM experiment_arms) AS key`,
    );
    if (this.cache?.key === key) return this.cache.judges;
    const judges = await this.computeFresh();
    this.cache = { key, judges };
    return judges;
  }

  private async computeFresh(): Promise<Computed[]> {
    const rows = await this.db.query<GradingRow>(
      `SELECT j.id AS job_id, j.trial_id, t.experiment_id, k.id AS task_id, (j.id = cj.id) AS current,
              ${JUDGE_MODEL_SQL('g')} AS judge_model,
              (SELECT s -> 'spec' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.graders) = 'array' THEN j.graders ELSE '[]'::jsonb END) s
                WHERE s -> 'spec' ->> 'id' = g.grader_id LIMIT 1) AS spec,
              (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'criterion', e ->> 'criterion',
                        'verdict', CASE WHEN jsonb_typeof(e -> 'verdict') = 'string' THEN e ->> 'verdict' END,
                        'reason', CASE WHEN j.id = cj.id AND jsonb_typeof(e -> 'reason') = 'string' THEN left(e ->> 'reason', 1000) END,
                        'quote', CASE WHEN j.id = cj.id AND jsonb_typeof(e -> 'quote') = 'string' THEN left(e ->> 'quote', 600) END) ORDER BY x.ord), '[]'::jsonb)
                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(g.evidence) = 'array' THEN g.evidence ELSE '[]'::jsonb END) WITH ORDINALITY AS x (e, ord)
                WHERE jsonb_typeof(e) = 'object' AND jsonb_typeof(e -> 'criterion') = 'string') AS items
       FROM grading_jobs j
       JOIN current_grading cj ON cj.trial_id = j.trial_id
       JOIN grades g ON g.id = ANY (j.grade_ids) AND g.kind = 'judge'
       JOIN trials t ON t.id = j.trial_id
       JOIN tasks k ON k.sha256 = t.task_sha256
       WHERE j.status = 'done'
       ORDER BY j.trial_id, j.created_at DESC, j.id DESC, g.id`,
    );
    const accs = new Map<string, JudgeAcc>();
    for (const r of rows) {
      // A judge grade that called no model (not approved, or it stopped first) is no judge's verdict.
      if (!r.judge_model) continue;
      const rubric = rubricOf(r.spec);
      const id = `${r.judge_model}\u0000${rubric}`;
      let acc = accs.get(id);
      if (!acc) accs.set(id, (acc = { model: r.judge_model, rubric, current: new Map(), gradings: new Map(), criteria: new Map() }));
      const listed = specCriteria(r.spec);
      for (const c of listed) if (!acc.criteria.has(c.id)) acc.criteria.set(c.id, c.text);
      for (const it of r.items) if (!acc.criteria.has(it.criterion)) acc.criteria.set(it.criterion, null);
      // Retest: every grading by this judge, newest first; two grades of one job are one grading.
      const runs = acc.gradings.get(r.trial_id) ?? [];
      let run = runs.find((x) => x.job === r.job_id);
      if (!run) runs.push((run = { job: r.job_id, verdicts: {} }));
      for (const it of r.items) if (!(it.criterion in run.verdicts)) run.verdicts[it.criterion] = it.verdict ?? 'missing';
      acc.gradings.set(r.trial_id, runs);
      if (!r.current) continue;
      let cur = acc.current.get(r.trial_id);
      if (!cur) acc.current.set(r.trial_id, (cur = { taskId: r.task_id, experimentId: r.experiment_id, verdicts: new Map(), criteria: new Set() }));
      for (const c of listed) cur.criteria.add(c.id);
      for (const it of r.items) {
        if (cur.verdicts.has(it.criterion)) continue;
        cur.verdicts.set(it.criterion, { verdict: it.verdict ?? 'missing', reason: it.reason || it.quote || null });
        cur.criteria.add(it.criterion);
      }
    }
    if (!accs.size) return [];

    const trialIds = [...new Set([...accs.values()].flatMap((a) => [...a.current.keys()]))];
    const arms = await this.armsOf(trialIds);
    const experimentIds = new Set([...arms.values()].flat().map((m) => m.experimentId));
    for (const a of accs.values()) for (const c of a.current.values()) if (c.experimentId) experimentIds.add(c.experimentId);
    const experimentsAt = new Map(
      (await this.db.query<{ id: string; created_at: Date }>('SELECT id, created_at FROM experiments WHERE id = ANY($1::text[])', [[...experimentIds]])).map((e) => [e.id, e.created_at.getTime()]),
    );
    const labels = await this.settledLabels();

    const out: Computed[] = [];
    for (const acc of accs.values()) {
      const perExperiment = new Map<string, number>();
      for (const [trial, cur] of acc.current) {
        const ids = new Set([...(cur.experimentId ? [cur.experimentId] : []), ...(arms.get(trial) ?? []).map((m) => m.experimentId)]);
        for (const e of ids) perExperiment.set(e, (perExperiment.get(e) ?? 0) + 1);
      }
      const byCriterion = new Map<string, JudgedItem[]>([...acc.criteria.keys()].map((c) => [c, []]));
      for (const set of ['heldout', 'tuning'] as const) {
        for (const [key, human] of labels[set]) {
          const [trial, criterion] = splitKey(key);
          const cur = acc.current.get(trial);
          if (!cur || !cur.criteria.has(criterion)) continue;
          const v = cur.verdicts.get(criterion);
          byCriterion.get(criterion)?.push({
            trialId: trial,
            criterion,
            taskId: cur.taskId,
            set,
            human: human.value,
            humanNote: human.note,
            judge: v?.verdict ?? 'missing',
            judgeReason: v?.reason ?? null,
            arms: arms.get(trial) ?? [],
          });
        }
      }
      const gradings = [...acc.gradings.values()].map((runs) => runs.map((r) => r.verdicts));
      const criteria = [...acc.criteria.entries()].map(([criterion, text]) =>
        criterionTrust(`${acc.model}:${acc.rubric}`, { criterion, text, items: byCriterion.get(criterion) ?? [], retest: retestOf(gradings, criterion) }),
      );
      const { status, summary } = judgeStatus(criteria);
      const experiments = [...perExperiment.keys()].sort((a, b) => (experimentsAt.get(b) ?? 0) - (experimentsAt.get(a) ?? 0) || (a < b ? 1 : a > b ? -1 : 0));
      out.push({
        trust: { judge_model: acc.model, rubric: acc.rubric, experiments, trials_judged: acc.current.size, criteria, status, summary },
        perExperiment,
        overallTasks: tasksWithPairs((byCriterion.get('overall') ?? []).filter((p) => p.set === 'heldout')),
      });
    }
    // Most-used judges first.
    return out.sort((a, b) => b.trust.trials_judged - a.trust.trials_judged || cmp(a.trust.judge_model, b.trust.judge_model) || cmp(a.trust.rubric, b.trust.rubric));
  }

  /** Each trial's experiments and arms: its own experiment's arm (TRIAL_IN_ARM), and arm A of any experiment that reuses it (D34). */
  private async armsOf(trialIds: string[]): Promise<Map<string, { experimentId: string; arm: string }[]>> {
    const rows = await this.db.query<{ experiment_id: string; arm: string; trial_id: string }>(
      `SELECT a.experiment_id, a.arm, t.id AS trial_id
       FROM experiment_arms a JOIN experiments e ON e.id = a.experiment_id
       JOIN trials t ON t.experiment_id = a.experiment_id AND ${TRIAL_IN_ARM}
       WHERE t.id = ANY($1::text[])
       UNION
       SELECT a.experiment_id, a.arm, r.id AS trial_id
       FROM experiment_arms a CROSS JOIN LATERAL unnest(a.reused_trial_ids) AS r (id)
       WHERE r.id = ANY($1::text[])
       ORDER BY 3, 1, 2`,
      [trialIds],
    );
    const out = new Map<string, { experimentId: string; arm: string }[]>();
    for (const r of rows) out.set(r.trial_id, [...(out.get(r.trial_id) ?? []), { experimentId: r.experiment_id, arm: r.arm }]);
    return out;
  }

  /** Per set, the raters' majority of each rater's settled label (D46, D73), by (trial, criterion). `final` is not used. */
  private async settledLabels(): Promise<Record<TrustSet, Map<string, SettledLabel>>> {
    const rows = await this.db.query<LabelRow & { label_set: string }>(
      `SELECT trial_id, criterion, value, label_set, rater, second_look, note, labelled_at
       FROM labels WHERE label_set IN ('tuning', 'heldout') ORDER BY labelled_at, id`,
    );
    const of = (set: TrustSet) => humanMajority(raterLabels(rows.filter((r) => r.label_set === set)), POLICY);
    return { heldout: of('heldout'), tuning: of('tuning') };
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
