import { UnsupportedGenerationModeError } from '../infrastructure/generate.js'

/**
 * #722 FULL_GENERATE_ONLY_V1 — federation is withdrawn.
 *
 * Federation loaded persisted semantic graphs and derived a new semantic
 * artifact from them: it clustered, scored, named communities, wrote a report,
 * serialized a canonical artifact and activated it. Persisted semantics were
 * the input to new semantics, which is precisely what this contract forbids.
 * Unlike time-travel comparison, nothing about it is read-only.
 *
 * There is no supported multi-repo continuation to fall back to: a federated
 * graph would have to be generated from the repositories themselves, which is
 * not a capability this release has. So this refuses rather than degrading.
 *
 * The refusal is raised before any graph is loaded and before any directory or
 * artifact is created. The historical implementation is recoverable from Git
 * history and the #722 evidence ledger; it is deliberately not retained here
 * under any name.
 */

export interface FederateOptions {
  outputDir?: string | undefined
  directed?: boolean | undefined
}

export interface FederateResult {
  graphPath: string
  reportPath: string
  repos: string[]
  totalNodes: number
  totalEdges: number
  crossRepoEdges: number
  communityCount: number
}

export function federate(graphPaths: string[], options: FederateOptions = {}): FederateResult {
  void [graphPaths, options]
  throw new UnsupportedGenerationModeError(
    'federate',
    'run `madar generate` for a full regeneration of each repository',
  )
}
