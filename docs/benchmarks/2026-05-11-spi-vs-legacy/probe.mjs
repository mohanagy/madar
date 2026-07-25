#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'

import { computeContextPackDiagnostics } from '../../../dist/src/runtime/context-pack-diagnostics.js'
import { estimateContextPackEntryTokens } from '../../../dist/src/runtime/context-pack.js'
import { applyContextPackResolution } from '../../../dist/src/runtime/context-pack-resolution.js'
import { classifyCalibrationBucket } from '../../../dist-eval/tools/eval/lib/runtime/benchmark/probe-calibration.js'
import { contextPackFromRetrieveResult, retrieveContext } from '../../../dist/src/runtime/retrieve.js'
import { loadGraph } from '../../../dist/src/runtime/serve.js'

const [graphPath, promptsPath] = process.argv.slice(2)

if (!graphPath || !promptsPath) {
  console.error('usage: probe.mjs <graph-path> <prompts.json>')
  process.exit(2)
}

const graph = loadGraph(graphPath)
const prompts = JSON.parse(readFileSync(promptsPath, 'utf8')).prompts
const budget = 2000
const retrievalLevels = [1, 2, 3, 4]
const graphPathForOutput = (() => {
  const normalized = relative(resolve(process.cwd()), resolve(graphPath))
  return normalized.length > 0 && !normalized.startsWith('..') ? normalized : basename(graphPath)
})()

function summarizeRun(result) {
  const pack = contextPackFromRetrieveResult(result)
  const diagnostics = computeContextPackDiagnostics(pack, { skipBudgetUnderutilization: true })
  const frameworkRoles = Array.from(
    new Set(
      result.matched_nodes
        .map((node) => node.framework_role)
        .filter((value) => typeof value === 'string' && value.length > 0),
      ),
  ).sort()
  const topFiles = Array.from(
    new Set(
      result.matched_nodes
        .map((node) => node.source_file)
        .filter((value) => typeof value === 'string' && value.length > 0),
    ),
  ).slice(0, 5)
  const resolvedSummaries = Object.fromEntries(
    ['detail', 'signature', 'sketch'].map((resolution) => {
      const resolved = resolution === 'detail'
        ? {
            nodes: pack.nodes,
            bytes_saved: 0,
          }
        : applyContextPackResolution(pack.nodes, {
            resolution,
            relationships: pack.relationships,
          })
      const tokenCount = resolved.nodes.reduce(
        (total, node) => total + estimateContextPackEntryTokens(node.label, node.source_file, node.line_number, node.snippet),
        0,
      )
      return [resolution, {
        token_count: tokenCount,
        bytes_saved: resolved.bytes_saved,
        representation_types: Array.from(new Set(resolved.nodes.map((node) => node.representation_type ?? 'detail'))).sort(),
      }]
    }),
  )

  return {
    token_count: result.token_count,
    node_count: result.matched_nodes.length,
    labels: result.matched_nodes.map((node) => node.label),
    top_files: topFiles,
    framework_roles: frameworkRoles,
    quality_score: diagnostics.quality_score,
    warnings: diagnostics.warnings.map((warning) => warning.kind),
    retrieval_gate: result.retrieval_gate ?? null,
    retrieval_strategy: result.retrieval_strategy ?? 'default',
    slice: result.slice ?? null,
    resolutions: resolvedSummaries,
    selection_strategy: result.selection_diagnostics?.selection_strategy,
    used_tokens: result.selection_diagnostics?.used_tokens ?? result.token_count,
    required_overflow: result.selection_diagnostics?.required_overflow ?? false,
    ranking: (result.selection_diagnostics?.ranking ?? [])
      .slice(0, 5)
      .map((entry) => ({
        label: entry.label,
        evidence_class: entry.evidence_class,
        included: entry.included,
        score: entry.score,
        token_cost: entry.token_cost,
        density: entry.density,
        reasons: entry.reasons,
        penalties: entry.penalties,
      })),
  }
}

const promptAnalyses = prompts.map((prompt) => {
  const evidenceOrder = retrieveContext(graph, {
    question: prompt.text,
    budget,
    selectionStrategy: 'evidence-order',
  })
  const valuePerToken = retrieveContext(graph, {
    question: prompt.text,
    budget,
    selectionStrategy: 'value-per-token',
  })
  const sliceV1 = retrieveContext(graph, {
    question: prompt.text,
    budget,
    selectionStrategy: 'value-per-token',
    retrievalStrategy: 'slice-v1',
  })

  return {
    id: prompt.id,
    intent: prompt.intent,
    text: prompt.text,
    strategies: {
      evidence_order: summarizeRun(evidenceOrder),
      value_per_token: summarizeRun(valuePerToken),
      slice_v1: summarizeRun(sliceV1),
    },
    deltas: {
      token_count: valuePerToken.token_count - evidenceOrder.token_count,
      node_count: valuePerToken.matched_nodes.length - evidenceOrder.matched_nodes.length,
      slice_token_count: sliceV1.token_count - valuePerToken.token_count,
      slice_node_count: sliceV1.matched_nodes.length - valuePerToken.matched_nodes.length,
    },
    retrieval_levels: retrievalLevels.map((level) => ({
      level,
      ...summarizeRun(retrieveContext(graph, {
        question: prompt.text,
        budget,
        retrievalLevel: level,
        selectionStrategy: 'value-per-token',
      })),
    })),
  }
})

const calibration = promptAnalyses.reduce((summary, prompt) => {
  const evidenceOrder = prompt.strategies.evidence_order
  const valuePerToken = prompt.strategies.value_per_token
  const tokenDelta = valuePerToken.token_count - evidenceOrder.token_count
  const qualityDelta = valuePerToken.quality_score - evidenceOrder.quality_score
  const labelDelta = valuePerToken.labels.filter((label) => !evidenceOrder.labels.includes(label))
  const note = {
    prompt: prompt.id,
    token_delta: tokenDelta,
    quality_delta: qualityDelta,
    added_labels: labelDelta,
  }

  switch (classifyCalibrationBucket({ tokenDelta, qualityDelta })) {
    case 'helps':
      summary.helps.push(note)
      break
    case 'hurts_or_expands':
      summary.hurts_or_expands.push(note)
      break
    default:
      summary.no_material_change.push(note)
      break
  }
  return summary
}, {
  helps: [],
  no_material_change: [],
  hurts_or_expands: [],
})

console.log(JSON.stringify({
  graph_path: graphPathForOutput,
  budget,
  prompts: promptAnalyses,
  calibration,
}, null, 2))
