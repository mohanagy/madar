import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { generateIndex } from '../../src/application/generate-index.js'
import { buildDoctorReport, runDoctorCommand, runStatusCommand } from '../../src/infrastructure/doctor.js'

function inWorkspace(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'madar-doctor-'))
  try {
    run(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('doctor command', () => {
  it('reports a missing graph without requiring optional agents', () => {
    inWorkspace((workspace) => {
      const report = buildDoctorReport({ projectDir: workspace })
      const output = runDoctorCommand({ projectDir: workspace })

      expect(report.graph).toEqual(expect.objectContaining({
        exists: false,
        indexState: 'missing',
        buildState: null,
      }))
      expect(report.healthy).toBe(false)
      expect(output).toContain('query index: missing')
      expect(output).toContain('madar generate .')
      expect(output).not.toContain('madar claude install')
    })
  })

  it('reports authenticated canonical index and build-state readiness', () => {
    inWorkspace((workspace) => {
      writeFileSync(join(workspace, 'main.ts'), 'export const canonicalValue = 1\n')
      const generated = generateIndex(workspace)
      const report = buildDoctorReport({ projectDir: workspace })
      const doctor = runDoctorCommand({ projectDir: workspace })
      const status = runStatusCommand({ projectDir: workspace })

      expect(report.graph.indexState).toBe('ready')
      expect(report.graph.buildState?.build_id).toBe(generated.buildId)
      expect(report.healthy).toBe(true)
      expect(doctor).toContain('query index: ready')
      expect(doctor).toContain(`build: authenticated (${generated.buildId})`)
      expect(status).toContain('index ready')
      expect(status).toContain(`build ${generated.buildId}`)
      expect(status).not.toContain('freshness')
      expect(status).not.toContain('semantic')
    })
  })

  it('reports corrupt graph bytes as an explicit index boundary', () => {
    inWorkspace((workspace) => {
      writeFileSync(join(workspace, 'main.ts'), 'export const value = 1\n')
      const generated = generateIndex(workspace)
      writeFileSync(generated.graphPath, '{"invalid":true}\n')
      const report = buildDoctorReport({ projectDir: workspace })

      expect(report.graph.indexState).toBe('corrupt')
      expect(report.graph.buildState).toBeNull()
      expect(report.healthy).toBe(false)
    })
  })

  it('reports retired hooks and MCP profile settings as stale installation state', () => {
    inWorkspace((workspace) => {
      writeFileSync(join(workspace, 'main.ts'), 'export const canonicalValue = 1\n')
      generateIndex(workspace)
      writeFileSync(join(workspace, 'CLAUDE.md'), '## madar\nretrieve\n')
      writeJson(join(workspace, '.claude', 'settings.json'), {
        hooks: {
          PreToolUse: [{
            name: 'madar',
            source: 'madar',
            matcher: 'Glob|Grep|Bash|Agent|Read',
            hooks: [{ type: 'command', command: 'old-profile-hook' }],
          }],
        },
      })
      writeJson(join(workspace, '.mcp.json'), {
        mcpServers: {
          madar: {
            command: 'madar',
            args: ['serve', '--stdio', '--auto-refresh'],
            env: { MADAR_TOOL_PROFILE: 'strict' },
          },
        },
      })

      const report = buildDoctorReport({ projectDir: workspace })
      const claude = report.agents.find((agent) => agent.label === 'claude')
      const mcp = report.mcpChecks.find((check) => check.label === 'claude')

      expect(claude?.status).toBe('partial')
      expect(mcp).toEqual(expect.objectContaining({
        status: 'stale',
        reason: expect.stringContaining('retired MADAR_TOOL_PROFILE'),
      }))
      expect(report.nextCommands).toContain('madar claude install')
      expect(report.healthy).toBe(false)
    })
  })
})
