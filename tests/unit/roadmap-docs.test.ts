import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('roadmap documentation', () => {
  it('documents the public roadmap page and links it from the README', () => {
    const roadmap = readFileSync(resolve('docs/roadmap.md'), 'utf8')
    const readme = readFileSync(resolve('README.md'), 'utf8')

    expect(roadmap).toContain('# Public roadmap')
    expect(roadmap).toContain('issues/155')
    expect(roadmap).toContain('## P0')
    expect(roadmap).toContain('## P1')
    expect(roadmap).toContain('## P2')
    expect(roadmap).toContain('issues/159')
    expect(roadmap).toContain('issues/161')
    expect(roadmap).toContain('issues/186')
    expect(roadmap).toContain('help wanted')
    expect(roadmap).toContain('good first issue')
    expect(roadmap).toContain('priority:p1')
    expect(roadmap).toContain('area:docs')
    expect(readme).toContain('docs/roadmap.md')
  })
})
