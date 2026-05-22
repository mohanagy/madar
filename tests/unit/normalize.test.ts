import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { LEGACY_NORMALIZATION_CAPABILITY_ID } from '../../src/core/provenance/types.js'
import { normalizeExtractionData } from '../../src/core/schema/normalize.js'
import { buildFromJson } from '../../src/pipeline/build.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures')

describe('normalizeExtractionData', () => {
  it('defaults legacy payloads to schema version 1 with base layers and baseline provenance', () => {
    const legacy = {
      nodes: [
        { id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'alpha.py', source_location: 'L1' },
        { id: 'n2', label: 'Beta', file_type: 'document', source_file: 'beta.md' },
      ],
      edges: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'references',
          confidence: 'EXTRACTED',
          source_file: 'alpha.py',
          source_location: 'L2',
        },
      ],
      hyperedges: [
        {
          id: 'h1',
          nodes: ['n1', 'n2'],
          relation: 'context',
          source_file: 'alpha.py',
        },
      ],
    }

    const normalized = normalizeExtractionData(legacy)

    expect(normalized.schema_version).toBe(1)
    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        id: 'n1',
        layer: 'base',
        provenance: [
          expect.objectContaining({
            capability_id: LEGACY_NORMALIZATION_CAPABILITY_ID,
            stage: 'normalize',
            source_file: 'alpha.py',
            source_location: 'L1',
          }),
        ],
      }),
    )
    expect(normalized.edges[0]).toEqual(
      expect.objectContaining({
        layer: 'base',
        provenance: [
          expect.objectContaining({
            capability_id: LEGACY_NORMALIZATION_CAPABILITY_ID,
            source_file: 'alpha.py',
            source_location: 'L2',
          }),
        ],
      }),
    )
    expect(normalized.hyperedges[0]).toEqual(
      expect.objectContaining({
        layer: 'base',
        provenance: [
          expect.objectContaining({
            capability_id: LEGACY_NORMALIZATION_CAPABILITY_ID,
            source_file: 'alpha.py',
          }),
        ],
      }),
    )
  })

  it('preserves explicit v2 schema, layers, and provenance', () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction-v2.json'), 'utf8')) as unknown

    expect(normalizeExtractionData(fixture)).toEqual(fixture)
  })

  it('does not mutate legacy payload inputs', () => {
    const legacy = {
      capture: { tags: ['legacy'] },
      nodes: [{ id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'alpha.py', metadata: { tags: ['node'] } }],
      edges: [],
    }
    const snapshot = JSON.parse(JSON.stringify(legacy)) as typeof legacy

    const normalized = normalizeExtractionData(legacy)
    const normalizedNode = normalized.nodes[0]

    expect(normalized.capture).toEqual(snapshot.capture)
    expect(normalized.capture).not.toBe(legacy.capture)
    expect(normalizedNode).toBeDefined()
    expect((normalizedNode?.metadata as { tags: string[] }).tags).toEqual(['node'])
    expect(normalizedNode?.metadata).not.toBe(legacy.nodes[0]?.metadata)

    expect(legacy).toEqual(snapshot)
    expect('schema_version' in legacy).toBe(false)
    const legacyNode = legacy.nodes[0]
    expect(legacyNode).toBeDefined()
    expect('layer' in (legacyNode ?? {})).toBe(false)
    expect('provenance' in (legacyNode ?? {})).toBe(false)
  })

  it('projects flat ingest frontmatter into structured provenance for records from the same source file', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_doc',
          label: 'notes.md',
          file_type: 'document' as const,
          source_file: 'notes.md',
          source_location: 'L1',
          source_url: 'https://github.com/mohanagy/madar',
          captured_at: '2026-04-13T00:00:00Z',
          author: 'Docs Team',
          contributor: 'madar',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
        {
          id: 'n_heading',
          label: 'Notes',
          file_type: 'document' as const,
          source_file: 'notes.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
      edges: [
        {
          source: 'n_doc',
          target: 'n_heading',
          relation: 'contains',
          confidence: 'EXTRACTED' as const,
          source_file: 'notes.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:github',
            stage: 'ingest',
            source_url: 'https://github.com/mohanagy/madar',
            captured_at: '2026-04-13T00:00:00Z',
            author: 'Docs Team',
            contributor: 'madar',
          }),
        ]),
      }),
    )
    expect(normalized.nodes[1]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:github', stage: 'ingest' }),
        ]),
      }),
    )
    expect(normalized.edges[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:github', stage: 'ingest' }),
        ]),
      }),
    )
  })

  it('projects flat tweet ingest frontmatter into builtin tweet provenance', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_tweet',
          label: 'tweet.md',
          file_type: 'document' as const,
          source_file: 'tweet.md',
          source_location: 'L1',
          source_url: 'https://x.com/madar/status/123',
          captured_at: '2026-04-13T01:00:00Z',
          author: 'Madar Bot',
          contributor: 'madar',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
        {
          id: 'n_body',
          label: 'Tweet Body',
          file_type: 'document' as const,
          source_file: 'tweet.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
      edges: [
        {
          source: 'n_tweet',
          target: 'n_body',
          relation: 'contains',
          confidence: 'EXTRACTED' as const,
          source_file: 'tweet.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:tweet',
            stage: 'ingest',
            source_url: 'https://x.com/madar/status/123',
            captured_at: '2026-04-13T01:00:00Z',
            author: 'Madar Bot',
            contributor: 'madar',
          }),
        ]),
      }),
    )
    expect(normalized.nodes[1]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:tweet', stage: 'ingest' }),
        ]),
      }),
    )
    expect(normalized.edges[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:tweet', stage: 'ingest' }),
        ]),
      }),
    )
  })

  it('projects flat arxiv ingest frontmatter into builtin arxiv provenance', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_paper',
          label: 'paper.md',
          file_type: 'paper' as const,
          source_file: 'paper.md',
          source_location: 'L1',
          source_url: 'https://arxiv.org/abs/1706.03762',
          captured_at: '2026-04-13T02:00:00Z',
          contributor: 'madar',
          provenance: [{ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' }],
        },
        {
          id: 'n_abstract',
          label: 'Abstract',
          file_type: 'paper' as const,
          source_file: 'paper.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' }],
        },
      ],
      edges: [
        {
          source: 'n_paper',
          target: 'n_abstract',
          relation: 'contains',
          confidence: 'EXTRACTED' as const,
          source_file: 'paper.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' }],
        },
      ],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:arxiv',
            stage: 'ingest',
            source_url: 'https://arxiv.org/abs/1706.03762',
            captured_at: '2026-04-13T02:00:00Z',
            contributor: 'madar',
          }),
        ]),
      }),
    )
    expect(normalized.nodes[1]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:arxiv', stage: 'ingest' }),
        ]),
      }),
    )
    expect(normalized.edges[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown-paper', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:arxiv', stage: 'ingest' }),
        ]),
      }),
    )
  })

  it('projects flat hackernews ingest frontmatter into builtin hackernews provenance', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_hn',
          label: 'hn.md',
          file_type: 'document' as const,
          source_file: 'hn.md',
          source_location: 'L1',
          source_url: 'https://news.ycombinator.com/item?id=8863',
          captured_at: '2026-04-14T12:00:00Z',
          contributor: 'madar',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
        {
          id: 'n_hn_heading',
          label: 'Highlights',
          file_type: 'document' as const,
          source_file: 'hn.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
      edges: [
        {
          source: 'n_hn',
          target: 'n_hn_heading',
          relation: 'contains',
          confidence: 'EXTRACTED' as const,
          source_file: 'hn.md',
          source_location: 'L5',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:hackernews',
            stage: 'ingest',
            source_url: 'https://news.ycombinator.com/item?id=8863',
            captured_at: '2026-04-14T12:00:00Z',
            contributor: 'madar',
          }),
        ]),
      }),
    )
    expect(normalized.nodes[1]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:hackernews', stage: 'ingest' }),
        ]),
      }),
    )
    expect(normalized.edges[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({ capability_id: 'builtin:ingest:hackernews', stage: 'ingest' }),
        ]),
      }),
    )
  })

  it('prefers explicit webpage type for ingest provenance when source_url still looks like media', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_page',
          label: 'page.md',
          file_type: 'document' as const,
          type: 'webpage',
          source_file: 'page.md',
          source_location: 'L1',
          source_url: 'https://cdn.example.com/assets/episode.mp3',
          captured_at: '2026-04-14T23:00:00Z',
          contributor: 'madar',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
      edges: [],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:webpage',
            stage: 'ingest',
            source_url: 'https://cdn.example.com/assets/episode.mp3',
            captured_at: '2026-04-14T23:00:00Z',
            contributor: 'madar',
          }),
        ]),
      }),
    )
  })

  it('prefers explicit binary ingest_url_type when source_url lacks a binary suffix', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_audio',
          label: 'episode.mp3',
          file_type: 'audio' as const,
          source_file: 'episode.mp3',
          source_location: 'L1',
          source_url: 'https://example.com/download/audio',
          ingest_url_type: 'audio',
          captured_at: '2026-04-14T23:30:00Z',
          contributor: 'madar',
          provenance: [{ capability_id: 'builtin:extract:audio', stage: 'extract' }],
        },
      ],
      edges: [],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: 'builtin:extract:audio', stage: 'extract' }),
          expect.objectContaining({
            capability_id: 'builtin:ingest:audio',
            stage: 'ingest',
            source_url: 'https://example.com/download/audio',
            captured_at: '2026-04-14T23:30:00Z',
            contributor: 'madar',
          }),
        ]),
      }),
    )
  })

  it('does not duplicate explicit ingest provenance already emitted during raw extraction', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_doc',
          label: 'notes.md',
          file_type: 'document' as const,
          source_file: 'notes.md',
          source_location: 'L1',
          source_url: 'https://github.com/mohanagy/madar',
          captured_at: '2026-04-13T00:00:00Z',
          author: 'Docs Team',
          contributor: 'madar',
          provenance: [
            { capability_id: 'builtin:extract:markdown', stage: 'extract' },
            {
              capability_id: 'builtin:ingest:github',
              stage: 'ingest',
              source_file: 'notes.md',
              source_url: 'https://github.com/mohanagy/madar',
              captured_at: '2026-04-13T00:00:00Z',
              author: 'Docs Team',
              contributor: 'madar',
            },
          ],
        },
        {
          id: 'n_heading',
          label: 'Notes',
          file_type: 'document' as const,
          source_file: 'notes.md',
          source_location: 'L5',
          provenance: [
            { capability_id: 'builtin:extract:markdown', stage: 'extract' },
            {
              capability_id: 'builtin:ingest:github',
              stage: 'ingest',
              source_file: 'notes.md',
              source_url: 'https://github.com/mohanagy/madar',
              captured_at: '2026-04-13T00:00:00Z',
              author: 'Docs Team',
              contributor: 'madar',
            },
          ],
        },
      ],
      edges: [
        {
          source: 'n_doc',
          target: 'n_heading',
          relation: 'contains',
          confidence: 'EXTRACTED' as const,
          source_file: 'notes.md',
          source_location: 'L5',
          provenance: [
            { capability_id: 'builtin:extract:markdown', stage: 'extract' },
            {
              capability_id: 'builtin:ingest:github',
              stage: 'ingest',
              source_file: 'notes.md',
              source_url: 'https://github.com/mohanagy/madar',
              captured_at: '2026-04-13T00:00:00Z',
              author: 'Docs Team',
              contributor: 'madar',
            },
          ],
        },
      ],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]?.provenance).toHaveLength(2)
    expect(normalized.nodes[1]?.provenance).toHaveLength(2)
    expect(normalized.edges[0]?.provenance).toHaveLength(2)
    expect(normalized.nodes[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
        expect.objectContaining({ capability_id: 'builtin:ingest:github', stage: 'ingest' }),
      ]),
    )
    expect(normalized.nodes[1]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
        expect.objectContaining({ capability_id: 'builtin:ingest:github', stage: 'ingest' }),
      ]),
    )
    expect(normalized.edges[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' }),
        expect.objectContaining({ capability_id: 'builtin:ingest:github', stage: 'ingest' }),
      ]),
    )
  })

  it.each([
    {
      label: 'paper.pdf',
      fileType: 'paper' as const,
      sourceUrl: 'https://example.com/paper.pdf',
      extractCapabilityId: 'builtin:extract:paper',
      ingestCapabilityId: 'builtin:ingest:pdf',
    },
    {
      label: 'diagram.png',
      fileType: 'image' as const,
      sourceUrl: 'https://example.com/diagram.png',
      extractCapabilityId: 'builtin:extract:image',
      ingestCapabilityId: 'builtin:ingest:image',
    },
  ])('projects flat binary ingest metadata into %s provenance', ({ label, fileType, sourceUrl, extractCapabilityId, ingestCapabilityId }) => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: `n_${label.replace(/\W+/g, '_')}`,
          label,
          file_type: fileType,
          source_file: label,
          source_url: sourceUrl,
          captured_at: '2026-04-13T05:00:00Z',
          contributor: 'madar',
          provenance: [{ capability_id: extractCapabilityId, stage: 'extract' }],
        },
      ],
      edges: [],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([
          expect.objectContaining({ capability_id: extractCapabilityId, stage: 'extract' }),
          expect.objectContaining({
            capability_id: ingestCapabilityId,
            stage: 'ingest',
            source_url: sourceUrl,
            captured_at: '2026-04-13T05:00:00Z',
            contributor: 'madar',
          }),
        ]),
      }),
    )
  })

  it('does not let virtual citation nodes seed ingest provenance for a source file', () => {
    const extraction = {
      schema_version: 2 as const,
      nodes: [
        {
          id: 'n_doc',
          label: 'paper.md',
          file_type: 'document' as const,
          source_file: 'paper.md',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
        {
          id: 'n_abstract',
          label: 'Abstract',
          file_type: 'document' as const,
          source_file: 'paper.md',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
        {
          id: 'n_virtual_citation',
          label: 'arXiv:1234.5678',
          file_type: 'paper' as const,
          source_file: 'paper.md',
          source_url: 'https://arxiv.org/abs/1234.5678',
          virtual: true,
          semantic_kind: 'citation' as const,
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
      edges: [
        {
          source: 'n_doc',
          target: 'n_abstract',
          relation: 'contains',
          confidence: 'EXTRACTED' as const,
          source_file: 'paper.md',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
    }

    const normalized = normalizeExtractionData(extraction)

    expect(normalized.nodes[0]?.provenance).toEqual([expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })])
    expect(normalized.nodes[1]?.provenance).toEqual([expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })])
    expect(normalized.edges[0]?.provenance).toEqual([expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })])
  })
})

