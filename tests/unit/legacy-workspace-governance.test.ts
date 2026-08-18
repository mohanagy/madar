import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { executeCli } from '../../src/cli/main.js'
import { classifyWorkspaceGraph } from '../../src/contracts/graph-artifact-selection.js'
import { runDoctorCommand, runStatusCommand } from '../../src/infrastructure/doctor.js'

/**
 * A workspace that never cut over must be reported as what it is.
 *
 * Answering from a legacy v1 graph was already supported, but the surfaces that
 * describe the workspace were still resolving the caller's requested path -- and
 * the CLI parser always supplies a default, `out/graph.madar`. So a command
 * answered correctly from graph.json and then reported on a file that does not
 * exist: freshness said `missing`, `status` said `graph missing`, the payload
 * named graph.madar as its source, and telemetry printed `Graph file not found`
 * with an absolute path. Every one of those is a false statement about a
 * workspace that has a working graph.
 *
 * Presence of a path is not intent. These cases pin the distinction at each
 * surface that got it wrong.
 */

const LEGACY_V1 = (root: string): string => JSON.stringify({
  schema_version: 1,
  directed: true,
  root_path: root,
  nodes: [
    { id: 'a_alpha', label: 'alpha()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' },
    { id: 'a_beta', label: 'beta()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L2' },
  ],
  links: [
    { source: 'a_alpha', target: 'a_beta', relation: 'calls', confidence: 'EXTRACTED', source_file: 'src/a.ts' },
  ],
})

describe('a workspace that never cut over is reported truthfully', () => {
  let root: string
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    root = mkdtempSync(join(tmpdir(), 'legacy-governance-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { beta() }\nexport function beta() {}\n')
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'graph.json'), LEGACY_V1(root))
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(root, { recursive: true, force: true })
  })

  it('starts from a legacy-only workspace with no canonical artifact', () => {
    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('legacy_v1_only')
  })

  it('pack reports the artifact it read and measures freshness against it', async () => {
    const lines: string[] = []
    const io = {
      log: (message: string) => lines.push(String(message)),
      error: (message: string) => lines.push(String(message)),
    }

    const exitCode = await executeCli(['pack', 'how does alpha work?'], io)
    const text = lines.join('\n')
    const payload = JSON.parse(text.slice(text.indexOf('{')).split('\n')[0] ?? '{}') as {
      graph_path?: string
      governance?: { graph_freshness?: { status?: string, indexed_file_count?: number } }
    }

    expect(exitCode).toBe(0)
    // Naming graph.madar here claimed a file the workspace does not have.
    expect(payload.graph_path).toBe('out/graph.json')
    expect(payload.governance?.graph_freshness?.status).not.toBe('missing')
    expect(payload.governance?.graph_freshness?.indexed_file_count ?? 0).toBeGreaterThan(0)
  })

  it('prompt reports the artifact it read', async () => {
    const lines: string[] = []
    const io = {
      log: (message: string) => lines.push(String(message)),
      error: (message: string) => lines.push(String(message)),
    }

    const exitCode = await executeCli(['prompt', 'how does alpha work?', '--provider', 'claude'], io)
    const text = lines.join('\n')
    const payload = JSON.parse(text.slice(text.indexOf('{')).split('\n')[0] ?? '{}') as {
      graph_path?: string
      graph_freshness?: { status?: string }
    }

    expect(exitCode).toBe(0)
    expect(payload.graph_path).toBe('out/graph.json')
    expect(payload.graph_freshness?.status).not.toBe('missing')
  })

  it('no command leaks a not-found path for an artifact nobody asked for', async () => {
    const lines: string[] = []
    const io = {
      log: (message: string) => lines.push(String(message)),
      error: (message: string) => lines.push(String(message)),
    }

    await executeCli(['pack', 'how does alpha work?'], io)
    await executeCli(['prompt', 'how does alpha work?', '--provider', 'claude'], io)
    const text = lines.join('\n')

    // The telemetry buckets loaded the requested path rather than the resolved
    // one, so a successful command emitted a not-found error carrying an
    // absolute filesystem path.
    expect(text).not.toMatch(/Graph file not found/)
    expect(text).not.toContain(root)
  })

  it('status and doctor describe the graph the workspace has', () => {
    // The parser's default made `graphPath !== undefined` always true, so the
    // pre-cutover branch in the report builder was unreachable and every legacy
    // workspace was described as having no graph at all.
    const status = runStatusCommand({ graphPath: 'out/graph.madar', graphPathIntent: 'default' })
    const doctor = runDoctorCommand({ graphPath: 'out/graph.madar', graphPathIntent: 'default' })

    expect(status).not.toMatch(/graph missing/)
    expect(doctor).not.toMatch(/graph: missing/)
  })

  it('still reports a genuinely missing artifact as missing when asked for it', () => {
    // The fix must not make the report unfalsifiable: an explicitly named
    // artifact that does not exist is still missing.
    const status = runStatusCommand({ graphPath: 'out/graph.madar', graphPathIntent: 'explicit' })

    expect(status).toMatch(/graph missing/)
  })

  it('reports missing when the workspace really has no graph', () => {
    rmSync(join(root, 'out', 'graph.json'))

    expect(classifyWorkspaceGraph(join(root, 'out')).state).toBe('missing')
    expect(runStatusCommand({ graphPath: 'out/graph.madar', graphPathIntent: 'default' })).toMatch(/graph missing/)
  })
})
