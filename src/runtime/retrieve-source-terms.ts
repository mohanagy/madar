import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { KnowledgeGraph } from '../contracts/graph.js'
import { tokenizeLabel } from './retrieve/pipeline.js'

const SOURCE_LOCATION = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/
const IDENTIFIER = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u
const MAX_STORED_SNIPPET_LINES = 25
const MAX_STORED_SNIPPET_CHARS = 2_000
const MAX_TRUNCATED_SNIPPET_CHARS = MAX_STORED_SNIPPET_CHARS + 3
const BUILTIN_EXTRACTOR_PREFIX = 'builtin:extract:'
const OWN = Object.prototype.hasOwnProperty
const EMPTY_TOKENS: readonly string[] = Object.freeze([])

const SOURCE_RELEVANT_FIELDS = [
  'label',
  'file_type',
  'source_file',
  'source_location',
  'line_number',
  'node_kind',
  'snippet',
  'provenance',
  'framework_metadata',
  'external_call',
  'synthetic',
  'placeholder',
  'is_synthetic',
  'is_placeholder',
] as const

type NodeEntry = [string, Record<string, unknown>]

export interface StoredSourceTermEntry {
  readonly eligible: boolean
  readonly tokens: readonly string[]
  readonly normalizedSourceFile: string | null
}

interface CachedStoredSourceTermEntry extends StoredSourceTermEntry {
  readonly fingerprint: string
}

const sourceTermCache = new WeakMap<KnowledgeGraph, Map<string, CachedStoredSourceTermEntry>>()
const sourceTokenizationCount = new WeakMap<KnowledgeGraph, number>()

function hasOwn(value: object, key: PropertyKey): boolean {
  return OWN.call(value, key)
}

