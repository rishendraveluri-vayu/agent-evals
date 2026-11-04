import { Inject, Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import type { Grade, Json, StoredFile, TaskSplit, TrialStatus, TrialView } from '../contract';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { Db } from '../database/db.service';
import { locate } from './trial-files';

interface Row {
  id: string;
  experiment_id: string;
  repeat_index: number;
  attempt: number;
  status: TrialStatus;
  label: string | null;
  end_state: string | null;
  spec: Json;
  result: Json;
  runner_report: Json;
  cost_usd: number | null;
  sim_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model_calls: number | null;
  proxy_complete: boolean | null;
  wall_s: number | null;
  worker_id: string | null;
  created_at: Date;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  finished_at: Date | null;
  folder: string | null;
  files: StoredFile[] | null;
  problems: string[];
  task_sha256: string;
  task_id: string;
  task_version: string;
  task_split: TaskSplit;
  task_kind: string;
  task_summary: string;
  config_hash: string;
  config_name: string;
  harness: string;
  harness_ref: string;
  model: string;
  prompt_id: string;
  prompt_version: string;
  prompt_sha256: string;
  toolset_id: string;
  toolset_version: string;
  toolset_sha256: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function timingField(report: Json, key: 'started_at' | 'ended_at'): string | null {
  if (typeof report !== 'object' || report === null || Array.isArray(report)) return null;
  const timing = report.timing;
  if (typeof timing !== 'object' || timing === null || Array.isArray(timing)) return null;
  const v = timing[key];
  return typeof v === 'string' ? v : null;
}

/** Trials made in an experiment, from the database (R11a). Folder trials stay in FileTrialStore. */
@Injectable()
export class DbTrialsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
  ) {}

  get enabled(): boolean {
    return this.db.configured;
  }

  /** Which of these ids are experiment trials. */
  async known(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db.query<{ id: string }>('SELECT id FROM trials WHERE id = ANY($1)', [ids]);
    return new Set(rows.map((r) => r.id));
  }

  async get(id: string): Promise<TrialView | null> {
    const [r] = await this.db.query<Row>(
      `SELECT t.*, k.id AS task_id, k.version AS task_version, k.split AS task_split, k.kind AS task_kind, k.summary AS task_summary,
              c.name AS config_name, c.harness, c.harness_ref, c.model, c.prompt_sha256, c.toolset_sha256,
              p.id AS prompt_id, p.version AS prompt_version, s.id AS toolset_id, s.version AS toolset_version
       FROM trials t
       JOIN tasks k ON k.sha256 = t.task_sha256
       JOIN configs c ON c.hash = t.config_hash
       JOIN prompts p ON p.sha256 = c.prompt_sha256
       JOIN toolsets s ON s.sha256 = c.toolset_sha256
       WHERE t.id = $1`,
      [id],
    );
    if (!r) return null;
    const grades = await this.db.query<Omit<Grade, 'created_at'> & { created_at: Date }>(
      `SELECT id::int AS id, grader_id, grader_version, kind, verdict, score, evidence, judge_model, run_index, created_at
       FROM grades WHERE trial_id = $1 ORDER BY id`,
      [id],
    );
    return {
      id: r.id,
      experiment_id: r.experiment_id,
      task: { sha256: r.task_sha256, id: r.task_id, version: r.task_version, split: r.task_split, kind: r.task_kind, summary: r.task_summary },
      config: {
        hash: r.config_hash,
        name: r.config_name,
        harness: r.harness,
        harness_ref: r.harness_ref,
        model: r.model,
        prompt: { id: r.prompt_id, version: r.prompt_version, sha256: r.prompt_sha256 },
        toolset: { id: r.toolset_id, version: r.toolset_version, sha256: r.toolset_sha256 },
      },
      repeat_index: r.repeat_index,
      attempt: r.attempt,
      status: r.status,
      label: r.label,
      end_state: r.end_state,
      spec: r.spec,
      result: r.result,
      runner_report: r.runner_report,
      usage:
        r.runner_report === null
          ? null
          : {
              model_calls: r.model_calls,
              input_tokens: r.input_tokens,
              output_tokens: r.output_tokens,
              cost_usd: r.cost_usd,
              sim_cost_usd: r.sim_cost_usd,
              complete: r.proxy_complete,
            },
      timing: {
        created_at: r.created_at.toISOString(),
        claimed_at: iso(r.claimed_at),
        heartbeat_at: iso(r.heartbeat_at),
        finished_at: iso(r.finished_at),
        started_at: timingField(r.runner_report, 'started_at'),
        ended_at: timingField(r.runner_report, 'ended_at'),
        wall_s: r.wall_s,
      },
      worker_id: r.worker_id,
      files: r.files ?? [],
      grades: grades.map((g) => ({ ...g, created_at: g.created_at.toISOString() })),
      problems: r.problems,
    };
  }

  /** Contract v2 spans as reported, in time order; null for an unknown trial. */
  async spans(id: string): Promise<unknown[] | null> {
    const [exists] = await this.db.query('SELECT 1 FROM trials WHERE id = $1', [id]);
    if (!exists) return null;
    const rows = await this.db.query<{ raw: unknown }>('SELECT raw FROM spans WHERE trial_id = $1 ORDER BY start_ns, span_id', [id]);
    return rows.map((r) => r.raw);
  }

  /** A stored file from the trial's folder on the runs volume; null if unknown or refused. */
  async file(id: string, rel: string): Promise<Buffer | null | undefined> {
    const [t] = await this.db.query<{ folder: string | null }>('SELECT folder FROM trials WHERE id = $1', [id]);
    if (!t) return undefined; // not an experiment trial: let the folder store answer
    if (!t.folder) return null;
    const file = await locate(this.config.runsDir, t.folder, rel);
    return file ? fs.readFile(file) : null;
  }
}
