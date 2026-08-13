import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NUMERIC_IDENTIFIER = '(?:0|[1-9][0-9]*)'
const CORE_VERSION = `(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})`
const STABLE_TAG_PATTERN = new RegExp(`^v${CORE_VERSION}$`)
const PRERELEASE_TAG_PATTERN = new RegExp(`^v${CORE_VERSION}-(beta|rc|next)\\.(${NUMERIC_IDENTIFIER})$`)
const VERSIONED_PRERELEASE_PREFIX_PATTERN = new RegExp(`^v${CORE_VERSION}-`)

function fail(message) {
  throw new Error(message)
}

export function classifyReleaseTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) {
    fail('A release tag is required (for example, v1.2.3 or v1.2.3-beta.1)')
  }

  if (STABLE_TAG_PATTERN.test(tag)) {
    return {
      channel: 'stable',
      tag,
      version: tag.slice(1),
    }
  }

  const prereleaseMatch = tag.match(PRERELEASE_TAG_PATTERN)
  if (prereleaseMatch) {
    return {
      channel: 'prerelease',
      prerelease: `${prereleaseMatch[4]}.${prereleaseMatch[5]}`,
      tag,
      version: tag.slice(1),
    }
  }

  if (VERSIONED_PRERELEASE_PREFIX_PATTERN.test(tag)) {
    fail(`Invalid prerelease tag "${tag}": approved forms are -beta.N, -rc.N, or -next.N with a non-negative integer N`)
  }

  fail(`Malformed release tag "${tag}": expected vMAJOR.MINOR.PATCH or an approved prerelease tag`)
}

export function assertExpectedChannel(classification, expectedChannel) {
  if (expectedChannel !== 'stable' && expectedChannel !== 'prerelease') {
    fail(`Unknown expected channel "${expectedChannel}": use stable or prerelease`)
  }

  if (classification.channel !== expectedChannel) {
    fail(`Tag ${classification.tag} is ${classification.channel}; this release path requires a ${expectedChannel} tag`)
  }
}

export function assertTagMatchesPackageVersion(classification, packageVersion) {
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    fail('package.json must contain a non-empty version field')
  }

  if (classification.version !== packageVersion) {
    fail(`Tag ${classification.tag} does not match package.json version ${packageVersion}`)
  }
}

export function assertChangelogContainsVersion(version, changelog) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headingPattern = new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`, 'm')

  if (!headingPattern.test(changelog)) {
    fail(`CHANGELOG.md is missing a ## [${version}] section`)
  }
}

function parseArguments(args) {
  const options = {
    changelogPath: 'CHANGELOG.md',
    packageJsonPath: 'package.json',
    verifyChangelog: false,
    verifyPackageVersion: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--verify-package-version') {
      options.verifyPackageVersion = true
      continue
    }
    if (argument === '--verify-changelog') {
      options.verifyChangelog = true
      continue
    }

    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      fail(`${argument} requires a value`)
    }

    if (argument === '--tag') {
      options.tag = value
    } else if (argument === '--expect') {
      options.expectedChannel = value
    } else if (argument === '--package-json') {
      options.packageJsonPath = value
    } else if (argument === '--changelog') {
      options.changelogPath = value
    } else {
      fail(`Unknown argument "${argument}"`)
    }
    index += 1
  }

  return options
}

export function runCli(args) {
  const options = parseArguments(args)
  const classification = classifyReleaseTag(options.tag)

  if (options.expectedChannel) {
    assertExpectedChannel(classification, options.expectedChannel)
  }

  if (options.verifyPackageVersion) {
    const packageManifest = JSON.parse(readFileSync(resolve(options.packageJsonPath), 'utf8'))
    assertTagMatchesPackageVersion(classification, packageManifest.version)
  }

  if (options.verifyChangelog) {
    const changelog = readFileSync(resolve(options.changelogPath), 'utf8')
    assertChangelogContainsVersion(classification.version, changelog)
  }

  console.log(`channel=${classification.channel}`)
  console.log(`version=${classification.version}`)
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Release tag validation failed: ${message}`)
    process.exitCode = 1
  }
}
