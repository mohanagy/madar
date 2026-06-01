import { createHash } from 'node:crypto'

import type {
  ContextPackExpandableRef,
  ContextPackGovernanceReceipt,
  ContextPackGovernanceResolution,
  ContextPackGovernanceSurface,
  ContextPackRetrievalStrategy,
  ContextPackTaskKind,
} from '../contracts/context-pack.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'
import type { GraphFreshnessMetadata } from './freshness.js'
import type { MadarResponseEvidence } from './mcp-response-evidence.js'

const GOVERNANCE_HASH_LENGTH = 12

function hashGovernanceIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, GOVERNANCE_HASH_LENGTH)
}

function summarizeFollowUp(expandable: readonly ContextPackExpandableRef[]): ContextPackGovernanceReceipt['follow_up'] {
  const evidenceClasses = [...new Set(expandable.map((entry) => entry.evidence_class))]
  const expansionTaskKinds = [...new Set(expandable.map((entry) => entry.follow_up.task_kind))]

  return {
    expandable_handle_count: expandable.length,
    expandable_evidence_classes: evidenceClasses,
    expansion_task_kinds: expansionTaskKinds,
    preview_item_count: expandable.reduce((total, entry) => total + entry.preview.length, 0),
    focus_file_count: expandable.reduce((total, entry) => total + entry.follow_up.focus_files.length, 0),
    focus_range_count: expandable.reduce((total, entry) => total + entry.follow_up.focus_ranges.length, 0),
  }
}

export function buildContextPackGovernanceReceipt(input: {
  surface: ContextPackGovernanceSurface
  graphFreshness: GraphFreshnessMetadata
  task: ContextPackTaskKind
  taskIntent: TaskIntentKind
  budget: number
  evidence: Pick<MadarResponseEvidence, 'agent_directive' | 'coverage' | 'missing_phases' | 'pack_confidence'>
  expandable: readonly ContextPackExpandableRef[]
  retrievalStrategy?: ContextPackRetrievalStrategy
  resolution?: ContextPackGovernanceResolution
  mcpCall?: {
    cacheEligible: boolean
    cacheStatus: 'hit' | 'miss' | 'bypass'
    deltaSessionId?: string
  }
}): ContextPackGovernanceReceipt {
  return {
    version: 1,
    surface: input.surface,
    privacy_boundary: {
      source_safe: true,
      includes_prompt: false,
      includes_source_content: false,
      includes_answer_content: false,
      includes_file_paths: false,
    },
    graph_freshness: {
      graph_version: input.graphFreshness.graphVersion,
      graph_modified_ms: input.graphFreshness.graphModifiedMs,
      graph_modified_at: input.graphFreshness.graphModifiedAt,
    },
    request: {
      task: input.task,
      task_intent: input.taskIntent,
      budget: input.budget,
      ...(input.retrievalStrategy ? { retrieval_strategy: input.retrievalStrategy } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
    },
    directive: {
      pack_confidence: input.evidence.pack_confidence,
      coverage: input.evidence.coverage,
      agent_directive: input.evidence.agent_directive,
      missing_phases: [...input.evidence.missing_phases],
    },
    follow_up: summarizeFollowUp(input.expandable),
    ...(input.mcpCall
      ? {
          mcp_call: {
            tool_name: 'context_pack',
            cache_eligible: input.mcpCall.cacheEligible,
            cache_status: input.mcpCall.cacheStatus,
            ...(input.mcpCall.deltaSessionId ? { delta_session_hash: hashGovernanceIdentifier(input.mcpCall.deltaSessionId) } : {}),
          },
        }
      : {}),
  }
}

