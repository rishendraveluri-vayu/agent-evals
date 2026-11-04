import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { CreatePromptRequest, CreatedPrompt, HarnessView, ModelView, PromptView, TaskView, ToolsetView } from '../contract';
import type { HttpResponse } from '../common/http';
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

  /** 201 with a new version; 200 with the existing version when the same text was posted before. */
  @Post('prompts')
  async createPrompt(@Body() body: CreatePromptRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<CreatedPrompt> {
    const { prompt, created } = await this.catalogue.createPrompt(body);
    res.status(created ? 201 : 200);
    return prompt;
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
