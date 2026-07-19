import { createCapabilityRegistry, type CapabilityDefinition } from '../../src/infrastructure/capabilities.js'
import {
  dispatchSingleFileExtraction,
  type ExtractionFileOutcome,
  type ExtractionFragment,
} from '../../src/pipeline/extract/dispatch.js'

function makeExtraction(label: string): ExtractionFragment {
  return {
    nodes: [
      {
        id: `${label}-node`,
        label,
        file_type: 'code',
        source_file: `/tmp/${label}.py`,
      },
    ],
    edges: [],
  }
}

describe('dispatchSingleFileExtraction', () => {
  it('dispatches through the registry-selected handler and writes the result to cache', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const registry = createCapabilityRegistry([capability])
    const extraction = makeExtraction('python-result')
    const writes: ExtractionFragment[] = []

    const result = dispatchSingleFileExtraction(
      '/tmp/example.py',
      new Set(['/tmp/example.py']),
      {
        'custom:extract:python': () => extraction,
      },
      {
        registry,
        readCached: () => null,
        writeCached: (_filePath, cachedExtraction) => {
          writes.push(cachedExtraction)
        },
      },
    )

    expect(result).toEqual(extraction)
    expect(writes).toEqual([extraction])
  })

  it('returns the cached extraction before resolving a handler', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const registry = createCapabilityRegistry([capability])
    const cached = makeExtraction('cached-result')

    const result = dispatchSingleFileExtraction(
      '/tmp/example.py',
      new Set(['/tmp/example.py']),
      {
        'custom:extract:python': () => {
          throw new Error('handler should not run when cache is warm')
        },
      },
      {
        registry,
        readCached: () => cached,
        writeCached: () => {
          throw new Error('cache write should not run for cached results')
        },
      },
    )

    expect(result).toEqual(cached)
  })

  it('returns an empty fragment when no registered capability matches the file', () => {
    const outcomes: ExtractionFileOutcome[] = []
    const result = dispatchSingleFileExtraction('/tmp/example.unknown', new Set(), {}, {
      registry: createCapabilityRegistry(),
      onOutcome: (outcome) => outcomes.push(outcome),
    })

    expect(result).toEqual({ nodes: [], edges: [] })
    expect(outcomes).toEqual([expect.objectContaining({
      filePath: '/tmp/example.unknown',
      status: 'unsupported',
      reason: 'capability_missing',
    })])
  })

  it('uses source classification to disambiguate handlers that share an extension', () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:extract:markdown-document',
        kind: 'extract',
        fileType: 'document',
        extensions: ['.md'],
      },
      {
        id: 'custom:extract:markdown-paper',
        kind: 'extract',
        fileType: 'paper',
        extensions: ['.md'],
      },
    ])
    const paperExtraction = makeExtraction('paper-result')

    const result = dispatchSingleFileExtraction(
      '/tmp/paper.md',
      new Set(['/tmp/paper.md']),
      {
        'custom:extract:markdown-document': () => makeExtraction('document-result'),
        'custom:extract:markdown-paper': () => paperExtraction,
      },
      {
        registry,
        readCached: () => null,
        classifySourceFile: () => 'paper',
      },
    )

    expect(result).toEqual(paperExtraction)
  })

  it('throws when a capability resolves but no handler is registered for it', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const registry = createCapabilityRegistry([capability])

    expect(() => dispatchSingleFileExtraction('/tmp/example.py', new Set(), {}, { registry })).toThrow(/No extractor handler registered/i)
  })

  it('records empty extraction as an explicit failed outcome', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const outcomes: ExtractionFileOutcome[] = []

    const result = dispatchSingleFileExtraction(
      '/tmp/empty.py',
      new Set(['/tmp/empty.py']),
      { 'custom:extract:python': () => ({ nodes: [], edges: [] }) },
      {
        registry: createCapabilityRegistry([capability]),
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    )

    expect(result).toEqual({ nodes: [], edges: [] })
    expect(outcomes).toEqual([expect.objectContaining({
      status: 'failed',
      reason: 'empty_extraction',
      capability: 'custom:extract:python',
    })])
  })

  it('records parser diagnostics as indexed-with-warnings', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const outcomes: ExtractionFileOutcome[] = []
    const extraction = {
      ...makeExtraction('fallback'),
      diagnostics: [{ code: 'parser_fallback', level: 'warning' as const, message: 'fallback used' }],
    }

    dispatchSingleFileExtraction(
      '/tmp/fallback.py',
      new Set(['/tmp/fallback.py']),
      { 'custom:extract:python': () => extraction },
      {
        registry: createCapabilityRegistry([capability]),
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    )

    expect(outcomes).toEqual([expect.objectContaining({
      status: 'indexed_with_warnings',
      reason: 'parser_fallback',
      diagnostics: extraction.diagnostics,
    })])
  })

  it('can recover a per-file extractor failure and report it without losing successful files', () => {
    const capability: CapabilityDefinition = {
      id: 'custom:extract:python',
      kind: 'extract',
      fileType: 'code',
      extensions: ['.py'],
    }
    const outcomes: ExtractionFileOutcome[] = []
    const registry = createCapabilityRegistry([capability])
    const dependencies = {
      registry,
      recoverFailures: true,
      onOutcome: (outcome: ExtractionFileOutcome) => outcomes.push(outcome),
    }

    const failed = dispatchSingleFileExtraction(
      '/tmp/broken.py',
      new Set(['/tmp/broken.py', '/tmp/healthy.py']),
      { 'custom:extract:python': () => { throw new Error('parser exploded') } },
      dependencies,
    )
    const healthy = dispatchSingleFileExtraction(
      '/tmp/healthy.py',
      new Set(['/tmp/broken.py', '/tmp/healthy.py']),
      { 'custom:extract:python': () => makeExtraction('healthy') },
      dependencies,
    )

    expect(failed).toEqual({ nodes: [], edges: [] })
    expect(healthy.nodes).toHaveLength(1)
    expect(outcomes).toEqual([
      expect.objectContaining({
        filePath: '/tmp/broken.py',
        status: 'failed',
        reason: 'extractor_error',
        diagnostics: [expect.objectContaining({ message: 'parser exploded' })],
      }),
      expect.objectContaining({
        filePath: '/tmp/healthy.py',
        status: 'indexed',
        reason: 'indexed',
      }),
    ])
  })
})
