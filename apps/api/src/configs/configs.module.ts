import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { ConfigsController } from './configs.controller';
import { ConfigsService } from './configs.service';

@Module({
  imports: [CatalogueModule],
  controllers: [ConfigsController],
  providers: [ConfigsService],
  exports: [ConfigsService],
})
export class ConfigsModule {}
