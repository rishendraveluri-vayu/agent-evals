import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { CreateLabelRequest, LabelLine, LabelQueueItem } from '../contract';
import type { HttpResponse } from '../common/http';
import { LabelsService } from './labels.service';

@Controller()
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  /** Blind items for Rishi to label: no harness, model, arm, timing, cost or grade. */
  @Get('labels/queue')
  queue(@Query('set') set: string, @Query('experiment') experiment?: string): Promise<LabelQueueItem[]> {
    return this.labels.queue(set, experiment);
  }

  /** Appends Rishi's label to labels/<set>.jsonl. */
  @Post('labels')
  create(@Body() body: CreateLabelRequest): Promise<LabelLine> {
    return this.labels.create(body);
  }

  /** SP5: judge agreement on held-out labels. `null` until it exists. */
  @Get('judge/agreement')
  agreement(@Res() res: HttpResponse): void {
    res.status(200).json(null);
  }
}
