import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

interface WorkflowJob {
  environment?: string
  if?: string
  needs?: string | string[]
  outputs?: Record<string, unknown>
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
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
  jobs?: Record<string, WorkflowJob>
}

const classifierPath = resolve('.github/scripts/classify-release-tag.mjs')
const nextReleaseStatePath = resolve('.github/scripts/verify-next-release-state.mjs')
const qualificationGatePath = resolve('.github/scripts/check-qualification-gate.mjs')
const publishNextWorkflowPath = '.github/workflows/publish-next.yml'

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

function job(workflow: Workflow, jobName: string): WorkflowJob {
  const target = workflow.jobs?.[jobName]
  if (!target) {
    throw new Error(`Missing job: ${jobName}`)
  }
  return target
}

function workflowStep(workflow: Workflow, jobName: string, stepName: string): WorkflowStep {
  const step = job(workflow, jobName).steps?.find((candidate) => candidate.name === stepName)
  if (!step) {
    throw new Error(`Missing ${jobName} workflow step: ${stepName}`)
  }
  return step
}

function allSteps(workflow: Workflow, jobName: string): WorkflowStep[] {
  return job(workflow, jobName).steps ?? []
}

function withQualificationFixture(
  { contractPresent, scriptPresent }: { contractPresent: boolean; scriptPresent: boolean },
  runAssertion: (fixtureDir: string) => void,
): void {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'madar-qualification-gate-'))

  try {
    const scripts = scriptPresent ? { 'qualify:validate': 'node -e "process.exit(0)"' } : {}
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ scripts }))
    if (contractPresent) {
      mkdirSync(join(fixtureDir, 'docs', 'qualification'), { recursive: true })
    }
    runAssertion(fixtureDir)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
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

  it('rejects workflow_dispatch now that manual dispatch is removed from the pipeline', () => {
    const result = runNode(nextReleaseStatePath, [
      '--assert-event',
      '--event', 'workflow_dispatch',
      '--ref', 'refs/heads/next',
    ])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Publishing is not allowed')
  })

  it('allows a prerelease tag push', () => {
    const result = runNode(nextReleaseStatePath, [
      '--assert-event',
      '--event', 'push',
      '--ref', 'refs/tags/v1.2.3-beta.1',
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('event=allowed')
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

describe('qualification gate', () => {
  it('runs when the qualify:validate script is present, regardless of the contract', () => {
    withQualificationFixture({ contractPresent: false, scriptPresent: true }, (fixtureDir) => {
      const result = runNode(qualificationGatePath, [], fixtureDir)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('decision=run')
    })
  })

  it('records a notice when neither the qualification contract nor its script are present', () => {
    withQualificationFixture({ contractPresent: false, scriptPresent: false }, (fixtureDir) => {
      const result = runNode(qualificationGatePath, [], fixtureDir)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('decision=notice')
    })
  })

  it('hard-fails when the qualification contract exists but its validator script is missing', () => {
    withQualificationFixture({ contractPresent: true, scriptPresent: false }, (fixtureDir) => {
      const result = runNode(qualificationGatePath, [], fixtureDir)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('docs/qualification/')
      expect(result.stderr).toContain('is present on this commit, but the qualify:validate script is missing')
    })
  })

  it('still runs when both the contract and the script are present', () => {
    withQualificationFixture({ contractPresent: true, scriptPresent: true }, (fixtureDir) => {
      const result = runNode(qualificationGatePath, [], fixtureDir)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('decision=run')
    })
  })
})

describe('release workflow policy', () => {
  it('parses every release workflow as YAML', () => {
    expect(() => parseWorkflow('.github/workflows/ci.yml')).not.toThrow()
    expect(() => parseWorkflow('.github/workflows/release.yml')).not.toThrow()
    expect(() => parseWorkflow(publishNextWorkflowPath)).not.toThrow()
  })

  it('has no workflow_dispatch trigger and no dispatch inputs', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)

    expect(workflow.on?.workflow_dispatch).toBeUndefined()
    expect(workflow.on?.pull_request).toBeUndefined()
    expect(workflow.on?.push?.branches).toBeUndefined()
  })

  it('triggers only on approved prerelease tag pushes', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)

    expect(workflow.on?.push?.tags).toEqual([
      'v*-beta.*',
      'v*-rc.*',
      'v*-next.*',
    ])
  })

  it('derives the release tag solely from github.ref_name', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const validateJob = job(workflow, 'validate')

    expect(validateJob.if).toBe("startsWith(github.ref, 'refs/tags/')")
    expect(String((validateJob as { env?: Record<string, unknown> }).env?.RELEASE_TAG))
      .toBe('${{ github.ref_name }}')
  })

  it('defines exactly the three jobs validate, publish, post_publish with the right needs', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)

    expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(['post_publish', 'publish', 'validate'])
    expect(job(workflow, 'validate').needs).toBeUndefined()
    expect(job(workflow, 'publish').needs).toBe('validate')
    expect(job(workflow, 'post_publish').needs).toEqual(['validate', 'publish'])
  })

  it('grants the npm-next protected environment only to the publish job', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)

    expect(job(workflow, 'validate').environment).toBeUndefined()
    expect(job(workflow, 'publish').environment).toBe('npm-next')
    expect(job(workflow, 'post_publish').environment).toBeUndefined()
  })

  it('has no workflow-level id-token or contents: write permission', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)

    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('grants each job exactly the permissions it needs, and never combines id-token: write with contents: write', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)

    expect(job(workflow, 'validate').permissions).toEqual({ contents: 'read' })
    expect(job(workflow, 'publish').permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    expect(job(workflow, 'post_publish').permissions).toEqual({ contents: 'write' })

    for (const [jobName, jobDef] of Object.entries(workflow.jobs ?? {})) {
      const permissions = jobDef.permissions ?? {}
      const hasIdToken = permissions['id-token'] === 'write'
      const hasContentsWrite = permissions.contents === 'write'
      expect(hasIdToken && hasContentsWrite, `${jobName} must not combine id-token: write with contents: write`).toBe(false)
    }
  })

  it('keeps the publish job free of checkout, npm ci, tests, build, and repository scripts', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const steps = allSteps(workflow, 'publish')

    for (const step of steps) {
      expect(step.uses ?? '', 'publish must not use actions/checkout').not.toMatch(/actions\/checkout/)
      expect(step.run ?? '').not.toContain('npm ci')
      expect(step.run ?? '').not.toContain('npm run test')
      expect(step.run ?? '').not.toContain('npm run build')
      expect(step.run ?? '').not.toMatch(/\.github\/scripts\//)
    }
  })

  it('never runs a dependency cache in the publish job\'s Node setup', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const setupNode = workflowStep(workflow, 'publish', 'Set up Node.js')

    expect(setupNode.with).not.toHaveProperty('cache')
  })

  it('has no live publish command in validate or post_publish, only dry runs', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)

    for (const jobName of ['validate', 'post_publish']) {
      const steps = allSteps(workflow, jobName)
      for (const step of steps) {
        const run = step.run ?? ''
        if (run.includes('npm publish')) {
          expect(run, `${jobName} step "${step.name}" must be a dry run`).toContain('--dry-run')
        }
      }
    }
  })

  it('runs exactly one live publish command, in the publish job, as its final substantive step', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const allJobNames = Object.keys(workflow.jobs ?? {})

    const livePublishSteps: { jobName: string; index: number; step: WorkflowStep }[] = []
    for (const jobName of allJobNames) {
      const steps = allSteps(workflow, jobName)
      steps.forEach((step, index) => {
        const run = step.run ?? ''
        if (run.includes('npm publish') && !run.includes('--dry-run')) {
          livePublishSteps.push({ jobName, index, step })
        }
      })
    }

    expect(livePublishSteps).toHaveLength(1)
    const found = livePublishSteps[0]
    if (!found) {
      throw new Error('expected exactly one live publish step')
    }
    const { jobName, index, step } = found
    expect(jobName).toBe('publish')
    expect(step.name).toBe('Publish prerelease with npm Trusted Publishing')
    expect(index).toBe(allSteps(workflow, 'publish').length - 1)
    expect(step.run).toContain('npm publish "release-artifact/$TARBALL_NAME" --tag next --access public --provenance')
    expect(step.run).not.toContain('npm publish --access public')
    expect(step.run).not.toContain('NODE_AUTH_TOKEN')
  })

  it('publishes the exact downloaded tarball, never the working directory', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const publish = workflowStep(workflow, 'publish', 'Publish prerelease with npm Trusted Publishing')

    expect(publish.run).not.toMatch(/npm publish\s+\.\s/)
    expect(publish.run).not.toMatch(/npm publish\s+--tag/)
    expect(publish.run).toContain('"release-artifact/$TARBALL_NAME"')
  })

  it('records and verifies the release artifact SHA-256 across validate, publish, and post_publish', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const packStep = workflowStep(workflow, 'validate', 'Build release tarball and receipt')
    const verifyStep = workflowStep(workflow, 'publish', "Verify downloaded artifact against the validate job's receipt")

    expect(packStep.run).toContain('sha256sum')
    expect(job(workflow, 'validate').steps?.map((step) => step.name)).toContain('Upload release tarball artifact')
    expect(verifyStep.run).toContain('EXPECTED_TARBALL_SHA256')
    expect(verifyStep.run).toContain('sha256sum -c')

    const validateOutputs = (job(workflow, 'validate') as { outputs?: Record<string, unknown> }).outputs
    expect(String(validateOutputs?.tarball_sha256)).toContain('steps.pack.outputs.sha256')
  })

  it('names the uploaded artifact with the run id, run attempt, version, and commit', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const packStep = workflowStep(workflow, 'validate', 'Build release tarball and receipt')

    expect(packStep.run).toContain('github.run_id')
    expect(packStep.run).toContain('github.run_attempt')
    expect(packStep.run).toContain('PACKAGE_VERSION')
    expect(packStep.run).toContain('RELEASE_COMMIT')

    const uploadStep = workflowStep(workflow, 'validate', 'Upload release tarball artifact')
    expect(uploadStep.with?.name).toBe('${{ steps.pack.outputs.artifact_name }}')
    expect(uploadStep.with).toHaveProperty('retention-days')
  })

  it('captures pre-publish dist-tags in publish and preserves latest in post_publish', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const captureStep = workflowStep(workflow, 'publish', 'Capture pre-publish npm dist-tags')
    const verifyStep = workflowStep(workflow, 'post_publish', 'Verify published version and dist-tags')

    expect(captureStep.run).toContain('npm view "$PACKAGE_NAME" dist-tags --json')
    const publishOutputs = (job(workflow, 'publish') as { outputs?: Record<string, unknown> }).outputs
    expect(String(publishOutputs?.pre_publish_dist_tags)).toContain('steps.capture-dist-tags.outputs.json')
    expect(verifyStep.run).toContain('verify-next-release-state.mjs')
    expect(verifyStep.run).toContain('--verify-publish')
  })

  it('keeps every required validation gate in validate before the release tarball is built', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const steps = allSteps(workflow, 'validate')
    const packIndex = steps.findIndex((step) => step.name === 'Build release tarball and receipt')
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

    expect(packIndex).toBeGreaterThan(0)
    for (const command of requiredCommands) {
      const commandIndex = steps.findIndex((step) => step.run?.includes(command))
      expect(commandIndex, command).toBeGreaterThanOrEqual(0)
      expect(commandIndex, command).toBeLessThan(packIndex)
    }
    expect(workflowStep(workflow, 'validate', 'Run qualification validation when available').run)
      .toContain('npm run qualify:validate')
  })

  it('delegates the qualification gate decision to check-qualification-gate.mjs and acts on all three outcomes', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const step = workflowStep(workflow, 'validate', 'Run qualification validation when available')

    // The gate's own present/missing/notice decision table is exercised directly against
    // check-qualification-gate.mjs in the "qualification gate" describe block above; this test
    // only asserts the workflow step wires that decision to the right action.
    expect(step.run).toContain('check-qualification-gate.mjs')
    expect(step.run).toContain('decision=run')
    expect(step.run).toContain('npm run qualify:validate')
    expect(step.run).toContain("echo 'status=passed' >> \"$GITHUB_OUTPUT\"")
    expect(step.run).toContain('decision=notice')
    expect(step.run).toContain('qualify:validate is not present on this tag')
  })

  it('classifies the GitHub releases on the correct channels', () => {
    const stableWorkflow = parseWorkflow('.github/workflows/release.yml')
    const nextWorkflow = parseWorkflow(publishNextWorkflowPath)
    const stableClassifier = workflowStep(stableWorkflow, 'release', 'Require stable release tag')
    const prereleaseClassifier = workflowStep(nextWorkflow, 'validate', 'Validate prerelease tag and release files')
    const githubPrerelease = workflowStep(nextWorkflow, 'post_publish', 'Create or update GitHub prerelease')

    expect(stableClassifier.run).toContain('--expect stable')
    expect(prereleaseClassifier.run).toContain('--expect prerelease')
    expect(githubPrerelease.run).toContain('--prerelease')
    expect(workflowStep(stableWorkflow, 'release', 'Create GitHub release').run).not.toContain('--prerelease')
  })

  it('uses a 40-character commit SHA with a version comment for every action in the privileged workflow, and rejects mutable refs', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const raw = readFileSync(resolve(publishNextWorkflowPath), 'utf8')
    const usesLines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('uses:'))

    expect(usesLines.length).toBeGreaterThan(0)

    const mutableRefPattern = /@(v\d+|main|master)(\s|$)/
    for (const line of usesLines) {
      expect(line, line).not.toMatch(mutableRefPattern)
      const match = line.match(/uses:\s*([^@]+)@([0-9a-f]{40})(?:\s+#\s*(v[\w.]+))?/)
      expect(match, `${line} must pin a 40-character SHA with a # vX.Y.Z comment`).not.toBeNull()
      expect(match?.[3], `${line} must have a readable version comment`).toBeTruthy()
    }

    for (const jobDef of Object.values(workflow.jobs ?? {})) {
      for (const step of jobDef.steps ?? []) {
        if (!step.uses) continue
        expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
      }
    }
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

// ---------------------------------------------------------------------------------------------
// A: job outputs must map from step outputs, never from `env.*`. `env.PACKAGE_VERSION` and
// `env.RELEASE_COMMIT` are written at runtime via `>> "$GITHUB_ENV"`, which does not reliably
// populate `jobs.<id>.outputs` -- `publish` could receive empty version/commit. These tests
// prove the dataflow itself, not just that an `outputs:` block exists.
// ---------------------------------------------------------------------------------------------
describe('validate job output dataflow', () => {
  function assertOutputMapsFromStep(
    workflow: Workflow,
    jobName: string,
    outputName: string,
    expectedStepId: string,
  ): void {
    const targetJob = job(workflow, jobName)
    const rawValue = String(targetJob.outputs?.[outputName] ?? '').trim()

    expect(rawValue, `${jobName}.outputs.${outputName} must not be empty`).not.toBe('')
    expect(rawValue, `${jobName}.outputs.${outputName} must not read from env.*`).not.toMatch(/env\./)
    expect(
      rawValue,
      `${jobName}.outputs.${outputName} must map from steps.${expectedStepId}.outputs.*`,
    ).toMatch(new RegExp(`^\\$\\{\\{\\s*steps\\.${expectedStepId}\\.outputs\\.[\\w-]+\\s*\\}\\}$`))

    const producingStep = (targetJob.steps ?? []).find((step) => step.id === expectedStepId)
    expect(producingStep, `${jobName} must have a step with id "${expectedStepId}"`).toBeDefined()
  }

  function assertStepWritesOutputKey(step: WorkflowStep, key: string): void {
    const run = step.run ?? ''
    expect(run, `step "${step.name}" must write to $GITHUB_OUTPUT`).toMatch(/GITHUB_OUTPUT/)
    // Negative lookbehind for a word character rules out matching "tag_commit=" as a false
    // positive for the "commit=" key, while still matching `key=value`, `echo "key=$value"`,
    // and `{ echo "key=..." ; }` forms.
    expect(run, `step "${step.name}" must write the "${key}=" key`).toMatch(new RegExp(`(?<!\\w)${key}=`))
  }

  it('maps version and tag from the release-meta step output, not env.*', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    assertOutputMapsFromStep(workflow, 'validate', 'version', 'release-meta')
    assertOutputMapsFromStep(workflow, 'validate', 'tag', 'release-meta')
  })

  it('maps commit from the release-commit step output, not env.*', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    assertOutputMapsFromStep(workflow, 'validate', 'commit', 'release-commit')
  })

  it('has the release-meta step write version and tag to $GITHUB_OUTPUT', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const step = workflowStep(workflow, 'validate', 'Validate prerelease tag and release files')
    expect(step.id).toBe('release-meta')
    assertStepWritesOutputKey(step, 'version')
    assertStepWritesOutputKey(step, 'tag')
  })

  it('has the release-commit step write commit to $GITHUB_OUTPUT', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const step = workflowStep(workflow, 'validate', 'Prove exact tag commit and next ancestry')
    expect(step.id).toBe('release-commit')
    assertStepWritesOutputKey(step, 'commit')
  })

  it('still keeps tarball_name, tarball_sha256, artifact_name, and qualification_status mapped from their existing step outputs', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    assertOutputMapsFromStep(workflow, 'validate', 'tarball_name', 'pack')
    assertOutputMapsFromStep(workflow, 'validate', 'tarball_sha256', 'pack')
    assertOutputMapsFromStep(workflow, 'validate', 'artifact_name', 'pack')
    assertOutputMapsFromStep(workflow, 'validate', 'qualification_status', 'qualification')
  })

  it('has publish and post_publish consume validate metadata exclusively through needs.validate.outputs', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const publishEnv = (job(workflow, 'publish') as { env?: Record<string, unknown> }).env ?? {}
    const postPublishEnv = (job(workflow, 'post_publish') as { env?: Record<string, unknown> }).env ?? {}

    expect(String(publishEnv.PACKAGE_VERSION)).toBe('${{ needs.validate.outputs.version }}')
    expect(String(publishEnv.RELEASE_COMMIT)).toBe('${{ needs.validate.outputs.commit }}')
    expect(String(publishEnv.RELEASE_TAG)).toBe('${{ needs.validate.outputs.tag }}')
    expect(String(postPublishEnv.PACKAGE_VERSION)).toBe('${{ needs.validate.outputs.version }}')
    expect(String(postPublishEnv.RELEASE_COMMIT)).toBe('${{ needs.validate.outputs.commit }}')
    expect(String(postPublishEnv.RELEASE_TAG)).toBe('${{ needs.validate.outputs.tag }}')
  })

  it('rejects empty version/commit metadata before the publish job can act on it', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const verifyStep = workflowStep(workflow, 'publish', "Verify downloaded artifact against the validate job's receipt")

    // If validate ever emitted an empty version or commit, the receipt written in the same job
    // would carry that same empty value, and this comparison in `publish` would still catch it
    // because the empty EXPECTED_TARBALL_SHA256 / receipt fields could never match a real
    // artifact's real sha256/version/commit.
    expect(verifyStep.run).toContain('receipt.version !== process.env.PACKAGE_VERSION')
    expect(verifyStep.run).toContain('receipt.sourceCommit !== process.env.RELEASE_COMMIT')
    expect(verifyStep.run).toContain('receipt.tarballSha256 !== process.env.EXPECTED_TARBALL_SHA256')
  })

  it('detects a synthetic fixture job whose output maps from env.* instead of a step output', () => {
    const brokenWorkflow: Workflow = {
      jobs: {
        validate: {
          outputs: { version: '${{ env.PACKAGE_VERSION }}' },
          steps: [{ name: 'set env', run: 'printf \'PACKAGE_VERSION=1.2.3\\n\' >> "$GITHUB_ENV"' }],
        },
      },
    }

    expect(() => assertOutputMapsFromStep(brokenWorkflow, 'validate', 'version', 'release-meta')).toThrow()
  })

  it('detects a synthetic fixture step that declares an id but never writes the expected key to $GITHUB_OUTPUT', () => {
    const brokenStep: WorkflowStep = {
      id: 'release-meta',
      name: 'Validate prerelease tag and release files',
      run: 'printf \'PACKAGE_VERSION=1.2.3\\n\' >> "$GITHUB_ENV"',
    }

    expect(() => assertStepWritesOutputKey(brokenStep, 'version')).toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
// B: `release.yml` classify/release split. `classify` runs for every `v*` tag (including
// malformed/unapproved forms) and fails visibly on anything that is not a stable or approved
// prerelease tag; `release` only runs for a classified-stable tag.
// ---------------------------------------------------------------------------------------------
describe('release.yml classify/release split', () => {
  it('defines exactly the two jobs classify and release', () => {
    const workflow = parseWorkflow('.github/workflows/release.yml')
    expect(Object.keys(workflow.jobs ?? {}).sort()).toEqual(['classify', 'release'])
  })

  it('has no workflow-level contents: write permission', () => {
    const workflow = parseWorkflow('.github/workflows/release.yml')
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('gives classify read-only permissions and no environment', () => {
    const workflow = parseWorkflow('.github/workflows/release.yml')
    const classifyJob = job(workflow, 'classify')
    expect(classifyJob.permissions).toEqual({ contents: 'read' })
    expect(classifyJob.environment).toBeUndefined()
  })

  it('maps the classify job output from the classify step, never hardcoded or from env', () => {
    const workflow = parseWorkflow('.github/workflows/release.yml')
    const classifyOutputs = job(workflow, 'classify').outputs
    expect(String(classifyOutputs?.channel)).toBe('${{ steps.classify.outputs.channel }}')
  })

  it('makes release depend on classify, require success and the stable channel, and hold contents: write', () => {
    const workflow = parseWorkflow('.github/workflows/release.yml')
    const releaseJob = job(workflow, 'release')
    expect(releaseJob.needs).toBe('classify')
    expect(releaseJob.if).toBe("success() && needs.classify.outputs.channel == 'stable'")
    expect(releaseJob.permissions).toEqual({ contents: 'write' })
  })

  it('pins every action in release.yml to a 40-character SHA with a version comment', () => {
    const raw = readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    const usesLines = raw.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('uses:'))

    expect(usesLines.length).toBeGreaterThan(0)
    for (const line of usesLines) {
      expect(line, line).not.toMatch(/@(v\d+|main|master)(\s|$)/)
      const match = line.match(/uses:\s*([^@]+)@([0-9a-f]{40})(?:\s+#\s*(v[\w.]+))?/)
      expect(match, `${line} must pin a 40-character SHA with a # vX.Y.Z comment`).not.toBeNull()
      expect(match?.[3], `${line} must have a readable version comment`).toBeTruthy()
    }
  })
})

describe('release.yml classify step behavior across all four tag classes', () => {
  function runClassifyStep(tag: string): { status: number | null; stderr: string; outputContents: string } {
    const workflow = parseWorkflow('.github/workflows/release.yml')
    const step = workflowStep(workflow, 'classify', 'Classify release tag')

    const outputDir = mkdtempSync(join(tmpdir(), 'madar-classify-output-'))
    const outputFile = join(outputDir, 'github-output')
    writeFileSync(outputFile, '')

    try {
      const result = spawnSync('bash', ['-c', step.run ?? ''], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_OUTPUT: outputFile },
      })
      return {
        status: result.status,
        stderr: result.stderr ?? '',
        outputContents: readFileSync(outputFile, 'utf8'),
      }
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  }

  it('classifies a stable tag as channel=stable and exits 0', () => {
    const { status, outputContents } = runClassifyStep('v0.33.0')
    expect(status).toBe(0)
    expect(outputContents).toContain('channel=stable')
  })

  it.each(['v0.33.0-beta.1', 'v0.33.0-rc.1', 'v0.33.0-next.1'])(
    'classifies the approved prerelease tag %s as channel=prerelease and exits 0, so release skips cleanly',
    (tag) => {
      const { status, outputContents } = runClassifyStep(tag)
      expect(status).toBe(0)
      expect(outputContents).toContain('channel=prerelease')
      expect(outputContents).not.toContain('channel=stable')
    },
  )

  it.each(['v0.33.0-alpha.1', 'v0.33.0-preview.1', 'v0.33.0-beta', 'v0.33.0-beta.01'])(
    'fails the classify step visibly for the unsupported tag %s and emits no channel',
    (tag) => {
      const { status, stderr, outputContents } = runClassifyStep(tag)
      expect(status).not.toBe(0)
      expect(outputContents).not.toContain('channel=')
      expect(stderr).toContain('Release tag validation failed:')
    },
  )
})

// ---------------------------------------------------------------------------------------------
// C: a green vitest summary is not sufficient release evidence. These tests prove the raw-log
// gate is actually wired into `validate` for both test:run and test:coverage, that both statuses
// are captured explicitly (not `&&`), that the scanner runs even when the test command fails,
// and that the tarball is only ever built after both gates pass.
// ---------------------------------------------------------------------------------------------
describe('vitest raw-log gate wiring in validate', () => {
  it('scans both the test:run and test:coverage logs with the scanner script', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const testRunStep = workflowStep(workflow, 'validate', 'Run tests')
    const coverageStep = workflowStep(workflow, 'validate', 'Run tests with coverage thresholds')

    expect(testRunStep.run).toContain('npm run test:run')
    expect(testRunStep.run).toContain('.github/scripts/assert-clean-vitest-log.mjs')
    expect(testRunStep.run).toContain('test-run.log')

    expect(coverageStep.run).toContain('npm run test:coverage')
    expect(coverageStep.run).toContain('.github/scripts/assert-clean-vitest-log.mjs')
    expect(coverageStep.run).toContain('test-coverage.log')
  })

  it('captures both the test command and scanner exit status explicitly, not via &&', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    for (const stepName of ['Run tests', 'Run tests with coverage thresholds']) {
      const run = workflowStep(workflow, 'validate', stepName).run ?? ''
      expect(run, stepName).toContain('PIPESTATUS[0]')
      expect(run, stepName).toContain('test_status=')
      expect(run, stepName).toContain('scanner_status=$?')
      expect(run, stepName).not.toMatch(/test:(run|coverage)[^\n]*&&[^\n]*assert-clean-vitest-log/)
    }
  })

  it('disables -e so a failing test command cannot short-circuit the scanner', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    for (const stepName of ['Run tests', 'Run tests with coverage thresholds']) {
      expect(workflowStep(workflow, 'validate', stepName).run, stepName).toContain('set +e')
    }
  })

  it('fails the step when either the test command or the scanner reports non-zero', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    for (const stepName of ['Run tests', 'Run tests with coverage thresholds']) {
      const run = workflowStep(workflow, 'validate', stepName).run ?? ''
      expect(run, stepName).toContain('if [ "$test_status" -ne 0 ] || [ "$scanner_status" -ne 0 ]')
      expect(run, stepName).toContain('exit 1')
    }
  })

  it('uploads raw vitest logs only on failure, with bounded retention and a unique run/attempt name', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const uploadStep = workflowStep(workflow, 'validate', 'Upload raw vitest logs on failure')

    expect(uploadStep.if).toBe('failure()')
    expect(String(uploadStep.with?.name)).toContain('github.run_id')
    expect(String(uploadStep.with?.name)).toContain('github.run_attempt')
    expect(uploadStep.with).toHaveProperty('retention-days')
    expect(Number(uploadStep.with?.['retention-days'])).toBeLessThanOrEqual(14)
    expect(String(uploadStep.uses)).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
  })

  it('builds the release tarball only after both vitest gate steps have run', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    const steps = allSteps(workflow, 'validate')
    const testRunIndex = steps.findIndex((step) => step.name === 'Run tests')
    const coverageIndex = steps.findIndex((step) => step.name === 'Run tests with coverage thresholds')
    const packIndex = steps.findIndex((step) => step.name === 'Build release tarball and receipt')

    expect(testRunIndex).toBeGreaterThanOrEqual(0)
    expect(coverageIndex).toBeGreaterThan(testRunIndex)
    expect(packIndex).toBeGreaterThan(coverageIndex)
  })

  it('never lets publish download or otherwise consume the diagnostic vitest-log artifact', () => {
    const workflow = parseWorkflow(publishNextWorkflowPath)
    for (const step of allSteps(workflow, 'publish')) {
      if (step.uses?.includes('actions/download-artifact')) {
        expect(String(step.with?.name)).not.toContain('vitest-diagnostic-logs')
      }
      expect(step.run ?? '').not.toContain('vitest-diagnostic-logs')
    }
  })
})
