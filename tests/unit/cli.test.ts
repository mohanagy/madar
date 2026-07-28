import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { generateIndex } from '../../src/application/generate-index.js'
import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../src/application/retrieve-context.js'
import {
  executeCli,
  parseGenerateArgs,
  parseInstallArgs,
  parseQueryArgs,
  type CliIO,
  UsageError,
} from '../../src/adapters/cli/main.js'
import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { inspectQueryIndex } from '../../src/domain/query/index-status.js'

const MAIN_SOURCE = readFileSync(
  new URL('../../src/adapters/cli/main.ts', import.meta.url),
  'utf8',
)
const BIN_SOURCE = readFileSync(
  new URL('../../src/adapters/cli/bin.ts', import.meta.url),
  'utf8',
)

const ALLOWED_COMMANDS = [
  'generate',
  'query',
  'status',
  'doctor',
  'install',
  'mcp',
] as const

const RETIRED_COMMANDS = [
  'watch',
  'serve',
  'try',
  'benchmark',
  'bench:suite',
  'eval',
  'compare',
  'hook',
  'telemetry',
  'aider',
  'claude',
  'cursor',
  'gemini',
  'copilot',
  'codex',
  'opencode',
  'claw',
  'droid',
  'trae',
  'trae-cn',
] as const

