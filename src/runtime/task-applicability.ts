import type {
  TaskApplicabilityClassification,
  TaskApplicabilityReason,
} from '../contracts/task-applicability.js'

const LOCAL_CODE_TERMS = [
  'repo',
  'repository',
  'codebase',
  'source code',
  'code',
  'file',
  'files',
  'module',
  'function',
  'class',
  'symbol',
  'runtime',
  'stack trace',
  'service',
  'controller',
  'component',
  'pipeline',
  'diff',
  'pr',
  'pull request',
  'tests',
  'test',
  'bug',
  'issue',
  'auth',
  'token',
  'session',
  'changed files',
  'this repo',
  'local repository',
]

const IMPLEMENT_TERMS = [
  'implement',
  'fix issue',
  'fix bug',
  'wire up',
  'add support',
  'build feature',
  'create feature',
  'write code',
]

const EXPLAIN_TERMS = [
  'explain how',
  'how does',
  'where is',
  'walk me through',
  'help me understand',
  'trace runtime path',
  'find affected files',
]

const DEBUG_TERMS = [
  'trace why',
  'root cause',
  'stack trace',
  'why is',
  'why does',
  'debug',
  'failing',
  'failure',
  'broken',
  'error',
  'bug',
]

const TEST_TERMS = [
  'write tests',
  'write regression tests',
  'add tests',
  'add regression tests',
  'generate tests',
  'create tests',
  'unit test',
  'integration test',
  'regression test',
]

const REVIEW_TERMS = [
  'review this pr',
  'review the pr',
  'review the diff',
  'pr diff',
  'review code',
  'audit the',
  'review the recent',
]

const REFACTOR_TERMS = [
  'refactor',
  'dead code',
  'clean up module',
  'cleanup module',
  'simplify module',
]

const GITHUB_PROJECT_TERMS = [
  'github project',
  'github projects',
  'project board',
  'projects board',
  'roadmap board',
  'roadmap review',
]

const PACKAGE_REGISTRY_TERMS = [
  'socket.dev',
  'socket alert',
  'npmjs.com',
  'package registry',
  'npm package',
  'package security page',
]

const AUTH_SETUP_TERMS = [
  'gh auth',
  'gh project',
  'auth login',
  'login setup',
  'device code',
  'token setup',
]

const MARKETING_COPY_TERMS = [
  'product hunt',
  'marketing copy',
  'launch copy',
  'headline',
  'tagline',
  'positioning',
  'landing page copy',
]

const GENERAL_RESEARCH_TERMS = [
  'web research',
  'market research',
  'competitor research',
  'general research',
]

const FILE_PATH_RE = /(?:^|\s)(?:[\w@./-]+\/)*[\w./@-]+\.[A-Za-z]{1,8}(?=\b|$)/i
const URL_RE = /https?:\/\/\S+/i
const GITHUB_PROJECT_URL_RE = /https?:\/\/github\.com\/.*\/projects\/\d+/i
const PACKAGE_REGISTRY_URL_RE = /https?:\/\/(?:www\.)?(?:npmjs\.com|socket\.dev|snyk\.io|packagephobia\.com)\//i

const TASK_APPLICABILITY_REASON_LABELS: Record<TaskApplicabilityReason, string> = {
  implement: 'implementation task',
  explain: 'codebase explanation task',
  debug: 'debugging task',
  test: 'test-writing task',
  review: 'code review task',
  refactor: 'refactor task',
  external_url: 'external URL or web-only task',
  github_project: 'GitHub Project roadmap review',
  package_registry: 'package registry or security page review',
  auth_setup: 'CLI auth or project setup',
  marketing_copy: 'marketing copy review',
  general_research: 'general research task',
}

interface TaskApplicabilityHookConfig {
  local_code_terms: readonly string[]
  implement_terms: readonly string[]
  explain_terms: readonly string[]
  debug_terms: readonly string[]
  test_terms: readonly string[]
  review_terms: readonly string[]
  refactor_terms: readonly string[]
  github_project_terms: readonly string[]
  package_registry_terms: readonly string[]
  auth_setup_terms: readonly string[]
  marketing_copy_terms: readonly string[]
  general_research_terms: readonly string[]
  reason_labels: Record<TaskApplicabilityReason, string>
}

