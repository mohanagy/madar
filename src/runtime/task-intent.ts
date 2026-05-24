import {
  TASK_INTENT_DEFINITIONS,
  type TaskIntentClassification,
  type TaskIntentConfidence,
  type TaskIntentContextKind,
  type TaskIntentDefinition,
  type TaskIntentKind,
  type TaskIntentScore,
  type TaskIntentSignalRule,
} from '../contracts/task-intent.js'
import type { ContextPackTaskKind } from '../contracts/context-pack.js'

interface RuleMatch {
  kind: TaskIntentKind
  rule_id: string
  score: number
  matched_terms: string[]
}

function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function containsTerm(normalizedPrompt: string, normalizedTerm: string): boolean {
  if (normalizedPrompt.length === 0 || normalizedTerm.length === 0) {
    return false
  }

  return ` ${normalizedPrompt} `.includes(` ${normalizedTerm} `)
}

function promptTokens(normalizedPrompt: string): Set<string> {
  return new Set(normalizedPrompt.split(' ').filter((token) => token.length > 0))
}

function matchAnyPhrases(normalizedPrompt: string, phrases: readonly string[]): string[] {
  return phrases
    .map(normalizeTerm)
    .filter((phrase) => containsTerm(normalizedPrompt, phrase))
}

function matchAnyKeywords(tokens: ReadonlySet<string>, keywords: readonly string[]): string[] {
  return keywords
    .map(normalizeTerm)
    .filter((keyword) => keyword.length > 0 && !keyword.includes(' ') && tokens.has(keyword))
}

function matchKeywordGroups(tokens: ReadonlySet<string>, keywordGroups: readonly (readonly string[])[]): string[] | null {
  const matches: string[] = []
  for (const group of keywordGroups) {
    const found = group
      .map(normalizeTerm)
      .find((keyword) => keyword.length > 0 && !keyword.includes(' ') && tokens.has(keyword))
    if (!found) {
      return null
    }
    matches.push(found)
  }
  return matches
}

function taskIntentRuleLabel(definition: TaskIntentDefinition, rule: TaskIntentSignalRule): string {
  return `${definition.kind}.${rule.id}`
}

function validateSingleKeyword(
  definition: TaskIntentDefinition,
  rule: TaskIntentSignalRule,
  field: string,
  keyword: string,
): void {
  const normalizedKeyword = normalizeTerm(keyword)
  if (normalizedKeyword.length === 0) {
    throw new Error(
      `Invalid task intent rule ${taskIntentRuleLabel(definition, rule)}: ${field} must normalize to a non-empty single keyword, got "${keyword}"`,
    )
  }

  if (normalizedKeyword.includes(' ')) {
    throw new Error(
      `Invalid task intent rule ${taskIntentRuleLabel(definition, rule)}: ${field} must normalize to a single keyword, got "${keyword}"`,
    )
  }
}

function validateRuleDefinition(definition: TaskIntentDefinition, rule: TaskIntentSignalRule): void {
  const hasAnyPhrases = (rule.any_phrases?.length ?? 0) > 0
  const hasAnyKeywords = (rule.any_keywords?.length ?? 0) > 0
  const hasKeywordGroups = (rule.keyword_groups?.length ?? 0) > 0
  const matcherFieldCount = [hasAnyPhrases, hasAnyKeywords, hasKeywordGroups].filter(Boolean).length

  if (matcherFieldCount !== 1) {
    throw new Error(
      `Invalid task intent rule ${taskIntentRuleLabel(definition, rule)}: must define exactly one of any_phrases, any_keywords, or keyword_groups`,
    )
  }

  rule.any_keywords?.forEach((keyword, index) => {
    validateSingleKeyword(definition, rule, `any_keywords[${index}]`, keyword)
  })

  rule.keyword_groups?.forEach((group, groupIndex) => {
    if (group.length === 0) {
      throw new Error(
        `Invalid task intent rule ${taskIntentRuleLabel(definition, rule)}: keyword_groups[${groupIndex}] must contain at least one keyword`,
      )
    }

    group.forEach((keyword, keywordIndex) => {
      validateSingleKeyword(definition, rule, `keyword_groups[${groupIndex}][${keywordIndex}]`, keyword)
    })
  })
}

export function validateTaskIntentDefinitions(): void {
  TASK_INTENT_DEFINITIONS.forEach((definition) => {
    definition.rules.forEach((rule) => {
      validateRuleDefinition(definition, rule)
    })
  })
}

const VALIDATED_TASK_INTENT_DEFINITIONS = (() => {
  validateTaskIntentDefinitions()
  return TASK_INTENT_DEFINITIONS
})()

