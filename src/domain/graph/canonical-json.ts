export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue }
function canonicalize(value: unknown, path: string, ancestors: Set<object>): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Graph data at ${path} must contain only finite numbers`)
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') throw new TypeError(`Graph data at ${path} is not JSON-safe`)
  if (ancestors.has(value)) throw new TypeError(`Graph data at ${path} contains a cycle`)
  const array = Array.isArray(value)
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`Graph data at ${path} must use plain objects`)
  }
  const entries = Reflect.ownKeys(value).filter((key) => !array || key !== 'length').map((key, index) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || (array && key !== String(index))
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`Graph data at ${path} must use enumerable string data properties`)
    }
    return [key, descriptor.value] as const
  })
  if (array && entries.length !== value.length) throw new TypeError(`Graph data at ${path} must use dense arrays`)
  ancestors.add(value)
  const result = array
    ? entries.map(([, entry], index) => canonicalize(entry, `${path}[${index}]`, ancestors))
    : Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry, `${path}.${key}`, ancestors)]))
  ancestors.delete(value)
  return result
}
export const canonicalJsonValue = (value: unknown, path = '$'): CanonicalJsonValue => canonicalize(value, path, new Set())
export const canonicalJsonString = (value: unknown, pretty = false): string => JSON.stringify(canonicalJsonValue(value), null, pretty ? 2 : undefined)
export const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
