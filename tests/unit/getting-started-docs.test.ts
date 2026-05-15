import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('getting started tutorial', () => {
  it('documents an end-to-end sample workspace walkthrough', () => {
    const tutorial = readFileSync(resolve('docs/tutorials/getting-started.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(tutorial).toContain('npm install -g @mohammednagy/graphify-ts')
    expect(tutorial).toContain('graphify-ts generate examples/sample-workspace --no-html')
    expect(tutorial).toContain('graphify-ts pack')
    expect(tutorial).toContain('graphify-ts prompt')
    expect(tutorial).toContain('graphify-ts compare')
    expect(tutorial).toContain('--exec')
    expect(tutorial).toContain('--yes')
    expect(tutorial.toLowerCase()).toContain('expected output')
    expect(tutorial.toLowerCase()).toContain('troubleshooting')
    expect(tutorial.toLowerCase()).toContain('optional')
    expect(tutorial).toContain('examples/sample-workspace')
    expect(readme).toContain('docs/tutorials/getting-started.md')
  })
})
