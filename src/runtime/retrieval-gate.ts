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

import { EXCLUDED_DOMAIN_HINTS, sourceExclusionPathOperand, sourceExclusionSymbolOperand, unquoteSourceExclusionOperand } from './source-exclusion-paths.js'
import { isPromptDataOffset, maskPromptRegions, scanPromptRegions, type PromptRegion } from '../shared/prompt-regions.js'

import type {
  RetrievalGateDecision,
  RetrievalExcludedDomain,
  RetrievalGateSignals,
  RetrievalGenerationDebugSignals,
  RetrievalGenerationIntent,
  RetrievalIntent,
  RetrievalLevel,
  RetrievalTargetDomainHint,
} from '../contracts/retrieval-gate.js'
import { classifyTaskIntent } from './task-intent.js'

export type {
  RetrievalGateDecision,
  RetrievalExcludedDomain,
  RetrievalGateSignals,
  RetrievalGenerationDebugSignals,
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
  { intent: 'explain',  re: /\b(?:explain|what (?:does|is|runs?)|how does|describe|walk me through|tell me about|summari[sz]e)\b/i },
]

const PATH_RE = /(?:^|\s|`)((?:[\w@./-]+\/)*[\w./@-]+\.[A-Za-z]{1,8})(?=\b|`|$)/g
// Only slash-qualified quoted paths extend the legacy delimiter grammar.
const QUOTED_PATH_RE = /(["'])((?:[\w@./-]+\/)+[\w./@-]+\.[A-Za-z]{1,8})\1/g
// Standalone parenthetical source references are common in follow-up requests.
// Keep this extension narrower than the legacy path grammar: a dotted member
// or a function argument must not become a new file-scope instruction.
const PARENTHETICAL_SOURCE_PATH_RE = /(?:^|\s)\(([\w@./-]+\.(?:[cm]?[jt]sx?|json))\)(?=$|\s|[.,;:!?](?=\s|$))/gi
const DIRECTORY_RE = /(?:^|[\s`"'(])((?:[\w@.-]+[\\/])+)(?=$|[\s`"'),;:!?]|\.(?=\s|$))/g
const SYMBOL_BACKTICK_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(?\)?)`/g
const SYMBOL_EXPLICIT_RE = /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:\.|#|::)[A-Za-z_$][\w$]*\(?\)?|[A-Za-z_$][\w$]{2,}\(\))\b/g
const STACK_TRACE_RE = /(?:^|\n)\s*at\s+\S+\s*\([^)]*:\d+(?::\d+)?\)|Error[:\s]\s+\S/
// A filename/member dot is part of the operand; only sentence periods end it.
const EXCLUSION_SPAN_RE = /\b(?:exclude|excluding|ignore|ignoring|omit|omitting|skip|skipping|without|except|do not include|don't include|not|no)\b\s+(.+?)(?=(?:\s+\b(?:but|while|however|when)\b|[;\n]|[.!?](?=\s|$)|$))/gi
const EVIDENCE_SCOPE_ITEM = String.raw`(?:the\s+)?(?:source(?:\s+code)?|tests?|config(?:uration)?(?:\s+files)?|(?:root\s+)?README(?:\.md)?)`
const EVIDENCE_SCOPE_LIST = `${EVIDENCE_SCOPE_ITEM}(?:\\s*(?:,\\s*(?:and\\s+)?|\\band\\s+|\\bor\\s+)${EVIDENCE_SCOPE_ITEM})*`
const EVIDENCE_SCOPE_LOCATION = String.raw`(?:\s+(?:in|from|within)\s+(?:(?:this|the|current)\s+)?(?:workspace|repository|repo|working\s+directory))?`
const EVIDENCE_SCOPE_DIRECTIVE_RE = new RegExp(
  `\\b(?:use|consult|consider|inspect|read|search)\\s+(?:only\\s+${EVIDENCE_SCOPE_LIST}|${EVIDENCE_SCOPE_LIST}\\s+only)${EVIDENCE_SCOPE_LOCATION}\\s*(?=[.;\\n]|$)[.;]?`,
  'gi',
)

const EVIDENCE_INVENTORY_RE = new RegExp(`^${EVIDENCE_SCOPE_LIST}\\s+(?:is|are)\\s+(?:the\\s+)?(?:only\\s+)?(?:allowed\\s+)?evidence$`, 'i')
const SOURCE_POSTURE_RE = /^(?:use|consult)\s+(?:(?:the|this)\s+)?(?:(?:committed|local)\s+)?(?:(?:repository|repo)\s+)?source(?:\s+code)?\s+for\s+(?:(?:this|the)\s+)?read[- ]only\s+(?:analysis|review|investigation)$/i
const ANSWER_FORMAT_RE = /^(?:give|provide|return|write)\s+(?:(?:a|the)\s+)?(?:(?:concise|brief|short|detailed)\s+)?(?:answer|response|summary)\s+with\s+(?:(?:repository[- ]relative|relative)\s+)?(?:file(?:\s+and\s+line)?|source|code)\s+(?:citations|references)$/i

/** Only complete, unquoted clauses can be procedural. A sentence about the
 * same words (authentication, tests, configuration, etc.) remains evidence. */
function removeProceduralClauses(prompt: string, rankingOnly: boolean): string {
  const regions = scanPromptRegions(prompt)
  const spans: Array<{ start: number; end: number }> = []
  let start = 0, regionIndex = 0
  for (const boundary of prompt.matchAll(/[;\r\n]|[.!?](?=\s|$)|$/g)) {
    if (isPromptDataOffset(regions, boundary.index)) continue
    const end = boundary.index + boundary[0].length
    const clause = prompt.slice(start, boundary.index).trim()
    while (regions[regionIndex] && regions[regionIndex]!.end <= start) regionIndex++
    const data = regions[regionIndex] !== undefined && regions[regionIndex]!.start < end
    if (!data && (SOURCE_POSTURE_RE.test(clause) || ANSWER_FORMAT_RE.test(clause)
      || (EVIDENCE_INVENTORY_RE.test(clause) && /\bsource\b/i.test(clause))
      || (rankingOnly && isProceduralProhibition(clause)))) spans.push({ start, end })
    start = end
  }
  return maskPromptRegions(prompt, spans).trim()
}

/** General agent actions only; conditional requirements and named code targets
 * are deliberately retained. This view must never enforce source-access policy. */
function isProceduralProhibition(clause: string): boolean {
  const prohibition = /^(?:please\s+)?(?:do not|don't|never)\s+(.+)$/i.exec(clause)
  if (!prohibition) return false
  let action = ''
  return prohibition[1]!.split(/\s*(?:,\s*(?:(?:and|or)\s+)?|\b(?:and|or)\b)\s*/i).every(operand => {
    const explicit = /^(change|modify|edit|write|delete|create|remove|run|execute|make|perform|read|access|expose)\s+(.+)$/i.exec(operand)
    if (explicit) action = explicit[1]!.toLowerCase()
    const object = (explicit?.[2] ?? operand).replace(/^(?:any|the|these)\s+/i, '')
    if (/^(?:change|modify|edit|write|delete|create|remove)$/.test(action)) return /^(?:files?|code|source(?:\s+files?)?|repository|repo)$/i.test(object)
    if (/^(?:run|execute)$/.test(action)) return /^(?:tests?|commands?|scripts?|server|application|app)$/i.test(object)
    if (/^(?:make|perform)$/.test(action)) return /^network\s+(?:calls?|requests?)$/i.test(object)
    if (/^(?:read|access|expose)$/.test(action)) return /^(?:secrets?(?:\/environment\s+files?)?|environment\s+files?|runtime\s+user\s+data)$/i.test(object)
    return false
  })
}

/** Remove generic task framing without removing concrete source restrictions. */
export function retrievalSubjectPrompt(prompt: string): string {
  const regions = scanPromptRegions(prompt)
  const subject = prompt.replace(EVIDENCE_SCOPE_DIRECTIVE_RE, (clause, offset: number) => (
    !isPromptDataOffset(regions, offset) && /\bsource\b/i.test(clause)
      && /\b(?:tests?|config(?:uration)?|readme)\b/i.test(clause) ? ' ' : clause
  ))
  return removeProceduralClauses(subject, false)
}

/** Ranking-only view. The original prompt must still supply exclusions and
 * policy; removing a prohibition here does not grant permission to ignore it. */
export function retrievalSearchPrompt(prompt: string): string {
  return removeProceduralClauses(retrievalSubjectPrompt(prompt), true)
}

const COMPLETE_ARTIFACT_OPERANDS = EXCLUDED_DOMAIN_HINTS.map(mapping => ({
  domain: mapping.domain,
  pattern: new RegExp(`^(?:${mapping.pattern.source})$`, mapping.pattern.flags),
}))

/** The existing action prohibitions are separate from source exclusions. */
function isOperationalExclusionOperand(term: string): boolean {
  return /^(?:change|modify|edit|write|create|delete|remove|mutate|overwrite|run|execute|invoke|call)\b/i.test(term)
    || /^(?:read|search|access)\s+(?:outside|beyond)\b/i.test(term)
    || /^browse\s+(?:the\s+)?(?:web|internet)\b/i.test(term)
}

/** Ambiguous modifiers need a whole evidence operand, not a domain word inside a condition. */
function hasCompleteEvidenceOperands(phrase: string, allowOperations: boolean): boolean {
  const operands = phrase.split(/\s*(?:,| and | or )\s*/i)
    .map(value => value.trim().replace(/^[`"']|[`"']$/g, '').replace(/^(?:the|any)\s+/i, '').trim())
  return operands.length > 0 && operands.every(operand => {
    if (!operand) return false
    if (allowOperations && isOperationalExclusionOperand(operand)) return true
    if (sourceExclusionPathOperand(operand)) return true
    if (sourceExclusionSymbolOperand(operand)) return true
    // Slash-qualified paths retain their syntax here. The output normalizer
    // below still supplies the existing path hints and domain classifications.
    if (/^(?:(?:[A-Za-z]:)?[/\\]|\.{1,2}[/\\])?(?:[\w@.-]+[/\\])+[\w@.*-]*$/.test(operand)) return true
    if (/^[\w@.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|toml|mdx?)$/i.test(operand)) return true
    if (COMPLETE_ARTIFACT_OPERANDS.some(mapping => mapping.domain !== 'config' && mapping.pattern.test(operand))) return true
    const qualified = /^(.*?)\s+(?:source(?:\s+files?)?|files?|directories|folders?|code|artifacts?)$/i.exec(operand)
    return !!qualified && COMPLETE_ARTIFACT_OPERANDS.some(mapping => mapping.pattern.test(qualified[1]!))
  })
}

/** A do-not action can constrain evidence only through a complete source scope. */
function sourceAccessExclusionOperands(phrase: string): string[] {
  const operands: string[] = []
  let sourceAccess = false
  for (const part of phrase.split(/\s*(?:,| and | or )\s*/i)) {
    const operand = part.trim().replace(/^(?:and|or)\s+/i, '')
    const access = /^(?:read|use|access|search|inspect|consult|consider)\s+(.+)$/i.exec(operand)
    const scope = access?.[1] ?? operand
    // A noun continuation inherits its preceding source-access action, never
    // an unrelated action such as "infer", "compare", or "run".
    const quotedSymbol = /^`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?`$/.test(scope.trim())
    sourceAccess = (access !== null || sourceAccess)
      && (hasCompleteEvidenceOperands(scope, false) || sourceExclusionPathOperand(scope) || quotedSymbol)
    if (sourceAccess) operands.push(...splitExclusionPhrase(scope))
  }
  return operands
}

function exclusionInstructionPrefix(prompt: string, index: number): string {
  const before = prompt.slice(0, index)
  const sentenceStart = [...before.matchAll(/[;!?\n]|\.(?=\s|$)/g)].at(-1)
  return before.slice(sentenceStart ? sentenceStart.index + sentenceStart[0].length : 0).trim()
}

/** Do not let a described condition consume a later explicit exclusion. */
function exclusionSpans(prompt: string, regions: readonly PromptRegion[]): Array<{ start: number; operatorStart: number; end: number; phrase: string }> {
  const spans: Array<{ start: number; operatorStart: number; end: number; phrase: string }> = []
  for (const match of prompt.matchAll(EXCLUSION_SPAN_RE)) {
    let start = match.index, operatorStart = start
    const end = start + match[0].length
    const add = (last: number): void => {
      const text = prompt.slice(operatorStart, last)
      const operator = /^(?:do not include|don't include|\w+)\b\s+/i.exec(text)
      if (operator) spans.push({ start, operatorStart, end: last, phrase: text.slice(operator[0].length).trim() })
    }
    for (const boundary of match[0].matchAll(/(?:,\s*(?:(?:and|but|however)\s+)?|\band\s+)(?:please\s+)?(?=(?:exclude|ignore|omit|skip|do not include|don't include)\b)/gi)) {
      const next = match.index + boundary.index + boundary[0].length
      if (isPromptDataOffset(regions, next)) continue
      const boundaryStart = match.index + boundary.index
      add(boundaryStart)
      start = boundaryStart; operatorStart = next
    }
    add(end)
  }
  return spans
}

export function classifyRetrievalLevel(input: RetrievalGateInput): RetrievalGateDecision {
  const prompt = input.prompt ?? ''
  const exclusions = extractPromptExclusions(prompt)
  // An evidence allowlist is not the task being requested. Keep its original
  // scope in the caller's prompt, but do not infer "write tests" or a README
  // lookup from "Use only source, tests, configuration, and root README.md".
  const positivePrompt = retrievalSubjectPrompt(exclusions.positivePrompt)
  const detectedPaths = input.mentionedPaths ?? detectPaths(positivePrompt)
  const detectedDirectories = detectDirectories(positivePrompt)
  const detectedSymbols = input.mentionedSymbols ?? detectSymbols(positivePrompt)
  const hasStackTrace = input.hasStackTrace ?? STACK_TRACE_RE.test(prompt)
  const hasPrDiff = input.hasPrDiff === true
  const intent = input.intent ?? detectIntent(positivePrompt)
  const generationClassification = detectGenerationIntent(positivePrompt)
  const generationIntent = generationClassification.intent
  const targetDomainHint = targetDomainHintForGenerationIntent(generationIntent)

  const signals: RetrievalGateSignals = {
    has_pr_diff: hasPrDiff,
    has_stack_trace: hasStackTrace,
    mentioned_paths: detectedPaths,
    ...(detectedDirectories.length ? { mentioned_directories: detectedDirectories } : {}),
    mentioned_symbols: detectedSymbols,
    generation_intent: generationIntent,
    target_domain_hint: targetDomainHint,
    generation_debug: generationClassification.debug,
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

  const decision = decideLevel({
    intent,
    generationIntent,
    executionOwnerShaped: /\bwhat runs?\b/i.test(positivePrompt),
    hasPrDiff,
    hasStackTrace,
    mentions: detectedPaths.length + detectedSymbols.length,
  })
  return {
    ...decision,
    skipped_retrieval: decision.level === 0,
    intent,
    signals,
  }
}

function decideLevel(opts: {
  intent: RetrievalIntent
  generationIntent: RetrievalGenerationIntent
  executionOwnerShaped: boolean
  hasPrDiff: boolean
  hasStackTrace: boolean
  mentions: number
}): { level: RetrievalLevel; reason: string } {
  const { intent, generationIntent, executionOwnerShaped, hasPrDiff, hasStackTrace, mentions } = opts

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

  if (generationIntent === 'runtime_generation' && (intent === 'unknown' || intent === 'explain')) {
    return { level: 3, reason: 'runtime generation intent — behavior slice retrieval' }
  }

  if (executionOwnerShaped && (intent === 'unknown' || intent === 'explain')) {
    return { level: 3, reason: 'runtime flow question — behavior slice retrieval' }
  }

  switch (intent) {
    case 'chitchat':
      return { level: 0, reason: 'conversational prompt with no code intent — no retrieval' }
    case 'impact':
      return { level: 4, reason: 'impact intent without PR diff — cross-module impact' }
    case 'implement':
      return { level: 2, reason: 'implementation intent — direct dependencies' }
    case 'migrate':
      return { level: 2, reason: 'migration intent — direct dependencies' }
    case 'document':
      return mentions > 0
        ? { level: 2, reason: 'documentation intent with explicit reference — direct dependencies' }
        : { level: 1, reason: 'documentation intent without explicit reference — local context' }
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
  const taskIntent = classifyTaskIntent(prompt).kind
  if (taskIntent === 'implement' || taskIntent === 'migrate' || taskIntent === 'document') {
    return taskIntent
  }

  for (const { intent, re } of PATTERNS) {
    if (re.test(prompt)) return intent
  }
  return 'unknown'
}

function detectGenerationIntent(prompt: string): {
  intent: RetrievalGenerationIntent
  debug: RetrievalGenerationDebugSignals
} {
  const lower = prompt.toLowerCase()
  const displayShaped = /\b(?:display(?:ed|ing)?|render(?:ed|ing)?|show(?:n|ing)?|visible|view|ui|frontend|front-end|component|screen|page|footer|header|label|date|timestamp)\b/i.test(lower)
  const genericGenerationShaped = /\b(?:generat(?:e|ed|es|ing|ion)|creat(?:e|ed|es|ing|ion)|build(?:s|ing|er)?|assembl(?:e|ed|es|ing)|produc(?:e|ed|es|ing))\b/i.test(lower)
  const backendRuntimeShaped = /\b(?:pipeline|runtime|orchestrator|worker|job|repository|service|controller|api|backend|persist(?:ed|ing)?|sav(?:e|ed|es|ing)|db(?:sync|[- ]sync)?)\b/i.test(lower)
  const reportGenerationShaped = /\b(?:idea\s+report|report\s+generation|final\s+report|planner|research|metrics?|scor(?:e|ing)|quality(?:\s|-)?gate|renderer|synthesis|assemble|assembly)\b/i.test(lower)
  const buildStaticShaped = /\b(?:next\.js|nextjs|app\s+router|route\s+segment|landing\s+page|static|ssg|isr|server\s+component)\b/i.test(lower)
  const explanationShaped = /\b(?:explain|how|why|trace|walk|flow|path|lifecycle|fail(?:s|ing|ed)?)\b/i.test(lower)
  const flowProofShaped =
    /\b(?:trace|walk(?:\s+me)?\s+through|flow|path|lifecycle|end-to-end|what (?:happens when|runs?)|through(?:\s+the)?\s+(?:runtime|pipeline)|reaches?)\b/i.test(lower)
    || (
      /\b(?:how|explain)\b/i.test(lower)
      && /\b(?:generated|built|assembled|produced|created|persist(?:ed|ing)?|saved?|handoff|handoffs)\b/i.test(lower)
    )
  const debug: RetrievalGenerationDebugSignals = {
    display_shaped: displayShaped,
    generic_generation_shaped: genericGenerationShaped,
    backend_runtime_shaped: backendRuntimeShaped,
    report_generation_shaped: reportGenerationShaped,
    build_static_shaped: buildStaticShaped,
    explanation_shaped: explanationShaped,
    flow_proof_shaped: flowProofShaped,
  }

  const strongRuntimeShaped = backendRuntimeShaped || reportGenerationShaped

  if (buildStaticShaped && !strongRuntimeShaped) {
    return { intent: 'unknown', debug }
  }
  if (displayShaped && !strongRuntimeShaped) {
    return { intent: 'display_rendering', debug }
  }
  if (strongRuntimeShaped && (genericGenerationShaped || explanationShaped)) {
    return { intent: 'runtime_generation', debug }
  }
  if (genericGenerationShaped && explanationShaped && !displayShaped && !buildStaticShaped) {
    return { intent: 'runtime_generation', debug }
  }
  if (displayShaped) {
    return { intent: 'display_rendering', debug }
  }
  return { intent: 'unknown', debug }
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
    if (/^[\\/]/.test(prompt.slice(match.index + match[0].length))) continue
    if (match[1]) out.add(match[1])
  }
  for (const match of prompt.matchAll(QUOTED_PATH_RE)) {
    if (match[2]) out.add(match[2])
  }
  // Unconsumed exclusion syntax is ambiguous here (an operand can contain a
  // filename dot). Preserve legacy detection instead of adding a positive scope.
  if (exclusionSpans(prompt, scanPromptRegions(prompt)).length) return [...out]
  const quoted = [...prompt.matchAll(/`[^`\n]*`|"(?:\\.|[^"\\])*"|(?<!\w)'(?:\\.|[^'\\])*'(?!\w)/g)]
  for (const match of prompt.matchAll(PARENTHETICAL_SOURCE_PATH_RE)) {
    const start = match.index + match[0].indexOf('(')
    if (!quoted.some(quote => quote.index <= start && start < quote.index + quote[0].length)) out.add(match[1]!)
  }
  return [...out]
}

/** A directory narrows where to look; it does not request every declaration there. */
function detectDirectories(prompt: string): string[] {
  const out = new Set<string>()
  for (const match of prompt.matchAll(DIRECTORY_RE)) {
    const normalized = match[1]!.replaceAll('\\', '/')
    const segments = normalized.split('/').filter(Boolean)
    if (segments[0] === '.') segments.shift()
    if (!segments.length || segments.some(segment => segment === '.' || segment === '..')) continue
    out.add(`${segments.join('/')}/`)
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

/** A verb describing the code is not an instruction to remove that evidence. */
function isInstructionalExclusion(prompt: string, regions: readonly PromptRegion[], index: number, phrase: string, coordinatedImperative = false): boolean {
  // Quoted source/error text is the subject, including phrases such as
  // `ignore invalid records`. Quotes around the excluded operand still work.
  if (isPromptDataOffset(regions, index)) return false
  const prefix = exclusionInstructionPrefix(prompt, index)
  const operator = prompt.slice(index, index + 24).match(/^(?:do not include|don't include|\w+)/i)?.[0]?.toLowerCase()
  if ((operator === 'not' || operator === 'no') && /^(?:exclude|ignore|omit|skip)\b/i.test(phrase)) return false
  const polite = /^(?:(?:please|kindly)\s*)?(?:(?:you\s+(?:must|should|can)|(?:can|could|would|will)\s+you)\s*)?(?:please\s*)?$/i
  // Preserve do-not action prohibitions for the caller to strip from intent;
  // only complete source-access operands may become evidence exclusions.
  if (operator === 'not' && /^(?:please\s+)?do$/i.test(prefix)) return true
  const imperative = /^(?:exclude|ignore|omit|skip|do not include|don't include)$/.test(operator ?? '')
  if (imperative && coordinatedImperative) return true
  if (!imperative && !hasCompleteEvidenceOperands(phrase, /^(?:not|no|without)$/.test(operator ?? ''))) return false
  if (polite.test(prefix)) {
    if ((operator === 'no' || operator === 'not') && /\b(?:is|are|was|were|has|have|had|can|could|may|might|will|would|should|must|remains?|exists?|matches?|happens?)\b/i.test(phrase)) return false
    return true
  }
  // A request can coordinate a second instruction: "Explain X but ignore Y".
  // Questions and subordinate clauses instead describe runtime behavior.
  const directRequest = /^(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:only\s+)?(?:explain|describe|show|find|locate|read|search|inspect|review|summari[sz]e|trace|list|use|consider|analy[sz]e)\b/i.test(prefix)
  if (!directRequest) return false
  // The comma ends the described behavior before a separate instruction:
  // "Explain how X works, but ignore Y". Without that boundary, preserve
  // subordinate verbs in "Explain why X includes A but ignores B".
  if (imperative && /,\s*(?:but|however)(?:\s+please)?$/i.test(prefix)) return true
  if (/\b(?:how|why|what|which|when|where|whether|if|unless|that|whose|until)\b/i.test(prefix)) return false
  if (imperative) {
    return /(?:,|\b(?:and|but|while|however))\s*(?:please\s*)?$/i.test(prefix)
  }
  if (operator === 'not' || operator === 'no') return /(?:,|\bbut)\s*$/i.test(prefix)
  // "Show X excluding tests" and "Explain X without docs" scope a direct
  // request; the same modifiers inside "how/when/if ..." remain evidence.
  return true
}

function parsePromptExclusions(prompt: string, regions: readonly PromptRegion[]): {
  excludedTerms: string[]
  excludedPathHints: string[]
  excludedDomains: RetrievalExcludedDomain[]
  positivePrompt: string
  spans: Array<{ start: number; end: number }>
} {
  const excludedTerms = new Set<string>()
  const excludedPathHints = new Set<string>()
  const excludedDomains = new Set<RetrievalExcludedDomain>()
  const spans: Array<{ start: number; end: number }> = []
  let previousInstructionEnd: number | undefined

  for (const match of exclusionSpans(prompt, regions)) {
    const phrase = match.phrase
    // Only an already accepted directive supplies this context, including an
    // operational prohibition or a standalone scope such as "No tests".
    // Rejected descriptions and quoted source never supply it.
    const coordinated = previousInstructionEnd !== undefined
      && /^\s*(?:,\s*(?:(?:and|but|however)\s+)?|(?:and|but|while|however)\s+)(?:please\s+)?$/i.test(prompt.slice(previousInstructionEnd, match.operatorStart))
    if (!phrase || !isInstructionalExclusion(prompt, regions, match.operatorStart, phrase, coordinated)) {
      continue
    }
    spans.push({ start: match.start, end: match.end })
    previousInstructionEnd = match.end
    const actionProhibition = /^not\b/i.test(prompt.slice(match.operatorStart, match.end))
      && /^(?:please\s+)?do$/i.test(exclusionInstructionPrefix(prompt, match.operatorStart))
    const terms = actionProhibition ? sourceAccessExclusionOperands(phrase) : splitExclusionPhrase(phrase)
    for (const term of terms) {
      // A prohibition on agent actions is not an exclusion of source evidence.
      // For example, "do not change files or run tests" still permits reading
      // those files, and "do not read outside this workspace" does not exclude
      // source whose absolute path contains the word "workspace".
      if (!actionProhibition && /^(?:not|no|without)\b/i.test(prompt.slice(match.operatorStart, match.end)) && isOperationalExclusionOperand(term)) continue
      excludedTerms.add(term)
      // A specific source scope does not exclude its extension or every file
      // in a domain whose word happens to appear in its basename.
      if (sourceExclusionPathOperand(term) || sourceExclusionSymbolOperand(term)) continue
      const hint = normalizeExclusionPathHint(term)
      if (hint) {
        excludedPathHints.add(hint)
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
    spans,
  }
}

/** Preserve the public evidence result, including its original positive prompt. */
export function extractPromptExclusions(prompt: string): {
  excludedTerms: string[]
  excludedPathHints: string[]
  excludedDomains: RetrievalExcludedDomain[]
  positivePrompt: string
} {
  const { spans: _spans, ...result } = parsePromptExclusions(prompt, scanPromptRegions(prompt))
  return result
}

/** Evidence view: remove accepted instructions without rewriting quoted data.
 * The public positivePrompt remains normalized for its existing consumers.
 */
export function retrievalEvidencePrompt(prompt: string): string {
  const { spans } = parsePromptExclusions(prompt, scanPromptRegions(prompt))
  return retrievalSubjectPrompt(maskPromptRegions(prompt, spans))
}

/** Preserve legacy noun-pass normalization while denying request nouns inside data. */
export function retrievalSymbolKeywordPrompt(prompt: string): string {
  const regions = scanPromptRegions(prompt)
  const { spans } = parsePromptExclusions(prompt, regions)
  const nouns = [...prompt.matchAll(/\b(?:functions?|methods?|symbols?)(?=\s+[`'"]?[A-Za-z_$])/g)]
    .filter(match => isPromptDataOffset(regions, match.index))
    .map(match => ({ start: match.index, end: match.index + match[0].length }))
  const masked = maskPromptRegions(prompt, nouns)
  return retrievalSubjectPrompt(spans.length === 0 ? masked : compressPrompt(excludePromptSpans(masked, spans)))
}

/** Instruction-only view. Discover regions and exclusions on the original text
 * before whitespace compression can erase fence boundaries. Quoted operands
 * remain source scopes, while their entire accepted exclusion is masked here. */
export function retrievalDirectivePrompt(prompt: string): string {
  const regions = scanPromptRegions(prompt)
  const { spans } = parsePromptExclusions(prompt, regions)
  return retrievalSubjectPrompt(maskPromptRegions(maskPromptRegions(prompt, regions), spans))
}

function splitExclusionPhrase(phrase: string): string[] {
  return phrase
    .split(/\s*(?:,| and | or )\s*/i)
    .map((part) => part.trim().replace(/^(?:the|any|and|or)\s+/i, ''))
    .map((part) => sourceExclusionPathOperand(part)
      ? (/\s/.test(part) ? part : part.replace(/^([`"'])(.*)\1$/, '$2'))
      : sourceExclusionSymbolOperand(part)
        ? unquoteSourceExclusionOperand(part)
        : part.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, ''))
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
  return prompt.replace(/\s+/g, ' ').replace(/\s+([,;]|\.(?!\.?[\\/]))/g, '$1').trim()
}
