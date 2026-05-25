import { isRecord } from '../shared/guards.js'

export interface SemanticCandidate {
  id: string
  text: string
}

export interface SemanticRuntimeOptions {
  model?: string
  batchSize?: number
}

export const DEFAULT_SEMANTIC_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'
const OPTIONAL_TRANSFORMERS_PACKAGE = '@huggingface/transformers'

type TransformerPipeline = (input: unknown, options?: Record<string, unknown>) => Promise<unknown>

const pipelineCache = new Map<string, Promise<TransformerPipeline>>()

function numericArrayFromValue(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as Iterable<number>)
  }

  return null
}

function vectorFromOutput(output: unknown): number[] {
  const directVector = numericArrayFromValue(output)
  if (directVector) {
    return directVector
  }

  if (Array.isArray(output) && output.length > 0) {
    return vectorFromOutput(output[0])
  }

  if (isRecord(output)) {
    const dataVector = numericArrayFromValue(output.data)
    if (dataVector) {
      return dataVector
    }
  }

  throw new Error('[madar] Semantic model returned an unsupported embedding payload.')
}

function vectorsFromOutput(output: unknown, expectedCount: number): number[][] {
  if (Array.isArray(output)) {
    return output.map((entry) => vectorFromOutput(entry))
  }

  if (isRecord(output) && Array.isArray(output.dims) && output.dims.length >= 2) {
    const [rows, columns] = output.dims
    const data = numericArrayFromValue(output.data)
    if (typeof rows === 'number' && typeof columns === 'number' && data && rows === expectedCount) {
      const vectors: number[][] = []
      for (let index = 0; index < rows; index += 1) {
        vectors.push(data.slice(index * columns, (index + 1) * columns))
      }
      return vectors
    }
  }

  if (expectedCount === 1) {
    return [vectorFromOutput(output)]
  }

  throw new Error('[madar] Semantic model returned an unsupported batched embedding payload.')
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0
  }

  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

async function loadPipeline(task: string, model: string): Promise<TransformerPipeline> {
  const cacheKey = `${task}\u0000${model}`
  const cached = pipelineCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const pending = (async () => {
    try {
      const transformersModule = await import(OPTIONAL_TRANSFORMERS_PACKAGE) as {
        pipeline: (task: string, model: string) => Promise<TransformerPipeline>
      }
      return await transformersModule.pipeline(task, model)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingOptionalTransformersDependency(message)) {
        throw new Error(
          `[madar] Semantic retrieval requires the optional package '${OPTIONAL_TRANSFORMERS_PACKAGE}'. Install it with \`npm install ${OPTIONAL_TRANSFORMERS_PACKAGE}\` and rerun with --semantic or --rerank.`,
        )
      }
      throw new Error(`[madar] Failed to load local ${task} model '${model}': ${message}`)
    }
  })()

  pipelineCache.set(cacheKey, pending)
  return pending
}

function isMissingOptionalTransformersDependency(message: string): boolean {
  return (
    message.includes(`Cannot find package '${OPTIONAL_TRANSFORMERS_PACKAGE}'`) ||
    message.includes(`Cannot find module '${OPTIONAL_TRANSFORMERS_PACKAGE}'`) ||
    (message.includes('ERR_MODULE_NOT_FOUND') && message.includes(OPTIONAL_TRANSFORMERS_PACKAGE))
  )
}

function classificationScore(output: unknown): number {
  if (isRecord(output) && typeof output.score === 'number' && Number.isFinite(output.score)) {
    return output.score
  }

  if (!Array.isArray(output) || output.length === 0) {
    return 0
  }

  const scoredOutputs = output
    .filter(isRecord)
    .map((entry) => ({
      label: typeof entry.label === 'string' ? entry.label.toLowerCase() : '',
      score: typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : 0,
    }))

  const preferred = scoredOutputs.find((entry) => (
    entry.label.includes('relevant') ||
    entry.label.includes('positive') ||
    entry.label.includes('entail')
  ))
  if (preferred) {
    return preferred.score
  }

  return scoredOutputs.reduce((best, entry) => Math.max(best, entry.score), 0)
}

export async function rankCandidatesBySemanticSimilarity(
  question: string,
  candidates: readonly SemanticCandidate[],
  options: SemanticRuntimeOptions = {},
): Promise<Map<string, number>> {
  if (candidates.length === 0) {
    return new Map()
  }

  const embedder = await loadPipeline('feature-extraction', options.model ?? DEFAULT_SEMANTIC_MODEL)
  const questionVector = vectorFromOutput(await embedder(question, { pooling: 'mean', normalize: true }))
  const batchSize = options.batchSize ?? 32
  const scores = new Map<string, number>()

  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize)
    const batchVectors = vectorsFromOutput(
      await embedder(batch.map((candidate) => candidate.text), { pooling: 'mean', normalize: true }),
      batch.length,
    )

    batch.forEach((candidate, index) => {
      scores.set(candidate.id, cosineSimilarity(questionVector, batchVectors[index] ?? []))
    })
  }

  return scores
}

export async function rerankCandidatesWithCrossEncoder(
  question: string,
  candidates: readonly SemanticCandidate[],
  options: SemanticRuntimeOptions = {},
): Promise<Map<string, number>> {
  if (candidates.length === 0) {
    return new Map()
  }

  const reranker = await loadPipeline('text-classification', options.model ?? DEFAULT_RERANK_MODEL)
  const outputs = await reranker(
    candidates.map((candidate) => ({
      text: question,
      text_pair: candidate.text,
    })),
    { topk: 1 },
  )

  const normalizedOutputs = Array.isArray(outputs) ? outputs : [outputs]
  const scores = new Map<string, number>()
  candidates.forEach((candidate, index) => {
    scores.set(candidate.id, classificationScore(normalizedOutputs[index]))
  })
  return scores
}
