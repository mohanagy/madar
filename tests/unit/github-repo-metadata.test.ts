import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

interface RepoMetadata {
  description?: string
  topics?: string[]
}

function loadRepoMetadata(): RepoMetadata {
  return JSON.parse(readFileSync(resolve('.github/repo-metadata.json'), 'utf8')) as RepoMetadata
}

describe('GitHub repo metadata contract', () => {
  it('tracks the intended GitHub description and discovery topics for Madar', () => {
    const metadata = loadRepoMetadata()

    expect(metadata.description).toBe('Stop AI coding agents from rediscovering large TypeScript/Node repos with task-aware local context packs.')
    expect(metadata.topics).toEqual(expect.arrayContaining([
      'ai-coding-agents',
      'claude-code',
      'codex',
      'copilot',
      'cursor',
      'mcp',
      'typescript',
      'nodejs',
      'static-analysis',
      'codebase-analysis',
      'knowledge-graph',
    ]))
  })
})
