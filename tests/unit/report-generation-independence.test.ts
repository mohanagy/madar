// #660 Slice C — report-generation independence controls.
//
// Slice C removed the last production behaviour that Madar activated because a
// prompt LOOKED like the qualification report-generation task: a task-phrase
// classifier duplicated in `infrastructure/prompt-pack.ts` and
// `runtime/retrieve/slicing.ts`, the fixed
// "Follow planner, research, assembly, scoring, rendering, and persistence
// evidence" instruction, a name-driven anchor score table, forced anchor
// membership, a deeper report-only slice policy, and the `reportGenerationShaped`
// gate variant.
//
// These controls are NEGATIVE and INDEPENDENCE controls, not snapshots. Each one
// is written so that restoring any single retired rule makes it fail — that is
// verified mechanically by scripts/verify-report-generation-injections.mjs,
// which restores each rule from a digest-checked byte snapshot and requires the
// named control below to fail.
//
// The former qualification vocabulary is deliberately spelled out in the PROMPTS
// here. That is the point: these controls prove the words do nothing. It is
// never used to name a symbol, a path or an expected output.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ContextPackExecutionPhase } from '../../src/contracts/context-pack.js'
import { build } from '../../src/pipeline/build.js'
import { buildMadarPromptPack } from '../../src/infrastructure/prompt-pack.js'
import { classifyRetrievalLevel } from '../../src/runtime/retrieval-gate.js'
import { retrieveContext, type RetrieveResult } from '../../src/runtime/retrieve.js'

// The retired qualification vocabulary, split so a control never confuses a
// LEGITIMATE lexical effect with a report-policy effect. `rendering`/`renderer`
// are also ordinary FRONTEND-DISPLAY words that the generic display classifier
// has always matched and that Slice C did not touch, so they live apart and are
// only used where a display classification is the expected generic outcome.
const REPORT_WORDS = 'idea report generation planner research assembly scoring synthesis metrics quality gate'
const REPORT_DISPLAY_WORDS = 'rendering renderer'

// A shared generic frame. The two prompts carry the same backend-runtime and
// explanation shape and differ ONLY in their nouns. Both noun sets are chosen to
// match NO label in either fixture graph, so a structural difference cannot be
// explained away as ordinary lexical relevance — which section 11-B requires be
// identified separately rather than mistaken for special policy.
const FRAME = 'is generated end to end through the runtime pipeline by the'
const NEUTRAL_Q = `Explain how the daily digest ${FRAME} ingest, lookup, merge and tally stages`
const REPORT_Q = `Explain how the idea report ${FRAME} planner, research, assembly and scoring stages`

const BASE_INSTRUCTIONS = [
  'Answer the question using only the provided graph-guided retrieval output.',
  'If the retrieval does not contain the answer, say so.',
]

/**
 * A five-stage runtime flow whose edges point BACK toward the route.
 *
 * Every stage carries both a LABEL and a SOURCE PATH, because the retired score
 * table read `label + node_kind + framework_role + source_file` and in practice
 * matched on path SEGMENTS (`/assembly/`, `/scoring/`) far more often than on a
 * camelCase label, where lower-casing destroys the word boundaries the pattern
 * needed. A fixture that varied only the labels could not catch it.
 */
interface Stage { label: string; file: string }

function reverseFlowGraph(stages: {
  route: Stage
  trigger: Stage
  queue: Stage
  worker: Stage
  assembler: Stage
  scorer: Stage
}) {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'route', label: stages.route.label, file_type: 'code', source_file: stages.route.file, source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_route', community: 0 },
          { id: 'trigger', label: stages.trigger.label, file_type: 'code', source_file: stages.trigger.file, source_location: 'L30', node_kind: 'method', framework_role: 'service', community: 1 },
          { id: 'queue', label: stages.queue.label, file_type: 'code', source_file: stages.queue.file, source_location: 'L40', node_kind: 'method', framework_role: 'queue', community: 1 },
          { id: 'worker', label: stages.worker.label, file_type: 'code', source_file: stages.worker.file, source_location: 'L50', node_kind: 'method', framework_role: 'worker', community: 2 },
          { id: 'assembler', label: stages.assembler.label, file_type: 'code', source_file: stages.assembler.file, source_location: 'L60', node_kind: 'method', framework_role: 'service', community: 2 },
          { id: 'scorer', label: stages.scorer.label, file_type: 'code', source_file: stages.scorer.file, source_location: 'L70', node_kind: 'method', framework_role: 'service', community: 2 },
        ],
        edges: [
          { source: 'trigger', target: 'route', relation: 'calls', confidence: 'EXTRACTED', source_file: stages.trigger.file },
          { source: 'queue', target: 'trigger', relation: 'calls', confidence: 'EXTRACTED', source_file: stages.queue.file },
          { source: 'worker', target: 'queue', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: stages.worker.file },
          { source: 'assembler', target: 'worker', relation: 'calls', confidence: 'EXTRACTED', source_file: stages.assembler.file },
          { source: 'scorer', target: 'assembler', relation: 'calls', confidence: 'EXTRACTED', source_file: stages.scorer.file },
        ],
      },
    ],
    { directed: true },
  )
}

