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
// This module is intentionally small and dependency-free so the gate can
// be imported anywhere the runtime needs to make a retrieval decision
// without pulling the rest of the retrieve pipeline.

export type RetrievalLevel = 0 | 1 | 2 | 3 | 4 | 5

export type RetrievalIntent =
  | 'rename'
  | 'explain'
  | 'debug'
  | 'refactor'
  | 'test'
  | 'review'
  | 'impact'
  | 'chitchat'
  | 'unknown'

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

export type RetrievalGateSignals = {
  has_pr_diff: boolean
  has_stack_trace: boolean
  mentioned_paths: ReadonlyArray<string>
  mentioned_symbols: ReadonlyArray<string>
}

export type RetrievalGateDecision = {
  level: RetrievalLevel
  /** True iff level === 0 — caller can short-circuit retrieval entirely. */
  skipped_retrieval: boolean
  /** Human-readable explanation of why this level was selected. */
  reason: string
  /** Intent the gate inferred (or that the caller supplied). */
  intent: RetrievalIntent
  /** Signals the gate detected from the prompt + caller hints. */
  signals: RetrievalGateSignals
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
const STACK_TRACE_RE = /(?:^|\n)\s*at\s+\S+\s*\([^)]*:\d+(?::\d+)?\)|Error[:\s]\s+\S/

export function classifyRetrievalLevel(input: RetrievalGateInput): RetrievalGateDecision {
  const prompt = input.prompt ?? ''
  const detectedPaths = input.mentionedPaths ?? detectPaths(prompt)
  const detectedSymbols = input.mentionedSymbols ?? detectSymbols(prompt)
  const hasStackTrace = input.hasStackTrace ?? STACK_TRACE_RE.test(prompt)
  const hasPrDiff = input.hasPrDiff === true
  const intent = input.intent ?? detectIntent(prompt)

  const signals: RetrievalGateSignals = {
    has_pr_diff: hasPrDiff,
    has_stack_trace: hasStackTrace,
    mentioned_paths: detectedPaths,
    mentioned_symbols: detectedSymbols,
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
  return [...out]
}
