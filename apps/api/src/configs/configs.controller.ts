import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { ConfigDiffEntry, ConfigView, CreateConfigRequest } from '../contract';
import type { HttpResponse } from '../common/http';
import { ConfigsService } from './configs.service';

@Controller('configs')
export class ConfigsController {
  constructor(private readonly configs: ConfigsService) {}

  /** 201 with a new config; 200 with the stored one when the same content was posted before. */
  @Post()
  async create(@Body() body: CreateConfigRequest, @Res({ passthrough: true }) res: HttpResponse): Promise<ConfigView> {
    const { config, created } = await this.configs.create(body);
    res.status(created ? 201 : 200);
    return config;
  }

  @Get()
  list(): Promise<ConfigView[]> {
    return this.configs.list();
  }

  @Get(':hash')
  get(@Param('hash') hash: string): Promise<ConfigView> {
    return this.configs.get(hash);
  }

  /** Every field where config a and config b differ. */
  @Get(':a/diff/:b')
  diff(@Param('a') a: string, @Param('b') b: string): Promise<ConfigDiffEntry[]> {
    return this.configs.diff(a, b);
  }
}
