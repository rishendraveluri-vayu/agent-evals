import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import type { BundleTable, ExampleView, JsonObject, LoadExampleResponse } from '../contract';
import { BUNDLE_TABLES } from '../contract';
import { ApiError, badRequest, conflict } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';
import { Db } from '../database/db.service';
import { hashFile, safeRelPath, storeUpload } from '../trials/trial-files';
import { spanRows } from '../worker/report';
import { EXAMPLE_NAME, type ExampleFile, type ExampleManifest, exampleInvalid, readFiles, readManifest, readTables } from './example-files';

/** Held while loading, so two loads of one example never race. Any fixed number. */
const LOAD_LOCK = 74_201_408;

/** Trial and grading states an example may be shipped in: finished ones, so nothing is left to claim. */
const FINAL_TRIAL = ['done', 'infra_failed', 'abandoned', 'cancelled'];
const FINAL_JOB = ['done', 'failed', 'superseded', 'no_graders'];
/** A trial's adapter code hash as the table stores it (migration 018, D85). */
const ADAPTER_SHA = /^sha256:[0-9a-f]{64}$/;

/**
 * Content-addressed rows the example shares with this database's own: the key is a hash of the
 * content, so an existing row with the key is the same content. These columns are compared anyway,
 * and a difference is a 409 rather than a silent mix. Names, paths and lineage are not content.
 */
const SHARED: Partial<Record<BundleTable, { key: string; columns: string[] }>> = {
  prompts: { key: 'sha256', columns: ['id', 'version', 'text'] },
  toolsets: { key: 'sha256', columns: ['id', 'version', 'servers'] },
  tasks: { key: 'sha256', columns: ['id', 'version', 'split', 'kind', 'summary', 'body', 'client_state_sha256'] },
  configs: {
    key: 'hash',
    columns: ['harness', 'harness_ref', 'adapter_version', 'capabilities_sha256', 'model', 'api_format', 'prompt_sha256', 'toolset_sha256', 'settings', 'harness_options', 'seed'],
  },
};

const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A row value as text, for keys and messages (rows are JSON). */
const txt = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? `${v}` : (JSON.stringify(v) ?? 'null'));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

interface Checked {
  tables: Record<BundleTable, JsonObject[]>;
  files: { file: ExampleFile; data: Buffer; folder: string }[];
}

/**
 * Checks that the bundle is one finished experiment whose rows refer only to each other (and
 * agree with the manifest's counts), so it can be loaded as it is, read-only. Throws 422.
 */
