import { describe, expect, it } from 'vitest'

import { deriveIngestProvenanceFromRecord } from '../../src/core/provenance/ingest.js'

describe('deriveIngestProvenanceFromRecord', () => {
  it('classifies arxiv hosts by hostname', () => {
    const provenance = deriveIngestProvenanceFromRecord({
      source_file: 'paper.md',
      source_url: 'https://export.arxiv.org/abs/1706.03762',
    })

    expect(provenance).toEqual(expect.objectContaining({
      capability_id: 'builtin:ingest:arxiv',
      source_url: 'https://export.arxiv.org/abs/1706.03762',
    }))
  })

  it('does not classify non-arxiv hosts that only mention arxiv.org in the path as arxiv', () => {
    const provenance = deriveIngestProvenanceFromRecord({
      source_file: 'paper.md',
      source_url: 'https://example.com/redirect/arxiv.org/abs/1706.03762',
    })

    expect(provenance).toEqual(expect.objectContaining({
      capability_id: 'builtin:ingest:webpage',
      source_url: 'https://example.com/redirect/arxiv.org/abs/1706.03762',
    }))
  })
})
