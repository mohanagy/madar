import { loadGraphArtifact } from '../../adapters/filesystem/graph-artifact.js'
import { readBuildState } from '../../domain/index/build-state.js'

export type CorpusBaselineSource = 'provided' | 'graph' | 'estimated'

export interface CorpusBaseline {
  words: number
  tokens: number
  source: CorpusBaselineSource
}

export interface CorpusBaselineOptions {
  graphPath?: string | undefined
  corpusWords?: number | null | undefined
}

export function corpusTokensFromWords(words: number): number {
  return Math.floor((Math.max(0, Math.floor(words)) * 100) / 75)
}

export function formatTokenRatio(corpusTokens: number, queryTokens: number): string {
  if (corpusTokens <= 0 || queryTokens <= 0) {
    return 'n/a'
  }

  if (corpusTokens >= queryTokens) {
    return `${Number((corpusTokens / queryTokens).toFixed(1))}x fewer`
  }

  return `${Number((queryTokens / corpusTokens).toFixed(1))}x more`
}

export function resolveCorpusBaseline(nodeCount: number, options: CorpusBaselineOptions = {}): CorpusBaseline {
  const providedWords = options.corpusWords
  if (typeof providedWords === 'number' && Number.isFinite(providedWords) && providedWords >= 0) {
    return {
      words: Math.floor(providedWords),
      tokens: corpusTokensFromWords(providedWords),
      source: 'provided',
    }
  }

  if (options.graphPath) {
    let graphWords: number | null = null
    try { graphWords = readBuildState(loadGraphArtifact(options.graphPath))?.corpus.total_words ?? null } catch { /* estimate below */ }
    if (typeof graphWords === 'number' && Number.isFinite(graphWords) && graphWords >= 0) {
      return {
        words: Math.floor(graphWords),
        tokens: corpusTokensFromWords(graphWords),
        source: 'graph',
      }
    }
  }

  const estimatedWords = nodeCount * 50
  return {
    words: estimatedWords,
    tokens: corpusTokensFromWords(estimatedWords),
    source: 'estimated',
  }
}
