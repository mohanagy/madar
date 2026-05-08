import { readFileSync, statSync } from 'node:fs'

import { godNodes, suggestQuestions } from '../../pipeline/analyze.js'
import { buildCommunityLabels } from '../../pipeline/community-naming.js'
import { MCP_PROMPTS, type McpPromptDefinition } from './definitions.js'
import { communitiesFromGraph, loadGraph } from '../serve.js'
import { validateGraphPath } from '../../shared/security.js'

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

interface PromptContext {
  graph: ReturnType<typeof loadGraph>
  communities: ReturnType<typeof communitiesFromGraph>
  communityLabels: Record<number, string>
  nodeCommunity: Record<string, number>
  topCommunities: Array<{ communityId: number; label: string; size: number }>
  topGodNodes: Array<{ label: string; edges: number }>
  suggestedQuestions: string[]
}

interface PromptHelpers {
  ok(id: string | number | null, result: unknown): StdioResponse
  failure(id: string | number | null, code: number, message: string): StdioResponse
  stringParam(params: unknown, key: string): string | null
  stringParamAlias(params: unknown, keys: readonly string[]): string | null
  integerLikeParamAlias(params: unknown, keys: readonly string[], options?: { min?: number; max?: number }): number | null
  recordParam(params: unknown, key: string): Record<string, unknown> | null
  jsonrpcInvalidParams: number
  maxStdioTextLength: number
  maxCompletionValues: number
}

const promptContextCache = new Map<string, { mtimeMs: number; context: PromptContext }>()

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function readStoredCommunityLabels(graphPath: string): Record<number, string> {
  const safeGraphPath = validateGraphPath(graphPath)

  try {
    const parsed = JSON.parse(readFileSync(safeGraphPath, 'utf8')) as { community_labels?: unknown }
    const rawLabels = parsed.community_labels
    if (!rawLabels || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) {
      return {}
    }

    const labels = new Map<number, string>()
    for (const [communityIdRaw, labelRaw] of Object.entries(rawLabels as Record<string, unknown>)) {
      const communityId = Number(communityIdRaw)
      const label = typeof labelRaw === 'string' ? labelRaw.trim() : ''
      if (Number.isInteger(communityId) && communityId >= 0 && label.length > 0) {
        labels.set(communityId, label)
      }
    }

    return Object.fromEntries(labels.entries())
  } catch {
    return {}
  }
}

function nodeCommunityMap(communities: ReturnType<typeof communitiesFromGraph>): Record<string, number> {
  const mapping: Record<string, number> = {}

  for (const [communityIdRaw, nodeIds] of Object.entries(communities)) {
    const communityId = Number(communityIdRaw)
    for (const nodeId of nodeIds) {
      mapping[nodeId] = communityId
    }
  }

  return mapping
}

function loadPromptContext(graphPath: string): PromptContext {
  const safeGraphPath = validateGraphPath(graphPath)
  const currentMtime = statSync(safeGraphPath).mtimeMs
  const cached = promptContextCache.get(safeGraphPath)
  if (cached && cached.mtimeMs === currentMtime) {
    return cached.context
  }

  const graph = loadGraph(safeGraphPath)
  const communities = communitiesFromGraph(graph)
  const storedLabels = readStoredCommunityLabels(safeGraphPath)
  const communityLabels = {
    ...buildCommunityLabels(graph, communities),
    ...storedLabels,
  }
  const topCommunities = Object.entries(communities)
    .map(([communityIdRaw, nodeIds]) => {
      const communityId = Number(communityIdRaw)
      return {
        communityId,
        label: communityLabels[communityId] ?? `Community ${communityId}`,
        size: nodeIds.length,
      }
    })
    .sort((left, right) => right.size - left.size || left.label.localeCompare(right.label))
    .slice(0, 3)

  const context: PromptContext = {
    graph,
    communities,
    communityLabels,
    nodeCommunity: nodeCommunityMap(communities),
    topCommunities,
    topGodNodes: godNodes(graph, 5).map((node) => ({ label: node.label, edges: node.edges })),
    suggestedQuestions: suggestQuestions(graph, communities, communityLabels, 3)
      .map((item) => item.question)
      .filter((question): question is string => Boolean(question)),
  }

  promptContextCache.set(safeGraphPath, { mtimeMs: currentMtime, context })
  return context
}

