// Loads and enforces the frozen machine-checkable adjudication contract.
//
// Tier 1 has frozen requirements written in English. Earlier revisions of this
// evaluator tried to decide them by looking for negation words and subject
// mentions in artifact prose. That is not decidable: "There is no doubt that an
// on-disk matcher cache exists" contains a negation and the subject while
// asserting the opposite, and "supporting evidence for src/hono.ts" mentions a
// missing requirement while asserting its presence.
//
// So no sentence is read. Each frozen clause is bound, by SHA-256 of its exact
// bytes, to one typed predicate declared in docs/qualification/tier1-adjudication.json,
// and the predicates operate only on typed artifact channels and frozen
// identities. A clause whose wording changes stops matching its binding and the
// run refuses rather than silently applying a stale interpretation.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const ADJUDICATION_PATH = 'docs/qualification/tier1-adjudication.json'
export const CONTRACT_MISMATCH = 'adjudication_contract_mismatch'

/** The closed predicate union. Anything outside it refuses the run. */
export const PREDICATE_KINDS = new Set([
  'answerability_not_in',
  'prohibited_reference_absent',
  'required_evidence_paths_present',
  'explicit_path_present',
  'required_typed_absence',
  'prohibited_substitution_absent',
  'must_not_ready_when_requirements_missing',
  'typed_unresolved_requirement_present',
])

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** RFC 6901. Returns undefined when the pointer does not resolve. */
export function resolvePointer(doc, pointer) {
  if (pointer === '') return doc
  let cur = doc
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (cur === null || cur === undefined) return undefined
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key]
  }
  return cur
}

function requireArray(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Load the contract and check it against the frozen sources it claims to bind.
 *
 * Returns { contract, digest, problems, byClause, requirementsById }. A non-empty
 * `problems` means the run must not be measured: an adjudication contract that
 * does not match its sources is not a weaker contract, it is a different one.
 */
export function loadAdjudication(root, { requiredClauses = [] } = {}) {
  const problems = []
  const path = resolve(root, ADJUDICATION_PATH)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { contract: null, digest: null, problems: [`${CONTRACT_MISMATCH}: ${ADJUDICATION_PATH} is unreadable: ${error.message}`], byClause: new Map(), requirementsById: new Map() }
  }
  const digest = createHash('sha256').update(raw).digest('hex')
  let contract
  try {
    contract = JSON.parse(raw)
  } catch (error) {
    return { contract: null, digest, problems: [`${CONTRACT_MISMATCH}: ${ADJUDICATION_PATH} is not valid JSON: ${error.message}`], byClause: new Map(), requirementsById: new Map() }
  }

  const docCache = new Map()
  const readDoc = (file) => {
    if (!docCache.has(file)) {
      try { docCache.set(file, JSON.parse(readFileSync(resolve(root, file), 'utf8'))) }
      catch { docCache.set(file, null) }
    }
    return docCache.get(file)
  }

  // ---- requirement identities --------------------------------------------
  const requirementsById = new Map()
  for (const requirement of requireArray(contract.requirements)) {
    if (requirementsById.has(requirement.id)) {
      problems.push(`${CONTRACT_MISMATCH}: duplicate requirement identity ${requirement.id}`)
      continue
    }
    const doc = readDoc(requirement.source?.file)
    if (!doc) {
      problems.push(`${CONTRACT_MISMATCH}: requirement ${requirement.id} references unreadable ${requirement.source?.file}`)
      continue
    }
    const node = resolvePointer(doc, requirement.source?.pointer ?? '')
    if (node === undefined) {
      problems.push(`${CONTRACT_MISMATCH}: requirement ${requirement.id} pointer ${requirement.source?.pointer} does not resolve in ${requirement.source?.file}`)
      continue
    }
    const actual = sha256(JSON.stringify(node))
    if (actual !== requirement.identity_sha256) {
      problems.push(`${CONTRACT_MISMATCH}: requirement ${requirement.id} identity changed (recorded ${requirement.identity_sha256}, actual ${actual})`)
      continue
    }
    requirementsById.set(requirement.id, requirement)
  }

  // ---- entries -------------------------------------------------------------
  const byClause = new Map()
  const seenIds = new Set()
  for (const entry of requireArray(contract.entries)) {
    if (seenIds.has(entry.id)) problems.push(`${CONTRACT_MISMATCH}: duplicate adjudication id ${entry.id}`)
    seenIds.add(entry.id)

    const key = `${entry.source?.file}#${entry.source?.pointer}`
    if (byClause.has(key)) {
      problems.push(`${CONTRACT_MISMATCH}: clause ${key} has more than one adjudication entry`)
      continue
    }

    const doc = readDoc(entry.source?.file)
    if (!doc) {
      problems.push(`${CONTRACT_MISMATCH}: entry ${entry.id} references unreadable ${entry.source?.file}`)
      continue
    }
    const text = resolvePointer(doc, entry.source?.pointer ?? '')
    if (typeof text !== 'string') {
      problems.push(`${CONTRACT_MISMATCH}: entry ${entry.id} points at no clause (${key})`)
      continue
    }
    const actual = sha256(text)
    if (actual !== entry.source?.clause_sha256) {
      problems.push(`${CONTRACT_MISMATCH}: clause text changed for ${entry.id} (${key}; recorded ${entry.source?.clause_sha256}, actual ${actual})`)
      continue
    }
    if (!PREDICATE_KINDS.has(entry.predicate?.kind)) {
      problems.push(`${CONTRACT_MISMATCH}: entry ${entry.id} declares unknown predicate kind ${JSON.stringify(entry.predicate?.kind)}`)
      continue
    }
    const malformed = validateParams(entry, requirementsById)
    if (malformed) { problems.push(`${CONTRACT_MISMATCH}: entry ${entry.id} has malformed parameters: ${malformed}`); continue }

    byClause.set(key, entry)
  }

  // ---- completeness: every prose clause the caller must adjudicate ---------
  for (const required of requiredClauses) {
    const key = `${required.file}#${required.pointer}`
    if (!byClause.has(key)) {
      problems.push(`${CONTRACT_MISMATCH}: frozen clause ${key} has no adjudication entry`)
    }
  }
  // ... and no entry that points at a clause nobody adjudicates.
  if (requiredClauses.length > 0) {
    const wanted = new Set(requiredClauses.map((c) => `${c.file}#${c.pointer}`))
    for (const key of byClause.keys()) {
      if (!wanted.has(key)) problems.push(`${CONTRACT_MISMATCH}: adjudication entry binds ${key}, which is not a Tier 1 clause`)
    }
  }

  return { contract, digest, problems, byClause, requirementsById }
}