function evaluateRule(
  definition: TaskIntentDefinition,
  normalizedPrompt: string,
  tokens: ReadonlySet<string>,
  rule: TaskIntentSignalRule,
): RuleMatch | null {
  const matchedTerms = new Set<string>()
  let matched = false

  if (rule.any_phrases) {
    const phraseMatches = matchAnyPhrases(normalizedPrompt, rule.any_phrases)
    if (phraseMatches.length === 0) {
      return null
    }
    matched = true
    for (const phrase of phraseMatches) {
      matchedTerms.add(phrase)
    }
  }

  if (rule.any_keywords) {
    const keywordMatches = matchAnyKeywords(tokens, rule.any_keywords)
    if (keywordMatches.length === 0) {
      return null
    }
    matched = true
    for (const keyword of keywordMatches) {
      matchedTerms.add(keyword)
    }
  }

  if (rule.keyword_groups) {
    const keywordGroupMatches = matchKeywordGroups(tokens, rule.keyword_groups)
    if (!keywordGroupMatches) {
      return null
    }
    matched = true
    for (const keyword of keywordGroupMatches) {
      matchedTerms.add(keyword)
    }
  }

  if (!matched) {
    return null
  }

  return {
    kind: definition.kind,
    rule_id: rule.id,
    score: rule.score,
    matched_terms: [...matchedTerms].sort(),
  }
}

function compareDefinitions(left: TaskIntentDefinition, right: TaskIntentDefinition): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority
  }
  return left.kind.localeCompare(right.kind)
}

function taskIntentDefinition(kind: TaskIntentKind): TaskIntentDefinition {
  const definition = VALIDATED_TASK_INTENT_DEFINITIONS.find((entry) => entry.kind === kind)
  if (!definition) {
    throw new Error(`Missing task intent definition for ${kind}`)
  }
  return definition
}

function compareScores(left: TaskIntentScore, right: TaskIntentScore): number {
  if (left.score !== right.score) {
    return right.score - left.score
  }

  const leftDefinition = VALIDATED_TASK_INTENT_DEFINITIONS.find((definition) => definition.kind === left.kind)
  const rightDefinition = VALIDATED_TASK_INTENT_DEFINITIONS.find((definition) => definition.kind === right.kind)
  if (!leftDefinition || !rightDefinition) {
    return left.kind.localeCompare(right.kind)
  }

  return compareDefinitions(leftDefinition, rightDefinition)
}

function confidenceForScore(score: number): TaskIntentConfidence {
  if (score >= 10) {
    return 'high'
  }
  if (score >= 5) {
    return 'medium'
  }
  return 'low'
}

export function normalizeTaskIntentPrompt(prompt: string): string {
  return normalizeTerm(prompt)
}

export function defaultContextKindForTaskIntent(kind: TaskIntentKind): TaskIntentContextKind {
  return taskIntentDefinition(kind).default_context_kind
}

export function fallbackTaskIntentForContextKind(kind: TaskIntentContextKind): TaskIntentKind {
  switch (kind) {
    case 'implement':
      return 'implement'
    case 'review':
      return 'review'
    case 'impact':
      return 'impact'
    case 'explain':
    default:
      return 'explain'
  }
}

export interface ResolvedTaskSelection {
  classification: TaskIntentClassification
  explicit: boolean
  task_kind: ContextPackTaskKind
  task_intent: TaskIntentKind
}

export function resolveTaskSelection(
  prompt: string,
  requestedTask: ContextPackTaskKind = 'explain',
  options: { explicit?: boolean } = {},
): ResolvedTaskSelection {
  const classification = classifyTaskIntent(prompt)
  const explicit = options.explicit === true || requestedTask !== 'explain'
  const task_kind = explicit ? requestedTask : classification.default_context_kind
  const task_intent = explicit && task_kind !== classification.default_context_kind
    ? fallbackTaskIntentForContextKind(task_kind)
    : classification.kind

  return {
    classification,
    explicit,
    task_kind,
    task_intent,
  }
}

export function classifyTaskIntent(prompt: string): TaskIntentClassification {
  const normalizedPrompt = normalizeTaskIntentPrompt(prompt)
  const tokens = promptTokens(normalizedPrompt)
  const ruleMatches = VALIDATED_TASK_INTENT_DEFINITIONS
    .flatMap((definition) => definition.rules.map((rule) => evaluateRule(definition, normalizedPrompt, tokens, rule)))
    .filter((match): match is RuleMatch => match !== null)

  const scores = VALIDATED_TASK_INTENT_DEFINITIONS
    .map((definition): TaskIntentScore => ({
      kind: definition.kind,
      score: ruleMatches
        .filter((match) => match.kind === definition.kind)
        .reduce((total, match) => total + match.score, 0),
    }))
    .sort(compareScores)

  const winningKind = scores[0]?.kind ?? 'explain'
  const winningDefinition = taskIntentDefinition(winningKind)

  return {
    version: 1,
    prompt,
    normalized_prompt: normalizedPrompt,
    kind: winningDefinition.kind,
    default_context_kind: winningDefinition.default_context_kind,
    confidence: confidenceForScore(scores[0]?.score ?? 0),
    matched_rules: ruleMatches
      .slice()
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score
        }
        return left.rule_id.localeCompare(right.rule_id)
      })
      .map((match) => match.rule_id),
    matched_terms: [...new Set(ruleMatches.flatMap((match) => match.matched_terms))].sort(),
    scores,
  }
}
