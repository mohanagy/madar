import { GraphIntegrityInvariantError } from './graph-integrity.js'

/**
 * Explicit JSON-safety guards for everything that will become serialized bytes.
 *
 * The canonical-JSON module already refuses these values, but it signals with
 * `TypeError`, and a `TypeError` is exactly what a programming mistake in this
 * validator would also produce. Catching it here would convert real bugs into
 * "the data was bad", so the guards are duplicated deliberately and explicitly
 * rather than wrapped. The canonical serializer is still run against a finalized
 * snapshot as a probe, to prove these guards agree with it.
 *
 * The bounds exist because a serializer-facing value with no bound is a way to
 * make an artifact arbitrarily large without ever failing a type check.
 */

export const MAX_CANONICAL_DEPTH = 12 as const
export const MAX_CANONICAL_STRING_LENGTH = 4096 as const
export const MAX_CANONICAL_ARRAY_LENGTH = 512 as const
export const MAX_CANONICAL_OBJECT_KEYS = 128 as const

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  const type = typeof value
  if (type !== 'object') return `a ${type}`
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype === Object.prototype || prototype === null) return 'an object'
  return `a ${(value as { constructor?: { name?: string } }).constructor?.name ?? 'class'} instance`
}

/**
 * Validates that a value is bounded, acyclic, canonical JSON.
 *
 * Rejects the whole non-JSON family by name rather than by a catch: bigint,
 * function, symbol, undefined, NaN, Infinity, class instances, Date, Map, Set
 * and typed arrays all reach here as ordinary values that satisfy their static
 * types.
 */
export function assertCanonicalJsonValue(
  value: unknown,
  field: string,
  seen: Set<object> = new Set(),
  depth = 0,
): void {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new GraphIntegrityInvariantError(`${field} nests deeper than ${MAX_CANONICAL_DEPTH}`)
  }

  if (value === null) return

  switch (typeof value) {
    case 'string':
      if (value.length > MAX_CANONICAL_STRING_LENGTH) {
        throw new GraphIntegrityInvariantError(`${field} exceeds ${MAX_CANONICAL_STRING_LENGTH} characters`)
      }
      return
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) {
        throw new GraphIntegrityInvariantError(`${field} must be a finite number, not ${String(value)}`)
      }
      return
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new GraphIntegrityInvariantError(`${field} must be canonical JSON, not ${describe(value)}`)
    default:
      break
  }

  const container = value as object
  if (seen.has(container)) {
    throw new GraphIntegrityInvariantError(`${field} is cyclic`)
  }
  seen.add(container)

  if (Array.isArray(value)) {
    if (value.length > MAX_CANONICAL_ARRAY_LENGTH) {
      throw new GraphIntegrityInvariantError(`${field} exceeds ${MAX_CANONICAL_ARRAY_LENGTH} entries`)
    }
    for (const [index, entry] of value.entries()) {
      assertCanonicalJsonValue(entry, `${field}[${index}]`, seen, depth + 1)
    }
    seen.delete(container)
    return
  }

  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GraphIntegrityInvariantError(`${field} must be canonical JSON, not ${describe(value)}`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new GraphIntegrityInvariantError(`${field} must not carry symbol keys`)
  }

  const keys = Object.getOwnPropertyNames(value)
  if (keys.length > MAX_CANONICAL_OBJECT_KEYS) {
    throw new GraphIntegrityInvariantError(`${field} exceeds ${MAX_CANONICAL_OBJECT_KEYS} keys`)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw new GraphIntegrityInvariantError(`${field}.${key} must be a data property, not an accessor`)
    }
    if (descriptor?.enumerable !== true) {
      // A non-enumerable own property is invisible to JSON but visible to code,
      // so validator and serializer would disagree about the object.
      throw new GraphIntegrityInvariantError(`${field}.${key} must be enumerable`)
    }
    if (key.length > MAX_CANONICAL_STRING_LENGTH) {
      throw new GraphIntegrityInvariantError(`${field} has a key longer than ${MAX_CANONICAL_STRING_LENGTH}`)
    }
    assertCanonicalJsonValue((value as Record<string, unknown>)[key], `${field}.${key}`, seen, depth + 1)
  }
  seen.delete(container)
}
