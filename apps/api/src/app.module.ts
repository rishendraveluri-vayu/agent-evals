import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { TrialsModule } from './trials/trials.module';

@Module({
  imports: [HealthModule, TrialsModule],
})
export class AppModule {}
