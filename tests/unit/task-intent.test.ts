import { describe, expect, it } from 'vitest'

import {
  TASK_INTENT_DEFINITIONS,
  TASK_INTENT_KINDS,
  type TaskIntentKind,
} from '../../src/contracts/task-intent.js'
import {
  classifyTaskIntent,
  normalizeTaskIntentPrompt,
  resolveTaskSelection,
  validateTaskIntentDefinitions,
} from '../../src/runtime/task-intent.js'
import { resolveTaskEvidenceRecipe } from '../../src/runtime/task-evidence-recipes.js'

function defaultContextKindFor(kind: TaskIntentKind): 'explain' | 'implement' | 'review' | 'impact' {
  const definition = TASK_INTENT_DEFINITIONS.find((entry) => entry.kind === kind)
  if (!definition) {
    throw new Error(`Missing task intent definition for ${kind}`)
  }
  return definition.default_context_kind
}

function definitionByKind(kind: TaskIntentKind) {
  const definition = TASK_INTENT_DEFINITIONS.find((entry) => entry.kind === kind)
  if (!definition) {
    throw new Error(`Missing task intent definition for ${kind}`)
  }
  return definition
}

function withTemporaryDefinitions(
  mutate: (definitions: typeof TASK_INTENT_DEFINITIONS) => void,
  callback: () => void,
): void {
  const originalDefinitions = structuredClone(TASK_INTENT_DEFINITIONS)
  try {
    mutate(TASK_INTENT_DEFINITIONS)
    callback()
  } finally {
    TASK_INTENT_DEFINITIONS.splice(0, TASK_INTENT_DEFINITIONS.length, ...originalDefinitions)
  }
}

