import { Controller, Get } from '@nestjs/common';
import type { HarnessView, ModelView, PromptView, TaskView, ToolsetView } from '../contract';
import { CatalogueService } from './catalogue.service';

/** What configs and experiments are made from. Files in git are the source. */
@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get('harnesses')
  harnesses(): Promise<HarnessView[]> {
    return this.catalogue.listHarnesses();
  }

  @Get('prompts')
  prompts(): Promise<PromptView[]> {
    return this.catalogue.prompts();
  }

  @Get('toolsets')
  toolsets(): Promise<ToolsetView[]> {
    return this.catalogue.toolsets();
  }

  @Get('tasks')
  tasks(): Promise<TaskView[]> {
    return this.catalogue.listTasks();
  }

  @Get('models')
  models(): Promise<ModelView[]> {
    return this.catalogue.listModels();
  }
}
