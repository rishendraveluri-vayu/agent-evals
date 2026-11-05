import { Injectable } from '@nestjs/common';
import type { BundleTable, ExperimentBundle, GradingJobStatus, GradingOutcome, Json, JsonObject, TrialCause, TrialGradingState, TrialStatus } from '../contract';
import { BUNDLE_TABLES } from '../contract';
import { CONFIG_SELECT, type ConfigRow, configView } from '../configs/configs.service';
import { Db } from '../database/db.service';
import { causesFor } from '../causes/trial-facts';
import { JUDGE_MODEL_SQL } from '../grading/grading-core';
import { ExperimentsService, experimentTitle, gradingState, mayHaveCause } from './experiments.service';

/** A trial's outcome as the run grid and the comparison count it (TrialGradingState); null before it is done. */
const outcomeOf = (r: ExportRow): TrialGradingState => gradingState({ ...r, status: r.status as TrialStatus });

/**
 * Every trial row of an experiment (infra failures, abandoned and cancelled rows included,
 * CLAUDE.md: never dropped silently), joined with its config, task, grades and spend. A trial's
 * `outcome` and grades are its current grading's (the latest finished grading job), as the
 * comparison and the run grid count them; older grade versions stay in the database, in the JSON
 * export's `grade_history` and in the bundle.
 */

const PAGE = 200;

/** One grade as the export shows it (grades `g`). A judge grade's model comes from its evidence when the column predates D72. */
const GRADE_JSON = `json_build_object('grader_id', g.grader_id, 'grader_version', g.grader_version, 'kind', g.kind, 'required', g.required,
  'verdict', g.verdict, 'score', g.score, 'evidence', g.evidence, 'judge_model', ${JUDGE_MODEL_SQL('g')}, 'run_index', g.run_index, 'job_id', g.job_id)`;

interface ExportRow {
  id: string;
  experiment_id: string;
  repeat_index: number;
  attempt: number;
  seq: number;
  status: string;
  label: string | null;
  end_state: string | null;
  worker_id: string | null;
  claimed_at: Date | null;
  finished_at: Date | null;
  cost_usd: number | null;
  sim_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_calls: number | null;
  proxy_complete: boolean | null;
  wall_s: number | null;
  folder: string | null;
  problems: string[];
  result: Json;
  runner_report: Json;
  config_hash: string;
  task_sha256: string;
  task_id: string;
  task_version: string;
  task_split: string;
  task_kind: string;
  /** The current grading's grades: those of the latest finished grading job only. */
  grades: Json[];
  /** Every stored grade of the trial, every version (JSON export only). */
  grade_history: Json[];
  /** The latest finished grading job (done or no_graders), as the compare and the run grid read it. */
  graded_status: GradingJobStatus | null;
  graded_outcome: GradingOutcome | null;
  grading_job_id: string | null;
  /** The latest grading job that was not superseded, finished or not. */
  latest_job_status: GradingJobStatus | null;
}

/**
 * The arm a trial ran in, by its config's place in the experiment: A, B. An A/A run (the same
 * config twice) has its second arm's repeats after the first's (lib/arms.ts armIndexOf in the UI).
 */
export function armOf(configHashes: string[], n: number, configHash: string, repeatIndex: number): string {
  const [a, b] = configHashes;
  const i = configHashes.length === 2 && a === b ? (repeatIndex >= n ? 1 : 0) : configHashes.indexOf(configHash);
  return i < 0 ? '' : String.fromCharCode(65 + i);
}