function formatTopCommunitySummary(context: PromptContext): string {
  if (context.topCommunities.length === 0) {
    return 'No named communities detected.'
  }

  return context.topCommunities.map((community) => `${community.label} (#${community.communityId}, ${formatCount(community.size, 'node')})`).join('; ')
}

function formatGodNodeSummary(context: PromptContext): string {
  if (context.topGodNodes.length === 0) {
    return 'No non-file god nodes detected.'
  }

  return context.topGodNodes.map((node) => `${node.label} (${node.edges} edges)`).join(', ')
}

function formatSuggestedQuestionLines(context: PromptContext): string {
  if (context.suggestedQuestions.length === 0) {
    return '- No high-signal graph questions detected.'
  }

  return context.suggestedQuestions.map((question) => `- ${question}`).join('\n')
}

function graphSnapshotLines(context: PromptContext): string[] {
  return [
    `Graph snapshot: ${formatCount(context.graph.numberOfNodes(), 'node')}, ${formatCount(context.graph.numberOfEdges(), 'edge')}, ${formatCount(Object.keys(context.communities).length, 'community')}.`,
    `Top communities: ${formatTopCommunitySummary(context)}`,
    `God nodes: ${formatGodNodeSummary(context)}`,
  ]
}

export function promptDefinitionsForGraph(graphPath: string): McpPromptDefinition[] {
  const context = loadPromptContext(graphPath)
  const exampleLabels = context.topGodNodes.slice(0, 3).map((node) => node.label)
  const exampleCommunities = context.topCommunities.slice(0, 2).map((community) => `${community.label} (#${community.communityId})`)

  return MCP_PROMPTS.map((prompt) => {
    switch (prompt.name) {
      case 'graph_query_prompt':
        return {
          ...prompt,
          description: `Ask a question using graph evidence only. Current graph: ${formatCount(context.graph.numberOfNodes(), 'node')} across ${formatCount(Object.keys(context.communities).length, 'community')}.`,
        }
      case 'graph_path_prompt':
        return {
          ...prompt,
          description: exampleLabels.length > 0 ? `Explain the shortest path between two graph concepts such as ${exampleLabels.join(', ')}.` : prompt.description,
        }
      case 'graph_explain_prompt':
        return {
          ...prompt,
          description: exampleLabels.length > 0 ? `Explain one node and its neighborhood. Try labels like ${exampleLabels.join(', ')}.` : prompt.description,
        }
      case 'graph_community_summary_prompt':
        return {
          ...prompt,
          description: exampleCommunities.length > 0 ? `Summarize a detected community such as ${exampleCommunities.join(' or ')}.` : prompt.description,
        }
      case 'context_pack_prompt':
        return {
          ...prompt,
          description: exampleCommunities.length > 0
            ? `Prepare a compact explain/review/impact pack for graph areas such as ${exampleCommunities.join(' or ')}.`
            : prompt.description,
        }
      case 'context_prompt_prompt':
        return {
          ...prompt,
          description: `Compile a provider-ready context prompt for this graph. Use claude for cache-aware follow-ups and gemini for plain prompt text.`,
        }
      case 'context_session_reset_prompt':
        return {
          ...prompt,
          description: 'Reset a stored context prompt session before switching topics or starting a fresh Claude thread.',
        }
      default:
        return prompt
    }
  })
}

function sanitizePromptValue(value: string | null, fallback: string): string {
  if (!value) {
    return fallback
  }

  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized.length > 0 ? sanitized : fallback
}

