// SPI v1 — projector: SemanticProgramIndex → ExtractionData (slice 1c-i of #72).
//
// Bridges the SPI substrate to the existing graph.json pipeline. Slot:
//
//     buildSpi(root) → SemanticProgramIndex
//                          ↓
//              projectSpiToExtraction(spi, { root })
//                          ↓
//                    ExtractionData
//                          ↓
//          buildFromJson() → cluster() → analyze() → toJson()
//                          ↓
//                       graph.json
//
// In other words: replace `extract()` with the SPI build + projector pair and
// the rest of the pipeline runs unchanged. The projector reuses the exact
// id/label/provenance helpers from src/pipeline/extract/core.ts so a file the
// projector emits matches what the legacy extractor would emit for the same
// path.
//
// === Scope of slice 1c-i (this file) ===
//
// The projector covers only the structural surface SPI v1 captures:
//
//   * File nodes — one per SpiFile, id = `_makeId(basenameWithoutExt(path))`,
//     label = basename, source_location = "L1", file_type = "code".
//   * Symbol nodes — one per SpiSymbol of kind in {function, class, interface,
//     type-alias, enum, method, constant, variable, namespace}. ids and
//     labels are generated to match the legacy extractor's snake_case
//     `_makeId(fileBasename, [className,] symbolName)` scheme.
//   * `contains` edges — file → top-level symbol (every kind except `method`).
//   * `method`   edges — class → method symbol.
//   * `imports_from` edges — file → resolved file from SPI's `imports` edges.
//   * `calls` edges — caller symbol → callee symbol from SPI's `calls` edges.
//   * `extends` / `implements` edges — symbol → symbol from SPI's type layer.
//
// === What's intentionally deferred to slice 1c-ii ===
//
// Full byte-equivalence on the checked-in `examples/demo-repo/out/
// graph.json` golden fixture requires reproducing every legacy extractor
// emission decision: framework-specific node kinds (Express/NestJS/Next.js/
// React Router/Redux), cross-file resolution heuristics, generic call
// resolution, non-code file extraction, and snippet truncation rules. That's
// a port of ~3,600 lines of extract.ts and lives in slice 1c-ii.
//
// This slice ships the structural projector and a comparison test against a
// small TS-only sandbox fixture so the contract is exercised; it does NOT
// trigger the v0.14.0 release (the design doc says the projector landing is
// the trigger, but only when it covers demo-repo byte-equivalence).

import { basename, extname, resolve } from 'node:path'

import type {
  ExtractionData,
  ExtractionEdge,
  ExtractionNode,
} from '../../contracts/types.js'
import {
  _makeId,
  addNode,
  addUniqueEdge,
  createEdge,
  createNode,
} from '../extract/core.js'

import type {
  SemanticProgramIndex,
  SpiEdge,
  SpiFile,
  SpiSymbol,
  SpiSymbolKind,
} from './types.js'

export type ProjectSpiToExtractionOptions = {
  /** Workspace root the SPI was built against. Used to resolve absolute
   *  paths so the produced ExtractionNode.source_file matches the legacy
   *  extractor's path output. */
  root: string
  /**
   * Optional full-corpus, collision-safe stems from the legacy extraction
   * pipeline. Hybrid generation supplies this so SPI-projected source IDs do
   * not collide with legacy-only files that share a basename.
   */
  fileStemByAbsolutePath?: ReadonlyMap<string, string>
}

const PROJECTABLE_SYMBOL_KINDS: ReadonlySet<SpiSymbolKind> = new Set([
  'function',
  'class',
  'interface',
  'type-alias',
  'enum',
  'method',
  'constant',
  'variable',
  'namespace',
])

const SPI_TO_EXTRACTION_RELATION: Partial<Record<SpiEdge['kind'], string>> = {
  imports: 'imports_from',
  calls: 'calls',
  injects: 'injects',
  enqueues_job: 'enqueues_job',
  extends: 'extends',
  implements: 'implements',
  registers_controller: 'registers_controller',
}

const SPI_TO_EXTRACTION_CONFIDENCE: Record<SpiEdge['confidence'], ExtractionEdge['confidence']> = {
  high: 'EXTRACTED',
  medium: 'INFERRED',
  low: 'AMBIGUOUS',
}

