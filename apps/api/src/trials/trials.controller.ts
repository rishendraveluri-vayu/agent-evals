import { Controller, Get, Inject, NotFoundException, Param, StreamableFile } from '@nestjs/common';
import { TRIAL_STORE } from './trial-store';
import type { SpanView, TrialDetail, TrialStore, TrialSummary } from './trial-store';

@Controller('trials')
export class TrialsController {
  constructor(@Inject(TRIAL_STORE) private readonly store: TrialStore) {}

  /** Every trial, oldest first, with the numbers the spend chart and the table need. */
  @Get()
  list(): Promise<TrialSummary[]> {
    return this.store.list();
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<TrialDetail> {
    const detail = await this.store.get(id);
    if (!detail) throw new NotFoundException(`no trial ${id}`);
    return detail;
  }

  /** The trial's spans with attributes as plain objects, oldest first. */
  @Get(':id/spans')
  async spans(@Param('id') id: string): Promise<SpanView[]> {
    const spans = await this.store.spans(id);
    if (!spans) throw new NotFoundException(`no trial ${id}`);
    return spans;
  }

  /** A stored file, such as a request body a chat span refers to (evals.request_ref). */
  @Get(':id/files/*path')
  async file(@Param('id') id: string, @Param('path') rel: string | string[]): Promise<StreamableFile> {
    const relPath = Array.isArray(rel) ? rel.join('/') : rel;
    const data = await this.store.artifact(id, relPath);
    if (!data) throw new NotFoundException(`no file ${relPath} for trial ${id}`);
    const isJson = relPath.endsWith('.json') || relPath.endsWith('.jsonl');
    return new StreamableFile(data, {
      type: isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    });
  }
}