export function checkBundle(m: ExampleManifest, tables: Record<BundleTable, JsonObject[]>, files: { file: ExampleFile; data: Buffer }[]): Checked {
  const bad = (why: string): ApiError => exampleInvalid(m.name, why);
  const [exp, ...more] = tables.experiments;
  if (!exp || more.length || exp.id !== m.experiment_id) throw bad(`it must hold exactly one experiment, ${m.experiment_id}`);
  if (exp.status !== 'done' && exp.status !== 'cancelled') throw bad(`experiment ${m.experiment_id} is ${txt(exp.status)}; only a finished one is shipped`);
  const id = m.experiment_id;
  for (const a of tables.experiment_arms) {
    if (a.experiment_id !== id) throw bad(`an arm belongs to ${txt(a.experiment_id)}`);
    if (strings(a.reused_trial_ids).length) throw bad(`arm ${txt(a.arm)} reuses its parent's trials, which are not in the example`);
  }
  for (const e of tables.experiment_events) if (e.experiment_id !== id) throw bad(`an event belongs to ${txt(e.experiment_id)}`);
  const trials = new Map(tables.trials.map((t) => [str(t.id) ?? '', t]));
  for (const t of tables.trials) {
    if (t.experiment_id !== id || t.probe === true) throw bad(`trial ${txt(t.id)} is not a trial of ${id}`);
    if (!FINAL_TRIAL.includes(txt(t.status))) throw bad(`trial ${txt(t.id)} is ${txt(t.status)}; every trial must have finished`);
    // D85: a trial exported before the column has none (every example shipped so far), which loads as null.
    if (t.adapter_sha256 !== undefined && t.adapter_sha256 !== null && !(typeof t.adapter_sha256 === 'string' && ADAPTER_SHA.test(t.adapter_sha256))) {
      throw bad(`trial ${txt(t.id)}'s adapter_sha256 is not sha256:<64 hex digits>`);
    }
  }
  for (const s of tables.spans) {
    if (!trials.has(str(s.trial_id) ?? '') || typeof s.raw !== 'object' || s.raw === null) throw bad('a span names no trial of the example, or has no raw span');
    if (Object.keys(s).some((k) => k !== 'trial_id' && k !== 'raw')) throw bad('span rows must be {trial_id, raw}');
  }
  const jobs = new Set(tables.grading_jobs.map((j) => str(j.id)));
  for (const j of tables.grading_jobs) {
    if (!trials.has(str(j.trial_id) ?? '')) throw bad(`grading job ${txt(j.id)} names no trial of the example`);
    if (!FINAL_JOB.includes(txt(j.status))) throw bad(`grading job ${txt(j.id)} is ${txt(j.status)}; grading must have finished`);
  }
  const gradeIds = new Set(tables.grades.map((g) => txt(g.id)));
  for (const g of tables.grades) {
    if (!trials.has(str(g.trial_id) ?? '')) throw bad(`a grade names no trial of the example`);
    if (g.job_id !== null && g.job_id !== undefined && !jobs.has(str(g.job_id))) throw bad(`a grade names grading job ${txt(g.job_id)}, which is not in the example`);
  }
  for (const j of tables.grading_jobs) {
    const ids = Array.isArray(j.grade_ids) ? j.grade_ids.map(String) : [];
    if (ids.some((g) => !gradeIds.has(g))) throw bad(`grading job ${txt(j.id)} names grades that are not in the example`);
  }
  const has = (table: BundleTable, key: string): Set<string> => new Set(tables[table].map((r) => str(r[key]) ?? ''));
  const configs = has('configs', 'hash');
  const prompts = has('prompts', 'sha256');
  const toolsets = has('toolsets', 'sha256');
  const tasks = has('tasks', 'sha256');
  for (const h of [...strings(exp.config_hashes), ...tables.trials.map((t) => txt(t.config_hash)), ...tables.experiment_arms.map((a) => txt(a.config_hash))]) {
    if (!configs.has(h)) throw bad(`config ${h} is not in the example`);
  }
  for (const c of tables.configs) {
    if (c.parent_hash !== null && c.parent_hash !== undefined && !configs.has(txt(c.parent_hash))) throw bad(`config ${txt(c.hash)} was forked from ${txt(c.parent_hash)}, which is not in the example`);
    if (!prompts.has(txt(c.prompt_sha256)) || !toolsets.has(txt(c.toolset_sha256))) throw bad(`config ${txt(c.hash)}'s prompt or toolset is not in the example`);
  }
  if (exp.sim_prompt_sha256 !== null && exp.sim_prompt_sha256 !== undefined && !prompts.has(txt(exp.sim_prompt_sha256))) throw bad('the simulator prompt is not in the example');
  for (const s of [...strings(exp.task_sha256s), ...tables.trials.map((t) => txt(t.task_sha256))]) {
    if (!tasks.has(s)) throw bad(`task ${s} is not in the example`);
  }
  const out: Checked['files'] = [];
  for (const { file, data } of files) {
    const t = trials.get(file.trial_id);
    const folder = str(t?.folder);
    if (!t || !folder || !safeRelPath(folder) || !safeRelPath(file.path)) throw bad(`file ${file.trial_id}/${file.path} has no trial folder to go in`);
    const listed = (Array.isArray(t.files) ? t.files : []).find((f) => typeof f === 'object' && f !== null && !Array.isArray(f) && f.path === file.path) as JsonObject | undefined;
    if (listed && listed.sha256 !== file.sha256) throw bad(`file ${file.trial_id}/${file.path} is ${file.sha256}, but the trial lists ${txt(listed.sha256)}`);
    out.push({ file, data, folder });
  }
  const counts: [keyof ExampleManifest['counts'], number][] = [
    ['configs', tables.configs.length],
    ['tasks', tables.tasks.length],
    ['trials', tables.trials.length],
    ['spans', tables.spans.length],
    ['grades', tables.grades.length],
    ['files', files.length],
  ];
  for (const [k, n] of counts) if (m.counts[k] !== n) throw bad(`the manifest counts ${m.counts[k]} ${k}, the bundle holds ${n}`);
  return { tables, files: out };
}

/**
 * Shipped examples (SP7): finished experiments under examples/<name>/, loaded on request. A load
 * only inserts: it never overwrites or deletes a row or a stored file, a second load is a no-op,
 * and anything already there with other content is a 409. The loaded experiment is marked with
 * the example's name and stays read-only (examples/example-guard.ts).
 */
@Injectable()
export class ExamplesService {
  private readonly logger = new Logger(ExamplesService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: Db,
  ) {}

