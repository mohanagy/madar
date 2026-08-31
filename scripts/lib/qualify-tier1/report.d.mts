/** Fields excluded from the semantic digest because they legitimately vary. */
export declare const VOLATILE_FIELDS: readonly string[]

export declare function semanticDigest(result: Record<string, unknown>): string

export declare function renderReport(result: Record<string, unknown>): string
