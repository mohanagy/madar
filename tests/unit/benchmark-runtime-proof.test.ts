import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import { retrieveBenchmarkContext } from '../../tools/eval/lib/infrastructure/benchmark/runtime-proof.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('benchmark retrieval adapter', () => {
  it('uses the production evidence query from the authenticated graph root', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-benchmark-retrieve-'))
    roots.push(root)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'repository.ts'),
      'export function storeInvoice(id: string): string { return `stored:${id}` }\n',
      'utf8',
    )
    writeFileSync(
      join(root, 'src', 'service.ts'),
      [
        "import { storeInvoice } from './repository.js'",
        'export function processInvoice(id: string): string {',
        '  return storeInvoice(id)',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    const generated = generateIndex(root)
    const graph = loadGraphArtifact(generated.graphPath)
    const originalCwd = process.cwd()

    const result = retrieveBenchmarkContext(
      graph,
      generated.graphPath,
      'How does process invoice call store invoice?',
      4_000,
    )

    expect(process.cwd()).toBe(originalCwd)
    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining(['processInvoice()', 'storeInvoice()']),
    )
  })
})
