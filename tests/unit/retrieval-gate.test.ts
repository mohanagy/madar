import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileSourceExclusions } from '../../src/runtime/source-exclusions.js'
import { interpretRetrievalQuery } from '../../src/runtime/retrieve/pipeline.js'
import { queryEvidenceObligations } from '../../src/runtime/retrieve/conceptual-fallback.js'
import { describe, expect, it } from 'vitest'

import {
  classifyRetrievalLevel,
  extractPromptExclusions,
  retrievalDirectivePrompt,
  retrievalSearchPrompt,
  retrievalSubjectPrompt,
  type RetrievalGateInput,
} from '../../src/runtime/retrieval-gate.js'

function classify(input: Partial<RetrievalGateInput> & { prompt: string }) {
  return classifyRetrievalLevel(input as RetrievalGateInput)
}

describe('retrievalSearchPrompt — procedural framing', () => {
  it('ranks the code question while preserving source restrictions in the policy view', () => {
    const subject = 'Trace credential refresh through the UI and API. What authentication is required, and how are persistence failures handled?'
    const restriction = 'Do not change files, make network calls, or read secrets/environment files or runtime user data.'
    const prompt = `Use the committed repository source for this read-only analysis. ${restriction} Source, configuration, tests and the root README are the only allowed evidence. Give a concise answer with repository-relative file and line citations. ${subject}`
    expect(retrievalSearchPrompt(prompt)).toBe(subject)
    expect(retrievalSubjectPrompt(prompt)).toContain(restriction)
    expect(extractPromptExclusions(retrievalSubjectPrompt(prompt))).toEqual(extractPromptExclusions(`${restriction} ${subject}`))
    expect(retrievalSearchPrompt(`Do not read src/private.ts. ${subject}`)).toContain('Do not read src/private.ts.')
    expect(interpretRetrievalQuery({ question: prompt, budget: 3000 }).question_tokens)
      .toEqual(interpretRetrievalQuery({ question: subject, budget: 3000 }).question_tokens)
    expect(queryEvidenceObligations(prompt)).toEqual(queryEvidenceObligations(subject))
    expect(interpretRetrievalQuery({ question: `Do not read src/private.ts. ${prompt}`, budget: 3000 })
      .retrieval_gate.signals.excluded_terms).toContain('src/private.ts')
  })

  it('handles procedural suffixes and alternative subjects without dropping behavior words', () => {
    const subject = 'How do tests verify configuration precedence and environment secrets handling?'
    expect(retrievalSearchPrompt(`${subject} Use local source for this read-only review; provide a brief response with source references. Do not run tests or execute scripts.`)).toBe(subject)
    expect(classify({ prompt: `${subject} Source, tests, and configuration are the only evidence.` })).toEqual(classify({ prompt: subject }))
  })

  it('retains questions, conditional requirements, explicit targets, and quoted instruction text', () => {
    for (const prompt of [
      'Why does the server not read secrets/environment files or runtime user data?',
      'Do not change authentication behavior when credentials expire. Explain the current behavior.',
      'Read only tests. Explain configuration precedence in README.md.',
      'Give a concise answer with code citations about token expiry.',
      'Explain "Do not run tests" and `Use local source for this read-only review`.',
      'Explain this warning:\n```text\nDo not run tests.\nSource, tests and configuration are the only evidence.\n```',
    ]) expect(retrievalSearchPrompt(prompt)).toBe(prompt)
  })
})

