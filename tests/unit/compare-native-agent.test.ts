import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  executeNativeAgentCompare,
  formatNativeAgentCompareSummary,
  parseAnthropicResultEvent,
  type CompareRunMode,
  type NativeAgentCompareResult,
  type NativeAgentCompareReport,
  type NativeAgentRunner,
} from '../../src/infrastructure/compare.js'

const FIXTURE_PARENT = resolve('out', 'test-runtime', 'native-agent')
const COMPARE_OUTPUT_PARENT = resolve('out', 'compare', 'test-runtime-native-agent')

function makeFixtureProject(): { projectDir: string; graphPath: string; outputDir: string } {
  mkdirSync(FIXTURE_PARENT, { recursive: true })
  mkdirSync(COMPARE_OUTPUT_PARENT, { recursive: true })
  const projectDir = mkdtempSync(join(FIXTURE_PARENT, 'project-'))
  const outputDir = mkdtempSync(join(COMPARE_OUTPUT_PARENT, 'out-'))
  // Build a minimal out/graph.json so the snapshot has something to rename.
  mkdirSync(join(projectDir, 'out'), { recursive: true })
  writeFileSync(
    join(projectDir, 'out', 'graph.json'),
    JSON.stringify({
      community_labels: { '0': 'Mock' },
      nodes: [
        { id: 'a', label: 'Alpha', source_file: 'a.ts', source_location: '1', file_type: 'code', community: 0 },
      ],
      edges: [],
      hyperedges: [],
    }),
    'utf8',
  )
  // Plant the other snapshot targets so we can verify they round-trip.
  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'madar': {} } }, null, 2), 'utf8')
  writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project Claude rules\n', 'utf8')
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  writeFileSync(join(projectDir, '.claude', 'settings.json'), '{}\n', 'utf8')
  return { projectDir, graphPath: join(projectDir, 'out', 'graph.json'), outputDir }
}

const BASELINE_USAGE_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 96368,
  num_turns: 9,
  result: 'baseline answer',
  total_cost_usd: 0.62,
  usage: {
    input_tokens: 14,
    cache_creation_input_tokens: 40648,
    cache_read_input_tokens: 574528,
    output_tokens: 3152,
  },
}

const MADAR_USAGE_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 34744,
  num_turns: 3,
  result: 'madar answer',
  total_cost_usd: 0.7,
  usage: {
    input_tokens: 13,
    cache_creation_input_tokens: 92833,
    cache_read_input_tokens: 140662,
    output_tokens: 1893,
  },
}

function scriptedRunner(payloads: { baseline: unknown; madar: unknown }): NativeAgentRunner {
  return async (input) => ({
    exitCode: 0,
    stdout: `${JSON.stringify(input.mode === 'baseline' ? payloads.baseline : payloads.madar)}\n`,
    stderr: '',
    elapsedMs: input.mode === 'baseline' ? 96368 : 34744,
  })
}

