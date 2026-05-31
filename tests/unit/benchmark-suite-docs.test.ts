import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function readDoc(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8')
}

describe('benchmark suite docs', () => {
  it('documents the expanded ready matrix and the latest published result bundle', () => {
    const content = readDoc('docs/benchmarks/suite/README.md')

    expect(content).toContain('ts-small')
    expect(content).toContain('nestjs-mid')
    expect(content).toContain('ts-monorepo-large')
    expect(content).toContain('explain-runtime')
    expect(content).toContain('implement')
    expect(content).toContain('review')
    expect(content).toContain('impact')
    expect(content).toContain('results/2026-05-31T12-00-00/summary.md')
  })

  it('checks in full share-safe receipts for the latest published bundle', () => {
    const report = JSON.parse(readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/raw/ts-small/implement/warm-cache/legacy/trial-001/trial-001/report.share-safe.json')) as {
      baseline?: { kind?: string }
      madar?: { kind?: string }
      tool_call_counts?: unknown
      measurement_validity?: string
      workflow_outcome?: unknown
    }
    const baselineAnswer = readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/raw/ts-small/implement/warm-cache/legacy/trial-001/trial-001/baseline-answer.txt')
    const madarAnswer = readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/raw/ts-small/implement/warm-cache/legacy/trial-001/trial-001/madar-answer.txt')

    expect(report.baseline?.kind).toBe('succeeded')
    expect(report.madar?.kind).toBe('succeeded')
    expect(report.tool_call_counts).toBeTruthy()
    expect(report.measurement_validity).toBe('valid')
    expect(report.workflow_outcome).toBeTruthy()
    expect(baselineAnswer).not.toBe('baseline\n')
    expect(madarAnswer).not.toBe('madar\n')
  })

  it('defines workflow outcome metrics alongside token and latency reporting', () => {
    const content = readDoc('docs/benchmarks/suite/methodology.md')

    expect(content).toContain('wrong-file edits')
    expect(content).toContain('validation pass/fail')
    expect(content).toContain('review time')
    expect(content).toContain('rework')
    expect(content).toContain('human intervention')
  })

  it('keeps claims conservative while acknowledging initial workflow-outcome receipts', () => {
    const claims = readDoc('docs/claims-and-evidence.md')
    const readme = readDoc('README.md')

    expect(claims).toContain('small-library, service, and monorepo fixture-style rows')
    expect(claims).toContain('initial implement/review workflow-outcome receipts')
    expect(claims).toContain('results/2026-05-31T12-00-00/summary.md')
    expect(readme).toContain('initial fixture-proxy implement/review/impact rows')
    expect(readme).toContain('no single-number cross-repo headline')
  })
})
