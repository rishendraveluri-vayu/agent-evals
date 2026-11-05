import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { LabelsController } from './labels.controller';
import { LabelsService } from './labels.service';

@Module({
  imports: [CatalogueModule],
  controllers: [LabelsController],
  providers: [LabelsService],
})
export class LabelsModule {}
