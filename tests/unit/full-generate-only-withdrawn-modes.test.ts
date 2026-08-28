import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { generateGraph, UnsupportedGenerationModeError } from '../../src/infrastructure/generate.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — withdrawn continuation modes.
 *
 * The decision must happen before any persisted semantic state is read and
 * before any artifact is published or modified.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-722-modes-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fx","type":"module"}\n')
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
  }))
  writeFileSync(join(root, 'src/a.ts'), 'export const alpha = 1\nexport function realSymbol(){return alpha}\n')
  return root
}

describe('#722 withdrawn continuation modes', () => {
  it('--cluster-only refuses with a typed result and publishes nothing', () => {
    const root = fixture()
    const first = generateGraph(root, { extractionMode: 'auto', noHtml: true })
    const before = readFileSync(first.graphPath)

    expect(() => generateGraph(root, { clusterOnly: true, noHtml: true }))
      .toThrow(UnsupportedGenerationModeError)

    // the prior durable artifact is untouched and no partial output remains
    expect(readFileSync(first.graphPath).equals(before)).toBe(true)
    expect(existsSync(join(root, 'out/graph.madar.tmp'))).toBe(false)
  })

  it('--cluster-only carries the declared typed code', () => {
    const root = fixture()
    generateGraph(root, { extractionMode: 'auto', noHtml: true })
    try {
      generateGraph(root, { clusterOnly: true, noHtml: true })
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedGenerationModeError)
      expect((error as UnsupportedGenerationModeError).code).toBe('UNSUPPORTED_GENERATION_MODE')
      expect((error as UnsupportedGenerationModeError).mode).toBe('cluster-only')
    }
  })

  it('--update performs a full fresh generation rather than continuing', () => {
    const root = fixture()
    const ordinary = generateGraph(root, { extractionMode: 'auto', noHtml: true })
    const updated = generateGraph(root, { update: true, extractionMode: 'auto', noHtml: true })

    // same work as an ordinary run: nothing is retained from the prior graph
    expect(updated.extractedFiles).toBe(ordinary.extractedFiles)
    expect(updated.nodeCount).toBe(ordinary.nodeCount)
    expect(updated.mode).toBe('generate')
  })
})