const HOOK_CONFIG: TaskApplicabilityHookConfig = {
  local_code_terms: LOCAL_CODE_TERMS,
  implement_terms: IMPLEMENT_TERMS,
  explain_terms: EXPLAIN_TERMS,
  debug_terms: DEBUG_TERMS,
  test_terms: TEST_TERMS,
  review_terms: REVIEW_TERMS,
  refactor_terms: REFACTOR_TERMS,
  github_project_terms: GITHUB_PROJECT_TERMS,
  package_registry_terms: PACKAGE_REGISTRY_TERMS,
  auth_setup_terms: AUTH_SETUP_TERMS,
  marketing_copy_terms: MARKETING_COPY_TERMS,
  general_research_terms: GENERAL_RESEARCH_TERMS,
  reason_labels: TASK_APPLICABILITY_REASON_LABELS,
}

function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function containsTerm(normalizedPrompt: string, term: string): boolean {
  const normalizedTerm = normalizePrompt(term)
  if (normalizedPrompt.length === 0 || normalizedTerm.length === 0) {
    return false
  }

  return ` ${normalizedPrompt} `.includes(` ${normalizedTerm} `)
}

function matchTerms(normalizedPrompt: string, terms: readonly string[]): string[] {
  return [...new Set(terms.map(normalizePrompt).filter((term) => containsTerm(normalizedPrompt, term)))].sort()
}

function hasLocalCodeCue(prompt: string, normalizedPrompt: string): { matched_terms: string[]; detected: boolean } {
  const matchedTerms = matchTerms(normalizedPrompt, LOCAL_CODE_TERMS)
  const detected = matchedTerms.length > 0 || FILE_PATH_RE.test(prompt)
  return {
    matched_terms: FILE_PATH_RE.test(prompt) ? [...new Set([...matchedTerms, 'file path'])].sort() : matchedTerms,
    detected,
  }
}

function negativeClassification(
  prompt: string,
  normalizedPrompt: string,
): { reason: TaskApplicabilityReason; matched_terms: string[] } | null {
  if (GITHUB_PROJECT_URL_RE.test(prompt)) {
    return { reason: 'github_project', matched_terms: ['github project url'] }
  }

  const githubProjectTerms = matchTerms(normalizedPrompt, GITHUB_PROJECT_TERMS)
  if (githubProjectTerms.length > 0) {
    return { reason: 'github_project', matched_terms: githubProjectTerms }
  }

  if (PACKAGE_REGISTRY_URL_RE.test(prompt)) {
    return { reason: 'package_registry', matched_terms: ['package registry url'] }
  }

  const packageRegistryTerms = matchTerms(normalizedPrompt, PACKAGE_REGISTRY_TERMS)
  if (packageRegistryTerms.length > 0) {
    return { reason: 'package_registry', matched_terms: packageRegistryTerms }
  }

  const authSetupTerms = matchTerms(normalizedPrompt, AUTH_SETUP_TERMS)
  if (authSetupTerms.length > 0) {
    return { reason: 'auth_setup', matched_terms: authSetupTerms }
  }

  const marketingTerms = matchTerms(normalizedPrompt, MARKETING_COPY_TERMS)
  if (marketingTerms.length > 0) {
    return { reason: 'marketing_copy', matched_terms: marketingTerms }
  }

  if (URL_RE.test(prompt)) {
    return { reason: 'external_url', matched_terms: ['external url'] }
  }

  const generalResearchTerms = matchTerms(normalizedPrompt, GENERAL_RESEARCH_TERMS)
  if (generalResearchTerms.length > 0) {
    return { reason: 'general_research', matched_terms: generalResearchTerms }
  }

  return null
}