export function projectSpiToExtraction(
  spi: SemanticProgramIndex,
  opts: ProjectSpiToExtractionOptions,
): ExtractionData {
  const root = resolve(opts.root)

  // Index SpiFiles for quick (file_id → SpiFile) lookups.
  const fileById = new Map<string, SpiFile>(spi.files.map((f) => [f.id, f]))
  const projectedFileStemById = createProjectedFileStemById(
    spi.files,
    root,
    opts.fileStemByAbsolutePath,
  )

  const nodes: ExtractionNode[] = []
  const edges: ExtractionEdge[] = []
  const seenNodeIds = new Set<string>()
  const seenEdgeKeys = new Set<string>()

  // Mappings from SPI ids to ExtractionNode ids so edges can be rewritten.
  const fileIdToNodeId = new Map<string, string>()
  const symbolIdToNodeId = new Map<string, string>()
  const symbolIdToSourceFile = new Map<string, string>()
  const symbolIdToLine = new Map<string, number>()

  // 1) File nodes.
  for (const file of spi.files) {
    const absPath = resolve(root, file.path)
    const fileBaseStem = projectedFileStemById.get(file.id) ?? basename(file.path, extname(file.path))
    const nodeId = _makeId(fileBaseStem)
    fileIdToNodeId.set(file.id, nodeId)
    addNode(nodes, seenNodeIds, createNode(nodeId, basename(file.path), absPath, 1, 'code'))
  }

  // 2) Symbol nodes.
  for (const symbol of spi.symbols) {
    if (!PROJECTABLE_SYMBOL_KINDS.has(symbol.kind)) continue
    const file = fileById.get(symbol.file_id)
    if (!file) continue

    const absPath = resolve(root, file.path)
    const fileBaseStem = projectedFileStemById.get(file.id) ?? basename(file.path, extname(file.path))
    const projection = projectSymbol(symbol, fileBaseStem)
    if (!projection) continue

    symbolIdToNodeId.set(symbol.id, projection.id)
    symbolIdToSourceFile.set(symbol.id, absPath)
    symbolIdToLine.set(symbol.id, symbol.range.start.line)

    const node = createNode(projection.id, projection.label, absPath, symbol.range.start.line, 'code')

    // Slice 1c-ii (projector framework propagation): if SPI tagged this
    // symbol with a framework_role (e.g. NestJS slice 3b set
    // 'nest_module'), surface that on the projected node so downstream
    // consumers can route framework-aware UX without re-classifying. Maps
    // SPI roles back onto the legacy extractor's `framework` + `node_kind`
    // shape for the role types we cover today; full byte-equivalence on
    // demo-repo's framework-specific synthetic nodes (e.g. NestJS route
    // nodes with `node_kind: 'route'`) remains in slice 1c-iii.
    if (symbol.framework_role) {
      node.framework = frameworkForRole(symbol.framework_role)
      node.framework_role = symbol.framework_role
      const inferredKind = nodeKindForRole(symbol.framework_role)
      if (inferredKind) {
        node.node_kind = inferredKind
      }
    }

    // Propagate framework_metadata onto the ExtractionNode. Today's
    // callers set keys like `route_path` (Express routes), `mount_path`
    // (Express middleware), and future framework slices may add more.
    // The legacy extractor uses `route_path` as a top-level field on
    // ExtractionNodes, so spreading the bag onto the node brings parity
    // and keeps consumers (graph.json shape, downstream retrieval) able
    // to filter by these fields without round-tripping through the SPI
    // substrate. ExtractionNode's index signature allows arbitrary keys,
    // so the spread is type-safe.
    if (symbol.framework_metadata) {
      node.framework_metadata = { ...symbol.framework_metadata }
      for (const [key, value] of Object.entries(symbol.framework_metadata)) {
        if (value !== undefined) {
          node[key] = value
        }
      }
    }

    if (symbol.framework_metadata?.external_call === true) {
      node.node_kind = 'method'
    }

    addNode(nodes, seenNodeIds, node)
  }

  // 3) Structural edges derived from SPI's `declares` layer:
  //    - file → top-level symbol (kind ≠ method) becomes `contains`.
  //    - class → method becomes `method`. SPI emits a file→method `declares`,
  //      but the legacy extractor models methods as children of their class.
  //      So we re-link by parsing the SpiSymbol.name (`ClassName.methodName`)
  //      back to its enclosing class node id.
  emitContainsAndMethodEdges(
    spi,
    fileById,
    fileIdToNodeId,
    projectedFileStemById,
    symbolIdToNodeId,
    edges,
    seenEdgeKeys,
    root,
  )

  // 4) Cross-symbol edges projected from SPI edge kinds: imports, calls,
  //    extends, implements.
  for (const edge of spi.edges) {
    const relation = SPI_TO_EXTRACTION_RELATION[edge.kind]
    if (!relation) continue

    const sourceId = resolveEndpoint(edge.from, fileIdToNodeId, symbolIdToNodeId)
    const targetId = resolveEndpoint(edge.to, fileIdToNodeId, symbolIdToNodeId)
    if (!sourceId || !targetId) continue

    // Drop self-edges (e.g., file `exports` self-loops in SPI).
    if (sourceId === targetId) continue

    const evidence = locateEvidence(edge, fileById, fileIdToNodeId, symbolIdToNodeId, symbolIdToSourceFile, symbolIdToLine, root)
    if (!evidence) continue

    addUniqueEdge(
      edges,
      seenEdgeKeys,
      createEdge(
        sourceId,
        targetId,
        relation,
        evidence.sourceFile,
        evidence.line,
        SPI_TO_EXTRACTION_CONFIDENCE[edge.confidence],
        1.0,
      ),
    )
  }

  return {
    schema_version: 1,
    nodes,
    edges,
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  }
}

