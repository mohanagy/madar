import { createHash } from 'node:crypto'

import type { ContextSessionDelta, ContextSessionState } from '../contracts/context-session.js'
import { estimateQueryTokens } from './serve.js'

export interface ContextSessionRefInput {
  ref: string
  content: string
  token_count?: number
}

function compareRefs(left: ContextSessionRefInput, right: ContextSessionRefInput): number {
  return left.ref.localeCompare(right.ref)
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function createContextSessionState(): ContextSessionState {
  return {
    version: 1,
    revision: 0,
    refs: {},
  }
}

export function buildContextSession(
  refs: readonly ContextSessionRefInput[],
  previous: ContextSessionState | undefined,
): { session_state: ContextSessionState; session_delta: ContextSessionDelta } {
  const baseState = previous ?? createContextSessionState()
  const orderedRefs = [...refs]
  const sortedRefs = [...refs].sort(compareRefs)
  const added: ContextSessionDelta['added'] = []
  const updated: ContextSessionDelta['updated'] = []
  const reused_refs: string[] = []
  const reusedRefSet = new Set<string>()

  const nextRefs: ContextSessionState['refs'] = {}
  for (const ref of sortedRefs) {
    const tokenCount = ref.token_count ?? estimateQueryTokens(ref.content)
    const hash = hashContent(ref.content)
    nextRefs[ref.ref] = {
      hash,
      token_count: tokenCount,
    }

    const previousRef = baseState.refs[ref.ref]
    if (!previousRef) {
      added.push({
        ref: ref.ref,
        hash,
        token_count: tokenCount,
        content: ref.content,
      })
      continue
    }

    if (previousRef.hash !== hash) {
      updated.push({
        ref: ref.ref,
        hash,
        token_count: tokenCount,
        content: ref.content,
      })
      continue
    }

    reused_refs.push(ref.ref)
    reusedRefSet.add(ref.ref)
  }

  const invalidated = Object.keys(baseState.refs)
    .filter((ref) => !(ref in nextRefs))
    .sort((left, right) => left.localeCompare(right))
  const reusedContent = orderedRefs
    .filter((ref) => reusedRefSet.has(ref.ref))
    .map((ref) => ref.content)
    .join('')

  return {
    session_state: {
      version: 1,
      revision: baseState.revision + 1,
      refs: nextRefs,
    },
    session_delta: {
      version: 1,
      previous_revision: baseState.revision > 0 ? baseState.revision : null,
      next_revision: baseState.revision + 1,
      added,
      updated,
      invalidated,
      reused_refs,
      reused_token_count: reusedContent.length > 0 ? estimateQueryTokens(reusedContent) : 0,
    },
  }
}
