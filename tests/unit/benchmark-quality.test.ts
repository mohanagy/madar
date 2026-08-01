import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { generateIndex } from '../../src/application/generate-index.js'
import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import {
  evaluateRetrievalQuality,
  formatQualityReport,
  GOLD_QUESTIONS,
} from '../../tools/eval/lib/infrastructure/benchmark/quality.js'

const sandboxes: string[] = []

function qualityWorkspace(): { root: string; graphPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'madar-quality-core-'))
  sandboxes.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'events.ts'),
    [
      "import type { MongoRepository } from 'typeorm'",
      '',
      'type EventRecord = { id: string }',
      '',
      'export async function persistRequest(',
      '  repository: MongoRepository<EventRecord>,',
      '  id: string,',
      '): Promise<void> {',
      '  await repository.update(id, { id })',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(root, 'src', 'handler.ts'),
    [
      "import type { MongoRepository } from 'typeorm'",
      "import { persistRequest } from './events.js'",
      '',
      'type EventRecord = { id: string }',
      '',
      'export function handleRequest(',
      '  repository: MongoRepository<EventRecord>,',
      '): Promise<void> {',
      "  return persistRequest(repository, 'request.handled')",
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  return { root, graphPath: generateIndex(root).graphPath }
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Core Reset retrieval quality evaluator', () => {
  it('targets the v2 planner, workflow selector and evidence hydrator', () => {
    const labels = GOLD_QUESTIONS.flatMap((question) => question.expected_labels)
    expect(labels).toEqual(expect.arrayContaining([
      'planquestion', 'selectworkflow', 'hydrateevidence', 'retrievecontext',
    ]))
    expect(labels).not.toEqual(expect.arrayContaining([
      'rankqueryanchors', 'traverseevidencepaths', 'sliceevidence',
    ]))
  })

  it('grades only authenticated nodes returned by the one query', () => {
    const { graphPath } = qualityWorkspace()
    const report = evaluateRetrievalQuality(
      loadGraphArtifact(graphPath),
      [{
        question: 'How does request flow end to end?',
        expected_labels: ['handleRequest()', 'persistRequest()'],
      }],
      3_000,
      { graphPath },
    )

    expect(report).toEqual(expect.objectContaining({
      total_questions: 1,
      questions_with_hits: 1,
      avg_recall: 1,
      avg_snippet_coverage: 1,
      avg_grounded_match_rate: 1,
    }))
    expect(report.questions[0]?.tokens_used).toBeGreaterThan(0)
    expect(report.questions[0]?.missing_labels).toEqual([])
  })

  it('does not credit substring or missing evidence', () => {
    const { graphPath } = qualityWorkspace()
    const report = evaluateRetrievalQuality(
      loadGraphArtifact(graphPath),
      [{ question: 'Where is persistRequest defined?', expected_labels: ['persist'] }],
      3_000,
      { graphPath },
    )
    expect(report.questions[0]?.recall).toBe(0)
    expect(report.questions[0]?.matched_labels).toEqual([])
  })

  it('does not grade a non-ready response as partial evidence', () => {
    const { graphPath } = qualityWorkspace()
    const report = evaluateRetrievalQuality(
      loadGraphArtifact(graphPath),
      [{
        question: 'Should this architecture be rewritten?',
        expected_labels: ['handleRequest()'],
      }],
      3_000,
      { graphPath },
    )

    expect(report.questions[0]).toMatchObject({
      returned_labels: [], matched_labels: [], recall: 0,
      snippet_coverage: 0, grounded_match_rate: 0,
    })
  })

  it('skips unlabeled questions and renders a compact report', () => {
    const { graphPath } = qualityWorkspace()
    const report = evaluateRetrievalQuality(
      loadGraphArtifact(graphPath),
      [
        { question: 'Where is handleRequest defined?', expected_labels: ['handleRequest()'] },
        { question: 'unlabeled evaluation prompt' },
      ],
      3_000,
      { graphPath },
    )
    expect(report.skipped_questions).toBe(1)
    expect(formatQualityReport(report)).toContain('madar retrieval quality benchmark')
  })
})
