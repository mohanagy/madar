import { describe, expect, it } from 'vitest'

import {
  CANONICAL_ARTIFACT_BASENAME,
  LEGACY_ARTIFACT_BASENAME,
  LEGACY_BACKUP_BASENAME,
} from '../../src/contracts/graph-artifact-selection.js'
import { GRAPH_LOCAL_SIDECAR_BASENAME } from '../../src/contracts/graph-artifact.js'
import { NATIVE_AGENT_SNAPSHOT_TARGETS } from '../../src/infrastructure/compare.js'

describe('native agent runs isolate every published graph artifact', () => {
  it('snapshots each artifact the cutover can publish', () => {
    // Derived from the publisher's own basenames rather than restated, so
    // adding a published artifact without isolating it fails here. graph.madar
    // was missing while graph.json was still live, which hid the gap: the
    // baseline arm's graph happened to be protected by the legacy entry.
    const published = [
      CANONICAL_ARTIFACT_BASENAME,
      LEGACY_ARTIFACT_BASENAME,
      LEGACY_BACKUP_BASENAME,
      GRAPH_LOCAL_SIDECAR_BASENAME,
    ]

    for (const basename of published) {
      expect(NATIVE_AGENT_SNAPSHOT_TARGETS).toContain(`out/${basename}`)
    }
  })

  it('still isolates the non-graph workspace files', () => {
    for (const target of ['out/GRAPH_REPORT.md', 'out/graph.html', '.mcp.json', 'CLAUDE.md', '.claude']) {
      expect(NATIVE_AGENT_SNAPSHOT_TARGETS).toContain(target)
    }
  })
})
