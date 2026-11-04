import { type ApiError, conflict } from '../common/api-error';

/**
 * A shipped example (SP7) is a finished experiment loaded by POST /examples/:name/load. It is
 * read-only, and it is not this database's own work: nothing claims, grades, judges or runs it,
 * and its trials are left out of spend, estimates and the label queue.
 */

/** SQL that is true when trial `t` (by its alias) belongs to no shipped example. */
export const NOT_EXAMPLE_TRIAL = (t: string): string =>
  `NOT EXISTS (SELECT 1 FROM experiments ex WHERE ex.id = ${t}.experiment_id AND ex.example_name IS NOT NULL)`;

export interface ExampleMark {
  id: string;
  example_name: string | null;
}

/** 409 `example_read_only` for anything that would run, change or re-grade an example. */
export function exampleReadOnly(exp: ExampleMark, action: string): ApiError {
  return conflict(
    'example_read_only',
    `experiment ${exp.id} is the shipped example ${exp.example_name}: it is read-only, so it cannot ${action}`,
    'Create your own experiment to run (the example’s configs are in GET /configs), and keep the example as it was shipped.',
  );
}

/** Throws exampleReadOnly when the experiment is a loaded example. */
export function assertNotExample(exp: ExampleMark, action: string): void {
  if (exp.example_name !== null) throw exampleReadOnly(exp, action);
}
