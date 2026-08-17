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
 * Single-quoted, always.
 *
 * The inline form is embedded in `node -e "<program>"`, so a double quote in the
 * generated JavaScript closes the shell string and truncates the program. None
 * of the values quoted here contain a single quote.
 */
function jsString(value: string): string {
  return `'${value}'`
}

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
    try {
      const descriptor = openSync(artifactPath, 'r');
      const buffer = Buffer.alloc(${PREFIX_BYTES});
      const read = readSync(descriptor, buffer, 0, ${PREFIX_BYTES}, 0);
      closeSync(descriptor);
      return buffer.slice(0, read).toString('utf8');
    } catch (error) {
      return null;
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

/** Single-line form, for embedding in a `node -e` program. */
export function generatedGraphDiscoveryInline(): string {
  return `/* ${GENERATED_GRAPH_DISCOVERY_MARKER} */${generatedGraphDiscoverySource('inline')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')}`
}
