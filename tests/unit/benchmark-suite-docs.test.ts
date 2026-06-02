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
    expect(content).toContain('python-service')
    expect(content).toContain('go-service')
    expect(content).toContain('explain-runtime')
    expect(content).toContain('implement')
    expect(content).toContain('review')
    expect(content).toContain('impact')
    expect(content).toContain('results/2026-05-31T12-00-00/summary.md')
    expect(content).not.toContain('Python and Go stay visible as planned rows')
  })

  it('checks in full share-safe receipts for the latest published bundle', () => {
    const report = JSON.parse(readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/raw/ts-small/implement/warm-cache/legacy/trial-001/report.share-safe.json')) as {
      data_source?: string
      baseline?: { kind?: string }
      madar?: { kind?: string }
      benchmark_outcome?: { evidence?: string[] }
      tool_call_counts?: unknown
      measurement_validity?: string
      workflow_outcome?: unknown
      publication_contract?: {
        report_json_variant?: string
        timing_semantics?: string
        tool_call_count_semantics?: string
        human_intervention_semantics?: string
      }
    }
    const baselineAnswer = readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/raw/ts-small/implement/warm-cache/legacy/trial-001/baseline-answer.txt')
    const madarAnswer = readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/raw/ts-small/implement/warm-cache/legacy/trial-001/madar-answer.txt')

    expect(report.data_source).toBe('fixture')
    expect(report.baseline?.kind).toBe('succeeded')
    expect(report.madar?.kind).toBe('succeeded')
    expect(report.benchmark_outcome?.evidence?.some((entry) => entry.includes('token reduction'))).toBe(true)
    expect(report.tool_call_counts).toBeTruthy()
    expect(report.measurement_validity).toBe('valid')
    expect(report.workflow_outcome).toBeTruthy()
    expect(report.publication_contract?.report_json_variant).toBe('share_safe_alias')
    expect(report.publication_contract?.timing_semantics).toBe('fixture_deterministic')
    expect(report.publication_contract?.tool_call_count_semantics).toBe('fixture_deterministic')
    expect(report.publication_contract?.human_intervention_semantics).toContain('independent of validation_passed')
    expect(baselineAnswer).toContain('Model:')
    expect(baselineAnswer).toContain('Prompt:')
    expect(baselineAnswer.trim().split('\n').length).toBeGreaterThan(3)
    expect(madarAnswer).toContain('Model:')
    expect(madarAnswer).toContain('Prompt:')
    expect(madarAnswer.trim().split('\n').length).toBeGreaterThan(3)
  })

  it('defines workflow outcome metrics alongside token and latency reporting', () => {
    const content = readDoc('docs/benchmarks/suite/methodology.md')

    expect(content).toContain('wrong-file edits')
    expect(content).toContain('validation pass/fail')
    expect(content).toContain('review time')
    expect(content).toContain('rework')
    expect(content).toContain('human intervention')
    expect(content).toContain('`status: \"ready\"`')
    expect(content).toContain('`status: \"planned\"`')
    expect(content).toContain('`report.json` is a checked-in share-safe alias')
    expect(content).toContain('`started_at` / `completed_at` fixture anchors')
    expect(content).toContain('ordered question list')
    expect(content).toContain('`session_diagnostics`')
    expect(content).toContain('single-question cells remain first-turn only')
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

  it('publishes the latest suite bundle under the canonical timestamp without nested trial directories', () => {
    const bundleReadme = readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/README.md')
    const summary = JSON.parse(readDoc('docs/benchmarks/suite/results/2026-05-31T12-00-00/summary.json')) as {
      output_root?: string
      cells?: Array<{
        artifacts?: {
          legacy_share_safe_reports?: string[]
        }
      }>
    }

    expect(bundleReadme).toContain('`report.json` is the checked-in share-safe alias')
    expect(bundleReadme).toContain('tool-call counts are deterministic fixture receipts')
    expect(summary.output_root).toBe('docs/benchmarks/suite/results/2026-05-31T12-00-00')
    expect(summary.cells?.[0]?.artifacts?.legacy_share_safe_reports?.[0]).toContain('/trial-001/report.share-safe.json')
    expect(summary.cells?.[0]?.artifacts?.legacy_share_safe_reports?.[0]).not.toContain('/trial-001/trial-001/')
    expect(summary.cells?.[0]?.artifacts?.legacy_share_safe_reports?.[0]).not.toContain('2026-05-31T12-00-00-001')
  })
})
