import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'vitest'

import { generateGraph, type GenerateGraphOptions, type GenerateGraphResult } from '../../../src/infrastructure/generate.js'
import { loadGraph } from '../../../src/runtime/serve.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — shared harness for the converted update scenarios.
 *
 * `--update` no longer continues from persisted semantic state; it routes to the
 * one supported full-generation owner. These scenarios previously asserted
 * incremental reuse. What remains valuable in them is the *situation* — a stale,
 * legacy, malformed or unusual prior artifact — so each is preserved and now
 * asserts that the situation cannot influence a fresh regeneration.
 *
 * The harness owns the shared invariants. Reader-call counts are owned by the
 * separate routing control, so scenarios assert only their unique semantics.
 */
export interface UpdateAsFreshScenario {
  /** Write the workspace's source truth. */
  readonly arrangeWorkspace: (dir: string) => void
  /** Options used for both the seeding run and the update run. */
  readonly generateOptions?: GenerateGraphOptions
  /** Corrupt, downgrade or otherwise seed the persisted artifact after seeding. */
  readonly arrangePersistedState?: (dir: string, initial: GenerateGraphResult) => void
  /**
   * Prove the seeded state is real. Without this a scenario can pass because its
   * fixture was inert rather than because regeneration ignored it.
   */
  readonly assertPersistedStatePrecondition?: (dir: string, initial: GenerateGraphResult) => void
  /** Change the workspace between seeding and the update run. */
  readonly mutateWorkspace?: (dir: string) => void
  /** The scenario's unique semantic invariant. */
  readonly assertFreshResult: (context: UpdateAsFreshContext) => void
}

export interface UpdateAsFreshContext {
  readonly dir: string
  readonly initial: GenerateGraphResult
  readonly result: GenerateGraphResult
  /** Ordinary full generation of the same final source, in a pristine workspace. */
  readonly clean: GenerateGraphResult
  readonly cleanDir: string
}

/** Semantic shape used to compare an update result against a clean generation. */
const semanticShape = (graphPath: string): { labels: string[], directed: boolean, linkCount: number } => {
  const graph = loadGraph(graphPath)
  return {
    labels: [...graph.nodeIds()].map((id) => String(graph.nodeAttributes(id).label ?? id)).sort(),
    directed: graph.isDirected(),
    linkCount: graph.numberOfEndpointPairs(),
  }
}

export function runUpdateAsFreshScenario(scenario: UpdateAsFreshScenario): void {
  const dir = mkdtempSync(join(tmpdir(), 'madar-722-update-'))
  const cleanDir = mkdtempSync(join(tmpdir(), 'madar-722-clean-'))
  try {
    const options = scenario.generateOptions ?? { noHtml: true }

    scenario.arrangeWorkspace(dir)
    const initial = generateGraph(dir, options)
    scenario.arrangePersistedState?.(dir, initial)
    scenario.assertPersistedStatePrecondition?.(dir, initial)
    scenario.mutateWorkspace?.(dir)

    const result = generateGraph(dir, { ...options, update: true })

    // ── shared invariants, asserted once ──────────────────────────────────────
    // `--update` is routed to the ordinary full-generation owner, so the public
    // mode is the truthful one and no continuation mode survives.
    expect(result.mode).toBe('generate')
    expect(existsSync(join(dir, 'out/graph.madar.tmp'))).toBe(false)

    // The same final source, generated cleanly, must be semantically identical:
    // nothing may reach the graph that came from the prior artifact.
    scenario.arrangeWorkspace(cleanDir)
    scenario.mutateWorkspace?.(cleanDir)
    const clean = generateGraph(cleanDir, options)
    expect(semanticShape(result.graphPath)).toStrictEqual(semanticShape(clean.graphPath))

    scenario.assertFreshResult({ dir, initial, result, clean, cleanDir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(cleanDir, { recursive: true, force: true })
  }
}
