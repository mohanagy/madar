import type { ContextPackSchemaV1 } from './context-pack.js'

export type HandoffConsumer = 'generic' | 'codex' | 'cursor' | 'copilot'

export type HandoffSnippetPolicy = 'omit' | 'include'

export interface HandoffArtifactSchemaV1<TPack = unknown> extends Omit<ContextPackSchemaV1<TPack>, 'plan'> {
  artifact_kind: 'madar_handoff'
  consumer: HandoffConsumer
  share_safe: boolean
  snippet_policy: HandoffSnippetPolicy
}
