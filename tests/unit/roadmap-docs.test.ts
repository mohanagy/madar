import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('roadmap documentation', () => {
  it('documents the public roadmap page and links it from the README', () => {
    const roadmap = readFileSync(resolve('docs/roadmap.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')
    const contributing = readFileSync(resolve('CONTRIBUTING.md'), 'utf8')

    expect(roadmap).toContain('# Public roadmap')
    expect(roadmap).toContain('## Recently shipped')
    expect(roadmap).toContain('## v0.26')
    expect(roadmap).toContain('## v0.27')
    expect(roadmap).toContain('## v0.28')
    expect(roadmap).toContain('## v0.29')
    expect(roadmap).toContain('## v0.30')
    expect(roadmap).toContain('issues/260')
    expect(roadmap).toContain('issues/261')
    expect(roadmap).toContain('issues/262')
    expect(roadmap).toContain('issues/263')
    expect(roadmap).not.toContain('graphify-ts')
    expect(roadmap).toContain('help wanted')
    expect(roadmap).toContain('good first issue')
    expect(roadmap).toContain('runtime trust')
    expect(roadmap).toContain('answer quality')
    expect(roadmap).toContain('TypeScript and Node.js framework coverage')
    expect(roadmap).toContain('MCP/session efficiency')
    expect(readme).toContain('docs/roadmap.md')
    expect(contributing).toContain('docs/roadmap.md')
    expect(contributing).not.toContain('issues/155')
  })
})