describe('buildFromJson normalization', () => {
  it('applies normalization defaults to legacy payloads before building the graph', () => {
    const graph = buildFromJson({
      nodes: [
        { id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'alpha.py', source_location: 'L1' },
        { id: 'n2', label: 'Beta', file_type: 'document', source_file: 'beta.md' },
      ],
      edges: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'references',
          confidence: 'EXTRACTED',
          source_file: 'alpha.py',
          source_location: 'L3',
        },
      ],
      hyperedges: [{ id: 'h1', nodes: ['n1', 'n2'], source_file: 'alpha.py' }],
    })

    const hyperedges = Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : []

    expect(graph.graph.schema_version).toBe(1)
    expect(graph.nodeAttributes('n1')).toEqual(
      expect.objectContaining({
        layer: 'base',
        provenance: [
          expect.objectContaining({
            capability_id: LEGACY_NORMALIZATION_CAPABILITY_ID,
            source_file: 'alpha.py',
            source_location: 'L1',
          }),
        ],
      }),
    )
    expect(graph.edgeAttributes('n1', 'n2')).toEqual(
      expect.objectContaining({
        layer: 'base',
        provenance: [expect.objectContaining({ capability_id: LEGACY_NORMALIZATION_CAPABILITY_ID })],
      }),
    )
    expect(hyperedges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'h1',
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: LEGACY_NORMALIZATION_CAPABILITY_ID })],
        }),
      ]),
    )
  })

  it('preserves an explicit schema version when building v2 payloads', () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, 'extraction-v2.json'), 'utf8')) as unknown
    const graph = buildFromJson(fixture)

    expect(graph.graph.schema_version).toBe(2)
  })

  it('projects ingest provenance into built graph attributes from flat frontmatter metadata', () => {
    const graph = buildFromJson({
      nodes: [
        {
          id: 'n_doc',
          label: 'notes.md',
          file_type: 'document',
          source_file: 'notes.md',
          source_url: 'https://github.com/mohanagy/madar',
          captured_at: '2026-04-13T00:00:00Z',
          author: 'Docs Team',
          contributor: 'madar',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
        {
          id: 'n_heading',
          label: 'Notes',
          file_type: 'document',
          source_file: 'notes.md',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
      edges: [
        {
          source: 'n_doc',
          target: 'n_heading',
          relation: 'contains',
          confidence: 'EXTRACTED',
          source_file: 'notes.md',
          provenance: [{ capability_id: 'builtin:extract:markdown', stage: 'extract' }],
        },
      ],
    })

    expect(graph.nodeAttributes('n_heading')).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([expect.objectContaining({ capability_id: 'builtin:ingest:github', stage: 'ingest' })]),
      }),
    )
    expect(graph.edgeAttributes('n_doc', 'n_heading')).toEqual(
      expect.objectContaining({
        provenance: expect.arrayContaining([expect.objectContaining({ capability_id: 'builtin:ingest:github', stage: 'ingest' })]),
      }),
    )
  })
})