// Unrelated names: an invoice intake flow.
const NEUTRAL_NAMES = {
  route: { label: '.submitInvoice()', file: '/src/entry/entry.controller.ts' },
  trigger: { label: '.beginRun()', file: '/src/flow/trigger.service.ts' },
  queue: { label: '.enqueueBatch()', file: '/src/flow/queue-registry.service.ts' },
  worker: { label: '.consume()', file: '/src/flow/orchestrator.worker.ts' },
  assembler: { label: '.combineLineItems()', file: '/src/flow/stage/stage.service.ts' },
  scorer: { label: '.rateVendor()', file: '/src/flow/rating/rating.service.ts' },
}

/**
 * The SAME structure with the SAME leading verbs and the same generic path words
 * ("src", "flow", "service"), named throughout after report workflow stages while
 * doing the same unrelated invoice work. Holding the verbs fixed matters: Madar
 * legitimately prefers action-shaped method names such as `generate`/`start`/
 * `process`, and that generic preference must not be mistaken for report naming.
 */
const REPORT_NAMED = {
  route: { label: '.submitReport()', file: '/src/entry/entry.controller.ts' },
  trigger: { label: '.beginPlanner()', file: '/src/flow/trigger.service.ts' },
  queue: { label: '.enqueueResearch()', file: '/src/flow/queue-registry.service.ts' },
  worker: { label: '.consume()', file: '/src/flow/orchestrator.worker.ts' },
  assembler: { label: '.combineAssembly()', file: '/src/flow/assembly/assembly.service.ts' },
  scorer: { label: '.rateScoring()', file: '/src/flow/scoring/scoring.service.ts' },
}