function frameworkForRole(role: NonNullable<SpiSymbol['framework_role']>): string {
  if (role.startsWith('nest_')) return 'nestjs'
  if (role.startsWith('routing_controllers_')) return 'routing-controllers'
  if (role.startsWith('express_')) return 'express'
  if (role.startsWith('nextjs_')) return 'nextjs'
  if (role.startsWith('react_router_')) return 'react-router'
  if (role.startsWith('redux_')) return 'redux'
  if (role.startsWith('hono_')) return 'hono'
  if (role.startsWith('fastify_')) return 'fastify'
  if (role.startsWith('trpc_')) return 'trpc'
  if (role.startsWith('prisma_')) return 'prisma'
  if (role.startsWith('repository_')) return 'repository'
  return 'unknown'
}

function nodeKindForRole(role: NonNullable<SpiSymbol['framework_role']>): NonNullable<ExtractionNode['node_kind']> | null {
  switch (role) {
    case 'nest_route':
    case 'routing_controllers_route':
    case 'express_route':
    case 'nextjs_app_route':
    case 'nextjs_pages_api':
    case 'hono_route':
    case 'fastify_route':
      return 'route'
    case 'routing_controllers_controller':
      return 'controller'
    case 'express_router':
      return 'router'
    case 'hono_app':
    case 'fastify_app':
      return 'class'
    case 'hono_middleware':
    case 'fastify_plugin':
      return 'function'
    case 'trpc_router':
      return 'router'
    case 'trpc_procedure_query':
    case 'trpc_procedure_mutation':
    case 'trpc_procedure_subscription':
      return 'route'
    case 'prisma_client':
      return 'class'
    case 'prisma_model_reader':
    case 'prisma_model_writer':
    case 'prisma_model_access':
      return 'function'
    case 'repository_reader':
    case 'repository_writer':
      return 'method'
    case 'nest_controller':
    case 'nest_module':
    case 'nest_provider':
    case 'nest_guard':
    case 'nest_pipe':
    case 'nest_interceptor':
      return 'class'
    case 'express_app':
    case 'express_middleware':
    case 'nextjs_middleware':
    case 'nextjs_client_component':
    case 'nextjs_app_page':
    case 'nextjs_app_layout':
    case 'nextjs_app_loading':
    case 'nextjs_app_error':
    case 'nextjs_app_template':
    case 'nextjs_pages_page':
      return role === 'nextjs_client_component' ? 'component' : 'function'
    case 'nextjs_server_action':
    case 'react_router_loader':
    case 'react_router_action':
      return 'function'
    case 'react_router_router':
      return 'router'
    case 'redux_slice':
      return 'slice'
    case 'redux_store':
      return 'store'
    case 'redux_selector':
    case 'redux_async_thunk':
    case 'redux_rtk_query_api':
      return 'function'
    default:
      return null
  }
}

type SymbolProjection = { id: string; label: string }

function normalizeStemPath(filePath: string): string {
  return resolve(filePath).replaceAll('\\', '/')
}

function createProjectedFileStemById(
  files: readonly SpiFile[],
  root: string,
  fileStemByAbsolutePath?: ReadonlyMap<string, string>,
): Map<string, string> {
  if (fileStemByAbsolutePath) {
    return new Map(files.map((file) => [
      file.id,
      fileStemByAbsolutePath.get(normalizeStemPath(resolve(root, file.path)))
        ?? basename(file.path, extname(file.path)),
    ]))
  }

  const duplicateCounts = new Map<string, number>()
  for (const file of files) {
    const stem = basename(file.path, extname(file.path))
    duplicateCounts.set(stem, (duplicateCounts.get(stem) ?? 0) + 1)
  }

  const stems = new Map<string, string>()
  for (const file of files) {
    const basenameStem = basename(file.path, extname(file.path))
    stems.set(
      file.id,
      (duplicateCounts.get(basenameStem) ?? 0) > 1
        ? uniqueProjectedFileStem(file.path)
        : basenameStem,
    )
  }
  return stems
}

function uniqueProjectedFileStem(filePath: string): string {
  const withoutExtension = filePath.slice(0, filePath.length - extname(filePath).length)
  return withoutExtension.split('/').filter(Boolean).join('_')
}

