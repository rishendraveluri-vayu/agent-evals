import { Module } from '@nestjs/common';
import { JudgeModule } from '../judge/judge.module';
import { SpendController } from './spend.controller';
import { SpendService } from './spend.service';

@Module({
  imports: [JudgeModule],
  controllers: [SpendController],
  providers: [SpendService],
  exports: [SpendService],
})
export class SpendModule {}
