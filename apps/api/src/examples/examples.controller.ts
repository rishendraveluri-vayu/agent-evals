import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { ExampleView, LoadExampleResponse } from '../contract';
import { ExamplesService } from './examples.service';

/** SP7: finished experiments shipped with the repo (examples/<name>/), for a reviewer to open without running anything. */
@Controller('examples')
export class ExamplesController {
  constructor(private readonly examples: ExamplesService) {}

  @Get()
  list(): Promise<ExampleView[]> {
    return this.examples.list();
  }

  /** Imports the example, insert-only. 200 both times: `created` is false when it was already loaded. */
  @Post(':name/load')
  @HttpCode(200)
  load(@Param('name') name: string): Promise<LoadExampleResponse> {
    return this.examples.load(name);
  }
}
