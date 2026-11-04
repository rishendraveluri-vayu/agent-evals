import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import type { JudgeApprovalResponse, JudgeRevokeResponse } from '../contract';
import { JudgeService } from './judge.service';

/** Approving and revoking real-model judging for one experiment (SP4, R8). UI-facing: never returns the key. */
@Controller('experiments')
export class JudgeController {
  constructor(private readonly judge: JudgeService) {}

  /** 201 with the approval; the key goes only to the grader worker, in grading claims. */
  @Post(':id/judge')
  approve(@Param('id') id: string, @Body() body: unknown): Promise<JudgeApprovalResponse> {
    return this.judge.approve(id, body);
  }

  @Delete(':id/judge')
  @HttpCode(200)
  revoke(@Param('id') id: string): Promise<JudgeRevokeResponse> {
    return this.judge.revoke(id);
  }
}
