import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CatalogueModule } from './catalogue/catalogue.module';
import { ApiErrorFilter } from './common/api-error';
import { CoreModule } from './common/core.module';
import { ConfigsModule } from './configs/configs.module';
import { ExperimentsModule } from './experiments/experiments.module';
import { HealthModule } from './health/health.module';
import { LabelsModule } from './labels/labels.module';
import { PreflightModule } from './preflight/preflight.module';
import { SpendModule } from './spend/spend.module';
import { TrialsModule } from './trials/trials.module';
import { WorkerModule } from './worker/worker.module';

@Module({
  imports: [CoreModule, HealthModule, CatalogueModule, ConfigsModule, ExperimentsModule, TrialsModule, WorkerModule, LabelsModule, PreflightModule, SpendModule],
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}
