import { Module } from '@nestjs/common';
import { WorkerAuthGuard } from '../worker/worker-auth.guard';
import { GraderController, RegradeController } from './grading.controller';
import { GradingService } from './grading.service';

/** SP4: grading as its own step after the trial (R14). */
@Module({
  controllers: [GraderController, RegradeController],
  providers: [GradingService, WorkerAuthGuard],
  exports: [GradingService],
})
export class GradingModule {}
