import { RATER_ID } from '../contract';
import { badRequest } from '../common/api-error';

/** D73: the rater of every label written before D73, whose line in labels/<set>.jsonl has no rater. */
export const FIRST_RATER = 'rishi';

const RATER_FIX = 'Send the id of the person labelling: 1 to 40 lower-case letters, digits, dashes or underscores, such as a first name.';

/** D73: a rater id (RATER_ID), or a 400 `invalid_rater` that says how to give one. */
export function raterId(value: unknown): string {
  if (value === undefined || value === null || value === '') throw badRequest('invalid_rater', 'rater is required: the id of the person giving the label (D73)', RATER_FIX);
  if (typeof value !== 'string' || !RATER_ID.test(value)) throw badRequest('invalid_rater', 'rater must be 1 to 40 lower-case letters, digits, dashes or underscores', RATER_FIX);
  return value;
}
