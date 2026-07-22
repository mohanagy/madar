import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { GenerateUnsupportedCorpusError } from '../../src/infrastructure/generate.js'
import type { GraphContextFreshness, GraphContextFreshnessStatus } from '../../src/runtime/freshness.js'
import type { GraphSummary } from '../../src/runtime/graph-summary.js'
import { runTryCommand, type TryCommandDependencies } from '../../src/infrastructure/try-command.js'

function createIo() {
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    io: {
      log(message?: string) {
        logs.push(String(message ?? ''))
      },
      error(message?: string) {
        errors.push(String(message ?? ''))
      },
    },
  }
}

function createGraphSummary(nodeCount: number): GraphSummary {
  return {
    node_count: nodeCount,
    edge_count: Math.max(nodeCount - 1, 0),
    file_count: Math.max(nodeCount, 1),
    community_count: Math.max(Math.min(nodeCount, 3), 1),
    source_domains: { production: Math.max(nodeCount, 1) },
    frameworks: [],
    top_modules: [],
    entrypoints: [],
    runtime_paths: [],
  }
}

function createFreshness(status: GraphContextFreshnessStatus, graphPath: string): GraphContextFreshness {
  return {
    status,
    graph_path: graphPath,
    graph_version: 'graph-version',
    graph_modified_ms: 1,
    graph_modified_at: '2026-06-01T00:00:00.000Z',
    generated_ms: 1,
    generated_at: '2026-06-01T00:00:00.000Z',
    madar_version: '0.27.9-next.0',
    indexed_file_count: 12,
    changed_source_count: status === 'fresh' ? 0 : 2,
    missing_source_count: 0,
    selected_context_status: status === 'fresh' || status === 'partially_stale' ? 'fresh' : 'possibly_stale',
    selected_context_file_count: 3,
    changed_selected_context_count: status === 'fresh' ? 0 : 1,
    missing_selected_context_count: 0,
    changed_outside_selected_context_count: status === 'fresh' ? 0 : 1,
    recommendation: 'Run `madar generate .`.',
  }
}

function createDependencies(overrides: Partial<TryCommandDependencies> = {}): TryCommandDependencies {
  return {
    generateGraph: vi.fn().mockImplementation((rootPath = '.') => ({
      mode: 'generate',
      rootPath: resolve(rootPath),
      outputDir: resolve(rootPath, 'out'),
      graphPath: resolve(rootPath, 'out', 'graph.json'),
      reportPath: resolve(rootPath, 'out', 'GRAPH_REPORT.md'),
      totalFiles: 12,
      codeFiles: 12,
      indexedFiles: 12,
      totalWords: 1000,
      nodeCount: 12,
      edgeCount: 11,
      communityCount: 3,
      semanticAnomalyCount: 0,
      warning: null,
      notes: [],
      discoverySafety: { version: 1, summary: { total: 0, sensitive: 0, unreadable: 0, reasons: {} }, exclusions: [] },
      discoveryExclusions: [],
      indexingManifestPath: resolve(rootPath, 'out', 'indexing-manifest.json'),
      indexingShareSafeManifestPath: resolve(rootPath, 'out', 'indexing-manifest.share-safe.json'),
      indexing: {
        state: 'complete', candidates: 12,
        counts: { indexed: 12, indexed_with_warnings: 0, skipped_by_policy: 0, unsupported: 0, failed: 0 },
        reason_buckets: { indexed: 12 }, capability_buckets: { 'builtin:index:typescript': 12 },
      },
    })),
    runContextPack: vi.fn().mockResolvedValue('text pack'),
    analyzeFreshness: vi.fn().mockImplementation((graphPath: string) => createFreshness('fresh', graphPath)),
    summarizeGraph: vi.fn().mockImplementation(() => createGraphSummary(12)),
    resolvePackageRoot: vi.fn().mockReturnValue('/pkg'),
    pathExists: vi.fn().mockReturnValue(false),
    readNodeMajorVersion: vi.fn().mockReturnValue(20),
    defaultInstallPlatform: vi.fn().mockReturnValue('claude'),
    ...overrides,
  }
}

