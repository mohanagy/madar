export declare const GRADER_TRUTH_REACHABLE: 'GRADER_TRUTH_REACHABLE_FROM_NORMAL_PRODUCT'
export declare const COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED: 'COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED'
export declare const UNAPPROVED_MIXED_ROUTER_GRADER_EDGE: 'UNAPPROVED_MIXED_ROUTER_GRADER_EDGE'
export declare const GRADER_BOUNDARY_CONFIG_INVALID: 'GRADER_BOUNDARY_CONFIG_INVALID'

export interface GraderBoundaryViolation {
  readonly reason: string
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly detail: string
  readonly chain: readonly string[]
}

export interface GraderDataReference {
  readonly file: string
  readonly line: number
  readonly literal: string
  readonly dataFile: string
}

/** One computed `import()` / `require()` whose specifier the compiler cannot resolve. */
export interface ComputedSpecifierSite {
  readonly path: string
  readonly kind: string
  readonly enclosing_declaration: string
  readonly expression: string
  readonly line: number
}

/** One grader-reaching edge carried by a mixed command router. */
export interface MixedRouterEdge {
  readonly from: string
  readonly kind: string
  readonly specifier: string
  readonly resolved: string
  readonly imported_bindings: readonly string[]
  readonly line: number
  readonly approved: boolean
}

export interface GraderBoundaryResult {
  readonly ok: boolean
  readonly reason: string | null
  readonly configProblems: readonly string[]
  readonly seeds: readonly string[]
  /** Every module from which grader truth is reachable, mixed routers included. */
  readonly ancestors: readonly string[]
  /** Ancestors that are dedicated grader/benchmark modules, routers excluded. */
  readonly dedicatedAncestors: readonly string[]
  readonly mixedRouters: readonly string[]
  readonly graderReachable: readonly string[]
  readonly dataReferences: readonly GraderDataReference[]
  readonly computedSpecifiers: readonly ComputedSpecifierSite[]
  readonly routerEdges: readonly MixedRouterEdge[]
  readonly unusedAllowances: readonly string[]
  readonly unusedRouterAllowances: readonly string[]
  readonly unusedComputedAllowances: readonly string[]
  readonly violations: readonly GraderBoundaryViolation[]
}

export interface GraderSequencingSite {
  readonly file: string
  readonly line: number
  readonly wrappers: readonly (string | null)[]
  readonly artifactFixesBefore: readonly number[]
  readonly profileConsumers: readonly { readonly line: number; readonly consumer: string | null }[]
}

export interface GraderSequencingResult {
  readonly ok: boolean
  readonly problems: readonly string[]
  readonly sites: readonly GraderSequencingSite[]
}

export interface GraderBoundaryInput {
  readonly root?: string
  readonly config?: unknown
  /** Pass false from anything that mutates sources; the graph is cached per root. */
  readonly cache?: boolean
}

export declare function analyzeGraderBoundary(input?: GraderBoundaryInput): GraderBoundaryResult
export declare function analyzeGraderSequencing(input?: GraderBoundaryInput): GraderSequencingResult
export declare function formatGraderBoundaryReport(result: GraderBoundaryResult): string
export declare function invalidateGraderBoundaryCache(): void
export declare function productionSourceFiles(root?: string): string[]
