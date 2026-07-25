export interface PromptRunnerUsage {
  provider: 'claude' | 'gemini'
  source: 'structured_stdout'
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_total_tokens: number
  total_tokens: number
}

export interface ParsedPromptRunnerOutput {
  answerText: string | null
  usage: PromptRunnerUsage | null
}

type PromptRunnerOutputParser = (stdout: string) => ParsedPromptRunnerOutput | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseStructuredPromptAnswer(payload: Record<string, unknown>): string | null {
  if (typeof payload.result === 'string') {
    return payload.result
  }
  if (typeof payload.completion === 'string') {
    return payload.completion
  }
  return null
}

export function parsePromptRunnerJsonRecord(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return null
  }

  return isRecord(payload) ? payload : null
}

function parseClaudeStructuredUsage(payload: Record<string, unknown>): PromptRunnerUsage | null {
  if (!isRecord(payload.usage)) {
    return null
  }

  const inputTokens = parseNonNegativeNumber(payload.usage.input_tokens)
  const outputTokens = parseNonNegativeNumber(payload.usage.output_tokens)
  if (inputTokens === null || outputTokens === null) {
    return null
  }

  const cacheCreationInputTokens = parseNonNegativeNumber(payload.usage.cache_creation_input_tokens) ?? 0
  const cacheReadInputTokens = parseNonNegativeNumber(payload.usage.cache_read_input_tokens) ?? 0
  const inputTotalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens

  return {
    provider: 'claude',
    source: 'structured_stdout',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    input_total_tokens: inputTotalTokens,
    total_tokens: inputTotalTokens + outputTokens,
  }
}

export function parseClaudeStructuredPromptRunnerOutput(stdout: string): ParsedPromptRunnerOutput | null {
  const payload = parsePromptRunnerJsonRecord(stdout)
  if (payload === null) {
    return null
  }

  const answerText = parseStructuredPromptAnswer(payload)
  const usage = parseClaudeStructuredUsage(payload)
  if (answerText === null && usage === null) {
    return null
  }

  return {
    answerText,
    usage,
  }
}

function parseGeminiStructuredAnswer(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    return null
  }

  const firstCandidate = payload.candidates[0]
  if (!isRecord(firstCandidate) || !isRecord(firstCandidate.content) || !Array.isArray(firstCandidate.content.parts)) {
    return null
  }

  let answerText = ''
  for (const part of firstCandidate.content.parts) {
    if (isRecord(part) && typeof part.text === 'string') {
      answerText += part.text
    }
  }

  return answerText.length > 0 ? answerText : null
}

function parseGeminiStructuredUsage(payload: Record<string, unknown>): PromptRunnerUsage | null {
  if (!isRecord(payload.usageMetadata)) {
    return null
  }

  const inputTokens = parseNonNegativeNumber(payload.usageMetadata.promptTokenCount)
  const outputTokens = parseNonNegativeNumber(payload.usageMetadata.candidatesTokenCount)
  const totalTokens = parseNonNegativeNumber(payload.usageMetadata.totalTokenCount)
  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return null
  }

  return {
    provider: 'gemini',
    source: 'structured_stdout',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_total_tokens: inputTokens,
    total_tokens: totalTokens,
  }
}

export function parseGeminiStructuredPromptRunnerOutput(stdout: string): ParsedPromptRunnerOutput | null {
  const payload = parsePromptRunnerJsonRecord(stdout)
  if (payload === null) {
    return null
  }

  const answerText = parseGeminiStructuredAnswer(payload)
  const usage = parseGeminiStructuredUsage(payload)
  if (answerText === null && usage === null) {
    return null
  }

  return {
    answerText,
    usage,
  }
}

const PROMPT_RUNNER_OUTPUT_PARSERS: readonly PromptRunnerOutputParser[] = [
  parseClaudeStructuredPromptRunnerOutput,
  parseGeminiStructuredPromptRunnerOutput,
]

export function parsePlainTextPromptRunnerOutput(stdout: string): ParsedPromptRunnerOutput {
  return {
    answerText: stdout,
    usage: null,
  }
}

export function parsePromptRunnerOutput(stdout: string): ParsedPromptRunnerOutput {
  for (const parser of PROMPT_RUNNER_OUTPUT_PARSERS) {
    const parsedOutput = parser(stdout)
    if (parsedOutput !== null) {
      return parsedOutput
    }
  }

  return parsePlainTextPromptRunnerOutput(stdout)
}
