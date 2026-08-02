import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import { generateIndex } from '../../src/application/generate-index.js'
import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../../src/application/retrieve-context.js'
import {
  inspectQueryIndex,
  type ReadyQueryIndex,
} from '../../src/domain/query/index-status.js'
import { planQuestion } from '../../src/domain/query/plan.js'
import type {
  QueryPlan,
  RetrieveContextResult,
} from '../../src/domain/query/types.js'
import { selectWorkflow } from '../../src/domain/query/workflow.js'

const roots: string[] = []

function readyWorkspace(
  name: string,
  files: Readonly<Record<string, string>>,
): ReadyQueryIndex {
  const root = mkdtempSync(join(tmpdir(), `madar-630-${name}-`))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source.endsWith('\n') ? source : `${source}\n`, 'utf8')
  }
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
    },
  }), 'utf8')
  const generated = generateIndex(root)
  const inspected = inspectQueryIndex(loadGraphArtifact(generated.graphPath))
  if (inspected.state !== 'ready') {
    throw new Error(`Expected ready ${name} index, received ${inspected.state}`)
  }
  return inspected
}

function supportedPlan(question: string): QueryPlan {
  const planned = planQuestion({ question, budget: 4_000 })
  if (planned.status !== 'supported') {
    throw new Error(`Expected supported plan, received ${planned.reason}`)
  }
  return planned.plan
}

function selectedLabels(
  index: ReadyQueryIndex,
  ids: readonly string[],
): string[] {
  return ids.map((id) => String(index.graph.nodeAttributes(id).label ?? id))
}

function expectExactAccounting(result: RetrieveContextResult, budget: number): void {
  const serialized = serializeRetrieveContextResult(result)
  expect(result.metrics.budget_tokens).toBe(Math.max(256, Math.min(budget, 4_000)))
  expect(countTokens(serialized)).toBe(result.metrics.serialized_tokens)
  expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(
    result.metrics.budget_tokens,
  )
}

