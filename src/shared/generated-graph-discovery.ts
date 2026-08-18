import { CANONICAL_ARTIFACT_BASENAME, LEGACY_ARTIFACT_BASENAME } from '../contracts/graph-artifact-selection.js'
import { GRAPH_ARTIFACT_MOVED_PREFIX, GRAPH_ARTIFACT_V2_HEADER } from '../contracts/graph-artifact-format.js'

/**
 * The one workspace classifier that generated host code embeds.
 *
 * Discovery had drifted into three separate implementations: the `node -e`
 * snippet for Gemini/Claude tool hooks, the CommonJS prompt-hook script for
 * Claude Code and Codex, and the ESM OpenCode plugin. Only the first was
 * migrated at the cutover, so the other two kept asking whether a file exists.
 * That is wrong in both directions after the cutover -- a canonical-only
 * workspace looked empty, and a tombstone or an ambiguous mixed workspace
 * looked ready -- and nothing failed, because each surface had its own copy and
 * only one was under test.
 *
 * Generating all three from this text is the point: a future change to
 * classification cannot reach one host and miss another.
 *
 * This stays a readiness hint. It reads a bounded prefix of each artifact,
 * enough to tell the shapes apart and no more; the runtime loader is what
 * validates an artifact before anything is answered from it.
 */

/**
 * Wording every generated surface uses for a workspace that never cut over.
 *
 * The contract forbids an unqualified "knowledge graph available" claim for a
 * legacy workspace: the graph is real but is being read in compatibility mode,
 * and a host told only that a graph exists cannot report the difference.
 */
export const GENERATED_LEGACY_GRAPH_NOTICE =
  'NOTE: this workspace still carries the legacy out/graph.json artifact, which Madar reads in '
  + 'compatibility mode. Run `madar generate .` to publish out/graph.madar.'

/** Marks generated output as carrying this classifier. */
export const GENERATED_GRAPH_DISCOVERY_MARKER = 'madar-workspace-graph-check'

/** States the generated classifier reports, mapped from the runtime states. */
export type GeneratedGraphState = 'current' | 'legacy' | 'mixed' | 'moved' | 'invalid' | 'none'

/** How the host loads `fs` and `path`. */
export type GeneratedModuleStyle = 'inline' | 'commonjs' | 'esm'

const PREFIX_BYTES = 32

/**
 * The markers the generated classifier matches must fit the window it reads.
 *
 * The generated program reads exactly PREFIX_BYTES from the front of each
 * candidate and compares the result against these two literals. A rename that
 * pushed either past the window would not fail to build and would not throw at
 * runtime: every workspace would simply classify as `invalid`, on every host
 * surface at once, with nothing pointing at the cause. Asserting it here fails
 * at generation instead.
 */
const GENERATED_PREFIX_MARKERS = [
  GRAPH_ARTIFACT_V2_HEADER.trimEnd(),
  GRAPH_ARTIFACT_MOVED_PREFIX,
] as const

for (const marker of GENERATED_PREFIX_MARKERS) {
  const byteLength = Buffer.byteLength(marker, 'utf8')
  if (byteLength > PREFIX_BYTES) {
    throw new Error(
      `generated host discovery reads ${PREFIX_BYTES} bytes but must match `
      + `${JSON.stringify(marker)}, which is ${byteLength} bytes`,
    )
  }
}

/**
 * A single-quoted JavaScript string literal, safe for every emitted form.
 *
 * The inline form is embedded in `node -e "<program>"`, so a double quote in the
 * generated JavaScript would close the shell string and truncate the program --
 * which is why single quotes are not a style choice here. None of the values
 * currently quoted contain an apostrophe, but nothing about a basename or header
 * constant guarantees that, and a rename that introduced one would silently
 * reintroduce a truncated program. So the escaping is real rather than assumed,
 * and a value that cannot be embedded safely fails loudly at generation time.
 */
export function escapeGeneratedString(value: string): string {
  if (value.includes('"')) {
    throw new Error(`generated host discovery cannot embed a double quote: ${JSON.stringify(value)}`)
  }
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
  return `'${escaped}'`
}

const jsString = escapeGeneratedString

