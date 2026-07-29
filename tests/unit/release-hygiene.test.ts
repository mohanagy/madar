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
    expect(releaseDoc).toContain('npm version 0.40.0-beta.3 --no-git-tag-version')
    expect(releaseDoc).toContain('`main` for stable releases, `next` for prereleases')
    expect(releaseDoc).toContain('npm publish --tag next --access public --provenance')
  })

  it('creates hyphenated GitHub releases as prereleases without moving latest', () => {
    const releaseWorkflow = loadFile('.github/workflows/release.yml')

    expect(releaseWorkflow).toContain('if [[ "$VERSION" == *-* ]]')
    expect(releaseWorkflow).toContain('RELEASE_FLAGS+=(--prerelease --latest=false)')
    expect(releaseWorkflow).toContain('--verify-tag')
  })

  it('publishes the beta only from the exact next tip through OIDC provenance', () => {
    const releaseWorkflow = loadFile('.github/workflows/release.yml')
    const publishIndex = releaseWorkflow.indexOf('npm run publish:next')
    const githubReleaseIndex = releaseWorkflow.indexOf('gh release create')
    const nextFetches = releaseWorkflow.match(/git fetch --no-tags origin next/g) ?? []
    const remoteTagChecks = releaseWorkflow.match(/git ls-remote origin/g) ?? []
    const protectionChecks = releaseWorkflow.match(/verify_next_protection/g) ?? []

    expect(existsSync(join(process.cwd(), '.github/workflows/publish-npm.yml'))).toBe(false)
    expect(releaseWorkflow).toContain('id-token: write')
    expect(releaseWorkflow).toContain('persist-credentials: false')
    expect(releaseWorkflow).toContain('package-manager-cache: false')
    expect(releaseWorkflow).not.toContain('cache: npm')
    expect(nextFetches.length).toBeGreaterThanOrEqual(4)
    expect(remoteTagChecks.length).toBeGreaterThanOrEqual(3)
    expect(releaseWorkflow).toContain('if [[ "$RELEASE_SHA" != "$NEXT_SHA" ]]')
    expect(releaseWorkflow).toContain("branches/next\" --jq '.protected'")
    expect(protectionChecks.length).toBeGreaterThanOrEqual(3)
    expect(releaseWorkflow).toContain('test "$RELEASE_SHA" = "$GITHUB_SHA"')
    expect(releaseWorkflow).toContain('verify_remote_tag')
    expect(releaseWorkflow).toContain('if [[ "$VERSION" != "0.40.0-beta.3" ]]')
    expect(releaseWorkflow).toContain('npm run publish:next')
    expect(releaseWorkflow).toContain('dist.attestations.provenance')
    expect(releaseWorkflow).toContain('npm --prefix "$VERIFY_DIR" audit signatures')
    expect(releaseWorkflow).toContain('c72c5f786dd07aff16f3ef4990bb4d166a197791')
    expect(releaseWorkflow).toContain(
      'sha512-ulfQ/bNBKz5VDzErYke1hsk3xIxoZtaJKZlN/lsRb60Tq7wvUnFFlxFR2sdkRQ9HBNBWgc/vhpcCgVvdPEk1lw==',
    )
    expect(releaseWorkflow).toContain('LATEST_VERSION" == "0.32.0"')
    expect(publishIndex).toBeGreaterThan(0)
    expect(githubReleaseIndex).toBeGreaterThan(publishIndex)
    expect(releaseWorkflow).not.toContain('NPM_TOKEN')
    expect(releaseWorkflow).not.toContain('--no-provenance')
  })

  it('verifies an existing or newly created GitHub prerelease without moving latest', () => {
    const releaseWorkflow = loadFile('.github/workflows/release.yml')

    expect(releaseWorkflow).toContain('git ls-remote origin "refs/tags/$TAG" "refs/tags/$TAG^{}"')
    expect(releaseWorkflow).toContain('test "$REMOTE_TAG_SHA" = "$GITHUB_SHA"')
    expect(releaseWorkflow).toContain('--target "$GITHUB_SHA"')
    expect(releaseWorkflow).toContain("'.target_commitish'")
    expect(releaseWorkflow).toContain("'.prerelease'")
    expect(releaseWorkflow).toContain("'.draft'")
    expect(releaseWorkflow).toContain('releases/latest')
    expect(releaseWorkflow).toContain('"v0.32.0"')
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