/** Type-tagged, length-delimited snapshot; unlike JSON it preserves absence, undefined, NaN, and -0. */
function snapshotValue(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null;'
  switch (typeof value) {
    case 'undefined': return 'undefined;'
    case 'boolean': return value ? 'boolean:1;' : 'boolean:0;'
    case 'number':
      if (Number.isNaN(value)) return 'number:NaN;'
      if (Object.is(value, -0)) return 'number:-0;'
      return `number:${String(value)};`
    case 'bigint': return `bigint:${String(value)};`
    case 'string': return `string:${value.length}:${value}`
    case 'symbol': return `symbol:${String(value.description ?? '')};`
    case 'function': return `function:${String(value)};`
    case 'object': {
      if (seen.has(value)) return 'cycle;'
      seen.add(value)
      if (Array.isArray(value)) {
        const parts = value.map((entry, index) => (
          hasOwn(value, index) ? `1:${snapshotValue(entry, seen)}` : '0:'
        ))
        seen.delete(value)
        return `array:${value.length}:[${parts.join('|')}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      const parts = keys.map((key) => `${key.length}:${key}=${snapshotValue(record[key], seen)}`)
      seen.delete(value)
      return `object:${keys.length}:{${parts.join('|')}}`
    }
  }
  return 'unknown;'
}

function sourceFingerprint(attributes: Record<string, unknown>, normalizationRootContext: string | undefined): string {
  const fields = SOURCE_RELEVANT_FIELDS.map((field) => (
    hasOwn(attributes, field)
      ? `${field.length}:${field}=own:${snapshotValue(attributes[field])}`
      : `${field.length}:${field}=absent;`
  ))
  return `root=${snapshotValue(normalizationRootContext)}|${fields.join('|')}`
}

function canonicalSourcePath(rootContext: string | undefined, candidate: unknown): string | null {
  if (
    typeof rootContext !== 'string'
    || rootContext.length === 0
    || rootContext.includes('\0')
    || typeof candidate !== 'string'
    || candidate.length === 0
    || candidate.includes('\0')
  ) {
    return null
  }

  const normalizedRoot = resolve(rootContext.replaceAll('\\', '/'))
  const absolutePath = resolve(normalizedRoot, candidate.replaceAll('\\', '/'))
  const fromRoot = relative(normalizedRoot, absolutePath)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return null
  }
  return absolutePath.replaceAll('\\', '/')
}

function parseOrderedSourceRange(value: unknown): { start: number; end: number } | null {
  if (typeof value !== 'string') return null
  const match = SOURCE_LOCATION.exec(value)
  if (!match?.[1]) return null
  const start = Number(match[1])
  const end = match[2] === undefined ? start : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) return null
  return { start, end }
}

function validStoredSnippet(value: unknown, range: { start: number; end: number }): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\r')
    || value !== value.trim()
    || value.length > MAX_TRUNCATED_SNIPPET_CHARS
  ) {
    return false
  }
  const lines = value.split('\n')
  if (lines.length > MAX_STORED_SNIPPET_LINES || lines.length > (range.end - range.start + 1)) return false
  if (value.length <= MAX_STORED_SNIPPET_CHARS) return true
  return value.endsWith('...') && !/\s/u.test(value.at(-4) ?? '')
}

function hasFunctionIdentity(attributes: Record<string, unknown>): boolean {
  if (hasOwn(attributes, 'node_kind')) {
    return attributes.node_kind === 'function' || attributes.node_kind === 'method'
  }
  if (!hasOwn(attributes, 'label') || typeof attributes.label !== 'string') return false
  const match = /^(\.)?(.+)\(\)$/.exec(attributes.label)
  return match?.[2] !== undefined && IDENTIFIER.test(match[2])
}

function hasValidExclusionState(attributes: Record<string, unknown>): boolean {
  for (const key of ['external_call', 'synthetic', 'placeholder', 'is_synthetic', 'is_placeholder'] as const) {
    if (!hasOwn(attributes, key)) continue
    if (typeof attributes[key] !== 'boolean' || attributes[key] === true) return false
  }

  if (!hasOwn(attributes, 'framework_metadata')) return true
  const metadata = attributes.framework_metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const record = metadata as Record<string, unknown>
  if (!hasOwn(record, 'external_call')) return true
  return typeof record.external_call === 'boolean' && record.external_call === false
}

function matchingProvenance(
  value: unknown,
  expectedCapability: string,
  normalizedSourceFile: string,
  normalizationRootContext: string | undefined,
  rangeStart: number,
): boolean {
  if (!Array.isArray(value)) return false
  let matched = false
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const builtinExtractor = typeof entry.capability_id === 'string' && entry.capability_id.startsWith(BUILTIN_EXTRACTOR_PREFIX)
    const applicable = entry.stage === 'extract' || builtinExtractor
    if (!applicable) continue
    const location = parseOrderedSourceRange(entry.source_location)
    const sourceFile = canonicalSourcePath(normalizationRootContext, entry.source_file)
    if (
      entry.stage !== 'extract'
      || entry.capability_id !== expectedCapability
      || sourceFile !== normalizedSourceFile
      || location?.start !== rangeStart
    ) {
      return false
    }
    matched = true
  }
  return matched
}

function evaluateStoredSourceTerms(
  attributes: Record<string, unknown>,
  normalizationRootContext: string | undefined,
): Omit<StoredSourceTermEntry, 'tokens'> & { snippet: string | null } {
  if (!hasOwn(attributes, 'file_type') || attributes.file_type !== 'code') return { eligible: false, normalizedSourceFile: null, snippet: null }
  if (!hasFunctionIdentity(attributes) || !hasValidExclusionState(attributes)) return { eligible: false, normalizedSourceFile: null, snippet: null }

  const normalizedSourceFile = hasOwn(attributes, 'source_file')
    ? canonicalSourcePath(normalizationRootContext, attributes.source_file)
    : null
  if (!normalizedSourceFile) return { eligible: false, normalizedSourceFile: null, snippet: null }

  if (typeof attributes.label === 'string' && attributes.label.trim().toLowerCase() === basename(normalizedSourceFile).trim().toLowerCase()) {
    return { eligible: false, normalizedSourceFile, snippet: null }
  }

  const extension = extname(normalizedSourceFile).toLowerCase()
  const expectedCapability = extension === '.ts' || extension === '.tsx'
    ? 'builtin:extract:typescript'
    : extension === '.js' || extension === '.jsx'
      ? 'builtin:extract:javascript'
      : null
  if (!expectedCapability) return { eligible: false, normalizedSourceFile, snippet: null }

  const range = hasOwn(attributes, 'source_location') ? parseOrderedSourceRange(attributes.source_location) : null
  if (!range) return { eligible: false, normalizedSourceFile, snippet: null }
  if (hasOwn(attributes, 'line_number')) {
    const lineNumber = attributes.line_number
    if (!Number.isSafeInteger(lineNumber) || typeof lineNumber !== 'number' || lineNumber <= 0 || lineNumber !== range.start) {
      return { eligible: false, normalizedSourceFile, snippet: null }
    }
  }

  if (!hasOwn(attributes, 'snippet') || !validStoredSnippet(attributes.snippet, range)) {
    return { eligible: false, normalizedSourceFile, snippet: null }
  }
  if (!hasOwn(attributes, 'provenance') || !matchingProvenance(
    attributes.provenance,
    expectedCapability,
    normalizedSourceFile,
    normalizationRootContext,
    range.start,
  )) {
    return { eligible: false, normalizedSourceFile, snippet: null }
  }

  return { eligible: true, normalizedSourceFile, snippet: attributes.snippet }
}

/** Reconciles all supplied current nodes before retrieval filters and retains no omitted IDs. */
export function reconcileStoredSourceTerms(
  graph: KnowledgeGraph,
  normalizationRootContext: string | undefined,
  currentEntries: readonly NodeEntry[] = graph.nodeEntries(),
): ReadonlyMap<string, StoredSourceTermEntry> {
  const previous = sourceTermCache.get(graph) ?? new Map<string, CachedStoredSourceTermEntry>()
  const next = new Map<string, CachedStoredSourceTermEntry>()
  let tokenizations = sourceTokenizationCount.get(graph) ?? 0

  for (const [id, attributes] of currentEntries) {
    const fingerprint = sourceFingerprint(attributes, normalizationRootContext)
    const cached = previous.get(id)
    if (cached?.fingerprint === fingerprint) {
      next.set(id, cached)
      continue
    }

    const evaluated = evaluateStoredSourceTerms(attributes, normalizationRootContext)
    const tokens = evaluated.eligible && evaluated.snippet !== null
      ? Object.freeze(tokenizeLabel(evaluated.snippet))
      : EMPTY_TOKENS
    if (evaluated.eligible) tokenizations += 1
    next.set(id, Object.freeze({
      fingerprint,
      eligible: evaluated.eligible,
      tokens,
      normalizedSourceFile: evaluated.normalizedSourceFile,
    }))
  }

  sourceTermCache.set(graph, next)
  sourceTokenizationCount.set(graph, tokenizations)
  return next
}

/** Internal finite-control surface; intentionally not exported from a package barrel. */
export function storedSourceTermCacheInspection(graph: KnowledgeGraph): {
  entryCount: number
  tokenizationCount: number
  tokenArrays: ReadonlyMap<string, readonly string[]>
} {
  const entries = sourceTermCache.get(graph) ?? new Map<string, CachedStoredSourceTermEntry>()
  return {
    entryCount: entries.size,
    tokenizationCount: sourceTokenizationCount.get(graph) ?? 0,
    tokenArrays: new Map([...entries].map(([id, entry]) => [id, entry.tokens])),
  }
}
