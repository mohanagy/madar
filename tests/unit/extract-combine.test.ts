import type { ExtractionNode } from '../../src/pipeline/extract/contracts.js'
import { mergeExtractionFragments, resolveSourceNodeReferences } from '../../src/pipeline/extract/combine.js'

describe('mergeExtractionFragments', () => {
  it('returns an empty extraction payload when no fragments are provided', () => {
    expect(mergeExtractionFragments([])).toEqual({
      nodes: [],
      edges: [],
      input_tokens: 0,
      output_tokens: 0,
    })
  })

  it('merges extraction fragments into a stable combined payload', () => {
    const merged = mergeExtractionFragments([
      {
        nodes: [{ id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'alpha.py' }],
        edges: [],
      },
      {
        nodes: [{ id: 'n2', label: 'Beta', file_type: 'document', source_file: 'beta.md' }],
        edges: [{ source: 'n1', target: 'n2', relation: 'references', confidence: 'EXTRACTED', source_file: 'beta.md' }],
      },
    ])

    expect(merged).toEqual({
      nodes: [
        { id: 'n1', label: 'Alpha', file_type: 'code', source_file: 'alpha.py' },
        { id: 'n2', label: 'Beta', file_type: 'document', source_file: 'beta.md' },
      ],
      edges: [{ source: 'n1', target: 'n2', relation: 'references', confidence: 'EXTRACTED', source_file: 'beta.md' }],
      input_tokens: 0,
      output_tokens: 0,
    })
  })
})

describe('resolveSourceNodeReferences', () => {
  it('adds source_node reference edges against merged and context nodes without duplicates', () => {
    const noteNode: ExtractionNode = {
      id: 'n_note',
      label: 'notes.md',
      file_type: 'document',
      source_file: 'notes.md',
      source_location: 'L7',
      source_nodes: ['authenticate()', 'requestToken()', 'authenticate()', 'notes.md'],
    }
    const merged = {
      nodes: [
        noteNode,
        {
          id: 'n_auth',
          label: 'authenticate()',
          file_type: 'code' as const,
          source_file: 'auth.ts',
        },
      ],
      edges: [
        {
          source: 'n_note',
          target: 'n_auth',
          relation: 'references',
          confidence: 'EXTRACTED' as const,
          source_file: 'notes.md',
        },
      ],
      input_tokens: 0,
      output_tokens: 0,
    }

    const resolved = resolveSourceNodeReferences(merged, {
      contextNodes: [
        {
          id: 'n_request',
          label: 'requestToken()',
          file_type: 'code',
          source_file: 'client.ts',
        },
      ],
    })

    const references = resolved.edges.filter((edge) => edge.source === 'n_note' && edge.relation === 'references')

    expect(references).toHaveLength(2)
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'n_auth' }),
        expect.objectContaining({
          target: 'n_request',
          source_location: 'L7',
          layer: 'base',
          provenance: [expect.objectContaining({ capability_id: 'builtin:extract:markdown', stage: 'extract' })],
        }),
      ]),
    )
    expect(references.some((edge) => edge.target === 'n_note')).toBe(false)
  })

  it('ignores invalid or missing source_node references while preserving extraction metadata', () => {
    const resolved = resolveSourceNodeReferences({
      schema_version: 2,
      nodes: [
        {
          id: 'n_note',
          label: 'notes.md',
          file_type: 'document',
          source_file: 'notes.md',
          source_nodes: ['  ', 42, 'missing-node'],
        },
      ],
      edges: [],
      hyperedges: [
        {
          id: 'h_bundle',
          nodes: ['n_note'],
          relation: 'context_group',
          layer: 'semantic',
          provenance: [{ capability_id: 'test:hyperedge' }],
        },
      ],
      input_tokens: 5,
      output_tokens: 7,
    })

    expect(resolved.edges).toEqual([])
    expect(resolved.schema_version).toBe(2)
    expect(resolved.hyperedges).toEqual([
      {
        id: 'h_bundle',
        nodes: ['n_note'],
        relation: 'context_group',
        layer: 'semantic',
        provenance: [{ capability_id: 'test:hyperedge' }],
      },
    ])
    expect(resolved.input_tokens).toBe(5)
    expect(resolved.output_tokens).toBe(7)
  })
})
