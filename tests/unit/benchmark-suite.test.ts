import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import type { GenerateGraphResult } from '../../src/infrastructure/generate.js'
import type { NativeAgentCompareResult, NativeAgentCompareReport } from '../../src/infrastructure/compare.js'
import type { BenchmarkEnvironment, BenchmarkExpectedEnvironment } from '../../src/infrastructure/benchmark/environment.js'
import { claudeInstall } from '../../src/infrastructure/install.js'
import {
  loadBenchmarkSuiteRepos,
  loadBenchmarkSuiteTasks,
  runBenchmarkSuite,
  type BenchmarkSuiteRepo,
  type BenchmarkSuiteTask,
} from '../../src/infrastructure/benchmark/suite.js'

function withTempDir(callback: (tempDir: string) => void | Promise<void>): void | Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-bench-suite-'))
  const finalize = () => rmSync(tempDir, { recursive: true, force: true })
  try {
    const result = callback(tempDir)
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).finally(finalize)
    }
    finalize()
  } catch (error) {
    finalize()
    throw error
  }
}

function createFixtureRepo(rootPath: string): string {
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'package.json'), JSON.stringify({ name: 'fixture-repo', private: true }, null, 2), 'utf8')
  mkdirSync(join(rootPath, 'src'), { recursive: true })
  writeFileSync(join(rootPath, 'src', 'auth-controller.ts'), 'export const controller = true\n', 'utf8')
  mkdirSync(join(rootPath, 'out'), { recursive: true })
  writeFileSync(join(rootPath, 'out', 'graph.json'), '{}\n', 'utf8')
  claudeInstall(rootPath)
  return rootPath
}

function isSpiGraphPath(graphPath: string): boolean {
  return /(?:^|[\\/])spi(?:[\\/])/.test(graphPath)
}

function makeSucceededRun(
  resultPath: string,
  inputTokens: number,
  turns: number,
  durationMs: number,
  costUsd: number,
): NativeAgentCompareReport['baseline'] {
  return {
    kind: 'succeeded',
    model: 'claude-sonnet',
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 100,
    },
    total_input_tokens_anthropic_exact: inputTokens,
    uncached_input_tokens_anthropic_exact: inputTokens,
    cached_input_tokens_anthropic_exact: 0,
    total_cost_usd: costUsd,
    num_turns: turns,
    duration_ms: durationMs,
    result_path: resultPath,
  }
}