function communityMemberLabels(context: PromptContext, communityId: number): string[] {
  return [...(context.communities[communityId] ?? [])]
    .sort(
      (left, right) =>
        context.graph.degree(right) - context.graph.degree(left) ||
        String(context.graph.nodeAttributes(left).label ?? left).localeCompare(String(context.graph.nodeAttributes(right).label ?? right)),
    )
    .map((nodeId) => String(context.graph.nodeAttributes(nodeId).label ?? nodeId))
}

function communityBridgeLines(context: PromptContext, communityId: number): string[] {
  const nodeIds = context.communities[communityId] ?? []
  const nodeSet = new Set(nodeIds)
  const lines = new Set<string>()

  for (const nodeId of nodeIds) {
    for (const neighborId of context.graph.neighbors(nodeId)) {
      if (nodeSet.has(neighborId)) {
        continue
      }

      const sourceLabel = String(context.graph.nodeAttributes(nodeId).label ?? nodeId)
      const targetLabel = String(context.graph.nodeAttributes(neighborId).label ?? neighborId)
      const targetCommunityId = context.nodeCommunity[neighborId]
      const targetCommunityLabel =
        targetCommunityId === undefined ? 'outside named communities' : (context.communityLabels[targetCommunityId] ?? `Community ${targetCommunityId}`)
      lines.add(`${sourceLabel} -> ${targetLabel} (${targetCommunityLabel})`)
      if (lines.size >= 4) {
        return [...lines]
      }
    }
  }

  return [...lines]
}

