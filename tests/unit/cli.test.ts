import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  type CliDependencies,
  executeCli,
  formatHelp,
} from '../../src/cli/main.js'
import { parseQueryArgs, UsageError } from '../../src/cli/parser.js'
import type { RetrieveContextResult } from '../../src/domain/query/types.js'

const RESULT: RetrieveContextResult = {
  schema: 'madar.retrieve',
  version: 1,
  outcome: 'missing',
  matched_nodes: [],
  relationships: [],
  boundaries: [{ kind: 'missing', subject: 'where is auth?' }],
  metrics: {
    selected_files: 0,
    snippets: 0,
    closure_passes: 0,
    serialized_tokens: 64,
    truncated: false,
  },
}

function createIo() {
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    io: {
      log(message?: string) {
        logs.push(String(message ?? ''))
      },
      error(message?: string) {
        errors.push(String(message ?? ''))
      },
    },
  }
}

function createDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  return {
    notifyUpdate: () => null,
    loadGraph: vi.fn(() => ({ graph: true })),
    inspectQueryIndex: vi.fn(() => ({ state: 'unavailable', subject: 'test graph' })),
    retrieveContext: vi.fn(() => RESULT),
    ...overrides,
  } as unknown as CliDependencies
}

describe('query CLI parser', () => {
  it('accepts a question with only optional budget and graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-query-parser-'))
    const graphPath = join(root, 'out', 'graph.json')
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(graphPath, '{}\n', 'utf8')

    try {
      expect(parseQueryArgs(['where is auth?'])).toEqual({
        question: 'where is auth?',
        graphPath: 'out/graph.json',
      })
      expect(parseQueryArgs([
        '  where is auth?  ',
        '--budget=768',
        '--graph',
        graphPath,
      ])).toEqual({
        question: 'where is auth?',
        budget: 768,
        graphPath: realpathSync(graphPath),
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects missing, malformed, extra, and retired query arguments', () => {
    expect(() => parseQueryArgs([])).toThrow(UsageError)
    expect(() => parseQueryArgs(['question', '--budget', '0'])).toThrow(
      '--budget must be a positive integer',
    )
    expect(() => parseQueryArgs(['question', 'second question'])).toThrow(
      'unknown option for query',
    )

    for (const argument of [
      '--profile',
      '--semantic',
      '--rerank',
      '--task',
      '--verbose',
      '--retrieval-strategy',
    ]) {
      expect(() => parseQueryArgs(['question', argument])).toThrow(
        `unknown option for query: ${argument}`,
      )
    }
  })
})

describe('CLI delivery surface', () => {
  it('documents query as the canonical evidence command', () => {
    const help = formatHelp()

    expect(help).toContain('query "<question>"')
    expect(help).toContain('--budget N')
    expect(help).toContain('--graph PATH')
    expect(help).toContain('serve the single retrieve tool over MCP stdio')
    for (const removed of [
      '  pack ',
      '  prompt ',
      '  handoff ',
      '  proof-report ',
      '  review-compare ',
      '  time-travel ',
    ]) {
      expect(help).not.toContain(removed)
    }
  })

  it('passes only question and optional budget into the query core', async () => {
    const { io, logs } = createIo()
    const retrieveContext = vi.fn(() => RESULT)
    const loadGraph = vi.fn(() => ({ graph: true }))
    const index = { state: 'unavailable', subject: 'test graph' } as const
    const inspectQueryIndex = vi.fn(() => index)
    const dependencies = createDependencies({
      loadGraph: loadGraph as unknown as CliDependencies['loadGraph'],
      inspectQueryIndex,
      retrieveContext,
    })

    await expect(
      executeCli(
        ['query', 'where is auth?', '--budget', '512'],
        io,
        dependencies,
      ),
    ).resolves.toBe(0)

    expect(loadGraph).toHaveBeenCalledWith('out/graph.json')
    expect(inspectQueryIndex).toHaveBeenCalledWith({ graph: true })
    expect(retrieveContext).toHaveBeenCalledWith(index, {
      question: 'where is auth?',
      budget: 512,
    })
    expect(JSON.parse(logs[0] ?? '')).toEqual(RESULT)
  })

  it('prints help and returns controlled usage errors', async () => {
    const helpIo = createIo()
    await expect(
      executeCli([], helpIo.io, createDependencies()),
    ).resolves.toBe(0)
    expect(helpIo.logs[0]).toContain('Usage: madar <command>')

    const invalidIo = createIo()
    await expect(
      executeCli(['query'], invalidIo.io, createDependencies()),
    ).resolves.toBe(2)
    expect(invalidIo.errors).toEqual([
      'Usage: madar query "<question>" [--budget N] [--graph path]',
    ])

    const unknownIo = createIo()
    await expect(
      executeCli(['removed-command'], unknownIo.io, createDependencies()),
    ).resolves.toBe(1)
    expect(unknownIo.errors).toEqual([
      "error: unknown command 'removed-command'",
      "Run 'madar --help' for usage.",
    ])
  })
})
