/** Types for the mutation-harness scoring module, so its self-tests typecheck. */
export interface SuiteResult {
  readonly usable: boolean
  readonly why?: string
  readonly total?: number
  readonly failed?: readonly string[]
}

export interface MutationPlan {
  readonly ok: boolean
  readonly why?: string
  readonly mutated?: string
}

/** Both sides of an exact failure-set comparison, reported whole. */
export interface FailureIdentityComparison {
  readonly declared: readonly string[]
  readonly actual: readonly string[]
  readonly unexpected: readonly string[]
  readonly missing: readonly string[]
  readonly duplicateActual: readonly string[]
  readonly duplicateDeclared: readonly string[]
}

export interface ExactAttribution extends FailureIdentityComparison {
  readonly equal: boolean
  readonly mode?: 'exact_failure_set'
}

export interface MutantScore {
  readonly kind: 'caught' | 'UNCAUGHT' | 'SKIPPED'
  readonly detail: string
  readonly reason?: string
  readonly attribution?: ExactAttribution
}

export interface ExactDeclarationCheck {
  readonly ok: boolean
  readonly reason?: string
  readonly detail?: string
  readonly duplicates?: readonly string[]
}

export declare const ATTRIBUTION_REASONS: {
  readonly unexpectedFailedTest: 'unexpected_failed_test'
  readonly missingExpectedFailedTest: 'missing_expected_failed_test'
  readonly duplicateFailedTestIdentity: 'duplicate_failed_test_identity'
  readonly duplicateDeclaredTestIdentity: 'duplicate_declared_test_identity'
  readonly failureIdentitySetMismatch: 'failure_identity_set_mismatch'
  readonly invalidExactDeclaration: 'invalid_exact_declaration'
}

export function validateExactDeclaration(declared: unknown): ExactDeclarationCheck
export function compareFailureIdentitySets(
  declared: readonly string[],
  actual: readonly string[],
): FailureIdentityComparison
export function recomputeExactAttribution(
  declared: readonly string[],
  actual: readonly string[],
): ExactAttribution

export function matchesExpectation(name: string, expected: readonly (string | RegExp)[]): boolean
export function readSuiteResult(input: { raw?: string; report?: unknown }): SuiteResult
export function planMutation(input: {
  source: string
  from: string
  to: string
  scopeAfter?: string | null
}): MutationPlan
export function scoreMutant(input: {
  expect?: readonly (string | RegExp)[]
  result: SuiteResult
  exactFailureSet?: boolean
}): MutantScore
export function baselineVerdict(result: SuiteResult): string | null

export function parseReportFromText(text: unknown): unknown | null
export function classifyReportAvailability(input: {
  fileExists: boolean
  fileText?: string
  stdout?: string
}): { report: unknown | null; source: string }
