export declare function ensureMirror(
  cacheDir: string,
  url: string,
  ref: string,
  options?: { allowNetwork?: boolean },
): { dir: string; fetched: boolean }

export interface PreparationReceipt {
  readonly target_id: string
  readonly kind: string
  readonly url: string
  readonly ref: string
  readonly head: string | null
  readonly patch: string | null
  readonly patch_digest: string | null
  readonly patch_applied: boolean
  readonly cited_blobs_total: number
  readonly cited_blobs_verified: number
  readonly cited_blob_mismatches: readonly { path: string; expected: string; actual: string | null }[]
  readonly valid: boolean
  /** A validity-rules.md reason code; never a product-quality statement. */
  readonly invalid_reason: string | null
  readonly detail: string | null
}

export declare function prepareTarget(input: {
  target: Record<string, unknown>
  baseTarget: Record<string, unknown> | null
  contractRoot: string
  cacheDir: string
  destDir: string
  allowNetwork?: boolean
}): PreparationReceipt

export declare function pathExistsInTarget(destDir: string, path: string): boolean

/** Every identifier token and file basename in the prepared target. */
export declare function targetTokenIndex(destDir: string): ReadonlySet<string>

/**
 * True when `symbol` is grounded in the pinned target. Used ONLY to detect
 * fabrication; never for obligation recall, which compares enumerated symbol
 * entries and never source text.
 */
export declare function symbolExistsInTarget(destDir: string, symbol: string): boolean
