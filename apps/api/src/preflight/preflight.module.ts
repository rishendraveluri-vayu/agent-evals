import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { ConfigsModule } from '../configs/configs.module';
import { SpendModule } from '../spend/spend.module';
import { PreflightController } from './preflight.controller';
import { PreflightService } from './preflight.service';

@Module({
  imports: [CatalogueModule, ConfigsModule, SpendModule],
  controllers: [PreflightController],
  providers: [PreflightService],
  exports: [PreflightService],
})
export class PreflightModule {}
