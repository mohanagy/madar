import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { GenerateGraphResult } from '../../src/infrastructure/generate.js'
import type { NativeAgentCompareResult, NativeAgentCompareReport } from '../../src/infrastructure/compare.js'
import type { BenchmarkEnvironment, BenchmarkExpectedEnvironment } from '../../src/infrastructure/benchmark/environment.js'
import { loadBenchmarkRuntimeProofProfiles } from '../../src/infrastructure/benchmark/runtime-proof.js'
import { claudeInstall } from '../../src/infrastructure/install.js'
import {
  loadBenchmarkSuiteRepos,
  loadBenchmarkSuiteTasks,
  runBenchmarkSuite,
  type BenchmarkSuiteRepo,
  type BenchmarkSuiteTask,
} from '../../src/infrastructure/benchmark/suite.js'

const cliStubDir = mkdtempSync(join(tmpdir(), 'madar-bench-cli-stub-'))
const cliStubPath = join(cliStubDir, 'bin.js')

beforeAll(() => {
  writeFileSync(cliStubPath, '#!/usr/bin/env node\n', 'utf8')
  process.env.MADAR_BENCH_CLI_PATH = cliStubPath
})

afterAll(() => {
  delete process.env.MADAR_BENCH_CLI_PATH
  rmSync(cliStubDir, { recursive: true, force: true })
})

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

function createFixtureRepo(rootPath: string, options: { install?: boolean } = {}): string {
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'package.json'), JSON.stringify({ name: 'fixture-repo', private: true }, null, 2), 'utf8')
  mkdirSync(join(rootPath, 'src'), { recursive: true })
  writeFileSync(join(rootPath, 'src', 'auth-controller.ts'), 'export const controller = true\n', 'utf8')
  mkdirSync(join(rootPath, 'out'), { recursive: true })
  writeFileSync(join(rootPath, 'out', 'graph.json'), '{}\n', 'utf8')
  if (options.install !== false) {
    claudeInstall(rootPath)
  }
  return rootPath
}

