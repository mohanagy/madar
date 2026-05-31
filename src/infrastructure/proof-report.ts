import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { buildGraphSummary } from '../runtime/graph-summary.js'
import { computeContextPackDiagnostics } from '../runtime/context-pack-diagnostics.js'
import { loadGraph } from '../runtime/serve.js'
import { validateGraphOutputPath } from '../shared/security.js'

import type { CompiledContextPack, ContextPackCoverage, ContextPackNode, ContextPackTaskKind } from '../contracts/context-pack.js'
import type { ContextPackDiagnostics } from '../contracts/context-pack-diagnostics.js'
import type { TaskIntentKind } from '../contracts/task-intent.js'

interface ProofReportCompareSummary {
  question: string
  reductionRatio: number | null
  effectiveReductionRatio: number | null
  totalReductionRatio: number | null
  baselineStatus: string
  madarStatus: string
  winner: string | null
}

interface ProofReportOptions {
  graphPath: string
  outputDir?: string
  compareDir?: string
  packPath?: string | null
}

export interface ProofReportResult {
  outputPath: string
  report: string
}

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON at ${path}: ${message}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function asTaskKind(value: unknown): ContextPackTaskKind | null {
  return value === 'explain' || value === 'implement' || value === 'review' || value === 'impact'
    ? value
    : null
}

function asCoverage(value: unknown): ContextPackCoverage | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }

  const requiredEvidence = asArray<string>(record.required_evidence)
  const semanticRequired = asArray<string>(record.semantic_required)
  const semanticOptional = asArray<string>(record.semantic_optional)
  const entries = asArray(record.entries)
  const semanticEntries = asArray(record.semantic_entries)
  const missingRequired = asArray<string>(record.missing_required)
  const missingSemantic = asArray<string>(record.missing_semantic)
  const availableRelationships = typeof record.available_relationships === 'number' ? record.available_relationships : 0
  const selectedRelationships = typeof record.selected_relationships === 'number' ? record.selected_relationships : 0

  return {
    required_evidence: requiredEvidence as ContextPackCoverage['required_evidence'],
    semantic_required: semanticRequired as ContextPackCoverage['semantic_required'],
    semantic_optional: semanticOptional as ContextPackCoverage['semantic_optional'],
    entries: entries as ContextPackCoverage['entries'],
    semantic_entries: semanticEntries as ContextPackCoverage['semantic_entries'],
    missing_required: missingRequired as ContextPackCoverage['missing_required'],
    missing_semantic: missingSemantic as ContextPackCoverage['missing_semantic'],
    available_relationships: availableRelationships,
    selected_relationships: selectedRelationships,
  }
}

function asDiagnostics(value: unknown): ContextPackDiagnostics | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  if (
    typeof record.quality_score !== 'number' ||
    !Array.isArray(record.warnings) ||
    !asRecord(record.signals)
  ) {
    return null
  }
  return record as unknown as ContextPackDiagnostics
}

function compiledPackFromSchema(
  schema: Record<string, unknown>,
  pack: Record<string, unknown>,
): CompiledContextPack | null {
  const taskKind = asTaskKind(schema.task)
  const coverage = asCoverage(schema.coverage)
  if (!taskKind || !coverage) {
    return null
  }

  const nodes = asArray<ContextPackNode>(pack.matched_nodes ?? pack.nodes)
  const relationships = asArray<CompiledContextPack['relationships'][number]>(pack.relationships)
  const communityContext = asArray<CompiledContextPack['community_context'][number]>(pack.community_context)
  const graphSignalsRecord = asRecord(pack.graph_signals)
  const graphSignals = graphSignalsRecord
    ? {
      god_nodes: asArray<string>(graphSignalsRecord.god_nodes),
      bridge_nodes: asArray<string>(graphSignalsRecord.bridge_nodes),
    }
    : { god_nodes: [], bridge_nodes: [] }
  const taskIntent = typeof schema.task_intent === 'string' ? schema.task_intent as TaskIntentKind : null
  const prompt = typeof schema.prompt === 'string' ? schema.prompt : null
  const taskContract: CompiledContextPack['task_contract'] = {
    version: 1,
    task_kind: taskKind,
    evidence_recipe_id: (taskIntent ?? taskKind) as TaskIntentKind,
    budget: typeof schema.budget === 'number' ? schema.budget : 0,
    required_evidence: coverage.required_evidence,
    preferred_evidence: [],
    semantic_required: coverage.semantic_required,
    semantic_optional: coverage.semantic_optional,
    ...(taskIntent ? { task_intent: taskIntent } : {}),
    ...(prompt ? { prompt } : {}),
  }

  const compiledPack: CompiledContextPack = {
    task_contract: taskContract,
    token_count: typeof pack.token_count === 'number' ? pack.token_count : 0,
    nodes,
    relationships,
    community_context: communityContext,
    claims: asArray(schema.claims) as CompiledContextPack['claims'],
    expandable: asArray(schema.expandable) as CompiledContextPack['expandable'],
    coverage,
    graph_signals: graphSignals,
  }
  if (typeof pack.shared_file_type === 'string') {
    compiledPack.shared_file_type = pack.shared_file_type
  }
  if (pack.selection_diagnostics !== undefined) {
    compiledPack.selection_diagnostics = pack.selection_diagnostics as NonNullable<CompiledContextPack['selection_diagnostics']>
  }
  if (typeof pack.retrieval_strategy === 'string') {
    compiledPack.retrieval_strategy = pack.retrieval_strategy as NonNullable<CompiledContextPack['retrieval_strategy']>
  }
  if (pack.slice !== undefined) {
    compiledPack.slice = pack.slice as NonNullable<CompiledContextPack['slice']>
  }
  if (pack.execution_slice !== undefined) {
    compiledPack.execution_slice = pack.execution_slice as NonNullable<CompiledContextPack['execution_slice']>
  }
  if (pack.answer_contract !== undefined) {
    compiledPack.answer_contract = pack.answer_contract as NonNullable<CompiledContextPack['answer_contract']>
  }
  if (pack.answer_ready !== undefined) {
    compiledPack.answer_ready = pack.answer_ready as NonNullable<CompiledContextPack['answer_ready']>
  }
  if (pack.retrieval_gate !== undefined) {
    compiledPack.retrieval_gate = pack.retrieval_gate as NonNullable<CompiledContextPack['retrieval_gate']>
  }
  return compiledPack
}