function prelude(style: GeneratedModuleStyle): string {
  if (style === 'esm') {
    return `import { closeSync, lstatSync, openSync, readSync } from ${jsString('fs')};\n`
      + `import { dirname as dirnameOf, join as joinPath } from ${jsString('path')};\n`
  }
  return `const madarFs = require(${jsString('fs')}), madarPath = require(${jsString('path')});\n`
    + 'const { closeSync, lstatSync, openSync, readSync } = madarFs;\n'
    + 'const dirnameOf = madarPath.dirname, joinPath = madarPath.join;\n'
}

/**
 * Source text defining `classifyMadarWorkspace(startDirectory)`.
 *
 * It returns `{ graphState, linkedWorktree, hasGraph, legacyGraph }`. A linked
 * worktree keeps its artifacts outside the checkout behind a workspace hash
 * this code cannot compute, so it reports availability without having inspected
 * an artifact -- the installed MCP server builds that graph at startup.
 */
export function generatedGraphDiscoverySource(style: GeneratedModuleStyle): string {
  return `${prelude(style)}
function classifyMadarWorkspace(startDirectory) {
  function madarArtifactPrefix(artifactPath) {
    var descriptor = null;
    try {
      descriptor = openSync(artifactPath, 'r');
      const buffer = Buffer.alloc(${PREFIX_BYTES});
      const read = readSync(descriptor, buffer, 0, ${PREFIX_BYTES}, 0);
      return buffer.slice(0, read).toString('utf8');
    } catch (error) {
      return null;
    } finally {
      // The read can fail after the open succeeds -- EISDIR when the path is a
      // directory, EIO on a failing mount. Closing only on the success path
      // leaked a descriptor every time, and a host that calls this on each tool
      // invocation repeats it for the life of the process.
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch (closeError) {}
      }
    }
  }

  let directory = startDirectory;
  let graphState = 'none';
  let linkedWorktree = false;
  for (;;) {
    const outputDir = joinPath(directory, 'out');
    const canonicalPrefix = madarArtifactPrefix(joinPath(outputDir, ${jsString(CANONICAL_ARTIFACT_BASENAME)}));
    const legacyPrefix = madarArtifactPrefix(joinPath(outputDir, ${jsString(LEGACY_ARTIFACT_BASENAME)}));
    if (canonicalPrefix !== null || legacyPrefix !== null) {
      const canonical = canonicalPrefix !== null && canonicalPrefix.indexOf(${jsString(GRAPH_ARTIFACT_V2_HEADER.trimEnd())}) === 0;
      const moved = legacyPrefix !== null && legacyPrefix.indexOf(${jsString(GRAPH_ARTIFACT_MOVED_PREFIX)}) === 0;
      const liveV1 = legacyPrefix !== null && !moved && /^\\s*\\{/.test(legacyPrefix);
      graphState = (canonicalPrefix !== null && !canonical)
        ? 'invalid'
        : canonical
          ? (liveV1 ? 'mixed' : 'current')
          : moved ? 'moved' : liveV1 ? 'legacy' : 'invalid';
      break;
    }

    try {
      if (lstatSync(joinPath(directory, '.git')).isFile()) {
        linkedWorktree = true;
        break;
      }
    } catch (error) {}

    const parent = dirnameOf(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return {
    graphState: graphState,
    linkedWorktree: linkedWorktree,
    hasGraph: graphState === 'current' || graphState === 'legacy' || linkedWorktree,
    legacyGraph: graphState === 'legacy',
  };
}`
}

/**
 * Single-line form, for embedding in a `node -e` program.
 *
 * Line comments are stripped before joining. Collapsing the source to one line
 * turns any `//` into a comment that swallows the rest of the program, so a
 * comment written inside the generated function would silently truncate it --
 * which is exactly what happened when one was added to a `finally` block.
 * `containsNoLineComment` below is the guard that keeps this honest.
 */
export function generatedGraphDiscoveryInline(): string {
  const body = generatedGraphDiscoverySource('inline')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ')
  if (body.includes('//')) {
    throw new Error('generated inline discovery still contains a line comment after stripping')
  }
  return `/* ${GENERATED_GRAPH_DISCOVERY_MARKER} */${body}`
}
