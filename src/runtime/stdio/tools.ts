import { dirname } from 'node:path'

import { buildGraphifyPromptPack } from '../../infrastructure/compare.js'
import type { CompareRefsInput } from '../../infrastructure/time-travel.js'
import type { ContextPackClaim, ContextPackCoverage, ContextPackEvidenceClass, ContextPackExpandableRef } from '../../contracts/context-pack.js'
import type { ContextSessionState } from '../../contracts/context-session.js'
import { buildCommunityLabels } from '../../pipeline/community-naming.js'
import { communityDetailsAtZoom, communityDetailsMicro, type CommunityZoomLevel } from '../../pipeline/community-details.js'
import { validateGraphPath } from '../../shared/security.js'
import { featureMap } from '../feature-map.js'
import { implementationChecklist } from '../implementation-checklist.js'
import { analyzeImpact, callChains, compactImpactResult } from '../impact.js'
import { analyzePrImpact, compactPrImpactResult } from '../pr-impact.js'
import { relevantFiles } from '../relevant-files.js'
import { compactRetrieveResult, retrieveContext, retrieveContextAsync, type RetrieveResult } from '../retrieve.js'
import { riskMap } from '../risk-map.js'
import type { TimeTravelView } from '../time-travel.js'
import {
  communitiesFromGraph,
  getCommunity,
  getNeighbors,
  getNode,
  godNodesSummary,
  graphStats,
  queryGraph,
  semanticAnomaliesSummary,
  shortestPath,
} from '../serve.js'
import type { KnowledgeGraph } from '../../contracts/graph.js'

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

interface ToolHelpers {
  ok(id: string | number | null, result: unknown): StdioResponse
  failure(id: string | number | null, code: number, message: string): StdioResponse
  textToolResult(text: string): { content: Array<{ type: 'text'; text: string }> }
  stringParam(params: unknown, key: string): string | null
  stringParamAlias(params: unknown, keys: readonly string[]): string | null
  numberParamAlias(params: unknown, keys: readonly string[], options?: { min?: number; max?: number }): number | null
  recordParam(params: unknown, key: string): Record<string, unknown> | null
  loadGraphCached(graphPath: string): KnowledgeGraph
  queryOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; queryOptions?: Record<string, unknown> }
  handleGraphDiff(id: string | number | null, currentGraphPath: string, params: unknown): StdioResponse
  compareRefs(input: CompareRefsInput): Promise<unknown>
  getContextPromptSession(sessionId: string): ContextSessionState | undefined
  setContextPromptSession(sessionId: string, nextState: ContextSessionState): void
  clearContextPromptSession(sessionId: string): boolean
  readStoredCommunityLabels(graphPath: string): Record<number, string>
  jsonrpcInvalidParams: number
  jsonrpcServerError: number
  maxStdioTextLength: number
  maxStdioHops: number
  maxStdioTokenBudget: number
}

const TIME_TRAVEL_VIEWS = new Set<TimeTravelView>(['summary', 'risk', 'drift', 'timeline'])

interface ContextPlaneMetadata {
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage: ContextPackCoverage
  missing_context: ContextPackEvidenceClass[]
}

function emptyCoverage(): ContextPackCoverage {
  return {
    required_evidence: [],
    entries: [],
    missing_required: [],
    available_relationships: 0,
    selected_relationships: 0,
  }
}

function contextMetadata(
  payload: Partial<{
    claims: ContextPackClaim[]
    expandable: ContextPackExpandableRef[]
    coverage: ContextPackCoverage
  }>,
): ContextPlaneMetadata {
  const coverage = payload.coverage ?? emptyCoverage()
  return {
    claims: payload.claims ?? [],
    expandable: payload.expandable ?? [],
    coverage,
    missing_context: coverage.missing_required,
  }
}

function parseContextSessionState(raw: unknown): ContextSessionState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const record = raw as Record<string, unknown>
  if (record.version !== 1 || typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 0) {
    return null
  }
  if (!record.refs || typeof record.refs !== 'object' || Array.isArray(record.refs)) {
    return null
  }

  const refs: ContextSessionState['refs'] = {}
  for (const [ref, value] of Object.entries(record.refs as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const stored = value as Record<string, unknown>
    if (typeof stored.hash !== 'string' || typeof stored.token_count !== 'number' || !Number.isFinite(stored.token_count)) {
      return null
    }
    refs[ref] = {
      hash: stored.hash,
      token_count: stored.token_count,
    }
  }

  return {
    version: 1,
    revision: record.revision,
    refs,
  }
}

