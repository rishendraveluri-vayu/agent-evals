import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { HttpResponse } from './http';

/**
 * An error with the contract's body: `{"error": "<code>", "message": "<plain words>"}`, plus
 * `"fix": "<what to do instead>"` when there is one (the D25 follow-up: a refused config says how
 * to put it right, so the UI can show the fix next to the field).
 */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(fix ? { error: code, message, fix } : { error: code, message }, status);
  }
}

export const badRequest = (code: string, message: string, fix?: string): ApiError => new ApiError(400, code, message, fix);
export const notFound = (code: string, message: string, fix?: string): ApiError => new ApiError(404, code, message, fix);
export const conflict = (code: string, message: string, fix?: string): ApiError => new ApiError(409, code, message, fix);

/**
 * A Postgres error of class 22, "data exception" (node-pg's DatabaseError carries the SQLSTATE in
 * `code`): 22021 a NUL or bad byte in text, 22P05 a NUL in jsonb, 22003 a number out of range,
 * 22P02 text that is not of the column's type, and the rest of the class.
 */
function isDataError(e: unknown): e is Error & { code: string } {
  if (!(e instanceof Error) || !('severity' in e)) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code);
}

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
    if (isDataError(exception)) {
      // E9: a value from the request the database cannot take (a NUL character, a number out of
      // a column's range, text that is not of the column's type) is the request's fault: a 400
      // that says so, not a 500. Logged, in case the value was the API's own.
      this.logger.warn(`refused a value the database cannot store (${exception.code}): ${message}`);
      res.status(400).json({
        error: 'invalid_value',
        message: `a value in the request cannot be stored: ${message}`,
        fix: 'Remove any NUL character (\\u0000) and keep numbers in range, then send it again.',
      });
      return;
    }
    this.logger.error(exception instanceof Error ? (exception.stack ?? message) : message);
    res.status(500).json({ error: 'internal_error', message });
  }
}
