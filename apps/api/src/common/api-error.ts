import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { HttpResponse } from './http';

/** An error with the contract's body: `{"error": "<code>", "message": "<plain words>"}`. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super({ error: code, message }, status);
  }
}

export const badRequest = (code: string, message: string): ApiError => new ApiError(400, code, message);
export const notFound = (code: string, message: string): ApiError => new ApiError(404, code, message);
export const conflict = (code: string, message: string): ApiError => new ApiError(409, code, message);

function snake(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/**
 * Gives every error the contract's shape. Nest's own exceptions (`{statusCode, message, error}`)
 * are rewritten; a custom body such as the health report's is sent unchanged.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'statusCode' in body) {
        const b = body as { message?: unknown; error?: unknown };
        const message = Array.isArray(b.message) ? b.message.join('; ') : typeof b.message === 'string' ? b.message : exception.message;
        const code = typeof b.error === 'string' ? snake(b.error) : snake(HttpStatus[status] ?? 'error');
        res.status(status).json({ error: code, message });
        return;
      }
      res.status(status).json(typeof body === 'string' ? { error: snake(HttpStatus[status] ?? 'error'), message: body } : body);
      return;
    }
    const message = exception instanceof Error ? exception.message : String(exception);
    this.logger.error(exception instanceof Error ? (exception.stack ?? message) : message);
    res.status(500).json({ error: 'internal_error', message });
  }
}
