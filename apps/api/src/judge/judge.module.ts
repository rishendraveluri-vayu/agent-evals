import { Module } from '@nestjs/common';
import { JudgeController } from './judge.controller';
import { JudgeService } from './judge.service';

/** SP4: the LLM judge's per-experiment approval and its LiteLLM key (R8). */
@Module({
  controllers: [JudgeController],
  providers: [JudgeService],
  exports: [JudgeService],
})
export class JudgeModule {}
