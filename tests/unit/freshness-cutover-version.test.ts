import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GRAPH_ARTIFACT_V2_TOMBSTONE } from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { graphFreshnessMetadata } from '../../src/runtime/freshness.js'

function workspaceWith(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'freshness-cutover-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), source)
  generateGraph(root, { noHtml: true })
  return root
}

describe('graph version after the cutover', () => {
  it('distinguishes different graphs when addressed by the legacy path', () => {
    const alpha = workspaceWith('export function alpha() {}\n')
    const beta = workspaceWith('export function beta() { gamma() }\nexport function gamma() {}\n')

    try {
      // Both legacy paths now hold the same constant tombstone. Hashing the
      // requested file made every workspace report one identical version that
      // never changed when the graph did -- staleness detection failing
      // silently, which is the worst way for it to fail.
      expect(readFileSync(join(alpha, 'out', 'graph.json'), 'utf8'))
        .toBe(readFileSync(join(beta, 'out', 'graph.json'), 'utf8'))

      const alphaVersion = graphFreshnessMetadata(join(alpha, 'out', 'graph.json')).graphVersion
      const betaVersion = graphFreshnessMetadata(join(beta, 'out', 'graph.json')).graphVersion

      expect(alphaVersion).not.toBe(betaVersion)
    } finally {
      rmSync(alpha, { recursive: true, force: true })
      rmSync(beta, { recursive: true, force: true })
    }
  })

  it('reports the same version through the legacy and canonical paths', () => {
    const root = workspaceWith('export function alpha() {}\n')

    try {
      // Freshness must describe the artifact readers actually consume, so
      // which spelling the caller used cannot change the answer.
      expect(graphFreshnessMetadata(join(root, 'out', 'graph.json')).graphVersion)
        .toBe(graphFreshnessMetadata(join(root, 'out', 'graph.madar')).graphVersion)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('changes when the graph changes', () => {
    const root = workspaceWith('export function alpha() {}\n')

    try {
      const before = graphFreshnessMetadata(join(root, 'out', 'graph.json')).graphVersion
      writeFileSync(join(root, 'src', 'b.ts'), 'export function added() {}\n')
      generateGraph(root, { noHtml: true })

      expect(graphFreshnessMetadata(join(root, 'out', 'graph.json')).graphVersion).not.toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still reads a pre-cutover v1 workspace from the legacy path', () => {
    const root = mkdtempSync(join(tmpdir(), 'freshness-legacy-'))
    const out = join(root, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'graph.json'),
      JSON.stringify({ schema_version: 1, directed: true, nodes: [{ id: 'a' }], links: [] }),
    )

    try {
      // A workspace that never cut over has no canonical artifact, so the
      // legacy file is still the right thing to hash.
      expect(graphFreshnessMetadata(join(out, 'graph.json')).graphVersion).toMatch(/^[0-9a-f]{12}$/)
      expect(readFileSync(join(out, 'graph.json'), 'utf8')).not.toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