function projectSymbol(symbol: SpiSymbol, fileBaseStem: string): SymbolProjection | null {
  const storageOperation = typeof symbol.framework_metadata?.storage_operation === 'string'
    ? symbol.framework_metadata.storage_operation
    : null
  if (symbol.framework_metadata?.external_call === true) {
    return {
      id: _makeId(fileBaseStem, symbol.name),
      label: symbol.name,
    }
  }
  if (
    (
      symbol.framework_role === 'prisma_model_reader'
      || symbol.framework_role === 'prisma_model_writer'
      || symbol.framework_role === 'prisma_model_access'
    )
    && storageOperation
  ) {
    return {
      id: _makeId(fileBaseStem, symbol.name),
      label: `.${storageOperation}()`,
    }
  }

  if (symbol.kind === 'method') {
    // SpiSymbol.name for methods is `ClassName.methodName`.
    const dotAt = symbol.name.lastIndexOf('.')
    if (dotAt <= 0) return null
    const className = symbol.name.slice(0, dotAt)
    const methodName = symbol.name.slice(dotAt + 1)
    return {
      id: _makeId(fileBaseStem, className, methodName),
      label: `.${methodName}()`,
    }
  }

  if (symbol.kind === 'function') {
    return {
      id: _makeId(fileBaseStem, symbol.name),
      label: `${symbol.name}()`,
    }
  }

  // class / interface / type-alias / enum / constant / variable / namespace
  return {
    id: _makeId(fileBaseStem, symbol.name),
    label: symbol.name,
  }
}

function emitContainsAndMethodEdges(
  spi: SemanticProgramIndex,
  fileById: Map<string, SpiFile>,
  fileIdToNodeId: Map<string, string>,
  projectedFileStemById: Map<string, string>,
  symbolIdToNodeId: Map<string, string>,
  edges: ExtractionEdge[],
  seenEdgeKeys: Set<string>,
  root: string,
): void {
  for (const symbol of spi.symbols) {
    if (!PROJECTABLE_SYMBOL_KINDS.has(symbol.kind)) continue
    const targetId = symbolIdToNodeId.get(symbol.id)
    if (!targetId) continue
    const file = fileById.get(symbol.file_id)
    if (!file) continue
    const absPath = resolve(root, file.path)
    const evidenceLine = symbol.range.start.line

    if (symbol.kind === 'method') {
      // Re-parent: class symbol id is `_makeId(fileBaseStem, ClassName)`.
      const dotAt = symbol.name.lastIndexOf('.')
      if (dotAt <= 0) continue
      const className = symbol.name.slice(0, dotAt)
      const fileBaseStem = projectedFileStemById.get(file.id) ?? basename(file.path, extname(file.path))
      const classNodeId = _makeId(fileBaseStem, className)
      addUniqueEdge(
        edges,
        seenEdgeKeys,
        createEdge(classNodeId, targetId, 'method', absPath, evidenceLine, 'EXTRACTED', 1.0),
      )
      continue
    }

    // file → top-level non-method symbol = `contains`.
    const fileNodeId = fileIdToNodeId.get(symbol.file_id)
    if (!fileNodeId) continue
    addUniqueEdge(
      edges,
      seenEdgeKeys,
      createEdge(fileNodeId, targetId, 'contains', absPath, evidenceLine, 'EXTRACTED', 1.0),
    )
  }
}

function resolveEndpoint(
  spiId: string,
  fileIdToNodeId: Map<string, string>,
  symbolIdToNodeId: Map<string, string>,
): string | null {
  if (spiId.startsWith('file:')) return fileIdToNodeId.get(spiId) ?? null
  if (spiId.startsWith('symbol:')) return symbolIdToNodeId.get(spiId) ?? null
  return null
}

type Evidence = { sourceFile: string; line: number }

function locateEvidence(
  edge: SpiEdge,
  fileById: Map<string, SpiFile>,
  fileIdToNodeId: Map<string, string>,
  symbolIdToNodeId: Map<string, string>,
  symbolIdToSourceFile: Map<string, string>,
  symbolIdToLine: Map<string, number>,
  root: string,
): Evidence | null {
  if (edge.evidence) {
    const file = fileById.get(edge.evidence.file_id)
    if (file) {
      return {
        sourceFile: resolve(root, file.path),
        line: edge.evidence.range.start.line,
      }
    }
  }

  // Fallback: attribute the edge to the source endpoint's file.
  if (edge.from.startsWith('symbol:')) {
    const sf = symbolIdToSourceFile.get(edge.from)
    const line = symbolIdToLine.get(edge.from)
    if (sf && line !== undefined) return { sourceFile: sf, line }
  }
  if (edge.from.startsWith('file:')) {
    const file = lookupFileBySpiId(edge.from, fileById)
    if (file) return { sourceFile: resolve(root, file.path), line: 1 }
  }
  return null
}

function lookupFileBySpiId(spiId: string, fileById: Map<string, SpiFile>): SpiFile | null {
  return fileById.get(spiId) ?? null
}