/** A repository with no multi-stage generation structure at all. */
function flatDisplayGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'toggle', label: '.applyTheme()', file_type: 'code', source_file: '/src/ui/theme-toggle.ts', source_location: 'L4', node_kind: 'method', community: 0 },
          { id: 'store', label: '.readPalette()', file_type: 'code', source_file: '/src/ui/color-store.ts', source_location: 'L8', node_kind: 'method', community: 0 },
        ],
        edges: [
          { source: 'toggle', target: 'store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/ui/theme-toggle.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function retrieve(graph: ReturnType<typeof flatDisplayGraph>, question: string) {
  return retrieveContext(graph, { question, budget: 4000, retrievalLevel: 4, retrievalStrategy: 'slice-v1' })
}

/** Slice membership is observable through the matched nodes the slice selected. */
function memberIds(result: RetrieveResult): string[] {
  return result.matched_nodes.map((node) => node.node_id ?? node.label)
}

function structuralShape(result: RetrieveResult) {
  return {
    member_ids: memberIds(result),
    anchor_reasons: (result.slice?.anchors ?? []).map((anchor) => anchor.reason),
    anchor_count: (result.slice?.anchors ?? []).length,
    paths: (result.slice?.selected_paths ?? []).map((path) => `${path.from}-[${path.relation}]->${path.to}`),
    mode: result.slice?.mode,
  }
}

/**
 * The same slice keyed by NODE ID rather than label. Both fixture graphs use the
 * same ids for the same structural positions and differ only in what the symbols
 * are called, so an id-keyed shape isolates policy from naming completely: if the
 * two shapes differ, a name changed a structural decision.
 */
function shapeByPosition(result: RetrieveResult) {
  return {
    member_ids: memberIds(result),
    anchor_ids: (result.slice?.anchors ?? []).map((anchor) => anchor.node_id),
    anchor_reasons: (result.slice?.anchors ?? []).map((anchor) => anchor.reason),
    paths: (result.slice?.selected_paths ?? []).map((path) => `${path.from_id}-[${path.relation}]->${path.to_id}`),
  }
}

function instructionsFor(question: string, retrieval: Partial<RetrieveResult> = {}) {
  const decision = classifyRetrievalLevel({ prompt: question })
  const pack = buildMadarPromptPack({
    question,
    retrieval: {
      question,
      token_count: 120,
      matched_nodes: [],
      relationships: [],
      community_context: [],
      graph_signals: { god_nodes: [], bridge_nodes: [] },
      retrieval_gate: {
        level: decision.level,
        reason: decision.reason,
        skipped_retrieval: false,
        intent: decision.intent,
        signals: decision.signals,
      },
      ...retrieval,
    } as RetrieveResult,
  })
  return pack.prompt.split('\n\nRetrieved graph context:')[0]?.split('\n') ?? []
}

describe('#660 Slice C — report-generation independence', () => {
  // ------------------------------------------------------------- control A --
  it('A: report vocabulary alone produces no fixed workflow, no boost, no forced anchor and no gate variant', () => {
    // The MINIMAL pair. Both prompts are display-shaped and carry no backend
    // marker; they differ only by the qualification task's own name. Before
    // Slice C the second one was pulled to runtime_generation by
    // `reportGenerationShaped` alone. Now both take the generic display outcome.
    const withoutTaskName = classifyRetrievalLevel({ prompt: 'Explain how the summary is generated and displayed' })
    const withTaskName = classifyRetrievalLevel({ prompt: 'Explain how the idea report is generated and displayed in the footer' })

    expect(withTaskName.signals.generation_debug?.report_generation_shaped).toBe(false)
    expect(withTaskName.signals.generation_intent).toBe(withoutTaskName.signals.generation_intent)
    expect(withTaskName.signals.target_domain_hint).toBe(withoutTaskName.signals.target_domain_hint)
    expect(withTaskName.signals.generation_intent).toBe('display_rendering')

    // The gate still responds to GENERIC evidence, so this is not a constant:
    // adding a real backend-runtime marker moves it, and the report words do not.
    const withBackendMarker = classifyRetrievalLevel({ prompt: 'Explain how the summary is generated and displayed by the worker pipeline' })
    expect(withBackendMarker.signals.generation_intent).toBe('runtime_generation')

    // No manufactured workflow over a repository with no such structure: the
    // instructions are exactly the two unconditional ones.
    const question = `Explain how the ${REPORT_WORDS} ${REPORT_DISPLAY_WORDS} flow is displayed on the page`
    expect(instructionsFor(question)).toEqual(BASE_INSTRUCTIONS)

    // No forced candidate and no report-specific ranking over a flat repository.
    const shape = structuralShape(retrieve(flatDisplayGraph(), question))
    expect(shape.anchor_reasons).not.toContain('generation core heuristic')
    expect(shape.member_ids.length).toBeLessThanOrEqual(2)
  })

  // ------------------------------------------------------------- control B --
  it('B: the same repository and task intent yield the same structure under neutral and report wording', () => {
    // Equivalent intent over identical evidence. The only difference is the
    // retired qualification vocabulary, so nothing structural may move.
    const neutral = retrieve(reverseFlowGraph(NEUTRAL_NAMES), NEUTRAL_Q)
    const report = retrieve(reverseFlowGraph(NEUTRAL_NAMES), REPORT_Q)

    // Same generic classification, so any structural difference could only come
    // from the report words themselves.
    expect(classifyRetrievalLevel({ prompt: REPORT_Q }).signals.generation_intent)
      .toBe(classifyRetrievalLevel({ prompt: NEUTRAL_Q }).signals.generation_intent)
    expect(structuralShape(report)).toEqual(structuralShape(neutral))
    expect(structuralShape(report).anchor_reasons).not.toContain('generation core heuristic')
  })

  // ------------------------------------------------------------- control C --
  it('C: identical structure named after report stages earns no extra structural treatment', () => {
    // The sharp form: ONE prompt containing no report vocabulary at all, run
    // over two graphs that differ only in what their symbols are CALLED, and
    // compared by NODE ID so naming cannot leak into the comparison itself.
    //
    // The prompt names the shared `flow` path segment on purpose. That makes the
    // nodes source-path matches, which is what puts them through the runtime
    // anchor SCORING path -- without it the score table is never consulted and
    // this control could not catch a name-driven entry being restored.
    const neutralPrompt = 'Explain how the daily digest is generated end to end through the runtime pipeline in flow'
    const neutralNamed = shapeByPosition(retrieve(reverseFlowGraph(NEUTRAL_NAMES), neutralPrompt))
    const reportNamed = shapeByPosition(retrieve(reverseFlowGraph(REPORT_NAMED), neutralPrompt))

    expect(reportNamed).toEqual(neutralNamed)

    // Proof the comparison has teeth: the scoring path really is reached, so a
    // restored name-driven entry would move these positions.
    expect(neutralNamed.anchor_ids.length).toBeGreaterThan(0)
  })

  it('C2: a report-shaped prompt over report-named symbols still gets no table, chain, instruction or forced pick', () => {
    const shape = structuralShape(retrieve(reverseFlowGraph(REPORT_NAMED), REPORT_Q))

    // No forced selection, and every anchor reason is one of the ordinary
    // evidence reasons rather than a report heuristic.
    expect(shape.anchor_reasons).not.toContain('generation core heuristic')
    for (const reason of shape.anchor_reasons) {
      expect(['symbol mention', 'path mention', 'source path token match', 'top lexical match']).toContain(reason)
    }
    // No special phase chain and no fixed report instruction.
    expect(instructionsFor(REPORT_Q)).toEqual(BASE_INSTRUCTIONS)
  })

  // ------------------------------------------------------------- control D --
  it('D: the pre-existing non-qualification parity golden still carries its typed evidence instructions', () => {
    // tests/fixtures/prompt-pack-parity.golden.json was captured from a commit
    // BEFORE any #660 production edit, over a login/session flow named nothing
    // like a report. Its instructions come from the typed answer_contract that
    // runtimeGenerationContractPhaseElements derives from execution-slice
    // evidence, so they must survive the removal of the report classifier.
    const golden = JSON.parse(readFileSync(resolve('tests/fixtures/prompt-pack-parity.golden.json'), 'utf8')) as Record<string, { prompt: string }>
    const recorded = golden.normal_context_prompt?.prompt ?? ''

    expect(recorded).toContain('Treat HTTP/controller entrypoints as trigger context, not the full answer.')
    expect(recorded).toContain('Follow persistence evidence before concluding the flow.')
    expect(recorded).toContain('Do not collapse producer-to-worker handoffs into direct calls when the evidence is an enqueues_job boundary.')
    expect(recorded).toContain('Mention missing or uncertain phases when the execution slice is partial.')

    // And the retired fixed workflow is absent from that pre-existing golden.
    expect(recorded).not.toContain('Follow planner, research, assembly, scoring, rendering, and persistence evidence')
    expect(recorded).not.toContain('when downstream generation-core evidence is present')
  })

  it('D2: typed contract elements, not prompt words, decide the evidence instructions', () => {
    const typed = {
      execution_slice: {
        status: 'partial' as const,
        steps: [],
        phase_coverage: {
          expected: ['controller', 'queue', 'worker', 'persistence'] as ContextPackExecutionPhase[],
          observed: ['controller', 'queue'] as ContextPackExecutionPhase[],
          missing: ['worker', 'persistence'] as ContextPackExecutionPhase[],
        },
      },
      answer_contract: {
        version: 1 as const,
        answer_focus: 'runtime_generation' as const,
        entrypoint_scope: 'setup_context' as const,
        required_elements: ['main_pipeline_phases', 'queue_worker_handoff', 'persistence_or_artifact_storage'],
        do_not_claim: ['direct_producer_to_worker_calls_without_enqueues_boundary'],
        observed_phases: ['controller', 'queue'] as ContextPackExecutionPhase[],
        missing_phases: ['worker', 'persistence'] as ContextPackExecutionPhase[],
      },
    }

    const neutral = instructionsFor(NEUTRAL_Q, typed)
    const report = instructionsFor(REPORT_Q, typed)

    // Same typed evidence in, same instructions out, regardless of wording.
    expect(report).toEqual(neutral)
    expect(neutral).toContain('Follow persistence evidence before concluding the flow.')
    // The persistence line is earned by the typed element; the retired fixed
    // report workflow never appears.
    expect(neutral.join('\n')).not.toContain('planner, research, assembly, scoring, rendering')

    // Withdraw the typed element and the instruction goes with it: the control
    // fails in both directions rather than merely observing a constant.
    const withoutPersistence = instructionsFor(NEUTRAL_Q, {
      ...typed,
      answer_contract: { ...typed.answer_contract, required_elements: ['main_pipeline_phases'] },
    })
    expect(withoutPersistence).not.toContain('Follow persistence evidence before concluding the flow.')
    expect(withoutPersistence).toContain('Cover the main runtime pipeline phases instead of stopping at the entrypoint.')
  })
})
