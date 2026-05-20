import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { directorySize, runGeneratePerformanceBenchmark } from '../../src/infrastructure/benchmark/generate-performance.js'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'graphify-generate-benchmark-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'src', 'alpha.ts'), 'export function alpha(): number { return 1 }\n', 'utf8')
  writeFileSync(
    join(root, 'src', 'beta.ts'),
    'import { alpha } from "./alpha"\nexport function beta(): number { return alpha() }\n',
    'utf8',
  )
  writeFileSync(join(root, 'docs', 'notes.md'), '# Notes\n', 'utf8')
}

describe('generate performance benchmark harness', () => {
  it('covers generate, update, cluster-only, and SPI cache variants with structured metrics', () => {
    withTempDir((dir) => {
      const fixtureRoot = join(dir, 'fixture')
      const workDir = join(dir, 'runs')
      writeFixture(fixtureRoot)

      const summary = runGeneratePerformanceBenchmark({
        fixtureRoot,
        workDir,
      })

      expect(summary.schema_version).toBe(1)
      expect(summary.metrics_tracked).toEqual(expect.arrayContaining([
        'wall_clock_ms',
        'total_files',
        'extractable_files',
        'extracted_files',
        'node_count',
        'edge_count',
        'cache_hit',
        'cache_reason',
        'output_size_bytes',
      ]))
      expect(Object.keys(summary.variants)).toEqual([
        'generate-legacy',
        'generate-spi-cold',
        'generate-spi-warm',
        'update-noop',
        'update-changed',
        'cluster-only',
      ])

      for (const variant of Object.values(summary.variants)) {
        expect(variant.wall_clock_ms).toBeGreaterThanOrEqual(0)
        expect(variant.total_files).toBeGreaterThan(0)
        expect(variant.extractable_files).toBeGreaterThan(0)
        expect(variant.extractable_files).toBeGreaterThanOrEqual(variant.extracted_files)
        expect(variant.node_count).toBeGreaterThan(0)
        expect(variant.edge_count).toBeGreaterThan(0)
        expect(variant.graph_size_bytes).toBeGreaterThan(0)
        expect(variant.output_size_bytes).toBeGreaterThanOrEqual(variant.graph_size_bytes)
      }

      expect(summary.variants['generate-spi-cold']).toEqual(expect.objectContaining({
        mode: 'generate',
        strategy: 'spi',
        cache_hit: false,
        cache_reason: 'no-cache',
        extracted_files: 3,
      }))
      expect(summary.variants['generate-spi-warm']).toEqual(expect.objectContaining({
        mode: 'generate',
        strategy: 'spi',
        cache_hit: true,
        cache_reason: 'fresh-cache',
        extracted_files: 1,
      }))
      expect(summary.variants['update-noop']).toEqual(expect.objectContaining({
        mode: 'update',
        changed_files: 0,
        extracted_files: 0,
      }))
      expect(summary.variants['update-changed']).toEqual(expect.objectContaining({
        mode: 'update',
        changed_files: 1,
        extracted_files: 1,
      }))
      expect(summary.variants['cluster-only']).toEqual(expect.objectContaining({
        mode: 'cluster-only',
        extracted_files: 0,
      }))
    })
  })

  it('documents the benchmark plan, tracked metrics, and runnable harness', () => {
    const readme = readFileSync(resolve('docs/benchmarks/performance/README.md'), 'utf8')
    const runner = readFileSync(resolve('docs/benchmarks/performance/run.mjs'), 'utf8')

    expect(readme).toContain('`generate`, `update`, and `cluster-only`')
    expect(readme).toContain('wall_clock_ms')
    expect(readme).toContain('cache_reason')
    expect(readme).toContain('Manual large-repo benchmark flow')
    expect(readme).toContain('GRAPHIFY_PERF_FIXTURE')

    expect(runner).toContain('runGeneratePerformanceBenchmark')
    expect(runner).toContain('GRAPHIFY_PERF_RESULTS_DIR')
  })

  it.runIf(process.platform !== 'win32')('ignores symlinks when measuring output directory size', () => {
    withTempDir((dir) => {
      const root = join(dir, 'root')
      const outside = join(dir, 'outside')
      mkdirSync(root, { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(root, 'report.json'), '{}\n', 'utf8')
      writeFileSync(join(outside, 'large.bin'), 'x'.repeat(2048), 'utf8')
      symlinkSync(outside, join(root, 'linked-outside'), 'dir')

      expect(directorySize(root)).toBe(Buffer.byteLength('{}\n'))
    })
  })

  it.runIf(process.platform !== 'win32')('mutates the first real code file deterministically with language-appropriate syntax and skips symlinks', () => {
    withTempDir((dir) => {
      const fixtureRoot = join(dir, 'fixture')
      const workDir = join(dir, 'runs')
      const outside = join(dir, 'outside')
      mkdirSync(fixtureRoot, { recursive: true })
      mkdirSync(outside, { recursive: true })

      writeFileSync(join(fixtureRoot, 'a.py'), 'def alpha():\n    return 1\n', 'utf8')
      writeFileSync(join(fixtureRoot, 'z.ts'), 'export function zeta(): number { return 1 }\n', 'utf8')
      writeFileSync(join(outside, 'linked.js'), 'export const linked = true\n', 'utf8')
      symlinkSync(join(outside, 'linked.js'), join(fixtureRoot, 'b.js'))

      runGeneratePerformanceBenchmark({
        fixtureRoot,
        workDir,
      })

      const mutatedPython = readFileSync(join(workDir, 'workspaces', 'update-changed', 'a.py'), 'utf8')
      const untouchedTs = readFileSync(join(workDir, 'workspaces', 'update-changed', 'z.ts'), 'utf8')
      const outsideTarget = readFileSync(join(outside, 'linked.js'), 'utf8')

      expect(mutatedPython).toContain('# __graphifyBenchmarkTouch = True')
      expect(untouchedTs).not.toContain('__graphifyBenchmarkTouch')
      expect(outsideTarget).not.toContain('__graphifyBenchmarkTouch')
    })
  })
})
