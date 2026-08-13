import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  env?: Record<string, unknown>
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(path), 'utf8')
}

function parseWorkflow(path: string): Workflow {
  return parse(readRepoFile(path)) as Workflow
}

function workflowStep(path: string, jobName: string, stepName: string): WorkflowStep {
  const step = parseWorkflow(path).jobs?.[jobName]?.steps?.find((candidate) => candidate.name === stepName)
  if (!step) {
    throw new Error(`Missing ${jobName} workflow step: ${stepName}`)
  }
  return step
}

describe('guarded Vitest repository policy', () => {
  it('guards both public complete-suite npm scripts', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.['test:run']).toContain('scripts/run-guarded-vitest.mjs')
    expect(packageJson.scripts?.['test:coverage']).toContain('scripts/run-guarded-vitest.mjs')
    expect(packageJson.scripts?.test).toBe('vitest')
  })

  it('imports the canonical scanner instead of duplicating its signature policy', () => {
    const scannerSource = readRepoFile('.github/scripts/assert-clean-vitest-log.mjs')
    const runnerSource = readRepoFile('scripts/run-guarded-vitest.mjs')

    expect(runnerSource).toContain("from '../.github/scripts/assert-clean-vitest-log.mjs'")
    expect(runnerSource).toContain('assertCleanVitestLogs')
    expect(runnerSource).toContain('formatReport')
    expect(runnerSource).toContain('WORKER_FAILURE_SIGNATURES')
    for (const signature of [
      'Failed to start forks worker',
      'Timeout waiting for worker to respond',
    ]) {
      expect(scannerSource).toContain(signature)
      expect(runnerSource).not.toContain(signature)
    }
  })

  it('keeps CI complete-suite steps guarded and publishes only their failure logs', () => {
    const testRun = workflowStep('.github/workflows/ci.yml', 'validate', 'Run tests')
    const coverage = workflowStep('.github/workflows/ci.yml', 'validate', 'Run tests with coverage thresholds')
    const upload = workflowStep('.github/workflows/ci.yml', 'validate', 'Upload raw vitest logs on failure')

    expect(testRun.run).toBe('npm run test:run')
    expect(testRun.env?.VITEST_GUARD_LOG_PATH).toBe(
      '${{ runner.temp }}/vitest-guard-test-run-${{ matrix.os }}-node${{ matrix.node-version }}.log',
    )
    expect(coverage.run).toBe('npm run test:coverage')
    expect(coverage.env?.VITEST_GUARD_LOG_PATH).toBe(
      '${{ runner.temp }}/vitest-guard-test-coverage-${{ matrix.os }}-node${{ matrix.node-version }}.log',
    )
    expect(upload.if).toBe('failure()')
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(String(upload.with?.name)).toContain('github.run_id')
    expect(String(upload.with?.name)).toContain('github.run_attempt')
    expect(String(upload.with?.name)).toContain('matrix.os')
    expect(String(upload.with?.name)).toContain('matrix.node-version')
    expect(String(upload.with?.path)).toContain('vitest-guard-test-run-')
    expect(String(upload.with?.path)).toContain('vitest-guard-test-coverage-')
    expect(upload.with?.['if-no-files-found']).toBe('ignore')
    expect(upload.with?.['retention-days']).toBe(7)
  })

  it('keeps stable release tests guarded and uploads the one possible failure log', () => {
    const testRun = workflowStep('.github/workflows/release.yml', 'release', 'Run tests')
    const upload = workflowStep('.github/workflows/release.yml', 'release', 'Upload raw vitest logs on failure')

    expect(testRun.run).toBe('npm run test:run')
    expect(testRun.env?.VITEST_GUARD_LOG_PATH).toBe(
      '${{ runner.temp }}/vitest-guard-test-run-ubuntu-latest-node20.log',
    )
    expect(upload.if).toBe('failure()')
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(String(upload.with?.name)).toContain('github.run_id')
    expect(String(upload.with?.name)).toContain('github.run_attempt')
    expect(upload.with?.path).toBe('${{ runner.temp }}/vitest-guard-test-run-ubuntu-latest-node20.log')
    expect(upload.with?.['if-no-files-found']).toBe('ignore')
    expect(upload.with?.['retention-days']).toBe(7)
  })

  it('keeps publish-next on its existing direct canonical scanner gate', () => {
    expect(readRepoFile('.github/workflows/publish-next.yml'))
      .toContain('.github/scripts/assert-clean-vitest-log.mjs')
  })

  it('contains no raw vitest run invocation in any workflow', () => {
    const workflowDirectory = resolve('.github/workflows')
    for (const filename of readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'))) {
      expect(readFileSync(resolve(workflowDirectory, filename), 'utf8'), filename)
        .not.toMatch(/\bvitest run\b/)
    }
  })

  it('preserves the four-worker, no-retry Vitest configuration', () => {
    const config = readRepoFile('vitest.config.ts')

    expect(config).toMatch(/\bmaxWorkers:\s*4\b/)
    expect(config).not.toMatch(/\bretry\s*:/)
  })
})
