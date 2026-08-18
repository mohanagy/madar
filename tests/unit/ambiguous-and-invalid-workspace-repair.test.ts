import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { buildDoctorReport, runStatusCommand } from '../../src/infrastructure/doctor.js'
import { generateGraph } from '../../src/infrastructure/generate.js'

/**
 * Reporting and repair for the two states a workspace can be stuck in.
 *
 * Doctor computed health from the canonical artifact's freshness, so an
 * ambiguous workspace whose graph.madar happened to be fresh was reported
 * healthy -- while every default load in that same workspace refuses. A report
 * that says "healthy" about a workspace where nothing will answer is worse than
 * no report.
 *
 * Generation had the mirror problem: `--update` against an unreadable canonical
 * artifact loaded it, raised a raw parse error, and failed the command instead
 * of rebuilding from source. The graph it loaded was discarded moments later
 * anyway.
 */

const LIVE_V1 = JSON.stringify({
  schema_version: 1,
  directed: true,
  nodes: [{ id: 'stale', label: 'stale', file_type: 'code', source_file: 'stale.ts' }],
  links: [],
})

function cutOverWorkspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { beta() }\nexport function beta() {}\n')
  generateGraph(root, { noHtml: true })
  return root
}

describe('an ambiguous workspace is reported as needing attention', () => {
  it('is not healthy and names the repair', () => {
    const root = cutOverWorkspace('ambiguous-doctor-')
    try {
      writeFileSync(join(root, 'out', 'graph.json'), LIVE_V1)
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('mixed_v2_and_live_v1')

      const report = buildDoctorReport({ projectDir: root })

      expect(report.healthy).toBe(false)
      expect(report.nextCommands).toContain('madar generate .')
      expect(runStatusCommand({ projectDir: root })).toMatch(/attention needed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('is healthy again once the workspace is unambiguous', () => {
    const root = cutOverWorkspace('ambiguous-repaired-')
    try {
      // The control: the report is about the ambiguity, not about the graph.
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
      expect(buildDoctorReport({ projectDir: root }).graph.workspaceState).toBe('current_v2')
      expect(buildDoctorReport({ projectDir: root }).nextCommands).not.toContain('madar generate .')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('an unreadable canonical artifact is rebuilt, not parsed', () => {
  it('lets --update rebuild from source', () => {
    const root = cutOverWorkspace('invalid-update-')
    try {
      writeFileSync(join(root, 'out', 'graph.madar'), 'MADAR_GRAPH_ARTIFACT/2\n{ truncated')
      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('invalid_current_v2')

      generateGraph(root, { noHtml: true, update: true })

      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('refuses --cluster-only, which has no graph it can trust', () => {
    const root = cutOverWorkspace('invalid-cluster-')
    try {
      writeFileSync(join(root, 'out', 'graph.madar'), 'MADAR_GRAPH_ARTIFACT/2\n{ truncated')

      // Re-clustering needs an existing graph. Rebuilding from source is the
      // repair, and the message has to say so rather than surface a parse error.
      let message = ''
      try {
        generateGraph(root, { noHtml: true, clusterOnly: true })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      expect(message).toMatch(/cluster-only/)
      expect(message).toMatch(/madar generate \./)
      expect(message).not.toMatch(/invalid JSON|Unexpected|SyntaxError/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('still rebuilds a full generation over an unreadable artifact', () => {
    const root = cutOverWorkspace('invalid-full-')
    try {
      writeFileSync(join(root, 'out', 'graph.madar'), 'MADAR_GRAPH_ARTIFACT/2\n{ truncated')

      generateGraph(root, { noHtml: true })

      expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('current_v2')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