function pickImpactTarget(result: RetrieveResult): string {
  const directMatch = result.matched_nodes.find((node) => node.relevance_band === 'direct' && node.label.trim().length > 0)
  if (directMatch) {
    return directMatch.label
  }

  const bestMatch = [...result.matched_nodes]
    .sort((left, right) => (right.match_score ?? 0) - (left.match_score ?? 0))
    .find((node) => node.label.trim().length > 0)

  return bestMatch?.label ?? result.question
}

export function handleToolCall(id: string | number | null, graphPath: string, params: unknown, helpers: ToolHelpers): StdioResponse | Promise<StdioResponse> {
  const toolName = helpers.stringParam(params, 'name')
  if (!toolName) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `tools/call requires a string name parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  const toolArguments = helpers.recordParam(params, 'arguments') ?? {}
  const graph = helpers.loadGraphCached(graphPath)

  switch (toolName) {
    case 'query_graph': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `query_graph requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const { failureResponse, queryOptions } = helpers.queryOptionsFromParams(id, toolArguments)
      if (failureResponse) {
        return failureResponse
      }

      return helpers.ok(id, helpers.textToolResult(queryGraph(graph, question, queryOptions)))
    }
    case 'get_node': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `get_node requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(getNode(graph, label)))
    }
    case 'graph_diff': {
      const diffResponse = helpers.handleGraphDiff(id, graphPath, toolArguments)
      return 'error' in diffResponse && diffResponse.error ? diffResponse : helpers.ok(id, helpers.textToolResult(String(diffResponse.result ?? '')))
    }
    case 'semantic_anomalies':
      return helpers.ok(id, helpers.textToolResult(semanticAnomaliesSummary(graphPath, helpers.numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 5)))
    case 'get_neighbors': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `get_neighbors requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(getNeighbors(graph, label, helpers.stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? '')))
    }
    case 'shortest_path': {
      const source = helpers.stringParam(toolArguments, 'source')
      const target = helpers.stringParam(toolArguments, 'target')
      if (!source || !target) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `shortest_path requires string source and target parameters <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(shortestPath(graph, source, target, helpers.numberParamAlias(toolArguments, ['max_hops', 'maxHops'], { min: 1, max: helpers.maxStdioHops }) ?? 8)))
    }
    case 'explain_node': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `explain_node requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const relation = helpers.stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? ''
      return helpers.ok(id, helpers.textToolResult(`${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`))
    }
    case 'graph_stats':
      return helpers.ok(id, helpers.textToolResult(graphStats(graph)))
    case 'god_nodes':
      return helpers.ok(id, helpers.textToolResult(godNodesSummary(graph, helpers.numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 10)))
    case 'get_community': {
      const communityId = helpers.numberParamAlias(toolArguments, ['community_id', 'communityId'], { min: 0 })
      if (communityId === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'get_community requires a numeric community_id parameter >= 0')
      }
      return helpers.ok(id, helpers.textToolResult(getCommunity(graph, communitiesFromGraph(graph), communityId)))
    }
    case 'community_details': {
      const detailCommunityId = helpers.numberParamAlias(toolArguments, ['community_id', 'communityId'], { min: 0 })
      if (detailCommunityId === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'community_details requires a numeric community_id parameter >= 0')
      }
      const zoomRaw = helpers.stringParam(toolArguments, 'zoom') ?? 'mid'
      const zoom: CommunityZoomLevel = zoomRaw === 'micro' || zoomRaw === 'mid' || zoomRaw === 'macro' ? zoomRaw : 'mid'
      const detailCommunities = communitiesFromGraph(graph)
      const detailLabels = { ...buildCommunityLabels(graph, detailCommunities), ...helpers.readStoredCommunityLabels(graphPath) }
      const details = communityDetailsAtZoom(graph, detailCommunities, detailLabels, detailCommunityId, zoom)
      if (!details) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown community: ${detailCommunityId}`)
      }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(details)))
    }
    case 'community_overview': {
      const overviewCommunities = communitiesFromGraph(graph)
      const overviewLabels = { ...buildCommunityLabels(graph, overviewCommunities), ...helpers.readStoredCommunityLabels(graphPath) }
      const overview = communityDetailsMicro(graph, overviewCommunities, overviewLabels)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(overview)))
    }
    case 'impact': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `impact requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      if (Object.hasOwn(toolArguments, 'compact') && typeof toolArguments.compact !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'compact must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'verbose') && typeof toolArguments.verbose !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'verbose must be a boolean')
      }
      const impactDepth = helpers.numberParamAlias(toolArguments, ['depth'], { min: 1, max: 5 })
      const rawEdgeTypes = toolArguments.edge_types
      const edgeTypes = Array.isArray(rawEdgeTypes) ? rawEdgeTypes.filter((t): t is string => typeof t === 'string') : undefined
      const communityLabels = helpers.readStoredCommunityLabels(graphPath)
      const impactResult = analyzeImpact(graph, communityLabels, {
        label,
        ...(impactDepth !== null ? { depth: impactDepth } : {}),
        ...(edgeTypes && edgeTypes.length > 0 ? { edgeTypes } : {}),
      })
      const useVerboseImpact = toolArguments.verbose === true || toolArguments.compact === false
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(
        useVerboseImpact
          ? impactResult
          : {
              ...compactImpactResult(impactResult),
              missing_context: [],
            },
      )))
    }
    case 'call_chain': {
      const chainSource = helpers.stringParam(toolArguments, 'source')
      const chainTarget = helpers.stringParam(toolArguments, 'target')
      if (!chainSource || !chainTarget) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `call_chain requires string source and target parameters <= ${helpers.maxStdioTextLength} characters`)
      }
      const chainMaxHops = helpers.numberParamAlias(toolArguments, ['max_hops', 'maxHops'], { min: 1, max: helpers.maxStdioHops })
      const rawChainEdgeTypes = toolArguments.edge_types
      const chainEdgeTypes = Array.isArray(rawChainEdgeTypes) ? rawChainEdgeTypes.filter((t): t is string => typeof t === 'string') : undefined
      const chains = callChains(graph, chainSource, chainTarget, chainMaxHops ?? 8, chainEdgeTypes)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({ source: chainSource, target: chainTarget, chains, total: chains.length })))
    }
    case 'pr_impact': {
      if (Object.hasOwn(toolArguments, 'compact') && typeof toolArguments.compact !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'compact must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'verbose') && typeof toolArguments.verbose !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'verbose must be a boolean')
      }
      const prBaseBranch = helpers.stringParamAlias(toolArguments, ['base_branch', 'baseBranch'])
      const prDepth = helpers.numberParamAlias(toolArguments, ['depth'], { min: 1, max: 5 })
      const prBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && prBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const graphDir = dirname(validateGraphPath(graphPath))
      const projectRoot = dirname(graphDir)
      const prResult = analyzePrImpact(graph, projectRoot, {
        ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
        ...(prDepth !== null ? { depth: prDepth } : {}),
        ...(prBudget !== null ? { budget: prBudget } : {}),
      })
      const useVerbosePrImpact = toolArguments.verbose === true || toolArguments.compact === false
      if (useVerbosePrImpact) {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(prResult)))
      }
      const compactPrImpact = compactPrImpactResult(prResult)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        ...compactPrImpact,
        missing_context: (prResult.review_bundle.coverage ?? emptyCoverage()).missing_required,
      })))
    }
    case 'retrieve': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `retrieve requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      if (Object.hasOwn(toolArguments, 'compact') && typeof toolArguments.compact !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'compact must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'verbose') && typeof toolArguments.verbose !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'verbose must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'semantic') && typeof toolArguments.semantic !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'semantic must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'rerank') && typeof toolArguments.rerank !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'rerank must be a boolean')
      }
      const retrieveBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (retrieveBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `retrieve requires a numeric budget parameter between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const retrieveCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const retrieveFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const retrieveSemantic = toolArguments.semantic === true
      const retrieveRerank = toolArguments.rerank === true
      const retrieveSemanticModel = helpers.stringParamAlias(toolArguments, ['semantic_model', 'semanticModel'])
      const retrieveRerankModel = helpers.stringParamAlias(toolArguments, ['rerank_model', 'rerankModel'])
      const retrieval = retrieveSemantic || retrieveRerank ? retrieveContextAsync(graph, {
        question,
        budget: retrieveBudget,
        ...(retrieveCommunity !== null ? { community: retrieveCommunity } : {}),
        ...(retrieveFileType ? { fileType: retrieveFileType } : {}),
        ...(retrieveSemantic ? { semantic: true } : {}),
        ...(retrieveSemanticModel ? { semanticModel: retrieveSemanticModel } : {}),
        ...(retrieveRerank ? { rerank: true } : {}),
        ...(retrieveRerankModel ? { rerankerModel: retrieveRerankModel } : {}),
      }) : Promise.resolve(retrieveContext(graph, {
        question,
        budget: retrieveBudget,
        ...(retrieveCommunity !== null ? { community: retrieveCommunity } : {}),
          ...(retrieveFileType ? { fileType: retrieveFileType } : {}),
        }))
      const useVerboseRetrieve = toolArguments.verbose === true || toolArguments.compact === false
      return retrieval.then((result) => helpers.ok(id, helpers.textToolResult(JSON.stringify(
        useVerboseRetrieve
          ? result
          : {
              ...compactRetrieveResult(result),
              ...contextMetadata(result),
            },
      ))))
    }
    case 'context_pack': {
      const prompt = helpers.stringParam(toolArguments, 'prompt')
      if (!prompt) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_pack requires a string prompt parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const task = helpers.stringParam(toolArguments, 'task') ?? 'explain'
      if (task !== 'explain' && task !== 'review' && task !== 'impact') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'task must be one of explain, review, impact')
      }
      const budget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && budget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const resolvedBudget = budget ?? 3000

      if (task === 'review') {
        const graphDir = dirname(validateGraphPath(graphPath))
        const projectRoot = dirname(graphDir)
        const prResult = analyzePrImpact(graph, projectRoot, { budget: resolvedBudget })
        const compactPack = compactPrImpactResult(prResult)
        const reviewMetadata = contextMetadata(prResult.review_bundle)
        return helpers.ok(id, helpers.textToolResult(JSON.stringify({
          task,
          prompt,
          budget: resolvedBudget,
          graph_path: graphPath,
          pack: compactPack,
          ...reviewMetadata,
        })))
      }

      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: resolvedBudget,
      })

      if (task === 'impact') {
        const communityLabels = {
          ...buildCommunityLabels(graph, communitiesFromGraph(graph)),
          ...helpers.readStoredCommunityLabels(graphPath),
        }
        const impactTarget = pickImpactTarget(retrieval)
        const impactPack = compactImpactResult(analyzeImpact(graph, communityLabels, {
          label: impactTarget,
          depth: 3,
        }))
        return helpers.ok(id, helpers.textToolResult(JSON.stringify({
          task,
          prompt,
          budget: resolvedBudget,
          graph_path: graphPath,
          target: impactTarget,
          pack: impactPack,
          ...contextMetadata(retrieval),
        })))
      }

      const compactPack = compactRetrieveResult(retrieval)
      const { claims, expandable, coverage, missing_context } = contextMetadata(retrieval)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        task,
        prompt,
        budget: resolvedBudget,
        graph_path: graphPath,
        pack: compactPack,
        claims,
        expandable,
        coverage,
        missing_context,
      })))
    }
    case 'context_prompt': {
      const prompt = helpers.stringParam(toolArguments, 'prompt')
      if (!prompt) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_prompt requires a string prompt parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const provider = helpers.stringParam(toolArguments, 'provider')
      if (provider !== 'claude' && provider !== 'gemini') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'provider must be one of claude, gemini')
      }
      const budget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && budget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const sessionId = helpers.stringParamAlias(toolArguments, ['session_id', 'sessionId'])
      const explicitSessionStateRaw = toolArguments.session_state ?? toolArguments.sessionState
      const explicitSessionState = explicitSessionStateRaw === undefined ? undefined : parseContextSessionState(explicitSessionStateRaw)
      if (explicitSessionStateRaw !== undefined && explicitSessionState === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'session_state must be a valid context session payload')
      }
      if (Object.hasOwn(toolArguments, 'reset_session') && typeof toolArguments.reset_session !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'reset_session must be a boolean')
      }
      if (Object.hasOwn(toolArguments, 'resetSession') && typeof toolArguments.resetSession !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'resetSession must be a boolean')
      }
      const resetSession = toolArguments.reset_session === true || toolArguments.resetSession === true
      if (resetSession && sessionId) {
        helpers.clearContextPromptSession(sessionId)
      }

      const retrieval = retrieveContext(graph, {
        question: prompt,
        budget: budget ?? 3000,
      })
      const previousSession =
        explicitSessionState
        ?? (sessionId ? helpers.getContextPromptSession(sessionId) : undefined)
      const promptPack = buildGraphifyPromptPack({
        question: prompt,
        retrieval,
        ...(provider === 'claude' && previousSession ? { session: previousSession } : {}),
      })
      if (provider === 'claude' && sessionId) {
        helpers.setContextPromptSession(sessionId, promptPack.session_state)
      }

      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        provider,
        task: 'explain',
        prompt,
        graph_path: graphPath,
        compiled: provider === 'claude'
          ? {
              provider,
              format: 'session_payload',
              prompt: promptPack.session_payload,
              token_count: promptPack.session_payload_token_count,
              effective_token_count: promptPack.effective_token_count,
              reused_context_tokens: promptPack.reused_context_tokens,
              session_state: promptPack.session_state,
              ...(sessionId ? { session_id: sessionId } : {}),
            }
          : {
              provider,
              format: 'prompt',
              prompt: promptPack.prompt,
              token_count: promptPack.token_count,
            },
        ...contextMetadata(retrieval),
      })))
    }
    case 'context_session_reset': {
      const sessionId = helpers.stringParamAlias(toolArguments, ['session_id', 'sessionId'])
      if (!sessionId) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `context_session_reset requires a string session_id parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({
        session_id: sessionId,
        cleared: helpers.clearContextPromptSession(sessionId),
      })))
    }
    case 'relevant_files': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `relevant_files requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const relevantBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && relevantBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const relevantLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && relevantLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const relevantCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const relevantFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = relevantFiles(graph, {
        question,
        budget: relevantBudget ?? 4000,
        ...(relevantLimit !== null ? { limit: relevantLimit } : {}),
        ...(relevantCommunity !== null ? { community: relevantCommunity } : {}),
        ...(relevantFileType ? { fileType: relevantFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'feature_map': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `feature_map requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const featureBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && featureBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const featureLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && featureLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const featureCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const featureFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = featureMap(graph, {
        question,
        budget: featureBudget ?? 4000,
        ...(featureLimit !== null ? { limit: featureLimit } : {}),
        ...(featureCommunity !== null ? { community: featureCommunity } : {}),
        ...(featureFileType ? { fileType: featureFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'risk_map': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `risk_map requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const riskBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && riskBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const riskLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && riskLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const riskCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const riskFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = riskMap(graph, {
        question,
        budget: riskBudget ?? 4000,
        ...(riskLimit !== null ? { limit: riskLimit } : {}),
        ...(riskCommunity !== null ? { community: riskCommunity } : {}),
        ...(riskFileType ? { fileType: riskFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'implementation_checklist': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `implementation_checklist requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const checklistBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (Object.hasOwn(toolArguments, 'budget') && checklistBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `budget must be a number between 1 and ${helpers.maxStdioTokenBudget}`)
      }

      const checklistLimit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 1, max: 50 })
      if (Object.hasOwn(toolArguments, 'limit') && checklistLimit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 1 and 50')
      }

      const checklistCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const checklistFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = implementationChecklist(graph, {
        question,
        budget: checklistBudget ?? 4000,
        ...(checklistLimit !== null ? { limit: checklistLimit } : {}),
        ...(checklistCommunity !== null ? { community: checklistCommunity } : {}),
        ...(checklistFileType ? { fileType: checklistFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
    }
    case 'time_travel_compare': {
      const fromRef = helpers.stringParamAlias(toolArguments, ['from_ref', 'fromRef'])
      const toRef = helpers.stringParamAlias(toolArguments, ['to_ref', 'toRef'])
      if (!fromRef || !toRef) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `time_travel_compare requires string from_ref and to_ref parameters <= ${helpers.maxStdioTextLength} characters`)
      }

      const rawView = helpers.stringParam(toolArguments, 'view')
      if (Object.hasOwn(toolArguments, 'view') && (!rawView || !TIME_TRAVEL_VIEWS.has(rawView as TimeTravelView))) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'view must be one of summary, risk, drift, timeline')
      }

      const limit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 0, max: 100 })
      if (Object.hasOwn(toolArguments, 'limit') && limit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 0 and 100')
      }

      const refresh = toolArguments.refresh
      if (Object.hasOwn(toolArguments, 'refresh') && typeof refresh !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'refresh must be a boolean')
      }

      return helpers.compareRefs({
        fromRef,
        toRef,
        ...(rawView ? { view: rawView as TimeTravelView } : {}),
        ...(typeof refresh === 'boolean' ? { refresh } : {}),
        ...(limit !== null ? { limit } : {}),
      }).then((result) => {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
      }).catch((error: unknown) => {
        return helpers.failure(id, helpers.jsonrpcServerError, error instanceof Error ? error.message : 'Time travel comparison failed')
      })
    }
    default:
      return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown tool: ${toolName}`)
  }
}
