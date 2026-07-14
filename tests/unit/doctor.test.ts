import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'vitest'

import { agentsInstall } from '../../src/infrastructure/install.js'
import { runDoctorCommand, runStatusCommand } from '../../src/infrastructure/doctor.js'

const PACKAGE_CLI_RELATIVE_PATH = join('dist', 'src', 'cli', 'bin.js')

function withSandbox(run: (sandboxDir: string) => void): void {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'madar-doctor-'))
  try {
    run(sandboxDir)
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true })
  }
}

function withOpenCodePackageRoot(run: (packageRoot: string) => void): void {
  withSandbox((packageRoot) => {
    writeJson(resolve(packageRoot, 'package.json'), {
      name: 'madar-test',
      bin: {
        madar: PACKAGE_CLI_RELATIVE_PATH,
      },
    })
    writeText(resolve(packageRoot, PACKAGE_CLI_RELATIVE_PATH), '#!/usr/bin/env node\n')
    run(packageRoot)
  })
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function writeMcpServer(path: string, serversKey: 'mcpServers' | 'servers', graphPath?: string): void {
  writeJson(path, {
    [serversKey]: {
      madar: {
        command: 'npx',
        args: graphPath
          ? ['--yes', '@lubab/madar', 'serve', '--stdio', graphPath]
          : ['--yes', '@lubab/madar', 'serve', '--stdio', '--auto-refresh'],
      },
    },
  })
}

describe('doctor command', () => {
  test('shows indexing completeness, affected local paths, and SPI diagnostics in doctor and status', () => {
    withSandbox((sandboxDir) => {
      writeJson(resolve(sandboxDir, 'out', 'graph.json'), {
        generated_at: new Date().toISOString(),
        nodes: [],
        edges: [],
      })
      writeJson(resolve(sandboxDir, 'out', 'indexing-manifest.json'), {
        version: 1,
        generated_at: new Date().toISOString(),
        summary: {},
        outcomes: [
          {
            path: 'src/index.ts',
            kind: 'file',
            status: 'indexed',
            reason: 'indexed',
            capability: 'builtin:extract:typescript',
          },
          {
            path: 'src/auth/broken.ts',
            kind: 'file',
            status: 'failed',
            reason: 'extractor_error',
            capability: 'builtin:extract:typescript',
          },
          {
            path: 'src/legacy.vue',
            kind: 'file',
            status: 'unsupported',
            reason: 'unsupported_file_type',
            capability: null,
          },
        ],
        spi_diagnostics: [{
          id: 'spi.call.program-create-failed',
          level: 'warn',
          reason: 'spi_diagnostic',
          message: 'local diagnostic detail',
        }],
      })

      const doctor = runDoctorCommand({ projectDir: sandboxDir, now: Date.now() })
      const status = runStatusCommand({ projectDir: sandboxDir, now: Date.now() })

      expect(doctor).toContain('indexing completeness: partial (1 indexed, 0 warnings, 0 policy skips, 1 unsupported, 1 failed)')
      expect(doctor).toContain('"src/auth/broken.ts" (failed; extractor_error; builtin:extract:typescript)')
      expect(doctor).toContain('"src/legacy.vue" (unsupported; unsupported_file_type; no capability)')
      expect(doctor).toContain('SPI diagnostics: 1')
      expect(status).toContain('indexing partial (indexed=1, warnings=0, skipped=0, unsupported=1, failed=1)')
      expect(status).toContain('"src/auth/broken.ts"[extractor_error]')
      expect(status).toContain('"src/legacy.vue"[unsupported_file_type]')
    })
  })

  test('shows local safety exclusion counts, reasons, and escaped paths in doctor and status', () => {
    withSandbox((sandboxDir) => {
      writeJson(resolve(sandboxDir, 'out', 'graph.json'), {
        nodes: [],
        edges: [],
        discovery_safety: {
          version: 1,
          summary: {
            total: 2,
            sensitive: 1,
            unreadable: 1,
            reasons: { secret_config: 1, unreadable_path: 1 },
          },
          exclusions: [
            { path: 'config/credentials.json', kind: 'sensitive', reason: 'secret_config' },
            { path: 'src/auth/broken.ts', kind: 'unreadable', reason: 'unreadable_path' },
          ],
        },
      })

      const doctor = runDoctorCommand({ projectDir: sandboxDir, now: Date.now() })
      const status = runStatusCommand({ projectDir: sandboxDir, now: Date.now() })

      expect(doctor).toContain('safety exclusions: 2 (1 sensitive, 1 unreadable)')
      expect(doctor).toContain('"config/credentials.json" (secret_config)')
      expect(doctor).toContain('"src/auth/broken.ts" (unreadable_path)')
      expect(status).toContain('safety 2 (sensitive=1, unreadable=1)')
      expect(status).toContain('"config/credentials.json"[secret_config]')
      expect(status).toContain('"src/auth/broken.ts"[unreadable_path]')
    })
  })

  test('reports missing graph and suggests setup commands', () => {
    withSandbox((sandboxDir) => {
      const output = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(output).toContain('[madar doctor] attention needed')
      expect(output).toContain('graph: missing')
      expect(output).toContain('madar generate .')
      expect(output).toContain('madar claude install')
      expect(output).toContain('madar cursor install')
      expect(output).toContain('madar gemini install')
      expect(output).toContain('madar copilot install')
    })
  })

  test('reports healthy status when graph and configs are wired', () => {
    withSandbox((sandboxDir) => {
      const graphPath = resolve(sandboxDir, 'out', 'graph.json')
      writeText(graphPath, '{"nodes":[],"edges":[]}\n')
      writeText(resolve(sandboxDir, 'CLAUDE.md'), '## madar\n')
      writeText(resolve(sandboxDir, 'GEMINI.md'), '## madar\n')
      writeText(resolve(sandboxDir, '.cursor', 'rules', 'madar.mdc'), 'rule')
      writeJson(resolve(sandboxDir, '.claude', 'settings.json'), {
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'out' }] }],
        },
      })
      writeJson(resolve(sandboxDir, '.gemini', 'settings.json'), {
        hooks: {
          BeforeTool: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'out' }] }],
        },
        mcpServers: {
          madar: {
            command: 'madar',
            args: ['serve', '--stdio', '--auto-refresh'],
            env: { MADAR_TOOL_PROFILE: 'core' },
          },
        },
      })
      writeMcpServer(resolve(sandboxDir, '.mcp.json'), 'mcpServers')
      writeMcpServer(resolve(sandboxDir, '.cursor', 'mcp.json'), 'mcpServers')
      writeMcpServer(resolve(sandboxDir, '.vscode', 'mcp.json'), 'servers')

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })
      const status = runStatusCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).toContain('[madar doctor] healthy')
      expect(doctor).toContain('claude: configured')
      expect(doctor).toContain('cursor: configured')
      expect(doctor).toContain('gemini: configured')
      expect(doctor).toContain('copilot: configured')
      expect(doctor).toContain('next commands: none')

      expect(status).toContain('[madar status] healthy')
      expect(status).toContain('next none')
    })
  })

  test('flags stale mcp path and recommends reinstall', () => {
    withSandbox((sandboxDir) => {
      const graphPath = resolve(sandboxDir, 'out', 'graph.json')
      const wrongGraphPath = resolve(sandboxDir, 'out', 'old-graph.json')
      writeText(graphPath, '{"nodes":[],"edges":[]}\n')
      writeText(resolve(sandboxDir, 'CLAUDE.md'), '## madar\n')
      writeJson(resolve(sandboxDir, '.claude', 'settings.json'), {
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'out' }] }],
        },
      })
      writeMcpServer(resolve(sandboxDir, '.mcp.json'), 'mcpServers', wrongGraphPath)

      const output = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(output).toContain('claude: partial')
      expect(output).toContain('.mcp.json')
      expect(output).toContain('stale')
      expect(output).toContain('madar claude install')
    })
  })

  test('does not treat unrelated checkout hooks as configured', () => {
    withSandbox((sandboxDir) => {
      const graphPath = resolve(sandboxDir, 'out', 'graph.json')
      writeText(graphPath, '{"nodes":[],"edges":[]}\n')
      writeText(resolve(sandboxDir, 'CLAUDE.md'), '## madar\n')
      writeText(resolve(sandboxDir, 'GEMINI.md'), '## madar\n')
      writeJson(resolve(sandboxDir, '.claude', 'settings.json'), {
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo checkout complete' }] }],
        },
      })
      writeJson(resolve(sandboxDir, '.gemini', 'settings.json'), {
        hooks: {
          BeforeTool: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'echo linked checkout ready' }] }],
        },
      })

      const output = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(output).toContain('claude: partial')
      expect(output).toContain('gemini: partial')
      expect(output).toContain('madar claude install')
      expect(output).toContain('madar gemini install')
    })
  })

  test('reports codex as configured when AGENTS.md, the managed prompt hook, and MCP config are wired', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      agentsInstall(sandboxDir, 'codex')

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })
      const status = runStatusCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).toContain('codex: configured')
      expect(doctor).toContain('instructions=yes')
      expect(doctor).toContain('hook=yes')
      expect(doctor).toContain('mcp=yes')
      expect(status).toContain('codex:configured')
    })
  })

  test('flags the pre-#550 Codex core marker until reinstall migrates it to strict', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      agentsInstall(sandboxDir, 'codex')
      const configPath = resolve(sandboxDir, '.codex', 'config.toml')
      writeText(
        configPath,
        readFileSync(configPath, 'utf8').replace('MADAR_TOOL_PROFILE = "strict"', 'MADAR_TOOL_PROFILE = "core"'),
      )

      const doctor = runDoctorCommand({ projectDir: sandboxDir, now: Date.now() })

      expect(doctor).toContain('codex: partial')
      expect(doctor).toContain('mcp=no')
      expect(doctor).toContain('madar codex install')
    })
  })

  test('reports an incomplete Codex profile as partial and recommends reinstall', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      agentsInstall(sandboxDir, 'codex')
      rmSync(resolve(sandboxDir, '.codex', 'madar-user-prompt-submit.cjs'), { force: true })

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })
      const status = runStatusCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).toContain('codex: partial')
      expect(doctor).toContain('instructions=yes')
      expect(doctor).toContain('hook=no')
      expect(doctor).toContain('mcp=yes')
      expect(doctor).toContain('madar codex install')
      expect(status).toContain('codex:partial')
    })
  })

  test('reports a marker-prefixed but stale Codex prompt script as partial', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      agentsInstall(sandboxDir, 'codex')
      writeText(
        resolve(sandboxDir, '.codex', 'madar-user-prompt-submit.cjs'),
        '// madar managed Codex UserPromptSubmit hook\nconsole.log("stale")\n',
      )

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).toContain('codex: partial')
      expect(doctor).toContain('instructions=yes')
      expect(doctor).toContain('hook=no')
      expect(doctor).toContain('mcp=yes')
      expect(doctor).toContain('madar codex install')
    })
  })

  test('reports a managed Codex MCP block with a later user conflict as partial', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      agentsInstall(sandboxDir, 'codex')
      const configPath = resolve(sandboxDir, '.codex', 'config.toml')
      writeText(
        configPath,
        `${readFileSync(configPath, 'utf8')}\n[mcp_servers.madar]\ncommand = "custom-madar"\n`,
      )

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })
      const status = runStatusCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).toContain('codex: partial')
      expect(doctor).toContain('instructions=yes')
      expect(doctor).toContain('hook=yes')
      expect(doctor).toContain('mcp=no')
      expect(doctor).toContain('madar codex install')
      expect(status).toContain('codex:partial')
    })
  })

  test('reports duplicate, stale, or legacy managed Codex hooks as partial', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      agentsInstall(sandboxDir, 'codex')
      const hooksPath = resolve(sandboxDir, '.codex', 'hooks.json')
      const hooksConfig = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
        hooks?: {
          UserPromptSubmit?: Array<Record<string, unknown>>
          PreToolUse?: Array<Record<string, unknown>>
        }
      }
      hooksConfig.hooks?.UserPromptSubmit?.push({
        name: 'madar',
        source: 'madar',
        hooks: [{ type: 'command', command: 'echo stale-madar-prompt-hook' }],
      })
      hooksConfig.hooks ??= {}
      hooksConfig.hooks.PreToolUse = [{
        name: 'madar',
        source: 'madar',
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo legacy-madar-pre-tool-hook' }],
      }]
      writeText(hooksPath, `${JSON.stringify(hooksConfig, null, 2)}\n`)

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })
      const status = runStatusCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).toContain('codex: partial')
      expect(doctor).toContain('instructions=yes')
      expect(doctor).toContain('hook=no')
      expect(doctor).toContain('mcp=yes')
      expect(doctor).toContain('madar codex install')
      expect(status).toContain('codex:partial')
    })
  })

  test('reports a managed Codex prompt hook with an extra command as partial', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      agentsInstall(sandboxDir, 'codex')
      const hooksPath = resolve(sandboxDir, '.codex', 'hooks.json')
      const hooksConfig = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
        hooks?: {
          UserPromptSubmit?: Array<{ source?: string, hooks?: Array<Record<string, unknown>> }>
        }
      }
      const managedHook = hooksConfig.hooks?.UserPromptSubmit?.find((hook) => hook.source === 'madar')
      managedHook?.hooks?.push({ type: 'command', command: 'echo extra-untrusted-command' })
      writeText(hooksPath, `${JSON.stringify(hooksConfig, null, 2)}\n`)

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).toContain('codex: partial')
      expect(doctor).toContain('instructions=yes')
      expect(doctor).toContain('hook=no')
      expect(doctor).toContain('mcp=yes')
      expect(doctor).toContain('madar codex install')
    })
  })

  test('reports OpenCode as configured when the AGENTS profile, plugin, and MCP entry are wired', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      withOpenCodePackageRoot((packageRoot) => {
        agentsInstall(sandboxDir, 'opencode', { packageRoot })

        const doctor = runDoctorCommand({
          projectDir: sandboxDir,
          now: Date.now(),
        })
        const status = runStatusCommand({
          projectDir: sandboxDir,
          now: Date.now(),
        })

        expect(doctor).toContain('opencode: configured')
        expect(doctor).toContain('instructions=yes')
        expect(doctor).toContain('plugin=yes')
        expect(doctor).toContain('mcp=yes')
        expect(status).toContain('opencode:configured')
      })
    })
  })

  test('ignores unrelated OpenCode config files that do not contain Madar wiring', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      writeJson(resolve(sandboxDir, 'opencode.json'), {
        mcp: {
          other: {
            type: 'local',
            command: ['echo', 'hi'],
          },
        },
      })

      const doctor = runDoctorCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })
      const status = runStatusCommand({
        projectDir: sandboxDir,
        now: Date.now(),
      })

      expect(doctor).not.toContain('opencode:')
      expect(doctor).not.toContain('madar opencode install')
      expect(status).not.toContain('opencode:')
    })
  })

  test('flags stale OpenCode AGENTS guidance and recommends reinstall', () => {
    withSandbox((sandboxDir) => {
      writeText(resolve(sandboxDir, 'out', 'graph.json'), '{"nodes":[],"edges":[]}\n')
      withOpenCodePackageRoot((packageRoot) => {
        agentsInstall(sandboxDir, 'opencode', { packageRoot })
        writeText(resolve(sandboxDir, 'AGENTS.md'), '## madar\n\nOld guidance.\n')

        const doctor = runDoctorCommand({
          projectDir: sandboxDir,
          now: Date.now(),
        })
        const status = runStatusCommand({
          projectDir: sandboxDir,
          now: Date.now(),
        })

        expect(doctor).toContain('opencode: partial')
        expect(doctor).toContain('instructions=no')
        expect(doctor).toContain('plugin=yes')
        expect(doctor).toContain('madar opencode install')
        expect(status).toContain('opencode:partial')
      })
    })
  })
})
