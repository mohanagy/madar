import { describe, expect, it, vi } from 'vitest'

import {
  runPipelineStage,
  startPipelineStage,
  type PipelineStageDiagnostic,
} from '../../src/core/pipeline/stage.js'

describe('pipeline stage diagnostics', () => {
  it('emits only source-safe operational fields', () => {
    const diagnostics: PipelineStageDiagnostic[] = []
    const secretSource = 'src/private/token-loader.ts'
    const output = runPipelineStage({
      pipeline: 'retrieval',
      stage: 'candidate_ranking',
      inputCount: 3.8,
      outputCount: (entries: string[]) => entries.length,
      observer: (diagnostic) => diagnostics.push(diagnostic),
    }, () => [secretSource])

    expect(output).toEqual([secretSource])
    expect(diagnostics).toHaveLength(1)
    expect(Object.keys(diagnostics[0] ?? {}).sort()).toEqual([
      'duration_ms',
      'input_count',
      'output_count',
      'pipeline',
      'stage',
      'status',
      'version',
      'warning_count',
    ])
    expect(diagnostics[0]).toMatchObject({
      version: 1,
      pipeline: 'retrieval',
      stage: 'candidate_ranking',
      status: 'completed',
      input_count: 3,
      output_count: 1,
      warning_count: 0,
    })
    expect(JSON.stringify(diagnostics)).not.toContain(secretSource)
  })

  it('reports failure without swallowing the original error', () => {
    const observer = vi.fn()
    const failure = new Error('parser included private source text')

    expect(() => runPipelineStage({
      pipeline: 'extraction',
      stage: 'per_language_extraction',
      inputCount: Number.NaN,
      outputCount: () => 1,
      observer,
    }, () => {
      throw failure
    })).toThrow(failure)

    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      input_count: 0,
      output_count: 0,
      warning_count: 1,
    }))
    expect(JSON.stringify(observer.mock.calls)).not.toContain(failure.message)
  })

  it('lets a timer report at most once', () => {
    const observer = vi.fn()
    const timer = startPipelineStage({
      pipeline: 'retrieval',
      stage: 'seed_generation',
      inputCount: 2,
      observer,
    })

    timer.complete(4)
    timer.fail()
    timer.complete(8, 2)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      input_count: 2,
      output_count: 4,
      warning_count: 0,
    }))
  })

  it('keeps observability failures outside production behavior', () => {
    const output = runPipelineStage({
      pipeline: 'retrieval',
      stage: 'budgeted_packing',
      inputCount: 1,
      outputCount: () => 1,
      observer: () => {
        throw new Error('telemetry sink unavailable')
      },
    }, () => 'packed')

    expect(output).toBe('packed')
  })
})