describe('extractPromptExclusions — instructions versus described behavior', () => {
  it('ignores example operators while retaining outside quoted source scopes', () => {
    const prompt = '```inline code```\nExclude `auth.ts`.\n````text\nExclude hidden.ts.\n```\n````\n"a wrapped quote:\nExclude private.ts."\nExplain run().'
    expect(extractPromptExclusions(prompt).excludedTerms).toEqual(['auth.ts'])
    const directives = retrievalDirectivePrompt(prompt)
    expect(directives).toContain('Explain run().')
    expect(directives).not.toMatch(/Exclude|auth|hidden|private|inline/)
    expect(extractPromptExclusions(prompt).positivePrompt).toContain('hidden.ts')
  })

  it.each([
    'How does default code file discovery exclude sensitive filenames and directories, apply source-file exemptions, and record exclusion reason strings and paths?',
    'Explain how a loader excludes generated entries.',
    'Which files does the loader ignore?',
    'How does the worker skip cached jobs without losing retries?',
    'Why does the parser not include empty records?',
    'Explain what happens when no files match.',
    'If no records remain, how does recovery proceed?',
    'Explain how the reader handles every field except the delimiter.',
    'The loader may ignore unknown fields; explain why.',
    'Explain the error `ignore invalid records`.',
    'Explain the error "exclude invalid fields".',
    "Explain the error 'skip missing values'.",
    'No records remain; explain recovery.',
    'Explain changes not committed yet.',
    'Show entries with no parent.',
    'Do not exclude tests; explain the runtime.',
    'How does the loader include files but ignore generated entries?',
    'Explain why loaders include files but ignore generated entries.',
    'Find source for fallback without a credential, records with no parent, and values not null. Explain how loaders include files, ignore generated entries, and report failures.',
    'No response schema; show generated fields without configuration.',
  ])('retains the entire behavior question: %s', prompt => {
    expect(extractPromptExclusions(prompt)).toEqual({
      excludedTerms: [], excludedPathHints: [], excludedDomains: [], positivePrompt: prompt,
    })
    expect(classify({ prompt }).signals.excluded_terms ?? []).toEqual([])
  })

  it.each([
    ['Exclude tests.', 'tests'],
    ['Please ignore fixtures.', 'fixtures'],
    ['Can you omit benchmarks?', 'benchmarks'],
    ['Explain the pipeline but ignore tests.', 'tests'],
    ['Explain how the pipeline works, but ignore tests.', 'tests'],
    ['Show the pipeline excluding tests.', 'tests'],
    ['Please do not include docs.', 'docs'],
    ["Please don't include docs.", 'docs'],
    ['Explain the pipeline without fixtures.', 'fixtures'],
    ['Show source except generated.', 'generated'],
    ['Explain runtime, not tests.', 'tests'],
    ['No tests; explain runtime.', 'tests'],
    ['Exclude `tests`; explain runtime.', 'tests'],
  ])('preserves explicit scope in %s', (prompt, term) => {
    expect(extractPromptExclusions(prompt).excludedTerms).toEqual([term])
    expect(extractPromptExclusions(prompt).positivePrompt).not.toContain(term)
  })

  it.each([
    ['Explain how the reader ignores missing fields; exclude docs.', 'docs', 'Explain how the reader ignores missing fields'],
    ['Which files does the loader ignore? Please exclude benchmarks.', 'benchmarks', 'Which files does the loader ignore?'],
    ['Explain `exclude tests`; exclude docs.', 'docs', 'Explain `exclude tests`'],
    ['Explain how retry works without cached state. Ignore fixtures.', 'fixtures', 'Explain how retry works without cached state.'],
    ['Find fallback without a credential, and exclude docs, and ignore fixtures.', ['docs', 'fixtures'], 'Find fallback without a credential'],
  ])('keeps behavior evidence while applying an explicit later instruction: %s', (prompt, term, subject) => {
    const parsed = extractPromptExclusions(prompt)
    expect(parsed.excludedTerms).toEqual(Array.isArray(term) ? term : [term])
    expect(parsed.positivePrompt).toContain(subject)
  })
})

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
  it('recognizes quoted slash-qualified paths without treating quoted members as paths', () => {
    for (const prompt of ['Explain "src/auth.ts".', "Explain 'src/auth.ts'.", '{"path":"src/auth.ts"}']) {
      expect(classify({ prompt }).signals.mentioned_paths).toContain('src/auth.ts')
    }
    for (const prompt of ['Explain "Promise.all".', "Explain 'client.auth.run'.", 'Explain "auth.ts".']) {
      expect(classify({ prompt }).signals.mentioned_paths).toEqual([])
    }
  })

  it('extracts file paths from a free-form prompt', () => {
    const decision = classify({ prompt: 'Why does src/auth/auth-service.ts crash on login?' })
    expect(decision.signals.mentioned_paths).toContain('src/auth/auth-service.ts')
    expect(decision.intent).toBe('debug')
    const scoped = classify({ prompt: 'Explain runtime behavior in app.ts and lib/, "src/runtime/", ./lib/ and src\\helpers\\.' })
    expect(scoped.signals.mentioned_paths).toEqual(['app.ts'])
    expect(scoped.signals.mentioned_directories).toEqual(['lib/', 'src/runtime/', 'src/helpers/'])
    for (const prompt of ['Explain ../lib/', 'Explain /lib/', 'Explain https://example.com/lib/', 'Explain C:\\lib\\', 'Explain source but exclude lib/']) {
      expect(classify({ prompt }).signals.mentioned_directories).toBeUndefined()
    }
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

  it('treats execution-owner questions as behavior traces', () => {
    const decision = classify({ prompt: 'What runs the monthly billing close?' })

    expect(decision.intent).toBe('explain')
    expect(decision.level).toBe(3)
    expect(decision.reason).toMatch(/runtime flow|behavior slice/i)
    expect(decision.signals.generation_debug?.flow_proof_shaped).toBe(true)
  })
})

