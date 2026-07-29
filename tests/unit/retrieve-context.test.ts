import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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
import { traverseEvidencePaths } from '../../src/domain/query/traverse.js'
import { sliceEvidence } from '../../src/domain/query/slice.js'
import { KnowledgeGraph } from '../../src/domain/graph/directed-multigraph.js'

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

function reportGenerationFixture(includeDistractor = false): {
  fixture: FlowFixture
  prompt: string
  shortControlPrompt: string
  longFlowPrompt: string
  masterAgentFollowupPrompt: string
  masterAgentFollowupParaphrasePrompts: string[]
  paraphrasePrompts: string[]
  focusedQueuePrompts: string[]
  expectedWorkflowCenters: string[]
  expectedRelationships: Array<{ from: string; relation: string; to: string }>
} {
  const fixtureDirectory = fileURLToPath(new URL(
    '../fixtures/pack-quality/runtime-generation-explain-report-flow/',
    import.meta.url,
  ))
  const root = sandbox('report-generation')
  const workspace = join(root, 'workspace')
  cpSync(join(fixtureDirectory, 'workspace'), workspace, { recursive: true })
  if (includeDistractor) {
    write(workspace, 'platform/src/app/entry.worker.js/route.ts', [
      'export function GET(): Response {',
      "  return new Response('unrelated')",
      '}',
      '',
    ].join('\n'))
  }
  const metadata = JSON.parse(
    readFileSync(join(fixtureDirectory, 'fixture.json'), 'utf8'),
  ) as {
    prompt: string
    short_control_prompt: string
    long_flow_prompt: string
    master_agent_followup_prompt: string
    master_agent_followup_paraphrase_prompts: string[]
    paraphrase_prompts: string[]
    focused_queue_prompts: string[]
    expected_workflow_centers: string[]
    expected_relationships: Array<{ from: string; relation: string; to: string }>
  }
  return {
    prompt: metadata.prompt,
    shortControlPrompt: metadata.short_control_prompt,
    longFlowPrompt: metadata.long_flow_prompt,
    masterAgentFollowupPrompt: metadata.master_agent_followup_prompt,
    masterAgentFollowupParaphrasePrompts: metadata.master_agent_followup_paraphrase_prompts,
    paraphrasePrompts: metadata.paraphrase_prompts,
    focusedQueuePrompts: metadata.focused_queue_prompts,
    expectedWorkflowCenters: metadata.expected_workflow_centers,
    expectedRelationships: metadata.expected_relationships,
    fixture: {
      root: workspace,
      source: {},
      ...indexedWorkspace(workspace),
    },
  }
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
      'src/flow-001/entry-local-00.ts':
        'export function entryLocal00(value: string): string ',
      'src/flow-001/process-local-01.ts':
        'export function processLocal01(value: string): string ',
      'src/flow-001/storage-local-02.js':
        'export function storageLocal02(value) ',
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

  it('keeps ordered evidence in the first comma-delimited obligation', () => {
    const fixture = flowFixture()
    const result = retrieveContext(fixture.index, {
      question:
        'Trace flow-001 from entry local 00 through calls to process local 01, then storage local 02.',
    })

    expect(result.matched_nodes.map((node) => node.source_file).sort()).toEqual([
      'src/flow-001/entry-local-00.ts',
      'src/flow-001/process-local-01.ts',
      'src/flow-001/storage-local-02.js',
    ])
    expect(result.relationships.map((relationship) => relationship.relation))
      .toEqual(['calls', 'calls'])
    expect(result.boundaries).toEqual([])
  })

  it('omits an alternate non-adjacent path when adjacent anchors form a complete chain', () => {
    const root = sandbox('adjacent-chain')
    write(root, 'src/start.ts', [
      "import { alternateAnchor } from './alternate.js'",
      "import { middleAnchor } from './middle.js'",
      '',
      'export function startAnchor(value: string): string {',
      '  alternateAnchor(value)',
      '  return middleAnchor(value)',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/alternate.ts', [
      "import { finishAnchor } from './finish.js'",
      '',
      'export function alternateAnchor(value: string): string {',
      '  return finishAnchor(value)',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/middle.ts', [
      "import { finishAnchor } from './finish.js'",
      '',
      'export function middleAnchor(value: string): string {',
      '  return finishAnchor(value)',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/finish.ts', [
      'export function finishAnchor(value: string): string {',
      '  return value',
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace `startAnchor` through `middleAnchor` to `finishAnchor`.',
    })

    expect(result.matched_nodes.map((node) => node.label).sort()).toEqual([
      'finishAnchor()',
      'middleAnchor()',
      'startAnchor()',
    ])
    const nodesById = new Map(result.matched_nodes.map((node) => [node.node_id, node]))
    expect(result.relationships.map((relationship) => ({
      from: nodesById.get(relationship.from_id)?.label,
      relation: relationship.relation,
      to: nodesById.get(relationship.to_id)?.label,
    }))).toEqual(expect.arrayContaining([
      { from: 'startAnchor()', relation: 'calls', to: 'middleAnchor()' },
      { from: 'middleAnchor()', relation: 'calls', to: 'finishAnchor()' },
    ]))
    expect(result.relationships).toHaveLength(2)
    expect(result.boundaries).toEqual([])
  })

  it('keeps a non-adjacent path when an adjacent anchor handoff is disconnected', () => {
    const root = sandbox('non-adjacent-handoff')
    write(root, 'src/start.ts', [
      "import { finishAnchor } from './finish.js'",
      '',
      'export function startAnchor(value: string): string {',
      '  return finishAnchor(value)',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/middle.ts', [
      "import { finishAnchor } from './finish.js'",
      '',
      'export function middleAnchor(value: string): string {',
      '  return finishAnchor(value)',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/finish.ts', [
      'export function finishAnchor(value: string): string {',
      '  return value',
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace `startAnchor` through `middleAnchor` to `finishAnchor`.',
    })

    expect(result.matched_nodes.map((node) => node.label).sort()).toEqual([
      'finishAnchor()',
      'middleAnchor()',
      'startAnchor()',
    ])
    const nodesById = new Map(result.matched_nodes.map((node) => [node.node_id, node]))
    expect(result.relationships.map((relationship) => ({
      from: nodesById.get(relationship.from_id)?.label,
      relation: relationship.relation,
      to: nodesById.get(relationship.to_id)?.label,
    }))).toEqual(expect.arrayContaining([
      { from: 'startAnchor()', relation: 'calls', to: 'finishAnchor()' },
      { from: 'middleAnchor()', relation: 'calls', to: 'finishAnchor()' },
    ]))
    expect(result.relationships).toHaveLength(2)
    expect(result.boundaries.filter((boundary) => boundary.kind === 'disconnected'))
      .toHaveLength(1)
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

  it('recovers the known report-generation path instead of response-format helpers', () => {
    for (const includeDistractor of [false, true]) {
      const {
        fixture,
        prompt,
        expectedWorkflowCenters,
        expectedRelationships,
      } = reportGenerationFixture(includeDistractor)

      for (const question of [
        prompt,
        'can you tell me how is the flow generating report for idea?',
      ]) {
        const result = retrieveContext(fixture.index, { question })
        const selectedFiles = result.matched_nodes.map((node) => node.source_file)
        const labels = new Map(result.matched_nodes.map((node) => [node.node_id, node.label]))
        const relationships = result.relationships.map((relationship) => ({
          from: labels.get(relationship.from_id),
          relation: relationship.relation,
          to: labels.get(relationship.to_id),
        }))

        expect(result.outcome).toBe('evidence')
        expect(selectedFiles).toEqual(expect.arrayContaining(expectedWorkflowCenters))
        expect(selectedFiles).not.toContain(
          'src/modules/ideas/application/helpers/idea-report-status-message.helper.ts',
        )
        expect(selectedFiles).not.toContain(
          'src/modules/ideas/application/helpers/idea-report-suggested-next-steps.helper.ts',
        )
        expect(selectedFiles).not.toContain('platform/src/app/entry.worker.js/route.ts')
        expect(relationships).toEqual(expect.arrayContaining(expectedRelationships))
        expect(result.boundaries).toEqual([])
      }
    }
  })

  it('keeps the full report pipeline and MasterAgent follow-up useful at the protocol budget', () => {
    const {
      fixture,
      shortControlPrompt,
      longFlowPrompt,
      masterAgentFollowupPrompt,
      masterAgentFollowupParaphrasePrompts,
      paraphrasePrompts,
      focusedQueuePrompts,
    } = reportGenerationFixture()
    const corePipeline = [
      ['src/modules/ideas/interface/http/idea-generation.controller.ts', '.generateFromProblem()'],
      ['src/modules/pipeline/api/pipeline-trigger.service.ts', 'startPipeline()'],
      ['src/modules/pipeline/api/queue-registry.service.ts', 'enqueueJob()'],
      ['src/modules/pipeline/workers/orchestrator.worker.ts', '.process()'],
      ['src/modules/planning/planner.service.ts', '.plan()'],
      ['src/modules/research/workers/section-research.worker.ts', '.process()'],
      ['src/modules/research/research-agent.service.ts', '.researchSection()'],
      ['src/modules/pipeline/assembly/assembly.worker.ts', '.process()'],
      ['src/modules/reports/assembly.service.ts', '.assembleReport()'],
      ['src/modules/pipeline/workers/db-sync.worker.ts', '.process()'],
    ]
    const exactBoundaryDetails = [
      'src/modules/planning/planner.service.ts:L13-L16 -> '
        + 'src/modules/research/workers/section-research.worker.ts:L17-L19',
      'src/modules/research/research-agent.service.ts:L10-L14 -> '
        + 'src/modules/pipeline/assembly/assembly.worker.ts:L17-L19',
      'src/modules/reports/assembly.service.ts:L20-L31 -> '
        + 'src/modules/pipeline/workers/db-sync.worker.ts:L26-L35',
    ]
    const assertLimitsAndSignal = (
      result: ReturnType<typeof retrieveContext>,
    ): void => {
      expect(result.outcome).toBe('evidence')
      expect(result.relationships.length).toBeGreaterThan(0)
      expect(result.matched_nodes.map((node) => node.source_file)).not.toContain(
        'platform/src/components/InProgressIdeasDropdown.tsx',
      )
      expect(result.metrics.selected_files).toBeLessThanOrEqual(12)
      expect(result.metrics.snippets).toBeLessThanOrEqual(25)
      expect(result.metrics.closure_passes).toBeLessThanOrEqual(1)
      expect(result.metrics.serialized_tokens).toBeLessThanOrEqual(4_000)
      expect(result.metrics.truncated).toBe(false)
    }
    const selected = (result: ReturnType<typeof retrieveContext>): string[][] =>
      result.matched_nodes.map((node) => [node.source_file, node.label])
    const disconnected = (result: ReturnType<typeof retrieveContext>): string[] =>
      result.boundaries.filter(({ kind }) => kind === 'disconnected')
        .map(({ detail }) => detail ?? '').sort()
    const relationships = (result: ReturnType<typeof retrieveContext>): string[] => {
      const nodes = new Map(result.matched_nodes.map((node) => [
        node.node_id,
        `${node.source_file}#${node.label}`,
      ]))
      return result.relationships.map((edge) =>
        `${nodes.get(edge.from_id)} --${edge.relation}--> ${nodes.get(edge.to_id)}`).sort()
    }
    const coreRelationships = [
      'src/modules/ideas/interface/http/idea-generation.controller.ts#.generateFromProblem() '
        + '--calls--> src/modules/pipeline/api/pipeline-trigger.service.ts#startPipeline()',
      'src/modules/pipeline/api/pipeline-trigger.service.ts#startPipeline() '
        + '--calls--> src/modules/pipeline/api/queue-registry.service.ts#enqueueJob()',
      'src/modules/pipeline/api/queue-registry.service.ts#enqueueJob() '
        + '--enqueues_job--> src/modules/pipeline/workers/orchestrator.worker.ts#.process()',
      'src/modules/pipeline/workers/orchestrator.worker.ts#.process() '
        + '--calls--> src/modules/planning/planner.service.ts#.plan()',
      'src/modules/research/workers/section-research.worker.ts#.process() '
        + '--calls--> src/modules/research/research-agent.service.ts#.researchSection()',
      'src/modules/pipeline/assembly/assembly.worker.ts#.process() '
        + '--calls--> src/modules/reports/assembly.service.ts#.assembleReport()',
    ].sort()
    const assertCorePipeline = (result: ReturnType<typeof retrieveContext>): void => {
      assertLimitsAndSignal(result)
      expect(selected(result)).toEqual(corePipeline)
      expect(relationships(result)).toEqual(coreRelationships)
      expect(disconnected(result)).toEqual([...exactBoundaryDetails].sort())
    }

    const shortControl = retrieveContext(fixture.index, {
      question: shortControlPrompt,
      budget: 8_000,
    })
    assertLimitsAndSignal(shortControl)
    expect(selected(shortControl)).toEqual(corePipeline.slice(0, 4))
    expect(relationships(shortControl)).toEqual(coreRelationships.filter((edge) =>
      !edge.includes('planner.service.ts')
      && !edge.includes('research/')
      && !edge.includes('assembly/')))

    const fullFlow = retrieveContext(fixture.index, {
      question: longFlowPrompt,
      budget: 8_000,
    })
    assertCorePipeline(fullFlow)
    for (const question of paraphrasePrompts) {
      assertCorePipeline(retrieveContext(fixture.index, { question, budget: 8_000 }))
    }

    for (const question of [
      masterAgentFollowupPrompt,
      ...masterAgentFollowupParaphrasePrompts,
    ]) {
      const masterAgentFollowup = retrieveContext(fixture.index, {
        question,
        budget: 8_000,
      })
      assertLimitsAndSignal(masterAgentFollowup)
      expect(selected(masterAgentFollowup)).toEqual([
        ...corePipeline.slice(0, 7),
        ['src/modules/pipeline/agent/master-agent.service.ts', '.call()'],
        ...corePipeline.slice(7, 9),
      ])
      expect(relationships(masterAgentFollowup)).toEqual([
        ...coreRelationships,
        'src/modules/research/research-agent.service.ts#.researchSection() '
          + '--calls--> src/modules/pipeline/agent/master-agent.service.ts#.call()',
      ].sort())
      expect(disconnected(masterAgentFollowup)).toEqual(
        exactBoundaryDetails.slice(0, 2).sort(),
      )
    }

    for (const question of focusedQueuePrompts) {
      const focused = retrieveContext(fixture.index, { question })
      expect(focused.metrics.selected_files).toBeLessThanOrEqual(3)
      expect(focused.metrics.snippets).toBeLessThanOrEqual(3)
      expect(focused.metrics.truncated).toBe(false)
      expect(selected(focused)).not.toEqual(corePipeline)
      expect(selected(focused)).not.toContainEqual(corePipeline[0])
      expect(selected(focused)).not.toContainEqual(corePipeline[4])
      expect(selected(focused)).not.toContainEqual(corePipeline[9])
    }
  })

  it('reports the exact first omitted authenticated target under a tiny budget', () => {
    const { fixture, prompt } = reportGenerationFixture()
    const constrained = retrieveContext(fixture.index, {
      question: prompt,
      budget: 40,
    })
    expect(constrained.boundaries).toContainEqual({
      kind: 'truncated',
      subject:
        'src/modules/ideas/interface/http/idea-generation.controller.ts:L16-L28',
    })

    const partial = retrieveContext(fixture.index, {
      question: prompt,
      budget: 400,
    })
    const retainedLocations = partial.matched_nodes.map((node) =>
      node.evidence_kind === 'symbol_declaration'
        ? `${node.source_file}:${node.source_location}`
        : node.source_file)
    const exactOmissions = partial.boundaries
      .filter((boundary) => boundary.kind === 'truncated' && boundary.subject !== 'retrieve')
      .map((boundary) => boundary.subject)
    expect(exactOmissions.length).toBeGreaterThan(0)
    expect(exactOmissions.every((target) => !retainedLocations.includes(target))).toBe(true)
  })

  it('keeps nearby report subflows focused while improving the broad flow', () => {
    const { fixture } = reportGenerationFixture()
    const cases = [
      ['Where is idea title generated?', 'generateIdeaTitle()'],
      ['How is idea title generated?', 'generateIdeaTitle()'],
      ['Where is idea report status message built?', 'getIdeaReportStatusMessage()'],
      ['How is idea report quality validated?', 'validateIdeaReportQuality()'],
      ['How are quality gate failures handled?', 'handleQualityGateFailure()'],
      ['How does failure report storage work?', 'writeRawFailureReport()'],
      ['How is database sync performed for reports?', 'saveStructuredReport()'],
    ] as const
    for (const [question, expectedLabel] of cases) {
      const result = retrieveContext(fixture.index, { question })
      expect(result.matched_nodes[0]?.label).toBe(expectedLabel)
    }
  })

  it('uses bounded successor context to recover a zero-overlap route branch', () => {
    const root = sandbox('route-fanout')
    write(root, 'src/entry.ts', [
      "import { distractAlpha } from './noise/alpha.js'",
      "import { distractBeta } from './noise/beta.js'",
      "import { forward } from './worker/forward.js'",
      '',
      'export function handleSignal(): string {',
      '  distractAlpha()',
      '  distractBeta()',
      '  return forward()',
      '}',
      '',
    ].join('\n'))
    for (const name of ['alpha', 'beta']) {
      write(root, `src/noise/${name}.ts`, [
        `import { ${name}One, ${name}Two, ${name}Three } from './${name}-helpers.js'`,
        `export function distract${name[0]!.toUpperCase()}${name.slice(1)}(): string {`,
        `  return ${name}One() + ${name}Two() + ${name}Three()`,
        '}',
        '',
      ].join('\n'))
      write(root, `src/noise/${name}-helpers.ts`, [
        `export const ${name}One = () => '1'`,
        `export const ${name}Two = () => '2'`,
        `export const ${name}Three = () => '3'`,
        '',
      ].join('\n'))
    }
    write(root, 'src/worker/forward.ts', [
      "import { getBackgroundProducer } from './producer.js'",
      'export function forward(): string {',
      '  return getBackgroundProducer()',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/worker/producer.ts',
      'export declare function getBackgroundProducer(): string\n')
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Trace signal handling toward the background producer.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.matched_nodes.map((node) => node.label)).toContain('forward()')
  })

  it('ranks interfaces only for explicit kind or definition intent', () => {
    const root = sandbox('interface-ranking')
    write(root, 'src/auth.ts', [
      'export interface AuthFlow {',
      '  ready: boolean',
      '}',
      'export function authFlow(): boolean {',
      '  return true',
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const index = readyIndex(root)

    const ordinary = retrieveContext(index, { question: 'Trace the auth flow.' })
    expect(ordinary.matched_nodes.map((node) => node.node_kind)).not.toContain('interface')
    const requested = retrieveContext(index, { question: 'Which interface defines AuthFlow?' })
    expect(requested.matched_nodes.map((node) => node.node_kind)).toContain('interface')
    const definition = retrieveContext(index, { question: 'Where is AuthFlow defined?' })
    expect(definition.matched_nodes.map((node) => node.label)).toEqual(['AuthFlow'])
  })

  it('keeps downstream branches but excludes low-signal callers after query terms are covered', () => {
    const root = sandbox('directed-query-frontier')
    write(root, 'src/app.ts', [
      "import { sendInvoiceReceipt } from './billing.js'",
      'export function runDemoScenario(): void {',
      '  sendInvoiceReceipt()',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/billing.ts', [
      "import { sendReceiptEmail } from './notifications.js'",
      'export function sendInvoiceReceipt(): void {',
      '  sendReceiptEmail()',
      '}',
      'export function collectInvoiceBatch(): number {',
      '  return 4',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/monthly.ts', [
      "import { collectInvoiceBatch } from './billing.js'",
      "import { buildMonthlyRevenueReport } from './reports.js'",
      'export function runMonthlyCloseJob(): number {',
      '  return collectInvoiceBatch() + buildMonthlyRevenueReport()',
      '}',
      '',
    ].join('\n'))
    write(root, 'src/notifications.ts', [
      'export function sendReceiptEmail(): void {}',
      '',
    ].join('\n'))
    write(root, 'src/reports.ts', [
      'export function buildMonthlyRevenueReport(): number {',
      '  return 1200',
      '}',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')

    const result = retrieveContext(readyIndex(root), {
      question: 'Which module sends invoice receipt emails?',
    })

    expect(result.matched_nodes.map((node) => node.label)).toEqual([
      'sendInvoiceReceipt()',
      'sendReceiptEmail()',
    ])
    expect(result.relationships).toHaveLength(1)
    expect(result.boundaries).toEqual([])

    const fanout = retrieveContext(readyIndex(root), {
      question: 'What runs the monthly billing close?',
    })
    expect(fanout.matched_nodes.map((node) => node.label)).toEqual([
      'runMonthlyCloseJob()',
      'buildMonthlyRevenueReport()',
      'collectInvoiceBatch()',
    ])
    expect(fanout.relationships).toHaveLength(2)
    expect(fanout.boundaries).toEqual([])
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
      expect.objectContaining({
        kind: 'disconnected',
        detail:
          'src/flow-002/alpha-local-00.ts:L1-L3 -> src/flow-002/beta-local-01.ts:L1-L3',
      }),
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

  it('retrieves exact natural symbol names without requiring kind words or backticks', () => {
    const root = sandbox('natural-symbol')
    write(root, 'src/config.ts', [
      'export const MAX_RETRIES = 3',
      'export const MAX_TIMEOUT = 30',
      'export const providerToFunction = { email: () => "sent" }',
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const index = readyIndex(root)

    expect(retrieveContext(index, { question: 'What is MAX_RETRIES?' })
      .matched_nodes.map((node) => node.label)).toEqual(['MAX_RETRIES'])
    expect(retrieveContext(index, { question: 'How does providerToFunction work?' })
      .matched_nodes.map((node) => node.label)).toEqual(['providerToFunction'])
  })

  it('reports exact synthetic framework targets as unavailable without unrelated evidence', () => {
    const root = sandbox('synthetic-framework')
    write(root, 'src/router.ts', [
      "import { initTRPC } from '@trpc/server'",
      'const t = initTRPC.create()',
      "const namedHealth = t.procedure.query(() => 'ok')",
      "export const appRouter = t.router({ namedHealth, inlineHealth: t.procedure.query(() => 'ok') })",
      '',
    ].join('\n'))
    write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
    const index = readyIndex(root)

    expect(retrieveContext(index, { question: 'Explain `appRouter.inlineHealth`.' }))
      .toMatchObject({
        outcome: 'unavailable',
        matched_nodes: [],
        relationships: [],
        boundaries: [{ kind: 'unavailable', subject: 'appRouter.inlineHealth' }],
        metrics: { selected_files: 0, snippets: 0, closure_passes: 0 },
      })
    expect(retrieveContext(index, { question: 'Explain `namedHealth`.' })
      .matched_nodes.map((node) => node.label)).toEqual(['namedHealth'])
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

  it('follows a finite directed evidence path beyond eight hops', () => {
    const root = sandbox('complete-traversal')
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
      question: 'Trace `nodeLocal00` to `nodeLocal09`.',
    })

    expect(result.outcome).toBe('evidence')
    expect(result.relationships).toHaveLength(9)
    expect(result.relationships.every((edge) => edge.relation === 'calls')).toBe(true)
    expect(result.matched_nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      'nodeLocal00()',
      'nodeLocal09()',
    ]))
    expect(result.boundaries).toEqual([])
    expect(result.metrics.truncated).toBe(false)
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
    const symbols = result.matched_nodes.filter((node) =>
      node.evidence_kind === 'symbol_declaration')
    expect(symbols).toHaveLength(2)
    expect(symbols.every((node) =>
      node.snippet === 'export function handle(): string ')).toBe(true)
    expect(result.matched_nodes.filter((node) =>
      node.evidence_kind === 'structural_file')).toHaveLength(2)
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
      'src/flow-001/storage-local-02.js',
      'export function storageLocal02() { return "changed" }\n',
    )

    const result = retrieveContext(fixture.index, {
      question: 'Explain `storageLocal02`.',
    })

    expect(result.outcome).toBe('stale')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'stale', subject: 'src/flow-001/storage-local-02.js' },
    ])
  })

  it('reports unavailable excerpts when an authenticated source disappears', () => {
    const fixture = flowFixture()
    unlinkSync(join(fixture.root, 'src/flow-001/storage-local-02.js'))

    const result = retrieveContext(fixture.index, {
      question: 'Explain `storageLocal02`.',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'unavailable', subject: 'src/flow-001/storage-local-02.js' },
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
      attributes.qualified_name === 'storageLocal02')
    if (!entry) throw new Error('Canonical fixture did not index storageLocal02')
    const [nodeId, attributes] = entry
    fixture.graph.replaceNodeAttributes(nodeId, {
      ...attributes,
      label: 'flow-003 escape local 00',
      qualified_name: 'escapeLocal00',
      source_file: relative(fixture.root, outside),
      source_location: 'L1-L3',
      line_number: 1,
      end_line_number: 3,
    })
    const escapedSource = relative(fixture.root, outside)
    const escapedIndex: ReadyQueryIndex = {
      ...fixture.index,
      graph: fixture.graph,
      file_hashes: new Map([
        ...fixture.index.file_hashes,
        [escapedSource, createHash('sha256').update(readFileSync(outside)).digest('hex')],
      ]),
    }

    const result = retrieveContext(escapedIndex, {
      question: 'Explain `escapeLocal00`.',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.matched_nodes).toEqual([])
    expect(result.boundaries).toEqual([
      { kind: 'unavailable', subject: escapedSource },
    ])
  })

  it('does not replace an exact hard-ignored graph target with unrelated evidence', () => {
    const fixture = flowFixture()
    const ignoredSource = 'tmp/escape.ts'
    const outside = write(fixture.root, ignoredSource, [
      'export function ignoredEscapeLocal00(): string {',
      "  return 'ignored'",
      '}',
      '',
    ].join('\n'))
    const entry = fixture.graph.nodeEntries().find(([, attributes]) =>
      attributes.qualified_name === 'storageLocal02')
    if (!entry) throw new Error('Canonical fixture did not index storageLocal02')
    fixture.graph.replaceNodeAttributes(entry[0], {
      ...entry[1],
      label: 'ignored escape local 00',
      qualified_name: 'ignoredEscapeLocal00',
      source_file: ignoredSource,
      source_location: 'L1-L3',
      line_number: 1,
      end_line_number: 3,
    })
    const ignoredIndex: ReadyQueryIndex = {
      ...fixture.index,
      graph: fixture.graph,
      file_hashes: new Map([
        ...fixture.index.file_hashes,
        [ignoredSource, createHash('sha256').update(readFileSync(outside)).digest('hex')],
      ]),
    }

    expect(retrieveContext(ignoredIndex, {
      question: 'Explain `ignoredEscapeLocal00`.',
    })).toMatchObject({
      outcome: 'unavailable',
      matched_nodes: [],
      relationships: [],
      boundaries: [{ kind: 'unavailable', subject: 'ignoredEscapeLocal00' }],
    })
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
      source_location: 'L1-L999',
      definition_range: {
        ...(entry[1].definition_range as { start: { line: number; column: number } }),
        end: { line: 999, column: 1 },
      },
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
      definition_range: {
        start: { line: 2, column: 1 },
        end: { line: 4, column: 2 },
      },
      declaration_range: {
        start: { line: 2, column: 1 },
        end: { line: 2, column: 38 },
      },
      snippet: 'export function lineTarget(): number ',
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
    const snippetQuestion = `Trace flow-010 from ${phases.map((phase, index) =>
      `${phase} local ${String(index).padStart(2, '0')}`).join(' -> ')}.`
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
      evidence_kind: 'symbol_declaration' as const,
      label: 'priority()',
      node_kind: 'function',
      source_file: 'src/priority.ts',
      source_location: 'L1',
      line_number: 1,
      end_line_number: 1,
      definition_range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 30 },
      },
      declaration_range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 30 },
      },
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

  it('prunes a structural file when the token budget drops its relationship', () => {
    const structural = {
      node_id: 'file',
      evidence_kind: 'structural_file' as const,
      label: 'priority.ts',
      node_kind: 'file' as const,
      source_file: 'src/priority.ts',
      source_domain: 'production',
      provenance: [{}],
      content_hash: 'b'.repeat(64),
    }
    const result = sliceEvidence({
      request: { question: 'priority', budget: 256 },
      outcome: 'evidence',
      matchedNodes: [structural, {
        node_id: 'symbol',
        evidence_kind: 'symbol_declaration',
        label: 'priority()',
        node_kind: 'function',
        source_file: 'src/priority.ts',
        source_location: 'L1',
        line_number: 1,
        end_line_number: 1,
        definition_range: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 30 },
        },
        declaration_range: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 30 },
        },
        source_domain: 'production',
        provenance: [{}],
        content_hash: 'b'.repeat(64),
        snippet: 'export function priority() {}',
      }],
      relationships: [{
        id: 'contains',
        from_id: 'file',
        to_id: 'symbol',
        relation: 'contains',
        source_file: 'src/priority.ts',
        source_location: 'L1',
        provenance: [{ detail: 'x'.repeat(2_000) }],
      }],
      boundaries: [],
      priorityNodeIds: ['file'],
      closurePasses: 1,
    })

    expect(result.matched_nodes).not.toContainEqual(expect.objectContaining({
      evidence_kind: 'structural_file',
    }))
    const ids = new Set(result.matched_nodes.map((entry) => entry.node_id))
    expect(result.relationships.every((edge) =>
      ids.has(edge.from_id) && ids.has(edge.to_id))).toBe(true)
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
      .toThrow('retrieve question must be between 1 and 512 characters')
    expect(() => retrieveContext(fixture.index, { question: 'x'.repeat(513) }))
      .toThrow('retrieve question must be between 1 and 512 characters')
    expect(retrieveContext(fixture.index, { question: 'trace entry', budget: 1 }).metrics.serialized_tokens)
      .toBeLessThanOrEqual(256)
    expect(retrieveContext(fixture.index, { question: 'trace entry', budget: 20_000 }).metrics.serialized_tokens)
      .toBeLessThanOrEqual(4000)
  })

  it('traverses a side branch between adjacent flow anchors without mixing index spaces', () => {
    const graph = new KnowledgeGraph({ root_path: '/workspace' })
    const chain = ['entry', 'plan', 'research', 'assembly']
    const anchors = [...chain.slice(0, -1), 'notification', chain.at(-1)!]
    const range = {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 20 },
    }
    for (const id of anchors) {
      graph.addNode(id, {
        label: `${id}()`,
        node_kind: 'function',
        source_file: `src/${id}.ts`,
        source_location: 'L1',
        definition_range: range,
        declaration_range: range,
      })
    }
    for (const [from, to] of [
      ['entry', 'plan'],
      ['plan', 'research'],
      ['research', 'notification'],
      ['research', 'assembly'],
    ]) {
      graph.addEdge(from!, to!, {
        relation: 'calls',
        source_file: `src/${from!}.ts`,
        source_location: 'L1',
        provenance: [],
      })
    }
    const index: ReadyQueryIndex = {
      state: 'ready',
      graph,
      root_path: '/workspace',
      file_hashes: new Map(),
      unsupported_sources: [],
    }

    const slice = traverseEvidencePaths(index, {
      anchors: anchors.map((id, firstMatch) => ({
        id,
        attributes: graph.nodeAttributes(id),
        score: 1,
        matchedTerms: [],
        firstMatch,
      })),
      boundaries: [],
      queryTerms: ['flow'],
      flow: true,
      branch: 'notification',
    })

    expect(slice.edges.map(({ from, to }) => `${from}->${to}`)).toEqual([
      'entry->plan',
      'plan->research',
      'research->assembly',
      'research->notification',
    ])
    expect(slice.boundaries).toEqual([])
  })
})
