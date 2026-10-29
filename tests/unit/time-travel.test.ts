import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { compareTimeTravelGraphs, formatTimeTravelResult } from '../../src/runtime/time-travel.js'

function buildBeforeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('mobile', { label: 'MobileClient', source_file: '/src/mobile.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('auth', { label: 'AuthService', source_file: '/src/auth.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('session', { label: 'SessionStore', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })

  graph.addEdge('web', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/web.ts' })
  graph.addEdge('mobile', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/mobile.ts' })
  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/session.ts' })

  graph.graph.community_labels = {
    0: 'Auth Layer',
    1: 'Data Layer',
    2: 'App Layer',
  }

  return graph
}

function buildAfterGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })

  graph.addNode('web', { label: 'WebApp', source_file: '/src/web.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('mobile', { label: 'MobileClient', source_file: '/src/mobile.ts', node_kind: 'module', file_type: 'code', community: 2 })
  graph.addNode('api', { label: 'ApiHandler', source_file: '/src/api.ts', node_kind: 'function', file_type: 'code', community: 2 })
  graph.addNode('auth', { label: 'AuthService', source_file: '/src/auth.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('session', { label: 'SessionStore', source_file: '/src/session.ts', node_kind: 'class', file_type: 'code', community: 0 })
  graph.addNode('db', { label: 'DatabaseConnection', source_file: '/src/db.ts', node_kind: 'class', file_type: 'code', community: 1 })
  graph.addNode('guide', { label: 'MigrationGuide', source_file: '/docs/migration.md', node_kind: 'document', file_type: 'document', community: 3 })

  graph.addEdge('web', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/web.ts' })
  graph.addEdge('mobile', 'api', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/mobile.ts' })
  graph.addEdge('api', 'auth', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api.ts' })
  graph.addEdge('auth', 'session', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth.ts' })
  graph.addEdge('session', 'db', { relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/session.ts' })

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

    const limited = compareTimeTravelGraphs(buildBeforeGraph(), buildAfterGraph(), { view: 'risk', limit: 3, depth: 1 })
    expect(limited.risk.topImpacts.find(impact => impact.label === 'AuthService')?.traversal)
      .toEqual({ status: 'depth_limited', depth: 1, node_limit: 500 })
    expect(formatTimeTravelResult(limited)).toContain('AuthService: at least 0 transitive dependents (depth_limited)')
    expect(limited.summary.whyItMatters).toContain('Top risk: AuthService reaches at least 0 transitive dependents.')
  })

  it('keeps duplicate-label impact owners and their before/after graph origins distinct', () => {
    const graph = (side: 'before' | 'after'): KnowledgeGraph => {
      const result = new KnowledgeGraph({ directed: true })
      for (const id of ['retained', 'middle', 'outer']) {
        result.addNode(id, { label: id === 'retained' ? '.run()' : id, source_file: `/src/${id}.ts`,
          community: id === 'retained' && side === 'after' ? 1 : 0 })
      }
      const owner = side === 'before' ? 'removed' : 'added'
      result.addNode(owner, { label: '.run()', source_file: `/src/${owner}.ts`, community: 0 })
      result.addEdge('outer', 'middle', { relation: 'calls' })
      result.addEdge('middle', owner, { relation: 'calls' })
      if (side === 'after') {
        result.addNode('entry', { label: 'entry', source_file: '/src/entry.ts', community: 0 })
        result.addEdge('entry', 'outer', { relation: 'calls' })
      }
      return result
    }
    const result = compareTimeTravelGraphs(graph('before'), graph('after'), { view: 'summary', limit: 20 })
    expect(result.risk.topImpacts.filter(impact => impact.label === '.run()')).toEqual([
      expect.objectContaining({ node_id: 'added', graph_side: 'after', source_file: '/src/added.ts', transitiveDependents: 2 }),
      expect.objectContaining({ node_id: 'removed', graph_side: 'before', source_file: '/src/removed.ts', transitiveDependents: 1 }),
      expect.objectContaining({ node_id: 'retained', graph_side: 'after', source_file: '/src/retained.ts', transitiveDependents: 0 }),
    ])
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
