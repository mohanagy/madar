export type PipelineKind = 'retrieval' | 'extraction'
export type PipelineStageStatus = 'completed' | 'skipped' | 'failed'

/**
 * Source-safe operational facts for one pipeline stage. Stage diagnostics
 * deliberately contain only bounded names, counts, status, and elapsed time.
 */
export interface PipelineStageDiagnostic<TStage extends string = string> {
  version: 1
  pipeline: PipelineKind
  stage: TStage
  status: PipelineStageStatus
  duration_ms: number
  input_count: number
  output_count: number
  warning_count: number
}

export type PipelineStageObserver<TStage extends string = string> = (
  diagnostic: PipelineStageDiagnostic<TStage>,
) => void

export interface PipelineStageRunOptions<TStage extends string, TOutput> {
  pipeline: PipelineKind
  stage: TStage
  inputCount: number
  outputCount: (output: TOutput) => number
  warningCount?: (output: TOutput) => number
  observer?: PipelineStageObserver<TStage>
}

const finiteCount = (value: number): number => {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

const elapsedMilliseconds = (startedAt: number): number => {
  const elapsed = performance.now() - startedAt
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed * 1000) / 1000) : 0
}

const emitPipelineDiagnostic = <TStage extends string>(
  observer: PipelineStageObserver<TStage> | undefined,
  diagnostic: PipelineStageDiagnostic<TStage>,
): void => {
  try {
    observer?.(diagnostic)
  } catch {
    // Observability is best-effort and must never change pipeline behavior.
  }
}

export const runPipelineStage = <TStage extends string, TOutput>(
  options: PipelineStageRunOptions<TStage, TOutput>,
  execute: () => TOutput,
): TOutput => {
  const startedAt = performance.now()
  try {
    const output = execute()
    emitPipelineDiagnostic(options.observer, {
      version: 1,
      pipeline: options.pipeline,
      stage: options.stage,
      status: 'completed',
      duration_ms: elapsedMilliseconds(startedAt),
      input_count: finiteCount(options.inputCount),
      output_count: finiteCount(options.outputCount(output)),
      warning_count: finiteCount(options.warningCount?.(output) ?? 0),
    })
    return output
  } catch (error) {
    emitPipelineDiagnostic(options.observer, {
      version: 1,
      pipeline: options.pipeline,
      stage: options.stage,
      status: 'failed',
      duration_ms: elapsedMilliseconds(startedAt),
      input_count: finiteCount(options.inputCount),
      output_count: 0,
      warning_count: 1,
    })
    throw error
  }
}

export const reportSkippedPipelineStage = <TStage extends string>(input: {
  pipeline: PipelineKind
  stage: TStage
  inputCount?: number
  observer?: PipelineStageObserver<TStage>
}): void => {
  emitPipelineDiagnostic(input.observer, {
    version: 1,
    pipeline: input.pipeline,
    stage: input.stage,
    status: 'skipped',
    duration_ms: 0,
    input_count: finiteCount(input.inputCount ?? 0),
    output_count: 0,
    warning_count: 0,
  })
}

export interface PipelineStageTimer {
  complete(outputCount: number, warningCount?: number): void
  fail(warningCount?: number): void
}

export const startPipelineStage = <TStage extends string>(input: {
  pipeline: PipelineKind
  stage: TStage
  inputCount: number
  observer?: PipelineStageObserver<TStage>
}): PipelineStageTimer => {
  const startedAt = performance.now()
  let reported = false
  const report = (status: PipelineStageStatus, outputCount: number, warningCount: number): void => {
    if (reported) {
      return
    }
    reported = true
    emitPipelineDiagnostic(input.observer, {
      version: 1,
      pipeline: input.pipeline,
      stage: input.stage,
      status,
      duration_ms: elapsedMilliseconds(startedAt),
      input_count: finiteCount(input.inputCount),
      output_count: finiteCount(outputCount),
      warning_count: finiteCount(warningCount),
    })
  }
  return {
    complete: (outputCount, warningCount = 0) => report('completed', outputCount, warningCount),
    fail: (warningCount = 1) => report('failed', 0, warningCount),
  }
}
