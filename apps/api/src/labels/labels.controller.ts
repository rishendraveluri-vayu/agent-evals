import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { CreateLabelRequest, LabelLine, LabelQueueItem } from '../contract';
import { LABEL_SETS } from '../contract';
import { badRequest } from '../common/api-error';
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

  /** SP5: judge agreement on held-out labels. `null` until it exists. An unknown `set` is a 400. */
  @Get('judge/agreement')
  agreement(@Query('set') set: unknown, @Res() res: HttpResponse): void {
    if (set !== undefined && !(typeof set === 'string' && (LABEL_SETS as readonly string[]).includes(set))) {
      throw badRequest('invalid_query', `set must be one of ${LABEL_SETS.join(', ')}`);
    }
    res.status(200).json(null);
  }
}
