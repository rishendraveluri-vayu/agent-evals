import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { CreateLabelRequest, LabelLine, LabelQueueItem } from '../contract';
import { LabelsService } from './labels.service';

/** Where the judge and the labels agree is GET /judge/trust (D83, judge/trust.controller.ts). */
@Controller()
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  /**
   * Blind items for a rater to label (D73): no harness, model, arm, timing, cost or grade.
   * D83: `calibrate=1` (with `experiment`) gives only a balanced block, k of the judge's passes and k of its fails, in a random order, still blind.
   */
  @Get('labels/queue')
  queue(
    @Query('set') set: string,
    @Query('experiment') experiment?: string,
    @Query('items') items?: string,
    @Query('rater') rater?: string,
    @Query('calibrate') calibrate?: unknown,
  ): Promise<LabelQueueItem[]> {
    return this.labels.queue(set, experiment, items, rater, calibrate);
  }

  /** Appends a rater's label to labels/<set>.jsonl, with the rater. */
  @Post('labels')
  create(@Body() body: CreateLabelRequest): Promise<LabelLine> {
    return this.labels.create(body);
  }
}
