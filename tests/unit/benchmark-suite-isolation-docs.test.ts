import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { captureBenchmarkEnvironment } from '../../src/infrastructure/benchmark/environment.js'
import { claudeInstall } from '../../src/infrastructure/install.js'

describe('benchmark suite isolation docs', () => {
  const methodology = readFileSync(resolve('docs/benchmarks/suite/methodology.md'), 'utf8')
  const gitAttributes = readFileSync(resolve('.gitattributes'), 'utf8')
  const isolationClaude = readFileSync(resolve('docs/benchmarks/suite/isolation/.claude/CLAUDE.md'), 'utf8')
  const isolationSettings = readFileSync(resolve('docs/benchmarks/suite/isolation/.claude/settings.json'), 'utf8')
  const environment = JSON.parse(readFileSync(resolve('docs/benchmarks/suite/isolation/environment.json'), 'utf8')) as {
    isolation_required: boolean
    mcp_servers_active: string[]
    skills_loaded: string[]
    plugins_active: string[]
    user_claude_md_hash: string
    project_claude_md_hash: null
    parent_claude_md_hashes: string[]
    hooks_active: {
      user_prompt_submit: string[]
      pre_tool_use: string[]
      post_tool_use: string[]
    }
  }
  const runIsolated = readFileSync(resolve('docs/benchmarks/suite/isolation/run-isolated.sh'), 'utf8')
  const retrieveRuntime = readFileSync(resolve('src/runtime/retrieve.ts'), 'utf8')
  const slicingRuntime = readFileSync(resolve('src/runtime/retrieve/slicing.ts'), 'utf8')
  const stdioTools = readFileSync(resolve('src/runtime/stdio/tools.ts'), 'utf8')
  const benchmarkCompare = readFileSync(resolve('src/infrastructure/compare.ts'), 'utf8')

  it('documents isolation mode, pinned environment, and env_mismatch handling', () => {
    expect(methodology).toContain('## Isolation mode and canonical environment')
    expect(methodology).toContain('MADAR_BENCH_ISOLATION=1')
    expect(methodology).toContain('status: "env_mismatch"')
    expect(methodology).toContain('Cells skipped for env drift: N')
    expect(methodology).toContain('isolation: true|false')
  })

  it('ships a minimal isolation config with the pinned environment hash', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'madar-bench-install-shape-'))
    const claudeConfigDir = join(projectRoot, '.bench-user', '.claude')
    try {
      mkdirSync(claudeConfigDir, { recursive: true })
      claudeInstall(projectRoot)
      const installedEnvironment = await captureBenchmarkEnvironment({
        projectRoot,
        claudeConfigDir,
        getClaudeCodeVersion: () => null,
      })

      expect(environment).toEqual({
        isolation_required: true,
        mcp_servers_active: ['madar'],
        skills_loaded: [],
        plugins_active: [],
        user_claude_md_hash: `sha256:${createHash('sha256').update(isolationClaude).digest('hex')}`,
        project_claude_md_hash: installedEnvironment.project_claude_md_hash,
        parent_claude_md_hashes: [],
        hooks_active: {
          user_prompt_submit: installedEnvironment.hooks_active.user_prompt_submit,
          pre_tool_use: installedEnvironment.hooks_active.pre_tool_use,
          post_tool_use: installedEnvironment.hooks_active.post_tool_use,
        },
      })
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
    expect(isolationClaude).toContain('published `madar bench:suite` isolation runs')
    expect(JSON.parse(isolationSettings)).toEqual({ hooks: {} })
  })

  it('ships a runnable isolation launcher that sets the pinned config', () => {
    expect(runIsolated).not.toContain('CLAUDE_CONFIG_DIR="${ISOLATION_ROOT}/.claude"')
    expect(runIsolated).toContain('RUNTIME_PROFILE_ROOT=')
    expect(runIsolated).toContain('cp "${ISOLATION_ROOT}/.claude/CLAUDE.md"')
    expect(runIsolated).toContain('cp "${ISOLATION_ROOT}/.claude/settings.json"')
    expect(runIsolated).toContain('export CLAUDE_CONFIG_DIR')
    expect(runIsolated).toContain('export CURSOR_CONFIG_DIR')
    expect(runIsolated).toContain('export MADAR_BENCH_ISOLATION=1')
    expect(runIsolated).toContain('npm pack --silent --pack-destination')
    expect(runIsolated).toContain('npm install --ignore-scripts --omit=optional')
    expect(runIsolated).toContain('PACKED_ARTIFACT_ROOT=')
    expect(runIsolated).toContain('MADAR_BENCH_RUNTIME_SOURCE="npm_pack"')
    expect(runIsolated).toContain('package/dist/src/cli/bin.js')
    expect(runIsolated).toContain('"serve"')
    expect(runIsolated).toContain('"--stdio"')
    expect(runIsolated).toContain('"out/graph.json"')
    expect(runIsolated).toContain('bench:suite "$@"')
  })

  it('ships an executable checkout-vs-packed retrieval parity gate', () => {
    const packageManifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const parityScript = readFileSync(resolve('.github/scripts/verify-packed-retrieval-parity.mjs'), 'utf8')
    const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')

    expect(packageManifest.scripts?.['verify:pack-parity']).toBe(
      'node .github/scripts/verify-packed-retrieval-parity.mjs',
    )
    expect(parityScript).toContain('Packed retrieval parity passed')
    expect(parityScript).toContain('checkoutServer.handleStdioRequest')
    expect(parityScript).toContain('packedServer.handleStdioRequest')
    expect(parityScript).toContain('Packed artifact unexpectedly contains checkout-only docs')
    expect(workflow).toContain('npm run verify:pack-parity')
  })

  it('keeps expected benchmark evidence out of all production retrieval paths', () => {
    expect(retrieveRuntime).not.toContain('runtimeProofProfile')
    expect(slicingRuntime).not.toContain('runtimeProofProfile')
    expect(stdioTools).not.toContain('runtime-proof.json')
    expect(stdioTools).not.toContain('loadBenchmarkRuntimeProofProfiles')
    expect(benchmarkCompare).toContain('loadBenchmarkRuntimeProofProfiles')
    expect(benchmarkCompare).toContain('missingRuntimeProofCitations')
  })

  it.skipIf(process.platform === 'win32')('fails fast when the default Claude profile is logged in but the isolated profile is not', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-bench-isolation-auth-'))
    const binDir = join(tempDir, 'bin')
    const mockCliPath = join(tempDir, 'mock-cli.js')
    const nodeCalledPath = join(tempDir, 'node-called')
    const runtimeProfileRoot = join(tempDir, 'runtime-profile')
    try {
      mkdirSync(binDir, { recursive: true })
      writeFileSync(mockCliPath, 'console.log("mock cli")\n', 'utf8')
      const fakeClaudePath = join(binDir, 'claude')
      writeFileSync(fakeClaudePath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 2 && "$1" == "auth" && "$2" == "status" ]]; then
  if [[ -n "\${CLAUDE_CONFIG_DIR:-}" ]]; then
    printf '{\\n"loggedIn":false,\\n"authMethod":"none",\\n"apiProvider":"firstParty"\\n}\\n'
    exit 1
  fi
  printf '{\\n"loggedIn":true,\\n"authMethod":"claude.ai",\\n"apiProvider":"firstParty"\\n}\\n'
  exit 0
fi
echo "unexpected claude invocation: $*" >&2
exit 97
`, 'utf8')
      chmodSync(fakeClaudePath, 0o755)
      const fakeNodePath = join(binDir, 'node')
      writeFileSync(fakeNodePath, `#!/usr/bin/env bash
set -euo pipefail
touch "${nodeCalledPath}"
exit 0
`, 'utf8')
      chmodSync(fakeNodePath, 0o755)

      expect(() => execFileSync('bash', [
        resolve('docs/benchmarks/suite/isolation/run-isolated.sh'),
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          MADAR_BENCH_ISOLATION_PROFILE_ROOT: runtimeProfileRoot,
          MADAR_BENCH_CLI_PATH: mockCliPath,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
      })).toThrowError(expect.objectContaining({
        stderr: expect.stringContaining('default Claude profile is logged in, but the isolated benchmark profile is not'),
      }))
      expect(existsSync(nodeCalledPath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('prints only the isolated runtime-profile login command when no Claude profile is authenticated', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'madar-bench-isolation-auth-none-'))
    const binDir = join(tempDir, 'bin')
    const mockCliPath = join(tempDir, 'mock-cli.js')
    const nodeCalledPath = join(tempDir, 'node-called')
    const runtimeProfileRoot = join(tempDir, 'runtime-profile')
    try {
      mkdirSync(binDir, { recursive: true })
      writeFileSync(mockCliPath, 'console.log("mock cli")\n', 'utf8')
      const fakeClaudePath = join(binDir, 'claude')
      writeFileSync(fakeClaudePath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 2 && "$1" == "auth" && "$2" == "status" ]]; then
  printf '{\\n"loggedIn":false,\\n"authMethod":"none",\\n"apiProvider":"firstParty"\\n}\\n'
  exit 1
fi
echo "unexpected claude invocation: $*" >&2
exit 97
`, 'utf8')
      chmodSync(fakeClaudePath, 0o755)
      const fakeNodePath = join(binDir, 'node')
      writeFileSync(fakeNodePath, `#!/usr/bin/env bash
set -euo pipefail
touch "${nodeCalledPath}"
exit 0
`, 'utf8')
      chmodSync(fakeNodePath, 0o755)

      expect(() => execFileSync('bash', [
        resolve('docs/benchmarks/suite/isolation/run-isolated.sh'),
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          MADAR_BENCH_ISOLATION_PROFILE_ROOT: runtimeProfileRoot,
          MADAR_BENCH_CLI_PATH: mockCliPath,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        },
      })).toThrowError(expect.objectContaining({
        stderr: expect.stringContaining('CLAUDE_CONFIG_DIR='),
      }))
      try {
        execFileSync('bash', [
          resolve('docs/benchmarks/suite/isolation/run-isolated.sh'),
        ], {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: 'pipe',
          env: {
            ...process.env,
            MADAR_BENCH_ISOLATION_PROFILE_ROOT: runtimeProfileRoot,
            MADAR_BENCH_CLI_PATH: mockCliPath,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
        })
      } catch (error) {
        const stderr = String((error as { stderr?: string }).stderr ?? '')
        expect(stderr).not.toContain('\n  claude auth login\n')
      }
      expect(existsSync(nodeCalledPath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('forces LF checkout for the pinned isolation CLAUDE.md', () => {
    expect(gitAttributes).toContain('docs/benchmarks/suite/isolation/.claude/CLAUDE.md text eol=lf')
  })
})
