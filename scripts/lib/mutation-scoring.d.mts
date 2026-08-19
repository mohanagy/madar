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

export interface MutantScore {
  readonly kind: 'caught' | 'UNCAUGHT' | 'SKIPPED'
  readonly detail: string
}

export function matchesExpectation(name: string, expected: readonly (string | RegExp)[]): boolean
export function readSuiteResult(input: { raw?: string; report?: unknown }): SuiteResult
export function planMutation(input: { source: string; from: string; to: string }): MutationPlan
export function scoreMutant(input: { expect?: readonly (string | RegExp)[]; result: SuiteResult }): MutantScore
export function baselineVerdict(result: SuiteResult): string | null
