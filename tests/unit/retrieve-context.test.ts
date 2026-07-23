import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../src/application/retrieve-context.js'
import {
  inspectQueryIndex,
  type QueryIndex,
  type ReadyQueryIndex,
} from '../../src/domain/query/index-status.js'
import { sliceEvidence } from '../../src/domain/query/slice.js'
import type { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'

const roots: string[] = []

function sandbox(name = 'workspace'): string {
  const root = mkdtempSync(join(tmpdir(), `madar-retrieve-${name}-`))
  roots.push(root)
  return root
}

function write(root: string, path: string, contents: string): string {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
  return absolute
}

function indexedWorkspace(root: string): { graph: KnowledgeGraph; index: ReadyQueryIndex } {
  const generated = generateIndex(root)
  const graph = loadGraphArtifact(generated.graphPath)
  const index = inspectQueryIndex(graph)
  if (index.state !== 'ready') {
    throw new Error(`Expected a ready query index, received ${index.state}: ${index.subject}`)
  }
  return { graph, index }
}

function readyIndex(root: string): ReadyQueryIndex {
  return indexedWorkspace(root).index
}

interface FlowFixture {
  root: string
  source: Record<string, string>
  graph: KnowledgeGraph
  index: ReadyQueryIndex
}

function flowFixture(): FlowFixture {
  const root = sandbox('flow')
  const source = {
    'src/flow-001/entry-local-00.ts': [
      "import { processLocal01 } from './process-local-01.js'",
      '',
      'export function entryLocal00(value: string): string {',
      '  return processLocal01(value)',
      '}',
    ].join('\n'),
    'src/flow-001/process-local-01.ts': [
      "import { storageLocal02 } from './storage-local-02.js'",
      '',
      'export function processLocal01(value: string): string {',
      '  return storageLocal02(value.trim())',
      '}',
    ].join('\n'),
    'src/flow-001/storage-local-02.js': [
      'export function storageLocal02(value) {',
      "  return `${value}:stored`",
      '}',
    ].join('\n'),
  }
  for (const [path, contents] of Object.entries(source)) write(root, path, `${contents}\n`)
  write(root, 'src/checker/checker.go', 'package checker\n')
  write(root, 'src/tinybird/client.go', 'package tinybird\n')
  write(root, 'package.json', '{"type":"module"}\n')
  write(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      allowJs: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
    },
  }))
  return { root, source, ...indexedWorkspace(root) }
}

function structuredQuestion(flow: string, phases: readonly string[]): string {
  return `Trace calls in ${flow} from ${phases.join(' through ')}.`
}

function authFlowFixture(): FlowFixture {
  const root = sandbox('auth-flow')
  const source = {
    'src/auth/auth-route.ts': [
      "import { authService } from './auth-service.js'",
      '',
      'export function authRoute(value: string): string {',
      '  return authService(value)',
      '}',
    ].join('\n'),
    'src/auth/auth-service.ts': [
      "import { authRepository } from './auth-repository.js'",
      '',
      'export function authService(value: string): string {',
      '  return authRepository(value)',
      '}',
    ].join('\n'),
    'src/auth/auth-repository.ts': [
      'export function authRepository(value: string): string {',
      '  return value',
      '}',
    ].join('\n'),
  }
  for (const [path, contents] of Object.entries(source)) write(root, path, `${contents}\n`)
  write(root, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
    },
  }))
  return { root, source, ...indexedWorkspace(root) }
}