export function handlePromptGet(id: string | number | null, graphPath: string, params: unknown, helpers: PromptHelpers): StdioResponse {
  const promptName = helpers.stringParam(params, 'name')
  if (!promptName) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `prompts/get requires a string name parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  const promptArguments = helpers.recordParam(params, 'arguments') ?? {}
  const context = loadPromptContext(graphPath)
  const snapshot = graphSnapshotLines(context).join('\n')
  const suggestedQuestionsText = formatSuggestedQuestionLines(context)

  switch (promptName) {
    case 'graph_query_prompt': {
      const question = sanitizePromptValue(helpers.stringParam(promptArguments, 'question'), '<question>')
      const mode = sanitizePromptValue(helpers.stringParam(promptArguments, 'mode'), 'bfs')
      return helpers.ok(id, {
        description: 'Ask and answer a question using graph evidence only.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${snapshot}\nSuggested follow-up questions:\n${suggestedQuestionsText}\n\nUse graph evidence only to answer this question: ${question}\nPreferred traversal mode: ${mode}. Cite the strongest nodes/edges you relied on and stay explicit about uncertainty.`,
            },
          },
        ],
      })
    }
    case 'graph_path_prompt': {
      const source = sanitizePromptValue(helpers.stringParam(promptArguments, 'source'), '<source>')
      const target = sanitizePromptValue(helpers.stringParam(promptArguments, 'target'), '<target>')
      return helpers.ok(id, {
        description: 'Explain the shortest path between two graph concepts.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${snapshot}\n\nFind the shortest path between ${source} and ${target}. Then explain each hop in plain language and call out the relation/confidence of each edge. Mention any community boundaries the path crosses.`,
            },
          },
        ],
      })
    }
    case 'graph_explain_prompt': {
      const label = sanitizePromptValue(helpers.stringParam(promptArguments, 'label'), '<label>')
      const relation = sanitizePromptValue(helpers.stringParam(promptArguments, 'relation'), '')
      return helpers.ok(id, {
        description: 'Explain a node and summarize its neighborhood.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${snapshot}\nSuggested follow-up questions:\n${suggestedQuestionsText}\n\nExplain the graph node ${label}${relation ? ` with neighbor relation filter ${relation}` : ''}. Summarize what it is, where it comes from, and why its neighborhood matters.`,
            },
          },
        ],
      })
    }
    case 'graph_community_summary_prompt': {
      const communityId = helpers.integerLikeParamAlias(promptArguments, ['community_id', 'communityId'], { min: 0 })
      if (communityId === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'graph_community_summary_prompt requires a numeric community_id parameter >= 0')
      }

      const members = communityMemberLabels(context, communityId)
      if (members.length === 0) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown community: ${communityId}`)
      }

      const communityLabel = context.communityLabels[communityId] ?? `Community ${communityId}`
      const bridges = communityBridgeLines(context, communityId)
      const relatedQuestions = context.suggestedQuestions.filter(
        (question) => question.includes(`\`${communityLabel}\``) || members.some((member) => question.includes(`\`${member}\``)),
      )

      return helpers.ok(id, {
        description: 'Summarize one community, its key nodes, and its boundaries.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                snapshot,
                `Community focus: ${communityLabel} (#${communityId}) with ${formatCount(members.length, 'node')}.`,
                `Key nodes: ${members.slice(0, 8).join(', ')}`,
                `Cross-community bridges: ${bridges.length > 0 ? bridges.join('; ') : 'No obvious cross-community bridges detected.'}`,
                'Related questions:',
                relatedQuestions.length > 0 ? relatedQuestions.map((question) => `- ${question}`).join('\n') : '- No community-specific follow-up questions detected.',
                '',
                `Summarize community #${communityId} (${communityLabel}) using graph evidence only. Explain its likely responsibility, the important files or concepts inside it, and the boundaries or bridges it has to the rest of the graph.`,
              ].join('\n'),
            },
          },
        ],
      })
    }
    case 'context_pack_prompt': {
      const prompt = sanitizePromptValue(helpers.stringParam(promptArguments, 'prompt'), '<prompt>')
      const task = sanitizePromptValue(helpers.stringParam(promptArguments, 'task'), 'explain')
      const budget = helpers.integerLikeParamAlias(promptArguments, ['budget'], { min: 1 })
      return helpers.ok(id, {
        description: 'Prepare a compact context pack with expandable refs and missing-context hints.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                snapshot,
                'Suggested follow-up questions:',
                suggestedQuestionsText,
                '',
                `Prepare a compact ${task} context pack for: ${prompt}.`,
                'Include coverage gaps, expandable references, and the minimum graph evidence a downstream agent needs to continue without re-scanning the repo.',
                budget === null ? '' : `Target pack budget: ${budget} tokens.`,
              ].filter((line) => line.length > 0).join('\n'),
            },
          },
        ],
      })
    }
    case 'context_prompt_prompt': {
      const prompt = sanitizePromptValue(helpers.stringParam(promptArguments, 'prompt'), '<prompt>')
      const provider = sanitizePromptValue(helpers.stringParam(promptArguments, 'provider'), 'claude')
      const sessionId = sanitizePromptValue(helpers.stringParamAlias(promptArguments, ['session_id', 'sessionId']), '')
      return helpers.ok(id, {
        description: 'Compile a provider-ready context prompt.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                snapshot,
                '',
                `Compile a ${provider} context prompt for: ${prompt}.`,
                provider === 'claude'
                  ? `Reuse session_id ${sessionId || '<session_id>'} when you want delta-only follow-up payloads and effective-token tracking.`
                  : 'Return a plain provider-agnostic prompt body with no session delta envelope.',
                'Keep the output compact and preserve any missing-context or expandable-reference hints that the retrieval surface emits.',
              ].join('\n'),
            },
          },
        ],
      })
    }
    case 'context_session_reset_prompt': {
      const sessionId = sanitizePromptValue(helpers.stringParamAlias(promptArguments, ['session_id', 'sessionId']), '<session_id>')
      return helpers.ok(id, {
        description: 'Reset a stored context prompt session.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Reset the stored context prompt session ${sessionId} before starting a fresh Claude thread or switching to a different task. Confirm that the next context_prompt call should resend the full stable context.`,
            },
          },
        ],
      })
    }
    default:
      return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown prompt: ${promptName}`)
  }
}

function completionValuesForPrefix(values: Iterable<string>, prefix: string, maxCompletionValues: number): string[] {
  const normalizedPrefix = prefix.trim().toLowerCase()
  const matches: string[] = []
  const seen = new Set<string>()
  const scanLimit = maxCompletionValues * 4

  for (const rawValue of values) {
    const value = rawValue.trim()
    if (!value) {
      continue
    }

    const normalizedValue = value.toLowerCase()
    if (seen.has(normalizedValue)) {
      continue
    }
    if (normalizedPrefix.length > 0 && !normalizedValue.startsWith(normalizedPrefix)) {
      continue
    }

    seen.add(normalizedValue)
    matches.push(value)
    if (matches.length >= scanLimit) {
      break
    }
  }

  return matches.sort((left, right) => left.localeCompare(right)).slice(0, maxCompletionValues)
}

function graphNodeLabels(graph: ReturnType<typeof loadGraph>): string[] {
  return graph
    .nodeEntries()
    .map(([, attributes]) => String(attributes.label ?? '').trim())
    .filter(Boolean)
}

function graphRelations(graph: ReturnType<typeof loadGraph>): string[] {
  return graph
    .edgeEntries()
    .map(([, , attributes]) => String(attributes.relation ?? '').trim())
    .filter(Boolean)
}

export function handleCompletion(id: string | number | null, graphPath: string, params: unknown, helpers: PromptHelpers): StdioResponse {
  const ref = helpers.recordParam(params, 'ref')
  const argument = helpers.recordParam(params, 'argument')
  if (!ref || !argument) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, 'completion/complete requires ref and argument objects')
  }

  const refType = helpers.stringParam(ref, 'type')
  const refName = helpers.stringParamAlias(ref, ['name', 'id'])
  const argumentName = helpers.stringParam(argument, 'name')
  const argumentValue = helpers.stringParam(argument, 'value') ?? ''
  if (!refType || !refName || !argumentName) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, 'completion/complete requires string ref.type, ref.name, and argument.name values')
  }
  if (refType !== 'ref/prompt' && refType !== 'prompt') {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unsupported completion ref type: ${refType}`)
  }

  const context = loadPromptContext(graphPath)
  const graph = context.graph
  let values: string[]
  switch (refName) {
    case 'graph_query_prompt':
      if (argumentName !== 'mode') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(['bfs', 'dfs'], argumentValue, helpers.maxCompletionValues)
      break
    case 'graph_path_prompt':
      if (argumentName !== 'source' && argumentName !== 'target') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(graphNodeLabels(graph), argumentValue, helpers.maxCompletionValues)
      break
    case 'graph_explain_prompt':
      if (argumentName === 'label') {
        values = completionValuesForPrefix(graphNodeLabels(graph), argumentValue, helpers.maxCompletionValues)
        break
      }
      if (argumentName === 'relation') {
        values = completionValuesForPrefix(graphRelations(graph), argumentValue, helpers.maxCompletionValues)
        break
      }
      return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unsupported completion argument for ${refName}: ${argumentName}`)
    case 'graph_community_summary_prompt':
      if (argumentName !== 'community_id') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(
        Object.keys(context.communities)
          .map(Number)
          .sort((left, right) => left - right)
          .map(String),
        argumentValue,
        helpers.maxCompletionValues,
      )
      break
    case 'context_pack_prompt':
      if (argumentName !== 'task') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(['explain', 'impact', 'review'], argumentValue, helpers.maxCompletionValues)
      break
    case 'context_prompt_prompt':
      if (argumentName !== 'provider') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unsupported completion argument for ${refName}: ${argumentName}`)
      }
      values = completionValuesForPrefix(['claude', 'gemini'], argumentValue, helpers.maxCompletionValues)
      break
    default:
      return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown completion reference: ${refName}`)
  }

  return helpers.ok(id, {
    completion: {
      values,
      total: values.length,
      hasMore: false,
    },
  })
}
