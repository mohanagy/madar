import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildDiagnosticReport,
  formatDoctorReport,
  formatStatusReport,
} from '../../src/adapters/cli/doctor.js'
import { executeCli } from '../../src/adapters/cli/main.js'
import {
  canonicalWorkspace,
  installClient,
  uninstallClient,
  workspaceServerName,
  type InstallOptions,
} from '../../src/adapters/cli/install.js'
import { generateIndex } from '../../src/application/generate-index.js'
import { resolveMadarWorkspace } from '../../src/shared/workspace.js'

type JsonObject = Record<string, unknown>

function git(directory: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected object fixture')
  }
  return value as JsonObject
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function linkedEntries(root: string, directory = root): string[] {
  const entries: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === '.git') continue
    const path = join(directory, entry.name)
    const name = relative(root, path).replaceAll('\\', '/')
    const metadata = lstatSync(path)
    if (entry.isDirectory()) {
      entries.push(`d ${name} ${metadata.mode & 0o777}`)
      entries.push(...linkedEntries(root, path))
    } else if (entry.isSymbolicLink()) {
      entries.push(`l ${name} ${metadata.mode & 0o777} ${readlinkSync(path)}`)
    } else {
      entries.push(
        `f ${name} ${metadata.mode & 0o777} ${readFileSync(path).toString('base64')}`,
      )
    }
  }
  return entries.sort()
}

function linkedSnapshot(root: string): {
  entries: readonly string[]
  status: string
} {
  return {
    entries: linkedEntries(root),
    status: git(root, ['status', '--short', '--untracked-files=all']),
  }
}

function claudeRunner(configPath: string): NonNullable<InstallOptions['runClaude']> {
  return (args, cwd) => {
    const config = existsSync(configPath) ? readJson(configPath) : { projects: {} }
    const projects = object(config.projects ??= {})
    const project = object(projects[cwd] ??= { mcpServers: {} })
    const servers = object(project.mcpServers ??= {})
    const serverName = args[4]
    if (typeof serverName !== 'string') throw new Error('Missing server fixture name')
    if (args[1] === 'add') {
      servers[serverName] = {
        type: 'stdio',
        command: 'madar',
        args: ['mcp'],
        env: {},
      }
    } else if (args[1] === 'remove') {
      delete servers[serverName]
    } else {
      throw new Error(`Unexpected Claude fixture command: ${args.join(' ')}`)
    }
    writeJson(configPath, config)
  }
}

describe('linked-worktree thin-delivery surface', () => {
  it('uses linked-worktree identity, an external graph, and external-only client wiring', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'madar-thin-worktree-'))
    const primary = join(sandbox, 'primary')
    const linked = join(sandbox, 'linked')
    try {
      execFileSync('git', ['init', primary], { stdio: 'pipe' })
      git(primary, ['config', 'user.email', 'madar-tests@example.com'])
      git(primary, ['config', 'user.name', 'Madar Tests'])
      writeFileSync(join(primary, 'main.ts'), 'export const value = 1\n', 'utf8')
      git(primary, ['add', '.'])
      git(primary, ['commit', '-m', 'initial'])
      git(primary, ['worktree', 'add', '-b', 'feature/thin-delivery', linked])

      const workspace = resolveMadarWorkspace(linked)
      expect(workspace.isLinkedWorktree).toBe(true)
      expect(workspace.graphPath.startsWith(linked)).toBe(false)
      expect(workspace.artifactRoot.startsWith(workspace.gitCommonDir!)).toBe(true)

      const generated = generateIndex(linked)
      expect(generated.graphPath).toBe(workspace.graphPath)
      expect(existsSync(workspace.graphPath)).toBe(true)
      expect(existsSync(join(linked, 'out'))).toBe(false)
      const statusLines: string[] = []
      expect(await executeCli(['status'], {
        log: (message = '') => statusLines.push(message),
        error: () => {},
        write: () => {},
      }, {
        version: () => 'test',
        cwd: linked,
      })).toBe(0)
      expect(statusLines).toEqual([
        expect.stringContaining('graph=ready'),
      ])
      const beforeInstall = linkedSnapshot(linked)
      expect(beforeInstall.status).toBe('')

      const homeDir = join(sandbox, 'home')
      const codexHome = join(homeDir, '.codex')
      const claudeConfig = join(homeDir, '.claude.json')
      const install: InstallOptions = {
        homeDir,
        codexHome,
        runClaude: claudeRunner(claudeConfig),
      }
      const canonical = canonicalWorkspace(linked)
      const serverName = workspaceServerName(linked)

      expect(installClient('claude', linked, install).action).toBe('installed')
      expect(installClient('codex', linked, install).action).toBe('installed')
      expect(linkedSnapshot(linked)).toEqual(beforeInstall)
      expect(installClient('claude', linked, install).action)
        .toBe('already-installed')
      expect(installClient('codex', linked, install).action)
        .toBe('already-installed')
      expect(linkedSnapshot(linked)).toEqual(beforeInstall)

      const claude = readJson(claudeConfig)
      expect(claude).toMatchObject({
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
      const codex = readFileSync(join(codexHome, 'config.toml'), 'utf8')
      expect(codex).toContain(`[mcp_servers.${serverName}]`)
      expect(codex).toContain('args = ["mcp"]')
      expect(codex).toContain(`cwd = ${JSON.stringify(canonical)}`)
      expect(codex).not.toContain('args = ["serve"')

      const report = buildDiagnosticReport({
        projectDir: linked,
        install,
      })
      expect(report).toMatchObject({
        workspace: workspace.rootPath,
        linkedWorktree: true,
        graph: {
          path: workspace.graphPath,
          state: 'ready',
          buildId: generated.buildId,
        },
        healthy: true,
      })
      expect(report.clients.map((client) => [client.client, client.status]))
        .toEqual([['claude', 'exact'], ['codex', 'exact']])
      expect(formatStatusReport(report)).toContain(
        'graph=ready claude=exact codex=exact',
      )
      expect(formatDoctorReport(report)).toContain('- linked worktree: yes')

      expect(uninstallClient('claude', linked, install).action).toBe('removed')
      expect(uninstallClient('codex', linked, install).action).toBe('removed')
      expect(linkedSnapshot(linked)).toEqual(beforeInstall)
      expect(existsSync(join(linked, 'out'))).toBe(false)
      expect(existsSync(workspace.graphPath)).toBe(true)
    } finally {
      if (existsSync(primary) && existsSync(linked)) {
        try {
          git(primary, ['worktree', 'remove', '--force', linked])
        } catch {
          // The recursive sandbox cleanup handles partial Git teardown.
        }
      }
      rmSync(sandbox, { recursive: true, force: true })
    }
  }, 30_000)
})
