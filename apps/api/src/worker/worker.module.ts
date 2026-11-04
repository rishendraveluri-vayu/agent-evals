import { Module } from '@nestjs/common';
import { WorkerAuthGuard } from './worker-auth.guard';
import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';

@Module({
  controllers: [WorkerController],
  providers: [WorkerService, WorkerAuthGuard],
  exports: [WorkerService],
})
export class WorkerModule {}
