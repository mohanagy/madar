import { spawnSync } from 'node:child_process'

function fail(message) {
  throw new Error(message)
}

function assertTagAbsent(result, tag) {
  if (result.error || result.status !== 0) {
    fail(`Unable to prove forbidden git tag ${tag} is absent`)
  }
  if (result.stdout.trim() !== '') {
    fail(`Beta.5 publication forbids git tag ${tag}`)
  }
}

function githubStatusCodes(result) {
  const output = `${result.stdout}\n${result.stderr}`
  return [...output.matchAll(/^HTTP\/[0-9.]+\s+(\d{3})\b/gm)]
    .map((match) => Number(match[1]))
}

function assertGithubReleaseAbsent(result, tag) {
  if (result.error) {
    fail(`Unable to prove forbidden GitHub Release ${tag} is absent`)
  }
  if (result.status === 0) {
    fail(`Beta.5 publication forbids GitHub Release ${tag}`)
  }

  const statusCodes = githubStatusCodes(result)
  const finalStatus = statusCodes.at(-1)
  if (finalStatus !== 404) {
    fail(
      finalStatus === undefined
        ? `GitHub Release absence probe for ${tag} returned no authenticated HTTP status`
        : `GitHub Release absence probe for ${tag} returned HTTP ${finalStatus}, not 404`,
    )
  }
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function verify(tag) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) fail('GITHUB_REPOSITORY is required')
  if (!tag) fail('The exact forbidden release tag is required')

  const tagResult = run('git', [
    'ls-remote',
    'origin',
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ])
  assertTagAbsent(tagResult, tag)

  const releaseResult = run('gh', [
    'api',
    '--include',
    `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
  ])
  assertGithubReleaseAbsent(releaseResult, tag)
}

function expectFailure(action, pattern) {
  try {
    action()
  } catch (error) {
    if (error instanceof Error && pattern.test(error.message)) return
    throw error
  }
  fail(`Expected failure matching ${pattern}`)
}

function selfTest() {
  const tag = 'v0.40.0-beta.5'
  expectFailure(
    () => assertTagAbsent({ status: 128, stdout: '', stderr: 'network error' }, tag),
    /Unable to prove forbidden git tag/,
  )
  expectFailure(
    () => assertTagAbsent({ status: 0, stdout: 'deadbeef refs\/tags\/v0.40.0-beta.5\n', stderr: '' }, tag),
    /forbids git tag/,
  )
  expectFailure(
    () => assertGithubReleaseAbsent({ status: 1, stdout: 'HTTP\/2.0 403 Forbidden\n', stderr: '' }, tag),
    /HTTP 403, not 404/,
  )
  expectFailure(
    () => assertGithubReleaseAbsent({ status: 1, stdout: '', stderr: 'network error' }, tag),
    /no authenticated HTTP status/,
  )
  expectFailure(
    () => assertGithubReleaseAbsent({ status: 0, stdout: 'HTTP\/2.0 200 OK\n', stderr: '' }, tag),
    /forbids GitHub Release/,
  )
  assertGithubReleaseAbsent(
    { status: 1, stdout: 'HTTP/2.0 404 Not Found\n', stderr: 'gh: Not Found (HTTP 404)' },
    tag,
  )
  console.log('Forbidden release-artifact probes fail closed.')
}

try {
  if (process.argv[2] === '--self-test') {
    selfTest()
  } else {
    verify(process.argv[2])
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