function buildSummaryResult(overrides: {
  question: string
  baselineTurns: number
  madarTurns: number
  baselineDurationMs: number
  madarDurationMs: number
  baselineInputTokens: number
  madarInputTokens: number
  reductions: NonNullable<NativeAgentCompareReport['reductions']>
}): NativeAgentCompareResult {
  return {
    graph_path: '/tmp/project/out/graph.json',
    output_root: '/tmp/project/out/compare/2026-05-12T00-00-00Z',
    reports: [
      {
        baseline_mode: 'native_agent',
        question: overrides.question,
        graph_path: '/tmp/project/out/graph.json',
        exec_command: { command: null, redacted: true, placeholders: [] },
        baseline: {
          kind: 'succeeded',
          model: 'claude-sonnet',
          usage: {
            input_tokens: overrides.baselineInputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 100,
          },
          total_input_tokens_anthropic_exact: overrides.baselineInputTokens,
          uncached_input_tokens_anthropic_exact: overrides.baselineInputTokens,
          cached_input_tokens_anthropic_exact: 0,
          total_cost_usd: 1,
          num_turns: overrides.baselineTurns,
          duration_ms: overrides.baselineDurationMs,
          result_path: '/tmp/project/baseline.txt',
        },
        madar: {
          kind: 'succeeded',
          model: 'claude-sonnet',
          usage: {
            input_tokens: overrides.madarInputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 100,
          },
          total_input_tokens_anthropic_exact: overrides.madarInputTokens,
          uncached_input_tokens_anthropic_exact: overrides.madarInputTokens,
          cached_input_tokens_anthropic_exact: 0,
          total_cost_usd: 1,
          num_turns: overrides.madarTurns,
          duration_ms: overrides.madarDurationMs,
          result_path: '/tmp/project/madar.txt',
        },
        reductions: overrides.reductions,
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
        started_at: '2026-05-12T00:00:00.000Z',
        completed_at: '2026-05-12T00:00:01.000Z',
        paths: {
          output_dir: '/tmp/project/out/compare/2026-05-12T00-00-00Z',
          report: '/tmp/project/out/compare/2026-05-12T00-00-00Z/report.json',
          share_safe_report: '/tmp/project/out/compare/2026-05-12T00-00-00Z/report.share-safe.json',
          baseline_answer: '/tmp/project/out/compare/2026-05-12T00-00-00Z/baseline.md',
          madar_answer: '/tmp/project/out/compare/2026-05-12T00-00-00Z/madar.md',
          prompt_file: '/tmp/project/out/compare/2026-05-12T00-00-00Z/prompt.txt',
        },
      },
    ],
  }
}

type SummaryOverrides = Parameters<typeof buildSummaryResult>[0]

function buildSuiteSummaryResult(overridesList: SummaryOverrides[]): NativeAgentCompareResult {
  return {
    graph_path: '/tmp/project/out/graph.json',
    output_root: '/tmp/project/out/compare/2026-05-12T00-00-00Z',
    reports: overridesList.map((overrides) => buildSummaryResult(overrides).reports[0]!),
  }
}

describe('parseAnthropicResultEvent', () => {
  it('parses a single non-stream JSON object from stdout', () => {
    const stdout = `${JSON.stringify(BASELINE_USAGE_PAYLOAD)}\n`
    const parsed = parseAnthropicResultEvent(stdout)
    expect(parsed).not.toBeNull()
    expect(parsed?.usage.input_tokens).toBe(14)
    expect(parsed?.num_turns).toBe(9)
  })

  it('extracts the trailing result event from a stream-json stdout', () => {
    const intermediate = JSON.stringify({ type: 'system', subtype: 'init', tools: ['retrieve'] })
    const result = JSON.stringify({ ...MADAR_USAGE_PAYLOAD })
    const parsed = parseAnthropicResultEvent(`${intermediate}\n${result}\n`)
    expect(parsed).not.toBeNull()
    expect(parsed?.usage.input_tokens).toBe(13)
    expect(parsed?.num_turns).toBe(3)
  })

  it('returns null when stdout has no parseable trailing JSON object', () => {
    expect(parseAnthropicResultEvent('not a json blob at all')).toBeNull()
  })

  it('returns null when the trailing JSON object lacks a usage block', () => {
    expect(parseAnthropicResultEvent(JSON.stringify({ type: 'result', result: 'no usage' }))).toBeNull()
  })
})

