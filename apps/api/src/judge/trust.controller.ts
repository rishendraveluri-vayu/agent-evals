import { Controller, Get, Query } from '@nestjs/common';
import type { JudgeTrustResponse } from '../contract';
import { JudgeTrustService } from './trust.service';

/** D83: how far to trust each LLM judge, from the humans' labels. Reads only. */
@Controller('judge')
export class JudgeTrustController {
  constructor(private readonly trust: JudgeTrustService) {}

  /** Every judge with a current judge grade; `?experiment=<id>` keeps that experiment's judges (404 unknown_experiment). */
  @Get('trust')
  get(@Query('experiment') experiment?: unknown): Promise<JudgeTrustResponse> {
    return this.trust.trust(experiment);
  }
}
