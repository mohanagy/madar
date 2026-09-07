import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExtractionData } from '../../src/contracts/types.js'
import type { SemanticProgramIndex } from '../../src/pipeline/spi/types.js'

const compositionControls = vi.hoisted(() => ({
  legacyTransform: undefined as ((extraction: ExtractionData) => ExtractionData) | undefined,
  spiTransform: undefined as ((spi: SemanticProgramIndex) => SemanticProgramIndex) | undefined,
}))

vi.mock('../../src/pipeline/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pipeline/extract.js')>()
  return {
    ...actual,
    extract: (...args: Parameters<typeof actual.extract>) => {
      const extraction = actual.extract(...args)
      return compositionControls.legacyTransform
        ? compositionControls.legacyTransform(structuredClone(extraction))
        : extraction
    },
  }
})

vi.mock('../../src/pipeline/spi/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pipeline/spi/cache.js')>()
  return {
    ...actual,
    buildSpiCached: (options: Parameters<typeof actual.buildSpiCached>[0]) => {
      const built = actual.buildSpiCached(options)
      return compositionControls.spiTransform
        ? { ...built, spi: compositionControls.spiTransform(structuredClone(built.spi)) }
        : built
    },
  }
})

import { generateGraph } from '../../src/infrastructure/generate.js'
import { readGeneratedGraphJson } from './helpers/generated-graph.js'

