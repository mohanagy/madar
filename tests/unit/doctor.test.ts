import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildDiagnosticReport,
  formatDoctorReport,
  formatStatusReport,
  runDoctorCommand,
  runStatusCommand,
} from '../../src/adapters/cli/doctor.js'
import {
  canonicalWorkspace,
  installClient,
  workspaceServerName,
  type InstallOptions,
} from '../../src/adapters/cli/install.js'
import { generateIndex } from '../../src/application/generate-index.js'

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'madar-thin-doctor-'))
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function exactClaudeRegistration(homeDir: string, workspace: string): void {
  const canonical = canonicalWorkspace(workspace)
  const serverName = workspaceServerName(workspace)
  writeJson(join(homeDir, '.claude.json'), {
    projects: {
      [canonical]: {
        mcpServers: {
          [serverName]: {
            type: 'stdio',
            command: 'madar',
            args: ['mcp'],
            env: {},
          },
        },
      },
    },
  })
}

function exactInstallOptions(sandbox: string): InstallOptions {
  return {
    homeDir: join(sandbox, 'home'),
    codexHome: join(sandbox, 'home', '.codex'),
  }
}

describe('thin-delivery status and doctor diagnostics', () => {
  it('reports the graph and exactly the two accepted client registrations', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      mkdirSync(workspace, { recursive: true })
      const options = exactInstallOptions(sandbox)

      const report = buildDiagnosticReport({
        projectDir: workspace,
        install: options,
      })

      expect(report).toEqual({
        workspace: resolve(workspace),
        linkedWorktree: false,
        graph: {
          path: join(workspace, 'out', 'graph.json'),
          state: 'missing',
          subject: 'canonical graph artifact',
          buildId: null,
          completeness: null,
        },
        clients: [
          expect.objectContaining({ client: 'claude', status: 'missing' }),
          expect.objectContaining({ client: 'codex', status: 'missing' }),
        ],
        healthy: false,
      })
      expect(formatStatusReport(report)).toBe(
        `workspace=${resolve(workspace)} graph=missing claude=missing codex=missing`,
      )
      expect(formatDoctorReport(report)).toContain('[madar doctor] attention required')
      expect(formatDoctorReport(report)).toContain('- claude: missing')
      expect(formatDoctorReport(report)).toContain('- codex: missing')
      expect(formatDoctorReport(report)).not.toContain('gemini')
      expect(formatDoctorReport(report)).not.toContain('cursor')
      expect(formatDoctorReport(report)).not.toContain('hook')
      expect(formatDoctorReport(report)).not.toContain('skill')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('uses one shared report shape for status and doctor when graph and wiring are exact', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const options = exactInstallOptions(sandbox)
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'main.ts'), 'export const ready = true\n')
      const generated = generateIndex(workspace)
      exactClaudeRegistration(options.homeDir!, workspace)
      installClient('codex', workspace, options)

      const report = buildDiagnosticReport({
        projectDir: workspace,
        install: options,
      })
      const status = formatStatusReport(report)
      const doctor = formatDoctorReport(report)

      expect(report.healthy).toBe(true)
      expect(report.graph).toMatchObject({
        path: generated.graphPath,
        state: 'ready',
        buildId: generated.buildId,
      })
      expect(report.clients.map((client) => [client.client, client.status]))
        .toEqual([['claude', 'exact'], ['codex', 'exact']])
      expect(status).toBe(
        `workspace=${resolve(workspace)} graph=ready claude=exact codex=exact`,
      )
      expect(doctor).toContain('[madar doctor] ready')
      expect(doctor).toContain(`- build: ${generated.buildId}`)
      expect(doctor).toContain('- claude: exact')
      expect(doctor).toContain('- codex: exact')
      expect(runStatusCommand({
        projectDir: workspace,
        install: options,
      })).toBe(status)
      expect(runDoctorCommand({
        projectDir: workspace,
        install: options,
      })).toBe(doctor)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('marks corrupt and foreign-workspace graph artifacts as explicit boundaries', () => {
    const sandbox = makeSandbox()
    try {
      const source = join(sandbox, 'source')
      const target = join(sandbox, 'target')
      mkdirSync(source, { recursive: true })
      mkdirSync(target, { recursive: true })
      writeFileSync(join(source, 'main.ts'), 'export const source = true\n')
      const generated = generateIndex(source)

      const foreign = buildDiagnosticReport({
        projectDir: target,
        graphPath: generated.graphPath,
        install: exactInstallOptions(sandbox),
      })
      expect(foreign.graph).toMatchObject({
        state: 'stale',
        subject: 'graph belongs to a different workspace',
        buildId: generated.buildId,
      })
      expect(foreign.healthy).toBe(false)

      writeFileSync(generated.graphPath, '{"not":"a graph"}\n')
      const corrupt = buildDiagnosticReport({
        projectDir: source,
        install: exactInstallOptions(sandbox),
      })
      expect(corrupt.graph).toEqual({
        path: generated.graphPath,
        state: 'corrupt',
        subject: 'canonical graph artifact',
        buildId: null,
        completeness: null,
      })
      expect(corrupt.healthy).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('surfaces unreadable Claude state and user-managed Codex ownership without mutation', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const options = exactInstallOptions(sandbox)
      mkdirSync(workspace, { recursive: true })
      mkdirSync(options.homeDir!, { recursive: true })
      writeFileSync(join(options.homeDir!, '.claude.json'), '{ broken', 'utf8')
      mkdirSync(options.codexHome!, { recursive: true })
      const serverName = workspaceServerName(workspace)
      const codexConfig = `[mcp_servers.${serverName}]\ncommand = "user-owned"\n`
      writeFileSync(join(options.codexHome!, 'config.toml'), codexConfig, 'utf8')

      const report = buildDiagnosticReport({
        projectDir: workspace,
        install: options,
      })

      expect(report.clients).toEqual([
        expect.objectContaining({
          client: 'claude',
          status: 'stale',
          detail: 'Claude configuration is not readable JSON',
        }),
        expect.objectContaining({
          client: 'codex',
          status: 'conflict',
          detail: 'workspace server name is user-managed',
        }),
      ])
      expect(readFileSync(join(options.homeDir!, '.claude.json'), 'utf8')).toBe('{ broken')
      expect(readFileSync(join(options.codexHome!, 'config.toml'), 'utf8')).toBe(codexConfig)
      expect(report.healthy).toBe(false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps both command entrypoints as formatters over the same diagnostic builder', () => {
    const source = readFileSync(
      resolve('src/adapters/cli/doctor.ts'),
      'utf8',
    )
    expect(source.match(/export function buildDiagnosticReport\(/g)).toHaveLength(1)
    expect(source).toMatch(
      /return formatStatusReport\(buildDiagnosticReport\(options\)\)/,
    )
    expect(source).toMatch(
      /return formatDoctorReport\(buildDiagnosticReport\(options\)\)/,
    )
    expect(source.match(/inspectClient\('/g)).toHaveLength(2)
  })
})
