/**
 * The finished example on the front door: a solved, real A/B experiment shipped with the repo.
 * It is being built separately. Until it exists this slot stays null and "See a finished example"
 * opens the experiments list; once it ships, put its experiment id here and every link to the
 * example opens its comparison.
 */
import { href } from '../router';

export const EXAMPLE_EXPERIMENT_ID: string | null = null;

/** Where "See a finished example" goes: the example's comparison, or the experiments list. */
export function exampleHref(id: string | null = EXAMPLE_EXPERIMENT_ID): string {
  return id ? href.compare(id) : href.experiments();
}
