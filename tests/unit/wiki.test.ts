import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { toWiki } from '../../src/pipeline/wiki.js'

function withTempDir(callback: (tempDir: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'sadeem-wiki-'))
  try {
    callback(tempDir)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('n1', { label: 'parse', file_type: 'code', source_file: 'parser.py', community: 0 })
  graph.addNode('n2', { label: 'validate', file_type: 'code', source_file: 'parser.py', community: 0 })
  graph.addNode('n3', { label: 'render', file_type: 'code', source_file: 'renderer.py', community: 1 })
  graph.addNode('n4', { label: 'stream', file_type: 'code', source_file: 'renderer.py', community: 1 })
  graph.addEdge('n1', 'n2', { relation: 'calls', confidence: 'EXTRACTED', weight: 1.0 })
  graph.addEdge('n1', 'n3', { relation: 'references', confidence: 'INFERRED', weight: 1.0 })
  graph.addEdge('n3', 'n4', { relation: 'calls', confidence: 'EXTRACTED', weight: 1.0 })
  return graph
}

const COMMUNITIES = { 0: ['n1', 'n2'], 1: ['n3', 'n4'] }
const LABELS = { 0: 'Parsing Layer', 1: 'Rendering Layer' }
const COHESION = { 0: 0.85, 1: 0.72 }
const GOD_NODES = [{ id: 'n1', label: 'parse', edges: 2 }]

describe('toWiki', () => {
  test('writes an index and returns article count', () => {
    withTempDir((tempDir) => {
      const count = toWiki(makeGraph(), COMMUNITIES, tempDir, { communityLabels: LABELS, cohesion: COHESION, godNodes: GOD_NODES })
      expect(count).toBe(3)
      expect(existsSync(join(tempDir, 'index.md'))).toBe(true)
    })
  })

  test('creates community and god node articles', () => {
    withTempDir((tempDir) => {
      toWiki(makeGraph(), COMMUNITIES, tempDir, { communityLabels: LABELS, godNodes: GOD_NODES })
      expect(existsSync(join(tempDir, 'Parsing_Layer.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'Rendering_Layer.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'parse.md'))).toBe(true)
    })
  })

  test('indexes communities and god nodes', () => {
    withTempDir((tempDir) => {
      toWiki(makeGraph(), COMMUNITIES, tempDir, { communityLabels: LABELS, godNodes: GOD_NODES })
      const index = readFileSync(join(tempDir, 'index.md'), 'utf8')
      expect(index).toContain('[[Parsing Layer]]')
      expect(index).toContain('[[Rendering Layer]]')
      expect(index).toContain('[[parse]]')
      expect(index).toContain('2 connections')
    })
  })

  test('includes cross-community links, cohesion, and audit trail in community articles', () => {
    withTempDir((tempDir) => {
      toWiki(makeGraph(), COMMUNITIES, tempDir, { communityLabels: LABELS, cohesion: COHESION })
      const article = readFileSync(join(tempDir, 'Parsing_Layer.md'), 'utf8')
      expect(article).toContain('[[Rendering Layer]]')
      expect(article).toContain('cohesion 0.85')
      expect(article).toContain('EXTRACTED')
      expect(article).toContain('INFERRED')
      expect(article).toContain('[[index]]')
    })
  })

  test('skips missing god node ids safely', () => {
    withTempDir((tempDir) => {
      const count = toWiki(makeGraph(), COMMUNITIES, tempDir, { communityLabels: LABELS, godNodes: [{ id: 'missing', label: 'ghost', edges: 99 }] })
      expect(count).toBe(2)
    })
  })

  test('falls back to default community labels', () => {
    withTempDir((tempDir) => {
      toWiki(makeGraph(), COMMUNITIES, tempDir)
      expect(existsSync(join(tempDir, 'Community_0.md'))).toBe(true)
      expect(existsSync(join(tempDir, 'Community_1.md'))).toBe(true)
    })
  })

  test('counts directed incoming links in community articles', () => {
    withTempDir((tempDir) => {
      const directedGraph = new KnowledgeGraph({ directed: true })
      directedGraph.addNode('n1', { label: 'parse', file_type: 'code', source_file: 'parser.py', community: 0 })
      directedGraph.addNode('n2', { label: 'render', file_type: 'code', source_file: 'renderer.py', community: 1 })
      directedGraph.addEdge('n2', 'n1', { relation: 'feeds', confidence: 'INFERRED', weight: 1.0 })

      toWiki(directedGraph, { 0: ['n1'], 1: ['n2'] }, tempDir, { communityLabels: LABELS })
      const article = readFileSync(join(tempDir, 'Parsing_Layer.md'), 'utf8')

      expect(article).toContain('[[Rendering Layer]]')
      expect(article).toContain('INFERRED')
    })
  })

  test('shows incoming directed relations in god node articles', () => {
    withTempDir((tempDir) => {
      const directedGraph = new KnowledgeGraph({ directed: true })
      directedGraph.addNode('n1', { label: 'parse', file_type: 'code', source_file: 'parser.py', community: 0 })
      directedGraph.addNode('n2', { label: 'render', file_type: 'code', source_file: 'renderer.py', community: 1 })
      directedGraph.addEdge('n2', 'n1', { relation: 'feeds', confidence: 'INFERRED', weight: 1.0 })

      toWiki(directedGraph, { 0: ['n1'], 1: ['n2'] }, tempDir, {
        communityLabels: LABELS,
        godNodes: [{ id: 'n1', label: 'parse', edges: 1 }],
      })
      const article = readFileSync(join(tempDir, 'parse.md'), 'utf8')

      expect(article).toContain('### feeds')
      expect(article).toContain('← [[render]] `INFERRED`')
    })
  })
})
