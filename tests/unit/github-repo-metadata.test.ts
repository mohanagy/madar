import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('GitHub repository metadata', () => {
  it('describes the one-retrieve authenticated evidence product', () => {
    const metadata = JSON.parse(readFileSync(resolve('.github/repo-metadata.json'), 'utf8')) as {
      description: string
      topics: string[]
    }

    expect(metadata.description).toBe(
      'Authenticated local evidence paths for JavaScript and TypeScript coding agents over one MCP retrieve call.',
    )
    expect(metadata.topics).toEqual(expect.arrayContaining([
      'ai-coding-agents',
      'claude-code',
      'codex',
      'mcp',
      'typescript',
      'nodejs',
      'static-analysis',
      'knowledge-graph',
    ]))
    expect(metadata.description).not.toContain('context pack')
  })
})
