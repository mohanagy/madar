import { describe, expect, it } from 'vitest'

import {
  classifyRetrievalLevel,
  type RetrievalGateInput,
} from '../../src/runtime/retrieval-gate.js'

function classify(input: Partial<RetrievalGateInput> & { prompt: string }) {
  return classifyRetrievalLevel(input as RetrievalGateInput)
}

describe('classifyRetrievalLevel — example decisions from issue #75', () => {
  it('rename without reference → level 0 (no retrieval needed)', () => {
    const decision = classify({ prompt: 'Rename this variable' })
    expect(decision.level).toBe(0)
    expect(decision.skipped_retrieval).toBe(true)
    expect(decision.intent).toBe('rename')
    expect(decision.reason).toMatch(/no retrieval/i)
  })

  it('rename with explicit symbol → level 1 (local symbol/file)', () => {
    const decision = classify({ prompt: 'Rename the variable `userCount` in this file' })
    expect(decision.level).toBe(1)
    expect(decision.intent).toBe('rename')
    expect(decision.signals.mentioned_symbols).toContain('userCount')
  })

  it('explain with mention → level 2 (direct dependencies)', () => {
    const decision = classify({ prompt: 'Explain this function `parseConfig`' })
    expect(decision.level).toBe(2)
    expect(decision.intent).toBe('explain')
    expect(decision.reason).toMatch(/direct dependencies/i)
  })

  it('explain without mention → level 1 (local context)', () => {
    const decision = classify({ prompt: 'Explain this function' })
    expect(decision.level).toBe(1)
    expect(decision.intent).toBe('explain')
  })

  it('implement prompt → level 2 (direct dependencies)', () => {
    const decision = classify({ prompt: 'Implement issue #275 by collecting implementation context for changed files' })
    expect(decision.level).toBe(2)
    expect(decision.intent).toBe('implement')
    expect(decision.reason).toMatch(/direct dependencies/i)
  })

  it('migrate prompt → level 2 (direct dependencies)', () => {
    const decision = classify({ prompt: 'Migrate the pack task inference to the new implementation taxonomy' })
    expect(decision.level).toBe(2)
    expect(decision.intent).toBe('migrate')
    expect(decision.reason).toMatch(/direct dependencies/i)
  })

  it('document prompt → level 1 (local context)', () => {
    const decision = classify({ prompt: 'Document the new pack task inference behavior' })
    expect(decision.level).toBe(1)
    expect(decision.intent).toBe('document')
    expect(decision.reason).toMatch(/local context/i)
  })

  it('debug "why" prompt → level 3 (behavior slice)', () => {
    const decision = classify({ prompt: 'Why is report generation slow?' })
    expect(decision.level).toBe(3)
    expect(decision.intent).toBe('debug')
    expect(decision.reason).toMatch(/behavior slice/i)
  })

  it('PR break-onboarding question with diff → level 5 (full PR impact pack)', () => {
    const decision = classify({ prompt: 'Can this PR break onboarding?', hasPrDiff: true })
    expect(decision.level).toBe(5)
    expect(decision.intent).toBe('impact')
    expect(decision.reason).toMatch(/PR (diff|impact pack)/i)
  })

  it('test prompt with mention → level 3 (behavior slice)', () => {
    const decision = classify({ prompt: 'What tests should I add for `parseConfig`?' })
    expect(decision.level).toBe(3)
    expect(decision.intent).toBe('test')
  })

  it('test prompt without mention → level 4 (cross-module impact)', () => {
    const decision = classify({ prompt: 'What tests should I add?' })
    expect(decision.level).toBe(4)
    expect(decision.intent).toBe('test')
  })
})

