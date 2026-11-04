import { Controller, Get, Query } from '@nestjs/common';
import type { SpendView, SystemSpendRow } from '../contract';
import { SpendService } from './spend.service';

@Controller('spend')
export class SpendController {
  constructor(private readonly spend: SpendService) {}

  /** Trial spend and the platform's own calls as separate lines, with each allowance (D38). */
  @Get()
  totals(): Promise<SpendView> {
    return this.spend.totals();
  }

  /** One row per platform-made call, newest first; `?kind=conflict_check` narrows it. */
  @Get('system')
  rows(@Query('kind') kind?: string): Promise<SystemSpendRow[]> {
    return this.spend.rows(typeof kind === 'string' && kind ? kind : undefined);
  }
}