function localClassification(
  prompt: string,
  normalizedPrompt: string,
): { reason: TaskApplicabilityReason; matched_terms: string[] } | null {
  const localCodeCue = hasLocalCodeCue(prompt, normalizedPrompt)

  const implementTerms = matchTerms(normalizedPrompt, IMPLEMENT_TERMS)
  if (implementTerms.length > 0) {
    return { reason: 'implement', matched_terms: implementTerms }
  }

  const debugTerms = matchTerms(normalizedPrompt, DEBUG_TERMS)
  if (debugTerms.length > 0 && localCodeCue.detected) {
    return { reason: 'debug', matched_terms: [...new Set([...debugTerms, ...localCodeCue.matched_terms])].sort() }
  }

  const testTerms = matchTerms(normalizedPrompt, TEST_TERMS)
  if (testTerms.length > 0) {
    return { reason: 'test', matched_terms: testTerms }
  }

  const reviewTerms = matchTerms(normalizedPrompt, REVIEW_TERMS)
  if (reviewTerms.length > 0 && localCodeCue.detected) {
    return { reason: 'review', matched_terms: [...new Set([...reviewTerms, ...localCodeCue.matched_terms])].sort() }
  }

  const refactorTerms = matchTerms(normalizedPrompt, REFACTOR_TERMS)
  if (refactorTerms.length > 0) {
    return { reason: 'refactor', matched_terms: refactorTerms }
  }

  const explainTerms = matchTerms(normalizedPrompt, EXPLAIN_TERMS)
  if (explainTerms.length > 0 && localCodeCue.detected) {
    return { reason: 'explain', matched_terms: [...new Set([...explainTerms, ...localCodeCue.matched_terms])].sort() }
  }

  return localCodeCue.detected
    ? { reason: 'explain', matched_terms: localCodeCue.matched_terms }
    : null
}

export function classifyTaskApplicability(prompt: string): TaskApplicabilityClassification {
  const normalizedPrompt = normalizePrompt(prompt)
  const negative = negativeClassification(prompt, normalizedPrompt)
  if (negative) {
    return {
      version: 1,
      prompt,
      normalized_prompt: normalizedPrompt,
      needs_local_code_context: false,
      reason: negative.reason,
      matched_terms: negative.matched_terms,
    }
  }

  const local = localClassification(prompt, normalizedPrompt)
  if (local) {
    return {
      version: 1,
      prompt,
      normalized_prompt: normalizedPrompt,
      needs_local_code_context: true,
      reason: local.reason,
      matched_terms: local.matched_terms,
    }
  }

  return {
    version: 1,
    prompt,
    normalized_prompt: normalizedPrompt,
    needs_local_code_context: false,
    reason: 'general_research',
    matched_terms: [],
  }
}

export function formatTaskApplicabilityDebugMessage(classification: TaskApplicabilityClassification): string {
  if (classification.needs_local_code_context) {
    return `Using Madar: task needs local codebase context (${TASK_APPLICABILITY_REASON_LABELS[classification.reason]}).`
  }

  return `Skipped Madar: task is ${TASK_APPLICABILITY_REASON_LABELS[classification.reason]}, not local codebase context.`
}