describe('classifyRetrievalLevel — escalation signals', () => {
  it('stack trace forces level 3 even when intent looks like rename', () => {
    const decision = classify({
      prompt: [
        'rename this variable',
        '    at handleRequest (server.ts:42:7)',
      ].join('\n'),
    })
    expect(decision.level).toBe(3)
    expect(decision.signals.has_stack_trace).toBe(true)
    expect(decision.reason).toMatch(/stack trace/i)
  })

  it('Error: prefix is recognized as a stack-trace signal', () => {
    const decision = classify({ prompt: 'Error: cannot read properties of undefined' })
    expect(decision.signals.has_stack_trace).toBe(true)
    expect(decision.level).toBe(3)
  })

  it('PR diff + review intent → level 5', () => {
    const decision = classify({ prompt: 'Please review this PR carefully', hasPrDiff: true })
    expect(decision.level).toBe(5)
    expect(decision.intent).toBe('review')
  })

  it('PR diff + impact intent → level 5', () => {
    const decision = classify({ prompt: 'What does this PR break?', hasPrDiff: true })
    expect(decision.level).toBe(5)
  })

  it('PR diff alone (no review/impact/test intent) does not escalate to level 5', () => {
    const decision = classify({ prompt: 'Explain this function `foo`', hasPrDiff: true })
    expect(decision.level).toBe(2)
  })

  it('review intent without PR diff falls back to behavior slice (level 3)', () => {
    const decision = classify({ prompt: 'Review this code carefully' })
    expect(decision.level).toBe(3)
    expect(decision.intent).toBe('review')
  })
})

describe('classifyRetrievalLevel — chitchat and unknowns', () => {
  it('"hi" → level 0 (chitchat)', () => {
    const decision = classify({ prompt: 'hi' })
    expect(decision.level).toBe(0)
    expect(decision.intent).toBe('chitchat')
    expect(decision.skipped_retrieval).toBe(true)
  })

  it('"thanks" → level 0', () => {
    const decision = classify({ prompt: 'thanks!' })
    expect(decision.level).toBe(0)
    expect(decision.intent).toBe('chitchat')
  })

  it('vague "do something" prompt → level 1 (default to local)', () => {
    const decision = classify({ prompt: 'do something useful here' })
    expect(decision.level).toBe(1)
    expect(decision.intent).toBe('unknown')
    expect(decision.reason).toMatch(/default to local/i)
  })
})

describe('classifyRetrievalLevel — manual override', () => {
  it('respects an explicit override regardless of intent', () => {
    const decision = classify({ prompt: 'Why is this slow?', manualOverride: 0 })
    expect(decision.level).toBe(0)
    expect(decision.skipped_retrieval).toBe(true)
    expect(decision.reason).toBe('manual override')
    // Intent is still detected for transparency — only the level is overridden.
    expect(decision.intent).toBe('debug')
  })

  it('override of level 5 forces full pack even on a chitchat prompt', () => {
    const decision = classify({ prompt: 'hi', manualOverride: 5 })
    expect(decision.level).toBe(5)
    expect(decision.reason).toBe('manual override')
  })
})

