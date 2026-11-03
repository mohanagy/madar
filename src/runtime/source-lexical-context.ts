import type { SourceLexicalDefinitionContext } from '../contracts/context-pack.js'

export const SOURCE_LEXICAL_DEFINITION_CAVEAT = 'Same-class method definitions are source context only; unresolved calls do not establish runtime dispatch.'

/** Caution metadata only: accepting it never authorizes source, an owner or an edge. */
export function sourceLexicalDefinitionContext(value: unknown): SourceLexicalDefinitionContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const context = value as Record<string, unknown>, ids = context.admitted_node_ids
  if (context.runtime_dispatch !== 'unresolved' || !Array.isArray(ids) || !ids.length || ids.length > 4
    || ids.some(id => typeof id !== 'string' || !id.length || id.length > 1024) || new Set(ids).size !== ids.length) return undefined
  return { admitted_node_ids: [...ids] as string[], runtime_dispatch: 'unresolved' }
}

export function applySourceLexicalCaution(payload: Record<string, unknown>): void {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  if (!sourceLexicalDefinitionContext(record(record(payload.pack).source_dependencies).lexical_definition_context)) return
  const evidence = record(payload.evidence), answerability = record(evidence.answerability)
  evidence.answerability = { ...answerability, state: 'insufficient', answer_scope: 'partial', advisory: true,
    caveats: [...new Set([...(Array.isArray(answerability.caveats) ? answerability.caveats : []), SOURCE_LEXICAL_DEFINITION_CAVEAT])] }
  evidence.agent_directive = 'explore_with_caution'
  payload.evidence = evidence
}
