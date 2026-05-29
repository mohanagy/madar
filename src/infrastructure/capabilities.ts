import { extname } from 'node:path'

import type { FileTypeValue } from '../pipeline/detect.js'

export interface ExtractCapabilityDefinition {
  id: string
  kind: 'extract'
  fileType: FileTypeValue
  extensions: string[]
}

export type CapabilityDefinition = ExtractCapabilityDefinition

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase()
  if (!trimmed || trimmed === '.') {
    return ''
  }

  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

function normalizeExtractCapability(capability: ExtractCapabilityDefinition): ExtractCapabilityDefinition {
  const normalizedExtensions = [...new Set(capability.extensions.map(normalizeExtension).filter(Boolean))].sort()
  if (normalizedExtensions.length === 0) {
    throw new Error(`Capability '${capability.id}' must declare at least one extension`)
  }

  return {
    ...capability,
    extensions: normalizedExtensions,
  }
}

function normalizeCapability(capability: CapabilityDefinition): CapabilityDefinition {
  return normalizeExtractCapability(capability)
}

function cloneCapability(capability: CapabilityDefinition): CapabilityDefinition {
  return { ...capability, extensions: [...capability.extensions] }
}

export class CapabilityRegistry {
  private readonly capabilitiesById = new Map<string, CapabilityDefinition>()
  private readonly extractCapabilitiesByExtension = new Map<string, ExtractCapabilityDefinition[]>()

  register(capability: CapabilityDefinition): void {
    const normalized = normalizeCapability(capability)

    if (this.capabilitiesById.has(normalized.id)) {
      throw new Error(`Capability '${normalized.id}' is already registered`)
    }

    if (normalized.kind === 'extract') {
      for (const extension of normalized.extensions) {
        const existing = this.extractCapabilitiesByExtension.get(extension) ?? []
        if (existing.some((registeredCapability) => registeredCapability.fileType === normalized.fileType)) {
          throw new Error(`Extension '${extension}' is already registered for file type '${normalized.fileType}'`)
        }
      }
    }

    this.capabilitiesById.set(normalized.id, normalized)
    for (const extension of normalized.extensions) {
      const existing = this.extractCapabilitiesByExtension.get(extension) ?? []
      this.extractCapabilitiesByExtension.set(extension, [...existing, normalized])
    }
  }

  get(id: string): CapabilityDefinition | null {
    return this.capabilitiesById.get(id) ?? null
  }

  list(): CapabilityDefinition[] {
    return [...this.capabilitiesById.values()].map(cloneCapability)
  }

  resolveExtractorForPath(filePath: string, fileType?: FileTypeValue | null): ExtractCapabilityDefinition | null {
    const extension = normalizeExtension(extname(filePath) || filePath)
    if (!extension) {
      return null
    }

    const candidates = this.extractCapabilitiesByExtension.get(extension) ?? []
    if (candidates.length === 0) {
      return null
    }

    if (fileType) {
      const matched = candidates.find((capability) => capability.fileType === fileType)
      if (matched) {
        return matched
      }
    }

    return candidates.length === 1 ? (candidates[0] ?? null) : null
  }
}

const BUILTIN_EXTRACT_CAPABILITIES = [
  { id: 'builtin:extract:python', kind: 'extract', fileType: 'code', extensions: ['.py'] },
  { id: 'builtin:extract:typescript', kind: 'extract', fileType: 'code', extensions: ['.ts', '.tsx'] },
  { id: 'builtin:extract:javascript', kind: 'extract', fileType: 'code', extensions: ['.js', '.jsx'] },
  { id: 'builtin:extract:go', kind: 'extract', fileType: 'code', extensions: ['.go'] },
  { id: 'builtin:extract:rust', kind: 'extract', fileType: 'code', extensions: ['.rs'] },
  { id: 'builtin:extract:java', kind: 'extract', fileType: 'code', extensions: ['.java'] },
  { id: 'builtin:extract:c-family', kind: 'extract', fileType: 'code', extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'] },
  { id: 'builtin:extract:ruby', kind: 'extract', fileType: 'code', extensions: ['.rb'] },
  { id: 'builtin:extract:swift', kind: 'extract', fileType: 'code', extensions: ['.swift'] },
  { id: 'builtin:extract:kotlin', kind: 'extract', fileType: 'code', extensions: ['.kt', '.kts'] },
  { id: 'builtin:extract:csharp', kind: 'extract', fileType: 'code', extensions: ['.cs'] },
  { id: 'builtin:extract:scala', kind: 'extract', fileType: 'code', extensions: ['.scala'] },
  { id: 'builtin:extract:php', kind: 'extract', fileType: 'code', extensions: ['.php'] },
  { id: 'builtin:extract:lua', kind: 'extract', fileType: 'code', extensions: ['.lua'] },
  { id: 'builtin:extract:toc', kind: 'extract', fileType: 'code', extensions: ['.toc'] },
  { id: 'builtin:extract:zig', kind: 'extract', fileType: 'code', extensions: ['.zig'] },
  { id: 'builtin:extract:powershell', kind: 'extract', fileType: 'code', extensions: ['.ps1'] },
  { id: 'builtin:extract:elixir', kind: 'extract', fileType: 'code', extensions: ['.ex', '.exs'] },
  { id: 'builtin:extract:objective-c', kind: 'extract', fileType: 'code', extensions: ['.m', '.mm'] },
  { id: 'builtin:extract:julia', kind: 'extract', fileType: 'code', extensions: ['.jl'] },
  { id: 'builtin:extract:markdown', kind: 'extract', fileType: 'document', extensions: ['.md'] },
  { id: 'builtin:extract:markdown-paper', kind: 'extract', fileType: 'paper', extensions: ['.md'] },
  { id: 'builtin:extract:text', kind: 'extract', fileType: 'document', extensions: ['.txt', '.rst'] },
  { id: 'builtin:extract:text-paper', kind: 'extract', fileType: 'paper', extensions: ['.txt', '.rst'] },
  { id: 'builtin:extract:paper', kind: 'extract', fileType: 'paper', extensions: ['.pdf'] },
  { id: 'builtin:extract:docx', kind: 'extract', fileType: 'document', extensions: ['.docx'] },
  { id: 'builtin:extract:xlsx', kind: 'extract', fileType: 'document', extensions: ['.xlsx'] },
  { id: 'builtin:extract:image', kind: 'extract', fileType: 'image', extensions: ['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'] },
  { id: 'builtin:extract:audio', kind: 'extract', fileType: 'audio', extensions: ['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav'] },
  { id: 'builtin:extract:video', kind: 'extract', fileType: 'video', extensions: ['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'] },
] satisfies readonly ExtractCapabilityDefinition[]

const BUILTIN_CAPABILITIES = [...BUILTIN_EXTRACT_CAPABILITIES] satisfies readonly CapabilityDefinition[]

export function createCapabilityRegistry(capabilities: readonly CapabilityDefinition[] = []): CapabilityRegistry {
  const registry = new CapabilityRegistry()
  for (const capability of capabilities) {
    registry.register(capability)
  }
  return registry
}

export function builtinCapabilities(): CapabilityDefinition[] {
  return BUILTIN_CAPABILITIES.map(cloneCapability)
}

export function createBuiltinCapabilityRegistry(): CapabilityRegistry {
  return createCapabilityRegistry(builtinCapabilities())
}

export const builtinCapabilityRegistry = createBuiltinCapabilityRegistry()
