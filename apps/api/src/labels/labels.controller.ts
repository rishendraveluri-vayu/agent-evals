import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { CreateLabelRequest, LabelLine, LabelQueueItem } from '../contract';
import type { HttpResponse } from '../common/http';
import { LabelsService } from './labels.service';

@Controller()
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  /** Blind items for a rater to label (D73): no harness, model, arm, timing, cost or grade. */
  @Get('labels/queue')
  queue(@Query('set') set: string, @Query('experiment') experiment?: string, @Query('items') items?: string, @Query('rater') rater?: string): Promise<LabelQueueItem[]> {
    return this.labels.queue(set, experiment, items, rater);
  }

  /** Appends a rater's label to labels/<set>.jsonl, with the rater. */
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
