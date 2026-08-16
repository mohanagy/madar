/**
 * The on-disk markers that identify a graph artifact.
 *
 * A leaf module on purpose. These constants are needed by both the artifact
 * reader and the workspace classifier, and the classifier is the single owner
 * of "which artifact does this path mean?". Keeping the markers here lets the
 * reader depend on the classifier without the two importing each other.
 */

export const GRAPH_ARTIFACT_V2_HEADER = 'MADAR_GRAPH_ARTIFACT/2\n' as const

export const GRAPH_ARTIFACT_V2_TOMBSTONE = [
  'MADAR_GRAPH_MOVED/2',
  'Use out/graph.madar with Madar >= the v2-supporting version.',
  '',
].join('\n')

/**
 * Magic that marks a legacy path as moved, whatever version wrote it.
 *
 * Write the exact tombstone above; accept any `MADAR_GRAPH_MOVED/<n>`. Nothing
 * else writes this magic, so a different version -- or trailing bytes from a
 * partial write -- still unambiguously means the artifact moved. Reporting that
 * is more actionable than calling the file corrupt, and it keeps a tombstone
 * written by a future version readable by this one.
 */
export const GRAPH_ARTIFACT_MOVED_PREFIX = 'MADAR_GRAPH_MOVED/'

/** True for any versioned moved marker, current or not. */
export function isMovedMarkerText(text: string): boolean {
  return text.startsWith(GRAPH_ARTIFACT_MOVED_PREFIX)
}