function relativeOutputBase(graphPath: string): string {
  return dirname(resolve(graphPath))
}

function graphCommandSuffix(graphPath: string): string {
  return resolve(graphPath) === resolve('out/graph.json') ? '' : ` --graph ${graphPath}`
}

function findFilesByName(rootDir: string, fileName: string): string[] {
  if (!existsSync(rootDir)) {
    return []
  }

  const entries = readdirSync(rootDir, { withFileTypes: true })
  const matches: string[] = []
  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      matches.push(...findFilesByName(entryPath, fileName))
      continue
    }
    if (entry.isFile() && entry.name === fileName) {
      matches.push(entryPath)
    }
  }
  return matches.sort((left, right) => left.localeCompare(right))
}

function readCompareSummaries(compareDir: string, graphBase: string): ProofReportCompareSummary[] {
  const safeCompareDir = validateGraphOutputPath(compareDir, graphBase)
  return findFilesByName(safeCompareDir, 'report.share-safe.json').map((reportPath) => {
    const parsed = readJsonFile(reportPath) as Record<string, unknown>
    const status = parsed.status && typeof parsed.status === 'object' && !Array.isArray(parsed.status)
      ? parsed.status as Record<string, unknown>
      : {}
    const providerProof = parsed.provider_proof && typeof parsed.provider_proof === 'object' && !Array.isArray(parsed.provider_proof)
      ? parsed.provider_proof as Record<string, unknown>
      : {}
    return {
      question: typeof parsed.question === 'string' ? parsed.question : '(unknown question)',
      reductionRatio: typeof parsed.reduction_ratio === 'number' ? parsed.reduction_ratio : null,
      effectiveReductionRatio: typeof parsed.effective_reduction_ratio === 'number' ? parsed.effective_reduction_ratio : null,
      totalReductionRatio: typeof parsed.total_reduction_ratio === 'number' ? parsed.total_reduction_ratio : null,
      baselineStatus: typeof status.baseline === 'string' ? status.baseline : 'unknown',
      madarStatus: typeof status.madar === 'string' ? status.madar : 'unknown',
      winner: typeof providerProof.winner === 'string' ? providerProof.winner : null,
    }
  })
}

function readPackDiagnostics(packPath: string | null | undefined, graphBase: string): ContextPackDiagnostics | null {
  if (!packPath) {
    return null
  }
  const safePackPath = validateGraphOutputPath(packPath, graphBase)
  if (!existsSync(safePackPath)) {
    return null
  }
  if (!statSync(safePackPath).isFile()) {
    throw new Error(`Pack report path is not a file: ${safePackPath}`)
  }
  const parsed = asRecord(readJsonFile(safePackPath))
  if (!parsed) {
    return null
  }
  const pack = asRecord(parsed.pack)
  if (!pack) {
    return null
  }

  const diagnostics = asDiagnostics(pack.diagnostics)
  if (diagnostics) {
    return diagnostics
  }

  const compiledPack = compiledPackFromSchema(parsed, pack)
  return compiledPack ? computeContextPackDiagnostics(compiledPack) : null
}

function formatRatio(label: string, value: number | null): string {
  if (value === null) {
    return `${label}: unavailable`
  }
  return `${label}: ${value.toFixed(2)}x`
}

function formatGraphQualitySection(graphPath: string): string[] {
  const summary = buildGraphSummary(loadGraph(graphPath))
  const lines = [
    '## Graph quality',
    '',
    `- Nodes: ${summary.node_count}`,
    `- Edges: ${summary.edge_count}`,
    `- Files: ${summary.file_count}`,
    `- Communities: ${summary.community_count}`,
  ]
  if (summary.frameworks.length > 0) {
    lines.push(`- Frameworks: ${summary.frameworks.join(', ')}`)
  }
  return lines
}