let reportFlow: ReadyQueryIndex
const frozenQueries = (JSON.parse(readFileSync(
  resolve('tests/fixtures/issue-625-evidence-skeleton/fixture.json'),
  'utf8',
)) as { queries: {
  beta_3_broad: string
  focused_recovery: string
  punctuation_variants: string[]
  clause_order_variants: string[]
  distant_paraphrases: string[]
  field_incident_variants: string[]
} }).queries
const issue631Queries = [
  'explain how generating the report for an idea is working ?',
  ...['finished', 'done', 'final', 'completed', 'saved', 'stored', 'persisted']
    .map((state) => `How does generating the report for an idea work? Explain the end-to-end pipeline flow from request to ${state} report.`),
  'Where is the idea report generation pipeline orchestrated? List the pipeline stages and the entrypoint service.',
]

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'madar-630-real-flow-'))
  roots.push(root)
  cpSync(resolve(
    'tests/fixtures/pack-quality/runtime-generation-explain-report-flow/workspace',
  ), root, { recursive: true })
  const generated = generateIndex(root)
  const inspected = inspectQueryIndex(loadGraphArtifact(generated.graphPath))
  if (inspected.state !== 'ready') {
    throw new Error(`Expected ready real-flow index, received ${inspected.state}`)
  }
  reportFlow = inspected
})

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('retrieve v2 uncovered contract cases', () => {
  it('preserves both explicitly named service-method scopes in planning and selection', () => {
    const question =
      'Trace enqueueTask through `ServiceAlpha.runAlpha` and `ServiceBeta.runBeta`.'
    const plan = supportedPlan(question)
    const index = readyWorkspace('two-explicit-scopes', {
      'src/entry.ts': [
        "import { ServiceAlpha } from './service-alpha.js'",
        "import { ServiceBeta } from './service-beta.js'",
        'export async function enqueueTask(value: string): Promise<string[]> {',
        '  const alpha = new ServiceAlpha()',
        '  const beta = new ServiceBeta()',
        '  return Promise.all([alpha.runAlpha(value), beta.runBeta(value)])',
        '}',
      ].join('\n'),
      'src/service-alpha.ts': [
        "import type { Repository } from 'typeorm'",
        'export class ServiceAlpha {',
        '  async runAlpha(value: string, repository?: Repository<object>) {',
        "    await repository?.update('alpha', { value })",
        '    return value',
        '  }',
        '}',
      ].join('\n'),
      'src/service-beta.ts': [
        "import type { Repository } from 'typeorm'",
        'export class ServiceBeta {',
        '  async runBeta(value: string, repository?: Repository<object>) {',
        "    await repository?.update('beta', { value })",
        '    return value',
        '  }',
        '}',
      ].join('\n'),
    })

    expect(plan.obligations.find(({ kind }) => kind === 'stage')?.target)
      .toBe('service alpha run alpha service beta run beta')

    const selected = selectWorkflow(index, plan)
    const labels = selectedLabels(index, selected.symbolIds)
    expect(labels.some((label) => label.includes('runAlpha'))).toBe(true)
    expect(labels.some((label) => label.includes('runBeta'))).toBe(true)
    expect(selected.obligations.find(({ kind }) => kind === 'stage')?.proven).toBe(true)
  })

  it('keeps both connected fan-in roots and fails closed for disconnected clauses', () => {
    const question =
      'Trace the report from alphaProcess and betaProcess through mergeResult to persistence.'
    const connected = readyWorkspace('connected-fan-in', {
      'src/alpha.ts': [
        "import { mergeResult } from './merge.js'",
        'export function alphaProcess(value: string) { return mergeResult(value) }',
      ].join('\n'),
      'src/beta.ts': [
        "import { mergeResult } from './merge.js'",
        'export function betaProcess(value: string) { return mergeResult(value) }',
      ].join('\n'),
      'src/merge.ts': [
        "import type { Repository } from 'typeorm'",
        'export async function mergeResult(',
        '  value: string, repository?: Repository<object>,',
        ') {',
        "  await repository?.update('report', { value })",
        '  return value',
        '}',
      ].join('\n'),
    })
    const connectedSelection = selectWorkflow(connected, supportedPlan(question))
    expect(connectedSelection.complete).toBe(true)
    expect(selectedLabels(connected, connectedSelection.rootSymbolIds))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('alphaProcess'),
        expect.stringContaining('betaProcess'),
      ]))

    const disconnected = readyWorkspace('disconnected-clauses', {
      'src/alpha.ts': [
        "import type { Repository } from 'typeorm'",
        'export async function alphaProcess(repository: Repository<object>) {',
        "  await repository.update('alpha', { done: true })",
        '}',
      ].join('\n'),
      'src/beta.ts': [
        "import type { Repository } from 'typeorm'",
        'export async function betaProcess(repository: Repository<object>) {',
        "  await repository.update('beta', { done: true })",
        '}',
      ].join('\n'),
    })
    const disconnectedResult = retrieveContext(disconnected, {
      question,
      budget: 4_000,
    })
    expect(disconnectedResult.state).toBe('incomplete')
    expect(disconnectedResult).not.toHaveProperty('dossier')
    if (disconnectedResult.state === 'incomplete') {
      expect(disconnectedResult.missing.map(({ code }) => code))
        .toContain('adjacent_handoff_unproven')
    }
  })

  it('allows an explicitly requested test-production-test flow', () => {
    const index = readyWorkspace('explicit-test-flow', {
      'tests/auth-route.test.ts': [
        "import { testAuthService } from '../src/auth-service.js'",
        "import type { Repository } from 'typeorm'",
        'export function testAuthRoute(repository: Repository<object>) {',
        '  return testAuthService(repository)',
        '}',
      ].join('\n'),
      'src/auth-service.ts': [
        "import { assertAuthRecord } from '../tests/auth-assertion.js'",
        "import type { Repository } from 'typeorm'",
        'export function testAuthService(repository: Repository<object>) {',
        '  return assertAuthRecord(repository)',
        '}',
      ].join('\n'),
      'tests/auth-assertion.ts': [
        "import type { Repository } from 'typeorm'",
        'export async function assertAuthRecord(repository: Repository<object>) {',
        "  await repository.update('auth', { verified: true })",
        "  return 'verified'",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Explain the test flow from testAuthRoute through testAuthService to assertAuthRecord.',
      budget: 4_000,
    })

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') return
    const files = result.dossier.evidence.files.map(({ path }) => path)
    expect(files.some((path) => path.startsWith('tests/'))).toBe(true)
    expect(files.some((path) => path.startsWith('src/'))).toBe(true)
  })

  it('does not authenticate a production workflow through a test-only bridge', () => {
    const index = readyWorkspace('test-only-bridge', {
      'src/runtime-start.ts': [
        "import { testBridge } from '../tests/runtime-bridge.test.js'",
        "import type { Repository } from 'typeorm'",
        'export function runtimeStart(repository: Repository<object>) {',
        '  return testBridge(repository)',
        '}',
      ].join('\n'),
      'tests/runtime-bridge.test.ts': [
        "import { runtimeFinish } from '../src/runtime-finish.js'",
        "import type { Repository } from 'typeorm'",
        'export function testBridge(repository: Repository<object>) {',
        '  return runtimeFinish(repository)',
        '}',
      ].join('\n'),
      'src/runtime-finish.ts': [
        "import type { Repository } from 'typeorm'",
        'export async function runtimeFinish(repository: Repository<object>) {',
        "  await repository.update('runtime', { complete: true })",
        "  return 'complete'",
        '}',
      ].join('\n'),
    })

    const result = retrieveContext(index, {
      question:
        'Trace the runtime report from runtimeStart through runtimeFinish to persistence.',
      budget: 4_000,
    })

    expect(result.state).toBe('incomplete')
    expect(result).not.toHaveProperty('dossier')
    if (result.state === 'incomplete') {
      expect(result.missing.length).toBeGreaterThan(0)
    }
  })

  it.each([
    ...frozenQueries.punctuation_variants,
    ...frozenQueries.clause_order_variants,
    ...frozenQueries.distant_paraphrases,
    ...frozenQueries.field_incident_variants,
    ...issue631Queries,
  ])('converges the frozen broad prompt: %s', (question) => {
    const baseline = retrieveContext(reportFlow, {
      question: frozenQueries.beta_3_broad,
      budget: 4_000,
    })
    expect(baseline.state).toBe('ready')
    expect(baseline.metrics).toMatchObject({
      required_obligations: 7,
      proven_obligations: 7,
    })
    if (baseline.state !== 'ready') return

    const result = retrieveContext(reportFlow, { question, budget: 4_000 })
    const detail = result.state === 'incomplete'
      ? JSON.stringify(result.missing) : result.state
    expect(result.state, detail).toBe('ready')
    expect(result.metrics).toMatchObject({
      required_obligations: 7,
      proven_obligations: 7,
    })
    if (result.state !== 'ready') return
    expect(result.dossier.flow).toEqual(baseline.dossier.flow)
    expect(result.dossier.evidence).toEqual(baseline.dossier.evidence)
  })

  it('answers the frozen focused orchestrator query with planning and channel evidence', () => {
    const result = retrieveContext(reportFlow, {
      question: frozenQueries.focused_recovery,
      budget: 4_000,
    })

    const detail = result.state === 'incomplete'
      ? JSON.stringify(result.missing) : result.state
    expect(result.state, detail).toBe('ready')
    if (result.state !== 'ready') return
    const labels = result.dossier.evidence.entities.flatMap((entity) =>
      entity.kind === 'symbol' ? [entity.label] : [])
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining('process'),
      expect.stringContaining('plan'),
    ]))
    expect(result.dossier.flow.links.some(({ kind }) => kind === 'channel')).toBe(true)
  })

  it.each([
    ['ready-999', 'Where is generateFromProblem defined?', 999],
    ['ready-1000', 'Where is generateFromProblem defined?!', 1_000],
    ['ready-1023', 'Where is generateFromProblem defined?', 1_023],
    ['ready-1024', 'Where is generateFromProblem defined?', 1_024],
    ['terminal-escaped', 'Compare "alpha\\beta" with 東京 🙂.', 256],
    ['terminal-unicode-limit', '🙂'.repeat(256), 256],
    ['terminal-3999', 'Compare every architecture in this repository.', 3_999],
    ['terminal-4000', 'Compare every architecture in this repository!', 4_000],
  ])('keeps exact deterministic token accounting at %s', (
    _name, question, budget,
  ) => {
    const first = retrieveContext(reportFlow, { question, budget })
    const second = retrieveContext(reportFlow, { question, budget })

    expect(second).toEqual(first)
    expectExactAccounting(first, budget)
    expect(first.state.startsWith('ready')).toBe(question.startsWith('Where'))
    if (first.state !== 'ready') expect(first).not.toHaveProperty('dossier')
  })
})
