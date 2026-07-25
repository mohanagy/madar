import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

describe('development-only benchmark isolation', () => {
  it('keeps the retired benchmark harness outside the public CLI', () => {
    const methodology = read('docs/benchmarks/suite/methodology.md')
    const cli = read('src/adapters/cli/main.ts')

    expect(methodology.toLowerCase()).toContain('historical')
    expect(cli).not.toContain("case 'benchmark'")
    expect(cli).not.toContain("case 'bench:suite'")
    expect(cli).not.toContain("case 'eval'")
  })

  it('pins scratch evaluation MCP wiring without calling the product installer', () => {
    const suite = read('src/infrastructure/benchmark/suite.ts')

    expect(suite).not.toContain("from '../install.js'")
    expect(suite).toContain("args: ['mcp']")
    expect(suite).toContain("'dist', 'src', 'adapters', 'cli', 'bin.js'")
    expect(suite).toContain("join(workspaceRoot, '.mcp.json')")
  })

  it('launches the packed suite through checkout-only tooling, not a public CLI alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-isolated-launcher-'))
    const runtimeRoot = join(root, 'runtime')
    const profileRoot = join(root, 'profile')
    const cliPath = join(
      runtimeRoot,
      'dist',
      'src',
      'adapters',
      'cli',
      'madar\\windows.js',
    )
    const suitePath = join(runtimeRoot, 'dist', 'src', 'infrastructure', 'benchmark', 'suite.js')
    mkdirSync(resolve(cliPath, '..'), { recursive: true })
    mkdirSync(resolve(suitePath, '..'), { recursive: true })
    writeFileSync(join(runtimeRoot, 'package.json'), '{"type":"module"}\n', 'utf8')
    writeFileSync(cliPath, '#!/usr/bin/env node\n', 'utf8')
    writeFileSync(suitePath, [
      'export async function runBenchmarkSuite(options) {',
      '  return { text: JSON.stringify(options) }',
      '}',
      '',
    ].join('\n'), 'utf8')

    try {
      const output = execFileSync('bash', [
        resolve('docs/benchmarks/suite/isolation/run-isolated.sh'),
        '--dry-run',
        '--repo=fixture',
        '--mode',
        'warm',
        '--trials=2',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          MADAR_BENCH_CLI_PATH: cliPath,
          MADAR_BENCH_RUNTIME_ROOT: runtimeRoot,
          MADAR_BENCH_ISOLATION_PROFILE_ROOT: profileRoot,
        },
      })
      const options = JSON.parse(output) as {
        repo?: string
        mode?: string
        trials?: number
        dryRun?: boolean
      }
      expect(options).toEqual(expect.objectContaining({
        repo: 'fixture',
        mode: 'warm',
        trials: 2,
        dryRun: true,
      }))

      const cursorText = readFileSync(
        join(profileRoot, '.cursor', 'mcp.json'),
        'utf8',
      )
      expect(cursorText).toContain('madar\\\\windows.js')
      const cursor = JSON.parse(cursorText) as {
        mcpServers?: { madar?: { command?: string; args?: string[]; env?: unknown } }
      }
      expect(cursor.mcpServers?.madar).toEqual({
        command: 'node',
        args: [cliPath, 'mcp'],
      })
      const launcher = read('docs/benchmarks/suite/isolation/run-isolated.sh')
      expect(launcher).toContain('tools/eval/core-reset/benchmark-suite.mjs')
      expect(launcher).not.toContain('exec node "${CLI_PATH}" bench:suite')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs packed parity through the one-tool transport and exact bytes', () => {
    const parity = read('.github/scripts/verify-packed-retrieval-parity.mjs')
    const workflow = read('.github/workflows/ci.yml')

    expect(parity).toContain("'adapters', 'mcp', 'server.js'")
    expect(parity).toContain('server.serveMcpServer')
    expect(parity).toContain('requestWaitMs: 25_000')
    expect(parity).toContain('CLI query, and direct application bytes differ')
    expect(parity).not.toContain('serveGraphStdio')
    expect(parity).not.toContain('autoRefreshRequestWaitMs: 30_000')
    expect(workflow).toContain('npm run verify:pack-parity')
  })

  it('keeps expected benchmark evidence out of production retrieval', () => {
    for (const path of [
      'src/application/retrieve-context.ts',
      'src/domain/query/slice.ts',
      'src/adapters/mcp/protocol.ts',
    ]) {
      const source = read(path)
      expect(source).not.toContain('runtimeProofProfile')
      expect(source).not.toContain('loadBenchmarkRuntimeProofProfiles')
      expect(source).not.toContain('expected_labels')
    }
  })
})
