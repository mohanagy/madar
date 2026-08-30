// Neutral owner of normal product prompt-pack construction (#660-A).
//
// `buildMadarPromptPack` is the single builder behind three call sites: the
// normal `madar prompt` CLI path (context-prompt-command.ts), the MCP
// context-prompt tool (runtime/stdio/tools.ts), and the compare/benchmark arms
// (infrastructure/compare.ts). While it lived inside compare.ts the first two —
// ordinary product paths — carried the qualification grader loader in their
// TypeScript module graph, because compare.ts imports the runtime-proof reader.
// The separation was only a call-graph property: nothing structural stopped
// grader truth from reaching a normal prompt.
//
// This module is that structure. It sits below compare.ts and imports nothing
// from the benchmark or grader layers, so the dependency can only run one way:
// compare.ts may consume this builder, and this builder may never consume
// compare.ts or any grader module. `docs/architecture/grader-boundary.json`
// lists it as a normal-product root, which means the guard refuses to allowlist
// it even if someone later tries.
//
// This is not a supported library API. The package ships only a `bin`, and this
// module is internal to it.
import type { ContextSessionDiagnostics, ContextSessionState } from '../contracts/context-session.js'
import { buildContextPrompt } from './context-prompt.js'
import { buildAnswerReadyPackSchema, buildExplainPackPayloadCore } from './context-pack-command.js'
import { compactRetrieveResult, type RetrieveResult } from '../runtime/retrieve.js'

export interface ComparePromptPack {
  kind: 'baseline' | 'madar'
  question: string
  prompt: string
  session_payload: string
  token_count: number
  session_payload_token_count: number
  effective_token_count: number
  reused_context_tokens: number
  session_diagnostics: ContextSessionDiagnostics
  session_state: ContextSessionState
}

export interface BuildMadarPromptPackInput {
  graphPath?: string
  question: string
  retrieval: RetrieveResult
  session?: ContextSessionState
}

function answerContractInstructions(retrieval: RetrieveResult): string[] {
  const answerContract = retrieval.answer_contract
  if (!answerContract) {
    return []
  }

  const instructions = [
    'Treat HTTP/controller entrypoints as trigger context, not the full answer.',
  ]

  const requiredElements = new Set(answerContract.required_elements)
  const phaseLabels = [
    ['planner_phase', 'planner'],
    ['research_phase', 'research'],
    ['assembly_phase', 'assembly'],
    ['scoring_phase', 'scoring'],
    ['report_builder_phase', 'rendering'],
  ] as const satisfies ReadonlyArray<readonly [string, string]>
  const selectedPhaseLabels: string[] = phaseLabels.flatMap(([key, label]) => requiredElements.has(key) ? [label] : [])
  if (selectedPhaseLabels.length > 0 || requiredElements.has('persistence_or_artifact_storage')) {
    const segments = [...selectedPhaseLabels]
    if (requiredElements.has('persistence_or_artifact_storage')) {
      segments.push('persistence')
    }
    instructions.push(`Follow ${segments.join(', ')} evidence before concluding the flow.`)
  } else if (requiredElements.has('main_pipeline_phases')) {
    instructions.push('Cover the main runtime pipeline phases instead of stopping at the entrypoint.')
  }

  if (requiredElements.has('queue_worker_handoff')) {
    instructions.push('Describe queue-to-worker handoffs explicitly when the flow crosses an enqueues_job boundary.')
  }

  if (answerContract.do_not_claim.includes('direct_producer_to_worker_calls_without_enqueues_boundary')) {
    instructions.push('Do not collapse producer-to-worker handoffs into direct calls when the evidence is an enqueues_job boundary.')
  }

  if (answerContract.do_not_claim.includes('full_runtime_certainty_when_slice_is_partial')) {
    instructions.push('Mention missing or uncertain phases when the execution slice is partial.')
  }

  if (answerContract.do_not_claim.includes('irrelevant_model_or_provider_details')) {
    instructions.push('Do not mention model or provider details unless they are directly relevant to the question.')
  }

  return instructions
}

function promptWantsReportGenerationCore(prompt: string): boolean {
  return /\b(?:report(?:\s+generation)?|generated\s+report|validation\s+report|final\s+report|assembly|assemble|synthesis|renderer|render|planner|research|metrics?|scor(?:e|ing)|quality(?:\s|-)?gate)\b/i.test(prompt)
}

function generationCoreInstructions(question: string, retrieval: RetrieveResult): string[] {
  const contractInstructions = answerContractInstructions(retrieval)
  if (contractInstructions.length > 0) {
    return contractInstructions
  }

  if (
    retrieval.retrieval_gate?.signals.generation_intent !== 'runtime_generation'
    || retrieval.retrieval_gate?.signals.target_domain_hint !== 'backend_runtime'
    || !promptWantsReportGenerationCore(question)
  ) {
    return []
  }

  return [
    'Treat HTTP/controller entrypoints as trigger context, not the full answer, when downstream generation-core evidence is present.',
    'Follow planner, research, assembly, scoring, rendering, and persistence evidence before concluding the flow.',
  ]
}

export function buildMadarPromptPack(input: BuildMadarPromptPackInput): ComparePromptPack {
  const explainPayloadCore = buildAnswerReadyPackSchema(
    buildExplainPackPayloadCore(compactRetrieveResult(input.retrieval), input.retrieval),
    input.retrieval.task_contract?.budget ?? 3000,
  )
  delete explainPayloadCore.serialized_budget
  const explainPayload = JSON.stringify(explainPayloadCore, null, 2)
  const builtPrompt = buildContextPrompt({
    instructions: [
      'Answer the question using only the provided graph-guided retrieval output.',
      'If the retrieval does not contain the answer, say so.',
      ...generationCoreInstructions(input.question, input.retrieval),
    ],
    stable_prefix_title: 'Retrieved graph context',
    stable_sections: [
      {
        ref: 'explain_pack_payload',
        sort_key: '10-explain-pack-payload',
        body: explainPayload,
      },
    ],
    dynamic_sections: [
      { title: 'Question', body: input.question },
      { body: 'Answer:' },
    ],
    ...(input.session ? { session: input.session } : {}),
  })

  return {
    kind: 'madar',
    question: input.question,
    prompt: builtPrompt.prompt,
    session_payload: builtPrompt.session_payload,
    token_count: builtPrompt.metrics.raw_prompt_tokens,
    session_payload_token_count: builtPrompt.metrics.session_payload_tokens,
    effective_token_count: builtPrompt.metrics.effective_prompt_tokens,
    reused_context_tokens: builtPrompt.metrics.reused_context_tokens,
    session_diagnostics: builtPrompt.session_diagnostics,
    session_state: builtPrompt.session_state,
  }
}
