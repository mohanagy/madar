import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { executeCli } from '../../src/cli/main.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'

/**
 * End-to-end proof that no command answers from an ambiguous workspace.
 *
 * This exists because a per-site audit was not enough: the mixed-state
 * decision was wired into three commands and missed the rest, and every unit
 * test still passed because they all called the resolver directly rather than
 * running a command. The only reliable check is to drive the CLI itself, so
 * this table is deliberately exhaustive over the graph-reading commands and a
 * new one that forgets the boundary will fail here.
 */
const GRAPH_READING_COMMANDS: ReadonlyArray<readonly [string, string[]]> = [
  ['query', ['query', 'alpha']],
  ['path', ['path', 'alpha', 'beta']],
  ['explain', ['explain', 'alpha']],
  ['summary', ['summary']],
  ['pack', ['pack', 'how does alpha work?']],
  ['prompt', ['prompt', 'how does alpha work?', '--provider', 'claude']],
]

const STALE_V1 = JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [{ id: 'stale', label: 'stale', file_type: 'code', source_file: 'stale.ts' }],
  links: [],
})

describe('no command answers from a mixed workspace', () => {
  let root: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    root = mkdtempSync(join(tmpdir(), 'mixed-cli-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'a.ts'),
      'export function alpha() { beta() }\nexport function beta() {}\n',
    )
    generateGraph(root, { noHtml: true })
    writeFileSync(join(root, 'out', 'graph.json'), STALE_V1)
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(root, { recursive: true, force: true })
  })

  it('starts from a genuinely mixed workspace', () => {
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('mixed_v2_and_live_v1')
  })

  it.each(GRAPH_READING_COMMANDS)('%s refuses and names the repair', async (_name, argv) => {
    const output: string[] = []
    const io = {
      log: (message: string) => output.push(String(message)),
      error: (message: string) => output.push(String(message)),
    }

    const exitCode = await executeCli([...argv], io)
    const text = output.join('\n')

    // Answering here is the failure: the command would be reporting on the
    // stale v1 while everything else describes the canonical artifact.
    expect(exitCode).not.toBe(0)
    expect(text).toMatch(/graph\.madar/)
    expect(text).toMatch(/madar generate \./)
    expect(text).not.toContain('stale')
  })

  it.each(GRAPH_READING_COMMANDS)('%s succeeds once the workspace is repaired', async (_name, argv) => {
    generateGraph(root, { noHtml: true })
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')

    const output: string[] = []
    const io = {
      log: (message: string) => output.push(String(message)),
      error: (message: string) => output.push(String(message)),
    }

    // The refusal must be about the ambiguity, not about the command being
    // broken: the same invocation works as soon as the state is unambiguous.
    expect(await executeCli([...argv], io)).toBe(0)
  })
})
