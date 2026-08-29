import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { ContextPackRecoveryPlan, MadarAnswerabilityState } from '../../src/contracts/context-recovery.js'
import { readinessRank } from '../../src/contracts/context-recovery.js'
import { serializeGraphArtifactV2 } from '../../src/contracts/graph-artifact.js'
import { buildFromJson } from '../../src/pipeline/build.js'
import {
  assessMadarResponseEvidence,
  buildMadarResponseEvidence,
} from '../../src/runtime/mcp-response-evidence.js'
import { readGraphIntegrityCap } from '../../src/shared/graph-integrity-answerability.js'

/**
 * End-to-end against a real artifact written to disk.
 *
 * The unit controls exercise the mapping on a decoded block. This suite reads
 * the same information the way production does -- through
 * `readGraphArtifactMetadata` off a serialized v2 artifact -- which is the only
 * way a mistake about the wire shape becomes visible. An earlier revision of
 * this work handed the whole storage receipt to the block parser and every real
 * artifact would have resolved as unreadable; the unit controls passed anyway,
 * because they fed the parser the shape it wanted.
 */

const NODES = [
  { id: 'alpha', label: 'Alpha', file_type: 'code', source_file: 'src/alpha.ts' },
  { id: 'beta', label: 'Beta', file_type: 'code', source_file: 'src/beta.ts' },
  { id: 'gamma', label: 'Gamma', file_type: 'code', source_file: 'src/gamma.ts' },
]

const RESOLVED_EDGES = [
  { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
  { source: 'beta', target: 'gamma', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
]

/** A critical relationship whose endpoint is missing from traversable topology. */
const MISSING_REGION_EDGES = [
  ...RESOLVED_EDGES,
  { source: 'alpha', target: 'nowhere', relation: 'imports_from', confidence: 'EXTRACTED', source_file: 'src/alpha.ts' },
  { source: 'beta', target: 'gamma', relation: 'totally_unregistered', confidence: 'EXTRACTED', source_file: 'src/beta.ts' },
]

const roots: string[] = []

function artifactFor(edges: Record<string, unknown>[]): string {
  const graph = buildFromJson(
    { schema_version: 1, directed: true, nodes: NODES, edges },
    { directed: true, accounting: 'normalized_extraction_boundary' },
  )
  const root = mkdtempSync(join(tmpdir(), 'madar-659-'))
  roots.push(root)
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  const graphPath = join(outDir, 'graph.madar')
  writeFileSync(graphPath, serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev-659',
    generationMode: 'full',
    generatedAt: '2026-08-30T00:00:00.000Z',
  }))
  return graphPath
}

