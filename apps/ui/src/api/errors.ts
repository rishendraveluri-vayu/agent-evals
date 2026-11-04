import type { ApiErrorBody } from './types';

/** A failed API call: the HTTP status (0 when the API could not be reached), the contract's
 *  error code and plain-words message, and its `fix` when the API says how to put it right. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fix: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.error === 'string' && typeof v.message === 'string';
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The API's fix for a failed call, when it gave one. */
export function errorFix(err: unknown): string | null {
  return err instanceof ApiError ? err.fix : null;
}

/** The message and, when there is one, the fix, as one sentence pair for an error line. */
export function errorWithFix(err: unknown): string {
  const fix = errorFix(err);
  return fix ? `${errorText(err).replace(/[.\s]+$/, '')}. ${fix}` : errorText(err);
}