describe('runTryCommand', () => {
  it('reuses a fresh graph and forces a text explain pack', async () => {
    const workspace = resolve('/tmp/workspace')
    const graphPath = resolve(workspace, 'out', 'graph.json')
    const { io } = createIo()
    const dependencies = createDependencies({
      pathExists: vi.fn().mockImplementation((path: string) => path === graphPath),
      analyzeFreshness: vi.fn().mockImplementation((path: string) => createFreshness('fresh', path)),
    })

    const output = await runTryCommand({ prompt: 'how does auth work?', path: workspace }, io, dependencies)

    expect(dependencies.generateGraph).not.toHaveBeenCalled()
    expect(dependencies.runContextPack).toHaveBeenCalledWith({
      options: {
        prompt: 'how does auth work?',
        budget: 3000,
        task: 'explain',
        graphPath,
        format: 'text',
      },
      io,
    })
    expect(output).toContain('text pack')
    expect(output).toContain('madar claude install')
  })

  it.each(['partially_stale', 'possibly_stale', 'stale'] as const)(
    'rebuilds a %s graph before running the pack',
    async (freshnessStatus) => {
      const workspace = resolve('/tmp/stale-workspace')
      const graphPath = resolve(workspace, 'out', 'graph.json')
      const { io } = createIo()
      const dependencies = createDependencies({
        pathExists: vi.fn().mockImplementation((path: string) => path === graphPath),
        analyzeFreshness: vi.fn().mockImplementation((path: string) => createFreshness(freshnessStatus, path)),
      })

      await runTryCommand({ prompt: 'how does auth work?', path: workspace }, io, dependencies)

      expect(dependencies.generateGraph).toHaveBeenCalledWith(workspace, {})
      expect(dependencies.runContextPack).toHaveBeenCalledWith({
        options: {
          prompt: 'how does auth work?',
          budget: 3000,
          task: 'explain',
          graphPath,
          format: 'text',
        },
        io,
      })
    },
  )

  it('falls back to the packaged sample workspace when the current repo has no supported files', async () => {
    const workspace = resolve('/tmp/empty-workspace')
    const sampleWorkspace = resolve('/pkg/examples/sample-workspace')
    const sampleGraphPath = resolve(sampleWorkspace, 'out', 'graph.json')
    const { io } = createIo()
    const dependencies = createDependencies({
      pathExists: vi.fn().mockImplementation((path: string) => path === sampleWorkspace),
      generateGraph: vi.fn().mockImplementation((rootPath = '.') => {
        const resolvedRoot = resolve(rootPath)
        if (resolvedRoot === workspace) {
          throw new GenerateUnsupportedCorpusError('NO_SUPPORTED_FILES', 'No supported files were found in the target path.')
        }
        return {
          mode: 'generate',
          rootPath: resolvedRoot,
          outputDir: resolve(resolvedRoot, 'out'),
          graphPath: resolve(resolvedRoot, 'out', 'graph.json'),
          reportPath: resolve(resolvedRoot, 'out', 'GRAPH_REPORT.md'),
          totalFiles: 12,
          codeFiles: 12,
          indexedFiles: 12,
          totalWords: 1000,
          nodeCount: 12,
          edgeCount: 11,
          communityCount: 3,
          semanticAnomalyCount: 0,
          warning: null,
          notes: [],
        }
      }),
    })

    const output = await runTryCommand({ prompt: 'how does auth work?', path: workspace }, io, dependencies)

    expect(dependencies.generateGraph).toHaveBeenNthCalledWith(1, workspace, {})
    expect(dependencies.generateGraph).toHaveBeenNthCalledWith(2, sampleWorkspace, {})
    expect(dependencies.runContextPack).toHaveBeenCalledWith({
      options: {
        prompt: 'how does auth work?',
        budget: 3000,
        task: 'explain',
        graphPath: sampleGraphPath,
        format: 'text',
      },
      io,
    })
    expect(output).toContain('No supported files were found in the target path.')
    expect(output).toContain('sample-workspace')
  })

  it('falls back when the current repo graph is too small for a useful first proof', async () => {
    const workspace = resolve('/tmp/tiny-workspace')
    const graphPath = resolve(workspace, 'out', 'graph.json')
    const sampleWorkspace = resolve('/pkg/examples/sample-workspace')
    const sampleGraphPath = resolve(sampleWorkspace, 'out', 'graph.json')
    const { io } = createIo()
    const dependencies = createDependencies({
      pathExists: vi.fn().mockImplementation((path: string) => path === graphPath || path === sampleWorkspace),
      summarizeGraph: vi
        .fn()
        .mockImplementation((path: string) => (path === graphPath ? createGraphSummary(4) : createGraphSummary(12))),
    })

    const output = await runTryCommand({ prompt: 'how does auth work?', path: workspace }, io, dependencies)

    expect(dependencies.generateGraph).toHaveBeenCalledWith(sampleWorkspace, {})
    expect(dependencies.runContextPack).toHaveBeenCalledWith({
      options: {
        prompt: 'how does auth work?',
        budget: 3000,
        task: 'explain',
        graphPath: sampleGraphPath,
        format: 'text',
      },
      io,
    })
    expect(output).toContain('too small')
    expect(output).toContain('sample-workspace')
  })

  it('does not hide generator failures behind the sample fallback', async () => {
    const workspace = resolve('/tmp/broken-workspace')
    const sampleWorkspace = resolve('/pkg/examples/sample-workspace')
    const { io } = createIo()
    const dependencies = createDependencies({
      pathExists: vi.fn().mockImplementation((path: string) => path === sampleWorkspace),
      generateGraph: vi.fn().mockImplementation(() => {
        throw new Error('EACCES: permission denied, scandir /tmp/broken-workspace')
      }),
    })

    await expect(runTryCommand({ prompt: 'how does auth work?', path: workspace }, io, dependencies)).rejects.toThrow(
      'EACCES: permission denied',
    )
    expect(dependencies.generateGraph).toHaveBeenCalledTimes(1)
    expect(dependencies.runContextPack).not.toHaveBeenCalled()
  })

  it('fails early with an explicit Node.js 20+ diagnostic', async () => {
    const { io } = createIo()
    const dependencies = createDependencies({
      readNodeMajorVersion: vi.fn().mockReturnValue(18),
    })

    await expect(runTryCommand({ prompt: 'how does auth work?', path: '.' }, io, dependencies)).rejects.toThrow(
      'madar try requires Node.js 20+',
    )
    expect(dependencies.generateGraph).not.toHaveBeenCalled()
    expect(dependencies.runContextPack).not.toHaveBeenCalled()
  })

  it('surfaces pack failures from fresh graph reuse without rewriting them as graph read failures', async () => {
    const workspace = resolve('/tmp/reuse-workspace')
    const graphPath = resolve(workspace, 'out', 'graph.json')
    const { io } = createIo()
    const dependencies = createDependencies({
      pathExists: vi.fn().mockImplementation((path: string) => path === graphPath),
      runContextPack: vi.fn().mockRejectedValue(new Error('pack exploded')),
    })

    await expect(runTryCommand({ prompt: 'how does auth work?', path: workspace }, io, dependencies)).rejects.toThrow(
      'pack exploded',
    )
    expect(dependencies.generateGraph).not.toHaveBeenCalled()
  })
})
