import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
    expect(runIsolated).toContain('export CLAUDE_CONFIG_DIR')
    expect(runIsolated).toContain('export CURSOR_CONFIG_DIR')
    expect(runIsolated).toContain('export MADAR_BENCH_ISOLATION=1')
    expect(runIsolated).toContain('"serve"')
    expect(runIsolated).toContain('"--stdio"')
    expect(runIsolated).toContain('"out/graph.json"')
    expect(runIsolated).toContain('bench:suite "$@"')
  })

  it('forces LF checkout for the pinned isolation CLAUDE.md', () => {
    expect(gitAttributes).toContain('docs/benchmarks/suite/isolation/.claude/CLAUDE.md text eol=lf')
  })
})
