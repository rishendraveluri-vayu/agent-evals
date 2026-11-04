import { Body, Controller, Get, HttpCode, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';
import type {
  CompareResponse,
  CreateExperimentRequest,
  Estimate,
  EstimateRequest,
  ExperimentDetail,
  ExperimentSummary,
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
  estimate(@Body() body: EstimateRequest): Promise<Estimate> {
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

  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.start(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string): Promise<ExperimentDetail> {
    return this.experiments.cancel(id);
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