function recordingIo(): {
  io: CliIO
  logs: string[]
  errors: string[]
  writes: string[]
} {
  const logs: string[] = []
  const errors: string[] = []
  const writes: string[] = []
  return {
    logs,
    errors,
    writes,
    io: {
      log(message) {
        logs.push(String(message ?? ''))
      },
      error(message) {
        errors.push(String(message ?? ''))
      },
      write(message) {
        writes.push(message)
      },
    },
  }
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('thin CLI command boundary', () => {
  it('dispatches exactly the six accepted command names', () => {
    const cases = [...MAIN_SOURCE.matchAll(/case '([^']+)'/g)]
      .map((match) => match[1])

    expect(cases).toEqual(ALLOWED_COMMANDS)
  })

  it.each(RETIRED_COMMANDS)('rejects retired command %s without an alias', async (command) => {
    await expect(executeCli(
      [command],
      recordingIo().io,
      { version: () => 'test', cwd: process.cwd() },
    )).rejects.toThrow(`Unknown command "${command}"`)
  })

  it('does not treat an implicit path as generate', async () => {
    await expect(executeCli(
      ['.'],
      recordingIo().io,
      { version: () => 'test', cwd: process.cwd() },
    )).rejects.toThrow('Unknown command "."')
  })

  it('keeps long global options in the lightweight bin only', async () => {
    expect(BIN_SOURCE).toContain("argv[0] === '--help'")
    expect(BIN_SOURCE).toContain("argv[0] === '--version'")
    expect(BIN_SOURCE.indexOf("argv[0] === '--help'"))
      .toBeLessThan(BIN_SOURCE.indexOf("await import('./main.js')"))
    expect(BIN_SOURCE.indexOf("argv[0] === '--version'"))
      .toBeLessThan(BIN_SOURCE.indexOf("await import('./main.js')"))

    for (const option of ['--help', '--version']) {
      await expect(executeCli(
        [option],
        recordingIo().io,
        { version: () => 'test', cwd: process.cwd() },
      )).rejects.toThrow(UsageError)
    }
  })

  it.each(['--stdio', '--mcp', '--auto-refresh'])(
    'rejects retired MCP transport flag %s',
    async (flag) => {
      await expect(executeCli(
        ['mcp', flag],
        recordingIo().io,
        { version: () => 'test', cwd: process.cwd() },
      )).rejects.toThrow('Usage: madar mcp')
    },
  )

  it.each([
    '--neo4j-push',
    '--neo4j-user',
    '--neo4j-password',
    '--neo4j-database',
  ])('rejects retired generation flag %s', (flag) => {
    expect(() => parseGenerateArgs([`${flag}=retired`]))
      .toThrow(`unknown option for generate: ${flag}=retired`)
  })
})

describe('thin CLI parsers', () => {
  it('parses only the retained generate options', () => {
    expect(parseGenerateArgs([])).toEqual({
      path: '.',
      update: false,
      watch: false,
      debounceSeconds: 3,
      strictIndexing: false,
      maxIndexingFailed: 0,
      maxIndexingUnsupported: 0,
    })
    expect(parseGenerateArgs([
      'src',
      '--update',
      '--watch',
      '--follow-symlinks',
      '--respect-gitignore',
      '--strict-indexing',
      '--debounce=0.5',
      '--max-indexing-failed',
      '2',
      '--max-indexing-unsupported=3',
    ])).toEqual({
      path: 'src',
      update: true,
      watch: true,
      followSymlinks: true,
      respectGitignore: true,
      debounceSeconds: 0.5,
      strictIndexing: true,
      maxIndexingFailed: 2,
      maxIndexingUnsupported: 3,
    })
  })

  it.each([
    { args: ['one', 'two'] },
    { args: ['--debounce', '-1'] },
    { args: ['--max-indexing-failed=1.5'] },
    { args: ['--max-indexing-unsupported', '-1'] },
    { args: ['--legacy'] },
    { args: ['--spi'] },
    { args: ['--include-docs'] },
  ])('rejects invalid generate boundary $args', ({ args }) => {
    expect(() => parseGenerateArgs(args)).toThrow(UsageError)
  })

  it('parses a single query plus split or equals options', () => {
    expect(parseQueryArgs(['  where is auth?  '])).toEqual({
      question: 'where is auth?',
      graphPath: 'out/graph.json',
    })
    expect(parseQueryArgs([
      'where is auth?',
      '--graph=custom.json',
      '--budget',
      '512',
    ])).toEqual({
      question: 'where is auth?',
      graphPath: 'custom.json',
      budget: 512,
    })
  })

  it.each([
    { args: [] },
    { args: [' '] },
    { args: ['one', 'two'] },
    { args: ['question', '--budget=0'] },
    { args: ['question', '--budget=1.5'] },
    { args: ['question', '--graph'] },
    { args: ['question', '--semantic'] },
    { args: ['question', '--rerank'] },
  ])('rejects invalid query boundary $args', ({ args }) => {
    expect(() => parseQueryArgs(args)).toThrow(UsageError)
  })

  it('accepts only Claude and Codex install targets with one uninstall flag', () => {
    expect(parseInstallArgs(['claude'])).toEqual({
      platform: 'claude',
      uninstall: false,
    })
    expect(parseInstallArgs(['codex', '--uninstall'])).toEqual({
      platform: 'codex',
      uninstall: true,
    })
    for (const args of [
      [],
      ['cursor'],
      ['claude', 'install'],
      ['codex', '--uninstall', '--uninstall'],
    ]) {
      expect(() => parseInstallArgs(args)).toThrow(UsageError)
    }
  })

  it.each([
    { argv: ['status', '--unknown'] },
    { argv: ['doctor', 'one.json', 'two.json'] },
    { argv: ['install', 'claude', '--legacy'] },
  ])('rejects invalid command-local arguments before loading implementation: $argv', async ({ argv }) => {
    await expect(executeCli(
      argv,
      recordingIo().io,
      { version: () => 'test', cwd: process.cwd() },
    )).rejects.toThrow(UsageError)
  })
})

describe('thin CLI composition', () => {
  it('has no eager production imports and keeps each implementation command-local', () => {
    expect(MAIN_SOURCE.match(/^import (?!type\b)/gm)).toBeNull()

    const expectedDynamicImports = [
      '../../application/generate-index.js',
      '../../application/update-index.js',
      '../../infrastructure/watch-index.js',
      '../filesystem/graph-artifact.js',
      '../../application/retrieve-context.js',
      '../../domain/query/index-status.js',
      '../../shared/workspace.js',
      './doctor.js',
      './install.js',
      '../mcp/server.js',
    ]
    for (const modulePath of expectedDynamicImports) {
      expect(MAIN_SOURCE).toContain(`import('${modulePath}')`)
    }
    expect(MAIN_SOURCE).not.toContain("from '../../src/cli/")
    expect(MAIN_SOURCE).not.toContain("import('../../infrastructure/benchmark")
  })

  it('writes byte-identical canonical query output with no presentation wrapper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-thin-cli-'))
    temporaryRoots.push(root)
    writeFileSync(
      join(root, 'auth.ts'),
      [
        'export function authenticate(token: string): boolean {',
        "  return token.trim() === 'accepted'",
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    const generated = generateIndex(root)
    const question = 'Where is authenticate implemented?'
    const expected = serializeRetrieveContextResult(retrieveContext(
      inspectQueryIndex(loadGraphArtifact(generated.graphPath)),
      { question, budget: 512 },
    ))
    const output = recordingIo()

    await expect(executeCli(
      ['query', question, '--graph', generated.graphPath, '--budget=512'],
      output.io,
      { version: () => 'test', cwd: root },
    )).resolves.toBe(0)

    expect(output.writes).toEqual([expected])
    expect(output.logs).toEqual([])
    expect(output.errors).toEqual([])
    expect(Buffer.from(output.writes[0] ?? ''))
      .toEqual(Buffer.from(expected))
  })
})