export const CSV_COLUMNS = [
  'experiment_id',
  // The name screens show: a shipped example's title, else the experiment's name (experimentTitle).
  'experiment_title',
  'trial_id',
  'arm',
  'repeat_index',
  'attempt',
  'status',
  'outcome',
  // D64: a failed or not-answered trial's primary failure cause, its reason, and the other causes that matched.
  'cause',
  'cause_reason',
  'causes_contributing',
  'label',
  'end_state',
  'task_sha256',
  'task_id',
  'task_version',
  'task_split',
  'task_kind',
  'config_hash',
  'config_name',
  'harness',
  'harness_ref',
  'adapter_version',
  'model',
  'prompt_id',
  'prompt_version',
  'prompt_sha256',
  'toolset_id',
  'toolset_version',
  'toolset_sha256',
  'cost_usd',
  'sim_cost_usd',
  'input_tokens',
  'output_tokens',
  'model_calls',
  'proxy_complete',
  'wall_s',
  'worker_id',
  'claimed_at',
  'finished_at',
  'grades_passed',
  'grades_total',
  'grades_json',
  'problems',
  'folder',
] as const;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly db: Db,
    private readonly experiments: ExperimentsService,
  ) {}

  /** Each page's trials with their failure cause (D64), read for the rows that can have one. */
  private async *rows(experimentId: string): AsyncGenerator<ExportRow & { cause: TrialCause | null }> {
    for await (const page of this.pages(experimentId)) {
      const causes = await causesFor(this.db, page.filter((r) => mayHaveCause({ ...r, status: r.status as TrialStatus })).map((r) => r.id));
      for (const r of page) yield { ...r, cause: causes.get(r.id) ?? null };
    }
  }

  private async *pages(experimentId: string): AsyncGenerator<ExportRow[]> {
    let after = -1;
    let afterAttempt = 0;
    for (;;) {
      const page = await this.db.query<ExportRow>(
        `SELECT t.id, t.experiment_id, t.repeat_index, t.attempt, t.seq, t.status, t.label, t.end_state, t.worker_id,
                t.claimed_at, t.finished_at, t.cost_usd, t.sim_cost_usd, t.input_tokens, t.output_tokens, t.model_calls,
                t.proxy_complete, t.wall_s, t.folder, t.problems, t.result, t.runner_report, t.config_hash, t.task_sha256,
                k.id AS task_id, k.version AS task_version, k.split AS task_split, k.kind AS task_kind,
                gd.id AS grading_job_id, gd.status AS graded_status, gd.outcome AS graded_outcome, gl.status AS latest_job_status,
                coalesce((SELECT json_agg(${GRADE_JSON} ORDER BY g.id)
                          FROM grades g WHERE g.trial_id = t.id AND g.id = ANY (gd.grade_ids)), '[]'::json) AS grades,
                coalesce((SELECT json_agg(${GRADE_JSON} ORDER BY g.id)
                          FROM grades g WHERE g.trial_id = t.id), '[]'::json) AS grade_history
         FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256
         -- The current grading: the latest finished job, as TRIAL_SUMMARY_SELECT and the compare read it.
         LEFT JOIN LATERAL (
           SELECT j.id, j.status, j.outcome, j.grade_ids FROM grading_jobs j
           WHERE j.trial_id = t.id AND j.status IN ('done', 'no_graders') ORDER BY j.created_at DESC, j.id DESC LIMIT 1
         ) gd ON true
         LEFT JOIN LATERAL (
           SELECT j.status FROM grading_jobs j WHERE j.trial_id = t.id AND j.status <> 'superseded' ORDER BY j.created_at DESC, j.id DESC LIMIT 1
         ) gl ON true
         WHERE t.experiment_id = $1 AND (t.seq, t.attempt) > ($2, $3)
         ORDER BY t.seq, t.attempt LIMIT ${PAGE}`,
        [experimentId, after, afterAttempt],
      );
      if (page.length) yield page;
      if (page.length < PAGE) return;
      const last = page[page.length - 1];
      after = last.seq;
      afterAttempt = last.attempt;
    }
  }

  private async configsFor(hashes: string[]): Promise<Map<string, ConfigRow>> {
    const rows = await this.db.query<ConfigRow>(`${CONFIG_SELECT} WHERE c.hash = ANY($1)`, [hashes]);
    return new Map(rows.map((r) => [r.hash, r]));
  }

  /** `{"experiment": {...}, "configs": [...], "trials": [...]}`, written one trial at a time. */
  async *json(experimentId: string): AsyncGenerator<string> {
    const experiment = await this.experiments.get(experimentId);
    const configs = await this.configsFor(experiment.config_hashes);
    const head: Partial<typeof experiment> = { ...experiment };
    delete head.events;
    // The title beside the experiment: a shipped example's stored name is the working name it was run under.
    const title = experiment.example?.title ?? experiment.name;
    yield `{"exported_at":${JSON.stringify(new Date().toISOString())},"experiment_title":${JSON.stringify(title)},"experiment":${JSON.stringify(head)},"trials":[`;
    let first = true;
    for await (const r of this.rows(experimentId)) {
      const c = configs.get(r.config_hash);
      const trial = {
        id: r.id,
        experiment_id: r.experiment_id,
        arm: armOf(experiment.config_hashes, experiment.n, r.config_hash, r.repeat_index),
        repeat_index: r.repeat_index,
        attempt: r.attempt,
        status: r.status,
        outcome: outcomeOf(r),
        cause: r.cause,
        label: r.label,
        end_state: r.end_state,
        task: { sha256: r.task_sha256, id: r.task_id, version: r.task_version, split: r.task_split, kind: r.task_kind },
        config: c ? configView(c) : { hash: r.config_hash },
        spend: {
          cost_usd: r.cost_usd,
          sim_cost_usd: r.sim_cost_usd,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          model_calls: r.model_calls,
          proxy_complete: r.proxy_complete,
        },
        timing: { claimed_at: r.claimed_at, finished_at: r.finished_at, wall_s: r.wall_s },
        worker_id: r.worker_id,
        folder: r.folder,
        problems: r.problems,
        grading_job_id: r.grading_job_id,
        grades: r.grades,
        grade_history: r.grade_history,
        result: r.result,
        runner_report: r.runner_report,
      };
      yield `${first ? '' : ','}\n${JSON.stringify(trial)}`;
      first = false;
    }
    yield '\n]}\n';
  }

  /**
   * GET /experiments/:id/bundle: every row needed to recreate the experiment in another database
   * (scripts/export_example.py, SP7), read in one read-only snapshot. Rows are `to_jsonb` of the
   * table's own row, which jsonb_populate_recordset reads back, except where the contract says
   * (ExperimentBundle). Never includes a trial's LiteLLM key tokens or the experiment's LiteLLM team.
   */
  async bundle(experimentId: string): Promise<ExperimentBundle> {
    await this.experiments.row(experimentId); // 404 for an unknown experiment
    return this.db.tx(async (client) => {
      // One snapshot, so the rows agree with each other; and nothing here can write.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const rows = async (sql: string, params: unknown[] = [experimentId]): Promise<JsonObject[]> =>
        (await client.query<{ row: JsonObject }>(sql, params)).rows.map((r) => r.row);
      const ofTrials = 'JOIN trials t ON t.id = x.trial_id WHERE t.experiment_id = $1';
      const tables: Partial<Record<BundleTable, JsonObject[]>> = {
        // The LiteLLM team is a handle into this machine's LiteLLM, of no use anywhere else.
        experiments: await rows(`SELECT to_jsonb(x) - 'litellm_team_id' AS row FROM experiments x WHERE x.id = $1`),
        experiment_arms: await rows('SELECT to_jsonb(x) AS row FROM experiment_arms x WHERE x.experiment_id = $1 ORDER BY x.position'),
        // A new id is given on import; the order is kept.
        experiment_events: await rows(`SELECT to_jsonb(x) - 'id' AS row FROM experiment_events x WHERE x.experiment_id = $1 ORDER BY x.at, x.id`),
        // A trial's key tokens are LiteLLM's handles to its (revoked) keys: secrets, never exported.
        trials: await rows(`SELECT to_jsonb(x) - 'agent_key_token' - 'sim_key_token' AS row FROM trials x WHERE x.experiment_id = $1 ORDER BY x.seq, x.attempt, x.id`),
        // The other span columns are read from raw (worker/report.ts spanRows) when it is loaded.
        spans: await rows(`SELECT jsonb_build_object('trial_id', x.trial_id, 'raw', x.raw) AS row FROM spans x ${ofTrials} ORDER BY x.trial_id, x.start_ns, x.span_id`),
        grading_jobs: await rows(`SELECT to_jsonb(x) AS row FROM grading_jobs x ${ofTrials} ORDER BY x.created_at, x.id`),
        grades: await rows(`SELECT to_jsonb(x) AS row FROM grades x ${ofTrials} ORDER BY x.id`),
        // The experiment's configs (and its trials', the same ones), with the configs they were forked from.
        configs: await rows(
          `WITH RECURSIVE wanted (hash) AS (
             SELECT unnest(config_hashes) FROM experiments WHERE id = $1
             UNION SELECT config_hash FROM trials WHERE experiment_id = $1
             UNION SELECT c.parent_hash FROM configs c JOIN wanted w ON w.hash = c.hash WHERE c.parent_hash IS NOT NULL)
           SELECT to_jsonb(x) AS row FROM configs x WHERE x.hash IN (SELECT hash FROM wanted) ORDER BY x.created_at, x.hash`,
        ),
      };
      const configs = tables.configs ?? [];
      const exp = (tables.experiments ?? [])[0] ?? {};
      tables.prompts = await rows('SELECT to_jsonb(x) AS row FROM prompts x WHERE x.sha256 = ANY($1) ORDER BY x.sha256', [
        [...configs.map((c) => c.prompt_sha256), exp.sim_prompt_sha256].filter((v) => typeof v === 'string'),
      ]);
      tables.toolsets = await rows('SELECT to_jsonb(x) AS row FROM toolsets x WHERE x.sha256 = ANY($1) ORDER BY x.sha256', [configs.map((c) => c.toolset_sha256)]);
      tables.tasks = await rows(
        `SELECT to_jsonb(x) AS row FROM tasks x
         WHERE x.sha256 IN (SELECT unnest(task_sha256s) FROM experiments WHERE id = $1 UNION SELECT task_sha256 FROM trials WHERE experiment_id = $1)
         ORDER BY x.id, x.sha256`,
      );
      const [schema] = (await client.query<{ version: string | null }>('SELECT max(version) AS version FROM schema_migrations')).rows;
      return {
        format: 'agent-evals-bundle',
        format_version: 1,
        schema_version: schema?.version ?? '',
        exported_at: new Date().toISOString(),
        experiment_id: experimentId,
        tables: Object.fromEntries(BUNDLE_TABLES.map((t) => [t, tables[t] ?? []])) as Record<BundleTable, JsonObject[]>,
      };
    });
  }

  /** One row per trial attempt, every column in CSV_COLUMNS. */
  async *csv(experimentId: string): AsyncGenerator<string> {
    const experiment = await this.experiments.row(experimentId);
    const configs = await this.configsFor(experiment.config_hashes);
    const title = experimentTitle(experiment);
    yield `${CSV_COLUMNS.join(',')}\n`;
    for await (const r of this.rows(experimentId)) {
      const c = configs.get(r.config_hash);
      const grades = Array.isArray(r.grades) ? (r.grades as { verdict?: unknown }[]) : [];
      const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
        experiment_id: r.experiment_id,
        experiment_title: title,
        trial_id: r.id,
        arm: armOf(experiment.config_hashes, experiment.n, r.config_hash, r.repeat_index),
        repeat_index: r.repeat_index,
        attempt: r.attempt,
        status: r.status,
        outcome: outcomeOf(r),
        cause: r.cause?.cause,
        cause_reason: r.cause?.reason,
        causes_contributing: r.cause?.contributing.length ? r.cause.contributing.map((c) => c.cause).join(';') : null,
        label: r.label,
        end_state: r.end_state,
        task_sha256: r.task_sha256,
        task_id: r.task_id,
        task_version: r.task_version,
        task_split: r.task_split,
        task_kind: r.task_kind,
        config_hash: r.config_hash,
        config_name: c?.name,
        harness: c?.harness,
        harness_ref: c?.harness_ref,
        adapter_version: c?.adapter_version,
        model: c?.model,
        prompt_id: c?.prompt_id,
        prompt_version: c?.prompt_version,
        prompt_sha256: c?.prompt_sha256,
        toolset_id: c?.toolset_id,
        toolset_version: c?.toolset_version,
        toolset_sha256: c?.toolset_sha256,
        cost_usd: r.cost_usd,
        sim_cost_usd: r.sim_cost_usd,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        model_calls: r.model_calls,
        proxy_complete: r.proxy_complete,
        wall_s: r.wall_s,
        worker_id: r.worker_id,
        claimed_at: r.claimed_at,
        finished_at: r.finished_at,
        grades_passed: grades.filter((g) => g.verdict === 'pass').length,
        grades_total: grades.length,
        grades_json: grades.length ? grades : null,
        problems: r.problems.length ? r.problems.join('; ') : null,
        folder: r.folder,
      };
      yield `${CSV_COLUMNS.map((k) => csvCell(values[k])).join(',')}\n`;
    }
  }
}
