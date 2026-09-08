import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import {
  compactRetrieveResultForStdio,
  retrieveContext,
} from '../../src/runtime/retrieve.js'
import { loadGraph } from '../../src/runtime/serve.js'

const QUESTION = 'Why can the displayed estimate differ from the charged total?'
const roots: string[] = []

interface GeneratedNode extends Record<string, unknown> {
  id: string
  label: string
  source_file: string
}

interface MatchedSourceNode {
  node_id?: string
  snippet: string | null
}

function isolatedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'retrieve-generated-source-'))
  roots.push(root)
  return root
}

function writeSource(root: string, relativePath: string, source: string): void {
  const sourceFile = join(root, relativePath)
  mkdirSync(dirname(sourceFile), { recursive: true })
  writeFileSync(sourceFile, source, 'utf8')
}

function nodesFromGraph(graph: ReturnType<typeof loadGraph>): GeneratedNode[] {
  return graph.nodeEntries().map(([id, attributes]) => ({ id, ...attributes }) as GeneratedNode)
}

function oneNode(nodes: readonly GeneratedNode[], label: string, relativePath: string): GeneratedNode {
  const matches = nodes.filter(
    (node) => node.label === label && node.source_file.replaceAll('\\', '/').endsWith(relativePath),
  )
  expect(matches, `expected one ${label} node in ${relativePath}`).toHaveLength(1)
  return matches[0]!
}

function oneMatched(nodes: readonly MatchedSourceNode[], nodeId: string): MatchedSourceNode {
  const matches = nodes.filter((node) => node.node_id === nodeId)
  expect(matches, `expected retrieved node ${nodeId}`).toHaveLength(1)
  return matches[0]!
}

function expectSnippetLines(snippet: string | null, lines: readonly string[]): void {
  const actualLines = snippet?.split('\n') ?? []
  for (const line of lines) {
    expect(actualLines).toContain(line)
  }
}