type GraphNode = Record<string, unknown> & {
  id: string
  label: string
  source_file: string
  source_location?: string
  snippet?: string
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = join(root, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

function generatedNodes(root: string, mode: 'auto' | 'legacy' | 'spi' = 'auto'): GraphNode[] {
  const result = generateGraph(root, { extractionMode: mode, noHtml: true })
  return (readGeneratedGraphJson(result.graphPath) as unknown as { nodes: GraphNode[] }).nodes
}

function nodeByLabel(nodes: GraphNode[], label: string): GraphNode {
  const matches = nodes.filter((node) => node.label === label)
  expect(matches, `expected one generated node labelled ${label}`).toHaveLength(1)
  return matches[0]!
}

describe('default-auto source composition', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'generate-auto-source-'))
    compositionControls.legacyTransform = undefined
    compositionControls.spiTransform = undefined
  })

  afterEach(() => {
    compositionControls.legacyTransform = undefined
    compositionControls.spiTransform = undefined
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('preserves verified generated source on the SPI node', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import express from "express"',
      'export const app = express()',
      'export function owned(): number {',
      '  return 1',
      '}',
      'app.get("/owned", owned)',
    ].join('\n') + '\n')

    const nodes = generatedNodes(sandbox)
    const owned = nodeByLabel(nodes, 'owned()')
    expect(owned).toMatchObject({
      framework: 'express',
      framework_role: 'express_route',
      route_path: '/owned',
      extraction_strategy: 'spi',
      source_location: 'L3-L5',
      snippet: 'export function owned(): number {\n  return 1\n}',
    })
    expect(owned.provenance).toEqual([
      expect.objectContaining({
        source_file: join(sandbox, 'src/server.ts'),
        source_location: 'L3',
      }),
    ])
  })

  it('rejects wrong-path legacy source ownership', () => {
    writeFile(sandbox, 'src/owner.ts', 'export function owned(): number { return 1 }\n')
    compositionControls.legacyTransform = (extraction) => ({
      ...extraction,
      nodes: extraction.nodes.map((node) => node.label === 'owned()'
        ? {
            ...node,
            source_file: join(sandbox, '..', 'foreign.ts'),
            snippet: 'export function owned(): number { return 999 }',
          }
        : node),
    })

    const owned = nodeByLabel(generatedNodes(sandbox), 'owned()')
    expect(owned.source_file).toBe(join(sandbox, 'src/owner.ts'))
    expect(owned.source_location).toBe('L1')
    expect(owned.snippet).toBeUndefined()
  })

  it.each([
    ['wrong start', 'L2'],
    ['reversed range', 'L2-L1'],
    ['out-of-anchor range', 'L1-L9'],
    ['malformed range', 'line 1'],
  ])('rejects a %s in legacy source evidence', (_label, sourceLocation) => {
    writeFile(sandbox, 'src/owner.ts', 'export function owned(): number { return 1 }\n')
    compositionControls.legacyTransform = (extraction) => ({
      ...extraction,
      nodes: extraction.nodes.map((node) => node.label === 'owned()'
        ? { ...node, source_location: sourceLocation, snippet: 'export function owned(): number { return 999 }' }
        : node),
    })

    const owned = nodeByLabel(generatedNodes(sandbox), 'owned()')
    expect(owned.source_location).toBe('L1')
    expect(owned.snippet).toBeUndefined()
  })

  it('rejects duplicate legacy declarations and unnormalized snippets', () => {
    writeFile(sandbox, 'src/owner.ts', 'export function owned(): number { return 1 }\n')
    compositionControls.legacyTransform = (extraction) => {
      const owned = extraction.nodes.find((node) => node.label === 'owned()')!
      return {
        ...extraction,
        nodes: [
          ...extraction.nodes,
          { ...owned, snippet: 'export function owned(): number { return 999 }' },
        ],
      }
    }
    expect(nodeByLabel(generatedNodes(sandbox), 'owned()').snippet).toBeUndefined()

    rmSync(join(sandbox, '.madar'), { recursive: true, force: true })
    compositionControls.legacyTransform = (extraction) => ({
      ...extraction,
      nodes: extraction.nodes.map((node) => node.label === 'owned()'
        ? { ...node, snippet: `export function owned() {${'x'.repeat(1_980)}...x` }
        : node),
    })
    expect(nodeByLabel(generatedNodes(sandbox), 'owned()').snippet).toBeUndefined()

    rmSync(join(sandbox, '.madar'), { recursive: true, force: true })
    compositionControls.legacyTransform = (extraction) => ({
      ...extraction,
      nodes: extraction.nodes.map((node) => node.label === 'owned()'
        ? { ...node, snippet: 'export function owned(): number {\r\n return 1\r\n}' }
        : node),
    })
    expect(nodeByLabel(generatedNodes(sandbox), 'owned()').snippet).toBeUndefined()
  })

  it('rejects overload and same-line declaration ambiguity', () => {
    writeFile(sandbox, 'src/ambiguous.ts', [
      'export function overloaded(value: string): string',
      'export function overloaded(value: number): number',
      'export function overloaded(value: string | number): string | number { return value }',
      'export const alpha = 1, beta = 2',
    ].join('\n') + '\n')

    const nodes = generatedNodes(sandbox)
    expect(nodeByLabel(nodes, 'overloaded()').snippet).toBeUndefined()
    expect(nodeByLabel(nodes, 'alpha').snippet).toBeUndefined()
    expect(nodeByLabel(nodes, 'beta').snippet).toBeUndefined()
  })

  it('uses SPI exclusive ends without guessing invalid coordinates', () => {
    writeFile(sandbox, 'src/owner.ts', [
      'export function owned(): number {',
      '  return 1',
      '}',
    ].join('\n') + '\n')
    compositionControls.spiTransform = (spi) => ({
      ...spi,
      symbols: spi.symbols.map((symbol) => symbol.name === 'owned'
        ? { ...symbol, range: { ...symbol.range, end: { line: 4, column: 1 } } }
        : symbol),
    })
    expect(nodeByLabel(generatedNodes(sandbox), 'owned()')).toMatchObject({
      source_location: 'L1-L3',
      snippet: 'export function owned(): number {\n  return 1\n}',
    })

    rmSync(join(sandbox, '.madar'), { recursive: true, force: true })
    compositionControls.spiTransform = (spi) => ({
      ...spi,
      symbols: spi.symbols.map((symbol) => symbol.name === 'owned'
        ? { ...symbol, range: { ...symbol.range, end: { ...symbol.range.start } } }
        : symbol),
    })
    const invalid = nodeByLabel(generatedNodes(sandbox), 'owned()')
    expect(invalid.source_location).toBe('L1')
    expect(invalid.snippet).toBeUndefined()
  })

  it('preserves first/last, one-line, CRLF, 25/26-line, and 2003-character legacy bytes', () => {
    const cases: Array<{ name: string; content: string }> = [
      { name: 'oneLine', content: 'export function oneLine(): number { return 1 }' },
      { name: 'crlfOwner', content: 'export function crlfOwner(): number {\r\n  return 1\r\n}' },
      {
        name: 'lines25',
        content: ['export function lines25(): number {', ...Array.from({ length: 23 }, (_, index) => `  const value${index} = ${index}`), '}'].join('\n'),
      },
      {
        name: 'lines26',
        content: ['export function lines26(): number {', ...Array.from({ length: 24 }, (_, index) => `  const value${index} = ${index}`), '}'].join('\n'),
      },
      {
        name: 'chars2003',
        content: `export function chars2003(): string { return '${'x'.repeat(2_050)}' }`,
      },
    ]

    for (const testCase of cases) {
      const autoRoot = join(sandbox, `auto-${testCase.name}`)
      const legacyRoot = join(sandbox, `legacy-${testCase.name}`)
      writeFile(autoRoot, 'src/input.ts', testCase.content)
      writeFile(legacyRoot, 'src/input.ts', testCase.content)
      const autoNode = nodeByLabel(generatedNodes(autoRoot), `${testCase.name}()`)
      const legacyNode = nodeByLabel(generatedNodes(legacyRoot, 'legacy'), `${testCase.name}()`)
      expect({ location: autoNode.source_location, snippet: autoNode.snippet }).toEqual({
        location: legacyNode.source_location,
        snippet: legacyNode.snippet,
      })
    }

    const lines25 = nodeByLabel(generatedNodes(join(sandbox, 'auto-lines25')), 'lines25()')
    const lines26 = nodeByLabel(generatedNodes(join(sandbox, 'auto-lines26')), 'lines26()')
    const chars2003 = nodeByLabel(generatedNodes(join(sandbox, 'auto-chars2003')), 'chars2003()')
    expect(lines25.snippet?.split('\n')).toHaveLength(25)
    expect(lines26.source_location).toBe('L1-L26')
    expect(lines26.snippet?.split('\n')).toHaveLength(25)
    expect(chars2003.snippet).toHaveLength(2_003)
    expect(chars2003.snippet?.endsWith('...')).toBe(true)
  }, 60_000)

  it('does not enrich a synthetic external call or alter explicit SPI behavior', () => {
    const source = [
      'import { readFileSync } from "node:fs"',
      'export function owned(): string {',
      '  return readFileSync("missing", "utf8")',
      '}',
    ].join('\n') + '\n'
    writeFile(sandbox, 'src/owner.ts', source)
    const autoNodes = generatedNodes(sandbox)
    const external = autoNodes.find((node) => node.label === 'readFileSync()')
    expect(external?.snippet).toBeUndefined()

    const spiRoot = join(sandbox, 'explicit-spi')
    writeFile(spiRoot, 'src/owner.ts', source)
    const explicitSpi = nodeByLabel(generatedNodes(spiRoot, 'spi'), 'owned()')
    expect(explicitSpi.source_location).toBe('L2')
    expect(explicitSpi.snippet).toBeUndefined()
  })

  it('persists identical source evidence across cold, warm, and canonical reloads', () => {
    writeFile(sandbox, 'src/owner.ts', [
      'export function owned(): number {',
      '  return 1',
      '}',
    ].join('\n') + '\n')
    const cold = generateGraph(sandbox, { extractionMode: 'auto', noHtml: true })
    const coldGraph = readGeneratedGraphJson(cold.graphPath) as unknown as { nodes: GraphNode[] }
    const warm = generateGraph(sandbox, { extractionMode: 'auto', noHtml: true })
    const warmGraph = readGeneratedGraphJson(warm.graphPath) as unknown as { nodes: GraphNode[] }
    expect(cold.cache?.hit).toBe(false)
    expect(warm.cache?.hit).toBe(true)
    expect(nodeByLabel(warmGraph.nodes, 'owned()')).toMatchObject({
      source_location: 'L1-L3',
      snippet: 'export function owned(): number {\n  return 1\n}',
    })
    expect(warmGraph.nodes.map(({ id, source_file, source_location, snippet }) => ({ id, source_file, source_location, snippet })))
      .toEqual(coldGraph.nodes.map(({ id, source_file, source_location, snippet }) => ({ id, source_file, source_location, snippet })))
  })
})
