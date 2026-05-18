import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { generateGraph, type GenerateGraphOptions, type GenerateGraphResult } from '../generate.js'
import type { SpiCacheStats } from '../../pipeline/spi/cache.js'

export type GeneratePerformanceVariantName =
  | 'generate-legacy'
  | 'generate-spi-cold'
  | 'generate-spi-warm'
  | 'update-noop'
  | 'update-changed'
  | 'cluster-only'

export interface GeneratePerformanceVariantSummary {
  mode: GenerateGraphResult['mode']
  strategy: 'legacy' | 'spi'
  wall_clock_ms: number
  total_files: number
  code_files: number
  non_code_files: number
  extractable_files: number
  extracted_files: number
  changed_files: number
  deleted_files: number
  node_count: number
  edge_count: number
  output_size_bytes: number
  graph_size_bytes: number
  cache_hit: boolean | null
  cache_reason: SpiCacheStats['reason'] | null
  cache_file_count: number | null
  notes: string[]
}

export interface RunGeneratePerformanceBenchmarkOptions {
  fixtureRoot: string
  workDir: string
}

export interface GeneratePerformanceBenchmarkSummary {
  schema_version: 1
  fixture_path: string
  work_dir: string
  metrics_tracked: string[]
  variants: Record<GeneratePerformanceVariantName, GeneratePerformanceVariantSummary>
}

const CODE_MUTATION_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'])
const CODE_MUTATION_MARKERS: Record<string, string> = {
  '.ts': 'export const __graphifyBenchmarkTouch = true',
  '.tsx': 'export const __graphifyBenchmarkTouch = true',
  '.js': 'export const __graphifyBenchmarkTouch = true',
  '.jsx': 'export const __graphifyBenchmarkTouch = true',
  '.py': '# __graphifyBenchmarkTouch = True',
  '.go': '// __graphifyBenchmarkTouch = true',
  '.rs': '// __graphifyBenchmarkTouch = true',
  '.java': '// __graphifyBenchmarkTouch = true',
}
const METRICS_TRACKED = [
  'wall_clock_ms',
  'total_files',
  'code_files',
  'non_code_files',
  'extractable_files',
  'extracted_files',
  'changed_files',
  'deleted_files',
  'node_count',
  'edge_count',
  'cache_hit',
  'cache_reason',
  'cache_file_count',
  'graph_size_bytes',
  'output_size_bytes',
] as const

function ensureCleanDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
}

export function directorySize(path: string): number {
  if (!existsSync(path)) {
    return 0
  }
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) {
    return 0
  }
  if (!stats.isDirectory()) {
    return stats.size
  }

  return readdirSync(path).reduce((total, entry) => total + directorySize(join(path, entry)), 0)
}

function prepareWorkspace(fixtureRoot: string, workDir: string, name: string): string {
  const workspace = join(workDir, 'workspaces', name)
  ensureCleanDir(workspace)
  cpSync(fixtureRoot, workspace, { recursive: true })
  return workspace
}

function summarizeVariant(
  result: GenerateGraphResult,
  wallClockMs: number,
  strategy: 'legacy' | 'spi',
): GeneratePerformanceVariantSummary {
  const graphSizeBytes = existsSync(result.graphPath) ? statSync(result.graphPath).size : 0
  return {
    mode: result.mode,
    strategy,
    wall_clock_ms: wallClockMs,
    total_files: result.totalFiles,
    code_files: result.codeFiles,
    non_code_files: result.nonCodeFiles,
    extractable_files: result.extractableFiles,
    extracted_files: result.extractedFiles,
    changed_files: result.changedFiles,
    deleted_files: result.deletedFiles,
    node_count: result.nodeCount,
    edge_count: result.edgeCount,
    output_size_bytes: directorySize(result.outputDir),
    graph_size_bytes: graphSizeBytes,
    cache_hit: result.cache?.hit ?? null,
    cache_reason: result.cache?.reason ?? null,
    cache_file_count: result.cache?.fileCount ?? null,
    notes: result.notes,
  }
}

