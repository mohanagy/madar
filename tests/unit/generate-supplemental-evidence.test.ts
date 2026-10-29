import { describe, expect, it } from 'vitest'

import type { ExtractionData, ExtractionNode } from '../../src/contracts/types.js'
import { mergeSupplementalCodeExtraction } from '../../src/infrastructure/generate.js'

function extraction(node: Partial<ExtractionNode>): ExtractionData {
  return {
    nodes: [{ id: 'request_processrequest', label: 'processRequest()', file_type: 'code', source_file: '/src/request.ts', ...node }],
    edges: [],
  }
}

describe('supplemental SPI source evidence merge', () => {
  it('retains primary source evidence and topology while adding SPI metadata and provenance', () => {
    const primary = extraction({
      source_location: 'L1-L6',
      snippet: 'export function processRequest(input: string) {\n  return input.trim()\n}',
      extraction_strategy: 'legacy',
      framework_metadata: { runtime_boundary: 'server', route_path: '/legacy' },
      provenance: [{ capability_id: 'legacy', stage: 'extract' }],
    })
    primary.edges = [{ source: 'request_processrequest', target: 'request', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/request.ts' }]
    const supplemental = extraction({
      label: 'supplemental label',
      source_location: 'L1',
      snippet: 'export function processRequest(input: string)',
      extraction_strategy: 'spi',
      framework: 'express',
      framework_role: 'express_route',
      route_path: '/requests',
      framework_metadata: { route_path: '/requests' },
      provenance: [{ capability_id: 'spi', stage: 'extract' }],
    })
    supplemental.edges = [{ source: 'request', target: 'request_processrequest', relation: 'contains', confidence: 'EXTRACTED', source_file: '/src/request.ts' }]

    const merged = mergeSupplementalCodeExtraction(primary, supplemental)

    expect(merged.nodes).toHaveLength(1)
    expect(merged.nodes[0]).toMatchObject({
      label: 'processRequest()',
      source_location: 'L1-L6',
      snippet: primary.nodes[0]!.snippet,
      extraction_strategy: 'spi',
      framework: 'express',
      framework_role: 'express_route',
      route_path: '/requests',
      framework_metadata: { runtime_boundary: 'server', route_path: '/requests' },
      provenance: [{ capability_id: 'legacy', stage: 'extract' }, { capability_id: 'spi', stage: 'extract' }],
    })
    expect(merged.edges).toEqual(primary.edges)
    expect(primary.nodes[0]!.source_location).toBe('L1-L6')
    expect(supplemental.nodes[0]!.source_location).toBe('L1')
  })

  it('fills missing source evidence and extends same-start ranges without joining unrelated ranges', () => {
    const supplemental = extraction({ source_location: 'L1-L6', snippet: 'function body' })
    expect(mergeSupplementalCodeExtraction(extraction({ source_location: 'L1' }), supplemental).nodes[0]).toMatchObject({
      source_location: 'L1-L6', snippet: 'function body',
    })
    expect(mergeSupplementalCodeExtraction(extraction({ source_location: 'L3-L4' }), supplemental).nodes[0]!.source_location).toBe('L3-L4')
    expect(mergeSupplementalCodeExtraction(extraction({}), supplemental).nodes[0]!.source_location).toBe('L1-L6')
  })

  it('retains SPI-only symbols and deduplicates shared provenance', () => {
    const shared = { capability_id: 'builtin:extract:typescript', stage: 'extract' }
    const primary = extraction({ provenance: [shared] })
    const supplemental = extraction({ provenance: [{ ...shared }] })
    supplemental.nodes.push({ id: 'spi_only', label: 'Request', file_type: 'code', source_file: '/src/request.ts', source_location: 'L8-L10' })

    const merged = mergeSupplementalCodeExtraction(primary, supplemental)

    expect(merged.nodes).toHaveLength(2)
    expect(merged.nodes[0]!.provenance).toEqual([shared])
    expect(merged.nodes[1]).toEqual(supplemental.nodes[1])
  })
})
