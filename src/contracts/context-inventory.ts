export type ContextInventorySourceKind = 'graph' | 'code' | 'docs' | 'diff' | 'logs'

export interface ContextInventorySourceMetadata {
  path?: string
  title?: string
  section?: string
  language?: string
  line_start?: number
  line_end?: number
  base_ref?: string
  head_ref?: string
  command?: string
  stream?: 'stdout' | 'stderr'
}

export interface ContextInventorySourceDescriptor {
  kind: ContextInventorySourceKind
  locator: string
  label: string
  metadata?: ContextInventorySourceMetadata
}

export type ContextInventoryValue =
  | string
  | number
  | boolean
  | null
  | ContextInventoryValue[]
  | { [key: string]: ContextInventoryValue }

export interface ContextInventoryEntry {
  version: 1
  id: string
  source: ContextInventorySourceDescriptor
  content: string | null
  summary?: string
  token_count?: number
  tags?: string[]
  attributes?: Record<string, ContextInventoryValue>
}
