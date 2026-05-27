import { KnowledgeGraph } from '../contracts/graph.js'
import type {
  ContextPackClaim,
  ContextPackCoverage,
  ContextPackEvidenceClass,
  ContextPackExpandableRef,
} from '../contracts/context-pack.js'
import { featureMap, type FeatureMapOptions } from './feature-map.js'
import { riskMap } from './risk-map.js'

export interface ImplementationChecklistOptions extends FeatureMapOptions {}

export interface ImplementationChecklistEditStep {
  path: string
  action: string
  why: string
  matched_symbols: string[]
}

export interface ImplementationChecklistValidationStep {
  title: string
  why: string
  paths: string[]
  symbols: string[]
}

export interface ImplementationChecklistResult {
  question: string
  token_count: number
  summary: string
  edit_steps: ImplementationChecklistEditStep[]
  validation_steps: ImplementationChecklistValidationStep[]
  claims: ContextPackClaim[]
  expandable: ContextPackExpandableRef[]
  coverage?: ContextPackCoverage
  missing_context?: ContextPackEvidenceClass[]
}

function formatSymbolList(symbols: readonly string[]): string {
  if (symbols.length === 0) {
    return 'the matched code'
  }
  if (symbols.length === 1) {
    return symbols[0]!
  }
  if (symbols.length === 2) {
    return `${symbols[0]} and ${symbols[1]}`
  }
  return `${symbols[0]}, ${symbols[1]}, and ${symbols[2]}`
}

function actionForEditStep(entryPoints: readonly string[], riskLabels: readonly string[], matchedSymbols: readonly string[]): string {
  if (entryPoints.length > 0 && riskLabels.length > 0) {
    return `Update ${formatSymbolList(entryPoints)} and keep ${formatSymbolList(riskLabels)} aligned.`
  }
  if (entryPoints.length > 0) {
    return `Start by editing ${formatSymbolList(entryPoints)}.`
  }
  if (riskLabels.length > 0) {
    return `Align ${formatSymbolList(riskLabels)} with its dependent callers.`
  }
  return `Update ${formatSymbolList(matchedSymbols)} in this file.`
}

function whyForEditStep(entryPoints: readonly string[], riskLabels: readonly string[], directMatches: number): string {
  if (entryPoints.length > 0 && riskLabels.length > 0) {
    return 'This file is both a primary entry point and part of the highest-signal shared-risk path.'
  }
  if (entryPoints.length > 0) {
    return 'This file owns the primary entry point for the requested change.'
  }
  if (riskLabels.length > 0) {
    return 'This file contains shared logic that can affect multiple callers.'
  }
  if (directMatches > 0) {
    return 'This file contains direct feature matches that should stay aligned with the main flow.'
  }
  return 'This file provides supporting context for the requested change.'
}

export function implementationChecklist(graph: KnowledgeGraph, options: ImplementationChecklistOptions): ImplementationChecklistResult {
  const feature = featureMap(graph, options)
  const risk = riskMap(graph, options)
  const limit = options.limit ?? 5

  const edit_steps = feature.relevant_files
    .slice(0, limit)
    .map((file) => {
      const entryPoints = feature.entry_points
        .filter((entry) => entry.source_file === file.path)
        .map((entry) => entry.label)
      const riskLabels = risk.top_risks
        .filter((entry) => entry.affected_files.includes(file.path) || entry.label === file.matched_symbols[0] || file.matched_symbols.includes(entry.label))
        .map((entry) => entry.label)

      return {
        path: file.path,
        action: actionForEditStep(entryPoints, riskLabels, file.matched_symbols),
        why: whyForEditStep(entryPoints, riskLabels, file.direct_matches),
        matched_symbols: file.matched_symbols,
      }
    })

  const validation_steps: ImplementationChecklistValidationStep[] = []

  for (const entryPoint of feature.entry_points.slice(0, Math.max(1, limit - 1))) {
    validation_steps.push({
      title: `Validate entry point: ${entryPoint.label}`,
      why: 'Confirm the change still behaves from the primary feature entry point.',
      paths: [entryPoint.source_file],
      symbols: [entryPoint.label],
    })
  }

  for (const topRisk of risk.top_risks.slice(0, Math.max(1, limit - validation_steps.length))) {
    validation_steps.push({
      title: `Validate shared risk: ${topRisk.label}`,
      why: `Re-check the callers and affected communities touched by ${topRisk.label}.`,
      paths: topRisk.affected_files,
      symbols: [topRisk.label],
    })
  }

  const firstFile = edit_steps[0]?.path
  const summary = firstFile
    ? `Start in ${firstFile}, then walk the dependent files in order and validate the highest-signal entry point plus shared risks.`
    : 'No implementation checklist matches found.'

  return {
    question: options.question,
    token_count: Math.max(feature.token_count, risk.token_count),
    summary,
    edit_steps,
    validation_steps,
    claims: feature.claims,
    expandable: feature.expandable,
    ...(feature.coverage
      ? {
          coverage: feature.coverage,
          missing_context: feature.missing_context,
        }
      : {}),
  }
}
