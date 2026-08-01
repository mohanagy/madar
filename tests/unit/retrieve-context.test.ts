import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'
import { afterEach, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../src/application/retrieve-context.js'
import { inspectQueryIndex, type ReadyQueryIndex } from '../../src/domain/query/index-status.js'

const roots: string[] = []

function workspace(source: string): {
  root: string
  path: string
  source: string
  index: ReadyQueryIndex
} {
  const root = mkdtempSync(join(tmpdir(), 'madar-retrieve-v2-'))
  roots.push(root)
  const path = join(root, 'src/report.ts')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source, 'utf8')
  const generated = generateIndex(root)
  const index = inspectQueryIndex(loadGraphArtifact(generated.graphPath))
  if (index.state !== 'ready') {
    throw new Error(`Expected ready index, received ${index.state}: ${index.subject}`)
  }
  return { root, path, source, index }
}

function multiFileWorkspace(files: Readonly<Record<string, string>>): ReadyQueryIndex {
  const root = mkdtempSync(join(tmpdir(), 'madar-retrieve-v2-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source, 'utf8')
  }
  const generated = generateIndex(root)
  const index = inspectQueryIndex(loadGraphArtifact(generated.graphPath))
  if (index.state !== 'ready') {
    throw new Error(`Expected ready index, received ${index.state}: ${index.subject}`)
  }
  return index
}

function reportFlowFixture(): ReadyQueryIndex {
  const root = mkdtempSync(join(tmpdir(), 'madar-retrieve-flow-'))
  roots.push(root)
  cpSync(resolve(
    'tests/fixtures/pack-quality/runtime-generation-explain-report-flow/workspace',
  ), root, { recursive: true })
  const generated = generateIndex(root)
  const index = inspectQueryIndex(loadGraphArtifact(generated.graphPath))
  if (index.state !== 'ready') {
    throw new Error(`Expected ready index, received ${index.state}: ${index.subject}`)
  }
  return index
}

function reportSource(persist = true): string {
  return `import type { MongoRepository } from 'typeorm'

type ReportRow = { id: string; body: string }

export async function generateIdeaReport(
  repository: MongoRepository<ReportRow>,
  body: string,
): Promise<string> {
  return planIdeaReport(repository, body)
}

async function planIdeaReport(
  repository: MongoRepository<ReportRow>,
  body: string,
): Promise<string> {
  return assembleIdeaReport(repository, body.trim())
}

async function assembleIdeaReport(
  repository: MongoRepository<ReportRow>,
  body: string,
): Promise<string> {
  ${persist
    ? "await repository.update('report-1', { id: 'report-1', body })"
    : 'const unchanged = body'}
  return body
}
`
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('retrieveContext v2', () => {
  it('returns one deterministic, authenticated workflow dossier', () => {
    const fixture = workspace(reportSource())
    const input = {
      question: 'How is an idea report generated end to end?',
      budget: 4_000,
    }
    const first = retrieveContext(fixture.index, input)
    const second = retrieveContext(fixture.index, input)

    expect(second).toEqual(first)
    expect(first.schema).toBe('madar.retrieve')
    expect(first.version).toBe(2)
    expect(first.state).toBe('ready')
    expect(countTokens(serializeRetrieveContextResult(first)))
      .toBe(first.metrics.serialized_tokens)
    expect(first.metrics.serialized_tokens).toBeLessThanOrEqual(4_000)
    expect(first.metrics.selected_files).toBeLessThanOrEqual(12)
    expect(first.metrics.authenticated_excerpts).toBeLessThanOrEqual(25)
    expect(first.metrics.causal_hops).toBeLessThanOrEqual(24)
    if (first.state !== 'ready') return

    expect(first.dossier.obligations.map(({ kind }) => kind)).toEqual([
      'subject', 'entry', 'stage', 'handoff', 'behavior', 'ordering', 'terminal',
    ])
    expect(first.dossier.obligations.every((claim) => claim.proofs.length > 0)).toBe(true)
    expect(first.dossier.flow.links.map(({ kind }) => kind)).toEqual([
      'direct', 'direct',
    ])
    expect(first.dossier.flow.terminals).toHaveLength(1)
    expect(first.dossier.evidence.entities.some((entity) =>
      entity.kind === 'operation' && 'operation_kind' in entity
      && entity.operation_kind === 'persistence')).toBe(true)
    const declarations = first.dossier.evidence.entities.filter((entity) =>
      entity.kind === 'symbol' && entity.excerpt !== undefined)
    expect(declarations).toEqual([])
    const links = new Map(first.dossier.flow.links.map((link) => [link.id, link]))
    const incident = new Set(first.dossier.evidence.entities.flatMap((entity) =>
      entity.kind !== 'operation' ? [] : 'owner' in entity ? [entity.owner]
        : entity.links.map((id) => links.get(id)!.from)).concat(
      first.dossier.evidence.proofs.flatMap((proof) => [proof.from, proof.to]),
    ))
    expect(first.dossier.evidence.entities.filter((entity) =>
      entity.kind === 'symbol' && entity.excerpt === undefined)
      .every((entity) => incident.has(entity.id))).toBe(true)
    expect(serializeRetrieveContextResult(first))
      .toContain('"state":"ready"')
  })

  it('converges public report-flow paraphrases within the warm p95 gate', () => {
    const index = reportFlowFixture()
    const active = {
      question: 'How is an idea report generated? Explain the pipeline flow from request to final report.',
      budget: 4_000,
    }
    const passive = {
      question: 'How does the idea report get generated from the initial request through to the completed report?',
      budget: 4_000,
    }
    const named = {
      question: 'How does GoValidate generate an idea report end to end?',
      budget: 4_000,
    }
    const first = retrieveContext(index, active)
    const second = retrieveContext(index, passive)
    const third = retrieveContext(index, named)

    expect(first.state).toBe('ready')
    expect(second.state).toBe('ready')
    expect(third.state).toBe('ready')
    if (first.state !== 'ready' || second.state !== 'ready'
      || third.state !== 'ready') return
    expect(second.dossier.query.subject).toBe(first.dossier.query.subject)
    expect(second.dossier.flow).toEqual(first.dossier.flow)
    expect(second.dossier.evidence).toEqual(first.dossier.evidence)
    expect(third.dossier.query.subject).toBe(first.dossier.query.subject)
    expect(third.dossier.flow).toEqual(first.dossier.flow)
    expect(third.dossier.evidence).toEqual(first.dossier.evidence)

    const links = new Map(first.dossier.flow.links.map((link) => [link.id, link]))
    const proofRows = new Map(first.dossier.evidence.proofs.map((proof) => [proof.id, proof]))
    for (const link of first.dossier.flow.links) {
      const path = link.proofs.map((id) => proofRows.get(id)!)
      expect(path[0]?.from).toBe(link.from)
      expect(path.at(-1)?.to).toBe(link.to)
      path.slice(1).forEach((proof, index) => expect(path[index]!.to).toBe(proof.from))
      expect(path.map(({ relation }) => relation)).toEqual(link.kind === 'direct'
        ? ['calls'] : path.length === 2
          ? ['publishes_to', 'consumed_by']
          : ['publishes_to', 'routes_through', 'consumed_by'])
    }
    const behavior = first.dossier.obligations.find(({ kind }) => kind === 'behavior')!
    const behaviorProofs = new Set(behavior.proofs)
    const stages = new Set(first.dossier.flow.links.flatMap(({ from, to }) => [from, to]))
    for (const stage of stages) {
      const outgoing = first.dossier.evidence.proofs.some((proof) =>
        proof.from === stage && behaviorProofs.has(proof.id))
      const operation = first.dossier.evidence.entities.some((entity) =>
        entity.kind === 'operation' && behaviorProofs.has(entity.id)
        && ('owner' in entity ? entity.owner === stage
          : entity.links.some((id) => links.get(id)?.from === stage)))
      expect(outgoing || operation).toBe(true)
    }
    expect(first.dossier.evidence.entities).toContainEqual(expect.objectContaining({
      kind: 'operation', links: expect.any(Array), callee: 'enqueueJob',
      scheduling: 'awaited', excerpt: expect.any(String),
    }))

    for (let pass = 0; pass < 3; pass += 1) retrieveContext(index, active)
    const samples = Array.from({ length: 20 }, () => {
      const start = performance.now()
      const result = retrieveContext(index, active)
      expect(result.state).toBe('ready')
      return performance.now() - start
    }).sort((left, right) => left - right)
    expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThan(500)
  })

  it('keeps focused locators declaration-only', () => {
    const result = retrieveContext(workspace(reportSource()).index, {
      question: 'Where is generateIdeaReport defined?',
      budget: 2_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(result.dossier.flow.links).toEqual([])
    expect(result.dossier.evidence.entities.map(({ kind }) => kind))
      .toEqual(['symbol'])
    expect(result.dossier.evidence.entities[0]).toMatchObject({
      kind: 'symbol',
      label: 'generateIdeaReport()',
      excerpt: expect.any(String),
    })
  })

  it('proves writes from body evidence and does not invent unsupported reads', () => {
    const index = workspace([
      'export const retryCount = 0',
      'export function updateMetrics(state: { retryCount: number }) {',
      '  state.retryCount = state.retryCount + 1',
      '}',
      'export function readMetrics(state: { retryCount: number }) {',
      '  return state.retryCount',
      '}',
      '',
    ].join('\n')).index
    const write = retrieveContext(index, {
      question: 'What updates retryCount?', budget: 2_000,
    })

    expect(write.state).toBe('ready')
    if (write.state !== 'ready') return
    expect(write.dossier.evidence.entities).toContainEqual(expect.objectContaining({
      kind: 'symbol', label: 'updateMetrics()',
    }))
    const mutation = write.dossier.evidence.entities.find((entity) =>
      entity.kind === 'operation' && 'operation_kind' in entity
      && entity.operation_kind === 'mutation')
    expect(mutation).toEqual(expect.objectContaining({
      kind: 'operation', owner: expect.any(String), excerpt: expect.any(String),
      detail: expect.objectContaining({ target: 'state . retryCount' }),
    }))
    expect(write.dossier.obligations[0]?.proofs).toContain(mutation?.id)

    const read = retrieveContext(index, {
      question: 'What reads retryCount?', budget: 2_000,
    })
    expect(read.state).toBe('incomplete')
    if (read.state === 'incomplete') {
      expect(read.missing).toContainEqual(expect.objectContaining({
        code: 'subject_unproven',
      }))
    }

    const unrelated = retrieveContext(workspace([
      'export function updateRetryCount(state: { status: string }) {',
      "  state.status = 'done'",
      '}',
      '',
    ].join('\n')).index, {
      question: 'What updates retryCount?', budget: 2_000,
    })
    expect(unrelated.state).toBe('incomplete')
    if (unrelated.state === 'incomplete') {
      expect(unrelated.missing).toContainEqual(expect.objectContaining({
        code: 'subject_unproven',
      }))
    }
  })

  it('keeps the backing call for an emitted persistence fact', () => {
    const index = workspace([
      "import { writeFile } from 'node:fs/promises'",
      'export async function validateIdeaReport(approved: boolean) {',
      "  if (approved) await writeFile('report.txt', 'ok')",
      '}',
      '',
    ].join('\n')).index

    const result = retrieveContext(index, {
      question: 'Explain how validateIdeaReport behaves', budget: 4_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    const persistence = result.dossier.evidence.entities.find((entity) =>
      entity.kind === 'operation' && 'operation_kind' in entity
      && entity.operation_kind === 'persistence')
    expect(persistence).toMatchObject({
      kind: 'operation',
      detail: { call: expect.any(String) },
    })
    expect(() => serializeRetrieveContextResult(result)).not.toThrow()
  })

  it('declares only the proven explain subject and proof-binds its call target', () => {
    const index = multiFileWorkspace({
      'repository.ts': 'export function saveOrder(id: string) { return id }\n',
      'service.ts': [
        "import { saveOrder } from './repository.js'",
        'export function submitOrder(id: string) { return saveOrder(id) }',
        '',
      ].join('\n'),
    })
    const result = retrieveContext(index, {
      question: 'How does submit order call save order?', budget: 4_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    const symbols = result.dossier.evidence.entities
      .filter((entity) => entity.kind === 'symbol')
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'submitOrder()', excerpt: expect.any(String) }),
      expect.objectContaining({ label: 'saveOrder()' }),
    ]))
    expect(symbols.find(({ label }) => label === 'saveOrder()'))
      .not.toHaveProperty('excerpt')
    expect(result.dossier.evidence.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'calls' }),
    ]))
    const call = result.dossier.evidence.entities.find((entity) =>
      entity.kind === 'operation' && 'links' in entity)
    expect(call).toEqual(expect.objectContaining({
      kind: 'operation', order: expect.any(Array),
      links: expect.any(Array), excerpt: expect.any(String),
    }))
    expect(call).not.toHaveProperty('scheduling')
    expect(call).not.toHaveProperty('callee')
    expect(call).not.toHaveProperty('operation_kind')
    expect(call).not.toHaveProperty('arguments')
  })

  it('keeps linked-call arguments only in the exact authenticated excerpt', () => {
    const index = multiFileWorkspace({
      'repository.ts': 'export function saveOrder(id: string) { return id }\n',
      'service.ts': [
        "import { saveOrder } from './repository.js'",
        "export function submitOrder() { return saveOrder('order-1') }",
        '',
      ].join('\n'),
    })
    const result = retrieveContext(index, {
      question: 'How does submit order call save order?', budget: 4_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    const call = result.dossier.evidence.entities.find((entity) =>
      entity.kind === 'operation' && 'links' in entity)
    expect(call).toBeDefined()
    if (!call || call.kind !== 'operation' || !('links' in call)) return
    expect(call).not.toHaveProperty('arguments')
    expect(result.dossier.evidence.excerpts.find(({ id }) => id === call?.excerpt)?.text)
      .toContain("saveOrder('order-1')")
  })

  it('preserves authenticated sibling-call sequence order in the dossier', () => {
    const index = workspace(`import type { MongoRepository } from 'typeorm'
type Row = { id: string }
export async function generateIdeaReport(repository: MongoRepository<Row>) {
  await persistIdeaReport(repository, 'first')
  return persistIdeaReport(repository, 'second')
}
async function persistIdeaReport(repository: MongoRepository<Row>, id: string) {
  await repository.update(id, { id })
  return id
}
`).index
    const result = retrieveContext(index, {
      question: 'How is an idea report generated end to end?', budget: 4_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    const sequence = result.dossier.flow.order.find(({ kind }) => kind === 'sequence')
    expect(sequence).toBeDefined()
    expect(sequence?.members).toHaveLength(2)
    expect(sequence?.proofs).toHaveLength(2)
    sequence?.members.forEach((member, index) => {
      expect(result.dossier.evidence.entities).toContainEqual(expect.objectContaining({
        id: member, kind: 'operation', excerpt: expect.any(String),
      }))
      expect(sequence.proofs[index]).toBe(member)
    })
  })

  it('keeps an exact imported-caller locator ahead of a called suffix match', () => {
    const index = multiFileWorkspace({
      'route.ts': [
        "import { trackClick } from './analytics.js'",
        "import { redirectToDestination } from './redirect.js'",
        'export function handleClick() { trackClick(); redirectToDestination() }',
        '',
      ].join('\n'),
      'analytics.ts': 'export function trackClick() {}\n',
      'redirect.ts': 'export function redirectToDestination() {}\n',
    })

    const result = retrieveContext(index, {
      question: 'Where is handleClick defined?',
      budget: 1_200,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    expect(result.dossier.evidence.entities).toEqual([
      expect.objectContaining({ kind: 'symbol', label: 'handleClick()' }),
    ])
  })

  it('returns exact incomplete states for missing persistence and budget', () => {
    const noTerminal = retrieveContext(workspace(reportSource(false)).index, {
      question: 'How is an idea report generated end to end?',
      budget: 4_000,
    })
    expect(noTerminal.state).toBe('incomplete')
    if (noTerminal.state === 'incomplete') {
      expect(noTerminal.missing.map(({ code }) => code))
        .toContain('terminal_persistence_unproven')
    }

    const tooSmall = retrieveContext(workspace(reportSource()).index, {
      question: 'How is an idea report generated end to end?',
      budget: 1,
    })
    expect(tooSmall.state).toBe('incomplete')
    if (tooSmall.state === 'incomplete') {
      expect(tooSmall.missing).toContainEqual(expect.objectContaining({
        code: 'required_token_budget',
        limit: 256,
      }))
    }
  })

  it('fails closed on stale selected source bytes', () => {
    const fixture = workspace(reportSource())
    writeFileSync(fixture.path, `${fixture.source}// changed\n`, 'utf8')

    const result = retrieveContext(fixture.index, {
      question: 'Where is generateIdeaReport defined?',
      budget: 4_000,
    })

    expect(result).toMatchObject({
      state: 'stale',
      failures: [{ state: 'stale', subject: 'src/report.ts' }],
    })
  })

  it('plans unsupported questions before consulting an unavailable index', () => {
    const result = retrieveContext(
      { state: 'unavailable', subject: 'out/graph.json' },
      { question: 'Compare every architecture in this repository.', budget: 4_000 },
    )

    expect(result).toMatchObject({
      schema: 'madar.retrieve',
      version: 2,
      state: 'unsupported',
      reason: 'unsupported_intent',
    })
  })

  it('keeps every non-ready terminal state within the effective budget', () => {
    const unsupported = retrieveContext({ state: 'unavailable', subject: 'ignored' }, {
      question: 'Compare every architecture in this repository.', budget: 256,
    })
    const unavailable = retrieveContext({
      state: 'unavailable', subject: 'x'.repeat(2_000),
    }, { question: 'Where is report defined?', budget: 256 })
    const corrupt = retrieveContext({
      state: 'corrupt', subject: 'x'.repeat(2_000),
    }, { question: 'Where is report defined?', budget: 256 })
    const fixture = workspace(reportSource())
    writeFileSync(fixture.path, `${fixture.source}// changed\n`, 'utf8')
    const stale = retrieveContext(fixture.index, {
      question: 'Where is generateIdeaReport defined?', budget: 256,
    })
    const incompleteResult = retrieveContext(workspace(reportSource(false)).index, {
      question: 'How is an idea report generated end to end?',
      budget: 256,
    })

    expect([unsupported, unavailable, corrupt, stale, incompleteResult]
      .map((result) => result.state)).toEqual([
      'unsupported', 'unavailable', 'corrupt', 'stale', 'incomplete',
    ])
    for (const result of [unsupported, unavailable, corrupt, stale, incompleteResult]) {
      expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(256)
      expect(countTokens(serializeRetrieveContextResult(result)))
        .toBe(result.metrics.serialized_tokens)
    }
  })
})
