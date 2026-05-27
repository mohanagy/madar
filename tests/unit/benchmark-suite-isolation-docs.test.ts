import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('benchmark suite isolation docs', () => {
  const methodology = readFileSync(resolve('docs/benchmarks/suite/methodology.md'), 'utf8')
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

  it('ships a minimal isolation config with the pinned environment hash', () => {
    const expectedHash = `sha256:${createHash('sha256').update(isolationClaude).digest('hex')}`

    expect(environment).toEqual({
      isolation_required: true,
      mcp_servers_active: ['madar'],
      skills_loaded: [],
      plugins_active: [],
      user_claude_md_hash: expectedHash,
      project_claude_md_hash: null,
      parent_claude_md_hashes: [],
      hooks_active: {
        user_prompt_submit: [],
        pre_tool_use: [],
        post_tool_use: [],
      },
    })
    expect(isolationClaude).toContain('published `madar bench:suite` isolation runs')
    expect(JSON.parse(isolationSettings)).toEqual({ hooks: {} })
  })

  it('ships a runnable isolation launcher that sets the pinned config', () => {
    expect(runIsolated).toContain('export CLAUDE_CONFIG_DIR')
    expect(runIsolated).toContain('export MADAR_BENCH_ISOLATION=1')
    expect(runIsolated).toContain('"serve"')
    expect(runIsolated).toContain('"--stdio"')
    expect(runIsolated).toContain('"out/graph.json"')
    expect(runIsolated).toContain('bench:suite "$@"')
  })
})
