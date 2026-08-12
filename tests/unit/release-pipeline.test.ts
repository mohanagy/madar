import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface Workflow {
  on?: {
    pull_request?: unknown
    push?: {
      branches?: string[]
      tags?: string[]
    }
    workflow_dispatch?: unknown
  }
  permissions?: Record<string, string>
  jobs?: Record<string, {
    environment?: string
    if?: string
    steps?: WorkflowStep[]
  }>
}

const classifierPath = resolve('.github/scripts/classify-release-tag.mjs')
const nextReleaseStatePath = resolve('.github/scripts/verify-next-release-state.mjs')

function runNode(script: string, args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function parseWorkflow(path: string): Workflow {
  return parse(readFileSync(resolve(path), 'utf8')) as Workflow
}

function workflowStep(workflow: Workflow, jobName: string, stepName: string): WorkflowStep {
  const step = workflow.jobs?.[jobName]?.steps?.find((candidate) => candidate.name === stepName)
  if (!step) {
    throw new Error(`Missing ${jobName} workflow step: ${stepName}`)
  }
  return step
}

function withReleaseFixture(
  packageVersion: string,
  changelog: string,
  runAssertion: (fixtureDir: string) => void,
): void {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-release-tag-'))

  try {
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ version: packageVersion }))
    writeFileSync(join(fixtureDir, 'CHANGELOG.md'), changelog)
    runAssertion(fixtureDir)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
}

