import { Injectable } from '@nestjs/common';
import type { Json } from '../contract';
import { CONFIG_SELECT, type ConfigRow, configView } from '../configs/configs.service';
import { Db } from '../database/db.service';
import { ExperimentsService } from './experiments.service';

/**
 * Every trial row of an experiment (infra failures, abandoned and cancelled rows included,
 * CLAUDE.md: never dropped silently), joined with its config, task, grades and spend.
 */

const PAGE = 200;

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
  grades: Json[];
}

export const CSV_COLUMNS = [
  'experiment_id',
  'trial_id',
  'repeat_index',
  'attempt',
  'status',
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

  private async *rows(experimentId: string): AsyncGenerator<ExportRow> {
    let after = -1;
    let afterAttempt = 0;
    for (;;) {
      const page = await this.db.query<ExportRow>(
        `SELECT t.id, t.experiment_id, t.repeat_index, t.attempt, t.seq, t.status, t.label, t.end_state, t.worker_id,
                t.claimed_at, t.finished_at, t.cost_usd, t.sim_cost_usd, t.input_tokens, t.output_tokens, t.model_calls,
                t.proxy_complete, t.wall_s, t.folder, t.problems, t.result, t.runner_report, t.config_hash, t.task_sha256,
                k.id AS task_id, k.version AS task_version, k.split AS task_split, k.kind AS task_kind,
                coalesce((SELECT json_agg(json_build_object('grader_id', g.grader_id, 'grader_version', g.grader_version,
                            'kind', g.kind, 'verdict', g.verdict, 'score', g.score, 'evidence', g.evidence,
                            'judge_model', g.judge_model, 'run_index', g.run_index) ORDER BY g.id)
                          FROM grades g WHERE g.trial_id = t.id), '[]'::json) AS grades
         FROM trials t JOIN tasks k ON k.sha256 = t.task_sha256
         WHERE t.experiment_id = $1 AND (t.seq, t.attempt) > ($2, $3)
         ORDER BY t.seq, t.attempt LIMIT ${PAGE}`,
        [experimentId, after, afterAttempt],
      );
      for (const row of page) yield row;
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
    yield `{"exported_at":${JSON.stringify(new Date().toISOString())},"experiment":${JSON.stringify(head)},"trials":[`;
    let first = true;
    for await (const r of this.rows(experimentId)) {
      const c = configs.get(r.config_hash);
      const trial = {
        id: r.id,
        experiment_id: r.experiment_id,
        repeat_index: r.repeat_index,
        attempt: r.attempt,
        status: r.status,
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
        grades: r.grades,
        result: r.result,
        runner_report: r.runner_report,
      };
      yield `${first ? '' : ','}\n${JSON.stringify(trial)}`;
      first = false;
    }
    yield '\n]}\n';
  }

  /** One row per trial attempt, every column in CSV_COLUMNS. */
  async *csv(experimentId: string): AsyncGenerator<string> {
    const experiment = await this.experiments.row(experimentId);
    const configs = await this.configsFor(experiment.config_hashes);
    yield `${CSV_COLUMNS.join(',')}\n`;
    for await (const r of this.rows(experimentId)) {
      const c = configs.get(r.config_hash);
      const grades = Array.isArray(r.grades) ? (r.grades as { verdict?: unknown }[]) : [];
      const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
        experiment_id: r.experiment_id,
        trial_id: r.id,
        repeat_index: r.repeat_index,
        attempt: r.attempt,
        status: r.status,
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