function formatWorkflowSection(graphPath: string): string[] {
  const summary = buildGraphSummary(loadGraph(graphPath))
  const lines = ['## Top workflows', '']
  if (summary.runtime_paths.length > 0) {
    for (const path of summary.runtime_paths.slice(0, 5)) {
      lines.push(`- ${path.from} -> ${path.to} (${path.hops} hops)`)
    }
    return lines
  }
  if (summary.entrypoints.length > 0) {
    for (const entry of summary.entrypoints.slice(0, 5)) {
      lines.push(`- ${entry.label} (${entry.source_file})`)
    }
    return lines
  }
  for (const module of summary.top_modules.slice(0, 5)) {
    lines.push(`- ${module.label} (degree ${module.degree})`)
  }
  return lines
}

function formatPackSection(
  diagnostics: ContextPackDiagnostics | null,
  graphPath: string,
  nextCommands: string[],
  limitations: string[],
): string[] {
  const lines = ['## Pack quality', '']
  if (!diagnostics) {
    lines.push('- No local context-pack diagnostics were provided.')
    limitations.push('Pack quality has not been measured locally yet.')
    nextCommands.push(`madar pack "<question>" --task explain${graphCommandSuffix(graphPath)} > out/proof-inputs/context-pack.json`)
    return lines
  }

  lines.push(`- Quality score: ${diagnostics.quality_score.toFixed(2)}`)
  lines.push(`- Claims: ${diagnostics.signals.claim_count}`)
  lines.push(`- Snippet coverage: ${(diagnostics.signals.snippet_coverage * 100).toFixed(0)}%`)
  lines.push(`- Budget utilization: ${(diagnostics.signals.budget_utilization * 100).toFixed(0)}%`)
  if (diagnostics.warnings.length === 0) {
    lines.push('- Warnings: none')
    return lines
  }

  lines.push('- Warnings:')
  for (const warning of diagnostics.warnings) {
    lines.push(`  - ${warning.message}`)
    limitations.push(warning.message)
  }
  return lines
}

function formatCompareSection(
  compareSummaries: readonly ProofReportCompareSummary[],
  graphPath: string,
  nextCommands: string[],
  limitations: string[],
): string[] {
  const lines = ['## Compare results', '']
  if (compareSummaries.length === 0) {
    lines.push('- No local compare receipts were found.')
    limitations.push('Compare evidence is missing for this repository snapshot.')
    nextCommands.push(`madar compare "<question>" --exec "<runner template>" --yes${graphCommandSuffix(graphPath)}`)
    return lines
  }

  for (const summary of compareSummaries) {
    lines.push(`### ${summary.question}`)
    lines.push(`- Baseline status: ${summary.baselineStatus}`)
    lines.push(`- Madar status: ${summary.madarStatus}`)
    lines.push(`- ${formatRatio('Reduction ratio', summary.reductionRatio)}`)
    lines.push(`- ${formatRatio('Effective reduction ratio', summary.effectiveReductionRatio)}`)
    lines.push(`- ${formatRatio('Total reduction ratio', summary.totalReductionRatio)}`)
    if (summary.winner) {
      lines.push(`- Winner: ${summary.winner}`)
    }
    lines.push('')
    if (summary.baselineStatus !== 'completed' || summary.madarStatus !== 'completed') {
      limitations.push(`Compare run for "${summary.question}" is incomplete.`)
    }
  }
  return lines
}

function uniqueOrdered(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export function runProofReportCommand(options: ProofReportOptions): ProofReportResult {
  const graphBase = relativeOutputBase(options.graphPath)
  const outputDir = validateGraphOutputPath(options.outputDir ?? join(graphBase, 'proof-report'), graphBase)
  const compareDir = options.compareDir ?? join(graphBase, 'compare')
  const compareSummaries = readCompareSummaries(compareDir, graphBase)
  const diagnostics = readPackDiagnostics(options.packPath ?? null, graphBase)
  const limitations: string[] = []
  const nextCommands: string[] = []
  const defaultCommands = [
    resolve(options.graphPath) === resolve('out/graph.json') ? 'madar summary out/graph.json' : `madar summary ${options.graphPath}`,
    resolve(options.graphPath) === resolve('out/graph.json') ? 'madar doctor out/graph.json' : `madar doctor ${options.graphPath}`,
  ]

  const report = [
    '# Local Proof Report',
    '',
    ...formatGraphQualitySection(options.graphPath),
    '',
    ...formatWorkflowSection(options.graphPath),
    '',
    ...formatPackSection(diagnostics, options.graphPath, nextCommands, limitations),
    '',
    ...formatCompareSection(compareSummaries, options.graphPath, nextCommands, limitations),
    '',
    '## Limitations',
    '',
    ...uniqueOrdered(limitations).map((line) => `- ${line}`),
    '',
    '## Next commands',
    '',
    ...uniqueOrdered([...nextCommands, ...defaultCommands]).map((line) => `- \`${line}\``),
    '',
  ].join('\n')

  mkdirSync(outputDir, { recursive: true })
  const outputPath = join(outputDir, 'proof-report.md')
  writeFileSync(outputPath, report, 'utf8')
  return { outputPath, report }
}
