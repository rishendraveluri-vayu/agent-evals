import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { ConflictCheckView, RenderedPromptView } from '../contract';
import type { HttpResponse } from '../common/http';
import { PreflightService } from './preflight.service';

/** Pre-run checks on a config (D33, D38), next to the config routes. */
@Controller('configs')
export class PreflightController {
  constructor(private readonly preflight: PreflightService) {}

  /** 200 with the rendered prompt (or a failed probe's reason); 202 while a probe is queued or running. */
  @Post(':hash/rendered-prompt')
  async startRendered(@Param('hash') hash: string, @Res({ passthrough: true }) res: HttpResponse): Promise<RenderedPromptView> {
    const view = await this.preflight.renderedPrompt(hash, true);
    res.status(view.status === 'queued' || view.status === 'running' ? 202 : 200);
    return view;
  }

  /** Reads the state without starting a probe; `none` before the first one. */
  @Get(':hash/rendered-prompt')
  rendered(@Param('hash') hash: string): Promise<RenderedPromptView> {
    return this.preflight.renderedPrompt(hash, false);
  }

  /** Runs the conflict check, or returns the stored result for the same input without a call. */
  @Post(':hash/conflict-check')
  @HttpCode(200)
  check(@Param('hash') hash: string): Promise<ConflictCheckView> {
    return this.preflight.conflictCheck(hash);
  }

  /**
   * The stored result for the config as it is now; 200 `null` before any (not a 404, so a page
   * that asks on every visit logs no error). Never calls a model.
   */
  @Get(':hash/conflict-check')
  async stored(@Param('hash') hash: string, @Res() res: HttpResponse): Promise<void> {
    res.status(200).json(await this.preflight.storedCheck(hash));
  }
}