function legacyArtifact(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-659-v1-'))
  roots.push(root)
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  const graphPath = join(outDir, 'graph.json')
  writeFileSync(graphPath, JSON.stringify({ schema_version: 1, directed: true, nodes: [], links: [] }))
  return graphPath
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Coverage strong enough that nothing but graph integrity can lower the result. */
function readyInputs(): Parameters<typeof assessMadarResponseEvidence>[0] {
  return {
    coverage: {
      required_evidence: ['primary'],
      semantic_required: ['implementation'],
      semantic_optional: [],
      entries: [
        { evidence_class: 'primary', required: true, available_nodes: 2, selected_nodes: 2, status: 'covered' },
      ],
      semantic_entries: [
        { category: 'implementation', label: 'implementation', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
      ],
      missing_required: [],
      missing_semantic: [],
      available_relationships: 2,
      selected_relationships: 2,
    },
    coveredWorkflowOwners: ['src/alpha.ts'],
    discoverySafety: null,
    indexingManifest: null,
    question: 'explain the alpha to gamma path',
  }
}

function recoveryPlan(state: MadarAnswerabilityState): ContextPackRecoveryPlan {
  return {
    version: 1,
    status: 'not_needed',
    budget: { max_attempts: 2, max_candidate_nodes: 64, max_elapsed_ms: 750, output_token_budget: 1_800 },
    initial_state: state,
    final_state: state,
    attempts: [],
    improved: false,
  }
}

describe('659 — the cap reaches a real artifact through the production reader', () => {
  it('reads a degraded receipt off a serialized v2 artifact', () => {
    const cap = readGraphIntegrityCap(artifactFor(MISSING_REGION_EDGES))
    // The whole point of this suite: the real wire shape resolves, and it does
    // not fall through to the unreadable branch.
    expect(cap.status).toBe('degraded')
    expect(cap.ceiling).toBe('verify_targets')
    expect(cap.targets.flatMap((target) => target.focus_files)).toContain('src/alpha.ts')
  })

  it('control 13 — a missing unretrieved region cannot yield ready', () => {
    const graphPath = artifactFor(MISSING_REGION_EDGES)
    const uncapped = assessMadarResponseEvidence(readyInputs())
    // Without integrity the same evidence is ready. That is the defect.
    expect(uncapped.answerability.state).toBe('ready')

    const capped = assessMadarResponseEvidence({ ...readyInputs(), graphPath })
    expect(capped.answerability.state).toBe('verify_targets')
    expect(capped.answerability.verification_targets.length).toBeGreaterThan(0)
  })

  it('control 15 / P1 — a legacy artifact keeps its exact prior behaviour', () => {
    const baseline = assessMadarResponseEvidence(readyInputs())
    const legacy = assessMadarResponseEvidence({ ...readyInputs(), graphPath: legacyArtifact() })
    expect(legacy.answerability).toEqual(baseline.answerability)
    expect(legacy.agent_directive).toBe(baseline.agent_directive)
    expect(legacy.pack_confidence).toBe(baseline.pack_confidence)
    // No fabricated integrity: absence is reported as absence, not as valid.
    expect(legacy.graph_integrity).toBeUndefined()
  })

  it('control 14 — every rendering derives from the one capped computation', () => {
    const graphPath = artifactFor(MISSING_REGION_EDGES)
    const assessed = assessMadarResponseEvidence({ ...readyInputs(), graphPath })
    const built = buildMadarResponseEvidence({ ...readyInputs(), graphPath })

    // `assessMadarResponseEvidence` is the CLI and recovery entry point;
    // `buildMadarResponseEvidence` is the MCP one. Same computation, so the
    // capped answerability and the diagnostic cannot disagree between them.
    expect(built.answerability).toEqual(assessed.answerability)
    expect(built.graph_integrity).toEqual(assessed.graph_integrity)
    expect(built.agent_directive).toEqual(assessed.agent_directive)
    expect(built.pack_confidence).toEqual(assessed.pack_confidence)
  })

  it('derives pack_confidence and agent_directive from the capped state, not the uncapped one', () => {
    const graphPath = artifactFor(MISSING_REGION_EDGES)
    const uncapped = assessMadarResponseEvidence(readyInputs())
    const capped = assessMadarResponseEvidence({ ...readyInputs(), graphPath })

    expect(uncapped.agent_directive).toBe('answer_from_pack')
    // Applied before the directive is derived, so the instruction changes too.
    expect(capped.agent_directive).toBe('verify_one_targeted_file')
    expect(capped.pack_confidence).not.toBe('high')
  })

  it('control 18 — published recovery is bounded by the final answerability', () => {
    const graphPath = artifactFor(MISSING_REGION_EDGES)
    const evidence = assessMadarResponseEvidence({
      ...readyInputs(),
      graphPath,
      recovery: recoveryPlan('ready'),
    })
    expect(evidence.answerability.state).toBe('verify_targets')
    expect(evidence.recovery?.final_state).toBe('verify_targets')
    expect(evidence.recovery?.initial_state).toBe('verify_targets')
    expect(readinessRank(evidence.recovery!.final_state))
      .toBeLessThanOrEqual(readinessRank(evidence.answerability.state))
  })

  it('control 18 — an already lower recovery state is preserved, never raised', () => {
    const evidence = assessMadarResponseEvidence({
      ...readyInputs(),
      recovery: recoveryPlan('insufficient'),
    })
    expect(evidence.answerability.state).toBe('ready')
    expect(evidence.recovery?.final_state).toBe('insufficient')
  })

  it('emits a share-safe diagnostic with no absolute paths', () => {
    const graphPath = artifactFor(MISSING_REGION_EDGES)
    const evidence = assessMadarResponseEvidence({ ...readyInputs(), graphPath })
    const diagnostic = evidence.graph_integrity
    expect(diagnostic).toBeDefined()
    expect(diagnostic?.status).toBe('degraded')
    for (const target of diagnostic?.verification_targets ?? []) {
      expect(target.startsWith('/')).toBe(false)
      expect(target).not.toContain(tmpdir())
    }
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain(tmpdir())
  })

  it('is idempotent across repeated assessments of the same artifact', () => {
    const graphPath = artifactFor(MISSING_REGION_EDGES)
    const first = assessMadarResponseEvidence({ ...readyInputs(), graphPath, recovery: recoveryPlan('ready') })
    const second = assessMadarResponseEvidence({ ...readyInputs(), graphPath, recovery: recoveryPlan('ready') })
    expect(second).toEqual(first)
  })
})
