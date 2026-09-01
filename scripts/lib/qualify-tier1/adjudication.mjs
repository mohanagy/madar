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
  'must_not_ready_when_relationships_missing',
  'typed_unresolved_requirement_present',
])

/** Topologies the relationship model supports. Anything else fails closed. */
export const RELATIONSHIP_TOPOLOGIES = new Set(['direct_edge'])
/** Directions the relationship model supports. */
export const RELATIONSHIP_DIRECTIONS = new Set(['forward'])
/** Group cardinalities. */
export const RELATIONSHIP_GROUP_MATCH = new Set(['all_required'])
/** What may suppress a missing relationship. */
export const UNRESOLVED_POLICIES = new Set(['exact_per_relationship', 'forbidden'])

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

  // ---- relationship adapters ----------------------------------------------
  const adapters = requireArray(contract.relationship_channels)
  const ADAPTER_FIELDS = new Set(['channel', 'source_field', 'target_field', 'relation_field',
    'source_id_field', 'target_id_field', 'semantic_direction', 'endpoint_resolution',
    'node_record_channels', 'rationale'])
  const seenAdapters = new Set()
  for (const adapter of adapters) {
    for (const key of Object.keys(adapter)) {
      if (!ADAPTER_FIELDS.has(key)) problems.push(`${CONTRACT_MISMATCH}: relationship adapter ${adapter.channel} declares unknown field ${key}`)
    }
    if (typeof adapter.channel !== 'string' || !adapter.channel.startsWith('.')) { problems.push(`${CONTRACT_MISMATCH}: relationship adapter has no schema-path channel`); continue }
    if (seenAdapters.has(adapter.channel)) problems.push(`${CONTRACT_MISMATCH}: duplicate relationship adapter ${adapter.channel}`)
    seenAdapters.add(adapter.channel)
    for (const key of ['source_field', 'target_field', 'relation_field', 'semantic_direction', 'endpoint_resolution']) {
      if (typeof adapter[key] !== 'string' || !adapter[key]) problems.push(`${CONTRACT_MISMATCH}: relationship adapter ${adapter.channel} is missing ${key}`)
    }
    if (adapter.semantic_direction !== 'source_to_target') problems.push(`${CONTRACT_MISMATCH}: relationship adapter ${adapter.channel} declares unsupported semantic_direction ${JSON.stringify(adapter.semantic_direction)}`)
    if (!['node_id', 'unique_label_in_scope'].includes(adapter.endpoint_resolution)) problems.push(`${CONTRACT_MISMATCH}: relationship adapter ${adapter.channel} declares unsupported endpoint_resolution ${JSON.stringify(adapter.endpoint_resolution)}`)
    if (!Array.isArray(adapter.node_record_channels) || adapter.node_record_channels.length === 0) problems.push(`${CONTRACT_MISMATCH}: relationship adapter ${adapter.channel} declares no node record channels`)
  }

  // ---- relationship requirements -------------------------------------------
  const relationshipsById = new Map()
  const REL_FIELDS = new Set(['id', 'source_selector', 'target_selector', 'direction', 'topology',
    'relation_kinds', 'required_edge_count', 'unresolved_subject_id', 'rationale', 'frozen_clause'])
  for (const requirement of requireArray(contract.relationship_requirements)) {
    for (const key of Object.keys(requirement)) {
      if (!REL_FIELDS.has(key)) { problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} declares unknown field ${key}`) }
    }
    if (typeof requirement.id !== 'string' || !requirement.id) { problems.push(`${CONTRACT_MISMATCH}: a relationship requirement has no id`); continue }
    if (relationshipsById.has(requirement.id)) { problems.push(`${CONTRACT_MISMATCH}: duplicate relationship id ${requirement.id}`); continue }
    let bad = false
    for (const side of ['source_selector', 'target_selector']) {
      const selector = requirement[side]
      if (!selector || typeof selector.path !== 'string' || !selector.path
        || !Array.isArray(selector.symbols) || selector.symbols.length === 0
        || !selector.symbols.every((symbol) => typeof symbol === 'string' && symbol)) {
        problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} has a malformed ${side}`); bad = true; continue
      }
      const doc = readDoc(selector.frozen_source?.file)
      if (!doc) { problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} ${side} references unreadable ${selector.frozen_source?.file}`); bad = true; continue }
      const node = resolvePointer(doc, selector.frozen_source?.pointer ?? '')
      if (node === undefined) { problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} ${side} pointer does not resolve`); bad = true; continue }
      const actual = sha256(JSON.stringify(node))
      if (actual !== selector.frozen_source?.identity_sha256) {
        problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} ${side} frozen identity changed (recorded ${selector.frozen_source?.identity_sha256}, actual ${actual})`); bad = true
      }
    }
    if (!RELATIONSHIP_TOPOLOGIES.has(requirement.topology)) { problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} declares unsupported topology ${JSON.stringify(requirement.topology)}`); bad = true }
    if (!RELATIONSHIP_DIRECTIONS.has(requirement.direction)) { problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} declares unsupported direction ${JSON.stringify(requirement.direction)}`); bad = true }
    if (!Array.isArray(requirement.relation_kinds) || requirement.relation_kinds.length === 0
      || !requirement.relation_kinds.every((kind) => typeof kind === 'string' && kind)) {
      problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} declares an empty or malformed relation kind set`); bad = true
    }
    if (!Number.isInteger(requirement.required_edge_count) || requirement.required_edge_count < 1) {
      problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} has a malformed required_edge_count`); bad = true
    }
    if (requirement.unresolved_subject_id !== null && requirement.unresolved_subject_id !== requirement.id) {
      problems.push(`${CONTRACT_MISMATCH}: relationship ${requirement.id} declares unresolved_subject_id ${JSON.stringify(requirement.unresolved_subject_id)}; it must equal the relationship id or be null`); bad = true
    }
    if (!bad) relationshipsById.set(requirement.id, requirement)
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
    const malformed = validateParams(entry, requirementsById, relationshipsById)
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

  // Every declared relationship must be used by some entry, and no entry may
  // name one that does not exist.
  const used = new Set()
  for (const entry of byClause.values()) {
    for (const id of entry.predicate?.params?.relationship_ids ?? []) used.add(id)
  }
  for (const id of relationshipsById.keys()) {
    if (!used.has(id)) problems.push(`${CONTRACT_MISMATCH}: relationship ${id} is declared but no clause uses it`)
  }

  return { contract, digest, problems, byClause, requirementsById, relationshipsById, adapters }
}

function validateParams(entry, requirementsById, relationshipsById) {
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
      if (p.relationship != null) return 'must_not_ready_when_requirements_missing no longer carries a relationship; use must_not_ready_when_relationships_missing'
      if (!strings(p.ready_states)) return 'ready_states must be a string array'
      if (p.unresolved != null) {
        const channelProblem = validateChannels(p.unresolved.channels)
        if (channelProblem) return channelProblem
      }
      return null
    }
    case 'must_not_ready_when_relationships_missing': {
      if (!strings(p.relationship_ids) || p.relationship_ids.length === 0) return 'relationship_ids must be a non-empty string array'
      for (const id of p.relationship_ids) if (!relationshipsById.has(id)) return `unknown relationship id ${id}`
      if (!RELATIONSHIP_GROUP_MATCH.has(p.group_match)) return `unsupported group_match ${JSON.stringify(p.group_match)}`
      if (!strings(p.ready_states) || p.ready_states.length === 0) return 'ready_states must be a non-empty string array'
      if (!UNRESOLVED_POLICIES.has(p.unresolved_policy)) return `unsupported unresolved_policy ${JSON.stringify(p.unresolved_policy)}`
      if (p.unresolved_policy === 'exact_per_relationship') {
        const channelProblem = validateChannels(p.unresolved_channels)
        if (channelProblem) return channelProblem
        // Every accepted subject value must be a declared relationship id.
        for (const channel of p.unresolved_channels) {
          const values = channel.shape === 'typed_record' ? channel.subject_values : channel.subject_tokens
          for (const value of values) {
            if (!relationshipsById.has(value)) return `unresolved channel ${channel.channel} accepts subject ${JSON.stringify(value)}, which is not a declared relationship id`
          }
        }
      } else if (p.unresolved_channels != null) {
        return 'unresolved_policy forbidden must not declare unresolved channels'
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
 * Node records the artifact publishes, indexed for endpoint resolution.
 *
 * A relationship endpoint is never matched by label alone. An edge names its
 * endpoints; those names are resolved to a node record carrying a source file,
 * and only then compared against the frozen path AND symbol. A same-named
 * symbol in another file, or the right file with another symbol, does not
 * satisfy a frozen selector.
 */
function collectNodeRecords(artifact, channels) {
  const byId = new Map()
  const byLabel = new Map()
  for (const channel of channels) {
    for (const node of readChannel(artifact, channel)) {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) continue
      const label = typeof node.label === 'string' ? node.label : null
      const file = typeof node.source_file === 'string' ? node.source_file : null
      if (!label || !file) continue
      const record = { label, source_file: file, node_id: typeof node.node_id === 'string' ? node.node_id : null, channel }
      if (record.node_id && !byId.has(record.node_id)) byId.set(record.node_id, record)
      const seen = byLabel.get(label)
      if (seen === undefined) byLabel.set(label, record)
      else if (seen && seen.source_file !== file) byLabel.set(label, null) // ambiguous: fail closed
    }
  }
  return { byId, byLabel }
}

/** Does a resolved node record satisfy a frozen endpoint selector? */
function endpointMatches(record, selector, normaliseSymbol) {
  if (!record) return false
  if (record.source_file !== selector.path) return false
  const wanted = new Set((selector.symbols ?? []).map(normaliseSymbol))
  return wanted.has(normaliseSymbol(record.label))
}

/**
 * Every typed relationship the artifact presents, through declared adapters.
 *
 * Only a channel whose schema carries an explicit source, an explicit target, an
 * explicit relation kind and a defined semantic direction can prove a
 * relationship. Adjacency — two nodes next to each other in a traversal, or
 * merely both present in a Pack — proves nothing and is not read here.
 */
export function extractTypedEdges(artifact, adapters) {
  const edges = []
  for (const adapter of adapters ?? []) {
    const nodes = collectNodeRecords(artifact, adapter.node_record_channels ?? [])
    for (const raw of readChannel(artifact, adapter.channel)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const relation = raw[adapter.relation_field]
      const sourceLabel = raw[adapter.source_field]
      const targetLabel = raw[adapter.target_field]
      if (typeof relation !== 'string' || typeof sourceLabel !== 'string' || typeof targetLabel !== 'string') continue

      const resolve = (idField, label) => {
        const id = idField ? raw[idField] : null
        if (typeof id === 'string' && nodes.byId.has(id)) return nodes.byId.get(id)
        if (adapter.endpoint_resolution === 'node_id') return null
        // `unique_label_in_scope`: exactly one node record may carry the label.
        return nodes.byLabel.get(label) ?? null
      }
      edges.push({
        channel: adapter.channel,
        relation,
        source_label: sourceLabel,
        target_label: targetLabel,
        source: resolve(adapter.source_id_field, sourceLabel),
        target: resolve(adapter.target_id_field, targetLabel),
      })
    }
  }
  return edges
}

/**
 * Is one frozen relationship requirement satisfied?
 *
 * Direction and relation kind are both enforced. `forward` means the edge runs
 * source → target as the channel's schema defines it; a reverse edge does not
 * satisfy a forward requirement, and a relation outside the allowlist does not
 * satisfy it either.
 */
export function evaluateRelationship(requirement, edges, normaliseSymbol) {
  const allowed = new Set(requirement.relation_kinds ?? [])
  const matches = []
  const nearMisses = []
  for (const edge of edges) {
    const forward = endpointMatches(edge.source, requirement.source_selector, normaliseSymbol)
      && endpointMatches(edge.target, requirement.target_selector, normaliseSymbol)
    const reverse = endpointMatches(edge.source, requirement.target_selector, normaliseSymbol)
      && endpointMatches(edge.target, requirement.source_selector, normaliseSymbol)
    if (!forward && !reverse) continue
    const relationAllowed = allowed.has(edge.relation)
    const directionOk = requirement.direction === 'forward' ? forward : (forward || reverse)
    if (directionOk && relationAllowed) matches.push({ channel: edge.channel, relation: edge.relation, from: edge.source_label, to: edge.target_label })
    else nearMisses.push({ channel: edge.channel, relation: edge.relation, from: edge.source_label, to: edge.target_label, rejected_for: !directionOk ? 'direction' : 'relation_kind' })
  }
  const required = requirement.required_edge_count ?? 1
  return {
    id: requirement.id,
    present: matches.length >= required,
    matches,
    rejected: nearMisses,
    required_edge_count: required,
    direction: requirement.direction,
    relation_kinds: [...allowed].sort(),
  }
}

/** Is one frozen requirement identity surfaced by the evidence set? *//** Is one frozen requirement identity surfaced by the evidence set? */
export function requirementPresent(requirement, evidence, normaliseSymbol) {
  const paths = new Set(evidence.generous.paths)
  const symbols = new Set(evidence.generous.symbols.map(normaliseSymbol))
  const pathPresent = requirement.path ? paths.has(requirement.path) : true
  const symbolPresent = (requirement.symbols ?? []).length === 0
    ? true
    : requirement.symbols.some((symbol) => symbols.has(normaliseSymbol(symbol)))
  return { present: pathPresent && symbolPresent, path_present: pathPresent, symbol_present: symbolPresent }
}