function validateParams(entry, requirementsById) {
  const p = entry.predicate?.params
  if (p === null || typeof p !== 'object') return 'params is not an object'
  const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  switch (entry.predicate.kind) {
    case 'answerability_not_in':
      return strings(p.states) && p.states.length > 0 ? null : 'states must be a non-empty string array'
    case 'prohibited_reference_absent':
      return ['paths', 'paths_and_symbols'].includes(p.scope) ? null : 'scope must be paths or paths_and_symbols'
    case 'required_evidence_paths_present':
      return null
    case 'explicit_path_present':
      return typeof p.path === 'string' && p.path ? null : 'path must be a non-empty string'
    case 'required_typed_absence': {
      if (typeof p.subject_id !== 'string' || !p.subject_id) return 'subject_id must be a non-empty string'
      const channelProblem = validateChannels(p.accepted_channels)
      if (channelProblem) return channelProblem
      if (p.prohibited_substitutions != null) {
        const s = p.prohibited_substitutions
        if (!strings(s.ready_states) || !strings(s.symbols) || !strings(s.paths)) return 'prohibited_substitutions is malformed'
      }
      return null
    }
    case 'prohibited_substitution_absent':
      return typeof p.subject_id === 'string' && strings(p.ready_states) && strings(p.prohibited_symbols) && strings(p.prohibited_paths)
        ? null : 'prohibited_substitution_absent parameters are malformed'
    case 'must_not_ready_when_requirements_missing': {
      if (!strings(p.requirement_ids) || p.requirement_ids.length === 0) return 'requirement_ids must be a non-empty string array'
      for (const id of p.requirement_ids) if (!requirementsById.has(id)) return `unknown requirement identity ${id}`
      if (!['any_missing', 'partial_only'].includes(p.match)) return 'match must be any_missing or partial_only'
      if (p.relationship != null) {
        const strs = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')
        if (!strs(p.relationship.from) || !strs(p.relationship.to)) return 'relationship endpoints are malformed'
        for (const id of [...p.relationship.from, ...p.relationship.to]) {
          if (!requirementsById.has(id)) return `relationship names unknown requirement identity ${id}`
          if (!p.requirement_ids.includes(id)) return `relationship endpoint ${id} is not among requirement_ids`
        }
      }
      if (!strings(p.ready_states)) return 'ready_states must be a string array'
      if (p.unresolved != null) {
        const channelProblem = validateChannels(p.unresolved.channels)
        if (channelProblem) return channelProblem
      }
      return null
    }
    case 'typed_unresolved_requirement_present': {
      if (!strings(p.requirement_ids)) return 'requirement_ids must be a string array'
      return validateChannels(p.channels)
    }
    default:
      return 'unhandled predicate kind'
  }
}

function validateChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return 'accepted channels must be a non-empty array'
  for (const channel of channels) {
    if (typeof channel?.channel !== 'string' || !channel.channel.startsWith('.')) return 'channel must be a schema path'
    if (channel.shape === 'typed_token') {
      if (!Array.isArray(channel.subject_tokens) || channel.subject_tokens.length === 0) return `channel ${channel.channel} has no subject tokens`
    } else if (channel.shape === 'typed_record') {
      if (typeof channel.status_field !== 'string' || typeof channel.subject_field !== 'string') return `channel ${channel.channel} is missing status_field or subject_field`
      if (!Array.isArray(channel.status_values) || channel.status_values.length === 0) return `channel ${channel.channel} has no status values`
      if (!Array.isArray(channel.subject_values) || channel.subject_values.length === 0) return `channel ${channel.channel} has no subject values`
    } else {
      return `channel ${channel.channel} declares unknown shape ${JSON.stringify(channel.shape)}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Typed channel reading
// ---------------------------------------------------------------------------

/** Read a schema path such as `.a.b[]` out of an artifact, yielding leaf values. */
function readChannel(artifact, channel) {
  const segments = channel.replace(/^\./, '').split('.')
  let nodes = [artifact]
  for (const segment of segments) {
    const isArray = segment.endsWith('[]')
    const key = isArray ? segment.slice(0, -2) : segment
    const next = []
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      const value = node[key]
      if (value === undefined) continue
      if (isArray) { if (Array.isArray(value)) next.push(...value) }
      else next.push(value)
    }
    nodes = next
  }
  return nodes
}

/**
 * Does any typed record in `channels` declare `subjectId` with an accepted status?
 *
 * Only the schema decides. A `typed_record` must carry the declared status field
 * AND the declared subject field; a `typed_token` value must equal a declared
 * token exactly. Nothing is inferred from surrounding text, and a free-text
 * channel can never satisfy this because it has neither field.
 */
export function findTypedDeclaration(artifact, channels, subjectId) {
  for (const spec of channels ?? []) {
    for (const value of readChannel(artifact, spec.channel)) {
      if (spec.shape === 'typed_token') {
        if (typeof value !== 'string') continue
        if (!spec.subject_tokens.includes(value)) continue
        if (subjectId && !value.includes(subjectId)) continue
        return { channel: spec.channel, shape: spec.shape, value }
      }
      if (spec.shape === 'typed_record') {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        const status = value[spec.status_field]
        const subject = value[spec.subject_field]
        if (typeof status !== 'string' || typeof subject !== 'string') continue
        if (!spec.status_values.includes(status)) continue
        if (!spec.subject_values.includes(subject)) continue
        if (subjectId && subject !== subjectId) continue
        return { channel: spec.channel, shape: spec.shape, status, subject }
      }
    }
  }
  return null
}

/**
 * Every relationship the artifact actually presents, as endpoint-label pairs.
 *
 * A clause that speaks of "the relationship between A and B" is not satisfied by
 * A and B both appearing somewhere: two isolated nodes are not an edge. These
 * are the channels in which Madar states that two things are connected.
 */
export function extractRelationshipEdges(artifact) {
  const edges = []
  const push = (from, to, channel) => {
    if (typeof from === 'string' && typeof to === 'string' && from && to) edges.push({ from, to, channel })
  }
  const pack = artifact.pack ?? {}
  for (const rel of pack.relationships ?? []) push(rel.from, rel.to, '.pack.relationships[]')
  for (const rel of pack.review_bundle?.relationships ?? []) push(rel.from, rel.to, '.pack.review_bundle.relationships[]')
  for (const rel of pack.slice?.selected_paths ?? []) push(rel.from, rel.to, '.pack.slice.selected_paths[]')
  for (const key of ['direct_dependents', 'transitive_dependents']) {
    for (const entry of pack[key] ?? []) push(pack.target, entry.label, `.pack.${key}[]`)
  }
  for (const community of pack.top_paths_per_community ?? []) {
    const path = community.path ?? []
    for (let index = 0; index + 1 < path.length; index += 1) push(path[index], path[index + 1], '.pack.top_paths_per_community[].path[]')
  }
  for (const key of ['steps', 'primary_path']) {
    const steps = key === 'steps' ? pack.execution_slice?.steps : pack.execution_slice?.primary_path?.steps
    for (let index = 0; index + 1 < (steps ?? []).length; index += 1) {
      push(steps[index].label, steps[index + 1].label, `.pack.execution_slice.${key}[]`)
    }
  }
  return edges
}

/**
 * Does the artifact connect any endpoint of `from` to any endpoint of `to`?
 * Direction-insensitive: the frozen clauses speak of "the relationship between",
 * not of an ordered edge.
 */
export function relationshipPresent(edges, fromRequirements, toRequirements, normaliseSymbol) {
  const labels = (requirements) => new Set(
    requirements.flatMap((requirement) => (requirement.symbols ?? []).map(normaliseSymbol)),
  )
  const left = labels(fromRequirements)
  const right = labels(toRequirements)
  for (const edge of edges) {
    const a = normaliseSymbol(edge.from)
    const b = normaliseSymbol(edge.to)
    if ((left.has(a) && right.has(b)) || (left.has(b) && right.has(a))) return { ...edge }
  }
  return null
}

/** Is one frozen requirement identity surfaced by the evidence set? */
export function requirementPresent(requirement, evidence, normaliseSymbol) {
  const paths = new Set(evidence.generous.paths)
  const symbols = new Set(evidence.generous.symbols.map(normaliseSymbol))
  const pathPresent = requirement.path ? paths.has(requirement.path) : true
  const symbolPresent = (requirement.symbols ?? []).length === 0
    ? true
    : requirement.symbols.some((symbol) => symbols.has(normaliseSymbol(symbol)))
  return { present: pathPresent && symbolPresent, path_present: pathPresent, symbol_present: symbolPresent }
}
