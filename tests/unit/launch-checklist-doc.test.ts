import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('launch checklist documentation', () => {
  it('publishes a proof-first launch checklist and links it from release/docs surfaces', () => {
    const checklist = readFileSync(resolve('docs/launch-checklist.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')
    const releaseDoc = readFileSync(resolve('docs/release.md'), 'utf8')
    const roadmap = readFileSync(resolve('docs/roadmap.md'), 'utf8')

    expect(checklist).toContain('# Launch checklist')
    expect(checklist).toContain('## Required proof block')
    expect(checklist).toContain('Release or milestone')
    expect(checklist).toContain('Primary audience')
    expect(checklist).toContain('Task type')
    expect(checklist).toContain('Proof links')
    expect(checklist).toContain('Caveats')
    expect(checklist).toContain('## Channel tracker')
    expect(checklist).toContain('| Surface | Update required before posting | Proof link required | Caveats included | Status | Owner |')
    expect(checklist).toContain('GitHub repo metadata')
    expect(checklist).toContain('npm package metadata')
    expect(checklist).toContain('MCP Registry')
    expect(checklist).toContain('Awesome MCP')
    expect(checklist).toContain('Reddit')
    expect(checklist).toContain('Hacker News')
    expect(checklist).toContain('Lobsters')
    expect(checklist).toContain('demo video')
    expect(checklist).toContain('blog post')
    expect(checklist).toContain('## Benchmark-backed launch draft')
    expect(checklist).toContain('#469')
    expect(checklist).toContain('docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.md')
    expect(checklist).toContain('530/570/610')
    expect(checklist).toContain('360/400/440')
    expect(checklist).toContain('validation pass 3/3')
    expect(checklist).toContain('rework 0')
    expect(checklist).toContain('Do not post generic "new open-source tool" messages')

    expect(readme).toContain('docs/launch-checklist.md')
    expect(releaseDoc).toContain('docs/launch-checklist.md')
    expect(roadmap).toContain('issues/474')
  })
})
