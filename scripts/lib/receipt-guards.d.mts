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

export const ARM_ENVELOPE_VERSION: 1
export const ARM_METRIC_NAMES: readonly string[]
export const ARM_WALL_UNIT: string
export const ARM_RSS_UNIT: string

export interface ArmSampleContract {
  readonly sampleCount: number
  readonly metricNames: readonly string[]
  readonly wallUnit: string
  readonly rssUnit: string
}

/** The immutable expectation the parent generates before spawning an arm. */
export interface ExpectedArmDescriptor {
  readonly envelopeVersion: 1
  readonly runNonce: string
  readonly armIdentity: string
  readonly revision: string
  readonly mode: string
  readonly corpusScope: string
  readonly inputChecksum: string
  readonly inventoryChecksum: string
  readonly fileCount: number
  readonly candidateCount: number
  readonly sampleContract: ArmSampleContract
}

export interface ArmEnvelope extends ExpectedArmDescriptor {
  readonly completionState: 'complete'
  readonly measurements: {
    readonly samples: readonly number[]
    readonly medianMs: number
    readonly minMs: number
    readonly maxMs: number
    readonly spreadMs: number
    readonly peakRssMb: number
  }
}

export function buildArmDescriptor(fields: {
  runNonce: string
  armIdentity: string
  revision: string
  mode: string
  corpusScope: string
  inputChecksum: string
  inventoryChecksum: string
  fileCount: number
  candidateCount: number
  sampleCount: number
}): ExpectedArmDescriptor

/** Validates an arm envelope against the descriptor the parent generated. */
export function assertArmResult(
  actual: unknown,
  expected: ExpectedArmDescriptor,
  options: { where: string },
): ArmEnvelope
