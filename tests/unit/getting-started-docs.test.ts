import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('getting started tutorial', () => {
  it('documents an end-to-end sample workspace walkthrough', () => {
    const tutorial = readFileSync(resolve('docs/tutorials/getting-started.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(tutorial).toContain('npm install -g sadeem')
    expect(tutorial).not.toContain('migration')
    expect(tutorial).toContain('sadeem generate examples/sample-workspace --no-html')
    expect(tutorial).toContain('sadeem pack')
    expect(tutorial).toContain('sadeem prompt')
    expect(tutorial).toContain('sadeem compare')
    expect(tutorial).toContain('--exec')
    expect(tutorial).toContain('--yes')
    expect(tutorial.toLowerCase()).toContain('expected output')
    expect(tutorial.toLowerCase()).toContain('troubleshooting')
    expect(tutorial.toLowerCase()).toContain('optional')
    expect(tutorial).toContain('examples/sample-workspace')
    expect(readme).toContain('docs/tutorials/getting-started.md')
  })
})
