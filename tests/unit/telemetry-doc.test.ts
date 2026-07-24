import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('telemetry documentation', () => {
  it('keeps telemetry opt-in and source-safe without retired product telemetry', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')
    const doc = readFileSync(resolve('docs/telemetry.md'), 'utf8')

    expect(readme).toContain('Telemetry is disabled unless you explicitly enable it')
    for (const field of [
      'command',
      'stage',
      'version',
      'os',
      'node_major',
      'graph_size_bucket',
      'repo_size_bucket',
      'failure_bucket',
      'status_bucket',
    ]) {
      expect(doc).toContain(field)
    }
    expect(doc).toContain('madar telemetry clear')
    expect(doc).toContain('madar telemetry report')
    expect(doc).toContain('question or prompt text')
    expect(doc).toContain('answer text')
    expect(doc).toContain('source paths')
    expect(doc).toContain('source content')
    expect(doc).toContain('DO_NOT_TRACK=1')
    expect(doc).toContain('MADAR_DISABLE_TELEMETRY=1')
    expect(doc).not.toContain('context_pack')
    expect(doc).not.toContain('answerability_bucket')
  })
})
