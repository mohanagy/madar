// Retrieval gate (#75): decides how much repo context to retrieve before
// building a context pack. Pure deterministic heuristic — no ML, no I/O.
//
// Gate output is consumed by upstream callers (CLI, MCP tools, agent
// pipelines) to decide whether to skip retrieval entirely (level 0), pull
// only local symbol/file context (level 1-2), trace a behavior slice
// (level 3), expand to cross-module impact (level 4), or build the full
// PR-impact pack (level 5). A null-result is never returned: every prompt
// receives a level + reason so callers can log decisions transparently.
//
// Levels (per issue #75):
//   0 = no retrieval needed
//   1 = local symbol/file only
//   2 = direct dependencies
//   3 = behavior slice
//   4 = cross-module impact
//   5 = full PR impact pack
//
// The output type lives in src/contracts/retrieval-gate.ts so callers
// (e.g. CompiledContextPack) can carry the decision without depending on
// the runtime classifier itself.

import type {
  RetrievalGateDecision,
  RetrievalExcludedDomain,
  RetrievalGateSignals,
  RetrievalGenerationIntent,
  RetrievalIntent,
  RetrievalLevel,
  RetrievalTargetDomainHint,
} from '../contracts/retrieval-gate.js'

export type {
  RetrievalGateDecision,
  RetrievalExcludedDomain,
  RetrievalGateSignals,
  RetrievalGenerationIntent,
  RetrievalIntent,
  RetrievalLevel,
  RetrievalTargetDomainHint,
} from '../contracts/retrieval-gate.js'

export type RetrievalGateInput = {
  /** The user's prompt or task description. Required. */
  prompt: string
  /** Pre-classified intent. If absent, the gate derives it from the prompt. */
  intent?: RetrievalIntent
  /** Caller-known signal: a PR diff is available for analysis. */
  hasPrDiff?: boolean
  /** Caller-known signal: specific file paths the prompt is about. */
  mentionedPaths?: ReadonlyArray<string>
  /** Caller-known signal: specific symbols the prompt is about. */
  mentionedSymbols?: ReadonlyArray<string>
  /** Caller-known signal: the prompt embeds a stack trace or error text. */
  hasStackTrace?: boolean
  /**
   * Manual override. When set, bypasses all heuristics and the decision is
   * returned with reason `'manual override'`. The acceptance criteria of
   * #75 require the gate be overridable via CLI/MCP options.
   */
  manualOverride?: RetrievalLevel
}

// Heuristic patterns. Order matters where alternatives overlap (e.g. an
// "explain why" prompt is debug-shaped, not explain-shaped — debug wins).
const PATTERNS: ReadonlyArray<{ intent: RetrievalIntent; re: RegExp }> = [
  { intent: 'chitchat', re: /^\s*(?:hi|hey|hello|thanks?|thank you|yo|ok|okay|cool)\b[\s.!?]*$/i },
  { intent: 'debug',    re: /\b(?:why|debug|broken|crashe?s?|fail(?:s|ing|ed)?|exception|error|throws?|slow|hang(?:s|ing)?|leak(?:s|ing)?|deadlock|race condition)\b/i },
  { intent: 'impact',   re: /\b(?:impact|break(?:s|ing)?|regress(?:ion|ions)?|depend(?:s|ency|encies|ent)|affect(?:s|ed)?|consumers?|callers?)\b/i },
  { intent: 'review',   re: /\b(?:review|audit|critique|look (?:over|at this pr)|sanity[- ]check)\b/i },
  { intent: 'test',     re: /\b(?:test(?:s|ing)?|spec(?:s)?|coverage|missing tests?)\b/i },
  { intent: 'refactor', re: /\b(?:refactor|simplif(?:y|ied)|clean ?up|tidy|extract)\b/i },
  { intent: 'rename',   re: /\b(?:rename|format|fix typo|spell(?:ing)?|reword|capitaliz)\b/i },
  { intent: 'explain',  re: /\b(?:explain|what (?:does|is)|how does|describe|walk me through|tell me about|summari[sz]e)\b/i },
]