function writeRoundingLayout(root: string, layout: 'same-file' | 'relative-import'): {
  ownerFile: string
  helperFile: string
  ownerLocation: string
  ownerConst: string
  ownerReturn: string
} {
  const firstHelper = 'export function readSavedValue(value) { return Math.floor(value); }'
  const secondHelper = 'export function rebuildValue(value) { return Math.ceil(value); }'
  if (layout === 'same-file') {
    writeSource(root, 'src/engine.js', [
      firstHelper,
      secondHelper,
      'export function assemble() {',
      '  const input = 12.5;',
      '  return { displayedEstimate: readSavedValue(input), chargedTotal: rebuildValue(input) };',
      '}',
    ].join('\n') + '\n')
    return {
      ownerFile: '/src/engine.js',
      helperFile: '/src/engine.js',
      ownerLocation: 'L3-L6',
      ownerConst: 'L4:   const input = 12.5;',
      ownerReturn: 'L5:   return { displayedEstimate: readSavedValue(input), chargedTotal: rebuildValue(input) };',
    }
  }

  writeSource(root, 'src/rounding.js', `${firstHelper}\n${secondHelper}\n`)
  writeSource(root, 'src/engine.js', [
    "import { readSavedValue, rebuildValue } from './rounding.js';",
    'export function assemble() {',
    '  const input = 12.5;',
    '  return { displayedEstimate: readSavedValue(input), chargedTotal: rebuildValue(input) };',
    '}',
  ].join('\n') + '\n')
  return {
    ownerFile: '/src/engine.js',
    helperFile: '/src/rounding.js',
    ownerLocation: 'L2-L5',
    ownerConst: 'L3:   const input = 12.5;',
    ownerReturn: 'L4:   return { displayedEstimate: readSavedValue(input), chargedTotal: rebuildValue(input) };',
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('fresh generated source evidence', () => {
  it('authenticates a complete generated owner range without fabricating line_number', () => {
    const root = isolatedRoot()
    const layout = writeRoundingLayout(root, 'same-file')
    const generated = generateGraph(root, { noHtml: true })
    const graph = loadGraph(generated.graphPath)
    const owner = oneNode(nodesFromGraph(graph), 'assemble()', layout.ownerFile)

    expect(owner.source_location).toBe(layout.ownerLocation)
    expect(owner).not.toHaveProperty('line_number')

    const raw = retrieveContext(graph, { question: QUESTION, budget: 4_000 })
    const compact = compactRetrieveResultForStdio(raw)
    expectSnippetLines(oneMatched(raw.matched_nodes, owner.id).snippet, [layout.ownerConst, layout.ownerReturn])
    expectSnippetLines(oneMatched(compact.matched_nodes, owner.id).snippet, [layout.ownerConst, layout.ownerReturn])
  })

  it.each(['same-file', 'relative-import'] as const)(
    'preserves external-call owners through default generation, canonical reload, and retrieval: %s',
    (layoutName) => {
      const root = isolatedRoot()
      const layout = writeRoundingLayout(root, layoutName)
      const firstSource = 'export function readSavedValue(value) { return Math.floor(value); }'
      const secondSource = 'export function rebuildValue(value) { return Math.ceil(value); }'

      const cold = generateGraph(root, { noHtml: true })
      const warm = generateGraph(root, { noHtml: true })
      expect(cold.cache?.hit).toBe(false)
      expect(warm.cache?.hit).toBe(true)

      const graph = loadGraph(warm.graphPath)
      const nodes = nodesFromGraph(graph)
      const owner = oneNode(nodes, 'assemble()', layout.ownerFile)
      const first = oneNode(nodes, 'readSavedValue()', layout.helperFile)
      const second = oneNode(nodes, 'rebuildValue()', layout.helperFile)
      const floor = oneNode(nodes, 'Math.floor', layout.helperFile)
      const ceil = oneNode(nodes, 'Math.ceil', layout.helperFile)

      expect(owner).toMatchObject({ source_location: layout.ownerLocation })
      expect(first).toMatchObject({ source_location: 'L1', snippet: firstSource })
      expect(second).toMatchObject({ source_location: 'L2', snippet: secondSource })
      expect(first).not.toHaveProperty('line_number')
      expect(second).not.toHaveProperty('line_number')
      expect(floor).toMatchObject({ source_location: 'L1', external_call: true })
      expect(ceil).toMatchObject({ source_location: 'L2', external_call: true })
      expect(floor).not.toHaveProperty('snippet')
      expect(ceil).not.toHaveProperty('snippet')

      const raw = retrieveContext(graph, { question: QUESTION, budget: 4_000 })
      const compact = compactRetrieveResultForStdio(raw)
      const firstRetrievedSource = layoutName === 'same-file' ? `L1: ${firstSource}` : firstSource
      const secondRetrievedSource = layoutName === 'same-file' ? `L2: ${secondSource}` : secondSource
      for (const result of [raw, compact]) {
        expectSnippetLines(oneMatched(result.matched_nodes, owner.id).snippet, [layout.ownerConst, layout.ownerReturn])
        expectSnippetLines(oneMatched(result.matched_nodes, first.id).snippet, [firstRetrievedSource])
        expectSnippetLines(oneMatched(result.matched_nodes, second.id).snippet, [secondRetrievedSource])
      }
    },
    60_000,
  )

  it('preserves an ordinary non-rounding declaration beside its synthetic external call', () => {
    const root = isolatedRoot()
    const source = 'export function serializeLedger(value) { return JSON.stringify(value); }'
    writeSource(root, 'src/ledger.js', `${source}\n`)

    const generated = generateGraph(root, { noHtml: true })
    const graph = loadGraph(generated.graphPath)
    const nodes = nodesFromGraph(graph)
    const owner = oneNode(nodes, 'serializeLedger()', '/src/ledger.js')
    const external = oneNode(nodes, 'JSON.stringify', '/src/ledger.js')

    expect(owner).toMatchObject({ source_location: 'L1', snippet: source })
    expect(owner).not.toHaveProperty('line_number')
    expect(external).toMatchObject({ source_location: 'L1', external_call: true })
    expect(external).not.toHaveProperty('snippet')
  })
})
