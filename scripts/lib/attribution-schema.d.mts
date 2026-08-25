/** Types for the total persisted-attribution schema, so its controls typecheck. */
export type AttributionMode = 'owning_test' | 'exact_failure_set'

export declare const ATTRIBUTION_MODES: readonly AttributionMode[]
export declare const NESTED_SCHEMA: Readonly<Record<AttributionMode, readonly string[]>>

export type JsonType =
  | 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object'
  | `non_json_${string}`

/** Presence, type, validity and canonical value, carried separately. */
export type FieldState =
  | { readonly state: 'missing' }
  | {
    readonly state: 'present'
    readonly validity: 'valid' | 'invalid'
    readonly jsonType: JsonType
    readonly value?: unknown
    readonly keys?: readonly string[]
  }

export interface FieldStateOptions {
  readonly valid?: (value: unknown) => boolean
  readonly setLike?: boolean
}

export function jsonTypeOf(value: unknown): JsonType
export function canonicalJsonValue(value: unknown): unknown
export function fieldState(
  container: unknown,
  key: string,
  options?: FieldStateOptions,
): FieldState
export function isExactString(value: unknown): boolean
export function isStringArray(value: unknown): boolean
export function isDeclaredMode(value: unknown): boolean

export interface PersistedAttributionState {
  readonly declaration: FieldState
  readonly topLevel: FieldState
  readonly nestedObject: FieldState
  readonly nested: Readonly<Record<string, FieldState>>
  readonly derived: unknown
}

export function validatePersistedAttribution(input: {
  meta: Record<string, unknown>
  scoring: Record<string, unknown>
  derived: unknown
}): { readonly problems: readonly string[]; readonly state: PersistedAttributionState }

export function deriveOwningTest(
  expected: readonly (string | RegExp)[],
  failed: readonly string[],
  matches: (name: string, expected: readonly (string | RegExp)[]) => boolean,
): { readonly matched: readonly string[]; readonly unmatched: readonly string[]; readonly caught: boolean }
