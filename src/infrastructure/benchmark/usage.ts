import { type PromptRunnerUsage } from '../prompt-runner.js'
import { type BenchmarkPromptTokenSource } from './runner.js'

export const QUERY_TOKEN_ESTIMATOR = {
  source: 'local_tokenizer',
  model: 'cl100k_base',
  exact: false,
} as const

export interface PromptUsageSummaryEntry {
  usage?: PromptRunnerUsage | null
  total_tokens?: number | null
  prompt_token_source?: BenchmarkPromptTokenSource | null
}

function usageRunCount(entries: readonly PromptUsageSummaryEntry[]): number {
  return entries.reduce((count, entry) => count + (entry.usage === null || entry.usage === undefined ? 0 : 1), 0)
}

export function usageProviderLabel(entries: readonly PromptUsageSummaryEntry[]): string {
  const providers = new Set(entries.flatMap((entry) => (entry.usage ? [entry.usage.provider] : [])))
  if (providers.size !== 1) {
    return 'Runner'
  }

  const [provider] = providers
  return provider === 'gemini' ? 'Gemini' : 'Claude'
}

export function averageInputTokenLabel(entries: readonly PromptUsageSummaryEntry[]): string {
  const usageRuns = usageRunCount(entries)
  const totalRuns = entries.length
  const providerLabel = usageProviderLabel(entries)

  if (usageRuns === totalRuns) {
    return `Avg input tokens (${providerLabel} reported)`
  }
  if (usageRuns > 0) {
    return `Avg input tokens (${providerLabel} reported where available; ${QUERY_TOKEN_ESTIMATOR.model} estimate fallback)`
  }
  return `Avg input tokens (estimated ${QUERY_TOKEN_ESTIMATOR.model})`
}

export function usageCaptureSummary(entries: readonly PromptUsageSummaryEntry[], subjectLabel: string): string | null {
  const usageRuns = usageRunCount(entries)
  if (usageRuns <= 0 || usageRuns >= entries.length) {
    return null
  }

  return `${usageProviderLabel(entries)} reported usage for ${usageRuns}/${entries.length} ${subjectLabel}; remaining runs used local estimate fallback`
}

export function averageReportedTotalTokens(entries: readonly PromptUsageSummaryEntry[]): number | null {
  if (entries.length === 0) {
    return null
  }

  let total = 0
  for (const entry of entries) {
    if (entry.total_tokens === null || entry.total_tokens === undefined) {
      return null
    }
    total += entry.total_tokens
  }
  return Math.floor(total / entries.length)
}

export function promptTokenSourceSuffix(source: BenchmarkPromptTokenSource | null | undefined): string {
  if (source === 'claude_reported_input') {
    return ' · Claude reported'
  }
  if (source === 'gemini_reported_input') {
    return ' · Gemini reported'
  }
  return source === 'estimated_cl100k_base' ? ` · estimated ${QUERY_TOKEN_ESTIMATOR.model}` : ''
}
