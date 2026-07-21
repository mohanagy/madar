import { assertValid, validateExtraction } from '../../src/pipeline/extract/contracts.js'

const VALID_EXTRACTION = {
  nodes: [
    { id: 'n1', label: 'Foo', file_type: 'code', source_file: 'foo.py' },
    { id: 'n2', label: 'Bar', file_type: 'document', source_file: 'bar.md' },
  ],
  edges: [
    {
      source: 'n1',
      target: 'n2',
      relation: 'references',
      confidence: 'EXTRACTED',
      source_file: 'foo.py',
      weight: 1.0,
    },
  ],
}

describe('validateExtraction', () => {
  it('returns an empty array for valid extraction data', () => {
    expect(validateExtraction(VALID_EXTRACTION)).toEqual([])
  })

  it('reports a missing nodes key', () => {
    const errors = validateExtraction({ edges: [] })
    expect(errors.some((error) => error.includes('nodes'))).toBe(true)
  })

  it('reports a missing edges key', () => {
    const errors = validateExtraction({ nodes: [] })
    expect(errors.some((error) => error.includes('edges'))).toBe(true)
  })

  it('rejects non-object input', () => {
    const errors = validateExtraction([])
    expect(errors).toHaveLength(1)
  })

  it('reports invalid file_type values', () => {
    const errors = validateExtraction({
      nodes: [{ id: 'n1', label: 'X', file_type: 'binary', source_file: 'x.bin' }],
      edges: [],
    })

    expect(errors.some((error) => error.includes('file_type'))).toBe(true)
  })

  it('accepts audio and video file_type values', () => {
    const errors = validateExtraction({
      nodes: [
        { id: 'n1', label: 'Episode', file_type: 'audio', source_file: 'episode.mp3' },
        { id: 'n2', label: 'Demo', file_type: 'video', source_file: 'demo.mp4' },
      ],
      edges: [],
    })

    expect(errors).toEqual([])
  })

  it('reports invalid confidence values', () => {
    const errors = validateExtraction({
      nodes: [
        { id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' },
        { id: 'n2', label: 'B', file_type: 'code', source_file: 'b.py' },
      ],
      edges: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'calls',
          confidence: 'CERTAIN',
          source_file: 'a.py',
        },
      ],
    })

    expect(errors.some((error) => error.includes('confidence'))).toBe(true)
  })

  it('reports a dangling edge source', () => {
    const errors = validateExtraction({
      nodes: [{ id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' }],
      edges: [
        {
          source: 'missing_id',
          target: 'n1',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: 'a.py',
        },
      ],
    })

    expect(errors.some((error) => error.includes('source') && error.includes('missing_id'))).toBe(true)
  })

  it('reports a dangling edge target', () => {
    const errors = validateExtraction({
      nodes: [{ id: 'n1', label: 'A', file_type: 'code', source_file: 'a.py' }],
      edges: [
        {
          source: 'n1',
          target: 'ghost',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: 'a.py',
        },
      ],
    })

    expect(errors.some((error) => error.includes('target') && error.includes('ghost'))).toBe(true)
  })

  it('reports missing node fields', () => {
    const errors = validateExtraction({
      nodes: [{ id: 'n1', label: 'A', source_file: 'a.py' }],
      edges: [],
    })

    expect(errors.some((error) => error.includes('file_type'))).toBe(true)
  })
})

describe('assertValid', () => {
  it('throws on invalid extraction data', () => {
    expect(() => assertValid({ nodes: 'bad', edges: [], oops: true })).toThrow(/error/i)
  })

  it('passes silently on valid extraction data', () => {
    expect(() => assertValid(VALID_EXTRACTION)).not.toThrow()
  })
})
