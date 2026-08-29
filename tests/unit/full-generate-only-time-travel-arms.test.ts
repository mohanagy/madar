import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { GRAPH_ARTIFACT_V2_HEADER } from '../../src/contracts/graph-artifact.js'

/**
 * #722 — time_travel_compare has two arms with different rules.
 *
 * HISTORICAL arm: a persisted snapshot may be loaded read-only. It is never
 * marked current, never mutated, never used to seed the other arm.
 *
 * CURRENT arm: always generated fresh through the ordinary full-generation
 * owner, in an isolated transient worktree. It never takes a cache hit, and its
 * result must equal a direct ordinary generation at that revision.
 */

const POISON_SYMBOL = 'MadarSevenTwoTwoHistoricalPoison'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A repository with a poisoned historical commit and a clean later commit. */
function repository(): { dir: string; historical: string; current: string } {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-tt-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])

  writeFileSync(join(dir, 'src/a.ts'), `export function ${POISON_SYMBOL}() { return 1 }\n`)
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'historical'])
  const historical = git(dir, ['rev-parse', 'HEAD'])

  writeFileSync(join(dir, 'src/a.ts'), 'export function cleanSymbol() { return 2 }\n')
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'current'])
  const current = git(dir, ['rev-parse', 'HEAD'])

  return { dir, historical, current }
}

/**
 * Path-independent semantics. The two arms are generated in different
 * directories, so absolute source paths differ by construction; comparing raw
 * bytes would compare the temp directory names, not the semantics.
 */
function semanticDigest(graphPath: string): string {
  const raw = readFileSync(graphPath, 'utf8')
  const payload = JSON.parse(raw.slice(GRAPH_ARTIFACT_V2_HEADER.length)) as {
    nodes: { id: string; attributes?: Record<string, unknown> }[]
    facts: { source: string; target: string; relation?: string }[]
  }
  const nodes = payload.nodes.map((n) => `${n.id}|${String(n.attributes?.label ?? '')}|${String(n.attributes?.file_type ?? '')}`).sort()
  const facts = payload.facts.map((f) => `${f.source}->${f.target}|${String(f.relation ?? '')}`).sort()
  return createHash('sha256').update(JSON.stringify({ nodes, facts })).digest('hex')
}

function transientWorktreeCount(): number {
  const root = join(tmpdir(), 'madar-time-travel-worktrees')
  try { return readdirSync(root).length } catch { return 0 }
}

