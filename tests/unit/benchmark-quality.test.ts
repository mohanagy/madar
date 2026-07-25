import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { generateIndex } from '../../src/application/generate-index.js'
import { loadGraphArtifact } from '../../src/adapters/filesystem/graph-artifact.js'
import {
  evaluateRetrievalQuality,
  formatQualityReport,
} from '../../tools/eval/lib/infrastructure/benchmark/quality.js'

const sandboxes: string[] = []

function qualityWorkspace(): { root: string; graphPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'madar-quality-core-'))
  sandboxes.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'events.ts'),
    [
      'export function publishEvent(name: string): string {',
      '  return `published:${name}`',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(root, 'src', 'handler.ts'),
    [
      "import { publishEvent } from './events.js'",
      'export function handleRequest(): string {',
      "  return publishEvent('request.handled')",
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
  it('grades only authenticated nodes returned by the one query', () => {
    const { graphPath } = qualityWorkspace()
    const report = evaluateRetrievalQuality(
      loadGraphArtifact(graphPath),
      [{
        question: 'How does handle request publish event?',
        expected_labels: ['handleRequest()', 'publishEvent()'],
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
      [{ question: 'publish event', expected_labels: ['publish'] }],
      3_000,
      { graphPath },
    )
    expect(report.questions[0]?.recall).toBe(0)
    expect(report.questions[0]?.matched_labels).toEqual([])
  })

  it('skips unlabeled questions and renders a compact report', () => {
    const { graphPath } = qualityWorkspace()
    const report = evaluateRetrievalQuality(
      loadGraphArtifact(graphPath),
      [
        { question: 'handle request', expected_labels: ['handleRequest()'] },
        { question: 'unlabeled evaluation prompt' },
      ],
      3_000,
      { graphPath },
    )
    expect(report.skipped_questions).toBe(1)
    expect(formatQualityReport(report)).toContain('madar retrieval quality benchmark')
  })
})
