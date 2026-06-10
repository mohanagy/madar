import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isRecord } from '../shared/guards.js'

export interface SemanticCandidate {
  id: string
  text: string
}

export interface SemanticRuntimeOptions {
  model?: string
  batchSize?: number
  /** Project root to resolve the optional transformers package from, in
   *  addition to madar's own installation. Needed because npx-launched
   *  servers run from the npx cache, where a project-local
   *  `npm install @huggingface/transformers` is otherwise invisible. */
  projectRoot?: string
}

export const DEFAULT_SEMANTIC_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'
const OPTIONAL_TRANSFORMERS_PACKAGE = '@huggingface/transformers'
const DEFAULT_MODEL_LOAD_TIMEOUT_MS = 120_000

type TransformerPipeline = (input: unknown, options?: Record<string, unknown>) => Promise<unknown>

interface TransformersModule {
  pipeline: (task: string, model: string) => Promise<TransformerPipeline>
}

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

async function loadPipeline(task: string, model: string, projectRoot?: string): Promise<TransformerPipeline> {
  const resolvedRoot = resolve(projectRoot ?? process.cwd())
  const cacheKey = `${task}\u0000${model}\u0000${resolvedRoot}`
  const cached = pipelineCache.get(cacheKey)
  if (cached) {
    return cached
  }

  const pending = withLoadTimeout((async () => {
    try {
      const transformersModule = await importTransformersModule(resolvedRoot)
      return await transformersModule.pipeline(task, model)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('[madar]')) {
        throw error
      }
      if (isMissingOptionalTransformersDependency(message)) {
        throw missingTransformersError()
      }
      throw new Error(`[madar] Failed to load local ${task} model '${model}': ${message}`)
    }
  })(), task, model)

  pipelineCache.set(cacheKey, pending)
  pending.catch(() => {
    if (pipelineCache.get(cacheKey) === pending) {
      pipelineCache.delete(cacheKey)
    }
  })
  return pending
}

function missingTransformersError(): Error {
  return new Error(
    `[madar] Semantic retrieval requires the optional package '${OPTIONAL_TRANSFORMERS_PACKAGE}'. Run \`npm install ${OPTIONAL_TRANSFORMERS_PACKAGE}\` in your project root (madar resolves it from the project as well as its own installation), then retry with --semantic or --rerank.`,
  )
}

function findProjectTransformersDir(startDir: string): string | null {
  let current = resolve(startDir)
  for (;;) {
    const candidate = join(current, 'node_modules', '@huggingface', 'transformers')
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

function entryFromExportValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (isRecord(value)) {
    for (const condition of ['import', 'node', 'default']) {
      const nested = entryFromExportValue(value[condition])
      if (nested) {
        return nested
      }
    }
  }
  return null
}

function moduleEntryFromManifest(manifest: Record<string, unknown>): string {
  const exportsField = manifest.exports
  const rootExport = isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith('.'))
    ? exportsField['.']
    : exportsField
  const fromExports = entryFromExportValue(rootExport)
  if (fromExports) {
    return fromExports
  }
  if (typeof manifest.module === 'string') {
    return manifest.module
  }
  if (typeof manifest.main === 'string') {
    return manifest.main
  }
  return 'index.js'
}

async function importProjectTransformers(projectRoot: string): Promise<TransformersModule | null> {
  const packageDir = findProjectTransformersDir(projectRoot)
  if (!packageDir) {
    return null
  }

  const manifest: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (!isRecord(manifest)) {
    return null
  }
  const entryPath = join(packageDir, moduleEntryFromManifest(manifest))
  return await import(pathToFileURL(entryPath).href) as TransformersModule
}

async function importTransformersModule(projectRoot: string): Promise<TransformersModule> {
  try {
    return await import(OPTIONAL_TRANSFORMERS_PACKAGE) as TransformersModule
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!isMissingOptionalTransformersDependency(message)) {
      throw error
    }
    const projectModule = await importProjectTransformers(projectRoot)
    if (projectModule) {
      return projectModule
    }
    throw missingTransformersError()
  }
}

function modelLoadTimeoutMs(): number {
  const raw = Number.parseInt(process.env.MADAR_MODEL_LOAD_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MODEL_LOAD_TIMEOUT_MS
}

async function withLoadTimeout<T>(work: Promise<T>, task: string, model: string): Promise<T> {
  const timeoutMs = modelLoadTimeoutMs()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `[madar] Timed out loading ${task} model '${model}' after ${Math.round(timeoutMs / 1000)}s. Override with MADAR_MODEL_LOAD_TIMEOUT_MS or retry without --semantic/--rerank.`,
      ))
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function isMissingOptionalTransformersDependency(message: string): boolean {
  if (!message.includes(OPTIONAL_TRANSFORMERS_PACKAGE)) {
    return false
  }
  return (
    message.includes(`Cannot find package '${OPTIONAL_TRANSFORMERS_PACKAGE}'`) ||
    message.includes(`Cannot find module '${OPTIONAL_TRANSFORMERS_PACKAGE}'`) ||
    message.includes('ERR_MODULE_NOT_FOUND') ||
    // Bundler-flavoured resolution failures (e.g. vite/vitest dev transforms).
    /could not resolve|failed to resolve|failed to load/i.test(message)
  )
}

/** True when the optional transformers package is resolvable, either from
 *  madar's own installation or from the given project root. Used to gate the
 *  semantic/rerank tool-schema fields and the doctor report. */
export function isSemanticRuntimeAvailable(projectRoot?: string): boolean {
  try {
    const require = createRequire(import.meta.url)
    require.resolve(`${OPTIONAL_TRANSFORMERS_PACKAGE}/package.json`)
    return true
  } catch (error) {
    const code = isRecord(error) && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
    // PATH_NOT_EXPORTED still proves the package is installed; only a true
    // module-not-found means it is absent from madar's own tree.
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      return true
    }
  }
  return findProjectTransformersDir(projectRoot ?? process.cwd()) !== null
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

  const embedder = await loadPipeline('feature-extraction', options.model ?? DEFAULT_SEMANTIC_MODEL, options.projectRoot)
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

  const reranker = await loadPipeline('text-classification', options.model ?? DEFAULT_RERANK_MODEL, options.projectRoot)
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
