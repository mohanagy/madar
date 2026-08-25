/** Types for the receipt estimate-history carry-forward, so its tests typecheck. */

/**
 * Carries a prior `superseded_estimate` from the receipt at `outPath` onto the
 * freshly rendered receipt JSON, matched by corpus scope.
 *
 * Returns `renderedJson` unchanged when there is no previous receipt, when it
 * cannot be parsed, or when it carries no superseded estimate.
 */
export function carryForwardSupersededEstimates(renderedJson: string, outPath: string): string
