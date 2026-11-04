import { Module } from '@nestjs/common';
import { ExamplesController } from './examples.controller';
import { ExamplesService } from './examples.service';

/** SP7: shipped example experiments, listed and loaded read-only. */
@Module({
  controllers: [ExamplesController],
  providers: [ExamplesService],
})
export class ExamplesModule {}
