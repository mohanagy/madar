import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { NativeAgentCompareReport, NativeAgentCompareResult } from '../../src/infrastructure/compare.js'
import type { GenerateIndexResult } from '../../src/application/generate-index.js'
import {
  loadBenchmarkSuiteRepos,
  loadBenchmarkSuiteTasks,
  runBenchmarkSuite,
  type BenchmarkSuiteRepo,
  type BenchmarkSuiteTask,
} from '../../src/infrastructure/benchmark/suite.js'

const roots: string[] = []
const cliStubRoot = mkdtempSync(join(tmpdir(), 'madar-benchmark-cli-'))
const cliStubPath = join(cliStubRoot, 'bin.js')
const previousCliPath = process.env.MADAR_BENCH_CLI_PATH

beforeAll(() => {
  writeFileSync(cliStubPath, '#!/usr/bin/env node\n', 'utf8')
  process.env.MADAR_BENCH_CLI_PATH = cliStubPath
})

afterAll(() => {
  if (previousCliPath === undefined) delete process.env.MADAR_BENCH_CLI_PATH
  else process.env.MADAR_BENCH_CLI_PATH = previousCliPath
  rmSync(cliStubRoot, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-benchmark-suite-'))
  roots.push(root)
  return root
}

function tempJson(name: string, value: unknown): string {
  const root = tempRoot()
  const path = join(root, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

function createFixtureRepo(root: string): string {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'fixture-repo', private: true }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, 'src', 'service.ts'), 'export const service = true\n', 'utf8')
  return root
}

function generateResult(rootPath: string): GenerateIndexResult {
  const outputDir = join(rootPath, 'out')
  const graphPath = join(outputDir, 'graph.json')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(graphPath, '{}\n', 'utf8')
  return {
    mode: 'generate',
    rootPath,
    outputDir,
    graphPath,
    reportPath: join(outputDir, 'GRAPH_REPORT.md'),
    totalFiles: 1,
    indexedFiles: 1,
    totalWords: 10,
    nodeCount: 1,
    edgeCount: 0,
    communityCount: 1,
    semanticAnomalyCount: 0,
    warning: null,
    notes: [],
    discoverySafety: {
      version: 1,
      summary: { total: 0, sensitive: 0, unreadable: 0, reasons: {} },
      exclusions: [],
    },
    indexingManifestPath: join(outputDir, 'indexing-manifest.json'),
    indexing: {
      state: 'complete',
      candidates: 1,
      counts: { indexed: 1, indexed_with_warnings: 0, skipped_by_policy: 0, unsupported: 0, failed: 0 },
      reason_buckets: { indexed: 1 },
      capability_buckets: { canonical_typescript_javascript: 1 },
    },
    buildId: 'a'.repeat(64),
  }
}

function succeededRun(resultPath: string, inputTokens: number): NativeAgentCompareReport['baseline'] {
  return {
    kind: 'succeeded',
    model: 'claude-sonnet',
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 50,
    },
    total_input_tokens_anthropic_exact: inputTokens,
    uncached_input_tokens_anthropic_exact: inputTokens,
    cached_input_tokens_anthropic_exact: 0,
    total_cost_usd: inputTokens / 1_000,
    num_turns: 2,
    duration_ms: inputTokens * 10,
    result_path: resultPath,
  }
}

