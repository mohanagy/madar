import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { executeCli } from '../../src/cli/main.js'
import { GRAPH_ARTIFACT_V2_HEADER, GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { releaseLoadGraph, releaseServeSource, type OldLoadGraph } from './helpers/v0321-loader.js'

/**
 * The cutover's compatibility contract, proved end to end on disk.
 *
 * The loader-level proof shows that the released v0.32.1 `loadGraph` rejects a
 * v2 artifact and the tombstone when handed those paths. This proves the case a
 * user actually hits: an old binary run in a workspace the current one has cut
 * over, resolving `out/graph.json` the way v0.32.1 resolves it by default. It
 * must fail, and the failure has to be one a person can act on rather than a
 * wrong answer drawn from a file it half-understood.
 *
 * It also proves the two directions that make the cutover safe to ship: an
 * upgrade preserves the prior v1 so nothing is destroyed, and restoring that
 * backup returns the workspace to a state the old binary can read.
 */

const SOURCE = 'export function login() { return authorize() }\nexport function authorize() { return true }\n'

/** What v0.32.1 resolves when no `--graph` is given. */
const OLD_READER_DEFAULT = join('out', 'graph.json')

const V1_FROM_OLD_BINARY = JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [
    { id: 'a_login', label: 'login()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' },
    { id: 'a_authorize', label: 'authorize()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L2' },
  ],
  links: [
    { source: 'a_login', target: 'a_authorize', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/a.ts' },
  ],
  hyperedges: [],
  community_labels: {},
})

function sourceWorkspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), SOURCE)
  return root
}

/** A workspace as an older binary would have left it: v1 only. */
function preCutoverWorkspace(): string {
  const root = sourceWorkspace('upgrade-pre-')
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', 'graph.json'), V1_FROM_OLD_BINARY)
  return root
}

/** Names and sizes of the graph artifacts a workspace holds. */
function diskReceipt(root: string): Record<string, number> {
  const out = join(root, 'out')
  const receipt: Record<string, number> = {}
  for (const name of ['graph.madar', 'graph.json', 'graph.v1.json']) {
    const path = join(out, name)
    if (existsSync(path)) receipt[name] = statSync(path).size
  }
  return receipt
}

function firstLine(path: string): string {
  return readFileSync(path, 'utf8').split('\n')[0] ?? ''
}

describe('the tombstone is a frozen, published contract', () => {
  // Pinned as literal bytes on purpose. Every other assertion in the suite
  // compares the file against GRAPH_ARTIFACT_V2_TOMBSTONE, so a change to that
  // constant changes both sides and nothing fails -- while the bytes are what an
  // old binary reports, what a person sees on opening the file, and what the
  // release workflow compares against.
  const EXPECTED_BYTES = 'MADAR_GRAPH_MOVED/2\n'
    + 'Use out/graph.madar with Madar >= the v2-supporting version.\n'

  it('has exactly the published bytes', () => {
    expect(GRAPH_ARTIFACT_V2_TOMBSTONE).toBe(EXPECTED_BYTES)
  })

  it('is not parseable as JSON, so a v1 reader has to refuse it', () => {
    // This is the whole mechanism of failing closed: the old loader parses
    // out/graph.json as JSON, and the tombstone cannot be parsed.
    expect(() => JSON.parse(GRAPH_ARTIFACT_V2_TOMBSTONE)).toThrow()
  })

  it('tells the reader where the graph went', () => {
    expect(GRAPH_ARTIFACT_V2_TOMBSTONE).toContain('out/graph.madar')
    expect(GRAPH_ARTIFACT_V2_TOMBSTONE.split('\n')[0]).toBe('MADAR_GRAPH_MOVED/2')
  })

  it('matches the bytes the release workflow compares against', () => {
    // publish-next.yml writes its own expected tombstone with printf and cmp's
    // the generated file against it. If the two drifted, the prerelease gate
    // would fail in CI only -- so the coupling is asserted here instead.
    const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'publish-next.yml'), 'utf8')
    const printed = EXPECTED_BYTES.replaceAll('\n', '\\n')

    expect(workflow).toContain(`printf '${printed}'`)
  })
})