describe('classifyRetrievalLevel — signal extraction', () => {
  it('extracts file paths from a free-form prompt', () => {
    const decision = classify({ prompt: 'Why does src/auth/auth-service.ts crash on login?' })
    expect(decision.signals.mentioned_paths).toContain('src/auth/auth-service.ts')
    expect(decision.intent).toBe('debug')
  })

  it('extracts backtick-quoted symbols', () => {
    const decision = classify({ prompt: 'Refactor `UsersService.findById`' })
    expect(decision.signals.mentioned_symbols).toContain('UsersService.findById')
    expect(decision.intent).toBe('refactor')
  })

  it('caller-supplied mentions override prompt detection', () => {
    const decision = classify({
      prompt: 'Explain this',
      mentionedSymbols: ['MyClass'],
    })
    expect(decision.signals.mentioned_symbols).toEqual(['MyClass'])
    // mentions present → level 2
    expect(decision.level).toBe(2)
  })

  it('extracts explicit Class.method references even without backticks', () => {
    const decision = classify({ prompt: 'Trace IdeasController.generateFromProblem through the runtime pipeline' })
    expect(decision.signals.mentioned_symbols).toContain('IdeasController.generateFromProblem')
  })

  it('extracts lowercase module.function references', () => {
    const decision = classify({ prompt: 'Trace utils.parseDate through the runtime pipeline' })
    expect(decision.signals.mentioned_symbols).toContain('utils.parseDate')
  })

  it('detects broad runtime-generation prompts without explicit symbols', () => {
    const decision = classify({ prompt: 'Explain how idea report is getting generated' })
    expect(decision.signals.generation_intent).toBe('runtime_generation')
    expect(decision.signals.target_domain_hint).toBe('backend_runtime')
  })

  it('escalates natural runtime-generation prompts to behavior-slice retrieval', () => {
    const decision = classify({ prompt: 'How idea report is being generated' })
    expect(decision.signals.generation_intent).toBe('runtime_generation')
    expect(decision.signals.target_domain_hint).toBe('backend_runtime')
    expect(decision.level).toBe(3)
    expect(decision.reason).toMatch(/runtime generation|behavior slice/i)
  })

  it('detects frontend display prompts separately from runtime generation prompts', () => {
    const decision = classify({ prompt: 'Where is the generated date displayed in the report footer?' })
    expect(decision.signals.generation_intent).toBe('display_rendering')
    expect(decision.signals.target_domain_hint).toBe('frontend_display')
  })

  it('keeps generated-report UI prompts out of backend runtime routing', () => {
    const decision = classify({ prompt: 'How is the generated report rendered in the UI?' })
    const signals = decision.signals as typeof decision.signals & {
      generation_debug?: {
        display_shaped: boolean
        generic_generation_shaped: boolean
        backend_runtime_shaped: boolean
        report_generation_shaped: boolean
        build_static_shaped: boolean
        explanation_shaped: boolean
      }
    }

    expect(decision.level).toBe(1)
    expect(decision.signals.generation_intent).toBe('display_rendering')
    expect(decision.signals.target_domain_hint).toBe('frontend_display')
    expect(signals.generation_debug).toEqual(expect.objectContaining({
      display_shaped: true,
      generic_generation_shaped: true,
      backend_runtime_shaped: false,
      build_static_shaped: false,
    }))
  })

  it('keeps component-creation prompts out of backend runtime routing', () => {
    const decision = classify({ prompt: 'How is this component created?' })
    expect(decision.level).toBe(1)
    expect(decision.signals.generation_intent).toBe('display_rendering')
    expect(decision.signals.target_domain_hint).toBe('frontend_display')
  })

  it('keeps landing-page generation prompts out of backend runtime routing', () => {
    const decision = classify({ prompt: 'How is the landing page generated?' })
    const signals = decision.signals as typeof decision.signals & {
      generation_debug?: {
        build_static_shaped: boolean
        backend_runtime_shaped: boolean
      }
    }

    expect(decision.level).toBe(1)
    expect(decision.signals.generation_intent).toBe('unknown')
    expect(decision.signals.target_domain_hint).toBe('unknown')
    expect(signals.generation_debug).toEqual(expect.objectContaining({
      build_static_shaped: true,
      backend_runtime_shaped: false,
    }))
  })

  it('keeps Next.js page-generation prompts out of backend runtime routing', () => {
    const decision = classify({ prompt: 'How does Next.js generate this page?' })
    expect(decision.level).toBe(2)
    expect(decision.signals.generation_intent).toBe('unknown')
    expect(decision.signals.target_domain_hint).toBe('unknown')
  })

  it('prefers display rendering for mixed generated-and-displayed prompts without backend runtime markers', () => {
    const decision = classify({ prompt: 'Explain how the report is generated and displayed' })
    expect(decision.level).toBe(1)
    expect(decision.signals.generation_intent).toBe('display_rendering')
    expect(decision.signals.target_domain_hint).toBe('frontend_display')
  })

  it('prefers runtime generation for explanatory prompts that also mention display terms', () => {
    const decision = classify({ prompt: 'Explain how the idea report is generated and displayed in the footer' })
    expect(decision.signals.generation_intent).toBe('runtime_generation')
    expect(decision.signals.target_domain_hint).toBe('backend_runtime')
  })

  it('detects broad generation noun prompts without explanation verbs', () => {
    const decision = classify({ prompt: 'idea report generation pipeline' })
    expect(decision.signals.generation_intent).toBe('runtime_generation')
    expect(decision.signals.target_domain_hint).toBe('backend_runtime')
  })

  it('marks runtime flow-proof questions distinctly from generic backend explain prompts', () => {
    const flowDecision = classify({ prompt: 'How idea report is being generated' })
    const genericExplainDecision = classify({ prompt: 'Explain the auth service layer' })

    const flowSignals = flowDecision.signals as typeof flowDecision.signals & {
      generation_debug?: { flow_proof_shaped?: boolean }
    }
    const genericExplainSignals = genericExplainDecision.signals as typeof genericExplainDecision.signals & {
      generation_debug?: { flow_proof_shaped?: boolean }
    }

    expect(flowDecision.signals.generation_intent).toBe('runtime_generation')
    expect(flowDecision.signals.target_domain_hint).toBe('backend_runtime')
    expect(flowSignals.generation_debug?.flow_proof_shaped).toBe(true)

    expect(genericExplainDecision.signals.generation_intent).toBe('runtime_generation')
    expect(genericExplainDecision.signals.target_domain_hint).toBe('backend_runtime')
    expect(genericExplainSignals.generation_debug?.flow_proof_shaped).toBe(false)
  })
})

