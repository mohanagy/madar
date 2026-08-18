import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

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

})

/**
 * The control: the refusal above is about the state, not about the commands.
 *
 * One workspace for the whole table rather than one per case. Every command
 * here reads the graph and none writes it, so they do not interact -- and that
 * is asserted at the end from the artifact's digest rather than assumed, which
 * is the condition for sharing a mutable workspace at all. Repairing per case
 * cost twelve full generations to prove one invariant.
 */
describe('the same commands answer once the workspace is repaired', () => {
  let root: string
  let originalCwd: string
  let repairedDigest: string

  const digest = (): string =>
    createHash('sha256').update(readFileSync(join(root, 'out', 'graph.madar'))).digest('hex')

  beforeAll(() => {
    originalCwd = process.cwd()
    root = mkdtempSync(join(tmpdir(), 'mixed-cli-repaired-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'a.ts'),
      'export function alpha() { beta() }\nexport function beta() {}\n',
    )
    generateGraph(root, { noHtml: true })
    writeFileSync(join(root, 'out', 'graph.json'), STALE_V1)

    // Full generation is the documented repair for the ambiguous state.
    generateGraph(root, { noHtml: true })
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    repairedDigest = digest()
    process.chdir(root)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(root, { recursive: true, force: true })
  })

  it.each(GRAPH_READING_COMMANDS)('%s succeeds once the workspace is repaired', async (_name, argv) => {
    const output: string[] = []
    const io = {
      log: (message: string) => output.push(String(message)),
      error: (message: string) => output.push(String(message)),
    }

    expect(await executeCli([...argv], io)).toBe(0)
  })

  it('left the shared artifact byte-identical', () => {
    // Sharing one workspace is only sound while every case above is a reader.
    // A command that started publishing would make the table order-dependent
    // and this is what would catch it.
    expect(digest()).toBe(repairedDigest)
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
  })
})