describe('a v0.32.1 reader fails closed on a workspace the current version cut over', () => {
  let oldLoadGraph: OldLoadGraph | null = null

  const releasedLoader = (): OldLoadGraph => {
    // Compiled once; the tag and file digest are asserted inside.
    oldLoadGraph ??= releaseLoadGraph(releaseServeSource())
    return oldLoadGraph
  }

  it('rejects a freshly generated workspace at the path it resolves by default', () => {
    const root = sourceWorkspace('upgrade-fresh-')
    try {
      generateGraph(root, { noHtml: true })
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')

      // No --graph: this is the path v0.32.1 uses on its own.
      const defaultPath = join(root, OLD_READER_DEFAULT)
      expect(existsSync(defaultPath)).toBe(true)

      let message = ''
      try {
        releasedLoader()(defaultPath)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      // Failing is the contract. Failing usefully is what makes it shippable:
      // the old binary cannot name graph.madar, so it has to at least tell the
      // user the file is not a graph it can read.
      expect(message).not.toBe('')
      expect(message).toMatch(/graph\.json/i)
      expect(message).toMatch(/corrupt|rebuild|re-run/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('rejects the canonical artifact if pointed at it directly', () => {
    const root = sourceWorkspace('upgrade-direct-')
    try {
      generateGraph(root, { noHtml: true })

      // A user who reads the tombstone and tries the new path with an old
      // binary must also be refused, not given a partial parse.
      expect(() => releasedLoader()(join(root, 'out', 'graph.madar'))).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('still reads a workspace that never cut over', () => {
    const root = preCutoverWorkspace()
    try {
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('legacy_v1_only')

      // The control that makes the rejections above meaningful: the released
      // loader is not simply broken in this harness.
      expect(() => releasedLoader()(join(root, OLD_READER_DEFAULT))).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('upgrading a pre-cutover workspace preserves what it had', () => {
  it('publishes the canonical artifact, the tombstone, and a backup of the prior v1', () => {
    const root = preCutoverWorkspace()
    try {
      const before = readFileSync(join(root, 'out', 'graph.json'), 'utf8')

      generateGraph(root, { noHtml: true })

      const out = join(root, 'out')
      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
      expect(firstLine(join(out, 'graph.madar'))).toBe(GRAPH_ARTIFACT_V2_HEADER.trimEnd())
      expect(readFileSync(join(out, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)

      // The prior artifact is preserved byte for byte. Losing it would make the
      // cutover irreversible for anyone who needs the old binary back.
      expect(existsSync(join(out, 'graph.v1.json'))).toBe(true)
      expect(readFileSync(join(out, 'graph.v1.json'), 'utf8')).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('leaves no backup when there was nothing to preserve', () => {
    const root = sourceWorkspace('upgrade-nothing-')
    try {
      generateGraph(root, { noHtml: true })

      // A fresh workspace never had a v1, so inventing a backup would claim a
      // history that does not exist.
      expect(existsSync(join(root, 'out', 'graph.v1.json'))).toBe(false)
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('does not overwrite an existing backup on a second cutover', () => {
    const root = preCutoverWorkspace()
    try {
      generateGraph(root, { noHtml: true })
      const preserved = readFileSync(join(root, 'out', 'graph.v1.json'), 'utf8')

      generateGraph(root, { noHtml: true })

      // The backup records the artifact from before the first cutover. A later
      // run must not replace it with anything newer.
      expect(readFileSync(join(root, 'out', 'graph.v1.json'), 'utf8')).toBe(preserved)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('records what a fresh and an upgraded workspace hold on disk', () => {
    const fresh = sourceWorkspace('receipt-fresh-')
    const upgraded = preCutoverWorkspace()
    try {
      generateGraph(fresh, { noHtml: true })
      generateGraph(upgraded, { noHtml: true })

      const freshReceipt = diskReceipt(fresh)
      const upgradedReceipt = diskReceipt(upgraded)

      // The receipts differ in exactly one file. Anything else differing would
      // mean an upgrade produces a materially different workspace shape.
      expect(Object.keys(freshReceipt).sort()).toEqual(['graph.json', 'graph.madar'])
      expect(Object.keys(upgradedReceipt).sort()).toEqual(['graph.json', 'graph.madar', 'graph.v1.json'])
      expect(freshReceipt['graph.json']).toBe(upgradedReceipt['graph.json'])
      expect(freshReceipt['graph.madar']).toBeGreaterThan(0)
      expect(upgradedReceipt['graph.v1.json']).toBeGreaterThan(0)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
      rmSync(upgraded, { recursive: true, force: true })
    }
  }, 180_000)
})

describe('rolling back returns the workspace to the old binary', () => {
  it('restores a readable v1 for the released loader', () => {
    const root = preCutoverWorkspace()
    try {
      generateGraph(root, { noHtml: true })
      const out = join(root, 'out')
      const oldLoadGraph = releaseLoadGraph(releaseServeSource())

      // Cut over: the old binary is locked out.
      expect(() => oldLoadGraph(join(root, OLD_READER_DEFAULT))).toThrow()

      // Roll back the way the tombstone's own instructions imply: the preserved
      // v1 goes back to the path the old binary reads, and the canonical
      // artifact steps aside.
      renameSync(join(out, 'graph.madar'), join(out, 'graph.madar.held'))
      writeFileSync(join(out, 'graph.json'), readFileSync(join(out, 'graph.v1.json')))

      expect(classifyWorkspaceGraph(out).state).toBe('legacy_v1_only')
      expect(() => oldLoadGraph(join(root, OLD_READER_DEFAULT))).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('lets the current version answer from the rolled-back workspace too', async () => {
    const root = preCutoverWorkspace()
    const originalCwd = process.cwd()
    try {
      generateGraph(root, { noHtml: true })
      const out = join(root, 'out')
      renameSync(join(out, 'graph.madar'), join(out, 'graph.madar.held'))
      writeFileSync(join(out, 'graph.json'), readFileSync(join(out, 'graph.v1.json')))

      process.chdir(root)
      const lines: string[] = []
      const io = {
        log: (message: string) => lines.push(String(message)),
        error: (message: string) => lines.push(String(message)),
      }

      // A rollback that only the old binary could read would strand anyone who
      // upgrades again, so the current version has to keep working here.
      expect(await executeCli(['summary'], io)).toBe(0)
      expect(lines.join('\n')).toMatch(/node_count/)
    } finally {
      process.chdir(originalCwd)
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('re-cuts over cleanly after a rollback', () => {
    const root = preCutoverWorkspace()
    try {
      generateGraph(root, { noHtml: true })
      const out = join(root, 'out')
      const firstBackup = readFileSync(join(out, 'graph.v1.json'), 'utf8')
      rmSync(join(out, 'graph.madar'))
      writeFileSync(join(out, 'graph.json'), readFileSync(join(out, 'graph.v1.json')))
      expect(classifyWorkspaceGraph(out).state).toBe('legacy_v1_only')

      generateGraph(root, { noHtml: true })

      // Repeatable in both directions, and the original backup still describes
      // the artifact from before the first cutover.
      expect(classifyWorkspaceGraph(out).state).toBe('current_v2')
      expect(readFileSync(join(out, 'graph.v1.json'), 'utf8')).toBe(firstBackup)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