function makeCompareResult(input: {
  question: string
  graphPath: string
  outputDir: string
  baselineInputTokens: number
  madarInputTokens: number
  baselineTurns: number
  madarTurns: number
  baselineDurationMs: number
  madarDurationMs: number
  baselineCostUsd: number
  madarCostUsd: number
  baselineToolTotal: number
  madarToolTotal: number
  baselineRead: number
  madarRead: number
  baselineGlob: number
  madarGlob: number
  baselineGrep: number
  madarGrep: number
  isolation?: boolean
  environment?: BenchmarkEnvironment
}): NativeAgentCompareResult {
  mkdirSync(input.outputDir, { recursive: true })
  const baselineAnswerPath = join(input.outputDir, 'baseline-answer.txt')
  const madarAnswerPath = join(input.outputDir, 'madar-answer.txt')
  const promptPath = join(input.outputDir, 'native_agent-prompt.txt')
  const reportPath = join(input.outputDir, 'report.json')
  const shareSafeReportPath = join(input.outputDir, 'report.share-safe.json')

  writeFileSync(baselineAnswerPath, 'baseline\n', 'utf8')
  writeFileSync(madarAnswerPath, 'madar\n', 'utf8')
  writeFileSync(promptPath, `${input.question}\n`, 'utf8')

  const publishedReport = {
    graph_path: input.graphPath,
    baseline: {
      result_path: baselineAnswerPath,
    },
    madar: {
      result_path: madarAnswerPath,
    },
  }
  const shareSafeReport = {
    graph_path: '<project-root>/out/graph.json',
    baseline: {
      result_path: '<artifact-root>/baseline-answer.txt',
    },
    madar: {
      result_path: '<artifact-root>/madar-answer.txt',
    },
  }
  writeFileSync(reportPath, `${JSON.stringify(publishedReport, null, 2)}\n`, 'utf8')
  writeFileSync(shareSafeReportPath, `${JSON.stringify(shareSafeReport, null, 2)}\n`, 'utf8')

  const report: NativeAgentCompareReport = {
    baseline_mode: 'native_agent',
    question: input.question,
    graph_path: input.graphPath,
    isolation: input.isolation ?? false,
    environment: input.environment ?? {
      claude_code_version: '1.2.3',
      host_os: 'darwin-arm64',
      node_version: 'v22.0.0',
      mcp_servers_active: ['madar'],
      mcp_server_count: 1,
      skills_loaded: [],
      skills_loaded_count: 0,
      plugins_active: [],
      user_claude_md_hash: 'sha256:isolation',
      project_claude_md_hash: null,
      parent_claude_md_hashes: [],
      hooks_active: {
        user_prompt_submit: [],
        pre_tool_use: [],
        post_tool_use: [],
      },
    },
    environment_contamination: {
      skills_activated_during_run: [],
      skills_conflicting_with_madar_rules: [],
      calls_to_other_mcps: {},
      subagent_dispatches_detected: 0,
      skill_alignment_score: 1,
    },
    exec_command: {
      command: null,
      placeholders: ['{prompt_file}'],
      redacted: true,
    },
    baseline: makeSucceededRun(baselineAnswerPath, input.baselineInputTokens, input.baselineTurns, input.baselineDurationMs, input.baselineCostUsd),
    madar: makeSucceededRun(madarAnswerPath, input.madarInputTokens, input.madarTurns, input.madarDurationMs, input.madarCostUsd),
    tool_call_counts: {
      baseline: {
        total: input.baselineToolTotal,
        Read: input.baselineRead,
        Bash: 0,
        Glob: input.baselineGlob,
        Grep: input.baselineGrep,
        ToolSearch: 0,
        other: {},
      },
      madar: {
        total: input.madarToolTotal,
        Read: input.madarRead,
        Bash: 0,
        Glob: input.madarGlob,
        Grep: input.madarGrep,
        ToolSearch: 0,
        other: {},
      },
    },
    install_verified: true,
    measurement_validity: 'valid',
    trace_status: 'trace_available',
    madar_mcp_call_count: 1,
    reductions: {
      input_tokens: input.baselineInputTokens / input.madarInputTokens,
      uncached_input_tokens: input.baselineInputTokens / input.madarInputTokens,
      cache_creation_input_tokens: null,
      num_turns: input.baselineTurns / input.madarTurns,
      duration_ms: input.baselineDurationMs / input.madarDurationMs,
      cost_usd: input.baselineCostUsd / input.madarCostUsd,
    },
    token_regression: false,
    token_regression_reasons: [],
    prompt_token_source: {
      baseline: 'anthropic_provider_reported',
      madar: 'anthropic_provider_reported',
    },
    provider_proof: {
      baseline: {
        provider: 'anthropic',
        input_tokens_source: 'anthropic_provider_reported',
        effective_tokens_source: 'anthropic_provider_reported',
        total_tokens_source: 'anthropic_provider_reported',
      },
      madar: {
        provider: 'anthropic',
        input_tokens_source: 'anthropic_provider_reported',
        effective_tokens_source: 'anthropic_provider_reported',
        total_tokens_source: 'anthropic_provider_reported',
      },
      reduction_basis: 'provider_reported',
    },
    started_at: '2026-05-27T00:00:00.000Z',
    completed_at: '2026-05-27T00:00:01.000Z',
    paths: {
      output_dir: input.outputDir,
      report: reportPath,
      share_safe_report: shareSafeReportPath,
      baseline_answer: baselineAnswerPath,
      madar_answer: madarAnswerPath,
      prompt_file: promptPath,
    },
  }

  return {
    graph_path: input.graphPath,
    output_root: input.outputDir,
    reports: [report],
  }
}

const ISOLATED_EXPECTED_ENVIRONMENT: BenchmarkExpectedEnvironment = {
  isolation_required: true,
  mcp_servers_active: ['madar'],
  skills_loaded: [],
  plugins_active: [],
  user_claude_md_hash: 'sha256:isolation',
  project_claude_md_hash: null,
  parent_claude_md_hashes: [],
  hooks_active: {
    user_prompt_submit: [],
    pre_tool_use: [],
    post_tool_use: [],
  },
}

