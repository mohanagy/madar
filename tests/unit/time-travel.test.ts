import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'
import { compareTimeTravelGraphs, formatTimeTravelResult } from '../../src/runtime/time-travel.js'

function buildBeforeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('mobile', { label: 'MobileClient', source_file: '/src/mobile.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('auth', { label: 'AuthService', source_file: '/src/auth.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('session', { label: 'SessionStore', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })

  graph.addEdge('web', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/web.ts' })
  graph.addEdge('mobile', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/mobile.ts' })
  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/session.ts' })

  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'Data Layer',
    2: 'App Layer',
  }

  return graph
}

function buildAfterGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('mobile', { label: 'MobileClient', source_file: '/src/mobile.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('auth', { label: 'AuthService', source_file: '/src/auth.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('session', { label: 'SessionStore', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('guide', { label: 'MigrationGuide', source_file: '/docs/migration.md', node_kind: 'document', file_type: 'document', community: 3 })

  graph.addEdge('web', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/web.ts' })
  graph.addEdge('mobile', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/mobile.ts' })
  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/session.ts' })

  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'Security Layer',
    2: 'App Layer',
    3: 'Docs',
  }

  return graph
}

describe('time travel runtime', () => {
  it('builds a summary view from graph deltas', () => {
    const result = compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'summary', limit: 5 })

    expect(result.summary.headline).toContain('changed')
    expect(result.changed.communities).toContainEqual(expect.objectContaining({ community: 0 }))
  })

  it('builds a risk view from changed labels', () => {
    const result = compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'risk', limit: 3 })

    expect(result.risk.topImpacts[0]?.label).toBe('AuthService')
  })

  it('formats the selected view for terminal output', () => {
    const result = compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'drift', limit: 3 })

    expect(formatTimeTravelResult(result)).toContain('AuthService')
    expect(formatTimeTravelResult(result)).toContain('Auth Layer')
    expect(formatTimeTravelResult(result)).toContain('Security Layer')
  })

  it('treats limit zero as zero drift items', () => {
    const result = compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'drift', limit: 0 })

    expect(result.drift.movedNodes).toEqual([])
  })

  it('builds and formats a timeline view from graph deltas', () => {
    const result = compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'timeline', limit: 4 })

    expect(result.timeline.events).toContainEqual(
      expect.objectContaining({
        kind: 'community_moved',
        label: 'AuthService',
        reason: 'Auth Layer → Security Layer',
      }),
    )
    expect(formatTimeTravelResult(result)).toContain('[community_moved] AuthService: Auth Layer → Security Layer')
  })
})
