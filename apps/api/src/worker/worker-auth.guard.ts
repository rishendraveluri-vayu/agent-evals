import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../common/app-config';

/** `/worker/*` needs `Authorization: Bearer $EVALS_WORKER_TOKEN` (docs/api-contract.md). */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.workerToken;
    if (!expected) throw new ApiError(503, 'worker_token_not_set', 'EVALS_WORKER_TOKEN is not set, so no worker can be let in');
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const m = /^Bearer (.+)$/.exec(value ?? '');
    if (!m || !same(m[1], expected)) throw new ApiError(401, 'unauthorized', 'a worker must send Authorization: Bearer <EVALS_WORKER_TOKEN>');
    return true;
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