describe('executeNativeAgentCompare', () => {
  it('produces a report with both Anthropic-reported usage blocks and computed reductions', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'What is the cluster module?',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      expect(result.reports).toHaveLength(1)
      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.baseline_mode).toBe('native_agent')
      expect(report.exec_command.command).toBeNull()
      expect(report.exec_command.redacted).toBe(true)

      // Both Anthropic-reported usage blocks are preserved as-is.
      expect(report.baseline.kind).toBe('succeeded')
      if (report.baseline.kind !== 'succeeded') {
        throw new Error('baseline should have succeeded')
      }
      expect(report.baseline.usage).toEqual(BASELINE_USAGE_PAYLOAD.usage)
      expect(report.baseline.num_turns).toBe(9)
      expect(report.baseline.total_cost_usd).toBe(0.62)

      expect(report.madar.kind).toBe('succeeded')
      if (report.madar.kind !== 'succeeded') {
        throw new Error('madar should have succeeded')
      }
      expect(report.madar.usage).toEqual(MADAR_USAGE_PAYLOAD.usage)
      expect(report.madar.num_turns).toBe(3)
      expect(report.madar.total_cost_usd).toBe(0.7)

      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
        baseline: Record<string, unknown>
        madar: Record<string, unknown>
      }
      expect(savedReport.baseline).toEqual(expect.objectContaining({
        total_input_tokens_anthropic_exact: 615190,
        uncached_input_tokens_anthropic_exact: 40662,
        cached_input_tokens_anthropic_exact: 574528,
      }))
      expect(savedReport.madar).toEqual(expect.objectContaining({
        total_input_tokens_anthropic_exact: 233508,
        uncached_input_tokens_anthropic_exact: 92846,
        cached_input_tokens_anthropic_exact: 140662,
      }))

      // Reductions match the spec table (3x turns, 2.6x input, 2.77x duration).
      expect(report.reductions).not.toBeNull()
      expect(report.reductions?.num_turns).toBeCloseTo(3.0, 2)
      expect(report.reductions?.input_tokens).toBeCloseTo(2.63, 1)
      expect(report.reductions?.duration_ms).toBeCloseTo(2.77, 1)

      // prompt_token_source must label both as Anthropic-provider-reported when
      // a usage block was present in the runner output.
      expect(report.prompt_token_source.baseline).toBe('anthropic_provider_reported')
      expect(report.prompt_token_source.madar).toBe('anthropic_provider_reported')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('restores out, .mcp.json, CLAUDE.md, and .claude/ when the baseline runner crashes', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    const before = {
      madarOut: readFileSync(join(projectDir, 'out', 'graph.json'), 'utf8'),
      mcpJson: readFileSync(join(projectDir, '.mcp.json'), 'utf8'),
      claudeMd: readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8'),
      claudeSettings: readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8'),
    }
    try {
      const crashRunner: NativeAgentRunner = async (input) => {
        if (input.mode === 'baseline') {
          throw new Error('baseline runner exploded mid-snapshot')
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(MADAR_USAGE_PAYLOAD)}\n`,
          stderr: '',
          elapsedMs: 34744,
        }
      }

      await expect(
        executeNativeAgentCompare(
          {
            graphPath,
            question: 'crash test',
            outputDir,
            execTemplate: 'mock-runner',
            baselineMode: 'native_agent',
          },
          {
            runner: crashRunner,
            now: () => new Date('2026-05-01T00:00:00Z'),
          },
        ),
      ).rejects.toThrow(/baseline/i)

      // Snapshot targets must be restored exactly even after the crash.
      expect(existsSync(join(projectDir, 'out', 'graph.json'))).toBe(true)
      expect(readFileSync(join(projectDir, 'out', 'graph.json'), 'utf8')).toBe(before.madarOut)
      expect(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).toBe(before.mcpJson)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(before.claudeMd)
      expect(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')).toBe(before.claudeSettings)

      // No leftover *.compare-bak-* siblings in the project root.
      const entries = readdirSync(projectDir)
      const leftoverBackups = ['out', '.mcp.json', 'CLAUDE.md', '.claude'].filter((target) =>
        entries.some((entry) => entry.startsWith(`${target}.compare-bak-`)),
      )
      expect(leftoverBackups).toEqual([])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('absent out files at start mean the baseline run sees an unmodified absent state', async () => {
    // When CLAUDE.md / .mcp.json / .claude don't exist, snapshot is a no-op for them
    // and they should still be absent after the run.
    mkdirSync(FIXTURE_PARENT, { recursive: true })
    mkdirSync(COMPARE_OUTPUT_PARENT, { recursive: true })
    const projectDir = mkdtempSync(join(FIXTURE_PARENT, 'bare-'))
    const outputDir = mkdtempSync(join(COMPARE_OUTPUT_PARENT, 'bare-out-'))
    mkdirSync(join(projectDir, 'out'), { recursive: true })
    writeFileSync(
      join(projectDir, 'out', 'graph.json'),
      JSON.stringify({ nodes: [], edges: [], hyperedges: [] }),
      'utf8',
    )
    try {
      await executeNativeAgentCompare(
        {
          graphPath: join(projectDir, 'out', 'graph.json'),
          question: 'bare project',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      expect(existsSync(join(projectDir, '.mcp.json'))).toBe(false)
      expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false)
      expect(existsSync(join(projectDir, '.claude'))).toBe(false)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('keeps out/compare/<ts> writable during the baseline run (snapshot does not hide the output dir)', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      // The runner deliberately probes the prompt-file path during the baseline run.
      // If the snapshot renamed out/ wholesale, the path would be missing
      // and the runner would have observed it. The runner returns whether each call
      // saw the file present.
      const probeResults: Array<{ mode: CompareRunMode; promptFileExists: boolean }> = []
      const probingRunner: NativeAgentRunner = async (input) => {
        probeResults.push({ mode: input.mode, promptFileExists: existsSync(input.promptFile) })
        const payload = input.mode === 'baseline' ? BASELINE_USAGE_PAYLOAD : MADAR_USAGE_PAYLOAD
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(payload)}\n`,
          stderr: '',
          elapsedMs: input.mode === 'baseline' ? 96368 : 34744,
        }
      }

      await executeNativeAgentCompare(
        {
          graphPath,
          question: 'snapshot scope check',
          outputDir,
          execTemplate: 'noop',
          baselineMode: 'native_agent',
        },
        {
          runner: probingRunner,
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      expect(probeResults).toHaveLength(2)
      expect(probeResults.every((probe) => probe.promptFileExists)).toBe(true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('redacts the exec command in the persisted report (does not leak --exec text)', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'redaction check',
          outputDir,
          execTemplate: "claude --api-key sk-secret -p '{question}'",
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, madar: MADAR_USAGE_PAYLOAD }),
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      const reportFile = readFileSync(report.paths.report, 'utf8')
      expect(reportFile).not.toContain('sk-secret')
      expect(reportFile).not.toContain('--api-key')
      expect(report.exec_command.command).toBeNull()
      expect(report.exec_command.redacted).toBe(true)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('preserves answer-only runs when stdout has no parseable result event but the runner exits cleanly', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      const garbledRunner: NativeAgentRunner = async () => ({
        exitCode: 0,
        stdout: 'not JSON, just a text blob',
        stderr: '',
        elapsedMs: 1,
      })

      const result = await executeNativeAgentCompare(
        {
          graphPath,
          question: 'garbled',
          outputDir,
          execTemplate: 'mock',
          baselineMode: 'native_agent',
        },
        {
          runner: garbledRunner,
          now: () => new Date('2026-05-01T00:00:00Z'),
        },
      )

      const report = result.reports[0] as NativeAgentCompareReport
      expect(report.baseline.kind).toBe('answer_only')
      if (report.baseline.kind === 'answer_only') {
        expect(report.baseline.evidence).toContain('not JSON')
        expect(report.baseline.exit_code).toBe(0)
      }
      expect(report.madar.kind).toBe('answer_only')
      expect(report.reductions).toBeNull()
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})

describe('formatNativeAgentCompareSummary', () => {
  it('describes wins as fewer, less, and faster', () => {
    const result = buildSummaryResult({
      question: 'win case',
      baselineTurns: 9,
      madarTurns: 3,
      baselineDurationMs: 9000,
      madarDurationMs: 3000,
      baselineInputTokens: 900,
      madarInputTokens: 300,
      reductions: {
        num_turns: 3,
        duration_ms: 3,
        input_tokens: 3,
        cost_usd: 1,
      },
    })
    const report = result.reports[0]
    if (!report || report.baseline.kind !== 'succeeded' || report.madar.kind !== 'succeeded') {
      throw new Error('summary fixture should produce succeeded runs')
    }
    report.baseline.usage = {
      input_tokens: 600,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 100,
      output_tokens: 100,
    }
    report.baseline.uncached_input_tokens_anthropic_exact = 800
    report.baseline.cached_input_tokens_anthropic_exact = 100
    report.madar.usage = {
      input_tokens: 150,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
      output_tokens: 100,
    }
    report.madar.uncached_input_tokens_anthropic_exact = 250
    report.madar.cached_input_tokens_anthropic_exact = 50

    const summary = formatNativeAgentCompareSummary(result)

    expect(summary).toContain('num_turns: baseline 9 → madar 3 (3x fewer)')
    expect(summary).toContain('latency:   baseline 9000ms → madar 3000ms (3x faster)')
    expect(summary).toContain('input_tokens (Anthropic-reported): baseline 900 → madar 300 (3x less)')
    expect(summary).toContain('uncached_input_tokens (Anthropic-reported): baseline 800 → madar 250 (3.2x less)')
    expect(summary).toContain('cache_creation_input_tokens (Anthropic-reported): baseline 200 → madar 100 (2x less)')
    expect(summary).toContain('cache_read_input_tokens (Anthropic-reported): baseline 100 → madar 50 (2x less)')
  })

  it('describes regressions as more and slower instead of fewer and faster', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'loss case',
      baselineTurns: 3,
      madarTurns: 9,
      baselineDurationMs: 3000,
      madarDurationMs: 9000,
      baselineInputTokens: 300,
      madarInputTokens: 900,
      reductions: {
        num_turns: 0.33,
        duration_ms: 0.33,
        input_tokens: 0.33,
        cost_usd: 1,
      },
    }))

    expect(summary).toContain('num_turns: baseline 3 → madar 9 (3x more)')
    expect(summary).toContain('latency:   baseline 3000ms → madar 9000ms (3x slower)')
    expect(summary).toContain('input_tokens (Anthropic-reported): baseline 300 → madar 900 (3x more)')
    expect(summary).not.toContain('0.33x fewer')
    expect(summary).not.toContain('0.33x faster')
    expect(summary).not.toContain('0.33x less')
  })

  it('omits cache-detail lines when neither run reported cache activity', () => {
    const summary = formatNativeAgentCompareSummary(buildSummaryResult({
      question: 'no cache case',
      baselineTurns: 9,
      madarTurns: 3,
      baselineDurationMs: 9000,
      madarDurationMs: 3000,
      baselineInputTokens: 900,
      madarInputTokens: 300,
      reductions: {
        num_turns: 3,
        duration_ms: 3,
        input_tokens: 3,
        cost_usd: 1,
      },
    }))

    expect(summary).not.toContain('uncached_input_tokens (Anthropic-reported)')
    expect(summary).not.toContain('cache_creation_input_tokens (Anthropic-reported)')
    expect(summary).not.toContain('cache_read_input_tokens (Anthropic-reported)')
  })

  it('summarizes all-win native_agent suites with aggregate win counts and reductions', () => {
    const summary = formatNativeAgentCompareSummary(buildSuiteSummaryResult([
      {
        question: 'win a',
        baselineTurns: 9,
        madarTurns: 3,
        baselineDurationMs: 9000,
        madarDurationMs: 3000,
        baselineInputTokens: 900,
        madarInputTokens: 300,
        reductions: {
          num_turns: 3,
          duration_ms: 3,
          input_tokens: 3,
          cost_usd: 1,
        },
      },
      {
        question: 'win b',
        baselineTurns: 8,
        madarTurns: 2,
        baselineDurationMs: 8000,
        madarDurationMs: 2000,
        baselineInputTokens: 800,
        madarInputTokens: 200,
        reductions: {
          num_turns: 4,
          duration_ms: 4,
          input_tokens: 4,
          cost_usd: 1,
        },
      },
    ]))

    expect(summary).toContain('Suite input_tokens (Anthropic-reported): 2 wins · 0 losses · mean reduction 70.8% · median reduction 70.8% · best win: "win b" (75% less) · worst regression: none')
    expect(summary).toContain('Suite num_turns: 2 wins · 0 losses · best win: "win b" (75% fewer) · worst regression: none')
    expect(summary).toContain('Suite latency: 2 wins · 0 losses · best win: "win b" (75% faster) · worst regression: none')
  })

  it('summarizes mixed native_agent suites with wins, losses, and regressions', () => {
    const summary = formatNativeAgentCompareSummary(buildSuiteSummaryResult([
      {
        question: 'win case',
        baselineTurns: 10,
        madarTurns: 5,
        baselineDurationMs: 10000,
        madarDurationMs: 5000,
        baselineInputTokens: 1000,
        madarInputTokens: 500,
        reductions: {
          num_turns: 2,
          duration_ms: 2,
          input_tokens: 2,
          cost_usd: 1,
        },
      },
      {
        question: 'loss case',
        baselineTurns: 4,
        madarTurns: 6,
        baselineDurationMs: 4000,
        madarDurationMs: 6000,
        baselineInputTokens: 400,
        madarInputTokens: 500,
        reductions: {
          num_turns: 0.67,
          duration_ms: 0.67,
          input_tokens: 0.8,
          cost_usd: 1,
        },
      },
    ]))

    expect(summary).toContain('Suite input_tokens (Anthropic-reported): 1 win · 1 loss · mean reduction 12.5% · median reduction 12.5% · best win: "win case" (50% less) · worst regression: "loss case" (25% more)')
    expect(summary).toContain('Suite num_turns: 1 win · 1 loss · best win: "win case" (50% fewer) · worst regression: "loss case" (50% more)')
    expect(summary).toContain('Suite latency: 1 win · 1 loss · best win: "win case" (50% faster) · worst regression: "loss case" (50% slower)')
  })

  it('calls out the comparable-question denominator when answer-only runs are excluded from suite aggregates', () => {
    const result = buildSuiteSummaryResult([
      {
        question: 'win a',
        baselineTurns: 9,
        madarTurns: 3,
        baselineDurationMs: 9000,
        madarDurationMs: 3000,
        baselineInputTokens: 900,
        madarInputTokens: 300,
        reductions: {
          num_turns: 3,
          duration_ms: 3,
          input_tokens: 3,
          cost_usd: 1,
        },
      },
      {
        question: 'win b',
        baselineTurns: 8,
        madarTurns: 2,
        baselineDurationMs: 8000,
        madarDurationMs: 2000,
        baselineInputTokens: 800,
        madarInputTokens: 200,
        reductions: {
          num_turns: 4,
          duration_ms: 4,
          input_tokens: 4,
          cost_usd: 1,
        },
      },
      {
        question: 'answer only',
        baselineTurns: 5,
        madarTurns: 5,
        baselineDurationMs: 5000,
        madarDurationMs: 5000,
        baselineInputTokens: 500,
        madarInputTokens: 500,
        reductions: {
          num_turns: 1,
          duration_ms: 1,
          input_tokens: 1,
          cost_usd: 1,
        },
      },
    ])
    result.reports[2] = {
      ...result.reports[2]!,
      madar: {
        kind: 'answer_only',
        evidence: null,
        exit_code: 0,
        stderr: null,
        result_path: '/tmp/project/answer-only.txt',
      },
      reductions: null,
    }

    const summary = formatNativeAgentCompareSummary(result)

    expect(summary).toContain('Suite input_tokens (Anthropic-reported): 2 wins · 0 losses · 2/3 comparable · mean reduction 70.8% · median reduction 70.8% · best win: "win b" (75% less) · worst regression: none')
    expect(summary).toContain('Suite num_turns: 2 wins · 0 losses · 2/3 comparable · best win: "win b" (75% fewer) · worst regression: none')
    expect(summary).toContain('Suite latency: 2 wins · 0 losses · 2/3 comparable · best win: "win b" (75% faster) · worst regression: none')
    expect(summary).toContain('"answer only" → answer-only run saved; no Anthropic usage block was available, so provider-proof reductions were not computed')
  })
})