  /** GET /examples: every example folder with a readable manifest. A broken one is logged and left out. */
  async list(): Promise<ExampleView[]> {
    let names: string[];
    try {
      const entries = await fs.readdir(this.config.examplesDir, { withFileTypes: true });
      names = entries.filter((d) => d.isDirectory() && EXAMPLE_NAME.test(d.name)).map((d) => d.name).sort();
    } catch {
      return [];
    }
    const manifests: ExampleManifest[] = [];
    for (const name of names) {
      try {
        manifests.push(await readManifest(this.config.examplesDir, name));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'unknown_example') continue; // a folder without a manifest
        this.logger.warn(err instanceof Error ? err.message : txt(err));
      }
    }
    const rows = this.db.configured && manifests.length
      ? await this.db.query<{ id: string; example_name: string | null }>('SELECT id, example_name FROM experiments WHERE id = ANY($1)', [manifests.map((m) => m.experiment_id)])
      : [];
    return manifests.map((m) => ({
      name: m.name,
      title: m.title,
      description: m.description,
      experiment_id: m.experiment_id,
      loaded: rows.some((r) => r.id === m.experiment_id && r.example_name === m.name),
      created_at: m.created_at,
      counts: m.counts,
    }));
  }

  /** POST /examples/:name/load */
  async load(name: string): Promise<LoadExampleResponse> {
    if (!EXAMPLE_NAME.test(name)) {
      throw badRequest('invalid_example_name', `${JSON.stringify(name)} is not an example name`, 'Use a name from GET /api/examples: lower-case letters, digits and hyphens.');
    }
    const m = await readManifest(this.config.examplesDir, name);
    const checked = checkBundle(m, await readTables(this.config.examplesDir, m), await readFiles(this.config.examplesDir, m));
    const done = { name, experiment_id: m.experiment_id };
    return this.db.tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOAD_LOCK]);
      const { rows: [existing] } = await client.query<{ example_name: string | null }>('SELECT example_name FROM experiments WHERE id = $1', [m.experiment_id]);
      if (existing?.example_name === name) return { ...done, created: false };
      if (existing) {
        throw conflict(
          'example_conflict',
          existing.example_name === null
            ? `experiment ${m.experiment_id} is already in this database as an experiment of its own (perhaps the one the example was exported from), so the example is not loaded over it`
            : `experiment ${m.experiment_id} is already loaded as the example ${existing.example_name}`,
          'Nothing was changed. Open the experiment that is there, or load the example into another database.',
        );
      }
      await this.checkColumns(client, m, checked.tables);
      await this.checkClashes(client, m, checked);
      await this.insert(client, m, checked.tables);
      // Files after the rows are in place but before the commit: a stored file is never
      // replaced, so a leftover from an earlier load (the same bytes) is simply kept.
      for (const f of checked.files) {
        await storeUpload(this.config.runsDir, f.folder, f.file.path, Readable.from([f.data]), f.file.sha256, { allowNew: true });
      }
      return { ...done, created: true };
    });
  }

  /** Every column the bundle names must exist here; an example from a newer schema is refused, not cut down. */
  private async checkColumns(client: PoolClient, m: ExampleManifest, tables: Record<BundleTable, JsonObject[]>): Promise<void> {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)',
      [[...BUNDLE_TABLES]],
    );
    for (const t of BUNDLE_TABLES) {
      if (t === 'spans') continue; // {trial_id, raw}, checked in checkBundle
      const known = new Set(rows.filter((r) => r.table_name === t).map((r) => r.column_name));
      const extra = [...new Set(tables[t].flatMap((r) => Object.keys(r)))].filter((c) => !known.has(c));
      if (extra.length) throw exampleInvalid(m.name, `${t} rows have columns this database does not: ${extra.join(', ')} (exported by a newer platform?)`);
    }
  }

  /** 409 when a row or stored file of the example is already here with other content. Nothing is written. */
  private async checkClashes(client: PoolClient, m: ExampleManifest, checked: Checked): Promise<void> {
    const clash = (what: string): ApiError =>
      conflict('example_conflict', `example ${m.name} cannot be loaded: ${what}`, 'Nothing was changed. The example only adds rows; it never replaces what is in this database.');
    const { tables } = checked;
    const taken = async (table: 'trials' | 'grading_jobs'): Promise<string[]> =>
      (await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1)`, [tables[table].map((r) => r.id)])).rows.map((r) => r.id);
    const trials = await taken('trials');
    if (trials.length) throw clash(`trial ${trials[0]} is already in this database${trials.length > 1 ? ` (and ${trials.length - 1} more)` : ''}`);
    const jobs = await taken('grading_jobs');
    if (jobs.length) throw clash(`grading job ${jobs[0]} is already in this database`);
    for (const [table, spec] of Object.entries(SHARED) as [BundleTable, { key: string; columns: string[] }][]) {
      const rows = tables[table];
      if (!rows.length) continue;
      const present = new Set(rows.flatMap((r) => Object.keys(r)));
      const cols = spec.columns.filter((c) => present.has(c));
      const { rows: differ } = await client.query<{ key: string }>(
        `SELECT b.${quote(spec.key)} AS key FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) b
         JOIN ${table} x ON x.${quote(spec.key)} = b.${quote(spec.key)}
         WHERE (${cols.map((c) => `x.${quote(c)}`).join(', ')}) IS DISTINCT FROM (${cols.map((c) => `b.${quote(c)}`).join(', ')})`,
        [JSON.stringify(rows)],
      );
      if (differ.length) throw clash(`${table} ${differ[0].key} is already in this database with other content`);
    }
    for (const f of checked.files) {
      const dest = path.resolve(this.config.runsDir, f.folder, f.file.path);
      try {
        const st = await fs.lstat(dest);
        if (!st.isFile() || (await hashFile(dest)).sha256 !== f.file.sha256) throw clash(`runs/${f.folder}/${f.file.path} is already stored with other content`);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') throw clash(`a stored file is in the way of runs/${f.folder}/${f.file.path}`);
        // ENOENT: not there yet, as expected
      }
    }
  }

  /** Inserts every row, in BUNDLE_TABLES order. Shared rows already here are kept as they are. */
  private async insert(client: PoolClient, m: ExampleManifest, tables: Record<BundleTable, JsonObject[]>): Promise<void> {
    const put = async (table: BundleTable, rows: JsonObject[], onConflict: string | null = null): Promise<void> => {
      if (!rows.length) return;
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(quote).join(', ');
      await client.query(
        `INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)${onConflict ? ` ON CONFLICT (${onConflict}) DO NOTHING` : ''}`,
        [JSON.stringify(rows)],
      );
    };
    await put('prompts', tables.prompts, 'sha256');
    await put('toolsets', tables.toolsets, 'sha256');
    await put('tasks', tables.tasks, 'sha256');
    await put('configs', tables.configs, 'hash');
    await put(
      'experiments',
      tables.experiments.map((e) => ({ ...e, example_name: m.name, example_title: m.title, example_loaded_at: new Date().toISOString() })),
    );
    await put('experiment_arms', tables.experiment_arms);
    // Events and grades get this database's own ids; a grading job's grade_ids follow its grades.
    await put('experiment_events', tables.experiment_events.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'id'))));
    await put('trials', tables.trials);
    const byTrial = new Map<string, JsonObject[]>();
    for (const s of tables.spans) byTrial.set(txt(s.trial_id), [...(byTrial.get(txt(s.trial_id)) ?? []), s.raw as JsonObject]);
    for (const [trialId, raws] of byTrial) {
      const { rows } = spanRows(raws);
      if (rows.length !== raws.length) throw exampleInvalid(m.name, `${raws.length - rows.length} spans of trial ${trialId} cannot be read`);
      await client.query(
        `INSERT INTO spans (trial_id, span_id, parent_span_id, name, kind, start_ns, end_ns, status_code, attributes, raw)
         SELECT $1, s.span_id, s.parent_span_id, s.name, s.kind, s.start_ns, s.end_ns, s.status_code, s.attributes, s.raw
         FROM jsonb_to_recordset($2::jsonb) AS s(span_id text, parent_span_id text, name text, kind smallint,
              start_ns numeric, end_ns numeric, status_code smallint, attributes jsonb, raw jsonb)`,
        [trialId, JSON.stringify(rows)],
      );
    }
    const { rows: ids } = await client.query<{ id: string }>(`SELECT nextval(pg_get_serial_sequence('grades', 'id'))::text AS id FROM generate_series(1, $1)`, [tables.grades.length]);
    const newId = new Map(tables.grades.map((g, i) => [txt(g.id), ids[i].id]));
    await put(
      'grading_jobs',
      tables.grading_jobs.map((j) => ({ ...j, grade_ids: (Array.isArray(j.grade_ids) ? j.grade_ids : []).map((g) => newId.get(txt(g)) as string) })),
    );
    await put('grades', tables.grades.map((g) => ({ ...g, id: newId.get(txt(g.id)) as string })));
  }
}
