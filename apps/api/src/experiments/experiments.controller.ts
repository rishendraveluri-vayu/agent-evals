import { Body, Controller, Get, HttpCode, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import type {
  CompareResponse,
  CreateExperimentRequest,
  EstimateResponse,
  ExperimentBundle,
  EstimateRequest,
  ExperimentDetail,
  ExperimentSummary,
  StartExperimentRequest,
  TrialRowSummary,
} from '../contract';
import { badRequest } from '../common/api-error';
import { ExperimentsService } from './experiments.service';
import { ExportService } from './export.service';

@Controller('experiments')
export class ExperimentsController {
  constructor(
    private readonly experiments: ExperimentsService,
    private readonly exporter: ExportService,
  ) {}

  /** Trials, cost and time for a planned run, before anything is created (R10.6). */
  @Post('estimate')
  @HttpCode(200)
  estimate(@Body() body: EstimateRequest): Promise<EstimateResponse> {
    return this.experiments.estimate(body);
  }

  /** Creates the experiment and its queued trial rows. Nothing runs until it is started. */
  @Post()
  create(@Body() body: CreateExperimentRequest): Promise<ExperimentDetail> {
    return this.experiments.create(body);
  }

  @Get()
  list(): Promise<ExperimentSummary[]> {
    return this.experiments.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.get(id);
  }

  /** Starts (or resumes) it. An unstarted one may be given its plan commit in the body. */
  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id') id: string, @Body() body?: StartExperimentRequest): Promise<ExperimentDetail> {
    return this.experiments.start(id, body);
  }

  /** Marks an experiment that never started as cancelled; nothing is deleted. 409 once it has started. */
  @Post(':id/discard')
  @HttpCode(200)
  discard(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.discard(id);
  }

  /** D32: no new claims; running trials finish. */
  @Post(':id/pause')
  @HttpCode(200)
  pause(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.pause(id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.resume(id);
  }

  /** D32: queued trials are cancelled; running ones finish. `cancel` is the older name. */
  @Post(':id/stop')
  @HttpCode(200)
  stop(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.cancel(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.cancel(id);
  }

  /** D37: one arm stops claiming; the other keeps running. `:config` is the arm's config hash, or A or B. */
  @Post(':id/arms/:config/pause')
  @HttpCode(200)
  pauseArm(@Param('id') id: string, @Param('config') config: string): Promise<ExperimentDetail> {
    return this.experiments.pauseArm(id, config);
  }

  @Post(':id/arms/:config/resume')
  @HttpCode(200)
  resumeArm(@Param('id') id: string, @Param('config') config: string): Promise<ExperimentDetail> {
    return this.experiments.resumeArm(id, config);
  }

  @Get(':id/trials')
  trials(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('config') config?: string,
    @Query('task') task?: string,
  ): Promise<TrialRowSummary[]> {
    return this.experiments.trials(id, { status, config, task });
  }

  @Get(':id/compare')
  compare(@Param('id') id: string): Promise<CompareResponse> {
    return this.experiments.compare(id);
  }

  /** SP7: every row needed to recreate the experiment elsewhere (scripts/export_example.py). Read-only. */
  @Get(':id/bundle')
  bundle(@Param('id') id: string): Promise<ExperimentBundle> {
    return this.exporter.bundle(id);
  }

  @Get(':id/export')
  async export(@Param('id') id: string, @Query('format') format = 'json'): Promise<StreamableFile> {
    if (format !== 'json' && format !== 'csv') throw badRequest('invalid_format', 'format must be json or csv');
    await this.experiments.row(id); // 404 before the stream starts
    const chunks = format === 'json' ? this.exporter.json(id) : this.exporter.csv(id);
    return new StreamableFile(Readable.from(chunks), {
      type: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${id}.${format}"`,
    });
  }
}
