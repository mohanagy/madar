import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  GRAPH_ARTIFACT_V2_HEADER,
  GRAPH_ARTIFACT_V2_TOMBSTONE,
} from '../../src/contracts/graph-artifact.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { federate } from '../../src/pipeline/federate.js'

function cutOverWorkspace(name: string, source: string): string {
  const root = mkdtempSync(join(tmpdir(), `federate-${name}-`))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', `${name}.ts`), source)
  generateGraph(root, { noHtml: true })
  return root
}

describe('federating workspaces that have been cut over', () => {
  it('reads canonical artifacts and publishes a canonical artifact', () => {
    const alpha = cutOverWorkspace('alpha', 'export function alpha() { alphaHelper() }\nexport function alphaHelper() {}\n')
    const beta = cutOverWorkspace('beta', 'export function beta() { betaHelper() }\nexport function betaHelper() {}\n')
    const outputDir = mkdtempSync(join(tmpdir(), 'federate-out-'))

    try {
      // Both sources are real cut-over workspaces: graph.json is a tombstone
      // and the graph lives in graph.madar. Federation used to parse the given
      // file as bare JSON, so this combination could not be read at all.
      expect(readFileSync(join(alpha, 'out', 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)

      const result = federate(
        [join(alpha, 'out', 'graph.madar'), join(beta, 'out', 'graph.madar')],
        { outputDir },
      )

      expect(result.repos).toHaveLength(2)
      expect(result.totalNodes).toBeGreaterThan(0)

      // Output follows the same contract as a generated workspace.
      expect(result.graphPath).toBe(join(outputDir, 'graph.madar'))
      expect(readFileSync(result.graphPath, 'utf8').startsWith(GRAPH_ARTIFACT_V2_HEADER)).toBe(true)
      expect(readFileSync(join(outputDir, 'graph.json'), 'utf8')).toBe(GRAPH_ARTIFACT_V2_TOMBSTONE)
      // Read the artifact directly rather than through loadGraph: that helper
      // sandboxes reads to the repository's own out/, and federated output is
      // deliberately written elsewhere.
      const payload = JSON.parse(
        readFileSync(result.graphPath, 'utf8').slice(GRAPH_ARTIFACT_V2_HEADER.length),
      ) as { nodes: unknown[] }
      expect(payload.nodes).toHaveLength(result.totalNodes)
    } finally {
      for (const path of [alpha, beta, outputDir]) rmSync(path, { recursive: true, force: true })
    }
  })

  it('accepts the legacy path of a cut-over workspace', () => {
    const alpha = cutOverWorkspace('alpha', 'export function alpha() {}\n')
    const beta = cutOverWorkspace('beta', 'export function beta() {}\n')
    const outputDir = mkdtempSync(join(tmpdir(), 'federate-out-'))

    try {
      // A caller handing over out/graph.json means "this workspace", not
      // "this exact tombstone", and resolution is shared with every other
      // reader rather than restated in federation.
      const result = federate(
        [join(alpha, 'out', 'graph.json'), join(beta, 'out', 'graph.json')],
        { outputDir },
      )

      expect(result.totalNodes).toBeGreaterThan(0)
    } finally {
      for (const path of [alpha, beta, outputDir]) rmSync(path, { recursive: true, force: true })
    }
  })
})
