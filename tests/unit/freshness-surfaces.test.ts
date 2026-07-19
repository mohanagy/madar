import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runContextPackCommand } from '../../src/infrastructure/context-pack-command.js'
import { runContextPromptCommand } from '../../src/infrastructure/context-prompt-command.js'
import { runDoctorCommand, runStatusCommand } from '../../src/infrastructure/doctor.js'
import { generateGraph } from '../../src/infrastructure/generate.js'
import { runHandoffCommand } from '../../src/infrastructure/handoff-command.js'
import { handleStdioRequest } from '../../src/runtime/stdio-server.js'

const sandboxRoots: string[] = []
const PACKAGE_VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
const OUT_GRAPH_PATH_PATTERN = /[\\/]out[\\/]graph\.json$/
const OUT_MISSING_GRAPH_PATH_PATTERN = /[\\/]out[\\/]missing\.json$/

type FixtureState = 'fresh' | 'modified' | 'unrelated_modified' | 'deleted' | 'shared_modified'

interface FreshnessFixture {
  root: string
  graphPath: string
  generatedAt: string
}

interface GitFreshnessFixture {
  root: string
  graphPath: string
  authPath: string
  sessionPath: string
  paymentPath: string
  routesPath: string
  sourceTime: Date
}

type AnalyzeGraphContextFreshness = (
  graphPath: string,
  graph?: unknown,
  selection?: { selected_source_files?: readonly string[] },
) => Record<string, unknown>