function compareResult(input: { question: string; graphPath: string; outputDir: string }): NativeAgentCompareResult {
  mkdirSync(input.outputDir, { recursive: true })
  const baselineAnswer = join(input.outputDir, 'baseline-answer.txt')
  const madarAnswer = join(input.outputDir, 'madar-answer.txt')
  const baselinePrompt = join(input.outputDir, 'baseline-prompt.txt')
  const madarPrompt = join(input.outputDir, 'madar-prompt.txt')
  const reportPath = join(input.outputDir, 'report.json')
  const shareSafeReportPath = join(input.outputDir, 'report.share-safe.json')

  writeFileSync(baselineAnswer, 'baseline\n', 'utf8')
  writeFileSync(madarAnswer, 'madar\n', 'utf8')
  writeFileSync(baselinePrompt, `${input.question}\n`, 'utf8')
  writeFileSync(madarPrompt, `${input.question}\n`, 'utf8')
  writeFileSync(reportPath, `${JSON.stringify({
    graph_path: input.graphPath,
    baseline: { result_path: baselineAnswer },
    madar: { result_path: madarAnswer },
  }, null, 2)}\n`, 'utf8')
  writeFileSync(shareSafeReportPath, `${JSON.stringify({
    graph_path: '<project-root>/out/graph.json',
    baseline: { result_path: '<artifact-root>/baseline-answer.txt' },
    madar: { result_path: '<artifact-root>/madar-answer.txt' },
  }, null, 2)}\n`, 'utf8')

  const report = {
    baseline_mode: 'native_agent',
    task: 'explain',
    question: input.question,
    graph_path: input.graphPath,
    isolation: false,
    environment: {
      claude_code_version: 'test',
      host_os: 'test',
      node_version: process.version,
      mcp_servers_active: ['madar'],
      mcp_server_count: 1,
      skills_loaded: [],
      skills_loaded_count: 0,
      plugins_active: [],
      user_claude_md_hash: 'sha256:test',
      project_claude_md_hash: null,
      parent_claude_md_hashes: [],
      hooks_active: { user_prompt_submit: [], pre_tool_use: [], post_tool_use: [] },
    },
    environment_contamination: {
      skills_activated_during_run: [],
      skills_conflicting_with_madar_rules: [],
      calls_to_other_mcps: {},
      subagent_dispatches_detected: 0,
      skill_alignment_score: 1,
    },
    exec_command: { command: null, placeholders: ['{prompt_file}'], redacted: true },
    baseline: succeededRun(baselineAnswer, 300),
    madar: succeededRun(madarAnswer, 200),
    install_verified: true,
    measurement_validity: 'valid',
    trace_status: 'trace_available',
    madar_mcp_call_count: 1,
    tool_call_counts: {
      baseline: { total: 5, Read: 2, Bash: 0, Glob: 1, Grep: 1, ToolSearch: 0, other: {} },
      madar: { total: 3, Read: 1, Bash: 0, Glob: 0, Grep: 1, ToolSearch: 0, other: {} },
    },
    reductions: {
      input_tokens: 1.5,
      uncached_input_tokens: 1.5,
      cache_creation_input_tokens: null,
      num_turns: 1,
      duration_ms: 1.5,
      cost_usd: 1.5,
    },
    token_regression: false,
    token_regression_reasons: [],
    prompt_token_source: { baseline: 'anthropic_provider_reported', madar: 'anthropic_provider_reported' },
    started_at: '2026-07-22T00:00:00.000Z',
    completed_at: '2026-07-22T00:00:01.000Z',
    paths: {
      output_dir: input.outputDir,
      report: reportPath,
      share_safe_report: shareSafeReportPath,
      baseline_answer: baselineAnswer,
      madar_answer: madarAnswer,
      baseline_prompt: baselinePrompt,
      madar_prompt: madarPrompt,
      prompt_file: madarPrompt,
    },
  } as NativeAgentCompareReport

  return { graph_path: input.graphPath, output_root: input.outputDir, reports: [report] }
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

  it('writes canonical summary and share-safe artifacts for a measured cell', async () => {
    const root = tempRoot()
    const repoPath = createFixtureRepo(join(root, 'repo'))
    const result = await runBenchmarkSuite({
      repo: 'typescript-service',
      task: 'explain-runtime',
      mode: 'cold',
      trials: 1,
      outputDir: join(root, 'results'),
      execTemplate: 'mock-runner',
      dryRun: false,
      yes: true,
    }, {
      repos: [readyRepo({ source: { kind: 'path', path: repoPath } })],
      tasks: [readyTask()],
      now: () => new Date('2026-07-22T12:34:56.000Z'),
      generateGraph: (rootPath = '.') => generateResult(rootPath),
      executeNativeAgentCompare: async (input) => compareResult({
        question: input.question ?? 'unknown',
        graphPath: input.graphPath,
        outputDir: input.outputDir,
      }),
    })

    expect(result.summaryJsonPath).toBeTruthy()
    expect(result.summaryPath).toBeTruthy()
    expect(result.summary?.schema_version).toBe(2)
    expect(result.summary?.cells).toEqual([
      expect.objectContaining({
        repoId: 'typescript-service',
        taskId: 'explain-runtime',
        mode: 'cold',
        status: 'completed',
        baseline: expect.objectContaining({ input_tokens: expect.objectContaining({ median: 300, n: 1 }) }),
        madar: expect.objectContaining({ input_tokens: expect.objectContaining({ median: 200, n: 1 }) }),
      }),
    ])

    const summaryMarkdown = readFileSync(result.summaryPath!, 'utf8')
    expect(summaryMarkdown).toContain('## explain-runtime')
    expect(summaryMarkdown).toContain('### Cold cache')
    expect(summaryMarkdown).toContain('| typescript-service | completed |')

    const shareSafePath = result.summary?.cells[0]?.artifacts.share_safe_reports[0]
    expect(shareSafePath).toBeTruthy()
    expect(shareSafePath?.replaceAll('\\', '/')).toContain('/canonical/trial-001/report.share-safe.json')
    const publishedReportPath = resolve(process.cwd(), shareSafePath!.replace(/report\.share-safe\.json$/, 'report.json'))
    expect(JSON.parse(readFileSync(publishedReportPath, 'utf8'))).toEqual({
      graph_path: '<project-root>/out/graph.json',
      baseline: { result_path: '<artifact-root>/baseline-answer.txt' },
      madar: { result_path: '<artifact-root>/madar-answer.txt' },
    })
  })

  it('generates and compares a repository from its configured graph root', async () => {
    const root = tempRoot()
    const repoPath = createFixtureRepo(join(root, 'repo'))
    const graphRoot = 'packages/api'
    mkdirSync(join(repoPath, graphRoot), { recursive: true })
    writeFileSync(join(repoPath, graphRoot, 'controller.ts'), 'export const controller = true\n', 'utf8')
    writeFileSync(join(repoPath, 'CLAUDE.md'), '# source-specific instructions\n', 'utf8')
    writeFileSync(join(repoPath, '.mcp.json'), '{"mcpServers":{"other":{"command":"other"}}}\n', 'utf8')
    const generatedRoots: string[] = []
    const comparedGraphPaths: string[] = []
    const comparedExecTemplates: string[] = []

    await runBenchmarkSuite({
      repo: 'typescript-service',
      task: 'explain-runtime',
      mode: 'warm',
      trials: 1,
      outputDir: join(root, 'results'),
      execTemplate: 'mock-runner',
      dryRun: false,
      yes: true,
    }, {
      repos: [readyRepo({ source: { kind: 'path', path: repoPath }, graphRoot })],
      tasks: [readyTask()],
      generateGraph: (rootPath = '.') => {
        generatedRoots.push(rootPath)
        const workspaceRoot = resolve(rootPath, '..', '..')
        expect(existsSync(join(workspaceRoot, 'CLAUDE.md'))).toBe(false)
        expect(existsSync(join(workspaceRoot, '.mcp.json'))).toBe(false)
        const config = JSON.parse(readFileSync(join(rootPath, '.mcp.json'), 'utf8')) as {
          mcpServers?: { madar?: { command?: string } }
        }
        expect(config.mcpServers?.madar?.command).toBe('madar')
        return generateResult(rootPath)
      },
      executeNativeAgentCompare: async (input) => {
        comparedGraphPaths.push(input.graphPath)
        comparedExecTemplates.push(input.execTemplate)
        return compareResult({
          question: input.question ?? 'unknown',
          graphPath: input.graphPath,
          outputDir: input.outputDir,
        })
      },
    })

    const suffix = graphRoot.split('/').join(sep)
    expect(generatedRoots).toHaveLength(1)
    expect(generatedRoots[0]).toMatch(new RegExp(`${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    expect(comparedGraphPaths).toEqual([
      join(generatedRoots[0]!, 'out', 'graph.json'),
      join(generatedRoots[0]!, 'out', 'graph.json'),
    ])
    expect(comparedExecTemplates).toHaveLength(2)
    expect(comparedExecTemplates.every((template) => template.includes(generatedRoots[0]!))).toBe(true)
  })

  it('uses fresh workspaces for cold trials and one prepared workspace for warm trials', async () => {
    const root = tempRoot()
    const repoPath = createFixtureRepo(join(root, 'repo'))
    const graphPathsByMode = new Map<'cold' | 'warm', string[]>()

    await runBenchmarkSuite({
      repo: 'typescript-service',
      task: 'explain-runtime',
      mode: 'all',
      trials: 2,
      outputDir: join(root, 'results'),
      execTemplate: 'mock-runner',
      dryRun: false,
      yes: true,
    }, {
      repos: [readyRepo({ source: { kind: 'path', path: repoPath } })],
      tasks: [readyTask()],
      generateGraph: (rootPath = '.') => generateResult(rootPath),
      executeNativeAgentCompare: async (input) => {
        const mode = input.outputDir.replaceAll('\\', '/').includes('/cold-cache/') ? 'cold' : 'warm'
        graphPathsByMode.set(mode, [...(graphPathsByMode.get(mode) ?? []), input.graphPath])
        return compareResult({
          question: input.question ?? 'unknown',
          graphPath: input.graphPath,
          outputDir: input.outputDir,
        })
      },
    })

    expect(graphPathsByMode.get('cold')).toHaveLength(2)
    expect(new Set(graphPathsByMode.get('cold')).size).toBe(2)
    expect(graphPathsByMode.get('warm')).toHaveLength(4)
    expect(new Set(graphPathsByMode.get('warm')).size).toBe(1)
  })

  it('continues healthy rows after a repository preparation failure', async () => {
    const root = tempRoot()
    const goodRepoPath = createFixtureRepo(join(root, 'good-repo'))
    let compareCalls = 0
    const result = await runBenchmarkSuite({
      repo: null,
      task: 'explain-runtime',
      mode: 'cold',
      trials: 1,
      outputDir: join(root, 'results'),
      execTemplate: 'mock-runner',
      dryRun: false,
      yes: true,
    }, {
      repos: [
        readyRepo({
          id: 'broken-repo',
          name: 'Broken repo',
          source: { kind: 'path', path: join(root, 'missing-repo') },
        }),
        readyRepo({
          id: 'healthy-repo',
          name: 'Healthy repo',
          source: { kind: 'path', path: goodRepoPath },
        }),
      ],
      tasks: [readyTask({
        prompts: {
          'broken-repo': 'Trace the broken flow.',
          'healthy-repo': 'Trace the healthy flow.',
        },
      })],
      generateGraph: (rootPath = '.') => generateResult(rootPath),
      executeNativeAgentCompare: async (input) => {
        compareCalls += 1
        return compareResult({
          question: input.question ?? 'unknown',
          graphPath: input.graphPath,
          outputDir: input.outputDir,
        })
      },
    })

    expect(compareCalls).toBe(1)
    expect(result.summary?.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repoId: 'broken-repo',
        status: 'skipped',
        reason: expect.stringContaining('Repo preparation failed'),
      }),
      expect.objectContaining({ repoId: 'healthy-repo', status: 'completed' }),
    ]))
    expect(result.summary?.cells_skipped_for_install).toBe(1)
    expect(result.text).toContain('1 skipped during preparation')
  })

  it('wraps benchmark execution with cmd-compatible Windows syntax', async () => {
    const root = tempRoot()
    const repoPath = createFixtureRepo(join(root, 'repo'))
    const originalPlatform = process.platform
    const execTemplates: string[] = []
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      await runBenchmarkSuite({
        repo: 'typescript-service',
        task: 'explain-runtime',
        mode: 'cold',
        trials: 1,
        outputDir: join(root, 'results'),
        execTemplate: 'type {prompt_file} | claude -p --output-format json',
        dryRun: false,
        yes: true,
      }, {
        repos: [readyRepo({ source: { kind: 'path', path: repoPath } })],
        tasks: [readyTask()],
        generateGraph: (rootPath = '.') => generateResult(rootPath),
        executeNativeAgentCompare: async (input) => {
          execTemplates.push(input.execTemplate)
          return compareResult({
            question: input.question ?? 'unknown',
            graphPath: input.graphPath,
            outputDir: input.outputDir,
          })
        },
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }

    expect(execTemplates).toHaveLength(1)
    expect(execTemplates[0]).toContain('cd /d "')
    expect(execTemplates[0]).toContain('&& type {prompt_file} | claude -p --output-format json')
    expect(execTemplates[0]).not.toContain('Set-Location -LiteralPath')
  })

  it('prepares an isolated suite-managed Madar install without mutating the source repo', async () => {
    const root = tempRoot()
    const repoPath = createFixtureRepo(join(root, 'repo'))
    const generatedRoots: string[] = []

    const result = await runBenchmarkSuite({
      repo: 'typescript-service',
      task: 'explain-runtime',
      mode: 'cold',
      trials: 1,
      outputDir: join(root, 'results'),
      execTemplate: 'mock-runner',
      dryRun: false,
      yes: true,
    }, {
      repos: [readyRepo({ source: { kind: 'path', path: repoPath } })],
      tasks: [readyTask()],
      generateGraph: (rootPath = '.') => {
        generatedRoots.push(rootPath)
        expect(rootPath).not.toBe(repoPath)
        expect(existsSync(join(rootPath, 'CLAUDE.md'))).toBe(true)
        expect(existsSync(join(rootPath, '.claude', 'settings.json'))).toBe(true)
        const config = JSON.parse(readFileSync(join(rootPath, '.mcp.json'), 'utf8')) as {
          mcpServers?: { madar?: { command?: string; env?: Record<string, string> } }
        }
        expect(config.mcpServers?.madar?.command).toBe('madar')
        expect(config.mcpServers?.madar?.env).toEqual(expect.objectContaining({ MADAR_TOOL_PROFILE: 'core' }))
        expect(config.mcpServers?.madar?.env?.PATH ?? config.mcpServers?.madar?.env?.Path).toContain(join(rootPath, '.claude', 'bin'))
        return generateResult(rootPath)
      },
      executeNativeAgentCompare: async (input) => compareResult({
        question: input.question ?? 'unknown',
        graphPath: input.graphPath,
        outputDir: input.outputDir,
      }),
    })

    expect(generatedRoots).toHaveLength(2)
    expect(new Set(generatedRoots).size).toBe(2)
    expect(existsSync(join(repoPath, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(repoPath, '.mcp.json'))).toBe(false)
    expect(result.summary?.cells[0]).toEqual(expect.objectContaining({ status: 'completed' }))
    expect(result.summary?.cells_skipped_for_install).toBe(0)
  })
})
