import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import { retrieveContext } from '../../src/runtime/retrieve.js'
import { assessMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'
import { buildRetrievalEvidencePlanFromResult } from '../../src/runtime/retrieve/pipeline.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'
import {
  buildCrossLayerMonitorFlowFixture,
  CROSS_LAYER_MONITOR_FLOW_FILES,
} from '../fixtures/cross-layer-monitor-flow.js'

const QUESTION = 'Trace how a failed monitor check becomes an incident, triggers notifications, and affects the public status-page status in this repository. Cite the exact files and symbols involved, identify any inconsistent status-computation paths, and clearly state any remaining uncertainty.'

function writeCrossLayerGraphFixture(root: string): string {
  const graph = buildCrossLayerMonitorFlowFixture()
  const graphPath = join(root, 'graph.json')
  writeFileSync(graphPath, JSON.stringify({
    ...graph.graph,
    directed: graph.isDirected(),
    nodes: graph.nodeEntries().map(([id, attributes]) => ({ id, ...attributes })),
    edges: graph.edgeEntries().map(([source, target, attributes]) => ({ source, target, ...attributes })),
    hyperedges: [],
  }), 'utf8')
  return graphPath
}

describe('cross-layer flow retrieval', () => {
  it('covers every flow obligation without letting presentation vocabulary dominate', () => {
    const started = performance.now()
    const result = retrieveContext(buildCrossLayerMonitorFlowFixture(), {
      question: QUESTION,
      budget: 1_800,
      retrievalStrategy: 'slice-v1',
    })
    const elapsedMs = performance.now() - started
    const selectedFiles = new Set(result.matched_nodes.map((node) => node.source_file))
    const relevantSelected = [...selectedFiles].filter((file) => (
      CROSS_LAYER_MONITOR_FLOW_FILES.includes(file as typeof CROSS_LAYER_MONITOR_FLOW_FILES[number])
    ))
    const precision = relevantSelected.length / Math.max(selectedFiles.size, 1)
    const evidence = assessMadarResponseEvidence({
      evidencePlan: buildRetrievalEvidencePlanFromResult(result),
      question: QUESTION,
      recovery: result.recovery,
    })

    expect(
      CROSS_LAYER_MONITOR_FLOW_FILES.every((file) => selectedFiles.has(file)),
      JSON.stringify({
        selected: [...selectedFiles],
        labels: result.matched_nodes.map((node) => node.label),
        relationships: result.relationships,
        retrievalPlan: result.retrieval_plan,
        recovery: result.recovery,
      }, null, 2),
    ).toBe(true)
    expect(precision).toBeGreaterThanOrEqual(0.7)
    expect(result.relationships.length).toBeGreaterThanOrEqual(5)
    expect(result.retrieval_plan).toMatchObject({
      status: 'recovered',
      reasons: expect.arrayContaining(['missing_query_obligations']),
      query_obligations: {
        total: 5,
        initially_covered: 1,
        finally_covered: 5,
      },
      attempts: [expect.objectContaining({
        status: 'applied',
        promoted_communities: expect.arrayContaining([1, 2, 3, 4, 5, 6]),
      })],
    })
    expect(evidence.answerability.state).toMatch(/^ready(?:_with_caveat)?$/)
    expect(evidence.answerability.broad_search_fallback).toBe('not_needed')
    expect(evidence.agent_directive).toBe('answer_from_pack')
    expect(result.token_count).toBeLessThanOrEqual(1_800)
    expect(elapsedMs).toBeLessThan(750)
  })

  it('returns an answer-ready workflow through one context_pack MCP call', async () => {
    const fixtureParent = resolve('out', 'test-runtime')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'madar-cross-layer-mcp-'))
    const previousToolProfile = process.env.MADAR_TOOL_PROFILE
    try {
      process.env.MADAR_TOOL_PROFILE = 'strict'
      const response = await Promise.resolve(handleStdioRequest(writeCrossLayerGraphFixture(root), {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context_pack',
          arguments: {
            prompt: QUESTION,
            task: 'explain',
            budget: 1_800,
          },
        },
      }))
      expect((response as { error?: unknown }).error, JSON.stringify(response, null, 2)).toBeUndefined()

      const payload = JSON.parse(
        (response?.result as { content: Array<{ text: string }> }).content[0]!.text,
      ) as {
        pack?: {
          matched_nodes?: Array<{ source_file: string }>
          relationships?: unknown[]
        }
        evidence?: {
          answerability?: { state?: string; broad_search_fallback?: string }
          agent_directive?: string
        }
      }
      const selectedFiles = new Set(payload.pack?.matched_nodes?.map((node) => node.source_file) ?? [])
      const relevantSelected = [...selectedFiles].filter((file) => (
        CROSS_LAYER_MONITOR_FLOW_FILES.includes(file as typeof CROSS_LAYER_MONITOR_FLOW_FILES[number])
      ))
      const uiSelected = [...selectedFiles].filter((file) => file.includes('/components/status/'))

      expect(
        CROSS_LAYER_MONITOR_FLOW_FILES.every((file) => selectedFiles.has(file)),
        JSON.stringify(payload, null, 2),
      ).toBe(true)
      expect(relevantSelected.length / Math.max(selectedFiles.size, 1)).toBeGreaterThanOrEqual(0.7)
      expect(uiSelected.length).toBeLessThanOrEqual(2)
      expect(
        payload.pack?.relationships?.length ?? 0,
        JSON.stringify(payload, null, 2),
      ).toBeGreaterThanOrEqual(5)
      expect(payload.evidence).toMatchObject({
        answerability: {
          state: expect.stringMatching(/^ready(?:_with_caveat)?$/),
          broad_search_fallback: 'not_needed',
        },
        agent_directive: 'answer_from_pack',
      })
    } finally {
      if (previousToolProfile === undefined) {
        delete process.env.MADAR_TOOL_PROFILE
      } else {
        process.env.MADAR_TOOL_PROFILE = previousToolProfile
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
