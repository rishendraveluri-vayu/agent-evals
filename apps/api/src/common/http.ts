/**
 * The few parts of Express's response the controllers use, so the API needs no @types/express.
 * Nest passes the real Express response object.
 */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}
