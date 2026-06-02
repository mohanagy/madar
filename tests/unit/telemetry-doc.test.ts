import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('telemetry documentation', () => {
  it('documents the opt-in controls in the README', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(readme).toContain('madar telemetry enable')
    expect(readme).toContain('madar telemetry disable')
    expect(readme).toContain('madar telemetry clear')
    expect(readme).toContain('madar telemetry report')
    expect(readme).toContain('MADAR_ENABLE_TELEMETRY=1')
    expect(readme).toContain('docs/telemetry.md')
    expect(readme).toContain('Telemetry is disabled unless you explicitly enable it')
  })

  it('documents collected and excluded telemetry fields explicitly', () => {
    const doc = readFileSync(resolve('docs/telemetry.md'), 'utf8')

    expect(doc).toContain('command')
    expect(doc).toContain('stage')
    expect(doc).toContain('version')
    expect(doc).toContain('os')
    expect(doc).toContain('node_major')
    expect(doc).toContain('graph_size_bucket')
    expect(doc).toContain('repo_size_bucket')
    expect(doc).toContain('failure_bucket')
    expect(doc).toContain('status_bucket')
    expect(doc).toContain('madar telemetry clear')
    expect(doc).toContain('madar telemetry report')
    expect(doc).toContain('prompt text')
    expect(doc).toContain('answer text')
    expect(doc).toContain('source paths')
    expect(doc).toContain('source content')
    expect(doc).toContain('DO_NOT_TRACK=1')
    expect(doc).toContain('MADAR_DISABLE_TELEMETRY=1')
  })
})