describe('task-intent', () => {
  describe('taxonomy definitions', () => {
    it('publishes a serializable roadmap taxonomy in stable order', () => {
      expect(TASK_INTENT_KINDS).toEqual([
        'explain',
        'implement',
        'review',
        'impact',
        'migrate',
        'document',
        'debug-flow',
        'pr-review-risk',
        'test-generation',
        'refactor-module',
        'dead-code',
        'security-review',
        'performance-review',
        'source-review',
      ])

      expect(TASK_INTENT_DEFINITIONS).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'implement',
          default_context_kind: 'implement',
          label: 'Implement',
        }),
        expect.objectContaining({
          kind: 'migrate',
          default_context_kind: 'implement',
          label: 'Migrate',
        }),
        expect.objectContaining({
          kind: 'document',
          default_context_kind: 'implement',
          label: 'Document',
        }),
        expect.objectContaining({
          kind: 'debug-flow',
          default_context_kind: 'explain',
          label: 'Debug flow',
        }),
        expect.objectContaining({
          kind: 'security-review',
          default_context_kind: 'review',
          label: 'Security review',
        }),
        expect.objectContaining({
          kind: 'performance-review',
          default_context_kind: 'impact',
          label: 'Performance review',
        }),
      ]))
      expect(JSON.parse(JSON.stringify(TASK_INTENT_DEFINITIONS))).toEqual(TASK_INTENT_DEFINITIONS)
    })
  })

  describe('normalizeTaskIntentPrompt', () => {
    it('normalizes whitespace, casing, punctuation, and separators', () => {
      expect(normalizeTaskIntentPrompt('  Review the PR-diff for SECURITY regressions!!  '))
        .toBe('review the pr diff for security regressions')
    })
  })

  describe('classifyTaskIntent', () => {
    it('distinguishes authored source investigation from review actions without overriding other task signals', () => {
      const recordedPrompts = [
        'In the CraftMyLetter source, trace AI review of an existing saved letter: credit deduction and durable attempt record before engine call; accepted revision save; no-revision immediate refund including refund transaction failure; engine exception refund; resulting HTTP responses, letter content/revision history, balance and attempt state. Also trace existing recovery job eligibility rules and idempotence for stranded and refunded attempts. Find relevant implementation and tests/config/root README only.',
        'Find source implementation and tests for AI review of an existing letter (review route/service), including credit transaction, attempt status, immediate refund, engine thrown/error vs unchanged response; find scheduled recovery job query and refund/state transitions. Search terms likely review credits, refund, attempt, recovery. Return exact files/line ranges and relevant snippets.',
      ]
      for (const prompt of [...recordedPrompts,
        'Trace the document review queue through its source handlers.',
        'In the inventory repository, please trace the audit log storage path.',
        'Could you please find the implementation of the peer review workflow?',
      ]) {
        const selected = resolveTaskSelection(prompt)
        expect(selected).toMatchObject({ explicit: false, task_kind: 'explain', task_intent: 'explain' })
        expect(selected.classification.scores[0]).toEqual({ kind: 'explain', score: 8 })
        expect(selected.classification.matched_rules).toContain('explain-source-investigation')
      }
      for (const task of ['explain', 'review', 'impact', 'implement'] as const) {
        expect(resolveTaskSelection(recordedPrompts[0]!, task, { explicit: true }))
          .toMatchObject({ explicit: true, task_kind: task, task_intent: task })
      }
      for (const prompt of [
        'Review the source and trace the existing workflow.',
        'Find source for the review flow. Audit it for correctness.',
        'Trace the review route; change its behavior.',
        'Find source for the review workflow, review it for correctness.',
        'Trace the review route: audit its guards.',
        'Trace the review route and then please review the implementation.',
        'In the source, audit the flow, trace review handling.',
        'In review source, trace the workflow.',
        '"Trace the source" review workflow.',
        '`Find source implementation` review workflow.',
        '```text\nTrace the source\n```\nReview workflow.',
        'In `the source`, trace the review workflow.',
        'Trace the review workflow and its latency.',
      ]) {
        const classification = classifyTaskIntent(prompt)
        expect(classification.kind).toBe('review')
        expect(classification.matched_rules).not.toContain('explain-source-investigation')
      }
      for (const prompt of [
        'Trace the review workflow and explain its behavior.',
        'Find source for the review workflow and implement the requested change.',
        'Trace the review workflow and determine what breaks if it is removed.',
        'Trace the review workflow during a security audit.',
        'Trace the PR diff for review.',
      ]) {
        expect(classifyTaskIntent(prompt).matched_rules).not.toContain('explain-source-investigation')
      }
      expect(classifyTaskIntent('Trace the review workflow and explain its behavior.').scores[0])
        .toEqual({ kind: 'explain', score: 8 })
    })

    it('routes the recorded source requests without caller task overrides', () => {
      const prompts = [
      "Trace the implementation of AI review of an existing saved letter in CraftMyLetter, including credit deduction, attempt persistence before engine invocation, accepted revision saving, no-revision refund failure handling, thrown-engine immediate refund, HTTP responses and attempt states. Also trace the existing recovery job: eligibility timing, refund transaction/state updates, idempotency and exclusions. Find relevant source, tests, configuration, root README only.",
      "Locate source implementation specifically for reviewing an existing saved letter using AI, review credit/credits, review attempt records, refund and recovery cron/job. Search source code for review endpoint and recovery. Need actual source paths and relevant snippets plus tests.",
      "How does CraftMyLetter review of an existing saved letter charge one AI review credit, create an attempt record before engine call, handle accepted revision/save, unchanged original/refund failure, engine exception/refund success, and recover pending review attempts? Locate endpoint/service and recovery implementation, relevant statuses, timestamps, transaction behavior and tests/config.",
      "Find implementation and tests for AI review of a saved existing letter, credit debit/refund and review attempt recovery job. Need endpoint path, exact status values, transactions, HTTP responses, recovery age eligibility, idempotence. Search specifically review attempt / review credits / recover abandoned review.",
      "In this Miftah source snapshot, trace opt-in modern stateless profile-context handle issuance and lifetime calculation from a host-authenticated profile selection, including how assertion expiry bounds the handle. Trace validation of a supplied handle on upstream-tool calls, including checks against assertion fields and expiry boundaries, profile selection, error codes, and whether handle is removed/forwarded before ordinary upstream tool processing. Find authoritative source/config/tests/root README only. Include repository-relative paths and lines.",
      "In this source snapshot, explain the opt-in modern stateless profile selection flow for a host-authenticated client: how profile-context handles are issued and their expiry derived from requested lifetime and host assertion exp; how an upstream tool call validates a supplied handle against a renewed assertion's issuer, subject, audience, chat, timing/exp boundaries; which profile gets selected; error codes and whether errors return to client or continue; and whether handle is forwarded upstream. Use source evidence only.",
      "Locate source implementation for profile context handle mint/resolve and host authenticated claims matching. Need exact expiry calculation and whether handle resolve compares auth issuer/subject/audience/chat, assertion exp/iat, with boundaries. Also tool processing invocation args and error response flow: does prepareCall rejection return error and are extracted args passed upstream without handle? Cite exact source ranges.",
      ]
      for (const prompt of prompts) {
        expect(resolveTaskSelection(prompt), prompt).toMatchObject({ explicit: false, task_kind: 'explain' })
      }
      expect(resolveTaskSelection(prompts[4]!).task_intent).toBe('debug-flow')
    })

    it.each([
      'How does the worker create a task, build context and update state?',
      'What does the review worker create before returning its result?',
      'How is the review queue built from incoming tasks?',
      'Where is the flow that creates review records?',
      'How does the factory create a task? Locate the source and its tests.',
      'Locate source for the review queue and audit log.',
      'Find implementation for record creation and review queue processing.',
      'Find implementation and tests for the audit log and review queue.',
      'Locate source for stored events, review record/records, audit entries and state transitions.',
      'In the source, locate the implementation of the review queue.',
      'How does the review queue use `createTask()` and "build context"?',
    ])('keeps described source behavior in explanation: %s', (prompt) => {
      const selected = resolveTaskSelection(prompt)
      expect(selected).toMatchObject({ explicit: false, task_kind: 'explain', task_intent: 'explain' })
      expect(selected.classification.scores[0]).toEqual({ kind: 'explain', score: 8 })
      expect(selected.classification.matched_rules).toContain('explain-source-investigation')
      for (const task of ['explain', 'review', 'impact', 'implement'] as const) {
        expect(resolveTaskSelection(prompt, task, { explicit: true }))
          .toMatchObject({ explicit: true, task_kind: task, task_intent: task })
      }
    })

    it.each([
      ['How does the factory create a task? Add another feature.', 'implement'],
      ['How does the factory create a task and then please add another feature?', 'implement'],
      ['Where is the review queue, and create a new task.', 'implement'],
      ['How is the review queue stored, and add a new task.', 'implement'],
      ['How does the review queue work? Review the handler.', 'review'],
      ['How is the review queue stored? Audit its permissions.', 'review'],
      ['Locate source for the review queue. Review transaction handling.', 'review'],
      ['Find implementation for the review queue and review it for correctness.', 'review'],
      ['Find source for the review queue, review its guards.', 'review'],
      ['Find source for the review queue and then review transaction handling.', 'review'],
      ['Find source for the review queue and review error handling for correctness.', 'review'],
      ['Find source for the queue. Inspect behavior and review error handling.', 'review'],
      ['Locate source and review handlers.', 'review'],
      ['Find source for the review queue and implement the requested change.', 'implement'],
      ['Locate source for the review queue. Generate regression tests.', 'test-generation'],
      ['How does the review queue work? Migrate the worker to a new API.', 'migrate'],
      ['Find source for the review queue and determine what breaks if it is removed.', 'impact'],
      ['Locate source for the review queue during a security audit.', 'security-review'],
    ] as const)('preserves a separate authored action: %s', (prompt, kind) => {
      const classification = classifyTaskIntent(prompt)
      expect(classification.kind).toBe(kind)
      expect(classification.matched_rules).not.toContain('explain-source-investigation')
    })

    it.each([
      '"How does the worker create a task?" Review the source.',
      '`Locate source` review queue.',
      '```text\nFind implementation for the review queue\n```\nReview the handler.',
      'src/how-does/review.ts',
      'src/locate-source/review.ts',
      'trace/review.ts',
      'find source/review.ts',
      'how does/review.ts',
      'In `the source`, locate the review queue.',
      'Find `source for` the review queue.',
    ])('does not promote a directive supplied by data or paths: %s', (prompt) => {
      const classification = classifyTaskIntent(prompt)
      expect(classification.kind).toBe('review')
      expect(classification.matched_rules).not.toContain('explain-source-investigation')
    })

    it('routes diagnosis to source evidence while preserving explicit tasks and pure change requests', () => {
      const prompt = 'Trace the request error path and determine whether the waiting operation can retry.'
      const diagnostic = resolveTaskSelection(prompt)
      expect(diagnostic).toMatchObject({ explicit: false, task_kind: 'explain', task_intent: 'debug-flow' })
      const recipe = resolveTaskEvidenceRecipe(diagnostic.task_kind, { task_intent: diagnostic.task_intent })
      expect(recipe).toMatchObject({ id: 'debug-flow', task_kind: 'explain',
        required_evidence: ['primary', 'supporting', 'structural'], semantic_required: ['implementation', 'structure'] })
      expect(recipe.required_evidence).not.toContain('impact')
      expect(recipe.semantic_required).not.toContain('configuration')
      for (const task of ['explain', 'impact', 'implement', 'review'] as const) {
        const selected = resolveTaskSelection(prompt, task, { explicit: true })
        expect(selected).toMatchObject({ explicit: true, task_kind: task,
          task_intent: task === 'explain' ? 'debug-flow' : task })
        expect(resolveTaskEvidenceRecipe(task, { task_intent: selected.task_intent }).task_kind).toBe(task)
      }
      expect(resolveTaskSelection('What breaks if we remove the shared worker?')).toMatchObject({ task_kind: 'impact', task_intent: 'impact' })
      expect(resolveTaskSelection('Please change ownership to the caller.')).toMatchObject({ task_kind: 'implement', task_intent: 'implement' })
      // Mixed wording still uses the existing winner; no new precedence rules.
      expect(resolveTaskSelection('Debug the error and identify the blast radius.')).toMatchObject({ task_kind: 'explain', task_intent: 'debug-flow' })
    })

    it.each([
      ['Explain how the context pack is assembled for retrieve questions.', 'explain'],
      ['Implement issue #275 by collecting implementation context for changed files.', 'implement'],
      ['Review the recent auth changes for anything suspicious.', 'review'],
      ['What breaks if we remove ContextPackTaskKind from the runtime?', 'impact'],
      ['Migrate graphify-ts install docs to madar naming.', 'migrate'],
      ['Document the new pack task inference behavior in the README.', 'document'],
      ['Trace why refresh token rotation started failing after the latest auth change.', 'debug-flow'],
      ['Review this PR diff for risky auth regressions before merge.', 'pr-review-risk'],
      ['Generate regression tests for token refresh and session expiry.', 'test-generation'],
      ['Refactor the session cache module without changing behavior.', 'refactor-module'],
      ['Find unused exports and dead code left behind by the old pipeline.', 'dead-code'],
      ['Audit the password reset flow for injection and auth bypass issues.', 'security-review'],
      ['Investigate latency and memory hotspots in graph clustering.', 'performance-review'],
    ] as const)('classifies "%s" as %s', (prompt, expectedKind) => {
      const classification = classifyTaskIntent(prompt)

      expect(classification.kind).toBe(expectedKind)
      expect(classification.default_context_kind).toBe(defaultContextKindFor(expectedKind))
      expect(classification.scores[0]).toEqual(expect.objectContaining({ kind: expectedKind }))
      expect(JSON.parse(JSON.stringify(classification))).toEqual(classification)
    })

    it('breaks overlapping signals deterministically in favor of pr review risk', () => {
      const classification = classifyTaskIntent(
        'Review the PR diff for risky performance regressions before merge.',
      )

      expect(classification.kind).toBe('pr-review-risk')
      expect(classification.confidence).toBe('high')
      expect(classification.scores.slice(0, 3)).toEqual([
        expect.objectContaining({ kind: 'pr-review-risk' }),
        expect.objectContaining({ kind: 'performance-review' }),
        expect.objectContaining({ kind: 'review' }),
      ])
    })

    it('does not let one support token satisfy both implement keyword groups', () => {
      const classification = classifyTaskIntent('Need support')

      expect(classification.kind).toBe('explain')
      expect(classification.matched_rules).not.toContain('implement-keywords')
    })

    it('falls back to explain when no roadmap signal matches', () => {
      const classification = classifyTaskIntent('Need help with the graph.')

      expect(classification.kind).toBe('explain')
      expect(classification.confidence).toBe('low')
      expect(classification.matched_rules).toEqual([])
      expect(classification.scores[0]).toEqual({ kind: 'explain', score: 0 })
    })

    it('routes rationale, quoted data, counterfactuals and leading change instructions by their directive', () => {
      expect(classifyTaskIntent('Why is the lock retained until cleanup finishes?').kind).toBe('explain')
      expect(classifyTaskIntent('Why does the lock protect the shared state?').kind).toBe('explain')
      expect(classifyTaskIntent('Why does acquiring the lock fail?').kind).toBe('debug-flow')
      expect(classifyTaskIntent('Explain the note titled "debug locking".').kind).toBe('explain')
      expect(classifyTaskIntent('Explain `what breaks` in this message.').kind).toBe('explain')
      expect(classifyTaskIntent('Explain what "debug locking" breaks means in this sentence.').kind).toBe('explain')
      expect(classifyTaskIntent('What would break if lock ownership changed? Do not change code.').kind).toBe('impact')
      expect(classifyTaskIntent('What could break if lock ownership changed?').kind).toBe('impact')
      expect(classifyTaskIntent('Please change lock ownership to the caller.').kind).toBe('implement')
      expect(classifyTaskIntent('Do not change lock ownership; explain it.').kind).toBe('explain')
      expect(classifyTaskIntent('Explain what happens if callers change lock ownership.').kind).toBe('explain')
    })

    it('does not revalidate static definitions on each classification call', () => {
      expect(classifyTaskIntent('What breaks if we remove ContextPackTaskKind from the runtime?').kind)
        .toBe('impact')

      withTemporaryDefinitions((definitions) => {
        definitionByKind('review').rules = [
          {
            id: 'review-invalid-keywords',
            score: 7,
            any_keywords: ['pull request'],
          },
        ]
      }, () => {
        expect(classifyTaskIntent('What breaks if we remove ContextPackTaskKind from the runtime?').kind)
          .toBe('impact')
      })
    })

    it('rejects multi-word any_keywords entries after normalization', () => {
      withTemporaryDefinitions((definitions) => {
        definitionByKind('review').rules = [
          {
            id: 'review-invalid-keywords',
            score: 7,
            any_keywords: ['pull request'],
          },
        ]
      }, () => {
        expect(() => validateTaskIntentDefinitions())
          .toThrow(/review\.review-invalid-keywords.*any_keywords\[0\].*pull request/i)
      })
    })

    it('rejects multi-word keyword_groups entries after normalization', () => {
      withTemporaryDefinitions((definitions) => {
        definitionByKind('impact').rules = [
          {
            id: 'impact-invalid-keyword-groups',
            score: 6,
            keyword_groups: [
              ['blast radius'],
              ['change'],
            ],
          },
        ]
      }, () => {
        expect(() => validateTaskIntentDefinitions())
          .toThrow(/impact\.impact-invalid-keyword-groups.*keyword_groups\[0\]\[0\].*blast radius/i)
      })
    })

    it('rejects rules that combine multiple signal matcher fields', () => {
      withTemporaryDefinitions((definitions) => {
        definitions[0]!.rules = [
          {
            id: 'explain-ambiguous-matchers',
            score: 3,
            any_phrases: ['explain'],
            any_keywords: ['explain'],
          },
        ]
      }, () => {
        expect(() => validateTaskIntentDefinitions())
          .toThrow(/explain\.explain-ambiguous-matchers.*exactly one of any_phrases, any_prefixes, any_keywords, or keyword_groups/i)
      })
    })

    it('rejects rules that do not define any phrases or keywords', () => {
      withTemporaryDefinitions((definitions) => {
        definitions[0]!.rules = [
          {
            id: 'explain-invalid-empty-rule',
            score: 3,
          },
        ]
      }, () => {
        expect(() => validateTaskIntentDefinitions())
          .toThrow(/explain\.explain-invalid-empty-rule.*exactly one of any_phrases, any_prefixes, any_keywords, or keyword_groups/i)
      })
    })
  })
})
