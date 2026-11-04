import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { JudgeModule } from '../judge/judge.module';
import { ExperimentsController } from './experiments.controller';
import { ExperimentsService } from './experiments.service';
import { ExportService } from './export.service';

@Module({
  imports: [CatalogueModule, JudgeModule],
  controllers: [ExperimentsController],
  providers: [ExperimentsService, ExportService],
  exports: [ExperimentsService],
})
export class ExperimentsModule {}
