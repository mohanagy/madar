export type CanonicalJsonPrimitive = null | boolean | number | string

export type CanonicalJson =
  | CanonicalJsonPrimitive
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson }

export type CanonicalArraySemantics = 'ordered' | 'set-like'

export interface CanonicalJsonOptions {
  /**
   * Plain arrays have no safe implicit meaning. Callers must declare whether
   * order is semantic or the array represents a set.
   */
  readonly arraySemantics?: CanonicalArraySemantics
  /**
   * Exceptional schema-declared object orders. An order is used only when an
   * object's keys exactly match the declared key set; every other object keeps
   * the canonical Unicode code-point order.
   */
  readonly fixedObjectKeyOrders?: readonly (readonly string[])[]
}

const ARRAY_SEMANTICS = Symbol('madar.canonical-json.array-semantics')

export interface CanonicalArrayInput {
  readonly [ARRAY_SEMANTICS]: CanonicalArraySemantics
  readonly values: readonly unknown[]
}

/** Declares an array whose input order is semantic. */
export function orderedCanonicalArray(values: readonly unknown[]): CanonicalArrayInput {
  return Object.freeze({ [ARRAY_SEMANTICS]: 'ordered' as const, values })
}

/** Declares an array whose values are recursively canonicalized as a set. */
export function setLikeCanonicalArray(values: readonly unknown[]): CanonicalArrayInput {
  return Object.freeze({ [ARRAY_SEMANTICS]: 'set-like' as const, values })
}

/**
 * True when a string contains a surrogate code unit, i.e. a character outside
 * the Basic Multilingual Plane.
 */
function hasSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdfff) return true
  }
  return false
}

/**
 * Orders strings by Unicode code point.
 *
 * The fast path is exact rather than approximate: UTF-16 code-unit order and
 * code-point order differ only where surrogate pairs are involved, so for
 * strings with no surrogates `<` already gives code-point order. Almost every
 * JSON key qualifies.
 *
 * The slow path materialised two arrays per comparison. Inside an O(n log n)
 * key sort run once per object, that allocation dominated artifact loading --
 * 15.9% of load time in the comparator plus much of the 9.7% spent in GC.
 */
function compareUnicodeCodePoints(left: string, right: string): number {
  if (!hasSurrogate(left) && !hasSurrogate(right)) {
    return left < right ? -1 : left > right ? 1 : 0
  }

  const leftPoints = [...left]
  const rightPoints = [...right]
  const length = Math.min(leftPoints.length, rightPoints.length)

  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0)
    const rightPoint = rightPoints[index]?.codePointAt(0)
    if (leftPoint !== rightPoint) {
      return (leftPoint ?? 0) - (rightPoint ?? 0)
    }
  }

  return leftPoints.length - rightPoints.length
}

function isCanonicalArrayInput(value: unknown): value is CanonicalArrayInput {
  return value !== null
    && typeof value === 'object'
    && ARRAY_SEMANTICS in value
    && Array.isArray((value as { readonly values?: unknown }).values)
}

function canonicalArray(
  values: readonly unknown[],
  semantics: CanonicalArraySemantics,
  ancestors: ReadonlySet<object>,
  options: CanonicalJsonOptions,
): readonly CanonicalJson[] {
  const normalized = values.map((value) => normalizeCanonicalJson(value, {
    ...options,
    arraySemantics: semantics,
  }, ancestors))
  if (semantics === 'ordered') {
    return normalized
  }

  const unique = new Map<string, { readonly bytes: Buffer; readonly value: CanonicalJson }>()
  for (const value of normalized) {
    const bytes = Buffer.from(serializeNormalizedCanonicalJson(value, options), 'utf8')
    unique.set(bytes.toString('hex'), { bytes, value })
  }

  return [...unique.values()]
    .sort((left, right) => Buffer.compare(left.bytes, right.bytes))
    .map((entry) => entry.value)
}

function orderedObjectKeys(keys: readonly string[], options: CanonicalJsonOptions): readonly string[] {
  for (const declaredOrder of options.fixedObjectKeyOrders ?? []) {
    if (
      declaredOrder.length === keys.length
      && declaredOrder.every((key) => keys.includes(key))
    ) {
      return declaredOrder
    }
  }
  return [...keys].sort(compareUnicodeCodePoints)
}

function assertPlainJsonObject(value: object): asserts value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical JSON only accepts plain objects')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Canonical JSON objects cannot contain symbol keys')
  }
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
    throw new TypeError('Canonical JSON objects cannot contain non-enumerable properties')
  }
}

/**
 * Recursively normalizes a value into the canonical JSON domain. Undefined,
 * non-finite numbers, non-plain objects, and cyclic structures are rejected.
 */
export function normalizeCanonicalJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
  ancestors: ReadonlySet<object> = new Set(),
): CanonicalJson {
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value.normalize('NFC')
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON numbers must be finite')
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (value === undefined) {
    throw new TypeError('Canonical JSON does not permit undefined')
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON does not permit ${typeof value} values`)
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON does not permit cyclic values')
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)

  if (isCanonicalArrayInput(value)) {
    return canonicalArray(value.values, value[ARRAY_SEMANTICS], nextAncestors, options)
  }
  if (Array.isArray(value)) {
    if (options.arraySemantics === undefined) {
      throw new TypeError('Canonical JSON arrays require explicit ordered or set-like semantics')
    }
    return canonicalArray(value, options.arraySemantics, nextAncestors, options)
  }

  assertPlainJsonObject(value)
  const normalizedEntries = new Map<string, CanonicalJson>()
  for (const [rawKey, item] of Object.entries(value)) {
    const key = rawKey.normalize('NFC')
    if (normalizedEntries.has(key)) {
      throw new TypeError(`Canonical JSON object keys collide after NFC normalization: ${JSON.stringify(key)}`)
    }
    normalizedEntries.set(key, normalizeCanonicalJson(item, options, nextAncestors))
  }

  const normalized: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>
  for (const key of orderedObjectKeys([...normalizedEntries.keys()], options)) {
    const item = normalizedEntries.get(key)
    if (item !== undefined) {
      normalized[key] = item
    }
  }
  return normalized
}

function serializeNormalizedCanonicalJson(value: CanonicalJson, options: CanonicalJsonOptions): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeNormalizedCanonicalJson(item, options)).join(',')}]`
  }

  const object = value as { readonly [key: string]: CanonicalJson }
  const keys = orderedObjectKeys(Object.keys(object), options)
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serializeNormalizedCanonicalJson(object[key]!, options)}`).join(',')}}`
}

/** Returns deterministic canonical JSON text without a trailing newline. */
export function serializeCanonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  return serializeNormalizedCanonicalJson(normalizeCanonicalJson(value, options), options)
}

/** Returns deterministic UTF-8 bytes for the canonical JSON representation. */
export function canonicalJsonBytes(value: unknown, options: CanonicalJsonOptions = {}): Buffer {
  return Buffer.from(serializeCanonicalJson(value, options), 'utf8')
}
