import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { strict as assert } from 'node:assert'

const PACKAGE_JSON_PATH = resolve('package.json')
const README_PATH = resolve('README.md')
const CHANGELOG_PATH = resolve('CHANGELOG.md')

const REPOSITORY_WEB_URL = 'https://github.com/mohanagy/madar'
const REPOSITORY_GIT_URL = 'git+https://github.com/mohanagy/madar.git'
const BUGS_URL = `${REPOSITORY_WEB_URL}/issues`
const HOMEPAGE_URL = `${REPOSITORY_WEB_URL}#readme`
const RELEASE_BRANCHED_README_PATHS = new Set([
  'docs/team-enterprise-offer.md',
  'docs/telemetry.md',
])

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadText(path) {
  return readFileSync(path, 'utf8')
}

function collectMarkdownLinkTargets(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] ?? '')
}

function changelogAnchorForVersion(version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const versionHeading = loadText(CHANGELOG_PATH).match(new RegExp(`^## \\[${escapedVersion}\\] - (.+)$`, 'm'))

  assert.ok(versionHeading, 'CHANGELOG.md must contain a dated heading for the current package.json version')

  return `## [${version}] - ${versionHeading[1]}`
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replaceAll(' ', '-')
}

function changelogBranchForVersion(version) {
  return version.includes('-') ? 'next' : 'main'
}

function assertReleaseBranchedReadmeLinks(readme, version) {
  const expectedBranch = version.includes('-') ? 'next' : 'main'
  const invalidTargets = collectMarkdownLinkTargets(readme).filter((target) => {
    const match = target.match(/^https:\/\/github\.com\/mohanagy\/madar\/blob\/([^/]+)\/(.+)$/)
    return match !== null && RELEASE_BRANCHED_README_PATHS.has(match[2]) && match[1] !== expectedBranch
  })

  assert.deepEqual(
    invalidTargets,
    [],
    `release-sensitive README doc links must target blob/${expectedBranch} for ${version.includes('-') ? 'prereleases' : 'stable releases'}`,
  )
}

function main() {
  const packageManifest = loadJson(PACKAGE_JSON_PATH)
  const readme = loadText(README_PATH)
  const changelog = loadText(CHANGELOG_PATH)

  assert.equal(packageManifest.repository?.type, 'git', 'package.json repository.type must stay set to git')
  assert.equal(packageManifest.repository?.url, REPOSITORY_GIT_URL, 'package.json repository.url must point at the public Madar GitHub repo')
  assert.equal(packageManifest.bugs?.url, BUGS_URL, 'package.json bugs.url must point at the public Madar issue tracker')
  assert.equal(packageManifest.homepage, HOMEPAGE_URL, 'package.json homepage must point at the public Madar README')

  assert.ok(
    changelog.includes(`## [${packageManifest.version}]`),
    'CHANGELOG.md must contain a heading for the current package.json version',
  )

  const unstableReadmeTargets = collectMarkdownLinkTargets(readme).filter(
    (target) => target.length > 0 && !/^(https?:\/\/|mailto:|#)/.test(target),
  )
  assert.deepEqual(
    unstableReadmeTargets,
    [],
    'README.md must use npm-stable absolute URLs or anchors for all markdown links',
  )

  const expectedVersionedChangelogLink =
    `${REPOSITORY_WEB_URL}/blob/${changelogBranchForVersion(packageManifest.version)}/CHANGELOG.md#${changelogAnchorForVersion(packageManifest.version)}`
  assert.ok(
    readme.includes(expectedVersionedChangelogLink),
    'README.md must link the current "What\'s new" section to the matching changelog entry',
  )
  assertReleaseBranchedReadmeLinks(readme, packageManifest.version)

  console.log('Validated package metadata, changelog version, and npm-visible README links for release hygiene.')
}

main()