describe('FULL-GENERATE-ONLY time-travel arms', () => {
  afterEach(() => { vi.resetModules() })

  test('precondition: the historical revision genuinely carries the poison symbol', () => {
    const repo = repository()
    const shown = git(repo.dir, ['show', `${repo.historical}:src/a.ts`])
    // Without this the "poison absent from the current arm" assertion below
    // would hold because the poison never existed.
    expect(shown, 'POISON_NOT_IN_HISTORICAL_REVISION').toContain(POISON_SYMBOL)
    expect(git(repo.dir, ['show', `${repo.current}:src/a.ts`]), 'POISON_LEAKED_INTO_CURRENT_REVISION')
      .not.toContain(POISON_SYMBOL)
  })

  test('the current arm is generated fresh and reads no persisted semantic state', async () => {
    const repo = repository()
    const counts = { graphPolicy: 0, storedPolicy: 0, cachedExtraction: 0, indexingManifest: 0 }

    vi.resetModules()
    const pol = await vi.importActual<typeof import('../../src/infrastructure/generation-policy.js')>('../../src/infrastructure/generation-policy.js')
    vi.doMock('../../src/infrastructure/generation-policy.js', () => ({ ...pol,
      readGraphGenerationPolicy: (...a: Parameters<typeof pol.readGraphGenerationPolicy>) => { counts.graphPolicy += 1; return pol.readGraphGenerationPolicy(...a) },
      readStoredGenerationPolicy: (...a: Parameters<typeof pol.readStoredGenerationPolicy>) => { counts.storedPolicy += 1; return pol.readStoredGenerationPolicy(...a) } }))
    const ext = await vi.importActual<typeof import('../../src/pipeline/extract.js')>('../../src/pipeline/extract.js')
    vi.doMock('../../src/pipeline/extract.js', () => ({ ...ext,
      readCachedExtraction: (...a: Parameters<typeof ext.readCachedExtraction>) => { counts.cachedExtraction += 1; return ext.readCachedExtraction(...a) } }))
    const man = await vi.importActual<typeof import('../../src/infrastructure/indexing-manifest.js')>('../../src/infrastructure/indexing-manifest.js')
    vi.doMock('../../src/infrastructure/indexing-manifest.js', () => ({ ...man,
      readIndexingManifestForGraph: (...a: Parameters<typeof man.readIndexingManifestForGraph>) => { counts.indexingManifest += 1; return man.readIndexingManifestForGraph(...a) } }))

    const worktreesBefore = transientWorktreeCount()
    try {
      const { compareRefs } = await import('../../src/infrastructure/time-travel.js')
      const result = await compareRefs(
        { fromRef: repo.historical, toRef: repo.current },
        { rootDir: repo.dir },
      )

      expect(result, 'COMPARISON_PRODUCED_NOTHING').toBeTruthy()
      for (const [k, v] of Object.entries(counts)) {
        expect(v, `TIME_TRAVEL_CURRENT_ARM_USED_PERSISTED_STATE (${k})`).toBe(0)
      }
      // No transient worktree survives a successful comparison.
      expect(transientWorktreeCount(), 'TRANSIENT_WORKTREE_LEAKED').toBe(worktreesBefore)
      // Nothing was published into the user's workspace.
      expect(existsSync(join(repo.dir, 'out', 'graph.madar')), 'PUBLISHED_INTO_USER_WORKSPACE').toBe(false)
    } finally {
      for (const m of ['../../src/infrastructure/generation-policy.js', '../../src/pipeline/extract.js',
                       '../../src/infrastructure/indexing-manifest.js']) vi.doUnmock(m)
      vi.resetModules()
    }
  }, 120_000)

  test('the current arm equals a direct ordinary generation at that revision', async () => {
    const repo = repository()
    const { loadOrBuildSnapshot } = await import('../../src/infrastructure/time-travel.js')
    const { generateGraph } = await import('../../src/infrastructure/generate.js')

    const armSnapshot = await loadOrBuildSnapshot({ ref: repo.current, refresh: true }, { rootDir: repo.dir })

    // Direct generation of the same revision, in an independent checkout.
    const direct = mkdtempSync(join(tmpdir(), 'madar-722-direct-'))
    execFileSync('git', ['clone', '-q', repo.dir, direct], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['checkout', '-q', repo.current], { cwd: direct, stdio: ['ignore', 'pipe', 'pipe'] })
    const directResult = generateGraph(direct, { extractionMode: 'auto', noHtml: true })

    expect(semanticDigest(armSnapshot.graphPath), 'CURRENT_ARM_DIVERGED_FROM_DIRECT_GENERATION')
      .toBe(semanticDigest(directResult.graphPath))
  }, 120_000)

  test('historical state cannot seed the current arm, in either arm order', async () => {
    const repo = repository()
    const { compareRefs } = await import('../../src/infrastructure/time-travel.js')
    const { loadOrBuildSnapshot } = await import('../../src/infrastructure/time-travel.js')

    // Seed the historical snapshot first, so a cache exists to leak from.
    const historicalSnapshot = await loadOrBuildSnapshot({ ref: repo.historical }, { rootDir: repo.dir })
    expect(readFileSync(historicalSnapshot.graphPath, 'utf8'), 'POISON_NOT_IN_HISTORICAL_SNAPSHOT')
      .toContain(POISON_SYMBOL)

    for (const [fromRef, toRef] of [[repo.historical, repo.current], [repo.current, repo.historical]] as const) {
      const currentArm = await loadOrBuildSnapshot({ ref: toRef, refresh: true }, { rootDir: repo.dir })
      const text = readFileSync(currentArm.graphPath, 'utf8')
      if (toRef === repo.current) {
        expect(text, 'TIME_TRAVEL_HISTORICAL_STATE_SEEDED_CURRENT_ARM').not.toContain(POISON_SYMBOL)
      }
      await compareRefs({ fromRef, toRef }, { rootDir: repo.dir })
    }
  }, 180_000)

  test('a failed generation leaves no transient worktree behind', async () => {
    const repo = repository()
    const before = transientWorktreeCount()
    const { loadOrBuildSnapshot } = await import('../../src/infrastructure/time-travel.js')

    await expect(loadOrBuildSnapshot({ ref: repo.current, refresh: true }, {
      rootDir: repo.dir,
      generateGraph: () => { throw new Error('injected generation failure') },
    })).rejects.toThrow(/injected generation failure/)

    expect(transientWorktreeCount(), 'TRANSIENT_WORKTREE_LEAKED_ON_FAILURE').toBe(before)
  }, 120_000)
})
