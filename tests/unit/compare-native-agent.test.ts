import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  executeNativeAgentCompare,
  parseAnthropicResultEvent,
  type CompareRunMode,
  type NativeAgentCompareReport,
  type NativeAgentRunner,
} from '../../src/infrastructure/compare.js'

const FIXTURE_PARENT = resolve('graphify-out', 'test-runtime', 'native-agent')
const COMPARE_OUTPUT_PARENT = resolve('graphify-out', 'compare', 'test-runtime-native-agent')

function makeFixtureProject(): { projectDir: string; graphPath: string; outputDir: string } {
  mkdirSync(FIXTURE_PARENT, { recursive: true })
  mkdirSync(COMPARE_OUTPUT_PARENT, { recursive: true })
  const projectDir = mkdtempSync(join(FIXTURE_PARENT, 'project-'))
  const outputDir = mkdtempSync(join(COMPARE_OUTPUT_PARENT, 'out-'))
  // Build a minimal graphify-out/graph.json so the snapshot has something to rename.
  mkdirSync(join(projectDir, 'graphify-out'), { recursive: true })
  writeFileSync(
    join(projectDir, 'graphify-out', 'graph.json'),
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
  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'graphify-ts': {} } }, null, 2), 'utf8')
  writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project Claude rules\n', 'utf8')
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  writeFileSync(join(projectDir, '.claude', 'settings.json'), '{}\n', 'utf8')
  return { projectDir, graphPath: join(projectDir, 'graphify-out', 'graph.json'), outputDir }
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

const GRAPHIFY_USAGE_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 34744,
  num_turns: 3,
  result: 'graphify answer',
  total_cost_usd: 0.7,
  usage: {
    input_tokens: 13,
    cache_creation_input_tokens: 92833,
    cache_read_input_tokens: 140662,
    output_tokens: 1893,
  },
}

function scriptedRunner(payloads: { baseline: unknown; graphify: unknown }): NativeAgentRunner {
  return async (input) => ({
    exitCode: 0,
    stdout: `${JSON.stringify(input.mode === 'baseline' ? payloads.baseline : payloads.graphify)}\n`,
    stderr: '',
    elapsedMs: input.mode === 'baseline' ? 96368 : 34744,
  })
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
    const result = JSON.stringify({ ...GRAPHIFY_USAGE_PAYLOAD })
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
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, graphify: GRAPHIFY_USAGE_PAYLOAD }),
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

      expect(report.graphify.kind).toBe('succeeded')
      if (report.graphify.kind !== 'succeeded') {
        throw new Error('graphify should have succeeded')
      }
      expect(report.graphify.usage).toEqual(GRAPHIFY_USAGE_PAYLOAD.usage)
      expect(report.graphify.num_turns).toBe(3)
      expect(report.graphify.total_cost_usd).toBe(0.7)

      // Reductions match the spec table (3x turns, 2.6x input, 2.77x duration).
      expect(report.reductions).not.toBeNull()
      expect(report.reductions?.num_turns).toBeCloseTo(3.0, 2)
      expect(report.reductions?.input_tokens).toBeCloseTo(2.63, 1)
      expect(report.reductions?.duration_ms).toBeCloseTo(2.77, 1)

      // prompt_token_source must label both as Anthropic-provider-reported when
      // a usage block was present in the runner output.
      expect(report.prompt_token_source.baseline).toBe('anthropic_provider_reported')
      expect(report.prompt_token_source.graphify).toBe('anthropic_provider_reported')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('restores graphify-out, .mcp.json, CLAUDE.md, and .claude/ when the baseline runner crashes', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    const before = {
      graphifyOut: readFileSync(join(projectDir, 'graphify-out', 'graph.json'), 'utf8'),
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
          stdout: `${JSON.stringify(GRAPHIFY_USAGE_PAYLOAD)}\n`,
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
      expect(existsSync(join(projectDir, 'graphify-out', 'graph.json'))).toBe(true)
      expect(readFileSync(join(projectDir, 'graphify-out', 'graph.json'), 'utf8')).toBe(before.graphifyOut)
      expect(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).toBe(before.mcpJson)
      expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8')).toBe(before.claudeMd)
      expect(readFileSync(join(projectDir, '.claude', 'settings.json'), 'utf8')).toBe(before.claudeSettings)

      // No leftover *.compare-bak-* siblings in the project root.
      const entries = readdirSync(projectDir)
      const leftoverBackups = ['graphify-out', '.mcp.json', 'CLAUDE.md', '.claude'].filter((target) =>
        entries.some((entry) => entry.startsWith(`${target}.compare-bak-`)),
      )
      expect(leftoverBackups).toEqual([])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('absent graphify-out files at start mean the baseline run sees an unmodified absent state', async () => {
    // When CLAUDE.md / .mcp.json / .claude don't exist, snapshot is a no-op for them
    // and they should still be absent after the run.
    mkdirSync(FIXTURE_PARENT, { recursive: true })
    mkdirSync(COMPARE_OUTPUT_PARENT, { recursive: true })
    const projectDir = mkdtempSync(join(FIXTURE_PARENT, 'bare-'))
    const outputDir = mkdtempSync(join(COMPARE_OUTPUT_PARENT, 'bare-out-'))
    mkdirSync(join(projectDir, 'graphify-out'), { recursive: true })
    writeFileSync(
      join(projectDir, 'graphify-out', 'graph.json'),
      JSON.stringify({ nodes: [], edges: [], hyperedges: [] }),
      'utf8',
    )
    try {
      await executeNativeAgentCompare(
        {
          graphPath: join(projectDir, 'graphify-out', 'graph.json'),
          question: 'bare project',
          outputDir,
          execTemplate: 'mock-runner',
          baselineMode: 'native_agent',
        },
        {
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, graphify: GRAPHIFY_USAGE_PAYLOAD }),
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

  it('keeps graphify-out/compare/<ts> writable during the baseline run (snapshot does not hide the output dir)', async () => {
    const { projectDir, graphPath, outputDir } = makeFixtureProject()
    try {
      // The runner deliberately probes the prompt-file path during the baseline run.
      // If the snapshot renamed graphify-out/ wholesale, the path would be missing
      // and the runner would have observed it. The runner returns whether each call
      // saw the file present.
      const probeResults: Array<{ mode: CompareRunMode; promptFileExists: boolean }> = []
      const probingRunner: NativeAgentRunner = async (input) => {
        probeResults.push({ mode: input.mode, promptFileExists: existsSync(input.promptFile) })
        const payload = input.mode === 'baseline' ? BASELINE_USAGE_PAYLOAD : GRAPHIFY_USAGE_PAYLOAD
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
          runner: scriptedRunner({ baseline: BASELINE_USAGE_PAYLOAD, graphify: GRAPHIFY_USAGE_PAYLOAD }),
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
      expect(report.graphify.kind).toBe('answer_only')
      expect(report.reductions).toBeNull()
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