describe('classifyRetrievalLevel — exclusions and negation', () => {
  it.each(['', ' in this workspace', ' from the repository', ' within the working directory'])('does not turn an evidence allowlist into test intent or a README lookup: %s', location => {
    const subject = 'How do content-ref context sessions compare input content hashes with previous state to produce added, updated, reused, invalidated refs, reused token counts, and next revision, and how are duplicate refs handled?'
    const scoped = classify({ prompt: `${subject} Use only source, tests, configuration, and root README.md${location}.` })
    expect(scoped).toEqual(classify({ prompt: subject }))
  })

  it.each([
    ['Write tests for duplicate session refs.', 'test'],
    ['Why are context-session tests failing?', 'debug'],
    ['Which tests cover duplicate session refs?', 'test'],
  ])('keeps the actual task intent for %s with an evidence allowlist', (subject, intent) => {
    const scoped = classify({ prompt: `${subject} Use source, tests, configuration, and root README.md only.` })
    expect(scoped.intent).toBe(intent)
    expect(scoped).toEqual(classify({ prompt: subject }))
  })

  it.each(['Explain the README.md setup steps.', 'Use README.md to explain setup steps.', 'Read only tests.'])('preserves a real source target in %s', prompt => {
    const decision = classify({ prompt })
    if (prompt.includes('README.md')) expect(decision.signals.mentioned_paths).toContain('README.md')
    else expect(decision.intent).toBe('test')
  })

  it('separates prohibited agent actions from excluded evidence', () => {
    expect(extractPromptExclusions('Trace record processing, excluding secondStep.').excludedTerms).toEqual(['secondStep'])
    expect(extractPromptExclusions('Explain how processing runs without secondStep.').excludedTerms).toEqual([])
    const symbol = compileSourceExclusions(['secondStep'], ['secondstep'])
    expect(symbol.matchesLabel('secondStep()')).toBe(true)
    expect(symbol.matchesLabel('firstStep()')).toBe(false)
    expect(symbol.matchesText('function secondStep(current) { return current }')).toBe(true)
    for (const [operand, unrelated] of [['open()', 'openConnection()'], ['$fetch', 'fetch()'], ['config.load', 'config.save()']]) {
      for (const quote of ['', '`', '"', "'"]) {
        const parsed = extractPromptExclusions(`Trace processing, excluding ${quote}${operand}${quote}.`)
        expect(parsed.excludedTerms).toEqual([operand])
        expect(parsed.excludedDomains).toEqual([])
        const matcher = compileSourceExclusions(parsed.excludedTerms, parsed.excludedPathHints)
        expect(matcher.matchesLabel(operand!)).toBe(true)
        expect(matcher.matchesLabel(unrelated!)).toBe(false)
        expect(matcher.matchesPath('src/config/open/fetch.ts')).toBe(false)
      }
      expect(extractPromptExclusions(`Explain how processing runs without ${operand}.`).excludedTerms).toEqual([])
    }
    for (const artifact of ['README', '__tests__', 'CONFIG']) {
      const parsed = extractPromptExclusions(`Exclude ${artifact}. Explain processing.`)
      expect(parsed.excludedDomains.length).toBeGreaterThan(0)
      expect(compileSourceExclusions(parsed.excludedTerms, parsed.excludedPathHints).matchesPath(`${artifact}/other.ts`)).toBe(true)
    }
    const decision = classify({ prompt: 'Do not read outside this workspace, browse the web, change files, invoke another agent/model, or run tests. Exclude benchmarks and fixtures. Explain computeTotal.' })
    expect(decision.signals.excluded_terms).toEqual(['benchmarks', 'fixtures'])
    expect(decision.signals.excluded_domains).toEqual(['benchmark', 'fixture'])
    const alternate = classify({ prompt: 'No run tests or docs. Without read outside this workspace. No tests, and ignore fixtures. Do not run tests, and exclude benchmarks. Explain computeTotal.' })
    expect(alternate.intent).toBe('explain')
    expect(alternate.signals.excluded_terms).toEqual(['docs', 'tests', 'fixtures', 'benchmarks'])
    expect(alternate.signals.excluded_domains).toEqual(['docs', 'test', 'fixture', 'benchmark'])
  })

  it.each([
    'do not infer them by trying to match strings',
    'Do not assume tests describe every case',
    'Please do not compare source with generated output',
  ])('keeps action prohibitions out of evidence filters: %s', action => {
    const parsed = extractPromptExclusions(`${action}. Explain picomatch.toRegex().`)
    expect(parsed.excludedTerms).toEqual([])
    expect(parsed.excludedPathHints).toEqual([])
    expect(parsed.excludedDomains).toEqual([])
    expect(parsed.positivePrompt).toContain('Explain picomatch.toRegex().')
  })

  it.each([
    ['Do not read docs or fixtures.', ['docs', 'fixtures']],
    ['Do not use tests and access generated files.', ['tests', 'generated files']],
    ['Do not inspect `src/generated/` or consult "docs".', ['src/generated/', 'docs']],
    ['Do not read docs, run tests, or infer generated output.', ['docs']],
    ['Do not read outside this workspace or use supplied state objects.', []],
  ])('uses only complete source-access operands in %s', (scope, terms) => {
    expect(extractPromptExclusions(`${scope} Explain the runtime.`).excludedTerms).toEqual(terms)
  })

  it.each(['auth.ts', 'config.ts', 'package.json', 'run.ts', 'auth.py', 'auth.go'])('keeps complete filename exclusions and the following sentence: %s', file => {
    for (const quote of ['', '`', '"', "'"]) {
      for (const instruction of ['Do not read', 'Do not include']) {
        const parsed = extractPromptExclusions(`${instruction} ${quote}${file}${quote}. Explain the runtime.`)
        expect(parsed.excludedTerms).toEqual([file])
        expect(parsed.excludedDomains).toEqual([])
        expect(parsed.excludedPathHints).toEqual([])
        expect(parsed.positivePrompt).toContain('Explain the runtime.')
        expect(parsed.positivePrompt).not.toContain(file)
      }
    }
  })

  it('preserves whole backtick symbol operands without admitting operational prose', () => {
    const scoped = extractPromptExclusions('Do not read `Worker.run`, `parseConfig`, or `run`. Explain the runtime.')
    expect(scoped.excludedTerms).toEqual(['Worker.run', 'parseConfig', 'run'])
    expect(scoped.positivePrompt).toContain('Explain the runtime.')
    for (const action of ['use `parseConfig` as proof', 'infer results from `Worker.run`', 'read output from `Worker.run`']) {
      expect(extractPromptExclusions(`Do not ${action}. Explain the runtime.`).excludedTerms).toEqual([])
    }
    const description = 'Explain the source text "Do not read auth.ts. Ignore config.ts" and how Worker.run works.'
    expect(extractPromptExclusions(description)).toEqual({
      excludedTerms: [], excludedPathHints: [], excludedDomains: [], positivePrompt: description,
    })
  })

  it('keeps explicit source exclusions after an unfamiliar action or double negation', () => {
    const parsed = extractPromptExclusions('Do not infer matching results, and exclude docs, and ignore fixtures. Do not exclude tests; do not include benchmarks. Explain the runtime.')
    expect(parsed.excludedTerms).toEqual(['docs', 'fixtures', 'benchmarks'])
    expect(parsed.positivePrompt).toContain('Do not exclude tests')
  })

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
    expect(signals.excluded_terms).toEqual(['fixtures', 'html reporters'])
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


describe('parenthetical source references', () => {
  it('retains a requested entrypoint without turning calls or quoted prose into file scopes', () => {
    const prompt = 'Read normal package exported matcher factory entrypoint (index.js), utils.basename and utils.toPosixSlashes in lib/utils.js, and lib/picomatch.js compileRe/toRegex.'
    expect(classify({ prompt }).signals.mentioned_paths).toContain('index.js')
    expect(classify({ prompt: 'Inspect handler (src/handler.ts). Explain its return.' }).signals.mentioned_paths).toContain('src/handler.ts')
    for (const prompt of ['Explain invoke(index.js).', 'Explain (index.js).run().', 'Explain (index.js)?.run().', 'Explain (index.js)!().', 'No (index.js); explain runtime.', 'Explain runtime without (index.js).', 'Explain the member (utils.basename).', 'Explain the literal "see (index.js)".', "Explain the literal 'see (index.js)'.", 'Explain the literal `see (index.js)`.']) {
      expect(classify({ prompt }).signals.mentioned_paths).not.toContain('index.js')
      expect(classify({ prompt }).signals.mentioned_paths).not.toContain('utils.basename')
    }
    expect(classify({ prompt: 'Explain the worker. Exclude (index.js).' }).signals.mentioned_paths).not.toContain('index.js')
  })
})


describe('compiled source exclusions', () => {
  it.each(['model internals', 'transport diagnostics', 'tenant caching'])('keeps the complete generic operand %s', phrase => {
    const [first, second] = phrase.split(' ') as [string, string]
    const parsed = extractPromptExclusions(`Ignore ${phrase}. Explain the caller.`)
    expect(parsed.excludedTerms).toEqual([phrase])
    expect(parsed.excludedPathHints).toEqual([`${first}-${second}`])
    expect(parsed.excludedDomains).toEqual([])
    const matcher = compileSourceExclusions(parsed.excludedTerms, parsed.excludedPathHints, '/workspace')
    expect(matcher.valid).toBe(true)
    expect(matcher.matchesText(`// pay for the ${first} call before completion`)).toBe(false)
    expect(matcher.matchesText(`// unrelated parser ${second}`)).toBe(false)
    expect(matcher.matchesText(`${second} ${first}`)).toBe(false)
    expect(matcher.matchesText(`${first} unrelated ${second}`)).toBe(false)
    expect(matcher.matchesText(`// inspect ${phrase}`)).toBe(true)
    expect(matcher.matchesLabel(`${first}${second[0]!.toUpperCase()}${second.slice(1)}()`)).toBe(true)
    expect(matcher.matchesPath(`/workspace/src/${first}-${second}.ts`)).toBe(true)
    expect(matcher.matchesPath(`/workspace/src/${first}/caller.ts`)).toBe(false)
    const explicit = extractPromptExclusions(`Ignore ${phrase} and ${first}. Explain the caller.`)
    expect(explicit.excludedTerms).toEqual([phrase, first])
    expect(compileSourceExclusions(explicit.excludedTerms, explicit.excludedPathHints)
      .matchesText(`// pay for the ${first} call`)).toBe(true)
  })

  it('retains explicit domain aliases and refuses invalid generic operands', () => {
    for (const phrase of ['generated files', 'model config']) {
      const parsed = extractPromptExclusions(`Ignore ${phrase}. Explain the caller.`)
      expect(parsed.excludedTerms).toEqual([phrase])
      expect(parsed.excludedDomains).toContain(phrase === 'generated files' ? 'generated' : 'config')
      // Domain aliases intentionally remain broader than generic phrase matching.
      expect(compileSourceExclusions(parsed.excludedTerms, parsed.excludedPathHints)
        .matchesPath(phrase === 'generated files' ? 'src/generated/worker.ts' : 'src/config/worker.ts')).toBe(true)
    }
    const invalid = compileSourceExclusions(['a'], [], '/workspace')
    expect(invalid.valid).toBe(false)
    expect(invalid.matchesSource('/workspace/src/allowed.ts', 'allowed()')).toBe(true)
  })

  it.each(['auth.ts', 'config.ts', 'package.json', 'run.ts', 'auth.py', 'auth.go'])('matches a whole filename without extension or label collisions: %s', file => {
    const matcher = compileSourceExclusions([file], [file.replaceAll('.', '-')], '/workspace')
    expect(matcher.valid).toBe(true)
    expect(matcher.matchesSource(`/workspace/src/${file}`, 'unrelated()')).toBe(true)
    expect(matcher.matchesSource(`/workspace/src/other.${file.split('.').at(-1)}`, file)).toBe(false)
    expect(matcher.matchesText(`The ${file} implementation is mentioned here`)).toBe(false)
  })

  it('normalizes relative scopes and independently checks logical and canonical roots', () => {
    const matcher = compileSourceExclusions(['./src/private/', 'src\\other.ts'], [], '/workspace')
    expect(matcher.valid).toBe(true)
    expect(matcher.matchesPath('/workspace/src/private/worker.ts')).toBe(true)
    expect(matcher.matchesPath('/workspace/src/other.ts')).toBe(true)
    expect(matcher.matchesPath('/real/src/private/worker.ts', '/real')).toBe(true)
    expect(matcher.matchesPath('/real/src/public/worker.ts', '/real')).toBe(false)
    expect(matcher.matchesPath('/workspace/src/privateer/worker.ts')).toBe(false)
    expect(matcher.matchesPath('/workspace/other/src/other.ts')).toBe(false)
    const absolute = compileSourceExclusions(['/workspace/src/other.ts'], [], '/workspace')
    expect(absolute.matchesPath('/real/src/other.ts', '/real')).toBe(true)
  })

  it('preserves quoted whitespace paths and Windows root boundaries', () => {
    const exclusions = extractPromptExclusions('Do not read "src/my config.ts". Explain the runtime.')
    expect(exclusions.excludedTerms).toEqual(['"src/my config.ts"'])
    expect(exclusions.excludedDomains).toEqual([])
    const matcher = compileSourceExclusions(exclusions.excludedTerms, exclusions.excludedPathHints, '/workspace')
    expect(matcher.valid).toBe(true)
    expect(matcher.matchesPath('src/my config.ts')).toBe(true)
    expect(matcher.matchesPath('src/other-config.ts')).toBe(false)
    expect(matcher.matchesLabel('myConfig')).toBe(false)
    const windows = compileSourceExclusions(['C:\\Repo\\src\\auth.ts'], [], 'C:\\Repo')
    expect(windows.valid).toBe(true)
    expect(windows.matchesPath('c:\\Repo\\src\\auth.ts')).toBe(true)
    expect(windows.matchesPath('C:\\Repo\\src\\other.ts')).toBe(false)
    expect(compileSourceExclusions(['/outside/auth.ts'], [], '/workspace').valid).toBe(false)
  })

  it('retains bounded glob and generic concept behavior without mixing their operands', () => {
    const matcher = compileSourceExclusions(['src/**/private-*.ts', '*.json', 'reporter utilities'], ['src-private-ts'], '/workspace')
    expect(matcher.valid).toBe(true)
    expect(matcher.matchesPath('src/a/private-a.ts')).toBe(true)
    const glob = extractPromptExclusions('Do not read src/file?.ts. Explain the runtime.')
    const globMatcher = compileSourceExclusions(glob.excludedTerms, glob.excludedPathHints, '/workspace')
    expect(globMatcher.matchesPath('src/file1.ts')).toBe(true)
    expect(globMatcher.matchesPath('src/file12.ts')).toBe(false)
    expect(matcher.matchesPath('src/a/public.ts')).toBe(false)
    expect(matcher.matchesPath('src/any.json')).toBe(true)
    expect(matcher.matchesLabel('reporterFactory')).toBe(false)
    expect(matcher.matchesText('reporter utilities')).toBe(true)
    expect(compileSourceExclusions(['workspace'], [], '/workspace').matchesPath('/workspace/src/allowed.ts')).toBe(false)
  })

  it('preserves single-segment, recursive, optional-directory and directory-prefix glob behavior', () => {
    for (const [pattern, file, expected] of [
      ['src/*.ts', 'src/a.ts', true], ['src/*.ts', 'src/nested/a.ts', false],
      ['src/?.ts', 'src/a.ts', true], ['src/?.ts', 'src/ab.ts', false],
      ['src/**/a?.ts', 'src/ab.ts', true], ['src/**/a?.ts', 'src/x/y/ab.ts', true],
      ['src/**/foo.ts', 'src/xfoo.ts', false], ['src/**foo.ts', 'src/x/foo.ts', true],
      ['***/foo.ts', 'foo.ts', true], ['****/foo.ts', 'foo.ts', true],
      ['***/foo.ts', 'a/b/foo.ts', true], ['****/foo.ts', 'a/b/foo.ts', true],
      ['src/private/', 'src/private/a.ts', true], ['src/private/', 'src/privateer/a.ts', false],
    ] as const) {
      const matcher = compileSourceExclusions([pattern], [], '/workspace')
      expect(matcher.valid).toBe(true)
      expect(matcher.matchesPath(file), `${pattern} versus ${file}`).toBe(expected)
    }
    expect(compileSourceExclusions(['*.ts'], [], '/workspace').matchesPath(`${'a'.repeat(4097)}.js`)).toBe(true)
    expect(compileSourceExclusions([`${'a'.repeat(500)}.ts`], [], '/workspace').matchesPath(`${'b'.repeat(600)}.js`)).toBe(true)
  })

  it('completes adversarial wildcard matching in a time-limited child process', () => {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run', fileURLToPath(import.meta.url), '-t', 'bounded glob worker', '--reporter=dot',
    ], { timeout: 5000, encoding: 'utf8', env: { ...process.env, MADAR_GLOB_ADVERSARIAL_WORKER: '1' } })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stdout + child.stderr).toBe(0)
    expect(child.stdout).toContain('GLOB_WORKER_PASS')
  }, 7000)

  it.skipIf(process.env.MADAR_GLOB_ADVERSARIAL_WORKER !== '1')('bounded glob worker', () => {
    const matcher = compileSourceExclusions(['*a*a*a*a*a*a*a*a*a*a*a*a.ts'], [], '/workspace')
    expect(matcher.valid).toBe(true)
    expect(matcher.matchesPath(`${'a'.repeat(200)}.js`)).toBe(false)
    expect(matcher.matchesPath(`${'a'.repeat(200)}.ts`)).toBe(true)
    process.stdout.write('GLOB_WORKER_PASS\n')
  })

  it.each(['../auth.ts', 'src/{a,b}.ts', 'src/!(auth).ts'])('fails closed for unsupported path scope %s', scope => {
    const matcher = compileSourceExclusions([scope], [], '/workspace')
    expect(matcher.valid).toBe(false)
    expect(matcher.matchesSource('/workspace/src/allowed.ts', 'allowed()')).toBe(true)
  })
})
