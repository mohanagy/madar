import type { ContextSessionDelta, ContextSessionState } from '../contracts/context-session.js'
import { buildContextSession } from '../runtime/context-session.js'
import { estimateQueryTokens } from '../runtime/serve.js'

/**
 * #80 — cache-aware prompt layout: order stable_sections so the most stable
 * content (workspace manifest, language summary) sits first and the most
 * task-volatile content (current question, recent changes) sits last. The
 * compiler sorts on `sort_key ?? ref`; recommended sort_key prefixes:
 *
 *   "01_workspace_*"   — repository manifest, language summary (most stable)
 *   "10_communities_*" — community / structure overview (semi-stable)
 *   "20_evidence_*"    — task-relevant evidence (semi-stable; rebuilds when
 *                        anchor changes but stays stable across follow-ups
 *                        in the same session)
 *   "90_anchor_*"      — current task anchor (least stable; emits last)
 *
 * The stable_prefix is byte-stable when the underlying graph + anchor are
 * unchanged across follow-ups, so Anthropic's automatic prompt cache can
 * reuse the entire prefix.
 */
export interface ContextPromptStableSection {
  ref: string
  title?: string
  body: string
  sort_key?: string
}

export interface ContextPromptDynamicSection {
  title?: string
  body: string
}

export interface BuildContextPromptInput {
  instructions: readonly string[]
  stable_sections: readonly ContextPromptStableSection[]
  dynamic_sections: readonly ContextPromptDynamicSection[]
  stable_prefix_title?: string
  session?: ContextSessionState
}

export interface ContextPromptMetrics {
  raw_prompt_tokens: number
  stable_prefix_tokens: number
  dynamic_suffix_tokens: number
  session_payload_tokens: number
  effective_prompt_tokens: number
  reused_context_tokens: number
}

export interface BuiltContextPrompt {
  prompt: string
  stable_prefix: string
  dynamic_suffix: string
  session_payload: string
  ordered_stable_refs: string[]
  session_state: ContextSessionState
  session_delta: ContextSessionDelta
  metrics: ContextPromptMetrics
}

const STABLE_PREFIX_INSTRUCTIONS_REF = '__stable_prefix:instructions'
const STABLE_PREFIX_TITLE_REF = '__stable_prefix:title'

function joinBlocks(blocks: readonly string[]): string {
  return blocks.map((block) => block.trim()).filter((block) => block.length > 0).join('\n\n')
}

function renderSection(section: { title?: string; body: string }): string {
  return section.title ? `${section.title}:\n${section.body}` : section.body
}

function compareStableSections(left: ContextPromptStableSection, right: ContextPromptStableSection): number {
  const leftKey = left.sort_key ?? left.ref
  const rightKey = right.sort_key ?? right.ref
  if (leftKey === rightKey) {
    return left.ref.localeCompare(right.ref)
  }
  return leftKey.localeCompare(rightKey)
}

function renderStablePrefix(input: Pick<BuildContextPromptInput, 'instructions' | 'stable_sections' | 'stable_prefix_title'>): {
  ordered_sections: ContextPromptStableSection[]
  stable_prefix: string
  session_refs: { ref: string; content: string }[]
} {
  const ordered_sections = [...input.stable_sections].sort(compareStableSections)
  const session_refs: { ref: string; content: string }[] = []
  const instructions = input.instructions.join('\n').trim()

  if (instructions.length > 0) {
    session_refs.push({
      ref: STABLE_PREFIX_INSTRUCTIONS_REF,
      content: instructions,
    })
  }

  const [firstSection, ...remainingSections] = ordered_sections
  if (input.stable_prefix_title && firstSection) {
    session_refs.push({
      ref: STABLE_PREFIX_TITLE_REF,
      content: `${session_refs.length > 0 ? '\n\n' : ''}${input.stable_prefix_title}:`,
    })
  }

  if (firstSection) {
    session_refs.push({
      ref: firstSection.ref,
      content: `${input.stable_prefix_title ? '\n' : session_refs.length > 0 ? '\n\n' : ''}${renderSection(firstSection)}`,
    })
  }

  for (const section of remainingSections) {
    session_refs.push({
      ref: section.ref,
      content: `\n\n${renderSection(section)}`,
    })
  }

  return {
    ordered_sections,
    stable_prefix: session_refs.map((ref) => ref.content).join(''),
    session_refs,
  }
}

function renderDynamicSuffix(dynamicSections: readonly ContextPromptDynamicSection[]): string {
  return joinBlocks(dynamicSections.map(renderSection))
}

function renderSessionPayload(sessionDelta: ContextSessionDelta, dynamicSuffix: string): string {
  return joinBlocks([
    'Session delta:',
    JSON.stringify(
      {
        previous_revision: sessionDelta.previous_revision,
        next_revision: sessionDelta.next_revision,
        added: sessionDelta.added,
        updated: sessionDelta.updated,
        invalidated: sessionDelta.invalidated,
      },
      null,
      2,
    ),
    dynamicSuffix,
  ])
}

export function buildContextPrompt(input: BuildContextPromptInput): BuiltContextPrompt {
  const { ordered_sections, stable_prefix, session_refs } = renderStablePrefix(input)
  const dynamic_suffix = renderDynamicSuffix(input.dynamic_sections)
  const prompt = joinBlocks([stable_prefix, dynamic_suffix])
  const { session_state, session_delta } = buildContextSession(session_refs, input.session)
  const stable_prefix_tokens = Object.values(session_state.refs).reduce((total, ref) => total + ref.token_count, 0)

  const session_payload =
    session_delta.previous_revision === null
      ? prompt
      : renderSessionPayload(session_delta, dynamic_suffix)
  const raw_prompt_tokens = estimateQueryTokens(prompt)
  const session_payload_tokens = estimateQueryTokens(session_payload)
  const effective_prompt_tokens =
    session_delta.previous_revision === null
      ? raw_prompt_tokens
      : Math.max(0, raw_prompt_tokens - session_delta.reused_token_count)

  return {
    prompt,
    stable_prefix,
    dynamic_suffix,
    session_payload,
    ordered_stable_refs: ordered_sections.map((section) => section.ref),
    session_state,
    session_delta,
    metrics: {
      raw_prompt_tokens,
      stable_prefix_tokens,
      dynamic_suffix_tokens: estimateQueryTokens(dynamic_suffix),
      session_payload_tokens,
      effective_prompt_tokens,
      reused_context_tokens: session_delta.reused_token_count,
    },
  }
}