describe('benchmark suite manifests', () => {
  it('loads the fixed repo and task manifests from docs/benchmarks/suite', () => {
    const repos = loadBenchmarkSuiteRepos()
    const tasks = loadBenchmarkSuiteTasks()

    expect(repos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'nestjs-mid',
        status: 'ready',
      }),
      expect.objectContaining({
        id: 'python-service',
        status: 'planned',
      }),
    ]))
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'explain-runtime',
        status: 'ready',
      }),
      expect.objectContaining({
        id: 'review',
        status: 'planned',
      }),
    ]))
  })

  it('rejects repo ids with unsafe path characters', async () => {
    await withTempDir(async (tempDir) => {
      const manifestPath = join(tempDir, 'repos.json')
      writeFileSync(manifestPath, JSON.stringify([
        {
          id: '../escape',
          name: 'Bad repo',
          path: '.',
          status: 'ready',
          supportsSpi: false,
        },
      ], null, 2), 'utf8')

      expect(() => loadBenchmarkSuiteRepos(manifestPath)).toThrow('repo id contains unsafe path characters')
    })
  })

  it('rejects task ids with unsafe path characters', async () => {
    await withTempDir(async (tempDir) => {
      const manifestPath = join(tempDir, 'tasks.json')
      writeFileSync(manifestPath, JSON.stringify([
        {
          id: '../escape',
          name: 'Bad task',
          status: 'ready',
          prompts: {},
        },
      ], null, 2), 'utf8')

      expect(() => loadBenchmarkSuiteTasks(manifestPath)).toThrow('task id contains unsafe path characters')
    })
  })
})

