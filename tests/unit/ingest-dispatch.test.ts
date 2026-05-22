import { createCapabilityRegistry } from '../../src/infrastructure/capabilities.js'
import { dispatchIngest, type IngestDispatchResult } from '../../src/infrastructure/ingest/dispatch.js'

function makeTextResult(label: string): IngestDispatchResult {
  return {
    kind: 'text',
    asset: {
      fileName: `${label}.md`,
      content: label,
    },
  }
}

describe('dispatchIngest', () => {
  it('dispatches through the registry-selected ingest handler', async () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:ingest:tweet',
        kind: 'ingest',
        urlType: 'tweet',
      },
    ])
    const result = await dispatchIngest(
      'tweet',
      'https://x.com/user/status/1',
      {},
      {
        'custom:ingest:tweet': async () => makeTextResult('tweet-result'),
      },
      { registry },
    )

    expect(result).toEqual(makeTextResult('tweet-result'))
  })

  it('falls back to the webpage ingest capability when the url type has no dedicated registration', async () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:ingest:webpage',
        kind: 'ingest',
        urlType: 'webpage',
      },
    ])

    const result = await dispatchIngest(
      'github',
      'https://github.com/mohanagy/madar',
      {},
      {
        'custom:ingest:webpage': async () => makeTextResult('webpage-result'),
      },
      { registry },
    )

    expect(result).toEqual(makeTextResult('webpage-result'))
  })

  it('throws when no ingest handler is registered for the resolved capability', async () => {
    const registry = createCapabilityRegistry([
      {
        id: 'custom:ingest:pdf',
        kind: 'ingest',
        urlType: 'pdf',
      },
    ])

    await expect(dispatchIngest('pdf', 'https://example.com/paper.pdf', {}, {}, { registry })).rejects.toThrow(/No ingest handler registered/i)
  })
})
