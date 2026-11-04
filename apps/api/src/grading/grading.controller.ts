import { Body, Controller, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { GraderClaimResponse, GradesReportResponse, RegradeResponse } from '../contract';
import type { HttpResponse } from '../common/http';
import { WorkerAuthGuard } from '../worker/worker-auth.guard';
import { GradingService } from './grading.service';

/** The grader worker's protocol (R14, D2): claim a grading job, report its grades. */
@Controller('grader')
@UseGuards(WorkerAuthGuard)
export class GraderController {
  constructor(private readonly grading: GradingService) {}

  /** 200 with a grading job, or 204 when nothing needs grading. */
  @Post('claim')
  async claim(@Body() body: unknown, @Res({ passthrough: true }) res: HttpResponse): Promise<GraderClaimResponse | undefined> {
    const job = await this.grading.claim(body);
    res.status(job ? 200 : 204);
    return job ?? undefined;
  }

  /** Reporting the same job and claim twice is a no-op 200; 409 claim_lost means drop it. */
  @Post('trials/:id/grades')
  @HttpCode(200)
  report(@Param('id') id: string, @Body() body: unknown): Promise<GradesReportResponse> {
    return this.grading.report(id, body);
  }
}

/** Re-grading, for example after a grader fix: no trial is re-run. */
@Controller('experiments')
export class RegradeController {
  constructor(private readonly grading: GradingService) {}

  @Post(':id/regrade')
  @HttpCode(202)
  regrade(@Param('id') id: string, @Body() body: unknown): Promise<RegradeResponse> {
    return this.grading.regrade(id, body);
  }
}
