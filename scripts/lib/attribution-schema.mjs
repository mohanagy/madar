/**
 * The one total schema for persisted mutation-attribution evidence.
 *
 * Four rounds of independent review found the same class of defect on different
 * fields: a persisted conclusion trusted without re-derivation, or a persisted
 * state collapsed in the digest that exists to distinguish states. Each round
 * repaired the field that was named. This module exists so there is no next
 * field to name -- one closed schema, one authority, one canonicalization, both
 * modes.
 *
 * Two rules generate everything here.
 *
 * 1. The DECLARATION decides. `meta.json` records what a mutant must prove.
 *    Every persisted representation is validated against it and none of them
 *    may decide how strictly the evidence is audited.
 *
 * 2. Nothing is coerced. A digest built from `String(value)` cannot tell `7`
 *    from `"7"`, and one built from `value === true` cannot tell `false` from
 *    missing, null, `"invalid"` or `0`. Presence, JSON type, validity and the
 *    canonical value are carried separately so the finite state space stays
 *    finite.
 */

/** The two declared attribution modes. Nothing else is a mode. */
export const ATTRIBUTION_MODES = Object.freeze(['owning_test', 'exact_failure_set'])

/** The exact nested key set each mode persists. Closed, not a minimum. */
export const NESTED_SCHEMA = Object.freeze({
  exact_failure_set: Object.freeze([
    'mode', 'declared', 'actual', 'unexpected', 'missing',
    'duplicateActual', 'duplicateDeclared', 'equal',
  ]),
  owning_test: Object.freeze(['mode', 'matched', 'unmatched', 'caught']),
})

/** The JSON type of a value, with null distinguished from object. */
export function jsonTypeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'boolean' || type === 'number' || type === 'string') return type
  if (type === 'object') return 'object'
  // Anything else -- undefined, function, symbol, bigint -- cannot have come
  // from JSON, so naming it precisely beats pretending it is an object.
  return `non_json_${type}`
}

/**
 * Canonicalizes a JSON value without changing its type.
 *
 * Object keys are sorted so key order is not meaning. Array order is preserved,
 * because element order and duplicate multiplicity ARE meaning for a malformed
 * array -- only a caller that knows a field is set-like may sort it.
 */
export function canonicalJsonValue(value) {
  const type = jsonTypeOf(value)
  if (type === 'number') {
    // A non-finite number cannot round-trip through JSON, so accepting one
    // would let two different in-memory states share a serialized form.
    if (!Number.isFinite(value)) return { non_finite: String(value) }
    return value
  }
  if (type === 'array') return value.map((entry) => canonicalJsonValue(entry))
  if (type === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalJsonValue(value[key])
    return out
  }
  if (type.startsWith('non_json_')) return { unrepresentable: type }
  return value
}

/**
 * The complete persisted state of one field: present or missing, its JSON type,
 * whether it satisfies its schema, and its canonical value.
 *
 * Returned whole rather than reduced to a verdict, because the digest needs the
 * state and the auditor needs the verdict, and collapsing either into the other
 * is what produced the collisions this replaces.
 */
export function fieldState(container, key, { valid = () => true, setLike = false } = {}) {
  if (container === null || typeof container !== 'object' || Array.isArray(container)
    || !Object.prototype.hasOwnProperty.call(container, key)) {
    return { state: 'missing' }
  }
  const value = container[key]
  const type = jsonTypeOf(value)
  const isValid = valid(value) === true
  // Sorting is applied only to a VALID set-like array. Sorting an invalid one
  // would normalize away the very shape that makes it invalid.
  const canonical = setLike && isValid && type === 'array'
    ? [...value].map((entry) => canonicalJsonValue(entry)).sort()
    : canonicalJsonValue(value)
  return {
    state: 'present',
    jsonType: type,
    validity: isValid ? 'valid' : 'invalid',
    value: canonical,
  }
}

/** A field state that is present, valid and equal to an expected string. */
export function isExactString(value) {
  return typeof value === 'string' && value.length > 0
}

/** An array whose every element is a string. */
export function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** A mode value that is one of the two declared modes. */
export function isDeclaredMode(value) {
  return isExactString(value) && ATTRIBUTION_MODES.includes(value)
}

/**
 * Validates the complete persisted attribution contract for one invocation.
 *
 * Returns the problems found and the canonical state of every field the digest
 * must carry. The caller decides how to report; this decides what is true.
 *
 * `deriveOwning` and `deriveExact` are supplied by the caller so the
 * independent derivations stay with the module that owns them.
 */
