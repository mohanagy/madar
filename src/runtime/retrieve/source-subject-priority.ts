import { isPromptDataOffset, maskPromptRegions, scanPromptRegions } from '../../shared/prompt-regions.js'
import { retrievalEvidencePrompt } from '../retrieval-gate.js'
import { sourceBodyQueryTerms, sourceQueryIsLiteralLookup, sourceQueryLiterals, sourceRequestProse } from './source-evidence.js'

/** Later authored investigations can guide bounded source affinity, never call authority. */
export function sourceSubjectQueries(question: string): string[] {
  if (question.length > 12_000 || sourceQueryIsLiteralLookup(question)) return []
  const positive = retrievalEvidencePrompt(question), regions = scanPromptRegions(positive)
  const prose = sourceRequestProse(maskPromptRegions(positive, regions)).replace(
    /(?:\.\/)?[\w@-]+(?:[./\\][\w@*-]+)+/g, value => ' '.repeat(value.length),
  )
  const originalTerms = new Set(sourceBodyQueryTerms(question))
  const originalLiterals = new Set(sourceQueryLiterals(positive))
  const queries: string[] = []
  let start = 0, sentences = 0
  const append = (end: number): void => {
    const text = positive.slice(start, end).trim(), authored = prose.slice(start, end).trim()
    if (!authored) return
    if (sentences++ === 0 || !/^(?:(?:also|then|next|please)\s+)*(?:trace|explain|describe|investigate)\s+\S/i.test(authored)) return
    if (!sourceQueryLiterals(retrievalEvidencePrompt(text)).every(literal => originalLiterals.has(literal))
      || !sourceBodyQueryTerms(authored).some(term => !originalTerms.has(term))) return
    if (!queries.includes(authored)) queries.push(authored)
  }
  for (const boundary of prose.matchAll(/[.!?](?=\s|$)|[\r\n]+/g)) {
    if (isPromptDataOffset(regions, boundary.index)) continue
    append(boundary.index)
    if (queries.length > 8) return []
    start = boundary.index + boundary[0].length
  }
  append(positive.length)
  return queries.length <= 8 ? queries : []
}
