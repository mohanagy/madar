import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { serializeGraphArtifactV2, readGraphArtifactMetadata } from '../../src/contracts/graph-artifact.js'
import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  publishTransitionalGraphArtifacts,
  type TransitionalPublicationStep,
} from '../../src/infrastructure/graph-artifact-transitional.js'

const PRIOR_ARTIFACT = 'prior canonical artifact'
const PRIOR_MIRROR = '{"schema_version":1,"marker":"prior mirror"}'

function artifactBytes(nodeId: string): Buffer {
  const graph = new KnowledgeGraph({ directed: true })
  graph.addNode(nodeId, {})
  return serializeGraphArtifactV2({
    graph,
    repositoryRevision: 'rev',
    generationMode: 'full',
    generatedAt: '2026-08-15T00:00:00.000Z',
  })
}

function workspace(seeded: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'madar-transitional-'))
  if (seeded) {
    writeFileSync(join(dir, 'graph.madar'), PRIOR_ARTIFACT)
    writeFileSync(join(dir, 'graph.json'), PRIOR_MIRROR)
  }
  return dir
}

function publish(dir: string, nodeId: string, beforeStep?: (step: TransitionalPublicationStep) => void): void {
  publishTransitionalGraphArtifacts({
    outputDir: dir,
    artifactBytes: artifactBytes(nodeId),
    legacyJson: `${JSON.stringify({ schema_version: 1, nodes: [{ id: nodeId }], links: [] })}\n`,
    rootPath: '/workspace/root',
    ...(beforeStep === undefined ? {} : { beforeStep }),
  })
}

describe('transitional publication — success', () => {
  it('publishes both artifacts from the same run', () => {
    const dir = workspace(false)
    publish(dir, 'alpha')

    expect(readGraphArtifactMetadata(join(dir, 'graph.madar')).format).toBe('v2')
    const mirror = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')) as { nodes: { id: string }[] }
    expect(mirror.nodes[0]?.id).toBe('alpha')
  })

  it('writes the machine-local root only to the sidecar', () => {
    const dir = workspace(false)
    publish(dir, 'alpha')

    expect(JSON.parse(readFileSync(join(dir, 'graph.local.json'), 'utf8'))).toEqual({ root_path: '/workspace/root' })
    expect(readFileSync(join(dir, 'graph.madar'), 'utf8')).not.toContain('root_path')
  })

  it('leaves no staging file behind', () => {
    const dir = workspace(false)
    publish(dir, 'alpha')

    expect(readdirSync(dir).filter((name) => name.endsWith('.publishing'))).toEqual([])
  })
})

describe('transitional publication — validation and recoverable failure', () => {
  it('rejects an invalid candidate before touching the output directory', () => {
    const dir = workspace(false)

    expect(() => publishTransitionalGraphArtifacts({
      outputDir: dir,
      artifactBytes: Buffer.from('not an artifact'),
      legacyJson: '{}',
    })).toThrow()

    expect(existsSync(join(dir, 'graph.madar'))).toBe(false)
    expect(existsSync(join(dir, 'graph.json'))).toBe(false)
  })

  it('leaves both prior files intact when staging fails', () => {
    const dir = workspace(true)

    expect(() => publish(dir, 'alpha', (step) => {
      if (step === 'stage') throw new Error('injected staging failure')
    })).toThrow(/injected staging failure/)

    expect(readFileSync(join(dir, 'graph.madar'), 'utf8')).toBe(PRIOR_ARTIFACT)
    expect(readFileSync(join(dir, 'graph.json'), 'utf8')).toBe(PRIOR_MIRROR)
  })

  it('restores the canonical artifact when the mirror rename fails', () => {
    const dir = workspace(true)

    expect(() => publish(dir, 'alpha', (step) => {
      if (step === 'rename_mirror') throw new Error('injected mirror rename failure')
    })).toThrow(/injected mirror rename failure/)

    // The canonical rename already happened, so the unwind must put the prior
    // artifact back rather than leaving a half-published pair.
    expect(readFileSync(join(dir, 'graph.madar'), 'utf8')).toBe(PRIOR_ARTIFACT)
    expect(readFileSync(join(dir, 'graph.json'), 'utf8')).toBe(PRIOR_MIRROR)
    expect(readdirSync(dir).filter((name) => name.endsWith('.publishing'))).toEqual([])
  })

  it('publishes canonical-first so the mirror can only lag, never lead', () => {
    const dir = workspace(true)
    const order: TransitionalPublicationStep[] = []

    publish(dir, 'alpha', (step) => { order.push(step) })

    // Order is load-bearing: an advanced mirror would be the newest thing on
    // disk and old readers would consume it as authoritative. A lagging mirror
    // is safe because current readers prefer the canonical artifact.
    expect(order).toEqual(['stage', 'rename_canonical', 'rename_mirror'])
  })
})

describe('transitional publication — abrupt-termination semantics', () => {
  it('documents, rather than prevents, a lagging mirror after the canonical rename', () => {
    const dir = workspace(true)

    // Simulate abrupt termination between the two renames: the canonical
    // artifact has advanced and no unwind ran. Two paths cannot be renamed as
    // one transaction, so this state is reachable and must stay safe.
    publishTransitionalGraphArtifacts({
      outputDir: dir,
      artifactBytes: artifactBytes('advanced'),
      legacyJson: PRIOR_MIRROR,
    })
    writeFileSync(join(dir, 'graph.json'), PRIOR_MIRROR)

    const metadata = readGraphArtifactMetadata(join(dir, 'graph.json'))

    // A current reader still resolves the canonical artifact, so the stale
    // mirror cannot change what it sees.
    expect(metadata.format).toBe('v2')
  })

  it('keeps a stale mirror from changing new-reader results', () => {
    const dir = workspace(false)
    publish(dir, 'alpha')
    writeFileSync(
      join(dir, 'graph.json'),
      JSON.stringify({ schema_version: 1, nodes: [{ id: 'stale' }], links: [] }),
    )

    expect(readGraphArtifactMetadata(join(dir, 'graph.json')).format).toBe('v2')
  })
})
