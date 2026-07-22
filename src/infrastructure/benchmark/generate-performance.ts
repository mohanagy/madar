import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { generateIndex, type GenerateIndexOptions, type GenerateIndexResult } from '../../application/generate-index.js'
import { updateIndex } from '../../application/update-index.js'

export type GeneratePerformanceVariantName =
  | 'generate'
  | 'update-noop'
  | 'update-changed'
  | 'cluster-only'

export interface GeneratePerformanceVariantSummary {
  mode: GenerateIndexResult['mode']
  wall_clock_ms: number
  total_files: number
  code_files: number
  indexed_files: number
  unsupported_files: number
  node_count: number
  edge_count: number
  output_size_bytes: number
  graph_size_bytes: number
  notes: string[]
}

export interface RunGeneratePerformanceBenchmarkOptions {
  fixtureRoot: string
  workDir: string
}

export interface GeneratePerformanceBenchmarkSummary {
  schema_version: 2
  fixture_path: string
  work_dir: string
  metrics_tracked: string[]
  variants: Record<GeneratePerformanceVariantName, GeneratePerformanceVariantSummary>
}

const CODE_MUTATION_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const CODE_MUTATION_MARKERS: Record<string, string> = {
  '.ts': 'export const __madarBenchmarkTouch = true',
  '.tsx': 'export const __madarBenchmarkTouch = true',
  '.js': 'export const __madarBenchmarkTouch = true',
  '.jsx': 'export const __madarBenchmarkTouch = true',
}
const METRICS_TRACKED = [
  'wall_clock_ms',
  'total_files',
  'code_files',
  'indexed_files',
  'unsupported_files',
  'node_count',
  'edge_count',
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
  result: GenerateIndexResult,
  wallClockMs: number,
): GeneratePerformanceVariantSummary {
  const graphSizeBytes = existsSync(result.graphPath) ? statSync(result.graphPath).size : 0
  return {
    mode: result.mode,
    wall_clock_ms: wallClockMs,
    total_files: result.totalFiles,
    code_files: result.totalFiles,
    indexed_files: result.indexedFiles,
    unsupported_files: result.indexing?.counts.unsupported ?? 0,
    node_count: result.nodeCount,
    edge_count: result.edgeCount,
    output_size_bytes: directorySize(result.outputDir),
    graph_size_bytes: graphSizeBytes,
    notes: result.notes,
  }
}

function runVariant(
  fixtureRoot: string,
  workDir: string,
  name: GeneratePerformanceVariantName,
  options: GenerateIndexOptions & { update?: boolean },
): GeneratePerformanceVariantSummary {
  const workspace = prepareWorkspace(fixtureRoot, workDir, name)
  const startedAt = Date.now()
  const { update, ...indexOptions } = options
  const result = update ? updateIndex(workspace, indexOptions) : generateIndex(workspace, indexOptions)
  const summary = summarizeVariant(result, Date.now() - startedAt)
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
        if (entry.name === 'out') {
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
  options: GenerateIndexOptions & { update?: boolean },
): GeneratePerformanceVariantSummary {
  const startedAt = Date.now()
  const { update, ...indexOptions } = options
  const result = update ? updateIndex(workspace, indexOptions) : generateIndex(workspace, indexOptions)
  const summary = summarizeVariant(result, Date.now() - startedAt)
  writeFileSync(join(workDir, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}

export function runGeneratePerformanceBenchmark(options: RunGeneratePerformanceBenchmarkOptions): GeneratePerformanceBenchmarkSummary {
  const fixtureRoot = resolve(options.fixtureRoot)
  const workDir = resolve(options.workDir)
  ensureCleanDir(workDir)
  mkdirSync(join(workDir, 'workspaces'), { recursive: true })

  const variants = {} as Record<GeneratePerformanceVariantName, GeneratePerformanceVariantSummary>
  variants.generate = runVariant(fixtureRoot, workDir, 'generate', {})

  const updateNoopWorkspace = prepareWorkspace(fixtureRoot, workDir, 'update-noop')
  generateIndex(updateNoopWorkspace, {})
  variants['update-noop'] = runPreparedVariant(updateNoopWorkspace, workDir, 'update-noop', { update: true })

  const updateChangedWorkspace = prepareWorkspace(fixtureRoot, workDir, 'update-changed')
  generateIndex(updateChangedWorkspace, {})
  appendMutation(updateChangedWorkspace)
  variants['update-changed'] = runPreparedVariant(
    updateChangedWorkspace,
    workDir,
    'update-changed',
    { update: true },
  )

  const clusterOnlyWorkspace = prepareWorkspace(fixtureRoot, workDir, 'cluster-only')
  generateIndex(clusterOnlyWorkspace, {})
  variants['cluster-only'] = runPreparedVariant(
    clusterOnlyWorkspace,
    workDir,
    'cluster-only',
    { clusterOnly: true },
  )

  const summary: GeneratePerformanceBenchmarkSummary = {
    schema_version: 2,
    fixture_path: fixtureRoot,
    work_dir: workDir,
    metrics_tracked: [...METRICS_TRACKED],
    variants,
  }

  writeFileSync(join(workDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}
