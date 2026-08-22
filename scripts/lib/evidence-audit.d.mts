export interface ProcessOutcome {
  readonly exit_code: number | null
  readonly termination_signal: string | null
  readonly timed_out: boolean
  readonly spawn_error: string | null
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly duration_ms: number
  readonly child_started: boolean
}

export type ReportStatus = 'green' | 'red' | 'unavailable'

export type ProcessStatus =
  | 'spawn_failed' | 'timed_out' | 'signalled' | 'not_started'
  | 'ordinary_zero' | 'ordinary_nonzero' | 'indeterminate' | 'unestablished'

export interface AuditProblem {
  readonly code: string
  readonly invocation: string | null
  readonly detail: string
}

export const REQUIRED_ARTIFACTS: readonly string[]
export const OPTIONAL_ARTIFACTS: readonly string[]
export const WORKER_SIGNATURES: readonly string[]
export const REPORT_FAILURE_FIELDS: readonly string[]
export const CLOCK_TOLERANCE_MS: number

export type ReportShape = 'usable_complete' | 'unavailable_incomplete' | 'unavailable_malformed'

export const VITEST_REPORT_SCHEMA: {
  readonly top: Readonly<Record<string, string>>
  readonly file: Readonly<Record<string, string>>
  readonly assertion: Readonly<Record<string, string>>
}
export const VITEST_STATUS_VALUES: readonly string[]

export function assertUsableVitestJsonReport(report: unknown): {
  result: ReportShape
  problems: ReadonlyArray<{ kind: 'incomplete' | 'malformed'; detail: string }>
}

export function processOutcomeClass(outcome: unknown): string
export function deriveProcessStatus(outcome: unknown): ProcessStatus
export function deriveReportStatus(input: { report: unknown; attribution: unknown }): ReportStatus
export function reportFailureReasons(report: unknown): readonly string[]
export function reportContradiction(report: unknown): readonly string[] | null
export function validateOutcomeCoherence(
  outcome: unknown,
  options: { reportPresent: boolean },
): ReadonlyArray<{ code: string; detail: string }>
export function checkStatusConcordance(input: {
  reportStatus: ReportStatus
  processStatus: ProcessStatus
  signatures?: readonly string[]
}): { code: string; detail: string } | null
export function recomputeAttribution(input: {
  report: unknown
  requestedSuite: string
  root: string
}): { reported: string[]; unexpected: string[]; exactlyOne: boolean; total: number; failed: string[] }
export function recomputeClassification(input: Record<string, unknown>): string
export function semanticAuditDigest(invocations: readonly unknown[]): string
export function auditEvidence(options: Record<string, unknown>): {
  problems: AuditProblem[]
  invocations: Array<Record<string, unknown>>
  mutants: number
  baselines: number
  semanticDigest: string | null
}
