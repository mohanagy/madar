import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('release documentation', () => {
  it('documents the release checklist and links it from contributor docs', () => {
    const releaseDoc = readFileSync(resolve('docs/release.md'), 'utf8')
    const cliReference = readFileSync(resolve('docs/reference/cli-and-mcp.md'), 'utf8')
    const contributing = readFileSync(resolve('CONTRIBUTING.md'), 'utf8')
    const commandAllowlist = cliReference
      .match(/The public command allowlist is:\n\n```text\n([\s\S]*?)\n```/)?.[1]
      ?.split('\n')

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
    expect(commandAllowlist).toEqual([
      'madar generate [path] [options]',
      'madar query "<question>" [--graph graph.json] [--budget tokens]',
      'madar status [graph.json]',
      'madar doctor [graph.json]',
      'madar install <claude|codex> [--uninstall]',
      'madar mcp',
    ])
    expect(releaseDoc).toContain('madar generate .')
    expect(releaseDoc).toContain('madar query "trace the release path"')
    expect(releaseDoc).toContain('madar install claude')
    expect(releaseDoc).toContain('args `["mcp"]`')
    expect(releaseDoc).toContain('`~/.codex/config.toml` or `$CODEX_HOME/config.toml`')
    expect(releaseDoc).toContain('only the tools capability')
    expect(releaseDoc).toContain('exactly one `retrieve` tool')
    expect(releaseDoc).toContain('no resources or prompts')
    expect(releaseDoc).not.toContain('.codex/hooks.json')
    expect(releaseDoc).not.toContain('.codex/madar-user-prompt-submit.cjs')
    expect(releaseDoc).not.toContain('`.codex/config.toml`')
    expect(releaseDoc).not.toContain('`/hooks`')
    expect(releaseDoc).not.toContain('compat:pack:dry-run')
    expect(releaseDoc).not.toContain('compat:publish:public')
    expect(releaseDoc).not.toContain('`madar --version` and `madar --version`')
    expect(releaseDoc).not.toContain('legacy compatibility package')
    expect(releaseDoc.toLowerCase()).toContain('post-release')
    expect(releaseDoc).toContain('Any new public claim requires a reproducible artifact under `docs/benchmarks/suite/`')
    expect(contributing).toContain('docs/release.md')
  })

  it('keeps the checked supply-chain snapshot aligned with current dependencies', () => {
    const sbomText = readFileSync(resolve('sbom.cdx.json'), 'utf8')
    const sbom = JSON.parse(sbomText) as {
      metadata?: { component?: { name?: string, version?: string } }
      components?: Array<{ name?: string }>
    }

    expect(sbom.metadata?.component).toEqual(expect.objectContaining({
      name: '@lubab/madar',
      version: '0.32.0',
    }))
    expect(
      sbom.components
        ?.map((component) => component.name)
        .filter((name) => name?.startsWith('neo4j-driver')),
    ).toEqual([])
    expect(sbomText).not.toContain('neo4j-driver')
  })
})