export function validatePersistedAttribution({ meta, scoring, derived }) {
  const problems = []
  const report = (detail) => problems.push(detail)

  const declaration = fieldState(meta, 'attribution_mode', { valid: isDeclaredMode })
  const topLevel = fieldState(scoring, 'attribution_mode', { valid: isDeclaredMode })
  const nestedObject = nestedObjectState(scoring)

  if (declaration.state !== 'present' || declaration.validity !== 'valid') {
    report(`meta declares no usable attribution mode: ${describe(declaration)}`)
    // Without an authority nothing below can be judged, so the state is
    // returned for the digest and no further conclusion is drawn.
    return { problems, state: { declaration, topLevel, nestedObject, nested: {}, derived: null } }
  }
  const mode = declaration.value

  if (topLevel.state !== 'present' || topLevel.validity !== 'valid') {
    report(`meta declares ${mode}, scoring records ${describe(topLevel)}`)
  } else if (topLevel.value !== mode) {
    report(`meta declares ${mode}, scoring records ${JSON.stringify(topLevel.value)}`)
  }

  if (nestedObject.state !== 'present' || nestedObject.validity !== 'valid') {
    report(`meta declares ${mode} but no usable nested attribution result was persisted: ${describe(nestedObject)}`)
    return { problems, state: { declaration, topLevel, nestedObject, nested: {}, derived } }
  }

  const nested = scoring.attribution
  const nestedMode = fieldState(nested, 'mode', { valid: isDeclaredMode })
  if (nestedMode.state !== 'present' || nestedMode.validity !== 'valid') {
    report(`meta declares ${mode}, nested attribution records ${describe(nestedMode)}`)
  } else if (nestedMode.value !== mode) {
    report(`meta declares ${mode}, nested attribution records ${JSON.stringify(nestedMode.value)}`)
  }

  const allowed = NESTED_SCHEMA[mode]
  for (const key of Object.keys(nested)) {
    if (!allowed.includes(key)) report(`nested attribution carries unknown field ${JSON.stringify(key)}`)
  }

  const states = { mode: nestedMode }
  // Exhaustive over the declared modes. A stored field never selects the
  // branch; the declaration does, and an unknown declaration was already
  // refused above.
  switch (mode) {
    case 'exact_failure_set':
      validateExactSet({ nested, derived, states, report })
      break
    case 'owning_test':
      validateOwningTest({ nested, derived, states, report })
      break
    /* c8 ignore next 2 -- unreachable: isDeclaredMode admits only the two above */
    default:
      report(`unreachable attribution mode ${JSON.stringify(mode)}`)
  }

  return { problems, state: { declaration, topLevel, nestedObject, nested: states, derived } }
}

const EXACT_LISTS = Object.freeze([
  'declared', 'actual', 'unexpected', 'missing', 'duplicateActual', 'duplicateDeclared',
])

function validateExactSet({ nested, derived, states, report }) {
  for (const key of EXACT_LISTS) {
    const state = fieldState(nested, key, { valid: isStringArray, setLike: true })
    states[key] = state
    if (state.state !== 'present' || state.validity !== 'valid') {
      report(`nested attribution ${key} is ${describe(state)}`)
      continue
    }
    const expected = [...(derived?.[key] ?? [])].sort()
    if (JSON.stringify(state.value) !== JSON.stringify(expected)) {
      report(`nested attribution ${key} disagrees with the evidence: `
        + `recorded ${state.value.length}, derived ${expected.length}`)
    }
  }
  const equal = fieldState(nested, 'equal', { valid: (value) => typeof value === 'boolean' })
  states.equal = equal
  if (equal.state !== 'present' || equal.validity !== 'valid') {
    report(`nested attribution equal is ${describe(equal)}`)
  } else if (equal.value !== (derived?.equal === true)) {
    report(`scoring recorded equal=${String(equal.value)}, evidence derives ${String(derived?.equal === true)}`)
  }
}

function validateOwningTest({ nested, derived, states, report }) {
  for (const key of ['matched', 'unmatched']) {
    const state = fieldState(nested, key, { valid: isStringArray, setLike: true })
    states[key] = state
    if (state.state !== 'present' || state.validity !== 'valid') {
      report(`nested attribution ${key} is ${describe(state)}`)
      continue
    }
    const expected = [...(derived?.[key] ?? [])].sort()
    if (JSON.stringify(state.value) !== JSON.stringify(expected)) {
      report(`nested attribution ${key} disagrees with the evidence: `
        + `recorded ${state.value.length}, derived ${expected.length}`)
    }
  }
  const caught = fieldState(nested, 'caught', { valid: (value) => typeof value === 'boolean' })
  states.caught = caught
  if (caught.state !== 'present' || caught.validity !== 'valid') {
    report(`nested attribution caught is ${describe(caught)}`)
  } else if (caught.value !== (derived?.caught === true)) {
    report(`scoring recorded caught=${String(caught.value)}, evidence derives ${String(derived?.caught === true)}`)
  }
}

/**
 * Presence, type, validity and KEY SET of the nested object -- never its value.
 *
 * The per-field states below already carry each value canonically, with
 * set-like arrays sorted. Carrying the whole object as well would duplicate
 * that material in unsorted form, and a truthful array permutation would then
 * change the digest even though the audit accepted it. Key set is what this
 * level is for; values belong to the fields that own them.
 */
function nestedObjectState(scoring) {
  const base = fieldState(scoring, 'attribution', {
    valid: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  })
  if (base.state !== 'present') return base
  if (base.validity === 'valid') {
    return {
      state: 'present',
      jsonType: base.jsonType,
      validity: 'valid',
      keys: Object.keys(scoring.attribution).sort(),
    }
  }
  // Not a plain object: it has no key set, so its canonical value is the only
  // faithful record of what was persisted.
  return base
}

/** A short, type-faithful description of a field state for a message. */
function describe(state) {
  if (state.state === 'missing') return 'missing'
  return `${state.validity} ${state.jsonType} ${JSON.stringify(state.value)?.slice(0, 40) ?? ''}`.trim()
}

/** The owning-test conclusion, derived from the declaration and the report. */
export function deriveOwningTest(expected, failed, matches) {
  const matched = failed.filter((name) => matches(name, expected))
  const matchedSet = new Set(matched)
  return {
    matched: [...matched].sort(),
    unmatched: failed.filter((name) => !matchedSet.has(name)).sort(),
    caught: matched.length > 0,
  }
}