function initializeGitRepo(rootPath: string, branch = 'main'): string {
  execFileSync('git', ['init', '-b', branch], { cwd: rootPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'madar@example.com'], { cwd: rootPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Madar Test'], { cwd: rootPath, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: rootPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: rootPath, stdio: 'pipe' })
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
  benchmarkOutcome?: NativeAgentCompareReport['benchmark_outcome']
  workflowOutcome?: {
    wrong_file_edits?: number | null
    validation_passed?: boolean | null
    review_time_seconds?: number | null
    rework_loops?: number | null
    human_intervention_required?: boolean | null
    evidence?: string[]
  }
}): NativeAgentCompareResult {
  mkdirSync(input.outputDir, { recursive: true })
  const baselineAnswerPath = join(input.outputDir, 'baseline-answer.txt')
  const madarAnswerPath = join(input.outputDir, 'madar-answer.txt')
  const baselinePromptPath = join(input.outputDir, 'baseline-prompt.txt')
  const madarPromptPath = join(input.outputDir, 'madar-prompt.txt')
  const promptPath = madarPromptPath
  const legacyPromptPath = join(input.outputDir, 'native_agent-prompt.txt')
  const reportPath = join(input.outputDir, 'report.json')
  const shareSafeReportPath = join(input.outputDir, 'report.share-safe.json')

  writeFileSync(baselineAnswerPath, 'baseline\n', 'utf8')
  writeFileSync(madarAnswerPath, 'madar\n', 'utf8')
  writeFileSync(baselinePromptPath, `${input.question}\n`, 'utf8')
  writeFileSync(madarPromptPath, `${input.question}\n`, 'utf8')
  writeFileSync(legacyPromptPath, `${input.question}\n`, 'utf8')

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

  const report = {
    baseline_mode: 'native_agent',
    task: 'explain',
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
      baseline_prompt: baselinePromptPath,
      madar_prompt: madarPromptPath,
      prompt_file: promptPath,
    },
    ...(input.workflowOutcome
      ? {
          workflow_outcome: {
            wrong_file_edits: input.workflowOutcome.wrong_file_edits ?? null,
            validation_passed: input.workflowOutcome.validation_passed ?? null,
            review_time_seconds: input.workflowOutcome.review_time_seconds ?? null,
            rework_loops: input.workflowOutcome.rework_loops ?? null,
            human_intervention_required: input.workflowOutcome.human_intervention_required ?? null,
            evidence: input.workflowOutcome.evidence ?? [],
          },
        }
      : {}),
    ...(input.benchmarkOutcome ? { benchmark_outcome: input.benchmarkOutcome } : {}),
  } as NativeAgentCompareReport & {
    workflow_outcome?: {
      wrong_file_edits: number | null
      validation_passed: boolean | null
      review_time_seconds: number | null
      rework_loops: number | null
      human_intervention_required: boolean | null
      evidence: string[]
    }
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
        id: 'ts-small',
        status: 'ready',
        shape: 'library',
      }),
      expect.objectContaining({
        id: 'nestjs-mid',
        status: 'ready',
        shape: 'nestjs-service-proxy',
      }),
      expect.objectContaining({
        id: 'ts-monorepo-large',
        status: 'ready',
        shape: 'monorepo',
      }),
      expect.objectContaining({
        id: 'python-service',
        status: 'ready',
      }),
      expect.objectContaining({
        id: 'go-service',
        status: 'ready',
      }),
      expect.objectContaining({
        id: 'documenso',
        status: 'ready',
        graphRoot: 'packages/lib',
        supportsSpi: true,
        source: expect.objectContaining({
          kind: 'git',
          url: 'https://github.com/documenso/documenso',
          ref: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      }),
      expect.objectContaining({
        id: 'formbricks',
        status: 'ready',
        graphRoot: 'apps/web',
        supportsSpi: true,
        source: expect.objectContaining({
          kind: 'git',
          url: 'https://github.com/formbricks/formbricks',
          ref: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      }),
      expect.objectContaining({
        id: 'dub',
        status: 'ready',
        graphRoot: 'apps/web',
        supportsSpi: true,
        source: expect.objectContaining({
          kind: 'git',
          url: 'https://github.com/dubinc/dub',
          ref: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      }),
      expect.objectContaining({
        id: 'twenty',
        status: 'ready',
        graphRoot: 'packages/twenty-server/src/engine',
        supportsSpi: true,
        source: expect.objectContaining({
          kind: 'git',
          url: 'https://github.com/twentyhq/twenty',
          ref: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      }),
      expect.objectContaining({
        id: 'cal-diy',
        status: 'ready',
        supportsSpi: false,
        source: expect.objectContaining({
          kind: 'git',
          url: 'https://github.com/calcom/cal.diy',
          ref: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      }),
      expect.objectContaining({
        id: 'novu',
        status: 'ready',
        graphRoot: 'apps',
        supportsSpi: false,
        source: expect.objectContaining({
          kind: 'git',
          url: 'https://github.com/novuhq/novu',
          ref: expect.stringMatching(/^[0-9a-f]{40}$/),
        }),
      }),
    ]))
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'explain-runtime',
        status: 'ready',
        prompts: expect.objectContaining({
          'ts-small': expect.any(String),
          'nestjs-mid': expect.any(String),
          'ts-monorepo-large': expect.any(String),
          'python-service': expect.any(String),
          'go-service': expect.any(String),
          'documenso': expect.any(String),
          'formbricks': expect.any(String),
          'dub': expect.any(String),
          'twenty': expect.any(String),
          'cal-diy': expect.any(String),
          'novu': expect.any(String),
        }),
      }),
      expect.objectContaining({
        id: 'implement',
        status: 'ready',
        prompts: expect.objectContaining({
          'ts-small': expect.any(String),
          'nestjs-mid': expect.any(String),
          'ts-monorepo-large': expect.any(String),
          'python-service': expect.any(String),
          'go-service': expect.any(String),
          'documenso': expect.any(String),
          'formbricks': expect.any(String),
          'dub': expect.any(String),
          'twenty': expect.any(String),
          'cal-diy': expect.any(String),
          'novu': expect.any(String),
        }),
      }),
      expect.objectContaining({
        id: 'review',
        status: 'ready',
        prompts: expect.objectContaining({
          'ts-small': expect.any(String),
          'nestjs-mid': expect.any(String),
          'ts-monorepo-large': expect.any(String),
          'python-service': expect.any(String),
          'go-service': expect.any(String),
          'documenso': expect.any(String),
          'formbricks': expect.any(String),
          'dub': expect.any(String),
          'twenty': expect.any(String),
          'cal-diy': expect.any(String),
          'novu': expect.any(String),
        }),
      }),
      expect.objectContaining({
        id: 'impact',
        status: 'ready',
        prompts: expect.objectContaining({
          'ts-small': expect.any(String),
          'nestjs-mid': expect.any(String),
          'ts-monorepo-large': expect.any(String),
          'python-service': expect.any(String),
          'go-service': expect.any(String),
          'documenso': expect.any(String),
          'formbricks': expect.any(String),
          'dub': expect.any(String),
          'twenty': expect.any(String),
          'cal-diy': expect.any(String),
          'novu': expect.any(String),
        }),
      }),
    ]))
  })

  it('keeps every documented repo path present and every ready repo/task cell prompt-wired', () => {
    const repos = loadBenchmarkSuiteRepos()
    const tasks = loadBenchmarkSuiteTasks()
    const readyRepoIds = repos.filter((repo) => repo.status === 'ready').map((repo) => repo.id)

    for (const repo of repos) {
      const source =
        repo.source
        ?? (typeof repo.path === 'string'
          ? { kind: 'path' as const, path: repo.path }
          : null)
      expect(source).not.toBeNull()
      if (source?.kind === 'path') {
        expect(existsSync(source.path)).toBe(true)
      } else if (source) {
        expect(source.url).toMatch(/^https:\/\/github\.com\//)
        expect(source.ref?.trim().length ?? 0).toBeGreaterThan(0)
      }
    }

    for (const task of tasks.filter((entry) => entry.status === 'ready')) {
      for (const repoId of readyRepoIds) {
        expect(task.prompts[repoId]).toEqual(expect.any(String))
        expect(task.prompts[repoId]?.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('ships deterministic answer-quality gates for the public explain-runtime rows', () => {
    const gates = JSON.parse(readFileSync(resolve('docs/benchmarks/suite/quality-gates.json'), 'utf8')) as Record<string, {
      prompt: string
      required_answer_terms: string[]
      forbidden_answer_terms: string[]
    }>

    expect(Object.values(gates).map((gate) => gate.prompt)).toEqual(expect.arrayContaining([
      'How does Documenso move a document from send preparation through recipient creation, signing state, and notification delivery?',
      'How does Formbricks process a survey response from request handling through persistence and analytics/event tracking?',
      'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?',
      'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?',
      'How does Cal.diy turn a booking request into availability validation, scheduled event persistence, and notification delivery?',
      'How does Novu process a notification trigger from API entry through workflow orchestration to channel delivery?',
    ]))

    for (const gate of Object.values(gates)) {
      expect(gate.required_answer_terms.length).toBeGreaterThan(0)
      expect(gate.forbidden_answer_terms).toEqual(expect.arrayContaining(['mcp__madar__retrieve']))
      expect(gate).not.toHaveProperty('manual_review_notes')
      expect(gate).not.toHaveProperty('required_concepts')
    }

    const humanReviews = JSON.parse(
      readFileSync(resolve('docs/benchmarks/suite/human-review.json'), 'utf8'),
    ) as Record<string, { prompt: string; status: string; manual_review_notes: string[] }>
    expect(Object.keys(humanReviews).sort()).toEqual(Object.keys(gates).sort())
    expect(Object.values(humanReviews).every((review) => review.manual_review_notes.length > 0)).toBe(true)
    expect(Object.values(humanReviews).every((review) => review.status === 'pending')).toBe(true)

    expect(gates['documenso-explain-runtime'] as Record<string, unknown>).toEqual(expect.objectContaining({
      require_direct_evidence: true,
    }))
    expect(gates['formbricks-explain-runtime'] as Record<string, unknown>).toEqual(expect.objectContaining({
      require_direct_evidence: true,
    }))
    expect(gates['dub-explain-runtime'] as Record<string, unknown>).toEqual(expect.objectContaining({
      require_direct_evidence: true,
    }))
    expect(gates['twenty-explain-runtime'] as Record<string, unknown>).toEqual(expect.objectContaining({
      require_direct_evidence: true,
    }))
    expect(gates['cal-diy-explain-runtime'] as Record<string, unknown>).toEqual(expect.objectContaining({
      require_direct_evidence: true,
    }))
    expect(gates['novu-explain-runtime'] as Record<string, unknown>).toEqual(expect.objectContaining({
      require_direct_evidence: true,
    }))
    expect(gates['dub-explain-runtime']?.forbidden_answer_terms).toEqual(expect.arrayContaining([
      'cannot answer the core of this question',
      "redirect entrypoint isn't indexed",
      'not present in this knowledge graph',
      'not verified from indexed code',
    ]))
    expect(gates['cal-diy-explain-runtime']?.forbidden_answer_terms).toEqual(expect.arrayContaining([
      "can't cite the persistence path from evidence here",
      'persistence step in the middle is not in the evidence',
      'partly inferred',
      'did not surface the top-level handler that wires them together',
    ]))
  })

  it('ships deterministic runtime-proof profiles for the public explain-runtime rows', () => {
    const profiles = JSON.parse(readFileSync(resolve('docs/benchmarks/suite/runtime-proof.json'), 'utf8')) as Record<string, {
      prompt: string
      strict_runtime_proof: boolean
      expected_spi: boolean
      obligations: Array<{
        id: string
        label: string
        kind: string
        evidence_terms: string[]
      }>
    }>

    expect(Object.values(profiles).map((profile) => profile.prompt)).toEqual(expect.arrayContaining([
      'How does Documenso move a document from send preparation through recipient creation, signing state, and notification delivery?',
      'How does Formbricks process a survey response from request handling through persistence and analytics/event tracking?',
      'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?',
      'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?',
      'How does Cal.diy turn a booking request into availability validation, scheduled event persistence, and notification delivery?',
      'How does Novu process a notification trigger from API entry through workflow orchestration to channel delivery?',
    ]))

    for (const profile of Object.values(profiles)) {
      expect(profile.strict_runtime_proof).toBe(true)
      expect(profile.expected_spi).toBe(false)
      expect(profile.obligations.length).toBeGreaterThanOrEqual(3)
      for (const obligation of profile.obligations) {
        expect(obligation.id).toEqual(expect.any(String))
        expect(obligation.label).toEqual(expect.any(String))
        expect(['entrypoint', 'handoff', 'terminal']).toContain(obligation.kind)
        expect(obligation.evidence_terms.length).toBeGreaterThan(0)
      }
    }

    expect(profiles['dub-explain-runtime']?.obligations.map((obligation) => obligation.id)).toEqual(expect.arrayContaining([
      'request_handling',
      'analytics_tracking',
      'destination_redirect',
    ]))
    expect(profiles['twenty-explain-runtime']?.obligations.map((obligation) => obligation.id)).toEqual(expect.arrayContaining([
      'api_mutation_handling',
      'workspace_service_handoff',
      'persistence',
    ]))
  })

  it('keeps blind holdout prompts and repos outside runtime-proof configuration', () => {
    const reposPath = resolve('docs/benchmarks/suite/holdouts/repos.json')
    const tasksPath = resolve('docs/benchmarks/suite/holdouts/tasks.json')
    const repos = loadBenchmarkSuiteRepos(reposPath)
    const tasks = loadBenchmarkSuiteTasks(tasksPath)
    const prompts = Object.values(tasks[0]?.prompts ?? {})
    const productionStdioSource = readFileSync(resolve('src/runtime/stdio/tools.ts'), 'utf8')

    expect(repos.map((repo) => repo.id)).toEqual([
      'holdout-order-service',
      'holdout-invoice-service',
    ])
    expect(repos.every((repo) => repo.source?.kind === 'path' && existsSync(repo.source.path))).toBe(true)
    expect(prompts).toHaveLength(2)
    expect(loadBenchmarkRuntimeProofProfiles(tasksPath)).toBeNull()
    for (const prompt of prompts) {
      expect(productionStdioSource).not.toContain(prompt)
    }
    expect(existsSync(resolve('docs/benchmarks/suite/holdouts/quality-gates.json'))).toBe(true)
    expect(existsSync(resolve('docs/benchmarks/suite/holdouts/human-review.json'))).toBe(true)
  })

  it('rejects runtime-proof profiles with empty evidence term arrays', async () => {
    await withTempDir(async (tempDir) => {
      const benchmarkDir = join(tempDir, 'benchmarks', 'explain')
      mkdirSync(benchmarkDir, { recursive: true })
      const questionsPath = join(benchmarkDir, 'questions.json')
      writeFileSync(questionsPath, JSON.stringify([{ question: 'How does login create a session?' }], null, 2), 'utf8')
      writeFileSync(
        join(benchmarkDir, 'runtime-proof.json'),
        JSON.stringify({
          'login-runtime': {
            prompt: 'How does login create a session?',
            strict_runtime_proof: true,
            expected_spi: false,
            obligations: [
              {
                id: 'request_handling',
                label: 'request handling',
                kind: 'entrypoint',
                evidence_terms: [],
              },
            ],
          },
        }, null, 2),
        'utf8',
      )

      expect(() => loadBenchmarkRuntimeProofProfiles(questionsPath)).toThrow(
        'Malformed runtime proof profile "login-runtime": obligations.request_handling.evidence_terms must be a non-empty string array',
      )
    })
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

  it('loads git-backed repo manifests without requiring a checked-in local path', async () => {
    await withTempDir(async (tempDir) => {
      const manifestPath = join(tempDir, 'repos.json')
      writeFileSync(manifestPath, JSON.stringify([
        {
          id: 'documenso',
          name: 'Documenso',
          source: {
            kind: 'git',
            url: 'https://github.com/documenso/documenso',
            ref: 'main',
          },
          status: 'ready',
          supportsSpi: false,
        },
      ], null, 2), 'utf8')

      expect(loadBenchmarkSuiteRepos(manifestPath)).toEqual([
        expect.objectContaining({
          id: 'documenso',
          source: {
            kind: 'git',
            url: 'https://github.com/documenso/documenso',
            ref: 'main',
          },
        }),
      ])
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
          reposManifestPath: join(tempDir, 'private', 'repos.json'),
          tasksManifestPath: join(tempDir, 'private', 'tasks.json'),
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
          tasksPath: join(tempDir, 'private', 'tasks.json'),
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
        filters: {
          repos_manifest: string | null
          tasks_manifest: string | null
        }
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

      expect(summaryJson.filters).toEqual(expect.objectContaining({
        repos_manifest: '<external-manifest>',
        tasks_manifest: '<external-manifest>',
      }))

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
      expect(summaryMarkdown).toContain('Benchmark outcomes')
      expect(summaryMarkdown).toContain('| nestjs-mid |')
      expect(summaryMarkdown).toContain('| completed | — | false |')
      expect(summaryMarkdown).toContain('| python-service |')
      expect(summaryMarkdown).toContain('Cells skipped for env drift: 0')
      expect(summaryMarkdown).not.toContain('average across repos')
      expect(summaryMarkdown).not.toContain('headline')
    })
  })

  it('surfaces non-claimable benchmark outcomes in suite summaries', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'dub-fixture'))
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'dub-fixture',
          name: 'Fixture Dub-like service',
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
            'dub-fixture': 'How does the redirect flow work?',
          },
        },
      ]

      const result = await runBenchmarkSuite(
        {
          repo: null,
          task: 'explain-runtime',
          mode: 'warm',
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
            benchmarkOutcome: {
              outcome: 'not_measured',
              checks: {
                routing_tool_latency: 'not_measured',
                token: 'not_measured',
                fresh_token: 'not_measured',
                cost: 'not_measured',
                turns: 'not_measured',
              },
              evidence: ['answer quality failed for madar: forbidden did not surface'],
            },
          }),
        },
      )

      const summaryJson = JSON.parse(readFileSync(result.summaryJsonPath!, 'utf8')) as {
        cells: Array<{
          repoId: string
          benchmark_outcomes?: unknown
        }>
      }
      const summaryMarkdown = readFileSync(result.summaryPath!, 'utf8')
      const cell = summaryJson.cells.find((entry) => entry.repoId === 'dub-fixture')

      expect(cell?.benchmark_outcomes).toEqual({
        legacy: {
          counts: {
            full_win: 0,
            partial_win: 0,
            regression: 0,
            not_measured: 1,
          },
          evidence: ['answer quality failed for madar: forbidden did not surface'],
        },
        spi_madar: null,
      })
      expect(summaryMarkdown).toContain('Benchmark outcomes')
      expect(summaryMarkdown).toContain('legacy: not_measured')
      expect(summaryMarkdown).toContain('answer quality failed for madar: forbidden did not surface')
    })
  })

  it('passes implement tasks through to native-agent compare inputs', async () => {
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
          id: 'implement',
          name: 'Implement task',
          description: 'Edit login validation behavior.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'Change login validation behavior.',
          },
        },
      ]
      const seenTasks: string[] = []

      await runBenchmarkSuite(
        {
          repo: null,
          task: 'implement',
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
            seenTasks.push(((input as { task?: string }).task) ?? 'missing')
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

      expect(seenTasks).toEqual(['implement', 'implement'])
    })
  })

  it('passes tasksPath through as questionsPath so suite quality gates can run', async () => {
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
      const tasksPath = join(tempDir, 'tasks.json')
      writeFileSync(tasksPath, JSON.stringify([
        {
          id: 'explain-runtime',
          name: 'Explain runtime flow',
          description: 'Trace a runtime path end to end.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'How does login session creation flow work?',
          },
        },
      ], null, 2), 'utf8')

      const seenQuestionsPaths: Array<string | null | undefined> = []

      await runBenchmarkSuite(
        {
          repo: 'nestjs-mid',
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
          now: () => new Date('2026-05-27T12:34:56Z'),
          tasksPath,
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
            seenQuestionsPaths.push((input as { questionsPath?: string | null }).questionsPath)
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
        } as Parameters<typeof runBenchmarkSuite>[1] & { tasksPath: string },
      )

      expect(seenQuestionsPaths).toEqual([tasksPath])
    })
  })

  it('generates and compares scoped benchmark repos from their configured graph root', async () => {
    await withTempDir(async (tempDir) => {
      const repoRoot = createFixtureRepo(join(tempDir, 'repos', 'twenty'), { install: false })
      mkdirSync(join(repoRoot, 'packages', 'twenty-server', 'src', 'modules'), { recursive: true })
      writeFileSync(
        join(repoRoot, 'packages', 'twenty-server', 'src', 'modules', 'record-service.ts'),
        'export const scopedRecordService = true\n',
        'utf8',
      )
      const scopedGraphRoot = 'packages/twenty-server/src/modules'
      writeFileSync(join(repoRoot, 'CLAUDE.md'), '# repo-specific claude\n', 'utf8')
      writeFileSync(
        join(repoRoot, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            github: {
              command: 'github-mcp',
              args: [],
            },
          },
        }, null, 2),
        'utf8',
      )
      mkdirSync(join(repoRoot, '.claude'), { recursive: true })
      writeFileSync(join(repoRoot, '.claude', 'settings.json'), '{"hooks":{"UserPromptSubmit":[]}}\n', 'utf8')
      writeFileSync(join(repoRoot, scopedGraphRoot, 'CLAUDE.md'), '# scoped repo-specific claude\n', 'utf8')
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'twenty',
          name: 'Twenty scoped fixture',
          path: repoRoot,
          graphRoot: scopedGraphRoot,
          description: 'Ready fixture',
          size: 'large',
          language: 'typescript',
          shape: 'crm-platform',
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
            twenty: 'How does Twenty process a CRM record mutation?',
          },
        },
      ]
      const generatedRoots: string[] = []
      const comparedGraphPaths: string[] = []
      const comparedExecTemplates: string[] = []

      await runBenchmarkSuite(
        {
          repo: 'twenty',
          task: 'explain-runtime',
          mode: 'warm',
          trials: 1,
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
            generatedRoots.push(rootPath)
            const workspaceRoot = resolve(rootPath, ...scopedGraphRoot.split('/').map(() => '..'))
            expect(existsSync(join(workspaceRoot, 'CLAUDE.md'))).toBe(false)
            expect(existsSync(join(workspaceRoot, '.mcp.json'))).toBe(false)
            expect(existsSync(join(workspaceRoot, '.claude', 'settings.json'))).toBe(false)
            const scopedMcpConfig = JSON.parse(readFileSync(join(rootPath, '.mcp.json'), 'utf8')) as {
              mcpServers?: Record<string, {
                command?: string
                env?: Record<string, string>
              }>
            }
            const scopedClaudeRules = readFileSync(join(rootPath, 'CLAUDE.md'), 'utf8')
            expect(Object.keys(scopedMcpConfig.mcpServers ?? {})).toEqual(['madar'])
            expect(scopedMcpConfig.mcpServers?.madar?.command).toBe('madar')
            expect(scopedMcpConfig.mcpServers?.madar?.env).toEqual(expect.objectContaining({
              MADAR_TOOL_PROFILE: 'core',
            }))
            expect(scopedMcpConfig.mcpServers?.madar?.env?.PATH ?? scopedMcpConfig.mcpServers?.madar?.env?.Path).toContain(join(rootPath, '.claude', 'bin'))
            expect(scopedClaudeRules).not.toContain('# scoped repo-specific claude')
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
            comparedGraphPaths.push(input.graphPath)
            comparedExecTemplates.push(input.execTemplate)
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

      const normalizedScopedSuffix = scopedGraphRoot.split('/').join(sep)

      expect(generatedRoots).toHaveLength(1)
      expect(generatedRoots[0]).toMatch(new RegExp(`${normalizedScopedSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
      expect(comparedGraphPaths).toEqual([
        join(generatedRoots[0]!, 'out', 'graph.json'),
        join(generatedRoots[0]!, 'out', 'graph.json'),
      ])
      expect(comparedExecTemplates).toHaveLength(2)
      for (const execTemplate of comparedExecTemplates) {
        expect(execTemplate).toContain(generatedRoots[0]!)
        expect(execTemplate).not.toContain(`${dirname(generatedRoots[0]!)}" && mock-runner`)
      }
    })
  })

  it('wraps benchmark workspace exec templates with cmd-compatible Windows syntax', async () => {
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
      const seenExecTemplates: string[] = []
      const originalPlatform = process.platform

      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      })

      try {
        await runBenchmarkSuite(
          {
            repo: null,
            task: 'explain-runtime',
            mode: 'cold',
            trials: 1,
            outputDir: join(tempDir, 'results'),
            execTemplate: 'type {prompt_file} | claude -p --output-format json',
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
              seenExecTemplates.push(input.execTemplate)
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
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        })
      }

      expect(seenExecTemplates).toHaveLength(1)
      expect(seenExecTemplates[0]).toContain('cd /d "')
      expect(seenExecTemplates[0]).toContain('&& type {prompt_file} | claude -p --output-format json')
      expect(seenExecTemplates[0]).not.toContain('Set-Location -LiteralPath')
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

  it('summarizes workflow outcomes for implement cells beyond cost and latency metrics', async () => {
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
          id: 'implement',
          name: 'Implement task',
          description: 'Apply a bounded implementation change.',
          status: 'ready',
          prompts: {
            'nestjs-mid': 'Add request-id propagation to the login session flow.',
          },
        },
      ]

      const result = await runBenchmarkSuite(
        {
          repo: 'nestjs-mid',
          task: 'implement',
          mode: 'warm',
          trials: 3,
          outputDir: join(tempDir, 'results'),
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos,
          tasks,
          now: () => new Date('2026-06-01T00:00:00Z'),
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
            const trialMatch = input.outputDir.match(/trial-(\d+)/)
            const trialNumber = trialMatch ? Number.parseInt(trialMatch[1] ?? '1', 10) : 1
            return makeCompareResult({
              question: input.question ?? 'unknown',
              graphPath: input.graphPath,
              outputDir: input.outputDir,
              baselineInputTokens: 500 + trialNumber,
              madarInputTokens: 320 + trialNumber,
              baselineTurns: 9,
              madarTurns: 5,
              baselineDurationMs: 12000 + trialNumber,
              madarDurationMs: 8000 + trialNumber,
              baselineCostUsd: 1.6,
              madarCostUsd: 1.1,
              baselineToolTotal: 14,
              madarToolTotal: 8,
              baselineRead: 5,
              madarRead: 3,
              baselineGlob: 4,
              madarGlob: 2,
              baselineGrep: 2,
              madarGrep: 1,
              workflowOutcome: {
                wrong_file_edits: trialNumber === 2 ? 1 : 0,
                validation_passed: trialNumber !== 2,
                rework_loops: trialNumber,
                human_intervention_required: trialNumber === 3,
                evidence: [
                  'validation pass/fail',
                  'wrong-file edits',
                  'human intervention',
                ],
              },
            })
          },
        },
      )

      const summaryJson = JSON.parse(readFileSync(result.summaryJsonPath!, 'utf8')) as {
        cells: Array<{
          taskId: string
          workflow_outcomes?: {
            legacy: {
              wrong_file_edits: { median: number; min: number; max: number; n: number } | null
              validation_passed: { passed: number; failed: number; n: number } | null
              review_time_seconds: { median: number; min: number; max: number; n: number } | null
              rework_loops: { median: number; min: number; max: number; n: number } | null
              human_intervention_required: { yes: number; no: number; n: number } | null
              evidence: string[]
            } | null
            spi_madar: {
              wrong_file_edits: { median: number; min: number; max: number; n: number } | null
              validation_passed: { passed: number; failed: number; n: number } | null
              review_time_seconds: { median: number; min: number; max: number; n: number } | null
              rework_loops: { median: number; min: number; max: number; n: number } | null
              human_intervention_required: { yes: number; no: number; n: number } | null
              evidence: string[]
            } | null
          }
        }>
      }
      const implementCell = summaryJson.cells.find((cell) => cell.taskId === 'implement')
      const summaryMarkdown = readFileSync(result.summaryPath!, 'utf8')

      expect(implementCell?.workflow_outcomes).toEqual({
        legacy: {
          wrong_file_edits: {
            median: 0,
            min: 0,
            max: 1,
            n: 3,
          },
          validation_passed: {
            passed: 2,
            failed: 1,
            n: 3,
          },
          review_time_seconds: null,
          rework_loops: {
            median: 2,
            min: 1,
            max: 3,
            n: 3,
          },
          human_intervention_required: {
            yes: 1,
            no: 2,
            n: 3,
          },
          evidence: [
            'validation pass/fail',
            'wrong-file edits',
            'human intervention',
          ],
        },
        spi_madar: null,
      })
      expect(summaryMarkdown).toContain('Workflow outcomes')
      expect(summaryMarkdown).toContain('legacy: validation pass 2/3')
      expect(summaryMarkdown).toContain('wrong-file edits 0 (0-1, n=3)')
      expect(summaryMarkdown).toContain('human intervention 1/3')
    })
  })

  it('keeps legacy and SPI workflow outcomes separate when both arms publish receipts', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'ts-small'))
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'ts-small',
          name: 'Fixture small workspace',
          path: runnableRepoPath,
          description: 'Ready fixture',
          size: 'small',
          language: 'typescript',
          shape: 'library',
          status: 'ready',
          supportsSpi: true,
        },
      ]
      const tasks: BenchmarkSuiteTask[] = [
        {
          id: 'implement',
          name: 'Implement task',
          description: 'Apply a bounded implementation change.',
          status: 'ready',
          prompts: {
            'ts-small': 'Add audit logging to the password reset flow.',
          },
        },
      ]

      const result = await runBenchmarkSuite(
        {
          repo: 'ts-small',
          task: 'implement',
          mode: 'warm',
          trials: 3,
          outputDir: join(tempDir, 'results'),
          execTemplate: 'mock-runner',
          dryRun: false,
          yes: true,
        },
        {
          repos,
          tasks,
          now: () => new Date('2026-06-01T00:00:00Z'),
          generateGraph: (rootPath = '.', options = {}) => {
            const outputDir = options.useSpi ? join(rootPath, 'out', 'spi') : join(rootPath, 'out')
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
            const trialMatch = input.outputDir.match(/trial-(\d+)/)
            const trialNumber = trialMatch ? Number.parseInt(trialMatch[1] ?? '1', 10) : 1
            const isSpi = input.outputDir.includes(`${sep}spi${sep}`)
            return makeCompareResult({
              question: input.question ?? 'unknown',
              graphPath: input.graphPath,
              outputDir: input.outputDir,
              baselineInputTokens: 500 + trialNumber,
              madarInputTokens: 320 + trialNumber,
              baselineTurns: 9,
              madarTurns: 5,
              baselineDurationMs: 12000 + trialNumber,
              madarDurationMs: 8000 + trialNumber,
              baselineCostUsd: 1.6,
              madarCostUsd: 1.1,
              baselineToolTotal: 14,
              madarToolTotal: 8,
              baselineRead: 5,
              madarRead: 3,
              baselineGlob: 4,
              madarGlob: 2,
              baselineGrep: 2,
              madarGrep: 1,
              workflowOutcome: isSpi
                ? {
                    wrong_file_edits: 0,
                    validation_passed: true,
                    rework_loops: 0,
                    human_intervention_required: false,
                    evidence: ['spi validation pass/fail'],
                  }
                : {
                    wrong_file_edits: trialNumber === 2 ? 1 : 0,
                    validation_passed: trialNumber !== 2,
                    rework_loops: trialNumber,
                    human_intervention_required: trialNumber === 3,
                    evidence: ['legacy validation pass/fail'],
                  },
            })
          },
        },
      )

      const summaryJson = JSON.parse(readFileSync(result.summaryJsonPath!, 'utf8')) as {
        cells: Array<{
          taskId: string
          workflow_outcomes?: {
            legacy: {
              validation_passed: { passed: number; failed: number; n: number } | null
              evidence: string[]
            } | null
            spi_madar: {
              validation_passed: { passed: number; failed: number; n: number } | null
              evidence: string[]
            } | null
          }
        }>
      }
      const implementCell = summaryJson.cells.find((cell) => cell.taskId === 'implement')
      const summaryMarkdown = readFileSync(result.summaryPath!, 'utf8')

      expect(implementCell?.workflow_outcomes).toEqual({
        legacy: expect.objectContaining({
          validation_passed: {
            passed: 2,
            failed: 1,
            n: 3,
          },
          evidence: ['legacy validation pass/fail'],
        }),
        spi_madar: expect.objectContaining({
          validation_passed: {
            passed: 3,
            failed: 0,
            n: 3,
          },
          evidence: ['spi validation pass/fail'],
        }),
      })
      expect(summaryMarkdown).toContain('legacy: validation pass 2/3')
      expect(summaryMarkdown).toContain('SPI: validation pass 3/3')
    })
  })

  it('provisions a suite-managed Madar install when the source repo has no verified install', async () => {
    await withTempDir(async (tempDir) => {
      const runnableRepoPath = createFixtureRepo(join(tempDir, 'repos', 'nestjs-mid'), { install: false })

      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'nestjs-mid',
          name: 'Fixture NestJS-like service',
          source: {
            kind: 'path',
            path: runnableRepoPath,
          },
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
      const generatedWorkspaceRoots: string[] = []

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
            generatedWorkspaceRoots.push(rootPath)
            expect(existsSync(join(rootPath, '.mcp.json'))).toBe(true)
            expect(existsSync(join(rootPath, 'CLAUDE.md'))).toBe(true)
            expect(existsSync(join(rootPath, '.claude', 'settings.json'))).toBe(true)
            const mcpConfig = JSON.parse(readFileSync(join(rootPath, '.mcp.json'), 'utf8')) as {
              mcpServers?: Record<string, {
                command?: string
                env?: Record<string, string>
              }>
            }
            expect(mcpConfig.mcpServers?.madar?.command).toBe('madar')
            expect(mcpConfig.mcpServers?.madar?.env).toEqual(expect.objectContaining({
              MADAR_TOOL_PROFILE: 'core',
            }))
            expect(mcpConfig.mcpServers?.madar?.env?.PATH ?? mcpConfig.mcpServers?.madar?.env?.Path).toContain(join(rootPath, '.claude', 'bin'))
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
            return makeCompareResult({
              question: 'How does login session creation flow work?',
              graphPath: join(generatedWorkspaceRoots[generatedWorkspaceRoots.length - 1]!, 'out', 'graph.json'),
              outputDir: join(tempDir, 'compare'),
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

      expect(generateCalls).toBe(2)
      expect(compareCalls).toBe(1)
      expect(result.summary?.cells[0]).toEqual(expect.objectContaining({
        repoId: 'nestjs-mid',
        status: 'completed',
      }))
      expect(result.summary?.cells_skipped_for_install).toBe(0)
    })
  })

  it('clones git-backed repos and provisions the benchmark workspace before compare', async () => {
    await withTempDir(async (tempDir) => {
      const sourceRepoPath = initializeGitRepo(createFixtureRepo(join(tempDir, 'repos', 'documenso-source'), { install: false }))
      const pinnedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepoPath, encoding: 'utf8', stdio: 'pipe' }).trim()
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'documenso',
          name: 'Documenso source repo',
          source: {
            kind: 'git',
            url: sourceRepoPath,
            ref: pinnedSha,
          },
          description: 'Git-backed benchmark repo',
          size: 'large',
          language: 'typescript',
          shape: 'monorepo',
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
            'documenso': 'How does the document send flow move from creation to recipient delivery?',
          },
        },
      ]
      const generatedWorkspaceRoots: string[] = []
      let compareCalls = 0

      const result = await runBenchmarkSuite(
        {
          repo: 'documenso',
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
            generatedWorkspaceRoots.push(rootPath)
            expect(rootPath).not.toBe(sourceRepoPath)
            expect(existsSync(join(rootPath, '.mcp.json'))).toBe(true)
            expect(existsSync(join(rootPath, 'CLAUDE.md'))).toBe(true)
            expect(existsSync(join(rootPath, '.claude', 'settings.json'))).toBe(true)
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
            return makeCompareResult({
              question: 'How does the document send flow move from creation to recipient delivery?',
              graphPath: join(generatedWorkspaceRoots[generatedWorkspaceRoots.length - 1]!, 'out', 'graph.json'),
              outputDir: join(tempDir, 'compare'),
              baselineInputTokens: 320,
              madarInputTokens: 210,
              baselineTurns: 6,
              madarTurns: 4,
              baselineDurationMs: 9100,
              madarDurationMs: 6100,
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

      expect(compareCalls).toBe(1)
      expect(result.summary?.cells[0]).toEqual(expect.objectContaining({
        repoId: 'documenso',
        status: 'completed',
      }))
    })
  })

  it('normalizes repo-local Claude and MCP config before provisioning the benchmark workspace', async () => {
    await withTempDir(async (tempDir) => {
      const sourceRepoPath = createFixtureRepo(join(tempDir, 'repos', 'twenty-source'), { install: false })
      writeFileSync(join(sourceRepoPath, 'CLAUDE.md'), '# repo-specific claude\n', 'utf8')
      mkdirSync(join(sourceRepoPath, '.claude'), { recursive: true })
      writeFileSync(
        join(sourceRepoPath, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [{ type: 'command', command: 'echo repo-hook' }],
              },
            ],
          },
        }, null, 2),
        'utf8',
      )
      writeFileSync(
        join(sourceRepoPath, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            github: {
              command: 'github-mcp',
              args: [],
            },
          },
        }, null, 2),
        'utf8',
      )

      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'twenty',
          name: 'Twenty source repo',
          source: {
            kind: 'path',
            path: sourceRepoPath,
          },
          description: 'Ready fixture',
          size: 'large',
          language: 'typescript',
          shape: 'crm-platform',
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
            'twenty': 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?',
          },
        },
      ]

      await runBenchmarkSuite(
        {
          repo: 'twenty',
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
            const mcpConfig = JSON.parse(readFileSync(join(rootPath, '.mcp.json'), 'utf8')) as {
              mcpServers?: Record<string, {
                command?: string
                env?: Record<string, string>
              }>
            }
            const claudeRules = readFileSync(join(rootPath, 'CLAUDE.md'), 'utf8')

            expect(Object.keys(mcpConfig.mcpServers ?? {})).toEqual(['madar'])
            expect(mcpConfig.mcpServers?.madar?.command).toBe('madar')
            expect(mcpConfig.mcpServers?.madar?.env).toEqual(expect.objectContaining({
              MADAR_TOOL_PROFILE: 'core',
            }))
            expect(mcpConfig.mcpServers?.madar?.env?.PATH ?? mcpConfig.mcpServers?.madar?.env?.Path).toContain(join(rootPath, '.claude', 'bin'))
            expect(claudeRules).not.toContain('# repo-specific claude')

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
          executeNativeAgentCompare: async () => makeCompareResult({
            question: 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?',
            graphPath: join(tempDir, 'compare-graph', 'out', 'graph.json'),
            outputDir: join(tempDir, 'compare'),
            baselineInputTokens: 320,
            madarInputTokens: 220,
            baselineTurns: 7,
            madarTurns: 4,
            baselineDurationMs: 9200,
            madarDurationMs: 6200,
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
    })
  })

  it('records repo preparation failures as skipped and continues with other ready rows', async () => {
    await withTempDir(async (tempDir) => {
      const goodRepoPath = createFixtureRepo(join(tempDir, 'repos', 'good-repo'), { install: false })
      const repos: BenchmarkSuiteRepo[] = [
        {
          id: 'broken-git',
          name: 'Broken git repo',
          source: {
            kind: 'git',
            url: join(tempDir, 'repos', 'missing-repo'),
            ref: 'main',
          },
          description: 'Broken git-backed repo',
          size: 'mid',
          language: 'typescript',
          shape: 'service',
          status: 'ready',
          supportsSpi: false,
        },
        {
          id: 'good-path',
          name: 'Good path repo',
          source: {
            kind: 'path',
            path: goodRepoPath,
          },
          description: 'Healthy path-backed repo',
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
            'broken-git': 'How does the broken repo flow work?',
            'good-path': 'How does the good repo flow work?',
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
          generateGraph: (rootPath = '.', options = {}) => ({
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
          } satisfies GenerateGraphResult),
          executeNativeAgentCompare: async () => {
            compareCalls += 1
            return makeCompareResult({
              question: 'How does the good repo flow work?',
              graphPath: join(tempDir, 'compare-graph', 'out', 'graph.json'),
              outputDir: join(tempDir, 'compare'),
              baselineInputTokens: 320,
              madarInputTokens: 220,
              baselineTurns: 7,
              madarTurns: 4,
              baselineDurationMs: 9200,
              madarDurationMs: 6200,
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

      expect(compareCalls).toBe(1)
      expect(result.summary?.cells).toEqual(expect.arrayContaining([
        expect.objectContaining({
          repoId: 'broken-git',
          status: 'skipped',
          reason: expect.stringContaining('failed'),
        }),
        expect.objectContaining({
          repoId: 'good-path',
          status: 'completed',
        }),
      ]))
      expect(result.summary?.cells_skipped_for_install).toBe(1)
      expect(result.text).toContain('1 skipped during preparation')
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
      const normalizedShareSafePath = shareSafePath!.replaceAll('\\', '/')
      expect(normalizedShareSafePath).toContain('/trial-001/report.share-safe.json')
      expect(normalizedShareSafePath).not.toContain('/trial-001/trial-001/')

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