describe('runBenchmarkSuite', () => {
  it('lists runnable and planned cells during dry-run without executing anything', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'))
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'nestjs-mid',
          name: 'Fixture NestJS-like service',
          path: runnableRepoPath,
          description: 'Ready fixture',
          size: 'mid',
          language: 'typescript',
          shape: 'service',
          status: 'ready',
          supportsSpi: true,
        },
        {
          id: 'python-service',
          name: 'Planned Python service',
          path: join(tempDir, 'repos', 'python-service'),
          description: 'Planned fixture',
          size: 'mid',
          language: 'python',
          shape: 'fastapi',
          status: 'planned',
          supportsSpi: false,
        },
      ]
      const tasks: BenchmarkSuiteTask[] = [
        {
          id: 'explain-runtime',
          name: 'Explain runtime flow',
          description: 'Trace a runtime path end to end.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'How does login session creation flow work?',
          },
        },
        {
          id: 'review',
          name: 'Review prompt',
          description: 'Review a diff.',
          status: 'planned',
          prompts: {},
        },
      ]
      let generateCalls = 0
      let compareCalls = 0

      const result = await runBenchmarkSuite(
        {
          repo: null,
          task: null,
          mode: 'all',
          trials: 3,
          outputDir: join(tempDir, 'results'),
          execTemplate: '',
          dryRun: true,
          yes: false,
        },
        {
          repos,
          tasks,
          generateGraph: () => {
            generateCalls += 1
            throw new Error('dry-run should not generate graphs')
          },
          executeNativeAgentCompare: async () => {
            compareCalls += 1
            throw new Error('dry-run should not execute compares')
          },
        },
      )

      expect(generateCalls).toBe(0)
      expect(compareCalls).toBe(0)
      expect(result.text).toContain('[ready] nestjs-mid / explain-runtime / cold-cache')
      expect(result.text).toContain('[ready] nestjs-mid / explain-runtime / warm-cache')
      expect(result.text).toContain('[planned] python-service / explain-runtime / cold-cache')
      expect(result.text).toContain('[planned] nestjs-mid / review / warm-cache')
    })
  })

  it('writes summary.json and summary.md with per-repo rows and no aggregate headline', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'))
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'nestjs-mid',
          name: 'Fixture NestJS-like service',
          path: runnableRepoPath,
          description: 'Ready fixture',
          size: 'mid',
          language: 'typescript',
          shape: 'service',
          status: 'ready',
          supportsSpi: true,
        },
        {
          id: 'python-service',
          name: 'Planned Python service',
          path: join(tempDir, 'repos', 'python-service'),
          description: 'Planned fixture',
          size: 'mid',
          language: 'python',
          shape: 'fastapi',
          status: 'planned',
          supportsSpi: false,
        },
      ]
      const tasks: BenchmarkSuiteTask[] = [
        {
          id: 'explain-runtime',
          name: 'Explain runtime flow',
          description: 'Trace a runtime path end to end.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'How does login session creation flow work?',
          },
        },
      ]
      const result = await runBenchmarkSuite(
        {
          repo: null,
          task: 'explain-runtime',
          mode: 'all',
          trials: 3,
          outputDir: join(tempDir, 'results'),
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos,
          tasks,
          now: () => new Date('2026-05-27T12:34:56Z'),
          generateGraph: (rootPath = '.', options = {}) => {
            const outputDir = join(rootPath, 'out')
            mkdirSync(outputDir, { recursive: true })
            const graphPath = join(outputDir, 'graph.json')
            writeFileSync(graphPath, '{}\n', 'utf8')
            return {
              mode: options.useSpi ? 'generate' : 'generate',
              rootPath,
              outputDir,
              graphPath,
              reportPath: join(outputDir, 'GRAPH_REPORT.md'),
              htmlPath: null,
              wikiPath: null,
              obsidianPath: null,
              svgPath: null,
              graphmlPath: null,
              cypherPath: null,
              docsPath: null,
              totalFiles: 1,
              codeFiles: 1,
              nonCodeFiles: 0,
              extractableFiles: 1,
              extractedFiles: 1,
              totalWords: 10,
              nodeCount: 1,
              edgeCount: 0,
              communityCount: 1,
              changedFiles: 0,
              deletedFiles: 0,
              cache: null,
              warning: null,
              notes: [],
            } satisfies GenerateGraphResult
          },
          executeNativeAgentCompare: async (input) => {
            const isSpi = isSpiGraphPath(input.graphPath)
            const trialMatch = input.outputDir.match(/trial-(\d+)/)
            const trialNumber = trialMatch ? Number.parseInt(trialMatch[1] ?? '1', 10) : 1
            return makeCompareResult({
              question: input.question ?? 'unknown',
              graphPath: input.graphPath,
              outputDir: input.outputDir,
              baselineInputTokens: 300 + trialNumber,
              madarInputTokens: isSpi ? 180 + trialNumber : 200 + trialNumber,
              baselineTurns: 6,
              madarTurns: isSpi ? 3 : 4,
              baselineDurationMs: 9000 + trialNumber,
              madarDurationMs: isSpi ? 5000 + trialNumber : 6000 + trialNumber,
              baselineCostUsd: 1.2,
              madarCostUsd: isSpi ? 0.7 : 0.8,
              baselineToolTotal: 9,
              madarToolTotal: isSpi ? 4 : 5,
              baselineRead: 4,
              madarRead: isSpi ? 2 : 3,
              baselineGlob: 2,
              madarGlob: isSpi ? 0 : 1,
              baselineGrep: 1,
              madarGrep: isSpi ? 0 : 1,
            })
          },
        },
      )

      expect(result.summaryPath).toBeTruthy()
      expect(result.summaryJsonPath).toBeTruthy()

      const summaryJson = JSON.parse(readFileSync(result.summaryJsonPath!, 'utf8')) as {
        cells: Array<{
          repoId: string
          taskId: string
          mode: string
          status: string
          baseline: { input_tokens: { median: number; min: number; max: number; n: number } }
          madar: { input_tokens: { median: number; min: number; max: number; n: number } }
          spi_madar: { input_tokens: { median: number; min: number; max: number; n: number } | null }
        }>
      }
      const summaryMarkdown = readFileSync(result.summaryPath!, 'utf8')

      expect(summaryJson.cells).toEqual(expect.arrayContaining([
        expect.objectContaining({
          repoId: 'nestjs-mid',
          taskId: 'explain-runtime',
          mode: 'cold',
          status: 'completed',
          isolation: false,
          baseline: expect.objectContaining({
            input_tokens: expect.objectContaining({
              median: 302,
              min: 301,
              max: 303,
              n: 3,
            }),
          }),
          madar: expect.objectContaining({
            input_tokens: expect.objectContaining({
              median: 202,
              min: 201,
              max: 203,
              n: 3,
            }),
          }),
          spi_madar: expect.objectContaining({
            input_tokens: expect.objectContaining({
              median: 182,
              min: 181,
              max: 183,
              n: 3,
            }),
          }),
        }),
        expect.objectContaining({
          repoId: 'python-service',
          taskId: 'explain-runtime',
          mode: 'warm',
          status: 'planned',
        }),
      ]))
      expect(summaryMarkdown).toContain('## explain-runtime')
      expect(summaryMarkdown).toContain('### Cold cache')
      expect(summaryMarkdown).toContain('### Warm cache')
      expect(summaryMarkdown).toContain('| nestjs-mid |')
      expect(summaryMarkdown).toContain('| completed | false |')
      expect(summaryMarkdown).toContain('| python-service |')
      expect(summaryMarkdown).toContain('Cells skipped for env drift: 0')
      expect(summaryMarkdown).not.toContain('average across repos')
      expect(summaryMarkdown).not.toContain('headline')
    })
  })

  it('regenerates fresh workspaces for each cold-cache trial while reusing warm ones', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'))
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'nestjs-mid',
          name: 'Fixture NestJS-like service',
          path: runnableRepoPath,
          description: 'Ready fixture',
          size: 'mid',
          language: 'typescript',
          shape: 'service',
          status: 'ready',
          supportsSpi: false,
        },
      ]
      const tasks: BenchmarkSuiteTask[] = [
        {
          id: 'explain-runtime',
          name: 'Explain runtime flow',
          description: 'Trace a runtime path end to end.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'How does login session creation flow work?',
          },
        },
      ]
      const graphPathsByMode = new Map<string, string[]>()

      await runBenchmarkSuite(
        {
          repo: null,
          task: 'explain-runtime',
          mode: 'all',
          trials: 2,
          outputDir: join(tempDir, 'results'),
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos,
          tasks,
          generateGraph: (rootPath = '.', options = {}) => {
            const outputDir = join(rootPath, 'out')
            mkdirSync(outputDir, { recursive: true })
            const graphPath = join(outputDir, 'graph.json')
            writeFileSync(graphPath, '{}\n', 'utf8')
            return {
              mode: options.useSpi ? 'generate' : 'generate',
              rootPath,
              outputDir,
              graphPath,
              reportPath: join(outputDir, 'GRAPH_REPORT.md'),
              htmlPath: null,
              wikiPath: null,
              obsidianPath: null,
              svgPath: null,
              graphmlPath: null,
              cypherPath: null,
              docsPath: null,
              totalFiles: 1,
              codeFiles: 1,
              nonCodeFiles: 0,
              extractableFiles: 1,
              extractedFiles: 1,
              totalWords: 10,
              nodeCount: 1,
              edgeCount: 0,
              communityCount: 1,
              changedFiles: 0,
              deletedFiles: 0,
              cache: null,
              warning: null,
              notes: [],
            } satisfies GenerateGraphResult
          },
          executeNativeAgentCompare: async (input) => {
            const normalizedOutputDir = input.outputDir.replaceAll('\\', '/')
            const mode = normalizedOutputDir.includes('/cold-cache/') ? 'cold' : 'warm'
            graphPathsByMode.set(mode, [...(graphPathsByMode.get(mode) ?? []), input.graphPath])
            return makeCompareResult({
              question: input.question ?? 'unknown',
              graphPath: input.graphPath,
              outputDir: input.outputDir,
              baselineInputTokens: 300,
              madarInputTokens: 200,
              baselineTurns: 6,
              madarTurns: 4,
              baselineDurationMs: 9000,
              madarDurationMs: 6000,
              baselineCostUsd: 1.2,
              madarCostUsd: 0.8,
              baselineToolTotal: 9,
              madarToolTotal: 5,
              baselineRead: 4,
              madarRead: 3,
              baselineGlob: 2,
              madarGlob: 1,
              baselineGrep: 1,
              madarGrep: 1,
            })
          },
        },
      )

      expect(new Set(graphPathsByMode.get('cold') ?? []).size).toBe(2)
      expect(new Set(graphPathsByMode.get('warm') ?? []).size).toBe(1)
    })
  })

  it('skips runnable cells when the repo has no verified Madar install', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'))
      rmSync(join(runnableRepoPath, '.mcp.json'), { force: true })
      rmSync(join(runnableRepoPath, 'CLAUDE.md'), { force: true })
      rmSync(join(runnableRepoPath, '.claude'), { recursive: true, force: true })

      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'nestjs-mid',
          name: 'Fixture NestJS-like service',
          path: runnableRepoPath,
          description: 'Ready fixture',
          size: 'mid',
          language: 'typescript',
          shape: 'service',
          status: 'ready',
          supportsSpi: false,
        },
      ]
      const tasks: BenchmarkSuiteTask[] = [
        {
          id: 'explain-runtime',
          name: 'Explain runtime flow',
          description: 'Trace a runtime path end to end.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'How does login session creation flow work?',
          },
        },
      ]
      let generateCalls = 0
      let compareCalls = 0

      const result = await runBenchmarkSuite(
        {
          repo: null,
          task: 'explain-runtime',
          mode: 'cold',
          trials: 1,
          outputDir: join(tempDir, 'results'),
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos,
          tasks,
          generateGraph: (rootPath = '.', options = {}) => {
            generateCalls += 1
            return {
              mode: options.useSpi ? 'generate' : 'generate',
              rootPath,
              outputDir: join(rootPath, 'out'),
              graphPath: join(rootPath, 'out', 'graph.json'),
              reportPath: join(rootPath, 'out', 'GRAPH_REPORT.md'),
              htmlPath: null,
              wikiPath: null,
              obsidianPath: null,
              svgPath: null,
              graphmlPath: null,
              cypherPath: null,
              docsPath: null,
              totalFiles: 1,
              codeFiles: 1,
              nonCodeFiles: 0,
              extractableFiles: 1,
              extractedFiles: 1,
              totalWords: 10,
              nodeCount: 1,
              edgeCount: 0,
              communityCount: 1,
              changedFiles: 0,
              deletedFiles: 0,
              cache: null,
              warning: null,
              notes: [],
            } satisfies GenerateGraphResult
          },
          executeNativeAgentCompare: async () => {
            compareCalls += 1
            throw new Error('install-skipped cells should not execute compare')
          },
        },
      )

      const summaryMarkdown = readFileSync(result.summaryPath!, 'utf8')

      expect(generateCalls).toBe(0)
      expect(compareCalls).toBe(0)
      expect(result.summary?.cells[0]).toEqual(expect.objectContaining({
        repoId: 'nestjs-mid',
        status: 'skipped',
        reason: expect.stringContaining('No Madar install detected'),
      }))
      expect(result.summary?.cells_skipped_for_install).toBe(1)
      expect(summaryMarkdown).toContain('cells_skipped_for_install: 1')
      expect(summaryMarkdown).toContain('skipped (no install)')
      expect(summaryMarkdown).toContain('No Madar install detected in repo; skipped benchmark cell.')
    })
  })

  it('treats SPI graph paths with Windows separators as SPI runs', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'))
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'nestjs-mid',
          name: 'Fixture NestJS-like service',
          path: runnableRepoPath,
          description: 'Ready fixture',
          size: 'mid',
          language: 'typescript',
          shape: 'service',
          status: 'ready',
          supportsSpi: true,
        },
      ]
      const tasks: BenchmarkSuiteTask[] = [
        {
          id: 'explain-runtime',
          name: 'Explain runtime flow',
          description: 'Trace a runtime path end to end.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'How does login session creation flow work?',
          },
        },
      ]

      const result = await runBenchmarkSuite(
        {
          repo: null,
          task: 'explain-runtime',
          mode: 'cold',
          trials: 1,
          outputDir: join(tempDir, 'results'),
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos,
          tasks,
          generateGraph: (rootPath = '.', options = {}) => ({
            mode: options.useSpi ? 'generate' : 'generate',
            rootPath,
            outputDir: options.useSpi ? 'C:\\tmp\\spi\\out' : 'C:\\tmp\\legacy\\out',
            graphPath: options.useSpi ? 'C:\\tmp\\spi\\out\\graph.json' : 'C:\\tmp\\legacy\\out\\graph.json',
            reportPath: options.useSpi ? 'C:\\tmp\\spi\\out\\GRAPH_REPORT.md' : 'C:\\tmp\\legacy\\out\\GRAPH_REPORT.md',
            htmlPath: null,
            wikiPath: null,
            obsidianPath: null,
            svgPath: null,
            graphmlPath: null,
            cypherPath: null,
            docsPath: null,
            totalFiles: 1,
            codeFiles: 1,
            nonCodeFiles: 0,
            extractableFiles: 1,
            extractedFiles: 1,
            totalWords: 10,
            nodeCount: 1,
            edgeCount: 0,
            communityCount: 1,
            changedFiles: 0,
            deletedFiles: 0,
            cache: null,
            warning: null,
            notes: [],
          } satisfies GenerateGraphResult),
          executeNativeAgentCompare: async (input) => {
            const isSpi = isSpiGraphPath(input.graphPath)
            return makeCompareResult({
              question: input.question ?? 'unknown',
              graphPath: input.graphPath,
              outputDir: input.outputDir,
              baselineInputTokens: 300,
              madarInputTokens: isSpi ? 180 : 200,
              baselineTurns: 6,
              madarTurns: isSpi ? 3 : 4,
              baselineDurationMs: 9000,
              madarDurationMs: isSpi ? 5000 : 6000,
              baselineCostUsd: 1.2,
              madarCostUsd: isSpi ? 0.7 : 0.8,
              baselineToolTotal: 9,
              madarToolTotal: isSpi ? 4 : 5,
              baselineRead: 4,
              madarRead: isSpi ? 2 : 3,
              baselineGlob: 2,
              madarGlob: isSpi ? 0 : 1,
              baselineGrep: 1,
              madarGrep: isSpi ? 0 : 1,
            })
          },
        },
      )

      const coldCell = result.summary?.cells.find((cell) => cell.repoId === 'nestjs-mid' && cell.mode === 'cold')
      expect(coldCell?.spi_madar?.input_tokens?.median).toBe(180)
    })
  })

  it('publishes share-safe report.json copies in docs artifacts', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'))
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'nestjs-mid',
          name: 'Fixture NestJS-like service',
          path: runnableRepoPath,
          description: 'Ready fixture',
          size: 'mid',
          language: 'typescript',
          shape: 'service',
          status: 'ready',
          supportsSpi: false,
        },
      ]
      const tasks: BenchmarkSuiteTask[] = [
        {
          id: 'explain-runtime',
          name: 'Explain runtime flow',
          description: 'Trace a runtime path end to end.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'How does login session creation flow work?',
          },
        },
      ]

      const result = await runBenchmarkSuite(
        {
          repo: null,
          task: 'explain-runtime',
          mode: 'cold',
          trials: 1,
          outputDir: join(tempDir, 'results'),
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos,
          tasks,
          generateGraph: (rootPath = '.', options = {}) => {
            const outputDir = join(rootPath, 'out')
            mkdirSync(outputDir, { recursive: true })
            const graphPath = join(outputDir, 'graph.json')
            writeFileSync(graphPath, '{}\n', 'utf8')
            return {
              mode: options.useSpi ? 'generate' : 'generate',
              rootPath,
              outputDir,
              graphPath,
              reportPath: join(outputDir, 'GRAPH_REPORT.md'),
              htmlPath: null,
              wikiPath: null,
              obsidianPath: null,
              svgPath: null,
              graphmlPath: null,
              cypherPath: null,
              docsPath: null,
              totalFiles: 1,
              codeFiles: 1,
              nonCodeFiles: 0,
              extractableFiles: 1,
              extractedFiles: 1,
              totalWords: 10,
              nodeCount: 1,
              edgeCount: 0,
              communityCount: 1,
              changedFiles: 0,
              deletedFiles: 0,
              cache: null,
              warning: null,
              notes: [],
            } satisfies GenerateGraphResult
          },
          executeNativeAgentCompare: async (input) => makeCompareResult({
            question: input.question ?? 'unknown',
            graphPath: input.graphPath,
            outputDir: input.outputDir,
            baselineInputTokens: 300,
            madarInputTokens: 200,
            baselineTurns: 6,
            madarTurns: 4,
            baselineDurationMs: 9000,
            madarDurationMs: 6000,
            baselineCostUsd: 1.2,
            madarCostUsd: 0.8,
            baselineToolTotal: 9,
            madarToolTotal: 5,
            baselineRead: 4,
            madarRead: 3,
            baselineGlob: 2,
            madarGlob: 1,
            baselineGrep: 1,
            madarGrep: 1,
          }),
        },
      )

      const shareSafePath = result.summary?.cells[0]?.artifacts.legacy_share_safe_reports[0]
      expect(shareSafePath).toBeTruthy()

      const publishedReportPath = resolve(
        process.cwd(),
        shareSafePath!.replace(/report\.share-safe\.json$/, 'report.json'),
      )
      const publishedReport = JSON.parse(readFileSync(publishedReportPath, 'utf8')) as {
        graph_path: string
        baseline: { result_path: string }
        madar: { result_path: string }
      }

      expect(publishedReport.graph_path).toBe('<project-root>/out/graph.json')
      expect(publishedReport.baseline.result_path).toBe('<artifact-root>/baseline-answer.txt')
      expect(publishedReport.madar.result_path).toBe('<artifact-root>/madar-answer.txt')
    })
  })

  it('marks isolation env drift as env_mismatch and skips compare execution', async () => {
    const previousIsolation = process.env.MADAR_BENCH_ISOLATION
    process.env.MADAR_BENCH_ISOLATION = '1'
    await withTempDir(async (tempDir) => {
      try {
        const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'))
        const repos: BenchmarkSuiteRepo[] = [
          {
            id: 'nestjs-mid',
            name: 'Fixture NestJS-like service',
            path: runnableRepoPath,
            description: 'Ready fixture',
            size: 'mid',
            language: 'typescript',
            shape: 'service',
            status: 'ready',
            supportsSpi: false,
          },
        ]
        const tasks: BenchmarkSuiteTask[] = [
          {
            id: 'explain-runtime',
            name: 'Explain runtime flow',
            description: 'Trace a runtime path end to end.',
            status: 'ready',
            prompts: {
              'nestjs-mid': 'How does login session creation flow work?',
            },
          },
        ]
        let compareCalls = 0

        const result = await runBenchmarkSuite(
          {
            repo: null,
            task: 'explain-runtime',
            mode: 'cold',
            trials: 1,
            outputDir: join(tempDir, 'results'),
            execTemplate: 'mock-runner',
            dryRun: false,
            yes: true,
          },
          {
            repos,
            tasks,
            expectedEnvironment: ISOLATED_EXPECTED_ENVIRONMENT,
            captureBenchmarkEnvironment: async () => ({
              claude_code_version: '1.2.3',
              host_os: 'darwin-arm64',
              node_version: 'v22.0.0',
              mcp_servers_active: ['github', 'madar'],
              mcp_server_count: 2,
              skills_loaded: ['systematic-debugging'],
              skills_loaded_count: 1,
              plugins_active: ['superpowers'],
              user_claude_md_hash: 'sha256:daily-driver',
              project_claude_md_hash: null,
              parent_claude_md_hashes: [],
              hooks_active: {
                user_prompt_submit: ['user:command:prompt'],
                pre_tool_use: [],
                post_tool_use: [],
              },
            }),
            generateGraph: (rootPath = '.', options = {}) => {
              const outputDir = join(rootPath, 'out')
              mkdirSync(outputDir, { recursive: true })
              const graphPath = join(outputDir, 'graph.json')
              writeFileSync(graphPath, '{}\n', 'utf8')
              return {
                mode: options.useSpi ? 'generate' : 'generate',
                rootPath,
                outputDir,
                graphPath,
                reportPath: join(outputDir, 'GRAPH_REPORT.md'),
                htmlPath: null,
                wikiPath: null,
                obsidianPath: null,
                svgPath: null,
                graphmlPath: null,
                cypherPath: null,
                docsPath: null,
                totalFiles: 1,
                codeFiles: 1,
                nonCodeFiles: 0,
                extractableFiles: 1,
                extractedFiles: 1,
                totalWords: 10,
                nodeCount: 1,
                edgeCount: 0,
                communityCount: 1,
                changedFiles: 0,
                deletedFiles: 0,
                cache: null,
                warning: null,
                notes: [],
              } satisfies GenerateGraphResult
            },
            executeNativeAgentCompare: async () => {
              compareCalls += 1
              throw new Error('env-mismatch cells should not run compare')
            },
          },
        )

        expect(compareCalls).toBe(0)
        expect(result.summary?.cells).toEqual([
          expect.objectContaining({
            repoId: 'nestjs-mid',
            taskId: 'explain-runtime',
            mode: 'cold',
            status: 'env_mismatch',
            isolation: true,
          }),
        ])
        expect(result.summary?.cells_skipped_for_env_drift).toBe(1)
        expect(result.summary?.cells[0]?.reason).toContain('mcp_servers_active')
        expect(result.text).toContain('Cells: 0 measured · 1 env mismatch · 0 planned')
      } finally {
        if (previousIsolation === undefined) {
          delete process.env.MADAR_BENCH_ISOLATION
        } else {
          process.env.MADAR_BENCH_ISOLATION = previousIsolation
        }
      }
    })
  })

  it('fails closed when isolation is enabled without a pinned expected environment', async () => {
    const previousIsolation = process.env.MADAR_BENCH_ISOLATION
    process.env.MADAR_BENCH_ISOLATION = '1'

    try {
      await expect(runBenchmarkSuite(
        {
          repo: null,
          task: null,
          mode: 'cold',
          trials: 1,
          outputDir: 'out/benchmarks',
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos: [],
          tasks: [],
          expectedEnvironment: null,
        },
      )).rejects.toThrow('Benchmark isolation is enabled but no expected environment was loaded')
    } finally {
      if (previousIsolation === undefined) {
        delete process.env.MADAR_BENCH_ISOLATION
      } else {
        process.env.MADAR_BENCH_ISOLATION = previousIsolation
      }
    }
  })
})