describe('release tag classifier', () => {
  it('classifies stable SemVer tags', () => {
    const result = runNode(classifierPath, ['--tag', 'v1.2.3'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('channel=stable')
    expect(result.stdout).toContain('version=1.2.3')
  })

  it.each(['v1.2.3-beta.0', 'v1.2.3-rc.2', 'v1.2.3-next.42'])(
    'classifies the approved prerelease tag %s',
    (tag) => {
      const result = runNode(classifierPath, ['--tag', tag])

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('channel=prerelease')
    },
  )

  it.each([
    'v1.2.3-alpha.1',
    'v1.2.3-beta',
    'v1.2.3-preview.0',
    'v1.2.3-beta.01',
    'v1.2.3-beta.1.trailing',
    '1.2.3',
    'v1.two.3',
    'v1.2.3+build.1',
  ])('rejects the invalid release tag %s', (tag) => {
    const result = runNode(classifierPath, ['--tag', tag])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Release tag validation failed:')
  })

  it('rejects a tag/package version mismatch independently', () => {
    withReleaseFixture('1.2.4', '## [1.2.3]\n', (fixtureDir) => {
      const result = runNode(classifierPath, [
        '--tag', 'v1.2.3',
        '--verify-package-version',
      ], fixtureDir)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('does not match package.json version 1.2.4')
    })
  })

  it('rejects a missing changelog section independently', () => {
    withReleaseFixture('1.2.3-beta.1', '## [Unreleased]\n', (fixtureDir) => {
      const result = runNode(classifierPath, [
        '--tag', 'v1.2.3-beta.1',
        '--verify-changelog',
      ], fixtureDir)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('CHANGELOG.md is missing a ## [1.2.3-beta.1] section')
    })
  })

  it('makes the prerelease path reject a stable tag', () => {
    const result = runNode(classifierPath, ['--tag', 'v1.2.3', '--expect', 'prerelease'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('this release path requires a prerelease tag')
  })

  it('makes the stable path reject a prerelease tag', () => {
    const result = runNode(classifierPath, ['--tag', 'v1.2.3-beta.1', '--expect', 'stable'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('this release path requires a stable tag')
  })
})

describe('next release state guards', () => {
  it.each([
    ['push', 'refs/heads/next'],
    ['pull_request', 'refs/pull/123/merge'],
  ])('rejects publication for a %s event on %s', (eventName, ref) => {
    const result = runNode(nextReleaseStatePath, [
      '--assert-event',
      '--event', eventName,
      '--ref', ref,
    ])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Publishing is not allowed')
  })

  it('rejects a tagged commit outside next', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-next-ancestor-'))

    try {
      execFileSync('git', ['init', '-b', 'next'], { cwd: fixtureDir, stdio: 'pipe' })
      execFileSync('git', ['config', 'user.email', 'madar@example.com'], { cwd: fixtureDir })
      execFileSync('git', ['config', 'user.name', 'Madar Test'], { cwd: fixtureDir })
      writeFileSync(join(fixtureDir, 'fixture.txt'), 'base\n')
      execFileSync('git', ['add', 'fixture.txt'], { cwd: fixtureDir })
      execFileSync('git', ['commit', '-m', 'base'], { cwd: fixtureDir, stdio: 'pipe' })
      execFileSync('git', ['switch', '-c', 'outside'], { cwd: fixtureDir, stdio: 'pipe' })
      writeFileSync(join(fixtureDir, 'fixture.txt'), 'outside\n')
      execFileSync('git', ['commit', '-am', 'outside'], { cwd: fixtureDir, stdio: 'pipe' })
      const outsideCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixtureDir,
        encoding: 'utf8',
      }).trim()
      execFileSync('git', ['switch', 'next'], { cwd: fixtureDir, stdio: 'pipe' })

      const result = runNode(nextReleaseStatePath, [
        '--assert-ancestor',
        '--commit', outsideCommit,
        '--branch', 'next',
      ], fixtureDir)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('is outside next')
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('rejects an already-published version', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-published-version-'))

    try {
      const versionsPath = join(fixtureDir, 'versions.json')
      writeFileSync(versionsPath, JSON.stringify(['0.32.1', '0.33.0-beta.1']))

      const result = runNode(nextReleaseStatePath, [
        '--assert-unpublished',
        '--version', '0.33.0-beta.1',
        '--versions-file', versionsPath,
      ])

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('is already published')
      expect(result.stderr).toContain('prepare a new prerelease number')
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('preserves latest while moving next to the published version', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-dist-tags-'))

    try {
      const beforePath = join(fixtureDir, 'before.json')
      const afterPath = join(fixtureDir, 'after.json')
      const resolvedPath = join(fixtureDir, 'resolved.json')
      writeFileSync(beforePath, JSON.stringify({ latest: '0.32.1', next: '0.33.0-beta.0' }))
      writeFileSync(afterPath, JSON.stringify({ latest: '0.32.1', next: '0.33.0-beta.1' }))
      writeFileSync(resolvedPath, JSON.stringify('0.33.0-beta.1'))

      const validResult = runNode(nextReleaseStatePath, [
        '--verify-publish',
        '--version', '0.33.0-beta.1',
        '--before', beforePath,
        '--after', afterPath,
        '--resolved-version', resolvedPath,
      ])
      expect(validResult.status).toBe(0)

      writeFileSync(afterPath, JSON.stringify({ latest: '0.33.0-beta.1', next: '0.33.0-beta.1' }))
      const changedLatestResult = runNode(nextReleaseStatePath, [
        '--verify-publish',
        '--version', '0.33.0-beta.1',
        '--before', beforePath,
        '--after', afterPath,
        '--resolved-version', resolvedPath,
      ])
      expect(changedLatestResult.status).not.toBe(0)
      expect(changedLatestResult.stderr).toContain('npm dist-tag latest changed')
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})

describe('release workflow policy', () => {
  it('parses every release workflow as YAML', () => {
    expect(() => parseWorkflow('.github/workflows/ci.yml')).not.toThrow()
    expect(() => parseWorkflow('.github/workflows/release.yml')).not.toThrow()
    expect(() => parseWorkflow('.github/workflows/publish-next.yml')).not.toThrow()
  })

  it('allows prerelease publication only from prerelease tags or manual dispatch', () => {
    const workflow = parseWorkflow('.github/workflows/publish-next.yml')

    expect(workflow.on?.push?.branches).toBeUndefined()
    expect(workflow.on?.push?.tags).toEqual([
      'v*-beta.*',
      'v*-rc.*',
      'v*-next.*',
    ])
    expect(workflow.on?.pull_request).toBeUndefined()
    expect(workflow.on?.workflow_dispatch).toBeDefined()
    expect(workflow.jobs?.publish?.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(workflow.jobs?.publish?.if).toContain("startsWith(github.ref, 'refs/tags/')")
  })

  it('uses protected OIDC publication without a privileged dependency cache', () => {
    const workflow = parseWorkflow('.github/workflows/publish-next.yml')
    const checkout = workflowStep(workflow, 'publish', 'Check out exact prerelease commit')
    const setupNode = workflowStep(workflow, 'publish', 'Set up Node.js')
    const publish = workflowStep(workflow, 'publish', 'Publish prerelease with npm Trusted Publishing')

    expect(workflow.permissions).toEqual({ contents: 'write', 'id-token': 'write' })
    expect(workflow.jobs?.publish?.environment).toBe('npm-next')
    expect(checkout.with).toMatchObject({
      'fetch-depth': 0,
      'persist-credentials': false,
    })
    // Ref injection guard: checkout runs before any validation, so a ref derived from
    // workflow_dispatch input could supply its own validation scripts and pass every gate.
    // The ref must come from github.sha, which GitHub resolves from the workflow ref.
    expect(checkout.with?.ref).toBe('${{ github.sha }}')
    expect(String(checkout.with?.ref)).not.toContain('inputs.')
    // The published artifact must be validated on a Node version the CI matrix tests.
    expect(['20', '22']).toContain(String(setupNode.with?.['node-version']))
    expect(setupNode.with).not.toHaveProperty('cache')
    expect(publish.run).toContain('npm publish --tag next --access public --provenance')
    expect(publish.run).not.toContain('npm publish --access public')
    expect(publish.run).not.toContain('NODE_AUTH_TOKEN')
  })

  it('keeps every required prerelease validation gate before publication', () => {
    const workflow = parseWorkflow('.github/workflows/publish-next.yml')
    const steps = workflow.jobs?.publish?.steps ?? []
    const publishIndex = steps.findIndex((step) => step.name === 'Publish prerelease with npm Trusted Publishing')
    const requiredCommands = [
      'npm ci',
      'npm run typecheck',
      'npm run test:run',
      'npm run test:coverage',
      'npm run build',
      'npm run verify:pack-parity',
      'npm run registry:validate',
      'npm run release:verify',
      'npm pack --dry-run',
      'npm publish --dry-run --tag next',
    ]

    expect(publishIndex).toBeGreaterThan(0)
    for (const command of requiredCommands) {
      const commandIndex = steps.findIndex((step) => step.run?.includes(command))
      expect(commandIndex, command).toBeGreaterThanOrEqual(0)
      expect(commandIndex, command).toBeLessThan(publishIndex)
    }
    expect(workflowStep(workflow, 'publish', 'Run qualification validation when available').run)
      .toContain('npm run qualify:validate')
  })

  it('classifies the GitHub releases on the correct channels', () => {
    const stableWorkflow = parseWorkflow('.github/workflows/release.yml')
    const nextWorkflow = parseWorkflow('.github/workflows/publish-next.yml')
    const stableClassifier = workflowStep(stableWorkflow, 'release', 'Require stable release tag')
    const prereleaseClassifier = workflowStep(nextWorkflow, 'publish', 'Validate prerelease tag and release files')
    const githubPrerelease = workflowStep(nextWorkflow, 'publish', 'Create or update GitHub prerelease')

    expect(stableClassifier.run).toContain('--expect stable')
    expect(prereleaseClassifier.run).toContain('--expect prerelease')
    expect(githubPrerelease.run).toContain('--prerelease')
    expect(workflowStep(stableWorkflow, 'release', 'Create GitHub release').run).not.toContain('--prerelease')
  })

  it('keeps release documentation consistent with both channels', () => {
    const releaseDoc = readFileSync(resolve('docs/release.md'), 'utf8')
    const contributing = readFileSync(resolve('CONTRIBUTING.md'), 'utf8')

    expect(releaseDoc).toContain('npm install -g @lubab/madar')
    expect(releaseDoc).toContain('npm install -g @lubab/madar@next')
    expect(releaseDoc).toContain('npm install -g @lubab/madar@0.33.0-beta.1')
    expect(releaseDoc).toContain('## Beta preparation (10 steps)')
    expect(releaseDoc).toContain('## Stable promotion (8 steps)')
    expect(releaseDoc).toContain('not cross-platform proof')
    expect(contributing).toContain('Issue branches')
    expect(contributing).toContain('reviewed `next` → `main` pull request')
  })
})
