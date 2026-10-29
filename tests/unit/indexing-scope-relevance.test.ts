import { describe, expect, it } from 'vitest'
import type { ContextPackCoverage } from '../../src/contracts/context-pack.js'
import type { IndexingOutcome, IndexingReasonCode } from '../../src/contracts/indexing.js'
import { createIndexingManifest } from '../../src/pipeline/indexing-outcomes.js'
import { buildMadarResponseEvidence } from '../../src/runtime/mcp-response-evidence.js'

const cases: Array<{
  id: string
  question: string
  outcomes: Array<Pick<IndexingOutcome, 'path' | 'status' | 'reason'>>
  owners: string[]
  expect_relevant: Partial<Record<IndexingReasonCode, number>>
  expect_missing: string[]
}> = [
  {
    "id": "scope-only-readme",
    "question": "Explain how transfer state is committed. Use only source, tests, configuration or root README within workspace.",
    "outcomes": [
      {
        "path": "README.md",
        "status": "skipped_by_policy",
        "reason": "docs_disabled"
      }
    ],
    "owners": [],
    "expect_relevant": {},
    "expect_missing": []
  },
  {
    "id": "actual-readme-subject",
    "question": "Explain the setup requirements in README.md. Use only source, tests, configuration or root README within workspace.",
    "outcomes": [
      {
        "path": "README.md",
        "status": "skipped_by_policy",
        "reason": "docs_disabled"
      }
    ],
    "owners": [],
    "expect_relevant": {
      "docs_disabled": 1
    },
    "expect_missing": [
      "indexing:docs_disabled"
    ]
  },
  {
    "id": "omitted-executing-source",
    "question": "Explain how src/persistence.ts commits transfer state. Use only source, tests, configuration or root README within workspace.",
    "outcomes": [
      {
        "path": "README.md",
        "status": "skipped_by_policy",
        "reason": "docs_disabled"
      },
      {
        "path": "src/persistence.ts",
        "status": "skipped_by_policy",
        "reason": "hard_ignored"
      }
    ],
    "owners": [],
    "expect_relevant": {
      "hard_ignored": 1
    },
    "expect_missing": [
      "indexing:hard_ignored"
    ]
  },
  {
    "id": "selected-owner-uncertainty",
    "question": "Explain how transfer state is committed. Use only source, tests, configuration or root README within workspace.",
    "outcomes": [
      {
        "path": "README.md",
        "status": "skipped_by_policy",
        "reason": "docs_disabled"
      },
      {
        "path": "src/store.ts",
        "status": "failed",
        "reason": "extractor_error"
      }
    ],
    "owners": [
      "README.md",
      "src/store.ts"
    ],
    "expect_relevant": {
      "docs_disabled": 1,
      "extractor_error": 1
    },
    "expect_missing": [
      "indexing:docs_disabled",
      "indexing:extractor_error"
    ]
  },
  {
    "id": "no-scope-code-parity",
    "question": "Explain how transfer state is committed.",
    "outcomes": [
      {
        "path": "README.md",
        "status": "skipped_by_policy",
        "reason": "docs_disabled"
      }
    ],
    "owners": [],
    "expect_relevant": {},
    "expect_missing": []
  },
  {
    "id": "no-scope-doc-parity",
    "question": "Explain the setup requirements in README.md.",
    "outcomes": [
      {
        "path": "README.md",
        "status": "skipped_by_policy",
        "reason": "docs_disabled"
      }
    ],
    "owners": [],
    "expect_relevant": {
      "docs_disabled": 1
    },
    "expect_missing": [
      "indexing:docs_disabled"
    ]
  }
]

const coverage: ContextPackCoverage = {
  required_evidence: ['primary', 'supporting'], semantic_required: [], semantic_optional: [],
  entries: [
    { evidence_class: 'primary', required: true, available_nodes: 1, selected_nodes: 1, status: 'covered' },
    { evidence_class: 'supporting', required: true, available_nodes: 0, selected_nodes: 0, status: 'missing' },
  ],
  semantic_entries: [], missing_required: ['supporting'], missing_semantic: [],
  available_relationships: 0, selected_relationships: 0,
}

describe('indexing relevance distinguishes source scope from the requested subject', () => {
  it.each(cases)('$id', (testCase) => {
    const indexingManifest = createIndexingManifest({ outcomes: [
      { path: 'src/transfer.ts', kind: 'file', status: 'indexed', reason: 'indexed', capability: 'builtin:extract:typescript' },
      ...testCase.outcomes.map(outcome => ({ ...outcome, kind: 'file' as const, capability: null })),
    ] })
    const input = { question: testCase.question, indexingManifest, coverage, coveredWorkflowOwners: testCase.owners }
    const original = JSON.stringify(input)
    const evidence = buildMadarResponseEvidence(input)
    expect(JSON.stringify(input)).toBe(original)
    expect(evidence.indexing_completeness).toMatchObject({
      state: indexingManifest.summary.state,
      total_uncertain: testCase.outcomes.length,
      reasons: Object.fromEntries([...new Set(testCase.outcomes.map(outcome => outcome.reason))]
        .map(reason => [reason, testCase.outcomes.filter(outcome => outcome.reason === reason).length])),
      relevant_reasons: testCase.expect_relevant,
    })
    expect(evidence.indexing_completeness?.relevant_reasons).toEqual(testCase.expect_relevant)
    expect(evidence.coverage_detail.missing_obligations.filter(value => value.startsWith('indexing:')))
      .toEqual(testCase.expect_missing)
    expect(evidence.coverage_detail.missing_obligations).toContain('evidence:supporting')
    expect(evidence.coverage).toBe('partial')
    expect(['ready', 'ready_with_caveat']).not.toContain(evidence.answerability.state)
    if (testCase.id === 'selected-owner-uncertainty') {
      expect(evidence.evidence_strength.level).toBe('weak')
    }
  })
})
