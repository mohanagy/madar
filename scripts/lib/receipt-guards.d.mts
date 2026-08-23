/** Types for the receipt-runner guards, so their tests typecheck. */
export interface ArmMeasurement { readonly inputChecksum: string }
export interface ComparisonSession {
  readonly order: string
  readonly base: ArmMeasurement
  readonly head: ArmMeasurement
}
export interface InvalidatedSession {
  readonly scope: string
  readonly order: string
  readonly reason: string
}

export function resolveExactCommit(repoRoot: string, ref: string): string
export function assertCleanTree(repoRoot: string): void
export function assertFreshBuild(dir: string, sha: string): string
export function sessionIsComparable(session: ComparisonSession): boolean
export function partitionSessions(
  sessions: readonly ComparisonSession[],
  scope: string,
): { usable: ComparisonSession[]; invalidated: InvalidatedSession[] }
export function assertDistinctArms(baselineSha: string, candidateSha: string): void

export interface ArmResult {
  readonly scope: string
  readonly samples: readonly number[]
  readonly medianMs: number
  readonly minMs: number
  readonly maxMs: number
  readonly spreadMs: number
  readonly peakRssMb: number
  readonly inputChecksum: string
  readonly emittedCandidates: number
}

export function assertArmResult(
  value: unknown,
  options: { scope: string; inputChecksum: string; where: string },
): ArmResult
