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
    expect(releaseDoc).toContain('npm sbom --sbom-format cyclonedx')
    expect(releaseDoc).toContain('sbom.cdx.json')
    expect(releaseDoc).toContain('npm publish --access public --provenance')
    expect(releaseDoc).toContain('docs/security/mcp-threat-model.md')
    expect(releaseDoc).toContain('madar --version')
    expect(releaseDoc).not.toContain('compat:pack:dry-run')
    expect(releaseDoc).not.toContain('compat:publish:public')
    expect(releaseDoc).not.toContain('`madar --version` and `madar --version`')
    expect(releaseDoc).not.toContain('legacy compatibility package')
    expect(releaseDoc.toLowerCase()).toContain('post-release')
    expect(releaseDoc).toContain('Any new public claim requires a reproducible artifact under `docs/benchmarks/suite/`')
    expect(contributing).toContain('docs/release.md')
  })
})
