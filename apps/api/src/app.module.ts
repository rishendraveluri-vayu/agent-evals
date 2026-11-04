import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CatalogueModule } from './catalogue/catalogue.module';
import { ApiErrorFilter } from './common/api-error';
import { CoreModule } from './common/core.module';
import { ConfigsModule } from './configs/configs.module';
import { HealthModule } from './health/health.module';
import { TrialsModule } from './trials/trials.module';

@Module({
  imports: [CoreModule, HealthModule, CatalogueModule, ConfigsModule, TrialsModule],
  providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
})
export class AppModule {}