const PATH_RE = /(?:^|\s|`)((?:[\w@./-]+\/)*[\w./@-]+\.[A-Za-z]{1,8})(?=\b|`|$)/g
const SYMBOL_BACKTICK_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(?\)?)`/g
const SYMBOL_EXPLICIT_RE = /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:\.|#|::)[A-Za-z_$][\w$]*\(?\)?|[A-Za-z_$][\w$]{2,}\(\))\b/g
const STACK_TRACE_RE = /(?:^|\n)\s*at\s+\S+\s*\([^)]*:\d+(?::\d+)?\)|Error[:\s]\s+\S/
const EXCLUSION_SPAN_RE = /\b(?:exclude|excluding|ignore|ignoring|omit|omitting|skip|skipping|without|do not include|don't include|not|no)\b\s+(.+?)(?=(?:\s+\b(?:but|while|however|when)\b|[.;\n]|$))/gi

const EXCLUDED_DOMAIN_HINTS: ReadonlyArray<{ domain: RetrievalExcludedDomain; pattern: RegExp; pathHints: string[] }> = [
  { domain: 'test', pattern: /\b(?:tests?|specs?|coverage|__tests__|e2e|cypress|playwright)\b/i, pathHints: ['test', 'tests', '__tests__', 'spec', 'specs', 'coverage'] },
  { domain: 'benchmark', pattern: /\b(?:bench(?:mark|marks)?|performance|perf)\b/i, pathHints: ['bench', 'benchmark', 'benchmarks', 'perf', 'performance'] },
  { domain: 'fixture', pattern: /\b(?:fixtures?|mocks?|__fixtures__|__mocks__)\b/i, pathHints: ['fixture', 'fixtures', 'mock', 'mocks', '__fixtures__', '__mocks__'] },
  { domain: 'generated', pattern: /\b(?:generated|codegen|__generated__)\b/i, pathHints: ['generated', '__generated__'] },
  { domain: 'docs', pattern: /\b(?:docs?|readme|changelog|markdown|mdx?)\b/i, pathHints: ['docs', 'readme', 'changelog'] },
  { domain: 'config', pattern: /\b(?:config|configs?|settings|env|docker|compose|k8s|helm|package\.json|tsconfig)\b/i, pathHints: ['config', 'configs', 'settings', 'env', 'docker', 'compose', 'k8s', 'helm', 'package.json', 'tsconfig'] },
  { domain: 'build_artifact', pattern: /\b(?:build artifacts?|dist|coverage|out|node_modules)\b/i, pathHints: ['build', 'dist', 'coverage', 'out', 'node_modules'] },
]

export function classifyRetrievalLevel(input: RetrievalGateInput): RetrievalGateDecision {
  const prompt = input.prompt ?? ''
  const exclusions = extractPromptExclusions(prompt)
  const positivePrompt = exclusions.positivePrompt
  const detectedPaths = input.mentionedPaths ?? detectPaths(positivePrompt)
  const detectedSymbols = input.mentionedSymbols ?? detectSymbols(positivePrompt)
  const hasStackTrace = input.hasStackTrace ?? STACK_TRACE_RE.test(prompt)
  const hasPrDiff = input.hasPrDiff === true
  const intent = input.intent ?? detectIntent(positivePrompt)
  const generationIntent = detectGenerationIntent(positivePrompt)
  const targetDomainHint = targetDomainHintForGenerationIntent(generationIntent)

  const signals: RetrievalGateSignals = {
    has_pr_diff: hasPrDiff,
    has_stack_trace: hasStackTrace,
    mentioned_paths: detectedPaths,
    mentioned_symbols: detectedSymbols,
    generation_intent: generationIntent,
    target_domain_hint: targetDomainHint,
    ...(exclusions.excludedDomains.length > 0 ? { excluded_domains: exclusions.excludedDomains } : {}),
    ...(exclusions.excludedTerms.length > 0 ? { excluded_terms: exclusions.excludedTerms } : {}),
    ...(exclusions.excludedPathHints.length > 0 ? { excluded_path_hints: exclusions.excludedPathHints } : {}),
  }

  if (input.manualOverride !== undefined) {
    return {
      level: input.manualOverride,
      skipped_retrieval: input.manualOverride === 0,
      reason: 'manual override',
      intent,
      signals,
    }
  }

  const decision = decideLevel({ intent, hasPrDiff, hasStackTrace, mentions: detectedPaths.length + detectedSymbols.length })
  return {
    ...decision,
    skipped_retrieval: decision.level === 0,
    intent,
    signals,
  }
}

function decideLevel(opts: {
  intent: RetrievalIntent
  hasPrDiff: boolean
  hasStackTrace: boolean
  mentions: number
}): { level: RetrievalLevel; reason: string } {
  const { intent, hasPrDiff, hasStackTrace, mentions } = opts

  // Stack trace is strong evidence of a behavior-tracing question regardless
  // of intent classification.
  if (hasStackTrace) {
    return { level: 3, reason: 'stack trace detected — behavior slice retrieval' }
  }

  // PR diff dominates when present and the user is asking review/impact/test
  // questions about the change.
  if (hasPrDiff && (intent === 'review' || intent === 'impact' || intent === 'test')) {
    return { level: 5, reason: `PR diff present + ${intent} intent — full PR impact pack` }
  }

  switch (intent) {
    case 'chitchat':
      return { level: 0, reason: 'conversational prompt with no code intent — no retrieval' }
    case 'impact':
      return { level: 4, reason: 'impact intent without PR diff — cross-module impact' }
    case 'debug':
      return { level: 3, reason: 'debug/why intent — behavior slice retrieval' }
    case 'review':
      return { level: 3, reason: 'review intent without PR diff — behavior slice retrieval' }
    case 'test':
      return mentions > 0
        ? { level: 3, reason: 'test intent with explicit reference — behavior slice' }
        : { level: 4, reason: 'test intent without explicit reference — cross-module impact' }
    case 'explain':
      return mentions > 0
        ? { level: 2, reason: 'explain intent with explicit reference — direct dependencies' }
        : { level: 1, reason: 'explain intent without explicit reference — local context' }
    case 'refactor':
      // Both branches stay within the 0–2 band: a refactor without an
      // explicit target is still a code-modification intent, not a
      // debugging trace, so direct dependencies are sufficient and a
      // behavior slice would over-retrieve.
      return mentions > 0
        ? { level: 2, reason: 'refactor intent with explicit reference — direct dependencies' }
        : { level: 2, reason: 'refactor intent without explicit reference — direct dependencies' }
    case 'rename':
      return mentions > 0
        ? { level: 1, reason: 'rename intent with explicit reference — local symbol/file' }
        : { level: 0, reason: 'rename intent without explicit reference — no retrieval needed' }
    case 'unknown':
    default:
      // Conservative default: pull local context. Prompts that genuinely
      // need broader context can override or rely on caller-supplied
      // hints (mentionedPaths / hasPrDiff) on the next pass.
      return { level: 1, reason: 'unclassified prompt — default to local context' }
  }
}

function detectIntent(prompt: string): RetrievalIntent {
  for (const { intent, re } of PATTERNS) {
    if (re.test(prompt)) return intent
  }
  return 'unknown'
}

function detectGenerationIntent(prompt: string): RetrievalGenerationIntent {
  const lower = prompt.toLowerCase()
  const displayShaped = /\b(?:display(?:ed|ing)?|render(?:ed|ing)?|show(?:n|ing)?|visible|view|ui|frontend|front-end|component|screen|page|footer|header|label|date|timestamp)\b/i.test(lower)
  const generationShaped = /\b(?:generat(?:e|ed|es|ing|ion)|creat(?:e|ed|es|ing|ion)|build(?:s|ing|er)?|assembl(?:e|ed|es|ing)|produc(?:e|ed|es|ing)|persist(?:ed|ing)?|sav(?:e|ed|es|ing)|pipeline|runtime|orchestrator|worker|job|repository|service)\b/i.test(lower)
  const explanationShaped = /\b(?:explain|how|trace|walk|flow|path|lifecycle)\b/i.test(lower)

  if (generationShaped && explanationShaped) {
    return 'runtime_generation'
  }
  if (generationShaped && !displayShaped) {
    return 'runtime_generation'
  }
  if (displayShaped) {
    return 'display_rendering'
  }
  return 'unknown'
}

function targetDomainHintForGenerationIntent(intent: RetrievalGenerationIntent): RetrievalTargetDomainHint {
  switch (intent) {
    case 'runtime_generation':
      return 'backend_runtime'
    case 'display_rendering':
      return 'frontend_display'
    case 'unknown':
    default:
      return 'unknown'
  }
}

function detectPaths(prompt: string): string[] {
  const out = new Set<string>()
  for (const match of prompt.matchAll(PATH_RE)) {
    if (match[1]) out.add(match[1])
  }
  return [...out]
}

function detectSymbols(prompt: string): string[] {
  const out = new Set<string>()
  for (const match of prompt.matchAll(SYMBOL_BACKTICK_RE)) {
    if (match[1]) out.add(match[1])
  }
  for (const match of prompt.matchAll(SYMBOL_EXPLICIT_RE)) {
    const candidate = match[1]?.trim()
    if (!candidate) {
      continue
    }
    if (/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx)$/i.test(candidate) || candidate.includes('/')) {
      continue
    }
    out.add(candidate)
  }
  return [...out]
}

export function extractPromptExclusions(prompt: string): {
  excludedTerms: string[]
  excludedPathHints: string[]
  excludedDomains: RetrievalExcludedDomain[]
  positivePrompt: string
} {
  const excludedTerms = new Set<string>()
  const excludedPathHints = new Set<string>()
  const excludedDomains = new Set<RetrievalExcludedDomain>()
  const spans: Array<{ start: number; end: number }> = []

  for (const match of prompt.matchAll(EXCLUSION_SPAN_RE)) {
    const phrase = match[1]?.trim()
    const index = match.index
    if (!phrase || index === undefined) {
      continue
    }
    spans.push({ start: index, end: index + match[0].length })
    for (const term of splitExclusionPhrase(phrase)) {
      excludedTerms.add(term)
      const hint = normalizeExclusionPathHint(term)
      if (hint) {
        excludedPathHints.add(hint)
      }
      const trailingWord = term.split(/\s+/).at(-1)
      if (trailingWord && trailingWord !== term) {
        excludedTerms.add(trailingWord)
      }
      for (const mapping of EXCLUDED_DOMAIN_HINTS) {
        if (mapping.pattern.test(term)) {
          excludedDomains.add(mapping.domain)
          mapping.pathHints.forEach((pathHint) => excludedPathHints.add(pathHint))
        }
      }
    }
  }

  const positivePrompt = spans.length === 0
    ? prompt
    : compressPrompt(excludePromptSpans(prompt, spans))

  return {
    excludedTerms: [...excludedTerms],
    excludedPathHints: [...excludedPathHints],
    excludedDomains: [...excludedDomains],
    positivePrompt,
  }
}

function splitExclusionPhrase(phrase: string): string[] {
  return phrase
    .split(/\s*(?:,| and | or )\s*/i)
    .map((part) => part.trim().replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, ''))
    .map((part) => part.replace(/^(?:the|any|and)\s+/i, ''))
    .filter((part) => part.length > 0)
}

function normalizeExclusionPathHint(term: string): string | null {
  const normalized = term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.length > 0 ? normalized : null
}

function excludePromptSpans(prompt: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  let cursor = 0
  let out = ''
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    out += prompt.slice(cursor, span.start)
    cursor = span.end
  }
  out += prompt.slice(cursor)
  return out
}

function compressPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').replace(/\s+([,.;])/g, '$1').trim()
}