describe('classifyRetrievalLevel — exclusions and negation', () => {
  it('does not classify excluded test terms as test intent', () => {
    const decision = classify({ prompt: 'Exclude tests but explain the runtime path for report generation.' })
    const signals = decision.signals as typeof decision.signals & { excluded_domains?: string[] }

    expect(decision.intent).toBe('explain')
    expect(decision.level).toBe(3)
    expect(signals.excluded_domains).toContain('test')
  })

  it('keeps positive test prompts classified as test intent', () => {
    const decision = classify({ prompt: 'Which tests cover report generation?' })
    expect(decision.intent).toBe('test')
  })

  it('tracks benchmark exclusions without promoting benchmark/test intent', () => {
    const decision = classify({ prompt: 'Do not include benchmarks; explain the production pipeline.' })
    const signals = decision.signals as typeof decision.signals & { excluded_domains?: string[] }

    expect(decision.intent).toBe('explain')
    expect(signals.excluded_domains).toContain('benchmark')
  })

  it('captures fixture and reporter exclusions', () => {
    const decision = classify({ prompt: 'Ignore fixtures and html reporters when you explain the backend flow.' })
    const signals = decision.signals as typeof decision.signals & {
      excluded_domains?: string[]
      excluded_terms?: string[]
    }

    expect(decision.intent).toBe('explain')
    expect(signals.excluded_domains).toContain('fixture')
    expect(signals.excluded_terms).toEqual(expect.arrayContaining(['html reporters', 'reporters']))
  })
})

describe('classifyRetrievalLevel — refactor intent stays in the 0-2 band', () => {
  it('refactor with explicit reference → level 2', () => {
    const decision = classify({ prompt: 'Refactor `UsersService.findById`' })
    expect(decision.intent).toBe('refactor')
    expect(decision.signals.mentioned_symbols).toContain('UsersService.findById')
    expect(decision.level).toBe(2)
  })

  it('refactor without any explicit reference → level 2 (not over-escalated to behavior slice)', () => {
    const decision = classify({ prompt: 'Refactor this module' })
    expect(decision.intent).toBe('refactor')
    expect(decision.signals.mentioned_symbols).toEqual([])
    expect(decision.signals.mentioned_paths).toEqual([])
    expect(decision.level).toBe(2)
    expect(decision.reason).toMatch(/direct dependencies/i)
  })
})

describe('classifyRetrievalLevel — caller-supplied intent', () => {
  it('uses caller-supplied intent verbatim and skips prompt classification', () => {
    const decision = classify({ prompt: 'arbitrary text', intent: 'impact' })
    expect(decision.intent).toBe('impact')
    expect(decision.level).toBe(4)
  })
})

describe('classifyRetrievalLevel — output shape', () => {
  it('every decision carries level / skipped_retrieval / reason / intent / signals', () => {
    const decision = classify({ prompt: 'hello' })
    expect(decision).toMatchObject({
      level: expect.any(Number),
      skipped_retrieval: expect.any(Boolean),
      reason: expect.any(String),
      intent: expect.any(String),
      signals: {
        has_pr_diff: expect.any(Boolean),
        has_stack_trace: expect.any(Boolean),
        mentioned_paths: expect.any(Array),
        mentioned_symbols: expect.any(Array),
      },
    })
  })

  it('level 0 sets skipped_retrieval to true', () => {
    const decision = classify({ prompt: 'thanks' })
    expect(decision.skipped_retrieval).toBe(true)
  })

  it('any non-zero level sets skipped_retrieval to false', () => {
    const decision = classify({ prompt: 'Explain this code' })
    expect(decision.skipped_retrieval).toBe(false)
  })
})
