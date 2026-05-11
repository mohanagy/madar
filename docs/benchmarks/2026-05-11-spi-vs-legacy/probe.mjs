#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'

import { computeContextPackDiagnostics } from '../../../dist/src/runtime/context-pack-diagnostics.js'
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

  return {
    token_count: result.token_count,
    node_count: result.matched_nodes.length,
    labels: result.matched_nodes.map((node) => node.label),
    framework_roles: frameworkRoles,
    quality_score: diagnostics.quality_score,
    warnings: diagnostics.warnings.map((warning) => warning.kind),
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

  return {
    id: prompt.id,
    intent: prompt.intent,
    text: prompt.text,
    strategies: {
      evidence_order: summarizeRun(evidenceOrder),
      value_per_token: summarizeRun(valuePerToken),
    },
    deltas: {
      token_count: valuePerToken.token_count - evidenceOrder.token_count,
      node_count: valuePerToken.matched_nodes.length - evidenceOrder.matched_nodes.length,
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

console.log(JSON.stringify({
  graph_path: graphPathForOutput,
  budget,
  prompts: promptAnalyses,
}, null, 2))
