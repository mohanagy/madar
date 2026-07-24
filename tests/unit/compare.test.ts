import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  buildNativeAgentPrompt,
  executeNativeAgentCompare,
  expandCompareExecTemplate,
  parseAnthropicResultEvent,
  type NativeAgentRunner,
} from '../../src/infrastructure/compare.js'
import { generateIndex } from '../../src/application/generate-index.js'

const roots: string[] = []
const originalCwd = process.cwd()

afterEach(() => {
  process.chdir(originalCwd)
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(): { graphPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'madar-compare-'))
  roots.push(root)
  const source = join(root, 'src')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, 'compare-fixture.ts'),
    'export function compareFixture(): string { return "ready" }\n',
    'utf8',
  )
  process.chdir(root)
  return { graphPath: generateIndex(root).graphPath, root }
}

function resultEvent(inputTokens: number, result = 'answer'): Record<string, unknown> {
  return {
    type: 'result',
    model: 'claude-test',
    num_turns: 2,
    duration_ms: 20,
    total_cost_usd: 0.01,
    result,
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 5,
    },
  }
}

function verboseStdout(
  tools: string[],
  inputTokens: number,
  result = 'answer',
): string {
  const assistant = {
    type: 'assistant',
    message: {
      content: tools.map((name) => ({ type: 'tool_use', name, input: {} })),
    },
  }
  return `${JSON.stringify(assistant)}\n${JSON.stringify(resultEvent(inputTokens, result))}\n`
}

function runnerFor(options: {
  baselineTools?: string[]
  madarTools?: string[]
} = {}): NativeAgentRunner {
  return async (input) => ({
    exitCode: 0,
    stdout:
      input.mode === 'baseline'
        ? verboseStdout(options.baselineTools ?? [], 100, 'baseline')
        : verboseStdout(
            options.madarTools ?? ['mcp__madar__retrieve'],
            50,
            'madar',
          ),
    stderr: '',
  })
}

describe('compare command contract', () => {
  it('expands only the supported placeholders with shell escaping', () => {
    expect(
      expandCompareExecTemplate(
        'runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}',
        {
          promptFile: '/tmp/a prompt.txt',
          question: 'where is auth?',
          mode: 'madar',
          outputFile: '/tmp/answer.txt',
        },
        'linux',
      ),
    ).toBe(
      "runner --prompt '/tmp/a prompt.txt' --question 'where is auth?' --mode 'madar' --out '/tmp/answer.txt'",
    )
  })

  it('rejects unknown placeholders and prompt-file command substitution', async () => {
    expect(() =>
      expandCompareExecTemplate('runner {legacy_mode}', {
        promptFile: 'prompt.txt',
        question: 'question',
        mode: 'madar',
        outputFile: 'answer.txt',
      }),
    ).toThrow('Unknown compare exec placeholder')

    const { graphPath } = fixture()
    await expect(
      executeNativeAgentCompare({
        graphPath,
        question: 'question',
        outputDir: 'out/compare',
        execTemplate: 'runner $(cat {prompt_file})',
      }),
    ).rejects.toThrow('must not expand {prompt_file}')
  })

  it('writes a single-retrieve native prompt with no legacy controls', () => {
    const prompt = buildNativeAgentPrompt('Trace login')
    expect(prompt).toContain('call the Madar `retrieve` tool exactly once')
    expect(prompt).toContain('Pass exactly the question below')
    expect(prompt).not.toMatch(/context_pack|profile|session|strategy/)
  })

  it('accepts only an attributable Madar-first retrieve run as valid', async () => {
    const { graphPath } = fixture()
    const result = await executeNativeAgentCompare(
      {
        graphPath,
        question: 'Trace login',
        outputDir: 'out/compare',
        execTemplate: 'runner {prompt_file}',
      },
      { runner: runnerFor() },
    )
    const report = result.report

    expect(report.attribution_status).toBe('verified')
    expect(existsSync(join(result.output_root, 'report.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(result.output_root, 'report.json'), 'utf8'))).not.toHaveProperty(
      'exec_command',
    )
  })

  it('fails attribution when repository exploration precedes retrieve', async () => {
    const { graphPath } = fixture()
    const result = await executeNativeAgentCompare(
      {
        graphPath,
        question: 'Trace login',
        outputDir: 'out/compare',
        execTemplate: 'runner {prompt_file}',
      },
      { runner: runnerFor({ madarTools: ['Read', 'mcp__madar__retrieve'] }) },
    )
    expect(result.report).toMatchObject({
      attribution_status: 'violated',
    })
  })

  it.each([
    {
      label: 'baseline invokes Madar',
      baselineTools: ['mcp__madar__retrieve'],
      madarTools: ['mcp__madar__retrieve'],
    },
    {
      label: 'Madar invokes retrieve twice',
      baselineTools: [],
      madarTools: ['mcp__madar__retrieve', 'mcp__madar__retrieve'],
    },
  ])('fails attribution when $label', async ({ baselineTools, madarTools }) => {
    const { graphPath } = fixture()
    const result = await executeNativeAgentCompare(
      {
        graphPath,
        question: 'Trace login',
        outputDir: 'out/compare',
        execTemplate: 'runner {prompt_file}',
      },
      { runner: runnerFor({ baselineTools, madarTools }) },
    )
    expect(result.report.attribution_status).toBe('violated')
  })

  it('terminates a stuck arm and records a timeout', async () => {
    const { graphPath } = fixture()
    const runner: NativeAgentRunner = async (input) => {
      if (input.mode === 'baseline') {
        return {
          exitCode: 0,
          stdout: verboseStdout([], 100),
          stderr: '',
        }
      }
      return await new Promise((resolve) => {
        input.signal?.addEventListener(
          'abort',
          () =>
            resolve({
              exitCode: 1,
              stdout: '',
              stderr: 'aborted',
            }),
          { once: true },
        )
      })
    }
    const result = await executeNativeAgentCompare(
      {
        graphPath,
        question: 'Trace login',
        outputDir: 'out/compare',
        execTemplate: 'runner {prompt_file}',
        perArmTimeoutSeconds: 0.01,
      },
      { runner },
    )
    expect(result.report.madar).toMatchObject({
      kind: 'runner_error',
      timed_out: true,
    })
  })
})

describe('Anthropic result parsing', () => {
  it('parses a single result object', () => {
    expect(parseAnthropicResultEvent(JSON.stringify(resultEvent(10)))).toMatchObject({
      total_input_tokens: 10,
      duration_ms: 20,
    })
  })

  it('uses the trailing result from stream JSON', () => {
    const stdout = `${JSON.stringify({ type: 'assistant' })}\n${JSON.stringify(resultEvent(12))}\n`
    expect(parseAnthropicResultEvent(stdout)?.total_input_tokens).toBe(12)
  })

  it('uses the trailing result from a JSON array', () => {
    const stdout = JSON.stringify([
      resultEvent(5, 'first'),
      resultEvent(15, 'last'),
    ])
    expect(parseAnthropicResultEvent(stdout)?.result).toBe('last')
  })

  it('rejects non-JSON output', () => {
    expect(parseAnthropicResultEvent('not json')).toBeNull()
  })

  it('rejects result records without input-token usage', () => {
    expect(
      parseAnthropicResultEvent(
        JSON.stringify({
          ...resultEvent(1),
          usage: {},
        }),
      ),
    ).toBeNull()
  })
})