function runVariant(
  fixtureRoot: string,
  workDir: string,
  name: GeneratePerformanceVariantName,
  options: GenerateGraphOptions,
  strategy: 'legacy' | 'spi',
): GeneratePerformanceVariantSummary {
  const workspace = prepareWorkspace(fixtureRoot, workDir, name)
  const startedAt = Date.now()
  const result = generateGraph(workspace, options)
  const summary = summarizeVariant(result, Date.now() - startedAt, strategy)
  writeFileSync(join(workDir, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}

function appendMutation(root: string): void {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        if (entry.name === 'graphify-out') {
          continue
        }
        stack.push(path)
        continue
      }
      const extension = extname(entry.name).toLowerCase()
      if (CODE_MUTATION_EXTENSIONS.has(extension)) {
        const marker = CODE_MUTATION_MARKERS[extension]
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n${marker}\n`, 'utf8')
        return
      }
    }
  }

  throw new Error(`Unable to find a code file to mutate under ${root}`)
}

function runPreparedVariant(
  workspace: string,
  workDir: string,
  name: GeneratePerformanceVariantName,
  options: GenerateGraphOptions,
  strategy: 'legacy' | 'spi',
): GeneratePerformanceVariantSummary {
  const startedAt = Date.now()
  const result = generateGraph(workspace, options)
  const summary = summarizeVariant(result, Date.now() - startedAt, strategy)
  writeFileSync(join(workDir, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}

export function runGeneratePerformanceBenchmark(options: RunGeneratePerformanceBenchmarkOptions): GeneratePerformanceBenchmarkSummary {
  const fixtureRoot = resolve(options.fixtureRoot)
  const workDir = resolve(options.workDir)
  ensureCleanDir(workDir)
  mkdirSync(join(workDir, 'workspaces'), { recursive: true })

  const variants = {} as Record<GeneratePerformanceVariantName, GeneratePerformanceVariantSummary>
  variants['generate-legacy'] = runVariant(fixtureRoot, workDir, 'generate-legacy', { noHtml: true }, 'legacy')
  variants['generate-spi-cold'] = runVariant(fixtureRoot, workDir, 'generate-spi-cold', { useSpi: true, noHtml: true }, 'spi')

  const spiWarmWorkspace = prepareWorkspace(fixtureRoot, workDir, 'generate-spi-warm')
  generateGraph(spiWarmWorkspace, { useSpi: true, noHtml: true })
  variants['generate-spi-warm'] = runPreparedVariant(
    spiWarmWorkspace,
    workDir,
    'generate-spi-warm',
    { useSpi: true, noHtml: true },
    'spi',
  )

  const updateNoopWorkspace = prepareWorkspace(fixtureRoot, workDir, 'update-noop')
  generateGraph(updateNoopWorkspace, { noHtml: true })
  variants['update-noop'] = runPreparedVariant(updateNoopWorkspace, workDir, 'update-noop', { update: true, noHtml: true }, 'legacy')

  const updateChangedWorkspace = prepareWorkspace(fixtureRoot, workDir, 'update-changed')
  generateGraph(updateChangedWorkspace, { noHtml: true })
  appendMutation(updateChangedWorkspace)
  variants['update-changed'] = runPreparedVariant(
    updateChangedWorkspace,
    workDir,
    'update-changed',
    { update: true, noHtml: true },
    'legacy',
  )

  const clusterOnlyWorkspace = prepareWorkspace(fixtureRoot, workDir, 'cluster-only')
  generateGraph(clusterOnlyWorkspace, { noHtml: true })
  variants['cluster-only'] = runPreparedVariant(
    clusterOnlyWorkspace,
    workDir,
    'cluster-only',
    { clusterOnly: true, noHtml: true },
    'legacy',
  )

  const summary: GeneratePerformanceBenchmarkSummary = {
    schema_version: 1,
    fixture_path: fixtureRoot,
    work_dir: workDir,
    metrics_tracked: [...METRICS_TRACKED],
    variants,
  }

  writeFileSync(join(workDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}
