import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  loadBenchmarkSuiteRepos,
  loadBenchmarkSuiteTasks,
  runBenchmarkSuite,
  type BenchmarkSuiteRepo,
  type BenchmarkSuiteTask,
} from '../../src/infrastructure/benchmark/suite.js'

const roots: string[] = []

function tempJson(name: string, value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-benchmark-suite-'))
  roots.push(root)
  const path = join(root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

function readyRepo(overrides: Partial<BenchmarkSuiteRepo> = {}): BenchmarkSuiteRepo {
  return {
    id: 'typescript-service',
    name: 'TypeScript service',
    source: { kind: 'path', path: '.' },
    description: 'Canonical TypeScript fixture',
    size: 'small',
    language: 'TypeScript',
    shape: 'service',
    status: 'ready',
    ...overrides,
  }
}

function readyTask(overrides: Partial<BenchmarkSuiteTask> = {}): BenchmarkSuiteTask {
  return {
    id: 'explain-runtime',
    name: 'Explain runtime',
    description: 'Trace a runtime path',
    status: 'ready',
    prompts: { 'typescript-service': 'Trace the request flow.' },
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('benchmark suite manifest parsing', () => {
  it('loads a canonical TypeScript repository entry', () => {
    const path = tempJson('repos.json', [readyRepo()])

    expect(loadBenchmarkSuiteRepos(path)).toEqual([
      expect.objectContaining({
        id: 'typescript-service',
        language: 'TypeScript',
        status: 'ready',
      }),
    ])
  })

  it('rejects the retired supportsSpi repository field instead of ignoring it', () => {
    const path = tempJson('repos.json', [{ ...readyRepo(), supportsSpi: true }])

    expect(() => loadBenchmarkSuiteRepos(path)).toThrow('contains unsupported fields')
  })

  it('rejects the retired expected_spi task field instead of ignoring it', () => {
    const path = tempJson('tasks.json', [{ ...readyTask(), expected_spi: 'legacy comparison' }])

    expect(() => loadBenchmarkSuiteTasks(path)).toThrow('contains unsupported fields')
  })

  it('rejects unsafe repository and task identifiers', () => {
    const reposPath = tempJson('repos.json', [readyRepo({ id: '../escape' })])
    const tasksPath = tempJson('tasks.json', [readyTask({ id: 'nested/task' })])

    expect(() => loadBenchmarkSuiteRepos(reposPath)).toThrow('unsafe path characters')
    expect(() => loadBenchmarkSuiteTasks(tasksPath)).toThrow('unsafe path characters')
  })

  it('rejects unsupported source fields rather than preserving compatibility options', () => {
    const path = tempJson('repos.json', [{
      ...readyRepo(),
      source: { kind: 'path', path: '.', extractionMode: 'spi' },
    }])

    expect(() => loadBenchmarkSuiteRepos(path)).toThrow('path source contains unsupported fields')
  })
})

describe('canonical benchmark planning', () => {
  it('plans exactly baseline and Madar work for cold and warm cells', async () => {
    const result = await runBenchmarkSuite({
      repo: null,
      task: null,
      mode: 'all',
      trials: 1,
      outputDir: 'out/benchmark-suite',
      execTemplate: 'agent --prompt {prompt}',
      dryRun: true,
      yes: false,
    }, {
      repos: [readyRepo()],
      tasks: [readyTask()],
    })

    expect(result.text).toContain('typescript-service')
    expect(result.text).toContain('cold')
    expect(result.text).toContain('warm')
    expect(result.text).not.toMatch(/legacy|spi/i)
  })

  it('marks missing prompts as planned without executing generation', async () => {
    const result = await runBenchmarkSuite({
      repo: 'typescript-service',
      task: 'review',
      mode: 'cold',
      trials: 1,
      outputDir: 'out/benchmark-suite',
      execTemplate: 'agent --prompt {prompt}',
      dryRun: true,
      yes: false,
    }, {
      repos: [readyRepo()],
      tasks: [readyTask({ id: 'review', prompts: {} })],
    })

    expect(result.text).toContain('prompt not defined for repo')
  })

  it('rejects unknown filters before creating a run', async () => {
    await expect(runBenchmarkSuite({
      repo: 'missing',
      task: null,
      mode: 'cold',
      trials: 1,
      outputDir: 'out/benchmark-suite',
      execTemplate: 'agent --prompt {prompt}',
      dryRun: true,
      yes: false,
    }, {
      repos: [readyRepo()],
      tasks: [readyTask()],
    })).rejects.toThrow('Unknown repo id: missing')
  })
})
