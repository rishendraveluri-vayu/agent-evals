import { Module } from '@nestjs/common';
import { LabelsModule } from '../labels/labels.module';
import { JudgeController } from './judge.controller';
import { JudgeService } from './judge.service';
import { JudgeTrustController } from './trust.controller';
import { JudgeTrustService } from './trust.service';

/** SP4: the LLM judge's per-experiment approval and its LiteLLM key (R8). D83: how far to trust it. */
@Module({
  imports: [LabelsModule],
  controllers: [JudgeController, JudgeTrustController],
  providers: [JudgeService, JudgeTrustService],
  exports: [JudgeService, JudgeTrustService],
})
export class JudgeModule {}
