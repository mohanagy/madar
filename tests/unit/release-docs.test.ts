import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('release documentation', () => {
  it('documents the release checklist and links it from contributor docs', () => {
    const releaseDoc = readFileSync(resolve('docs/release.md'), 'utf8')
    const contributing = readFileSync(resolve('CONTRIBUTING.md'), 'utf8')

    expect(releaseDoc).toContain('npm version')
    expect(releaseDoc).toContain('CHANGELOG.md')
    expect(releaseDoc).toContain('npm run typecheck')
    expect(releaseDoc).toContain('npm run build')
    expect(releaseDoc).toContain('npm run test:run')
    expect(releaseDoc).toContain('npm pack --dry-run')
    expect(releaseDoc).toContain('graphify-ts --version')
    expect(releaseDoc).toContain('graphify-ts generate .')
    expect(releaseDoc).toContain('graphify-ts claude install')
    expect(releaseDoc.toLowerCase()).toContain('post-release')
    expect(contributing).toContain('docs/release.md')
  })
})
