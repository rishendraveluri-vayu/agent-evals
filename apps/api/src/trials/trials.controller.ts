import { Controller, Get, Inject, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import type { FolderTrialDetail, FolderTrialSummary, TrialView } from '../contract';
import { DbTrialsService } from './db-trials.service';
import { TRIAL_STORE } from './trial-store';
import type { SpanView, TrialStore } from './trial-store';

/**
 * One trial: from the database when it was made in an experiment, otherwise from the folder
 * store, which keeps serving runs recorded outside an experiment (gate and smoke runs).
 */
@Controller('trials')
export class TrialsController {
  constructor(
    @Inject(TRIAL_STORE) private readonly store: TrialStore,
    private readonly dbTrials: DbTrialsService,
  ) {}

  /** Folder trials, oldest first, each with `experiment_id: null`. Experiment trials are listed
   *  by GET /experiments/:id/trials. */
  @Get()
  async list(): Promise<FolderTrialSummary[]> {
    const rows = await this.store.list();
    // An experiment attempt's folder on the runs volume looks like a folder trial; leave it out.
    const known = this.dbTrials.enabled ? await this.dbTrials.known(rows.map((r) => r.trialId)) : new Set<string>();
    return rows.filter((r) => !known.has(r.trialId)).map((s) => ({ experiment_id: null, ...s }));
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<TrialView | FolderTrialDetail> {
    if (this.dbTrials.enabled) {
      const stored = await this.dbTrials.get(id);
      if (stored) return stored;
    }
    const detail = await this.store.get(id);
    if (!detail) throw new NotFoundException(`no trial ${id}`);
    return { experiment_id: null, ...detail, summary: { experiment_id: null, ...detail.summary } } as FolderTrialDetail;
  }

  /** Experiment trials: contract v2 spans as reported. Folder trials: plain attributes. */
  @Get(':id/spans')
  async spans(@Param('id') id: string): Promise<unknown[] | SpanView[]> {
    if (this.dbTrials.enabled) {
      const stored = await this.dbTrials.spans(id);
      if (stored) return stored;
    }
    const spans = await this.store.spans(id);
    if (!spans) throw new NotFoundException(`no trial ${id}`);
    return spans;
  }

  /** A stored file, such as a request body a chat span refers to (evals.request_ref). */
  @Get(':id/files/*path')
  async file(@Param('id') id: string, @Param('path') rel: string | string[]): Promise<StreamableFile> {
    const relPath = Array.isArray(rel) ? rel.join('/') : rel;
    let data: Buffer | null | undefined = undefined;
    if (this.dbTrials.enabled) data = await this.dbTrials.file(id, relPath);
    if (data === undefined) data = await this.store.artifact(id, relPath);
    if (!data) throw new NotFoundException(`no file ${relPath} for trial ${id}`);
    const isJson = relPath.endsWith('.json') || relPath.endsWith('.jsonl');
    return new StreamableFile(data, {
      type: isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    });
  }
}
