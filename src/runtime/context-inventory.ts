import type {
  ContextInventoryEntry,
  ContextInventorySourceDescriptor,
  ContextInventorySourceKind,
  ContextInventorySourceMetadata,
  ContextInventoryValue,
} from '../contracts/context-inventory.js'

export interface ContextInventorySourceInput {
  kind: string
  locator?: string
  label?: string
  metadata?: ContextInventorySourceMetadata
}

export interface ContextInventoryEntryInput {
  id: string
  source: ContextInventorySourceInput | ContextInventorySourceDescriptor
  content: string | null
  summary?: string
  token_count?: number
  tags?: readonly string[]
  attributes?: Record<string, ContextInventoryValue>
}

const SOURCE_KIND_ALIASES: Record<string, ContextInventorySourceKind> = {
  code: 'code',
  source: 'code',
  doc: 'docs',
  docs: 'docs',
  document: 'docs',
  documentation: 'docs',
  diff: 'diff',
  patch: 'diff',
  graph: 'graph',
  node: 'graph',
  log: 'logs',
  logs: 'logs',
}

function normalizeString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function normalizePositiveInteger(value: number | undefined, field: 'line_start' | 'line_end'): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Context inventory ${field} must be a positive integer`)
  }
  return value
}

function normalizeStream(value: ContextInventorySourceMetadata['stream']): ContextInventorySourceMetadata['stream'] {
  if (value === undefined) {
    return undefined
  }
  if (value !== 'stdout' && value !== 'stderr') {
    throw new Error('Context inventory log stream must be stdout or stderr')
  }
  return value
}

function normalizeSourceKind(value: string): ContextInventorySourceKind {
  const normalized = SOURCE_KIND_ALIASES[value.trim().toLowerCase()]
  if (!normalized) {
    throw new Error(`Unsupported context inventory source kind: ${value}`)
  }
  return normalized
}

function normalizeSourceMetadata(
  kind: ContextInventorySourceKind,
  locator: string,
  metadata: ContextInventorySourceMetadata | undefined,
): ContextInventorySourceMetadata | undefined {
  const lineStart = normalizePositiveInteger(metadata?.line_start, 'line_start')
  const lineEnd = normalizePositiveInteger(metadata?.line_end, 'line_end')
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    throw new Error('Context inventory line_end must be greater than or equal to line_start')
  }

  const baseRef = normalizeString(metadata?.base_ref)
  const headRef = normalizeString(metadata?.head_ref)
  if (kind === 'diff' && Boolean(baseRef) !== Boolean(headRef)) {
    throw new Error('Diff inventory source metadata requires both base_ref and head_ref')
  }

  const path = normalizeString(metadata?.path) ?? (kind === 'code' || kind === 'docs' ? locator : undefined)
  const title = normalizeString(metadata?.title)
  const section = normalizeString(metadata?.section)
  const language = normalizeString(metadata?.language)
  const command = normalizeString(metadata?.command)
  const stream = normalizeStream(metadata?.stream)

  const normalized: ContextInventorySourceMetadata = {}
  if (path !== undefined) {
    normalized.path = path
  }
  if (title !== undefined) {
    normalized.title = title
  }
  if (section !== undefined) {
    normalized.section = section
  }
  if (language !== undefined) {
    normalized.language = language
  }
  if (lineStart !== undefined) {
    normalized.line_start = lineStart
  }
  if (lineEnd !== undefined) {
    normalized.line_end = lineEnd
  }
  if (baseRef !== undefined) {
    normalized.base_ref = baseRef
  }
  if (headRef !== undefined) {
    normalized.head_ref = headRef
  }
  if (command !== undefined) {
    normalized.command = command
  }
  if (stream !== undefined) {
    normalized.stream = stream
  }

  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined
}

function normalizeTags(tags: readonly string[] | undefined): string[] | undefined {
  if (!tags) {
    return undefined
  }

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const tag of tags) {
    const value = normalizeString(tag)
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    normalized.push(value)
  }

  return normalized.length > 0 ? normalized.sort((left, right) => left.localeCompare(right)) : undefined
}

export function normalizeContextInventorySource(
  input: ContextInventorySourceInput | ContextInventorySourceDescriptor,
): ContextInventorySourceDescriptor {
  const kindValue = normalizeString(input.kind)
  if (!kindValue) {
    throw new Error('Context inventory source kind is required')
  }

  const locator = normalizeString(input.locator) ?? normalizeString(input.metadata?.path)
  if (!locator) {
    throw new Error('Context inventory source locator is required')
  }

  const kind = normalizeSourceKind(kindValue)
  const label = normalizeString(input.label) ?? locator
  const metadata = normalizeSourceMetadata(kind, locator, input.metadata)

  return metadata
    ? { kind, locator, label, metadata }
    : { kind, locator, label }
}

export function createContextInventoryEntry(input: ContextInventoryEntryInput): ContextInventoryEntry {
  const id = normalizeString(input.id)
  if (!id) {
    throw new Error('Context inventory entry id is required')
  }
  if (typeof input.content !== 'string' && input.content !== null) {
    throw new Error('Context inventory entry content must be a string or null')
  }
  if (input.token_count !== undefined && (!Number.isInteger(input.token_count) || input.token_count < 0)) {
    throw new Error('Context inventory token_count must be a non-negative integer')
  }

  const summary = normalizeString(input.summary)
  const tags = normalizeTags(input.tags)

  return {
    version: 1,
    id,
    source: normalizeContextInventorySource(input.source),
    content: input.content,
    ...(summary ? { summary } : {}),
    ...(input.token_count !== undefined ? { token_count: input.token_count } : {}),
    ...(tags ? { tags } : {}),
    ...(input.attributes ? { attributes: input.attributes } : {}),
  }
}
