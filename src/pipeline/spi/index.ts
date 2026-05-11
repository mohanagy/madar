// SPI v1 — public re-exports.
//
// Slices 1a + 1b + 2a + 2b + 3a + 3c + 3b + 3b-ii + 1c-i:
//   * types + file layer + imports/exports edges
//   * symbol layer + declares edges
//   * call layer + type layer (extends/implements/param_type/return_type)
//   * diff overlay (computed on demand against a base/head ref)
//   * heuristic test layer (covered_by edges)
//   * NestJS framework base (framework_role tagging + module_imports/
//     module_provides/module_exports/controller_route)
//   * NestJS framework quality-of-life: guards/pipes/intercepts edges,
//     injects edges from constructor types and @Inject('TOKEN'),
//     dynamic Module.forRoot/forRootAsync handling.
//   * Structural projector — projectSpiToExtraction(spi, { root }) bridges
//     the SPI substrate to the existing graph.json pipeline by producing
//     ExtractionData of the same shape buildFromJson() consumes. Slice
//     1c-ii will extend it to byte-equivalence on examples/demo-repo/.

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

export {
  buildSpi,
  buildSpiFileLayer,
  type BuildSpiOptions,
  type BuildSpiFileLayerOptions,
} from './build.js'

export {
  computeSpiDiffOverlay,
  type ComputeSpiDiffOverlayOptions,
  type GitDiffRunner,
} from './diff-overlay.js'

export { isTestFilePath } from './test-layer.js'

export {
  detectNestFramework,
  collectNestTokenMap,
  type DetectNestFrameworkContext,
  type CollectNestTokenMapOptions,
  type NestTokenMap,
  type NestTokenBinding,
} from './framework-nestjs.js'

export {
  projectSpiToExtraction,
  type ProjectSpiToExtractionOptions,
} from './projector.js'

export {
  detectExpressFramework,
  type DetectExpressFrameworkContext,
} from './framework-express.js'

export {
  detectNextjsFramework,
  type DetectNextjsFrameworkContext,
} from './framework-nextjs.js'

export {
  detectReactRouterFramework,
  type DetectReactRouterFrameworkContext,
} from './framework-react-router.js'
