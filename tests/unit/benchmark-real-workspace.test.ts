import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'graphify-real-bench-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('real-workspace benchmark support', () => {
  it('summarizes backend-only and monorepo benchmark runs side by side', () => {
    withTempDir((dir) => {
      const backendDir = join(dir, 'backend')
      const monorepoDir = join(dir, 'monorepo')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(monorepoDir, { recursive: true })

      const sampleSummary = {
        variants: {
          legacy: { build_time_ms: 500, graph_size_bytes: 1000, node_count: 10, edge_count: 12 },
          'spi-cold': { build_time_ms: 650, graph_size_bytes: 800, node_count: 11, edge_count: 14 },
          'spi-warm': { build_time_ms: 320, graph_size_bytes: 800, node_count: 11, edge_count: 14 },
        },
        analysis: {
          'spi-cold': {
            prompts: [
              {
                id: 'auth-flow',
                strategies: {
                  evidence_order: {
                    token_count: 210,
                    node_count: 6,
                    framework_roles: ['nest_controller'],
                    representation_types: ['detail'],
                    quality_score: 0.91,
                    warnings: [],
                  },
                  value_per_token: {
                    token_count: 180,
                    node_count: 5,
                    framework_roles: ['nest_controller'],
                    representation_types: ['sketch'],
                    quality_score: 0.94,
                    warnings: [],
                  },
                },
                retrieval_levels: [
                  { level: 1, token_count: 70, node_count: 2 },
                  { level: 4, token_count: 220, node_count: 7 },
                ],
              },
            ],
          },
        },
        comparison: {
          build_time_delta_ms: 150,
          graph_size_delta_bytes: -200,
        },
      }

      writeFileSync(join(backendDir, 'summary.json'), JSON.stringify(sampleSummary, null, 2))
      writeFileSync(join(monorepoDir, 'summary.json'), JSON.stringify({
        ...sampleSummary,
        variants: {
          ...sampleSummary.variants,
          legacy: { build_time_ms: 1000, graph_size_bytes: 5000, node_count: 50, edge_count: 70 },
        },
      }, null, 2))

      const output = execFileSync('node', [
        'docs/benchmarks/2026-05-11-spi-vs-legacy/summarize-real-workspaces.mjs',
        dir,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })

      const summary = JSON.parse(output)
      expect(summary.workspace_order).toEqual(['backend', 'monorepo'])
      expect(summary.workspaces.backend.variants['spi-cold'].build_time_ms).toBe(650)
      expect(summary.workspaces.monorepo.variants.legacy.graph_size_bytes).toBe(5000)
      expect(summary.comparison.objective_metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workspace: 'backend', metric: 'build_time_ms' }),
          expect.objectContaining({ workspace: 'monorepo', metric: 'graph_size_bytes' }),
        ]),
      )
      expect(summary.comparison.qualitative_notes).toEqual(
        expect.arrayContaining([
          expect.stringContaining('No private paths or artifacts are committed'),
        ]),
      )
    })
  })

  it('ships a real-workspace prompt example and report template with the privacy disclaimer', () => {
    const prompts = JSON.parse(readFileSync(
      join(process.cwd(), 'docs', 'benchmarks', '2026-05-11-spi-vs-legacy', 'prompts.real-workspace.example.json'),
      'utf8',
    ))
    const template = readFileSync(
      join(process.cwd(), 'docs', 'benchmarks', '2026-05-11-spi-vs-legacy', 'REAL_WORKSPACE_REPORT_TEMPLATE.md'),
      'utf8',
    )

    expect(prompts.schema_version).toBe(1)
    expect(prompts.prompts.map((prompt: { id: string }) => prompt.id)).toEqual(
      expect.arrayContaining(['auth-flow', 'report-generation', 'review-current-diff']),
    )
    expect(template).toContain('This benchmark can be run on private repos locally.')
    expect(template).toContain('No private paths or artifacts are committed.')
    expect(template).toContain('If GoValidate is unavailable, no GoValidate-specific numbers are claimed.')
  })

  it.skipIf(process.platform === 'win32')('fails fast when the real-workspace prompts file is missing', () => {
    withTempDir((dir) => {
      expect(() => execFileSync('bash', [
        'docs/benchmarks/2026-05-11-spi-vs-legacy/run-real-workspace.sh',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          GRAPHIFY_BENCH_BACKEND: process.cwd(),
          GRAPHIFY_BENCH_REAL_PROMPTS: join(dir, 'missing-prompts.json'),
        },
      })).toThrowError(expect.objectContaining({
        stderr: expect.stringContaining('GRAPHIFY_BENCH_REAL_PROMPTS'),
      }))
    })
  })

  it('fails fast when a configured workspace path is missing', () => {
    withTempDir((dir) => {
      const promptsPath = join(dir, 'prompts.json')
      writeFileSync(promptsPath, JSON.stringify({
        schema_version: 1,
        prompts: [],
      }, null, 2))

      expect(() => execFileSync('bash', [
        'docs/benchmarks/2026-05-11-spi-vs-legacy/run-real-workspace.sh',
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          GRAPHIFY_BENCH_BACKEND: join(dir, 'missing-backend'),
          GRAPHIFY_BENCH_REAL_PROMPTS: promptsPath,
        },
      })).toThrowError(expect.objectContaining({
        stderr: expect.stringContaining('GRAPHIFY_BENCH_BACKEND'),
      }))
    })
  })

  it('prints which workspace summary failed to parse', () => {
    withTempDir((dir) => {
      const backendDir = join(dir, 'backend')
      const monorepoDir = join(dir, 'monorepo')
      mkdirSync(backendDir, { recursive: true })
      mkdirSync(monorepoDir, { recursive: true })
      writeFileSync(join(backendDir, 'summary.json'), JSON.stringify({ variants: {} }, null, 2))
      writeFileSync(join(monorepoDir, 'summary.json'), '{"variants":', 'utf8')

      expect(() => execFileSync('node', [
        'docs/benchmarks/2026-05-11-spi-vs-legacy/summarize-real-workspaces.mjs',
        dir,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      })).toThrowError(expect.objectContaining({
        stderr: expect.stringContaining('monorepo'),
      }))
    })
  })
})
