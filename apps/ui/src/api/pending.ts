/**
 * What a screen reads that no contract defines yet, added to the real types as OPTIONAL fields
 * through TypeScript module augmentation, so the screen works without it and uses it once the API
 * sends it. ./contract.ts stays a verbatim copy of the API's.
 *
 * When the API adds one of these to apps/api/src/contract.ts, copy the file over ./contract.ts
 * (contract.spec.ts fails until you do) and delete the field here: a field declared in both with
 * a different type is a compile error, so nothing is left half-merged.
 */
import './contract';

declare module './contract' {
  interface TrialRowSummary {
    /**
     * NOT IN THE CONTRACT: whether every grade passed, null when not graded. The run grid colours
     * a cell pass or fail by it; until the API sends it, a done trial shows as "done, not graded".
     */
    passed?: boolean | null;
  }
}