function writeDisconnectedFlow(
  root: string,
  flow: string,
  entries: readonly { phase: string; ordinal: string; file: string }[],
): string {
  for (const entry of entries) {
    write(root, `src/${flow}/${entry.file}`, [
      `export function ${entry.phase}Local${entry.ordinal}(): string {`,
      `  return '${entry.phase}:${entry.ordinal}'`,
      '}',
      '',
    ].join('\n'))
  }
  write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
  return structuredQuestion(
    flow,
    entries.map((entry) => `${entry.phase} local ${entry.ordinal}`),
  )
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('retrieve context', () => {
  it('returns exact authenticated excerpts and directed typed paths deterministically', () => {
    const fixture = flowFixture()
    const question = structuredQuestion('flow-001', [
      'entry local 00',
      'process local 01',
      'storage local 02',
    ])

    const first = retrieveContext(fixture.index, { question })
    const second = retrieveContext(fixture.index, { question })

    expect(first.outcome).toBe('evidence')
    expect(first.boundaries).toEqual([])
    expect(first.metrics).toMatchObject({
      selected_files: 3,
      snippets: 3,
      closure_passes: 1,
      truncated: false,
    })
    expect(first.metrics.serialized_tokens).toBeLessThanOrEqual(4000)
    expect(Object.fromEntries(first.matched_nodes.map((node) => [
      node.source_file,
      node.snippet,
    ]))).toEqual({
      'src/flow-001/entry-local-00.ts': [
        'export function entryLocal00(value: string): string {',
        '  return processLocal01(value)',
        '}',
      ].join('\n'),
      'src/flow-001/process-local-01.ts': [
        'export function processLocal01(value: string): string {',
        '  return storageLocal02(value.trim())',
        '}',
      ].join('\n'),
      'src/flow-001/storage-local-02.js': fixture.source['src/flow-001/storage-local-02.js'],
    })

    const nodesById = new Map(first.matched_nodes.map((node) => [node.node_id, node]))
    const directedRelationships = first.relationships.map((relationship) => ({
      from: nodesById.get(relationship.from_id)?.source_file,
      relation: relationship.relation,
      to: nodesById.get(relationship.to_id)?.source_file,
    }))
    expect(directedRelationships).toHaveLength(2)
    expect(directedRelationships).toEqual(expect.arrayContaining([
      {
        from: 'src/flow-001/entry-local-00.ts',
        relation: 'calls',
        to: 'src/flow-001/process-local-01.ts',
      },
      {
        from: 'src/flow-001/process-local-01.ts',
        relation: 'calls',
        to: 'src/flow-001/storage-local-02.js',
      },
    ]))
    expect(new Set(first.matched_nodes.map((node) => node.node_id)).size)
      .toBe(first.matched_nodes.length)
    expect(new Set(first.relationships.map((relationship) => relationship.id)).size)
      .toBe(first.relationships.length)
    expect(serializeRetrieveContextResult(second)).toBe(serializeRetrieveContextResult(first))
  })

  it('returns a directed evidence path for a broad natural flow question', () => {
    const fixture = authFlowFixture()

    const result = retrieveContext(fixture.index, {
      question: 'Trace the auth flow.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label).sort()).toEqual([
      'authRepository()',
      'authRoute()',
      'authService()',
    ])
    expect(result.relationships.map((relationship) => relationship.relation)).toEqual([
      'calls',
      'calls',
    ])
    expect(result.boundaries).toEqual([])
    expect(result.metrics.closure_passes).toBe(1)
  })

  it('normalizes derivational suffixes without a domain vocabulary', () => {
    const root = sandbox('phase-morphology')
    write(root, 'src/lifecycle/migrate-record.ts', [
      "import { assignRecord } from './assign-record.js'",
      '',
      'export function migrateRecord(): string {',
      '  return assignRecord()',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/lifecycle/assign-record.ts', [
      "import { recoverRecord } from './recover-record.js'",
      '',
      'export function assignRecord(): string {',
      '  return recoverRecord()',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/lifecycle/recover-record.ts', [
      'export function recoverRecord(): string {',
      "  return 'done'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace record migration through assignment and recovery.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.source_file).sort()).toEqual([
      'src/lifecycle/assign-record.ts',
      'src/lifecycle/migrate-record.ts',
      'src/lifecycle/recover-record.ts',
    ])
    expect(result.relationships.map((relationship) => relationship.relation)).toEqual([
      'calls',
      'calls',
    ])
    expect(result.boundaries).toEqual([])
  })

  it('keeps repository nouns that can also appear in answer instructions', () => {
    const root = sandbox('repository-noun')
    write(root, 'src/order.ts', 'export function Order(): string { return "ready" }\n')
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), { question: 'What is order?' })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label)).toContain('Order()')
  })

  it('does not treat ordinary hyphenated prose as an exact identifier', () => {
    const root = sandbox('hyphenated-prose')
    write(root, 'src/delivery.ts', [
      'export function deliverNotification(): string {',
      "  return 'sent'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'How is at-least-once delivery implemented?',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label)).toContain('deliverNotification()')
    expect(result.boundaries).not.toContainEqual({ kind: 'missing', subject: 'at-least-once' })
  })

  it('ranks production concepts ahead of requested-output and test-file noise', () => {
    const root = sandbox('instruction-noise')
    write(root, 'src/workflow/hydrate-session.ts', [
      "import { validateSession } from './validate-session.js'",
      '',
      'export function hydrateSession(): string {',
      '  return validateSession()',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/workflow/validate-session.ts', [
      'export function validateSession(): string {',
      "  return 'valid'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tests/session-output-format.test.ts', [
      'export function sessionExactFileSymbols(): string {',
      "  return 'test-only'",
      '}',
      '',
    ].join('\n'))
    write(root, 'assets/exact-files-symbols-evidence.png', 'not an image decoder fixture\n')
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: [
        'Trace session hydration through validation.',
        'Cite exact files and symbols for every phase, preserve causal order,',
        'and identify any missing evidence.',
      ].join(' '),
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.source_file).sort()).toEqual([
      'src/workflow/hydrate-session.ts',
      'src/workflow/validate-session.ts',
    ])
    expect(result.relationships.map((relationship) => relationship.relation)).toEqual(['calls'])
    expect(result.boundaries).toEqual([])
  })

  it('retains test-domain evidence when the question explicitly asks for tests', () => {
    const root = sandbox('requested-tests')
    write(root, 'src/auth-flow.ts', [
      'export function authFlow(): string {',
      "  return 'production'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tests/auth-flow.test.ts', [
      'export function testAuthFlow(): string {',
      "  return 'verified'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Which test verifies the auth flow?',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.source_file))
      .toEqual(['tests/auth-flow.test.ts'])
    expect(result.boundaries).toEqual([])
  })

  it('does not report media files as unsupported code evidence', () => {
    const root = sandbox('unsupported-media')
    write(root, 'src/public/status-page.ts', [
      'export function publicStatusPage(): string {',
      "  return 'ready'",
      '}',
      '',
    ].join('\n'))
    write(root, 'assets/public-status-page.png', 'binary placeholder\n')
    write(root, 'docs/public-status-page.md', '# Public status page\n')
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Explain the public status-page implementation.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.source_file))
      .toEqual(['src/public/status-page.ts'])
    expect(result.boundaries).toEqual([])
  })

  it('reports a connected lexical frontier omitted by the anchor cap', () => {
    const root = sandbox('broad-anchor-cap')
    for (let index = 0; index < 15; index += 1) {
      const ordinal = String(index).padStart(2, '0')
      const next = String(index + 1).padStart(2, '0')
      write(root, `src/auth/auth-node-${ordinal}.ts`, [
        ...(index < 14 ? [`import { authNode${next} } from './auth-node-${next}.js'`, ''] : []),
        `export function authNode${ordinal}(): string {`,
        index < 14 ? `  return authNode${next}()` : "  return 'done'",
        '}',
        '',
      ].join('\n'))
    }
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace the auth flow.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.metrics.selected_files).toBe(12)
    expect(result.boundaries).toContainEqual({
      kind: 'truncated',
      subject: 'query anchors',
    })
  })

  it('uses an exact symbol as a seed without excluding downstream query phases', () => {
    const fixture = authFlowFixture()

    const result = retrieveContext(fixture.index, {
      question: 'Trace `authRoute` through the auth service and repository.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label).sort()).toEqual([
      'authRepository()',
      'authRoute()',
      'authService()',
    ])
    expect(result.relationships).toHaveLength(2)
    expect(result.boundaries).toEqual([])
  })

  it('preserves disconnected anchors and reports the missing directed handoff', () => {
    const root = sandbox('disconnected')
    const question = writeDisconnectedFlow(root, 'flow-002', [
      { phase: 'alpha', ordinal: '00', file: 'alpha-local-00.ts' },
      { phase: 'beta', ordinal: '01', file: 'beta-local-01.ts' },
    ])

    const result = retrieveContext(readyIndex(root), { question })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes).toHaveLength(2)
    expect(result.relationships).toEqual([])
    expect(result.boundaries).toEqual([
      expect.objectContaining({ kind: 'disconnected' }),
    ])
    expect(result.metrics.closure_passes).toBe(1)
  })

  it('binds each structured locator to its nearest explicit scope', () => {
    const root = sandbox('multiple-scopes')
    write(root, 'src/flow-021/route-local-00.ts', [
      'export function routeLocal00(): string {',
      "  return 'route:00'",
      '}',
      '',
    ].join('\n'))
    write(root, 'src/flow-022/service-local-01.ts', [
      'export function serviceLocal01(): string {',
      "  return 'service:01'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace flow-021 route local 00 to flow-022 service local 01.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.source_file).sort()).toEqual([
      'src/flow-021/route-local-00.ts',
      'src/flow-022/service-local-01.ts',
    ])
    expect(result.boundaries).toEqual([
      expect.objectContaining({ kind: 'disconnected' }),
    ])
  })

  it('seals the inspected graph from later mutation', () => {
    const fixture = flowFixture()
    const before = retrieveContext(fixture.index, {
      question: structuredQuestion('flow-123', ['entry local 00']),
    })
    expect(before.outcome).toBe('missing')

    const source = fixture.graph.nodeEntries().find(([, attributes]) =>
      attributes.qualified_name === 'entryLocal00')
    if (!source) throw new Error('Canonical fixture did not index entryLocal00')
    fixture.graph.addNode('mutated-flow-123-entry', {
      ...source[1],
      label: 'flow-123 entry local 00',
      qualified_name: 'flow123EntryLocal00',
    })
    const exposed = fixture.index.graph as unknown as Record<string, unknown>
    expect(Object.isFrozen(fixture.index.graph)).toBe(true)
    expect(Object.keys(exposed)).not.toContain('nodeMap')
    expect(Object.keys(exposed)).not.toContain('edgeMap')
    expect(exposed.nodeMap).toBeUndefined()
    expect(exposed.edgeMap).toBeUndefined()
    expect(exposed.addNode).toBeUndefined()
    const returnedAttributes = fixture.index.graph.nodeAttributes(source[0])
    returnedAttributes.line_number = 1

    const after = retrieveContext(fixture.index, {
      question: structuredQuestion('flow-123', ['entry local 00']),
    })
    expect(after).toEqual(before)
  })

  it('returns one exact missing boundary for an absent explicit subject', () => {
    const fixture = flowFixture()

    const result = retrieveContext(fixture.index, {
      question: 'Which evidence path implements flow-999?',
    })

    expect(result).toMatchObject({
      outcome: 'missing',
      matched_nodes: [],
      relationships: [],
      boundaries: [{ kind: 'missing', subject: 'flow-999' }],
    })
  })

  it('does not turn ordinary word-number terminology into a mandatory scope', () => {
    const root = sandbox('technical-term')
    write(root, 'src/hash.ts', [
      'export function computeSourceHash(value: string): string {',
      '  return value',
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const index = readyIndex(root)

    const result = retrieveContext(index, {
      question: 'How does SHA-256 source hash computation work?',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.source_file)).toEqual(['src/hash.ts'])
    expect(result.boundaries).toEqual([])
  })

  it('keeps present scoped evidence beside an exact missing boundary', () => {
    const root = sandbox('mixed-scopes')
    write(root, 'src/hash.ts', [
      'export function computeSourceHash(value: string): string {',
      '  return value',
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Compare `computeSourceHash` with `missingHasher`.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label)).toEqual(['computeSourceHash()'])
    expect(result.boundaries).toEqual([{ kind: 'missing', subject: 'missingHasher' }])
  })

  it('keeps unscoped supported evidence beside an exact missing boundary', () => {
    const root = sandbox('missing-and-unscoped')
    write(root, 'src/hash.ts', [
      'export function computeSourceHash(value: string): string {',
      '  return value',
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Compare `missingHasher` with source hash computation.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label)).toEqual(['computeSourceHash()'])
    expect(result.boundaries).toEqual([{ kind: 'missing', subject: 'missingHasher' }])
  })

  it('reports a canonical file-only exact path as unavailable, not corrupt', () => {
    const root = sandbox('file-only')
    write(root, 'src/setup.ts', "import 'node:fs'\n")
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Explain src/setup.ts.',
    })

    expect(result).toMatchObject({
      outcome: 'unavailable',
      matched_nodes: [],
      relationships: [],
      boundaries: [{ kind: 'unavailable', subject: 'src/setup.ts' }],
    })
  })

  it('reports a bounded traversal as truncated instead of disconnected', () => {
    const root = sandbox('bounded-traversal')
    for (let index = 0; index < 10; index += 1) {
      const ordinal = String(index).padStart(2, '0')
      const next = String(index + 1).padStart(2, '0')
      write(root, `src/flow-030/node-local-${ordinal}.ts`, [
        ...(index < 9 ? [`import { nodeLocal${next} } from './node-local-${next}.js'`, ''] : []),
        `export function nodeLocal${ordinal}(): string {`,
        index < 9 ? `  return nodeLocal${next}()` : "  return 'done'",
        '}',
        '',
      ].join('\n'))
    }
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace flow-030 node local 00 to node local 09.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.relationships).toEqual([])
    expect(result.boundaries).toEqual([
      expect.objectContaining({ kind: 'truncated' }),
    ])
  })

  it('preserves every direct phase anchor when a causal path exceeds the file cap', () => {
    const root = sandbox('anchor-cap')
    for (let index = 0; index < 15; index += 1) {
      const ordinal = String(index).padStart(2, '0')
      const nextOrdinal = String(index + 1).padStart(2, '0')
      const phase = index === 0 ? 'start' : index === 7 ? 'middle' : index === 14 ? 'finish' : 'step'
      const nextPhase = index + 1 === 7
        ? 'middle'
        : index + 1 === 14
          ? 'finish'
          : 'step'
      write(root, `src/chain/${phase}-local-${ordinal}.ts`, [
        ...(index < 14
          ? [`import { ${nextPhase}Local${nextOrdinal} } from './${nextPhase}-local-${nextOrdinal}.js'`, '']
          : []),
        `export function ${phase}Local${ordinal}(): string {`,
        index < 14 ? `  return ${nextPhase}Local${nextOrdinal}()` : "  return 'done'",
        '}',
        '',
      ].join('\n'))
    }
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace `startLocal00` through `middleLocal07` to `finishLocal14`.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.metrics.selected_files).toBe(12)
    expect(result.metrics.truncated).toBe(true)
    expect(result.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      'startLocal00()',
      'middleLocal07()',
      'finishLocal14()',
    ]))
    expect(result.boundaries).toContainEqual(expect.objectContaining({ kind: 'truncated' }))
  })

  it('preserves identical authenticated excerpts at distinct graph locations', () => {
    const root = sandbox('identical-snippets')
    const source = [
      'export function handle(): string {',
      "  return 'same'",
      '}',
      '',
    ].join('\n')
    write(root, 'src/left/handler.ts', source)
    write(root, 'src/right/handler.ts', source)
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Compare src/left/handler.ts with src/right/handler.ts.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes).toHaveLength(2)
    expect(result.matched_nodes.every((node) => node.snippet === source.trimEnd())).toBe(true)
  })

  it('reports recognized unsupported sources without claiming graph evidence', () => {
    const fixture = flowFixture()

    const result = retrieveContext(fixture.index, {
      question: 'How does the Go checker call the Tinybird client?',
    })

    expect(result.outcome).toBe('unsupported')
    expect(result.matched_nodes).toEqual([])
    expect(result.relationships).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'unsupported', subject: 'src/checker/checker.go' },
      { kind: 'unsupported', subject: 'src/tinybird/client.go' },
    ])
  })

  it('reports when the unsupported-source boundary cap omits recognized files', () => {
    const root = sandbox('unsupported-cap')
    for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) {
      write(root, `src/${name}.go`, `package ${name}\n`)
    }
    write(root, 'src/index.ts', 'export const ready = true\n')
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Compare alpha, bravo, charlie, delta, and echo Go sources.',
    })

    expect(result.outcome).toBe('unsupported')
    expect(result.boundaries.filter((boundary) => boundary.kind === 'unsupported'))
      .toHaveLength(4)
    expect(result.boundaries).toContainEqual({
      kind: 'truncated',
      subject: 'unsupported sources',
    })
    expect(result.metrics.truncated).toBe(true)
  })

  it('omits stale excerpts when the complete source hash changes', () => {
    const fixture = flowFixture()
    write(
      fixture.root,
      'src/flow-001/entry-local-00.ts',
      'export function entryLocal00(): string { return "changed" }\n',
    )

    const result = retrieveContext(fixture.index, {
      question: structuredQuestion('flow-001', ['entry local 00']),
    })

    expect(result.outcome).toBe('stale')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'stale', subject: 'src/flow-001/entry-local-00.ts' },
    ])
  })

  it('reports unavailable excerpts when an authenticated source disappears', () => {
    const fixture = flowFixture()
    unlinkSync(join(fixture.root, 'src/flow-001/entry-local-00.ts'))

    const result = retrieveContext(fixture.index, {
      question: structuredQuestion('flow-001', ['entry local 00']),
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'unavailable', subject: 'src/flow-001/entry-local-00.ts' },
    ])
  })

  it('rejects a graph-selected source that escapes the authenticated root', () => {
    const fixture = flowFixture()
    const outsideRoot = sandbox('outside')
    const outside = write(outsideRoot, 'escape.ts', [
      'export function escapeLocal00(): string {',
      "  return 'outside'",
      '}',
      '',
    ].join('\n'))
    const entry = fixture.graph.nodeEntries().find(([, attributes]) =>
      attributes.qualified_name === 'entryLocal00')
    if (!entry) throw new Error('Canonical fixture did not index entryLocal00')
    const [nodeId, attributes] = entry
    fixture.graph.replaceNodeAttributes(nodeId, {
      ...attributes,
      label: 'flow-003 escape local 00',
      qualified_name: 'escapeLocal00',
      source_file: outside,
      source_location: 'L1-L3',
      line_number: 1,
      end_line_number: 3,
    })
    const escapedIndex: ReadyQueryIndex = {
      ...fixture.index,
      graph: fixture.graph,
      file_hashes: new Map([
        ...fixture.index.file_hashes,
        [outside, createHash('sha256').update(readFileSync(outside)).digest('hex')],
      ]),
    }

    const result = retrieveContext(escapedIndex, {
      question: structuredQuestion('flow-003', ['escape local 00']),
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'unavailable', subject: outside },
    ])
  })

  it('classifies an authenticated symbol with an invalid graph range as stale', () => {
    const root = sandbox('invalid-range')
    write(root, 'src/range.ts', [
      'export function invalidRange(): string {',
      "  return 'value'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const indexed = indexedWorkspace(root)
    const graph = indexed.graph
    const entry = graph.nodeEntries().find(([, attributes]) =>
      attributes.qualified_name === 'invalidRange')
    if (!entry) throw new Error('Canonical fixture did not index invalidRange')
    graph.replaceNodeAttributes(entry[0], {
      ...entry[1],
      end_line_number: 999,
    })

    const result = retrieveContext({ ...indexed.index, graph }, {
      question: 'Explain `invalidRange`.',
    })

    expect(result.outcome).toBe('stale')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'stale', subject: 'src/range.ts' },
    ])
  })

  it.each([
    ['CRLF', '\r\n'],
    ['bare CR', '\r'],
    ['Unicode line separator', '\u2028'],
    ['Unicode paragraph separator', '\u2029'],
  ])('authenticates TypeScript graph ranges across %s terminators', (_name, terminator) => {
    const root = sandbox('ecmascript-lines')
    const source = [
      'const before = 1;',
      'export function lineTarget(): number {',
      '  return 1',
      '}',
      '',
    ].join(terminator)
    write(root, 'src/lines.ts', source)
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Explain `lineTarget`.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.boundaries).toEqual([])
    expect(result.matched_nodes).toHaveLength(1)
    expect(result.matched_nodes[0]).toMatchObject({
      source_file: 'src/lines.ts',
      line_number: 2,
      end_line_number: 4,
      snippet: [
        'export function lineTarget(): number {',
        '  return 1',
        '}',
      ].join(terminator),
    })
  })

  it('classifies malformed symbol provenance as corrupt instead of missing', () => {
    const root = sandbox('malformed-provenance')
    write(root, 'src/provenance.ts', [
      'export function malformedProvenance(): string {',
      "  return 'value'",
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const indexed = indexedWorkspace(root)
    const graph = indexed.graph
    const entry = graph.nodeEntries().find(([, attributes]) =>
      attributes.qualified_name === 'malformedProvenance')
    if (!entry) throw new Error('Canonical fixture did not index malformedProvenance')
    graph.replaceNodeAttributes(entry[0], {
      ...entry[1],
      provenance: [],
    })

    const result = retrieveContext({ ...indexed.index, graph }, {
      question: 'Explain `malformedProvenance`.',
    })

    expect(result.outcome).toBe('corrupt')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'corrupt', subject: entry[0] },
    ])
  })

  it('returns a corrupt boundary for an unauthenticated canonical index', () => {
    const fixture = flowFixture()
    fixture.graph.graph.canonical_typescript_index = false
    const corrupt: QueryIndex = inspectQueryIndex(fixture.graph)

    expect(corrupt.state).toBe('corrupt')
    expect(retrieveContext(corrupt, { question: 'trace entry' })).toMatchObject({
      outcome: 'corrupt',
      matched_nodes: [],
      relationships: [],
      boundaries: [{ kind: 'corrupt', subject: 'canonical TypeScript index metadata' }],
    })
  })

  it('enforces the snippet and file caps with one truncation boundary', () => {
    const phases = [
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
      'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
      'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'amber', 'cedar',
    ]

    const snippetRoot = sandbox('snippet-cap')
    write(snippetRoot, 'src/flow-010/all-phases.ts', phases.flatMap((phase, index) => {
      const ordinal = String(index).padStart(2, '0')
      return [
        `export function ${phase}Local${ordinal}(): string {`,
        `  return '${phase}:${ordinal}'`,
        '}',
        '',
      ]
    }).join('\n'))
    write(snippetRoot, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const snippetQuestion = structuredQuestion(
      'flow-010',
      phases.map((phase, index) =>
        `${phase} local ${String(index).padStart(2, '0')}`),
    )
    const snippetResult = retrieveContext(readyIndex(snippetRoot), {
      question: snippetQuestion,
    })

    expect(snippetResult.metrics.snippets).toBeLessThanOrEqual(25)
    expect(snippetResult.boundaries.filter((boundary) => boundary.kind === 'truncated'))
      .toHaveLength(1)

    const fileRoot = sandbox('file-cap')
    const fileQuestion = writeDisconnectedFlow(
      fileRoot,
      'flow-011',
      phases.slice(0, 13).map((phase, index) => ({
        phase,
        ordinal: String(index).padStart(2, '0'),
        file: `${phase}-local-${String(index).padStart(2, '0')}.ts`,
      })),
    )
    const fileResult = retrieveContext(readyIndex(fileRoot), { question: fileQuestion })

    expect(fileResult.metrics.selected_files).toBeLessThanOrEqual(12)
    expect(fileResult.boundaries.filter((boundary) => boundary.kind === 'truncated'))
      .toHaveLength(1)
  })

  it('keeps the canonical result within a small budget by omitting whole facts', () => {
    const fixture = flowFixture()
    const result = retrieveContext(fixture.index, {
      question: structuredQuestion('flow-001', [
        'entry local 00',
        'process local 01',
        'storage local 02',
      ]),
      budget: 256,
    })

    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(256)
    expect(result.metrics.truncated).toBe(true)
    expect(result.boundaries).toContainEqual(expect.objectContaining({ kind: 'truncated' }))
    const selectedNodeIds = new Set(result.matched_nodes.map((node) => node.node_id))
    expect(result.relationships.every((relationship) =>
      selectedNodeIds.has(relationship.from_id) && selectedNodeIds.has(relationship.to_id))).toBe(true)
  })

  it('keeps fitting priority evidence ahead of verbose diagnostics under budget', () => {
    const node = {
      node_id: 'priority',
      label: 'priority()',
      node_kind: 'function',
      source_file: 'src/priority.ts',
      source_location: 'L1',
      line_number: 1,
      end_line_number: 1,
      source_domain: 'production',
      provenance: [{}],
      content_hash: 'a'.repeat(64),
      snippet: 'export function priority() {}',
    }
    const result = sliceEvidence({
      request: { question: 'priority', budget: 400 },
      outcome: 'evidence',
      matchedNodes: [node],
      relationships: [],
      boundaries: Array.from({ length: 10 }, (_, index) => ({
        kind: 'disconnected' as const,
        subject: `phase-${index}`,
        detail: `long diagnostic ${String(index).repeat(120)}`,
      })),
      priorityNodeIds: [node.node_id],
      closurePasses: 1,
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes).toEqual([node])
    expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(400)
    expect(result.metrics.truncated).toBe(true)
  })

  it('does not share mutable truncation facts between identical requests', () => {
    const fixture = flowFixture()
    const input = {
      question: structuredQuestion('flow-001', [
        'entry local 00',
        'process local 01',
        'storage local 02',
      ]),
      budget: 256,
    }
    const first = retrieveContext(fixture.index, input)
    const original = serializeRetrieveContextResult(first)
    const truncated = first.boundaries.find((candidate) => candidate.kind === 'truncated')
    if (!truncated) throw new Error('Expected a truncated boundary')
    truncated.detail = 'caller mutation'

    const second = retrieveContext(fixture.index, input)

    expect(serializeRetrieveContextResult(second)).toBe(original)
  })

  it('rejects every input key except required question and optional budget', () => {
    const fixture = flowFixture()

    expect(() => retrieveContext(fixture.index, {
      question: 'trace entry',
      semantic: true,
    })).toThrow('retrieve accepts only question and optional budget')
    expect(() => retrieveContext(fixture.index, { budget: 4000 }))
      .toThrow('retrieve question must be a non-empty string')
    expect(retrieveContext(fixture.index, { question: 'trace entry', budget: 1 }).metrics.serialized_tokens)
      .toBeLessThanOrEqual(256)
    expect(retrieveContext(fixture.index, { question: 'trace entry', budget: 20_000 }).metrics.serialized_tokens)
      .toBeLessThanOrEqual(4000)
  })
})
