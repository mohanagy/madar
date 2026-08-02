import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface PackageManifest {
  scripts?: Record<string, string>
}

function loadFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function loadPackageManifest(): PackageManifest {
  return JSON.parse(loadFile('package.json')) as PackageManifest
}

function releaseVerifyScriptPath(): string {
  return join(process.cwd(), '.github/scripts/verify-release-hygiene.mjs')
}

function forbiddenReleaseArtifactsScriptPath(): string {
  return join(process.cwd(), '.github/scripts/verify-forbidden-release-artifacts.mjs')
}

function collectMarkdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] ?? '')
}

function withReleaseFixture(
  version: string,
  readmeLink: string,
  runAssertion: (runVerify: () => string) => void,
): void {
  withReleaseReadmeFixture(version, `[release notes](${readmeLink})\n`, runAssertion)
}

function withReleaseReadmeFixture(
  version: string,
  readmeMarkdown: string,
  runAssertion: (runVerify: () => string) => void,
): void {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-release-hygiene-'))

  try {
    writeFileSync(
      join(fixtureDir, 'package.json'),
      JSON.stringify(
        {
          name: '@lubab/madar',
          version,
          mcpName: 'io.github.mohanagy/madar',
          repository: {
            type: 'git',
            url: 'git+https://github.com/mohanagy/madar.git',
          },
          bugs: {
            url: 'https://github.com/mohanagy/madar/issues',
          },
          homepage: 'https://github.com/mohanagy/madar#readme',
        },
        null,
        2,
      ),
    )
    writeFileSync(join(fixtureDir, 'README.md'), readmeMarkdown)
    writeFileSync(join(fixtureDir, 'CHANGELOG.md'), `## [${version}] - 2026-05-29\n`)

    runAssertion(() =>
      execFileSync(process.execPath, [releaseVerifyScriptPath()], {
        cwd: fixtureDir,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    )
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

describe('release hygiene', () => {
  it('keeps npm-visible README links stable', () => {
    const readme = loadFile('README.md')
    const unstableTargets = collectMarkdownLinkTargets(readme).filter(
      (target) => target.length > 0 && !/^(https?:\/\/|mailto:|#)/.test(target),
    )

    expect(unstableTargets).toEqual([])
  })

  it('ships a dedicated release verification command', () => {
    const scripts = loadPackageManifest().scripts ?? {}

    expect(scripts['release:verify']).toBe('node .github/scripts/verify-release-hygiene.mjs')
    expect(scripts['publish:next']).toBe('npm publish --tag next --access public --provenance')
    expect(() =>
      execFileSync(process.execPath, [releaseVerifyScriptPath()], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })

  it('requires the README changelog link to match the current release heading exactly', () => {
    withReleaseFixture('0.27.4', 'https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0274---wrong-date', (runVerify) => {
      expect(runVerify).toThrow(/matching changelog entry/)
    })
  })

  it('documents the release verification command in the release checklist', () => {
    const releaseDoc = loadFile('docs/release.md')

    expect(releaseDoc).toContain('npm run release:verify')
    expect(releaseDoc).toContain('npm version 0.40.0-beta.5 --no-git-tag-version')
    expect(releaseDoc).toContain('`main` for stable releases, `next` for prereleases')
    expect(releaseDoc).toContain('npm publish --tag next --access public --provenance')
  })

  it('publishes beta.5 from a protected next push without a tag or GitHub Release', () => {
    const releaseWorkflow = loadFile('.github/workflows/release.yml')

    expect(releaseWorkflow).toContain('branches:')
    expect(releaseWorkflow).toContain('- next')
    expect(releaseWorkflow).toContain('- package.json')
    expect(releaseWorkflow).not.toContain('tags:')
    expect(releaseWorkflow).not.toContain('gh release create')
    expect(releaseWorkflow).not.toContain('contents: write')
  })

  it('publishes the beta only from the exact next tip through OIDC provenance', () => {
    const releaseWorkflow = loadFile('.github/workflows/release.yml')
    const publishIndex = releaseWorkflow.indexOf('npm run publish:next')
    const nextFetches = releaseWorkflow.match(/git fetch --no-tags origin next/g) ?? []
    const protectionChecks = releaseWorkflow.match(/verify_next_protection/g) ?? []

    expect(existsSync(join(process.cwd(), '.github/workflows/publish-npm.yml'))).toBe(false)
    expect(releaseWorkflow).toContain('id-token: write')
    expect(releaseWorkflow).toContain('persist-credentials: false')
    expect(releaseWorkflow).toContain('package-manager-cache: false')
    expect(releaseWorkflow).not.toContain('cache: npm')
    expect(nextFetches.length).toBeGreaterThanOrEqual(3)
    expect(releaseWorkflow).toContain('if [[ "$RELEASE_SHA" != "$NEXT_SHA" ]]')
    expect(releaseWorkflow).toContain("branches/next\" --jq '.protected'")
    expect(protectionChecks.length).toBeGreaterThanOrEqual(3)
    expect(releaseWorkflow).toContain('test "$RELEASE_SHA" = "$GITHUB_SHA"')
    expect(releaseWorkflow).toContain('test "$GITHUB_REF" = "refs/heads/next"')
    expect(releaseWorkflow).toContain('verify_forbidden_release_artifacts_absent')
    expect(releaseWorkflow).toContain('if [[ "$VERSION" != "0.40.0-beta.5" ]]')
    expect(releaseWorkflow).toContain('npm run publish:next')
    expect(releaseWorkflow).toContain('dist.attestations.provenance')
    expect(releaseWorkflow).toContain('cd "$VERIFY_DIR"')
    expect(releaseWorkflow).toContain('npm audit signatures')
    expect(releaseWorkflow).not.toContain('npm --prefix "$VERIFY_DIR" init')
    expect(releaseWorkflow).toContain('d637297412ec5b868586ba59142fbefdcfc0d5e0')
    expect(releaseWorkflow).toContain(
      'sha512-HorzqtIvp2v5xMaYVGDzPDYtFBMaEVBkGXHBdTSVwC1DkQgmZaFuTU1Ff+7YByWN9FTQaVLTJsV7zKhEgSKxXw==',
    )
    expect(releaseWorkflow).toContain('LATEST_VERSION" == "0.32.0"')
    expect(publishIndex).toBeGreaterThan(0)
    expect(releaseWorkflow).not.toContain('NPM_TOKEN')
    expect(releaseWorkflow).not.toContain('--no-provenance')
  })

  it('proves beta.5 has no tag or GitHub Release before and after publication', () => {
    const releaseWorkflow = loadFile('.github/workflows/release.yml')
    const absenceChecks = releaseWorkflow.match(
      /node \.github\/scripts\/verify-forbidden-release-artifacts\.mjs "\$TAG"/g,
    ) ?? []
    const absenceScript = loadFile('.github/scripts/verify-forbidden-release-artifacts.mjs')

    expect(absenceChecks.length).toBeGreaterThanOrEqual(3)
    expect(absenceScript).toContain("'ls-remote'")
    expect(absenceScript).toContain("'--include'")
    expect(absenceScript).toContain('finalStatus !== 404')
    expect(absenceScript).toContain('Unable to prove forbidden git tag')
    expect(absenceScript).toContain('Unable to prove forbidden GitHub Release')
    expect(() => execFileSync(
      process.execPath,
      [forbiddenReleaseArtifactsScriptPath(), '--self-test'],
      { encoding: 'utf8', stdio: 'pipe' },
    )).not.toThrow()
    expect(releaseWorkflow).not.toContain('refs/tags/$TAG^{commit}')
    expect(releaseWorkflow).not.toContain('gh release view')
    expect(releaseWorkflow).not.toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
  })

  it('requires prerelease README changelog links to target next', () => {
    withReleaseFixture(
      '0.27.7-next.0',
      'https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0277-next0---2026-05-29',
      (runVerify) => {
        expect(runVerify).toThrow(/matching changelog entry/)
      },
    )
  })

  it('accepts prerelease README changelog links that target next', () => {
    withReleaseFixture(
      '0.27.7-next.0',
      'https://github.com/mohanagy/madar/blob/next/CHANGELOG.md#0277-next0---2026-05-29',
      (runVerify) => {
        expect(runVerify).not.toThrow()
      },
    )
  })

  it('requires next-only README doc links to target next for prereleases', () => {
    withReleaseReadmeFixture(
      '0.27.7-next.0',
      [
        '[release notes](https://github.com/mohanagy/madar/blob/next/CHANGELOG.md#0277-next0---2026-05-29)',
        '[enterprise offer](https://github.com/mohanagy/madar/blob/main/docs/team-enterprise-offer.md)',
        '',
      ].join('\n'),
      (runVerify) => {
        expect(runVerify).toThrow(/release-sensitive README doc links must target blob\/next/)
      },
    )
  })

  it('requires release-sensitive README doc links to target main for stable releases', () => {
    withReleaseReadmeFixture(
      '0.27.7',
      [
        '[release notes](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0277---2026-05-29)',
        '[enterprise offer](https://github.com/mohanagy/madar/blob/next/docs/team-enterprise-offer.md)',
        '',
      ].join('\n'),
      (runVerify) => {
        expect(runVerify).toThrow(/release-sensitive README doc links must target blob\/main/)
      },
    )
  })
})
