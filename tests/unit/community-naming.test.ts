import { createTestGraph } from '../helpers/knowledge-graph.js'
import { buildCommunityLabels } from '../../src/pipeline/community-naming.js'

describe('buildCommunityLabels', () => {
  it('derives stable semantic labels from dominant directories and file themes', () => {
    const graph = createTestGraph({
    metadata: { root_path: '/repo' },
    nodes: [
        ['a', {
                label: 'claudeInstall()', file_type: 'code', source_file: '/repo/src/infrastructure/install.ts'
            }],
        ['b', {
                label: 'cursorInstall()', file_type: 'code', source_file: '/repo/src/infrastructure/install.ts'
            }],
        ['c', {
                label: 'toHtml()', file_type: 'code', source_file: '/repo/src/pipeline/export.ts'
            }],
        ['d', {
                label: 'toSvg()', file_type: 'code', source_file: '/repo/src/pipeline/export.ts'
            }]
    ],
    edges: [
        ['a', 'b', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/src/infrastructure/install.ts'
            }],
        ['c', 'd', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/src/pipeline/export.ts'
            }]
    ]
})

    const communities = { 0: ['a', 'b'], 1: ['c', 'd'] }

    expect(buildCommunityLabels(graph, communities, { rootPath: '/repo' })).toEqual({
      0: 'Infrastructure Install',
      1: 'Pipeline Export',
    })
  })

  it('uses a meaningful singleton label when a community has only one member', () => {
    const graph = createTestGraph({
    metadata: { root_path: '/repo' },
    nodes: [
        ['directed-multigraph', {
                label: 'KnowledgeGraph', file_type: 'code', source_file: '/repo/src/domain/graph/directed-multigraph.ts'
            }]
    ],
    edges: []
})

    expect(buildCommunityLabels(graph, { 0: ['directed-multigraph'] }, { rootPath: '/repo' })).toEqual({
      0: 'Knowledge Graph',
    })
  })

  it('disambiguates duplicate labels with operation or node-based suffixes', () => {
    const graph = createTestGraph({
    metadata: { root_path: '/repo' },
    nodes: [
        ['a', {
                label: 'KnowledgeGraph', file_type: 'code', source_file: '/repo/src/domain/graph/directed-multigraph.ts'
            }],
        ['b', {
                label: 'KnowledgeGraph', file_type: 'code', source_file: '/repo/src/domain/graph/directed-multigraph.ts'
            }]
    ],
    edges: []
})

    const labels = buildCommunityLabels(graph, { 0: ['a'], 5: ['b'] }, { rootPath: '/repo' })
    expect(labels[0]).toBe('Knowledge Graph')
    // Second community gets a disambiguated name (not just a numeric ID)
    expect(labels[5]).not.toBe('Knowledge Graph')
    expect(labels[5]).toContain('Knowledge Graph')
  })

  it('does not crash when labels include Object prototype property names', () => {
    const graph = createTestGraph({
    metadata: { root_path: '/repo' },
    nodes: [
        ['a', {
                label: 'ConstructorHelper', file_type: 'code', source_file: '/repo/src/runtime/constructor.ts'
            }],
        ['b', {
                label: 'toStringBridge', file_type: 'code', source_file: '/repo/src/runtime/to-string.ts'
            }]
    ],
    edges: []
})

    expect(() => buildCommunityLabels(graph, { 0: ['a', 'b'] }, { rootPath: '/repo' })).not.toThrow()
    expect(buildCommunityLabels(graph, { 0: ['a', 'b'] }, { rootPath: '/repo' })).toEqual({
      0: 'Runtime Constructor',
    })
  })
})