export function buildPromptApplicabilityHookScript(
  matchPayloadJson: string,
  hookEventName: string,
  graphPath = 'out/graph.json',
): string {
  const graphAccessStatement = graphPath === 'out/graph.json'
    ? "fs.accessSync('out/graph.json')"
    : `fs.accessSync(${JSON.stringify(graphPath)})`

  return `const fs = require('fs')

const config = ${JSON.stringify(HOOK_CONFIG, null, 2)}
const matchPayload = ${JSON.stringify(matchPayloadJson)}
const hookEventName = ${JSON.stringify(hookEventName)}
const filePathRe = ${FILE_PATH_RE}
const urlRe = ${URL_RE}
const githubProjectUrlRe = ${GITHUB_PROJECT_URL_RE}
const packageRegistryUrlRe = ${PACKAGE_REGISTRY_URL_RE}
let input = ''

function normalizePrompt(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\\s+/g, ' ')
}

function containsTerm(normalizedPrompt, term) {
  const normalizedTerm = normalizePrompt(term)
  if (!normalizedPrompt || !normalizedTerm) {
    return false
  }

  return \` \${normalizedPrompt} \`.includes(\` \${normalizedTerm} \`)
}

function matchTerms(normalizedPrompt, terms) {
  return [...new Set(terms.map(normalizePrompt).filter((term) => containsTerm(normalizedPrompt, term)))].sort()
}

function hasLocalCodeCue(prompt, normalizedPrompt) {
  const matchedTerms = matchTerms(normalizedPrompt, config.local_code_terms)
  const hasFilePath = filePathRe.test(prompt)
  return {
    detected: matchedTerms.length > 0 || hasFilePath,
    matched_terms: hasFilePath ? [...new Set([...matchedTerms, 'file path'])].sort() : matchedTerms,
  }
}

function negativeClassification(prompt, normalizedPrompt) {
  if (githubProjectUrlRe.test(prompt)) {
    return { reason: 'github_project', matched_terms: ['github project url'] }
  }

  const githubProjectTerms = matchTerms(normalizedPrompt, config.github_project_terms)
  if (githubProjectTerms.length > 0) {
    return { reason: 'github_project', matched_terms: githubProjectTerms }
  }

  if (packageRegistryUrlRe.test(prompt)) {
    return { reason: 'package_registry', matched_terms: ['package registry url'] }
  }

  const packageRegistryTerms = matchTerms(normalizedPrompt, config.package_registry_terms)
  if (packageRegistryTerms.length > 0) {
    return { reason: 'package_registry', matched_terms: packageRegistryTerms }
  }

  const authSetupTerms = matchTerms(normalizedPrompt, config.auth_setup_terms)
  if (authSetupTerms.length > 0) {
    return { reason: 'auth_setup', matched_terms: authSetupTerms }
  }

  const marketingTerms = matchTerms(normalizedPrompt, config.marketing_copy_terms)
  if (marketingTerms.length > 0) {
    return { reason: 'marketing_copy', matched_terms: marketingTerms }
  }

  if (urlRe.test(prompt)) {
    return { reason: 'external_url', matched_terms: ['external url'] }
  }

  const generalResearchTerms = matchTerms(normalizedPrompt, config.general_research_terms)
  if (generalResearchTerms.length > 0) {
    return { reason: 'general_research', matched_terms: generalResearchTerms }
  }

  return null
}

function localClassification(prompt, normalizedPrompt) {
  const localCodeCue = hasLocalCodeCue(prompt, normalizedPrompt)

  const implementTerms = matchTerms(normalizedPrompt, config.implement_terms)
  if (implementTerms.length > 0) {
    return { reason: 'implement', matched_terms: implementTerms }
  }

  const debugTerms = matchTerms(normalizedPrompt, config.debug_terms)
  if (debugTerms.length > 0 && localCodeCue.detected) {
    return { reason: 'debug', matched_terms: [...new Set([...debugTerms, ...localCodeCue.matched_terms])].sort() }
  }

  const testTerms = matchTerms(normalizedPrompt, config.test_terms)
  if (testTerms.length > 0) {
    return { reason: 'test', matched_terms: testTerms }
  }

  const reviewTerms = matchTerms(normalizedPrompt, config.review_terms)
  if (reviewTerms.length > 0 && localCodeCue.detected) {
    return { reason: 'review', matched_terms: [...new Set([...reviewTerms, ...localCodeCue.matched_terms])].sort() }
  }

  const refactorTerms = matchTerms(normalizedPrompt, config.refactor_terms)
  if (refactorTerms.length > 0) {
    return { reason: 'refactor', matched_terms: refactorTerms }
  }

  const explainTerms = matchTerms(normalizedPrompt, config.explain_terms)
  if (explainTerms.length > 0 && localCodeCue.detected) {
    return { reason: 'explain', matched_terms: [...new Set([...explainTerms, ...localCodeCue.matched_terms])].sort() }
  }

  return localCodeCue.detected
    ? { reason: 'explain', matched_terms: localCodeCue.matched_terms }
    : null
}

function classifyTaskApplicability(prompt) {
  const normalizedPrompt = normalizePrompt(prompt)
  const negative = negativeClassification(prompt, normalizedPrompt)
  if (negative) {
    return {
      needs_local_code_context: false,
      reason: negative.reason,
    }
  }

  const local = localClassification(prompt, normalizedPrompt)
  if (local) {
    return {
      needs_local_code_context: true,
      reason: local.reason,
    }
  }

  return {
    needs_local_code_context: false,
    reason: 'general_research',
  }
}

process.stdin.on('data', (chunk) => {
  input += chunk
})

process.stdin.on('end', () => {
  try {
    ${graphAccessStatement}
  } catch {
    return
  }

  let prompt = ''
  try {
    const payload = input.length > 0 ? JSON.parse(input) : {}
    if (typeof payload.prompt === 'string') {
      prompt = payload.prompt
    }
  } catch {
    prompt = ''
  }

  const classification = classifyTaskApplicability(prompt)
  const debugEnabled = /^(1|true|yes)$/i.test(String(process.env.MADAR_HOOK_DEBUG || ''))
  if (!classification.needs_local_code_context) {
    if (!debugEnabled) {
      return
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName,
        additionalContext: 'Skipped Madar: task is '
          + ((config.reason_labels || {})[classification.reason] || classification.reason)
          + ', not local codebase context.',
      },
    }))
    return
  }

  process.stdout.write(matchPayload)
})
`
}
