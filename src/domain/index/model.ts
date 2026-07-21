// Compiler-independent facts used while the TypeScript adapter writes the
// canonical graph. These records never leave the adapter as a second index.

export type IndexLanguage =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'

export type IndexFile = {
  id: string
  path: string
  language: IndexLanguage
  loc: number
  hash: string
}

export type IndexSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'method'
  | 'constant'
  | 'variable'
  | 'namespace'

export type IndexPosition = {
  line: number
  column: number
}

export type IndexRange = {
  start: IndexPosition
  end: IndexPosition
}

export type IndexFrameworkRole =
  | 'nest_module'
  | 'nest_controller'
  | 'nest_route'
  | 'nest_provider'
  | 'nest_guard'
  | 'nest_pipe'
  | 'nest_interceptor'
  | 'express_app'
  | 'express_router'
  | 'express_route'
  | 'express_middleware'
  | 'nextjs_app_page'
  | 'nextjs_app_route'
  | 'nextjs_app_layout'
  | 'nextjs_app_loading'
  | 'nextjs_app_error'
  | 'nextjs_app_template'
  | 'nextjs_pages_page'
  | 'nextjs_pages_api'
  | 'nextjs_middleware'
  | 'nextjs_client_component'
  | 'nextjs_server_action'
  | 'react_router_router'
  | 'react_router_loader'
  | 'react_router_action'
  | 'hono_app'
  | 'hono_route'
  | 'hono_middleware'
  | 'fastify_app'
  | 'fastify_route'
  | 'fastify_plugin'
  | 'trpc_router'
  | 'trpc_procedure_query'
  | 'trpc_procedure_mutation'
  | 'trpc_procedure_subscription'
  | 'prisma_client'
  | 'prisma_model_reader'
  | 'prisma_model_writer'
  | 'prisma_model_access'

export type IndexStorageOperation =
  | 'create'
  | 'createMany'
  | 'update'
  | 'updateMany'
  | 'delete'
  | 'deleteMany'
  | 'upsert'
  | 'findUnique'
  | 'findUniqueOrThrow'
  | 'findFirst'
  | 'findFirstOrThrow'
  | 'findMany'
  | 'count'
  | 'aggregate'
  | 'groupBy'
  | '$transaction'

export type IndexRuntimeBoundary = 'client' | 'server'

export type IndexFrameworkMetadata = {
  storage_operation?: IndexStorageOperation
  runtime_boundary?: IndexRuntimeBoundary
  [key: string]: unknown
}

export type IndexSymbol = {
  id: string
  file_id: string
  name: string
  kind: IndexSymbolKind
  range: IndexRange
  exported: boolean
  framework_role?: IndexFrameworkRole
  framework_metadata?: IndexFrameworkMetadata
}

export type IndexEdgeKind =
  | 'imports'
  | 'reexports'
  | 'declares'
  | 'calls'
  | 'enqueues_job'
  | 'extends'
  | 'implements'
  | 'param_type'
  | 'return_type'
  | 'module_provides'
  | 'module_imports'
  | 'module_exports'
  | 'controller_route'
  | 'route_handler'
  | 'registers_controller'
  | 'injects'
  | 'guards'
  | 'intercepts'
  | 'pipes'

export type IndexEdgeConfidence = 'high' | 'medium' | 'low'

export type IndexEdgeSource =
  | 'typescript-semantic'
  | 'typescript-syntactic'
  | 'framework-decorator'
  | 'heuristic'

export type IndexEdgeEvidence = {
  file_id: string
  range: IndexRange
}

export type IndexEdge = {
  from: string
  to: string
  kind: IndexEdgeKind
  confidence: IndexEdgeConfidence
  source: IndexEdgeSource
  evidence?: IndexEdgeEvidence
  metadata?: Record<string, unknown>
}

export type IndexDiagnosticLevel = 'info' | 'warn' | 'error'

export type IndexDiagnosticEvidence = {
  file_id: string
  range?: IndexRange
}

export type IndexDiagnostic = {
  id: string
  level: IndexDiagnosticLevel
  message: string
  evidence?: IndexDiagnosticEvidence
}
