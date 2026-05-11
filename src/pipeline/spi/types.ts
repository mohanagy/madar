// SPI v1 — Semantic Program Index types.
//
// These types are the design contract from docs/designs/2026-05-10-spi-v1.md.
// They are intentionally exhaustive (every layer the design names) so later
// slices of #72 can fill in symbols / edges / framework / diff overlay
// without re-shaping the public surface.
//
// Slice 1a (this file) lands the type definitions plus the file-layer
// builder. Other layers ship in subsequent PRs of #72.

export type SpiVersion = 1

export type SemanticProgramIndex = {
  version: SpiVersion
  generated_at: string
  workspace: SpiWorkspace
  files: SpiFile[]
  symbols: SpiSymbol[]
  edges: SpiEdge[]
  diagnostics: SpiDiagnostic[]
}

export type SpiWorkspace = {
  root: string
  fingerprint: string
  extractor_version: string
  graphify_version: string
}

export type SpiLanguage =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'json'
  | 'unknown'

export type SpiFile = {
  id: string
  path: string
  language: SpiLanguage
  loc: number
  hash: string
}

export type SpiSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'method'
  | 'constant'
  | 'variable'
  | 'namespace'

export type SpiPosition = {
  line: number
  column: number
}

export type SpiRange = {
  start: SpiPosition
  end: SpiPosition
}

export type SpiFrameworkRole =
  // NestJS roles (slice 3b base)
  | 'nest_module'
  | 'nest_controller'
  | 'nest_route'
  | 'nest_provider'
  | 'nest_guard'
  | 'nest_pipe'
  | 'nest_interceptor'
  // Express roles (slice 1c-ii.b)
  | 'express_app'
  | 'express_router'
  | 'express_route'
  | 'express_middleware'
  // Next.js roles (slice 1c-iv.a)
  | 'nextjs_app_page'
  | 'nextjs_app_route'
  | 'nextjs_app_layout'
  | 'nextjs_app_loading'
  | 'nextjs_app_error'
  | 'nextjs_app_template'
  | 'nextjs_pages_page'
  | 'nextjs_pages_api'
  | 'nextjs_middleware'
  // React Router roles (slice 1c-v.a)
  | 'react_router_router'
  | 'react_router_loader'
  | 'react_router_action'

export type SpiSymbol = {
  id: string
  file_id: string
  name: string
  kind: SpiSymbolKind
  range: SpiRange
  exported: boolean
  framework_role?: SpiFrameworkRole
  /**
   * #72 slice 1c-ii.f — opt-in framework metadata bag. Populated by
   * framework detectors when the symbol carries framework-specific data
   * that doesn't fit the generic SpiSymbol shape:
   *
   *   - Express route handler (\`express_route\` role):
   *       \`route_path: string\`  — the route path string from the first
   *                                argument of \`<binding>.<method>(path, handler)\`.
   *                                e.g. \`'/users/:id'\`.
   *   - Express middleware (\`express_middleware\` role):
   *       \`mount_path?: string\` — the optional prefix from
   *                                \`app.use('/api', middleware)\`. Absent
   *                                when middleware is registered globally.
   *
   * Per the SPI v1 design's open questions: the schema is intentionally
   * \`unknown\` so framework extensions can store framework-specific
   * fields without rev-ing the SpiSymbol type. A consumer that wants to
   * type-narrow should do so against the symbol's \`framework_role\`.
   */
  framework_metadata?: Record<string, unknown>
}

export type SpiEdgeKind =
  // file layer
  | 'imports'
  | 'exports'
  // symbol layer
  | 'declares'
  | 'references'
  // call layer
  | 'calls'
  // type layer
  | 'extends'
  | 'implements'
  | 'param_type'
  | 'return_type'
  // test layer
  | 'covered_by'
  // diff overlay
  | 'changed_in'
  // framework layer (NestJS v1)
  | 'module_provides'
  | 'module_imports'
  | 'module_exports'
  | 'controller_route'
  | 'route_handler'
  | 'injects'
  | 'guards'
  | 'intercepts'
  | 'pipes'

export type SpiEdgeConfidence = 'high' | 'medium' | 'low'

export type SpiEdgeSource =
  | 'typescript-semantic'
  | 'typescript-syntactic'
  | 'tree-sitter'
  | 'framework-decorator'
  | 'heuristic'

export type SpiEdgeEvidence = {
  file_id: string
  range: SpiRange
}

export type SpiEdge = {
  from: string
  to: string
  kind: SpiEdgeKind
  confidence: SpiEdgeConfidence
  source: SpiEdgeSource
  evidence?: SpiEdgeEvidence
}

export type SpiDiagnosticLevel = 'info' | 'warn' | 'error'

export type SpiDiagnosticEvidence = {
  file_id: string
  range?: SpiRange
}

export type SpiDiagnostic = {
  id: string
  level: SpiDiagnosticLevel
  message: string
  evidence?: SpiDiagnosticEvidence
}

// Diff overlay is computed on demand against a base ref and is intentionally
// not part of the persisted SemanticProgramIndex (it varies with git state).
export type SpiDiffOverlay = {
  base_ref: string
  head_ref: string
  changed_files: string[]
  changed_symbols: string[]
  edges_added: SpiEdge[]
}
