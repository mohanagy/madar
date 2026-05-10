// SPI v1 — public re-exports.
//
// Slice 1a: types + file-layer builder. Symbol/call/type/test/diff/framework
// layers and the projection back to today's graph.json land in subsequent
// slices of #72.

export type {
  SpiVersion,
  SemanticProgramIndex,
  SpiWorkspace,
  SpiLanguage,
  SpiFile,
  SpiSymbolKind,
  SpiPosition,
  SpiRange,
  SpiFrameworkRole,
  SpiSymbol,
  SpiEdgeKind,
  SpiEdgeConfidence,
  SpiEdgeSource,
  SpiEdgeEvidence,
  SpiEdge,
  SpiDiagnosticLevel,
  SpiDiagnosticEvidence,
  SpiDiagnostic,
  SpiDiffOverlay,
} from './types.js'

export { buildSpiFileLayer, type BuildSpiFileLayerOptions } from './build.js'
