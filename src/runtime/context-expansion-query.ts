import { evaluateQueryEvidenceCoverage, queryEvidenceObligations, type QueryEvidenceNode } from './retrieve/conceptual-fallback.js'
import { resolveSourceSnippet } from './source-evidence-response.js'

/** Private heuristic selection goal; never source authority or answer-quality proof. */
export interface ContextExpansionQueryGoal {
  version: 1
  question: string
  missing_obligations: string[]
}

function eligibleObligations(question: string): string[] {
  return queryEvidenceObligations(question)
    // Divergence needs multiple owners and cannot qualify a single-owner page.
    .filter(obligation => !obligation.terms.includes('@divergence'))
    .map(obligation => `query:obligation:${obligation.index + 1}`)
}

function sourceNodes(nodes: readonly Record<string, unknown>[]): QueryEvidenceNode[] {
  const counts = new Map<string, number>()
  for (const node of nodes) if (typeof node.node_id === 'string') {
    counts.set(node.node_id, (counts.get(node.node_id) ?? 0) + 1)
  }
  // Filter suppliers too: a reference must not launder flagged or ambiguous text.
  const eligible = nodes.filter(node => typeof node.label === 'string' && node.label.trim()
    && typeof node.source_file === 'string' && node.source_file.trim()
    && node.snippet_unverified !== true && node.snippet_source !== 'derived'
    && node.source_verified !== false && node.source_representation !== 'derived'
    && (typeof node.node_id !== 'string' || counts.get(node.node_id) === 1))
  return eligible.flatMap(node => {
    const snippet = resolveSourceSnippet(node, eligible)?.replace(/^\[omitted lines \d+-\d+\]$/gm, '')
    return snippet?.trim() ? [{ label: node.label as string, source_file: node.source_file as string, snippet }] : []
  })
}

export function isContextExpansionQueryGoal(value: unknown, question: string): value is ContextExpansionQueryGoal {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof question !== 'string' || !question.trim() || question.length > 12_000) return false
  const goal = value as Record<string, unknown>
  if (Object.keys(goal).length !== 3 || Object.keys(goal).some(key => !['version', 'question', 'missing_obligations'].includes(key))
    || goal.version !== 1 || goal.question !== question
    || !Array.isArray(goal.missing_obligations) || goal.missing_obligations.length < 1
    || goal.missing_obligations.length > 8 || new Set(goal.missing_obligations).size !== goal.missing_obligations.length) return false
  const eligible = new Set(eligibleObligations(question))
  return goal.missing_obligations.every(id => typeof id === 'string' && eligible.has(id))
}

export function createContextExpansionQueryGoal(
  question: string, nodes: readonly Record<string, unknown>[],
): ContextExpansionQueryGoal | undefined {
  if (typeof question !== 'string' || !question.trim() || question.length > 12_000) return undefined
  const coverage = evaluateQueryEvidenceCoverage(question, sourceNodes(nodes))
  if (coverage.total < 3 || coverage.covered === 0 || coverage.missing_obligations.length === 0) return undefined
  const missing = new Set(coverage.missing_obligations)
  const missing_obligations = eligibleObligations(question).filter(id => missing.has(id))
  if (!missing_obligations.length) return undefined
  const goal: ContextExpansionQueryGoal = { version: 1, question, missing_obligations }
  Object.freeze(goal.missing_obligations)
  return Object.freeze(goal)
}

/** Reassess the exact retained question; progress is advisory lexical support only. */
export function contextExpansionQueryProgress(
  goal: ContextExpansionQueryGoal, nodes: readonly Record<string, unknown>[],
): string[] {
  if (!isContextExpansionQueryGoal(goal, goal.question)) return []
  const covered = new Set(evaluateQueryEvidenceCoverage(goal.question, sourceNodes(nodes)).covered_obligations)
  return goal.missing_obligations.filter(id => covered.has(id))
}

export interface ContextExpansionQueryRegistry {
  /** Observe final generic-handle publications, including those without a goal. */
  observe(id: string, fingerprint: string, goal?: ContextExpansionQueryGoal, binding?: string): void
  resolve(id: string, currentFingerprint: string, currentBinding: string): ContextExpansionQueryGoal | undefined
}

/** Transport-lifetime advisory history; never handle identity or source authority.
 * Fingerprints bind ordered context and final page; bindings include root/generation.
 * Keep this instance across handle/cache clears. Only a new transport gets a new one.
 */
export function createContextExpansionQueryRegistry(maxEntries = 512): ContextExpansionQueryRegistry {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('Invalid query registry capacity')
  type Claim = { fingerprint: string; binding: string | undefined; goal: ContextExpansionQueryGoal | undefined }
  const claims = new Map<string, Claim | null>()
  let saturated = false
  return Object.freeze({
    observe(id: string, fingerprint: string, goal?: ContextExpansionQueryGoal, binding?: string): void {
      if (saturated) return
      if (!claims.has(id) && claims.size >= maxEntries) {
        saturated = true
        claims.clear()
        return
      }
      // An invalid marked claim must not turn into a valid unmarked reissue.
      if (!id.trim() || !fingerprint.trim()
        || (goal !== undefined && (!goal || !binding?.trim() || !isContextExpansionQueryGoal(goal, goal.question)))) {
        claims.set(id, null)
        return
      }
      const prior = claims.get(id)
      if (prior === null) return
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.binding !== binding
          || prior.goal?.question !== goal?.question
          || JSON.stringify(prior.goal?.missing_obligations) !== JSON.stringify(goal?.missing_obligations)) claims.set(id, null)
        return
      }
      const copy: ContextExpansionQueryGoal | undefined = goal === undefined ? undefined : {
        version: 1, question: goal.question, missing_obligations: [...goal.missing_obligations],
      }
      if (copy) { Object.freeze(copy.missing_obligations); Object.freeze(copy) }
      claims.set(id, { fingerprint, binding, goal: copy })
    },
    resolve(id: string, currentFingerprint: string, currentBinding: string): ContextExpansionQueryGoal | undefined {
      if (saturated || !currentBinding.trim()) return undefined
      const claim = claims.get(id)
      return claim && claim.fingerprint === currentFingerprint && claim.binding === currentBinding
        ? claim.goal : undefined
    },
  })
}
