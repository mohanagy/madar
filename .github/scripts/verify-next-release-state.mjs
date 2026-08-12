import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(message) {
  throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'))
}

function publishedVersionList(value) {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value
  }
  fail('Published npm versions must be a JSON string or array of strings')
}

export function assertPublishEventAllowed(eventName, ref) {
  if (eventName === 'workflow_dispatch') {
    return
  }
  if (eventName === 'push' && ref.startsWith('refs/tags/')) {
    return
  }

  fail(`Publishing is not allowed for ${eventName} on ${ref}; use an approved prerelease tag or workflow_dispatch`)
}

export function assertVersionIsUnpublished(version, publishedVersions) {
  if (publishedVersionList(publishedVersions).includes(version)) {
    fail(`@lubab/madar@${version} is already published; npm versions are immutable, so prepare a new prerelease number`)
  }
}

export function assertCommitIsAncestor(commit, branch, isAncestor) {
  if (!isAncestor) {
    fail(`Tagged commit ${commit} is outside ${branch}; prereleases must come from the next branch`)
  }
}

export function assertPostPublishState(version, beforeTags, afterTags, resolvedVersion) {
  if (afterTags.next !== version) {
    fail(`npm dist-tag next points to ${String(afterTags.next)} instead of ${version}`)
  }
  if (afterTags.latest !== beforeTags.latest) {
    fail(`npm dist-tag latest changed from ${String(beforeTags.latest)} to ${String(afterTags.latest)} during prerelease publication`)
  }
  if (resolvedVersion !== version) {
    fail(`@lubab/madar@${version} resolved as ${String(resolvedVersion)} after publication`)
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name)
  if (index === -1) {
    return undefined
  }
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    fail(`${name} requires a value`)
  }
  return value
}

function requireArgument(args, name) {
  const value = argumentValue(args, name)
  if (!value) {
    fail(`${name} is required`)
  }
  return value
}

function gitCommitIsAncestor(commit, branch) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, branch], {
    encoding: 'utf8',
    stdio: 'pipe',
  })

  if (result.status === 0) {
    return true
  }
  if (result.status === 1) {
    return false
  }

  fail(result.stderr.trim() || `git merge-base failed with status ${String(result.status)}`)
}

export function runCli(args) {
  if (args.includes('--assert-event')) {
    assertPublishEventAllowed(
      requireArgument(args, '--event'),
      requireArgument(args, '--ref'),
    )
    console.log('event=allowed')
    return
  }

  if (args.includes('--assert-unpublished')) {
    const version = requireArgument(args, '--version')
    const versions = readJson(requireArgument(args, '--versions-file'))
    assertVersionIsUnpublished(version, versions)
    console.log('version=unpublished')
    return
  }

  if (args.includes('--assert-ancestor')) {
    const commit = requireArgument(args, '--commit')
    const branch = requireArgument(args, '--branch')
    assertCommitIsAncestor(commit, branch, gitCommitIsAncestor(commit, branch))
    console.log('ancestor=true')
    return
  }

  if (args.includes('--verify-publish')) {
    const version = requireArgument(args, '--version')
    const beforeTags = readJson(requireArgument(args, '--before'))
    const afterTags = readJson(requireArgument(args, '--after'))
    const resolvedVersion = readJson(requireArgument(args, '--resolved-version'))
    assertPostPublishState(version, beforeTags, afterTags, resolvedVersion)
    console.log('publication=verified')
    return
  }

  fail('Choose one mode: --assert-event, --assert-unpublished, --assert-ancestor, or --verify-publish')
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Next release validation failed: ${message}`)
    process.exitCode = 1
  }
}