afterEach(() => {
  while (sandboxRoots.length > 0) {
    const root = sandboxRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

function createFreshnessFixture(state: FixtureState): FreshnessFixture {
  const root = mkdtempSync(join(tmpdir(), 'madar-freshness-'))
  sandboxRoots.push(root)

  const authPath = join(root, 'src', 'auth.ts')
  const sessionPath = join(root, 'src', 'session.ts')
  const paymentPath = join(root, 'src', 'payment.ts')
  const routesPath = join(root, 'src', 'routes.ts')
  const graphPath = join(root, 'out', 'graph.json')
  const graphTime = new Date('2024-01-01T00:00:00.000Z')
  const sourceTime = new Date('2023-12-31T23:59:00.000Z')
  const modifiedTime = new Date('2024-01-01T00:04:00.000Z')

  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(
    authPath,
    [
      'export function AuthService() {',
      '  return issueSession()',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    sessionPath,
    [
      'export function issueSession() {',
      '  return "ok"',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    paymentPath,
    [
      'export function chargeCard() {',
      '  return "charged"',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  if (state === 'shared_modified') {
    writeFileSync(
      routesPath,
      [
        'export function registerAuthRoute() {',
        '  return AuthService()',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
  }

  writeFileSync(
    graphPath,
    JSON.stringify({
      directed: true,
      root_path: root,
      community_labels: {
        '0': 'Auth runtime',
      },
      nodes: [
        ...(state === 'shared_modified'
          ? [{
            id: 'routes',
            label: 'registerAuthRoute',
            source_file: 'src/routes.ts',
            source_location: 'L1-L3',
            file_type: 'code',
            node_kind: 'function',
            community: 0,
          }]
          : []),
        {
          id: 'auth',
          label: 'AuthService',
          source_file: 'src/auth.ts',
          source_location: 'L1-L3',
          file_type: 'code',
          node_kind: 'function',
          community: 0,
        },
        {
          id: 'session',
          label: 'issueSession',
          source_file: 'src/session.ts',
          source_location: 'L1-L3',
          file_type: 'code',
          node_kind: 'function',
          community: 0,
        },
        {
          id: 'payment',
          label: 'chargeCard',
          source_file: 'src/payment.ts',
          source_location: 'L1-L3',
          file_type: 'code',
          node_kind: 'function',
          community: 0,
        },
      ],
      edges: [
        ...(state === 'shared_modified'
          ? [{
            source: 'routes',
            target: 'auth',
            relation: 'calls',
            confidence: 'EXTRACTED',
            source_file: 'src/routes.ts',
          }]
          : []),
        {
          source: 'auth',
          target: 'session',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: 'src/auth.ts',
        },
      ],
      hyperedges: [],
    }),
    'utf8',
  )

  utimesSync(authPath, sourceTime, sourceTime)
  utimesSync(sessionPath, sourceTime, sourceTime)
  utimesSync(paymentPath, sourceTime, sourceTime)
  if (state === 'shared_modified') {
    utimesSync(routesPath, sourceTime, sourceTime)
  }
  utimesSync(graphPath, graphTime, graphTime)

  if (state === 'modified') {
    utimesSync(authPath, modifiedTime, modifiedTime)
  }

  if (state === 'unrelated_modified') {
    utimesSync(paymentPath, modifiedTime, modifiedTime)
  }

  if (state === 'deleted') {
    rmSync(authPath)
  }

  if (state === 'shared_modified') {
    utimesSync(routesPath, modifiedTime, modifiedTime)
  }

  return {
    root,
    graphPath,
    generatedAt: graphTime.toISOString(),
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()
}

function setFileContentPreservingMtime(path: string, content: string, sourceTime: Date): void {
  writeFileSync(path, content, 'utf8')
  utimesSync(path, sourceTime, sourceTime)
}

function createGitFreshnessFixture(options: {
  buildDirtyFile?: 'auth'
  authRelativePath?: string
} = {}): GitFreshnessFixture {
  const root = mkdtempSync(join(tmpdir(), 'madar-git-freshness-'))
  sandboxRoots.push(root)

  const authPath = join(root, options.authRelativePath ?? 'src/auth.ts')
  const sessionPath = join(root, 'src', 'session.ts')
  const paymentPath = join(root, 'src', 'payment.ts')
  const routesPath = join(root, 'src', 'routes.ts')
  const sourceTime = new Date('2024-01-01T00:00:00.000Z')

  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(
    authPath,
    [
      'export function AuthService() {',
      '  return issueSession()',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    sessionPath,
    [
      'export function issueSession() {',
      '  return "ok"',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    paymentPath,
    [
      'export function chargeCard() {',
      '  return "charged"',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    routesPath,
    [
      'export function registerAuthRoute() {',
      '  return AuthService()',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )

  git(root, ['init'])
  git(root, ['config', 'user.email', 'madar@example.com'])
  git(root, ['config', 'user.name', 'Madar Tests'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'initial'])

  for (const path of [authPath, sessionPath, paymentPath, routesPath]) {
    utimesSync(path, sourceTime, sourceTime)
  }

  if (options.buildDirtyFile === 'auth') {
    setFileContentPreservingMtime(
      authPath,
      [
        'export function AuthService() {',
        '  return issueSession().toUpperCase()',
        '}',
        '',
      ].join('\n'),
      sourceTime,
    )
  }

  const result = generateGraph(root)

  return {
    root,
    graphPath: result.graphPath,
    authPath,
    sessionPath,
    paymentPath,
    routesPath,
    sourceTime,
  }
}

async function withFullToolProfile<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.MADAR_TOOL_PROFILE
  process.env.MADAR_TOOL_PROFILE = 'full'
  try {
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env.MADAR_TOOL_PROFILE
    } else {
      process.env.MADAR_TOOL_PROFILE = previous
    }
  }
}

async function loadAnalyzeGraphContextFreshness(): Promise<AnalyzeGraphContextFreshness> {
  const freshnessRuntime = await import('../../src/runtime/freshness.js') as Record<string, unknown>
  const analyzeGraphContextFreshness = freshnessRuntime.analyzeGraphContextFreshness as AnalyzeGraphContextFreshness | undefined
  expect(analyzeGraphContextFreshness).toBeTypeOf('function')
  return analyzeGraphContextFreshness!
}

describe('freshness surfaces', () => {
  it('classifies fresh, modified, deleted, and missing graph states', async () => {
    const analyzeGraphContextFreshness = await loadAnalyzeGraphContextFreshness()

    const fresh = createFreshnessFixture('fresh')
    expect(analyzeGraphContextFreshness!(fresh.graphPath)).toEqual(expect.objectContaining({
      status: 'fresh',
      graph_path: expect.stringMatching(OUT_GRAPH_PATH_PATTERN),
      generated_at: fresh.generatedAt,
      madar_version: PACKAGE_VERSION.version,
      indexed_file_count: 3,
      changed_source_count: 0,
      missing_source_count: 0,
    }))

    const modified = createFreshnessFixture('modified')
    expect(analyzeGraphContextFreshness!(modified.graphPath)).toEqual(expect.objectContaining({
      status: 'partially_stale',
      selected_context_status: 'unknown',
      graph_path: expect.stringMatching(OUT_GRAPH_PATH_PATTERN),
      generated_at: modified.generatedAt,
      indexed_file_count: 3,
      changed_source_count: 1,
      changed_selected_context_count: 0,
      changed_outside_selected_context_count: 1,
      missing_source_count: 0,
      recommendation: expect.stringContaining('madar generate .'),
    }))

    const deleted = createFreshnessFixture('deleted')
    expect(analyzeGraphContextFreshness!(deleted.graphPath)).toEqual(expect.objectContaining({
      status: 'stale',
      graph_path: expect.stringMatching(OUT_GRAPH_PATH_PATTERN),
      indexed_file_count: 3,
      changed_source_count: 0,
      missing_source_count: 1,
      recommendation: expect.stringContaining('madar generate .'),
    }))

    expect(analyzeGraphContextFreshness!(join(deleted.root, 'out', 'missing.json'))).toEqual(expect.objectContaining({
      status: 'missing',
      graph_path: expect.stringMatching(OUT_MISSING_GRAPH_PATH_PATTERN),
      generated_at: null,
      indexed_file_count: 0,
      changed_source_count: 0,
      missing_source_count: 0,
      recommendation: expect.stringContaining('madar generate .'),
    }))
  })

  it('tracks selected-context drift from git dirty files even when source mtimes stay older than the graph', async () => {
    const analyzeGraphContextFreshness = await loadAnalyzeGraphContextFreshness()

    const fixture = createGitFreshnessFixture()
    setFileContentPreservingMtime(
      fixture.authPath,
      [
        'export function AuthService() {',
        '  return issueSession() + "-stale"',
        '}',
        '',
      ].join('\n'),
      fixture.sourceTime,
    )

    expect(analyzeGraphContextFreshness!(fixture.graphPath, undefined, {
      selected_source_files: [fixture.authPath, fixture.sessionPath],
    })).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      changed_source_count: 1,
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
    }))
  })

  it('tracks git dirty files whose paths include spaces', async () => {
    const analyzeGraphContextFreshness = await loadAnalyzeGraphContextFreshness()

    const fixture = createGitFreshnessFixture({ authRelativePath: 'src/auth service.ts' })
    setFileContentPreservingMtime(
      fixture.authPath,
      [
        'export function AuthService() {',
        '  return issueSession() + "-spaced"',
        '}',
        '',
      ].join('\n'),
      fixture.sourceTime,
    )

    expect(analyzeGraphContextFreshness!(fixture.graphPath, undefined, {
      selected_source_files: [fixture.authPath, fixture.sessionPath],
    })).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      changed_source_count: 1,
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
    }))
  })

  it('keeps a code graph fresh when agent-install instruction files are added after generation', async () => {
    const analyzeGraphContextFreshness = await loadAnalyzeGraphContextFreshness()
    const fixture = createGitFreshnessFixture()

    writeFileSync(join(fixture.root, 'AGENTS.md'), '## madar\n\nGenerated agent guidance.\n', 'utf8')
    writeFileSync(join(fixture.root, 'CLAUDE.md'), '## madar\n\nGenerated agent guidance.\n', 'utf8')

    expect(analyzeGraphContextFreshness!(fixture.graphPath)).toEqual(expect.objectContaining({
      status: 'fresh',
      changed_source_count: 0,
      missing_source_count: 0,
    }))
  })

  it('tracks unrelated git dirty files outside the selected context even when source mtimes stay older than the graph', async () => {
    const analyzeGraphContextFreshness = await loadAnalyzeGraphContextFreshness()

    const fixture = createGitFreshnessFixture()
    setFileContentPreservingMtime(
      fixture.paymentPath,
      [
        'export function chargeCard() {',
        '  return "charged-again"',
        '}',
        '',
      ].join('\n'),
      fixture.sourceTime,
    )

    expect(analyzeGraphContextFreshness!(fixture.graphPath, undefined, {
      selected_source_files: [fixture.authPath, fixture.sessionPath],
    })).toEqual(expect.objectContaining({
      status: 'partially_stale',
      selected_context_status: 'fresh',
      changed_source_count: 1,
      changed_selected_context_count: 0,
      changed_outside_selected_context_count: 1,
    }))
  })

  it('tracks git commit drift after build even when committed file mtimes stay older than the graph', async () => {
    const analyzeGraphContextFreshness = await loadAnalyzeGraphContextFreshness()

    const fixture = createGitFreshnessFixture()
    setFileContentPreservingMtime(
      fixture.paymentPath,
      [
        'export function chargeCard() {',
        '  return "committed-change"',
        '}',
        '',
      ].join('\n'),
      fixture.sourceTime,
    )
    git(fixture.root, ['add', 'src/payment.ts'])
    git(fixture.root, ['commit', '-m', 'update payment'])

    expect(analyzeGraphContextFreshness!(fixture.graphPath, undefined, {
      selected_source_files: [fixture.authPath, fixture.sessionPath],
    })).toEqual(expect.objectContaining({
      status: 'partially_stale',
      selected_context_status: 'fresh',
      changed_source_count: 1,
      changed_selected_context_count: 0,
      changed_outside_selected_context_count: 1,
    }))
  })

  it('tracks additional edits to a file that was already dirty when the graph was built', async () => {
    const analyzeGraphContextFreshness = await loadAnalyzeGraphContextFreshness()

    const fixture = createGitFreshnessFixture({ buildDirtyFile: 'auth' })
    setFileContentPreservingMtime(
      fixture.authPath,
      [
        'export function AuthService() {',
        '  return issueSession().toUpperCase() + "-again"',
        '}',
        '',
      ].join('\n'),
      fixture.sourceTime,
    )

    expect(analyzeGraphContextFreshness!(fixture.graphPath, undefined, {
      selected_source_files: [fixture.authPath, fixture.sessionPath],
    })).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      changed_source_count: 1,
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
    }))
  })

  it('exposes graph freshness in pack, prompt, handoff, and MCP context_pack outputs', async () => {
    const fixture = createFreshnessFixture('modified')

    const packJson = JSON.parse(await runContextPackCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      format: 'json',
      verbose: true,
    })) as {
      governance?: {
        graph_freshness?: Record<string, unknown>
      }
    }
    const packText = await runContextPackCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      format: 'text',
      verbose: true,
    })
    const promptJson = JSON.parse(await runContextPromptCommand({
      prompt: 'How does AuthService reach issueSession?',
      provider: 'claude',
      graphPath: fixture.graphPath,
    })) as {
      graph_freshness?: Record<string, unknown>
    }
    const handoffJson = JSON.parse(await runHandoffCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      consumer: 'generic',
    })) as {
      governance?: {
        graph_freshness?: Record<string, unknown>
      }
    }
    const mcpResponse = await withFullToolProfile(async () => await Promise.resolve(handleStdioRequest(fixture.graphPath, {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'How does AuthService reach issueSession?',
          budget: 500,
          task: 'explain',
          verbose: true,
        },
      },
    })))
    const mcpPayload = JSON.parse(((mcpResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? '') as {
      governance?: {
        graph_freshness?: Record<string, unknown>
      }
    }

    expect(packJson.governance?.graph_freshness).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      generated_at: fixture.generatedAt,
      madar_version: PACKAGE_VERSION.version,
      indexed_file_count: 3,
      changed_source_count: 1,
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
      missing_source_count: 0,
      recommendation: expect.stringContaining('madar generate .'),
    }))
    expect(packText).toContain('Graph freshness: possibly stale')
    expect(packText).toContain('Selected context: possibly stale')
    expect(packText).not.toContain('Graph source:')
    expect(packText).toContain('Changed since graph: 1 source file')
    expect(packText).toContain('Changed relevant to selected context: 1 source file')
    expect(packText).toContain('Recommended: Run `madar generate .`')

    expect(promptJson.graph_freshness).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      graph_path: expect.stringMatching(OUT_GRAPH_PATH_PATTERN),
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
      changed_source_count: 1,
      missing_source_count: 0,
    }))
    expect(handoffJson.governance?.graph_freshness).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
      changed_source_count: 1,
      missing_source_count: 0,
    }))
    expect(mcpPayload.governance?.graph_freshness).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
      changed_source_count: 1,
      missing_source_count: 0,
    }))
  })

  it('reports partially_stale graph freshness but fresh selected context when only unrelated indexed files changed', async () => {
    const fixture = createFreshnessFixture('unrelated_modified')

    const packJson = JSON.parse(await runContextPackCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      format: 'json',
      verbose: true,
    })) as {
      governance?: {
        graph_freshness?: Record<string, unknown>
      }
    }
    const packText = await runContextPackCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      format: 'text',
      verbose: true,
    })

    expect(packJson.governance?.graph_freshness).toEqual(expect.objectContaining({
      status: 'partially_stale',
      selected_context_status: 'fresh',
      changed_source_count: 1,
      changed_selected_context_count: 0,
      changed_outside_selected_context_count: 1,
    }))
    expect(packText).toContain('Graph freshness: partially stale')
    expect(packText).toContain('Selected context: fresh')
    expect(packText).toContain('Changed outside selected context: 1 source file')
  })

  it('treats modified shared files on the selected route as selected-context drift', async () => {
    const fixture = createFreshnessFixture('shared_modified')

    const packJson = JSON.parse(await runContextPackCommand({
      prompt: 'How does registerAuthRoute reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      format: 'json',
      verbose: true,
    })) as {
      governance?: {
        graph_freshness?: Record<string, unknown>
      }
    }

    expect(packJson.governance?.graph_freshness).toEqual(expect.objectContaining({
      status: 'possibly_stale',
      selected_context_status: 'possibly_stale',
      indexed_file_count: 4,
      changed_source_count: 1,
      changed_selected_context_count: 1,
      changed_outside_selected_context_count: 0,
    }))
  })

  it('reports selected-context freshness in CLI and MCP context_prompt outputs', async () => {
    const fixture = createFreshnessFixture('unrelated_modified')

    const promptJson = JSON.parse(await runContextPromptCommand({
      prompt: 'How does AuthService reach issueSession?',
      provider: 'claude',
      graphPath: fixture.graphPath,
    })) as {
      graph_freshness?: Record<string, unknown>
    }
    const mcpPromptResponse = await withFullToolProfile(async () => await Promise.resolve(handleStdioRequest(fixture.graphPath, {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'context_prompt',
        arguments: {
          prompt: 'How does AuthService reach issueSession?',
          provider: 'claude',
        },
      },
    })))
    const mcpPromptPayload = JSON.parse(((mcpPromptResponse as { result?: { content?: Array<{ text: string }> } }).result?.content ?? [])[0]?.text ?? '') as {
      graph_freshness?: Record<string, unknown>
    }

    expect(promptJson.graph_freshness).toEqual(expect.objectContaining({
      status: 'partially_stale',
      selected_context_status: 'fresh',
      changed_source_count: 1,
      changed_selected_context_count: 0,
      changed_outside_selected_context_count: 1,
    }))
    expect(mcpPromptPayload.graph_freshness).toEqual(expect.objectContaining({
      status: 'partially_stale',
      selected_context_status: 'fresh',
      changed_source_count: 1,
      changed_selected_context_count: 0,
      changed_outside_selected_context_count: 1,
    }))
  })

  it('supports scoped strict freshness that rejects only selected-context drift', async () => {
    const unrelated = createFreshnessFixture('unrelated_modified')
    const unrelatedPack = JSON.parse(await runContextPackCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: unrelated.graphPath,
      format: 'json',
      requireFreshContext: true,
    } as never)) as {
      governance?: {
        graph_freshness?: Record<string, unknown>
      }
    }
    expect(unrelatedPack.governance?.graph_freshness).toEqual(expect.objectContaining({
      status: 'partially_stale',
      selected_context_status: 'fresh',
    }))

    const modified = createFreshnessFixture('modified')
    await expect(runContextPackCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: modified.graphPath,
      format: 'json',
      requireFreshContext: true,
    } as never)).rejects.toThrow(/selected context/i)

    await expect(runContextPromptCommand({
      prompt: 'How does AuthService reach issueSession?',
      provider: 'claude',
      graphPath: modified.graphPath,
      requireFreshContext: true,
    } as never)).rejects.toThrow(/selected context/i)

    await expect(runHandoffCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: modified.graphPath,
      consumer: 'generic',
      requireFreshContext: true,
    } as never)).rejects.toThrow(/selected context/i)

    const mcpPackResponse = await withFullToolProfile(async () => await Promise.resolve(handleStdioRequest(modified.graphPath, {
      id: 4,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'How does AuthService reach issueSession?',
          budget: 500,
          task: 'explain',
          require_fresh_context: true,
        },
      },
    })))
    expect((mcpPackResponse as { error?: { message?: string } }).error?.message).toMatch(/selected context/i)

    const mcpPromptResponse = await withFullToolProfile(async () => await Promise.resolve(handleStdioRequest(modified.graphPath, {
      id: 5,
      method: 'tools/call',
      params: {
        name: 'context_prompt',
        arguments: {
          prompt: 'How does AuthService reach issueSession?',
          provider: 'claude',
          require_fresh_context: true,
        },
      },
    })))
    expect((mcpPromptResponse as { error?: { message?: string } }).error?.message).toMatch(/selected context/i)
  })

  it('refuses non-fresh pack, prompt, handoff, and MCP context_pack output when strict freshness is required', async () => {
    const fixture = createFreshnessFixture('modified')

    await expect(runContextPackCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      format: 'json',
      verbose: true,
      requireFreshGraph: true,
    } as never)).rejects.toThrow(/partially_stale/)

    await expect(runContextPromptCommand({
      prompt: 'How does AuthService reach issueSession?',
      provider: 'claude',
      graphPath: fixture.graphPath,
      requireFreshGraph: true,
    } as never)).rejects.toThrow(/partially_stale/)

    await expect(runHandoffCommand({
      prompt: 'How does AuthService reach issueSession?',
      budget: 500,
      task: 'explain',
      graphPath: fixture.graphPath,
      consumer: 'generic',
      requireFreshGraph: true,
    } as never)).rejects.toThrow(/partially_stale/)

    const mcpResponse = await withFullToolProfile(async () => await Promise.resolve(handleStdioRequest(fixture.graphPath, {
      id: 2,
      method: 'tools/call',
      params: {
        name: 'context_pack',
        arguments: {
          prompt: 'How does AuthService reach issueSession?',
          budget: 500,
          task: 'explain',
          require_fresh_graph: true,
        },
      },
    })))

    expect((mcpResponse as { error?: { message?: string } }).error?.message).toMatch(/partially_stale/)

    const mcpPromptResponse = await withFullToolProfile(async () => await Promise.resolve(handleStdioRequest(fixture.graphPath, {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'context_prompt',
        arguments: {
          prompt: 'How does AuthService reach issueSession?',
          provider: 'claude',
          require_fresh_graph: true,
        },
      },
    })))
    expect((mcpPromptResponse as { error?: { message?: string } }).error?.message).toMatch(/partially_stale/)
  })

  it('reports the shared freshness model consistently in doctor and status', () => {
    const modified = createFreshnessFixture('modified')
    const deleted = createFreshnessFixture('deleted')
    const now = Date.parse('2024-01-01T00:05:00.000Z')

    const modifiedDoctor = runDoctorCommand({
      graphPath: modified.graphPath,
      projectDir: modified.root,
      now,
    })
    const modifiedStatus = runStatusCommand({
      graphPath: modified.graphPath,
      projectDir: modified.root,
      now,
    })
    const deletedDoctor = runDoctorCommand({
      graphPath: deleted.graphPath,
      projectDir: deleted.root,
      now,
    })
    const deletedStatus = runStatusCommand({
      graphPath: deleted.graphPath,
      projectDir: deleted.root,
      now,
    })

    expect(modifiedDoctor).toContain('graph freshness: partially stale')
    expect(modifiedDoctor).toContain('changed since graph: 1 source file')
    expect(modifiedStatus).toContain('graph partially_stale')
    expect(modifiedStatus).toContain('changed=1')

    expect(deletedDoctor).toContain('graph freshness: stale')
    expect(deletedDoctor).toContain('missing since graph: 1 source file')
    expect(deletedStatus).toContain('graph stale')
    expect(deletedStatus).toContain('missing=1')
  })
})
