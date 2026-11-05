/** Who is labelling (D73): a rater id, typed on the Label page and remembered in this browser.
 *  Storage can be blocked; then the page asks again on each visit. */
import { RATER_ID } from '../api/types';

export const RATER_KEY = 'agent-evals-rater';

/** The id this browser remembers, or null when there is none (or it is not a rater id). */
export function storedRater(): string | null {
  try {
    const saved = window.localStorage.getItem(RATER_KEY);
    return saved !== null && RATER_ID.test(saved) ? saved : null;
  } catch {
    return null;
  }
}

export function rememberRater(id: string): void {
  try {
    window.localStorage.setItem(RATER_KEY, id);
  } catch {
    // Not remembered, but still used for this visit.
  }
}

/** The id as typed, without spaces around it and in lower case, or null when it is not a rater id. */
export function raterFrom(input: string): string | null {
  const id = input.trim().toLowerCase();
  return RATER_ID.test(id) ? id : null;
}
