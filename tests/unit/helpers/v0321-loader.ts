import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

import ts from 'typescript'

/**
 * Compiles the graph loader from the released v0.32.1 tag.
 *
 * The cutover promises that a v0.32.1 binary pointed at a cut-over workspace
 * fails closed rather than answering from something it half-understands. The
 * only way to prove that is to run the released loader itself, so this extracts
 * it from the pinned tag and executes it verbatim. Re-implementing the old
 * behaviour here would prove a guess.
 *
 * Both the tag object and the file digest are asserted. A tag that resolves
 * elsewhere, or a source file that differs from the release, is a failure --
 * silently proceeding would mean the proof no longer describes v0.32.1.
 */

export const RELEASE_TAG = 'v0.32.1'
/**
 * The tag OBJECT sha, which is what `git rev-parse v0.32.1` returns for an
 * annotated tag. The peeled commit is a different value; asserting that one
 * instead fails a correct checkout.
 */
export const RELEASE_TAG_OBJECT_SHA = '60266f238a838d73303c20a1e8894ba47d1444d7'
export const RELEASE_SERVE_SOURCE_SHA256 = '7683f62b0621a318837fbb0395ab90797fc795665031d9bd818ac7bcc48ea713'

const MAX_GRAPH_BYTES = 100 * 1024 * 1024

export type OldLoadGraph = (path: string) => unknown

export function gitText(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** The released `src/runtime/serve.ts`, with its identity asserted. */
export function releaseServeSource(): string {
  const tagObject = gitText(['rev-parse', RELEASE_TAG]).trim()
  if (tagObject !== RELEASE_TAG_OBJECT_SHA) {
    throw new Error(`${RELEASE_TAG} resolves to ${tagObject}, not the pinned ${RELEASE_TAG_OBJECT_SHA}`)
  }
  const source = gitText(['show', `${RELEASE_TAG}:src/runtime/serve.ts`])
  const digest = createHash('sha256').update(source).digest('hex')
  if (digest !== RELEASE_SERVE_SOURCE_SHA256) {
    throw new Error(`${RELEASE_TAG}:src/runtime/serve.ts digest ${digest} does not match the pinned source`)
  }
  return source
}

export function exactFunction(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`Could not extract ${startMarker} from tagged source`)
  return source.slice(start, end).trimEnd()
}

export function executableJavaScript(functionSource: string): string {
  // The release source is otherwise verbatim; removing only the module export
  // lets the extracted function execute inside the dependency-injection shell.
  return ts.transpileModule(functionSource.replace(/^export\s+/, ''), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText
}

export function compileOldLoadGraph(functionSource: string): OldLoadGraph {
  const executableSource = executableJavaScript(functionSource)
  // validateGraphPath is mechanically substituted with identity. It is a path
  // safety guard orthogonal to the released JSON parse behavior under proof.
  const factory = new Function(
    'readFileSync',
    'statSync',
    'MAX_GRAPH_BYTES',
    'validateGraphPath',
    'isRecord',
    'buildFromJson',
    'parseGenerationPolicy',
    'storedCommunityLabels',
    'parseDiscoverySafetyMetadata',
    `"use strict"; ${executableSource}; return loadGraph;`,
  ) as (...dependencies: readonly unknown[]) => OldLoadGraph
  const graph = { graph: {} as Record<string, unknown> }
  return factory(
    readFileSync,
    statSync,
    MAX_GRAPH_BYTES,
    (path: string) => path,
    (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value),
    () => graph,
    () => null,
    () => ({}),
    () => null,
  )
}

/** The released loader, ready to run. */
export function releaseLoadGraph(source = releaseServeSource()): OldLoadGraph {
  return compileOldLoadGraph(exactFunction(
    source,
    'export function loadGraph(graphPath: string): KnowledgeGraph {',
    '\n\nexport function communitiesFromGraph',
  ))
}
