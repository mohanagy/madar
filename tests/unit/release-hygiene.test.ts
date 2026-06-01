import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    expect(scripts['publish:next']).toBe('npm publish --tag next --access public')
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
    expect(releaseDoc).toContain('`main` for stable releases, `next` for prereleases')
    expect(releaseDoc).toContain('npm publish --tag next --access public --provenance')
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
        '[telemetry](https://github.com/mohanagy/madar/blob/main/docs/telemetry.md)',
        '',
      ].join('\n'),
      (runVerify) => {
        expect(runVerify).toThrow(/next-only README doc links must target blob\/next/)
      },
    )
  })
})
