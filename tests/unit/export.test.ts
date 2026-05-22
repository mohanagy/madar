import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildFromJson } from '../../src/pipeline/build.js'
import { cluster } from '../../src/pipeline/cluster.js'
import { toCypher, toGraphml, toHtml, toJson, toObsidian, toSvg } from '../../src/pipeline/export.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

function makeGraph() {
  return buildFromJson(JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction.json'), 'utf8')))
}

describe('export', () => {
  function withTempDir(callback: (tempDir: string) => void): void {
    const tempDir = mkdtempSync(join(tmpdir(), 'sadeem-export-'))
    try {
      callback(tempDir)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  it('writes valid graph JSON with community annotations', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.json')
      toJson(graph, communities, outputPath)
      const data = JSON.parse(readFileSync(outputPath, 'utf8'))

      expect(Array.isArray(data.nodes)).toBe(true)
      expect(Array.isArray(data.links)).toBe(true)
      for (const node of data.nodes) {
        expect(node).toHaveProperty('community')
      }
    })
  })

  it('writes directed graph JSON metadata and preserves opposite links', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [
          { source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
          { source: 'n2', target: 'n1', relation: 'returns_to', confidence: 'INFERRED', source_file: 'b.py' },
        ],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.json')
      toJson(graph, { 0: ['n1', 'n2'] }, outputPath)
      const data = JSON.parse(readFileSync(outputPath, 'utf8'))

      expect(data.directed).toBe(true)
      expect(data.links).toHaveLength(2)
      expect(data.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'n1', target: 'n2', relation: 'calls' }),
          expect.objectContaining({ source: 'n2', target: 'n1', relation: 'returns_to' }),
        ]),
      )
    })
  })

  it('writes cypher with merge statements', () => {
    const graph = makeGraph()

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.cypher')
      toCypher(graph, outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('MERGE')
    })
  })

  it('writes graphml with node and community fields', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.graphml')
      toGraphml(graph, communities, outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('<graphml')
      expect(content).toContain('<node')
      expect(content).toContain('community')
    })
  })

  it('writes directed graphml exports with directed edge defaults', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [
          { source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
          { source: 'n2', target: 'n1', relation: 'returns_to', confidence: 'INFERRED', source_file: 'b.py' },
        ],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.graphml')
      toGraphml(graph, { 0: ['n1', 'n2'] }, outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('edgedefault="directed"')
      expect(content).toContain('source="n1" target="n2"')
      expect(content).toContain('source="n2" target="n1"')
    })
  })

  it('writes svg with node labels and community legend content', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.svg')
      toSvg(graph, communities, outputPath, { 0: 'Group 0' })
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('<svg')
      expect(content).toContain('Group 0')
      expect(content).toContain('Transformer')
      expect(content).toContain('<circle')
      expect(content).toContain('<line')
    })
  })

  it('writes html with richer exploration controls and embedded data', () => {
    const graph = makeGraph()
    const communities = cluster(graph)

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, communities, outputPath, { 0: 'Group 0' })
      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('vis-network')
      expect(content.toLowerCase()).toContain('search')
      expect(content).toContain('RAW_NODES')
      expect(content).toContain('RAW_EDGES')
      expect(content).toContain('Selected node')
      expect(content).toContain('Focus neighborhood')
      expect(content).toContain('Communities')
      expect(content).toContain('selectNodeById')
      expect(content).toContain('focusCommunity')
      expect(content).toContain('arrows: EDGE_ARROWS')
      expect(content).toContain('return [...deduped.values()].sort((left, right) => {')
      expect(content).toContain('Group 0')
    })
  })

  it('writes overview-first html with self-contained community pages when requested', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'alpha', label: 'claudeInstall()', file_type: 'code', source_file: '/repo/src/infrastructure/install.ts' },
          { id: 'beta', label: 'cursorInstall()', file_type: 'code', source_file: '/repo/src/infrastructure/install.ts' },
          { id: 'gamma', label: 'toHtml()', file_type: 'code', source_file: '/repo/src/pipeline/export.ts' },
        ],
        edges: [
          { source: 'alpha', target: 'beta', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/src/infrastructure/install.ts' },
          { source: 'beta', target: 'alpha', relation: 'returns_to', confidence: 'INFERRED', source_file: '/repo/src/infrastructure/install.ts' },
        ],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      const result = toHtml(
        graph,
        { 0: ['alpha', 'beta'], 1: ['gamma'] },
        outputPath,
        { 0: 'Infrastructure Install', 1: 'Pipeline Export' },
        { mode: 'overview', cohesionScores: { 0: 1, 1: 1 } },
      )

      const overview = readFileSync(outputPath, 'utf8')
      const communityPage = readFileSync(join(tempDir, 'graph-pages', 'community-0.html'), 'utf8')

      expect(result.mode).toBe('overview')
      expect(result.communityPageCount).toBe(2)
      expect(overview).toContain('Overview-first large-graph mode')
      expect(overview).toContain('Open community')
      expect(overview).toContain('graph-pages/community-0.html')
      expect(overview).not.toContain('const RAW_EDGES =')
      expect(communityPage).toContain('Back to overview')
      expect(communityPage).toContain('claudeInstall()')
      expect(communityPage).not.toContain('toHtml()')
    })
  })

  it('writes overview-first html with bridge-first starting points', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'api', label: 'loginUser()', file_type: 'code', source_file: '/repo/backend/api.ts' },
          { id: 'web', label: 'loadSession()', file_type: 'code', source_file: '/repo/web-app/session.ts' },
          { id: 'worker', label: 'syncSession()', file_type: 'code', source_file: '/repo/worker/jobs.ts' },
          { id: 'shared', label: 'createSession()', file_type: 'code', source_file: '/repo/shared/auth.ts' },
        ],
        edges: [
          { source: 'api', target: 'shared', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/backend/api.ts' },
          { source: 'web', target: 'shared', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/web-app/session.ts' },
          { source: 'worker', target: 'shared', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/worker/jobs.ts' },
        ],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      const result = toHtml(
        graph,
        { 0: ['api'], 1: ['web'], 2: ['worker'], 3: ['shared'] },
        outputPath,
        { 0: 'Backend API', 1: 'Web Session', 2: 'Worker Jobs', 3: 'Shared Auth' },
        { mode: 'overview' },
      )

      const overview = readFileSync(outputPath, 'utf8')
      const bridgePage = readFileSync(
        join(tempDir, 'graph-pages', `bridge-${Buffer.from('shared', 'utf8').toString('base64url')}.html`),
        'utf8',
      )

      expect(result.mode).toBe('overview')
      expect(overview).toContain('Workspace Bridges')
      expect(overview).toContain('Start with nodes that connect otherwise separate communities.')
      expect(overview).toContain('createSession()')
      expect(overview).toContain('connects Backend API, Web Session, Worker Jobs')
      expect(overview).toContain(`graph-pages/bridge-${Buffer.from('shared', 'utf8').toString('base64url')}.html`)
      expect(bridgePage).toContain('Bridge neighborhood view')
      expect(bridgePage).toContain('This page shows the selected bridge node plus its immediate cross-community neighborhood.')
      expect(bridgePage).toContain('Local degree')
      expect(bridgePage).toContain('Global degree')
      expect(bridgePage).toContain('Connected communities')
    })
  })

  it('automatically switches to overview mode when the graph exceeds inline thresholds', () => {
    const graph = buildFromJson(
      {
        nodes: Array.from({ length: 2100 }, (_, index) => ({
          id: `node-${index}`,
          label: `Node${index}`,
          file_type: 'code',
          source_file: '/repo/src/pipeline/export.ts',
        })),
        edges: [],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      const result = toHtml(graph, { 0: graph.nodeIds() }, outputPath, { 0: 'Pipeline Export' })

      const overview = readFileSync(outputPath, 'utf8')

      expect(result.mode).toBe('overview')
      expect(result.reason).toContain('thresholds')
      expect(overview).toContain('Overview-first large-graph mode')
      expect(readdirSync(join(tempDir, 'graph-pages'))).toContain('community-0.html')
    })
  })

  it('writes summary-only community pages when a focused community still exceeds inline thresholds', () => {
    const graph = buildFromJson(
      {
        nodes: Array.from({ length: 1300 }, (_, index) => ({
          id: `node-${index}`,
          label: `Node${index}`,
          file_type: 'code',
          source_file: `/repo/src/module-${index % 7}.ts`,
        })),
        edges: [],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      const result = toHtml(graph, { 0: graph.nodeIds() }, outputPath, { 0: 'Large Community' })

      const overview = readFileSync(outputPath, 'utf8')
      const communityPage = readFileSync(join(tempDir, 'graph-pages', 'community-0.html'), 'utf8')

      expect(result.mode).toBe('overview')
      expect(overview).toContain('Open community summary')
      expect(communityPage).toContain('This community is too large to render as one interactive graph')
      expect(communityPage).toContain('This page shows only nodes inside this community; cross-community connections are hidden.')
      expect(communityPage).toContain('Top connected nodes')
      expect(communityPage).toContain('Search nodes by label or file')
      expect(communityPage).toContain('Selected node')
      expect(communityPage).toContain('Local degree')
      expect(communityPage).toContain('const SUMMARY_NODES =')
      // vis-network is referenced only in the opt-in loadInteractiveGraph function, not eagerly loaded
      expect(communityPage).not.toContain('<script src="https://unpkg.com/vis-network')
      expect(communityPage).not.toContain('const RAW_EDGES =')
      expect(communityPage).not.toContain('<article id=')
    })
  })

  it('uses deterministic safe anchors for summary-only community deep links', () => {
    const specialNodeId = 'src/routes/foo bar.ts#handler'
    const expectedAnchor = `node-${Buffer.from(specialNodeId, 'utf8').toString('base64url')}`
    const graph = buildFromJson(
      {
        nodes: [
          { id: specialNodeId, label: 'SpecialNode', file_type: 'code', source_file: '/repo/src/routes/foo bar.ts' },
          ...Array.from({ length: 1299 }, (_, index) => ({
            id: `node-${index}`,
            label: `Node${index}`,
            file_type: 'code',
            source_file: `/repo/src/module-${index % 7}.ts`,
          })),
        ],
        edges: [],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, { 0: graph.nodeIds() }, outputPath, { 0: 'Large Community' })

      const overview = readFileSync(outputPath, 'utf8')
      const communityPage = readFileSync(join(tempDir, 'graph-pages', 'community-0.html'), 'utf8')

      expect(overview).toContain(`#${expectedAnchor}`)
      expect(communityPage).toContain(`"anchor_id":"${expectedAnchor}"`)
      expect(communityPage).not.toContain(`id="${expectedAnchor}"`)
      expect(communityPage).not.toContain(`id="${encodeURIComponent(specialNodeId)}"`)
    })
  })

  it('writes html edge arrow config that matches graph directedness', () => {
    const undirectedGraph = makeGraph()
    const directedGraph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' }],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const undirectedPath = join(tempDir, 'undirected.html')
      const directedPath = join(tempDir, 'directed.html')
      toHtml(undirectedGraph, cluster(undirectedGraph), undirectedPath)
      toHtml(directedGraph, { 0: ['n1', 'n2'] }, directedPath)

      const undirectedContent = readFileSync(undirectedPath, 'utf8')
      const directedContent = readFileSync(directedPath, 'utf8')

      expect(undirectedContent).toContain('const IS_DIRECTED = false;')
      expect(undirectedContent).toContain('const EDGE_ARROWS = {};')
      expect(directedContent).toContain('const IS_DIRECTED = true;')
      expect(directedContent).toContain('const EDGE_ARROWS = {"to":{"enabled":true,"scaleFactor":0.45}};')
    })
  })

  it('adds local-scope labeling and hints to focused community pages', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'api', label: 'loginUser()', file_type: 'code', source_file: '/repo/backend/api.ts' },
          { id: 'shared', label: 'createSession()', file_type: 'code', source_file: '/repo/shared/auth.ts' },
        ],
        edges: [
          { source: 'api', target: 'shared', relation: 'calls', confidence: 'EXTRACTED', source_file: '/repo/backend/api.ts' },
        ],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, { 0: ['api'], 1: ['shared'] }, outputPath, { 0: 'Backend API', 1: 'Shared Auth' }, { mode: 'overview' })

      const communityPage = readFileSync(join(tempDir, 'graph-pages', 'community-1.html'), 'utf8')

      expect(communityPage).toContain('Focused community view')
      expect(communityPage).toContain('This page shows only nodes inside this community; cross-community connections are hidden.')
      expect(communityPage).toContain('Local degree')
      expect(communityPage).toContain('Global degree')
      expect(communityPage).toContain('Connected communities')
    })
  })

  it('writes html with confidence-based dash styling for inferred edges', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'Beta', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [{ source: 'n1', target: 'n2', relation: 'calls', confidence: 'INFERRED', source_file: 'a.py' }],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, { 0: ['n1', 'n2'] }, outputPath)

      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('dashes: edge.dashes')
      expect(content).toContain('"confidence":"INFERRED","dashes":true')
    })
  })

  it('writes html that surfaces source urls and metadata fields in the selected node panel', () => {
    const graph = buildFromJson({
      nodes: [
        {
          id: 'note',
          label: 'query_auth.md',
          file_type: 'document',
          source_file: 'out/memory/query_auth.md',
          source_url: 'https://example.com/auth',
          title: 'Auth result',
          author: 'Jane Doe',
          contributor: 'copilot',
          captured_at: '2026-04-11T00:00:00Z',
        },
      ],
      edges: [],
    })

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, { 0: ['note'] }, outputPath)

      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('Source URL')
      expect(content).toContain('selectedSourceUrl')
      expect(content).toContain('selectedAuthor')
      expect(content).toContain('selectedContributor')
      expect(content).toContain('selectedCapturedAt')
      expect(content).toContain('node.safe_source_url')
      expect(content).toContain('node.document_title')
      expect(content).toContain('node.author')
      expect(content).toContain('node.contributor')
      expect(content).toContain('node.captured_at')
    })
  })

  it('writes html that blocks unsafe source urls from becoming clickable links', () => {
    const graph = buildFromJson({
      nodes: [
        {
          id: 'note',
          label: 'query_auth.md',
          file_type: 'document',
          source_file: 'out/memory/query_auth.md',
          source_url: 'javascript:alert(1)',
        },
      ],
      edges: [],
    })

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, { 0: ['note'] }, outputPath)

      const content = readFileSync(outputPath, 'utf8')

      expect(content).toContain('"source_url":"javascript:alert(1)"')
      expect(content).toContain('"safe_source_url":""')
      expect(content).toContain('node.safe_source_url')
    })
  })

  it('writes an Obsidian-style vault with community notes and graph config', () => {
    const graph = makeGraph()
    const communities = cluster(graph)
    const labels = Object.fromEntries(Object.keys(communities).map((communityId) => [Number(communityId), `Group ${communityId}`]))

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'obsidian')
      const noteCount = toObsidian(graph, communities, outputPath, labels, { 0: 0.75 })
      const files = readdirSync(outputPath)

      expect(noteCount).toBeGreaterThan(0)
      expect(files.some((fileName) => fileName.endsWith('.md'))).toBe(true)
      expect(files.some((fileName) => fileName.startsWith('_COMMUNITY_'))).toBe(true)
      expect(readFileSync(join(outputPath, '.obsidian', 'graph.json'), 'utf8')).toContain('colorGroups')
    })
  })

  it('writes directed Obsidian notes with incoming and outgoing connections', () => {
    const graph = buildFromJson(
      {
        nodes: [
          { id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'a.py' },
          { id: 'n2', label: 'Beta', file_type: 'code', source_file: 'b.py' },
        ],
        edges: [
          { source: 'n1', target: 'n2', relation: 'calls', confidence: 'EXTRACTED', source_file: 'a.py' },
          { source: 'n2', target: 'n1', relation: 'returns_to', confidence: 'INFERRED', source_file: 'b.py' },
        ],
      },
      { directed: true },
    )

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'obsidian')
      toObsidian(graph, { 0: ['n1', 'n2'] }, outputPath, { 0: 'Group 0' })

      const note = readFileSync(join(outputPath, 'Alpha.md'), 'utf8')
      expect(note).toContain('→ [[Beta]] - `calls` [EXTRACTED]')
      expect(note).toContain('← [[Beta]] - `returns\\_to` [INFERRED]')
    })
  })

  it('escapes inline-script payloads in html exports', () => {
    const graph = makeGraph()
    graph.addNode('malicious', {
      label: '</script><script>alert("xss")</script>',
      source_file: 'evil.md',
      file_type: 'document',
    })

    withTempDir((tempDir) => {
      const outputPath = join(tempDir, 'graph.html')
      toHtml(graph, cluster(graph), outputPath)
      const content = readFileSync(outputPath, 'utf8')

      expect(content).not.toContain('</script><script>alert("xss")</script>')
      expect(content).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert')
    })
  })

  describe('buildCommunitySummaryHtml interactive toggle', () => {
    function makeLargeGraph() {
      return buildFromJson(
        {
          nodes: Array.from({ length: 1300 }, (_, index) => ({
            id: `node-${index}`,
            label: `Node${index}`,
            file_type: 'code',
            source_file: `/repo/src/module-${index % 7}.ts`,
          })),
          edges: [
            {
              source: 'node-0',
              target: 'node-1',
              relation: 'calls',
              confidence: 'EXTRACTED',
              source_file: '/repo/src/module-0.ts',
            },
          ],
        },
        { directed: true },
      )
    }

    it('includes a Load interactive graph button', () => {
      const graph = makeLargeGraph()

      withTempDir((tempDir) => {
        const outputPath = join(tempDir, 'graph.html')
        toHtml(graph, { 0: graph.nodeIds() }, outputPath, { 0: 'Large Community' })

        const communityPage = readFileSync(join(tempDir, 'graph-pages', 'community-0.html'), 'utf8')

        expect(communityPage).toContain('id="loadGraphBtn"')
        expect(communityPage).toContain('Load interactive graph')
      })
    })

    it('embeds node/edge data as JSON in a script tag', () => {
      const graph = makeLargeGraph()

      withTempDir((tempDir) => {
        const outputPath = join(tempDir, 'graph.html')
        toHtml(graph, { 0: graph.nodeIds() }, outputPath, { 0: 'Large Community' })

        const communityPage = readFileSync(join(tempDir, 'graph-pages', 'community-0.html'), 'utf8')

        expect(communityPage).toContain('id="graphData"')
        expect(communityPage).toContain('"id":"node-0"')
      })
    })

    it('includes the loadInteractiveGraph client-side function', () => {
      const graph = makeLargeGraph()

      withTempDir((tempDir) => {
        const outputPath = join(tempDir, 'graph.html')
        toHtml(graph, { 0: graph.nodeIds() }, outputPath, { 0: 'Large Community' })

        const communityPage = readFileSync(join(tempDir, 'graph-pages', 'community-0.html'), 'utf8')

        expect(communityPage).toContain('function loadInteractiveGraph(')
      })
    })
  })
})
