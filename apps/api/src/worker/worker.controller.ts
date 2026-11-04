import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { ClaimResponse, HeartbeatResponse, ReportResponse } from '../contract';
import type { HttpResponse } from '../common/http';
import { WorkerAuthGuard } from './worker-auth.guard';
import { WorkerService } from './worker.service';

/** The worker protocol (D2, docs/api-contract.md). Workers never touch the database. */
@Controller('worker')
@UseGuards(WorkerAuthGuard)
export class WorkerController {
  constructor(private readonly worker: WorkerService) {}

  /** 200 with a trial, or 204 when nothing is queued for the harness. */
  @Post('claim')
  async claim(@Body() body: unknown, @Res({ passthrough: true }) res: HttpResponse): Promise<ClaimResponse | undefined> {
    const claimed = await this.worker.claim(body);
    res.status(claimed ? 200 : 204);
    return claimed ?? undefined;
  }

  /** 200 keeps the lease; 409 claim_lost means stop the trial and report nothing. */
  @Post('trials/:id/heartbeat')
  @HttpCode(200)
  heartbeat(@Param('id') id: string, @Body() body: unknown): Promise<HeartbeatResponse> {
    return this.worker.heartbeat(id, body);
  }

  /** LiteLLM's spend-log rows for the trial's key, as LiteLLM returns them. */
  @Get('trials/:id/calls')
  calls(@Param('id') id: string, @Query('role') role?: string): Promise<unknown[]> {
    return this.worker.calls(id, role);
  }

  /** Reporting the same attempt twice is a no-op 200. */
  @Post('trials/:id/report')
  @HttpCode(200)
  report(@Param('id') id: string, @Body() body: unknown): Promise<ReportResponse> {
    return this.worker.report(id, body);
  }
}
