import { describe, expect, it } from 'vitest'

import {
  TASK_INTENT_DEFINITIONS,
  TASK_INTENT_KINDS,
  type TaskIntentKind,
} from '../../src/contracts/task-intent.js'
import {
  classifyTaskIntent,
  normalizeTaskIntentPrompt,
  validateTaskIntentDefinitions,
} from '../../src/runtime/task-intent.js'

function defaultContextKindFor(kind: TaskIntentKind): 'explain' | 'review' | 'impact' {
  const definition = TASK_INTENT_DEFINITIONS.find((entry) => entry.kind === kind)
  if (!definition) {
    throw new Error(`Missing task intent definition for ${kind}`)
  }
  return definition.default_context_kind
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
        'review',
        'impact',
        'debug-flow',
        'pr-review-risk',
        'test-generation',
        'refactor-module',
        'dead-code',
        'security-review',
        'performance-review',
      ])

      expect(TASK_INTENT_DEFINITIONS).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'debug-flow',
          default_context_kind: 'impact',
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
    it.each([
      ['Explain how the context pack is assembled for retrieve questions.', 'explain'],
      ['Review the recent auth changes for anything suspicious.', 'review'],
      ['What breaks if we remove ContextPackTaskKind from the runtime?', 'impact'],
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

    it('falls back to explain when no roadmap signal matches', () => {
      const classification = classifyTaskIntent('Need help with the graph.')

      expect(classification.kind).toBe('explain')
      expect(classification.confidence).toBe('low')
      expect(classification.matched_rules).toEqual([])
      expect(classification.scores[0]).toEqual({ kind: 'explain', score: 0 })
    })

    it('does not revalidate static definitions on each classification call', () => {
      expect(classifyTaskIntent('What breaks if we remove ContextPackTaskKind from the runtime?').kind)
        .toBe('impact')

      withTemporaryDefinitions((definitions) => {
        definitions[1]!.rules = [
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
        definitions[1]!.rules = [
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
        definitions[2]!.rules = [
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
          .toThrow(/explain\.explain-ambiguous-matchers.*exactly one of any_phrases, any_keywords, or keyword_groups/i)
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
          .toThrow(/explain\.explain-invalid-empty-rule.*exactly one of any_phrases, any_keywords, or keyword_groups/i)
      })
    })
  })
})
