import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  CODEX_STARTUP_TIMEOUT_SECONDS,
  CODEX_TOOL_TIMEOUT_SECONDS,
  canonicalWorkspace,
  inspectClient,
  installClient,
  resolveClaudeConfigPath,
  resolveCodexConfigPath,
  uninstallClient,
  workspaceServerName,
  type InstallOptions,
} from '../../src/adapters/cli/install.js'

type JsonObject = Record<string, unknown>

interface ClaudeCall {
  args: readonly string[]
  cwd: string
}

interface RepositorySnapshot {
  entries: readonly string[]
  status: string
}

function makeSandbox(prefix = 'madar-thin-install-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function removeSandbox(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected object fixture')
  }
  return value as JsonObject
}

function git(directory: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function createRepository(root: string): void {
  mkdirSync(root, { recursive: true })
  git(root, ['init'])
  git(root, ['config', 'user.email', 'madar-tests@example.com'])
  git(root, ['config', 'user.name', 'Madar Tests'])
  writeFileSync(join(root, 'main.ts'), 'export const value = 1\n', 'utf8')
  if (process.platform !== 'win32') chmodSync(join(root, 'main.ts'), 0o640)
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'fixture'])
}

function repositoryEntries(root: string, directory = root): string[] {
  const entries: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === '.git') continue
    const path = join(directory, entry.name)
    const name = relative(root, path).replaceAll('\\', '/')
    const metadata = lstatSync(path)
    if (entry.isDirectory()) {
      entries.push(`d ${name} ${metadata.mode & 0o777}`)
      entries.push(...repositoryEntries(root, path))
    } else if (entry.isSymbolicLink()) {
      entries.push(`l ${name} ${metadata.mode & 0o777} ${readlinkSync(path)}`)
    } else {
      const bytes = readFileSync(path).toString('base64')
      entries.push(`f ${name} ${metadata.mode & 0o777} ${bytes}`)
    }
  }
  return entries.sort()
}

function repositorySnapshot(root: string): RepositorySnapshot {
  return {
    entries: repositoryEntries(root),
    status: git(root, ['status', '--short', '--untracked-files=all']),
  }
}

function claudeRunner(
  configPath: string,
  calls: ClaudeCall[],
  afterMutation?: (operation: 'add' | 'remove') => void,
): NonNullable<InstallOptions['runClaude']> {
  return (args, cwd) => {
    calls.push({ args: [...args], cwd })
    const config = existsSync(configPath)
      ? readJson(configPath)
      : { theme: 'dark', projects: {} }
    const projects = object(config.projects ??= {})
    const project = object(projects[cwd] ??= { permissions: { allow: [] }, mcpServers: {} })
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
      writeJson(configPath, config)
      afterMutation?.('add')
      return
    }
    if (args[1] === 'remove') {
      delete servers[serverName]
      writeJson(configPath, config)
      afterMutation?.('remove')
      return
    }
    throw new Error(`Unexpected Claude fixture command: ${args.join(' ')}`)
  }
}

function expectedServerName(workspace: string): string {
  return `madar_${createHash('sha256')
    .update(canonicalWorkspace(workspace))
    .digest('hex')
    .slice(0, 12)}`
}

function managedMarker(serverName: string, edge: 'start' | 'end'): string {
  return edge === 'start'
    ? `# >>> madar managed mcp: ${serverName} >>>`
    : `# <<< madar managed mcp: ${serverName} <<<`
}

function expectExactCodexBlock(content: string, workspace: string): void {
  const serverName = workspaceServerName(workspace)
  expect(content).toContain(managedMarker(serverName, 'start'))
  expect(content).toContain(`[mcp_servers.${serverName}]`)
  expect(content).toContain('command = "madar"')
  expect(content).toContain('args = ["mcp"]')
  expect(content).toContain(`cwd = ${JSON.stringify(canonicalWorkspace(workspace))}`)
  expect(content).toContain(`startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SECONDS}`)
  expect(content).toContain(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`)
  expect(content).toContain(managedMarker(serverName, 'end'))
  expect(content).not.toContain('args = ["serve"')
  expect(content).not.toContain('auto-refresh')
}

const LEGACY_CLAUDE_SECTION = `## madar

This project has a Madar knowledge graph.

1. For a repository question, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search.
2. Use returned authenticated excerpts and relationships when \`outcome\` is \`evidence\`.
3. When retrieval returns a boundary instead of evidence, state it and use only focused verification needed to continue.
4. Skip Madar for tasks that do not require local repository context.
`

const LEGACY_CODEX_SECTION = `## madar

### Codex CLI integration

For repository questions, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search. Use authenticated evidence when available and report explicit boundaries otherwise.
`

const LEGACY_ROUTING_GUIDE = 'This project has a Madar knowledge graph. For a repository question, call the Madar retrieve tool exactly once with the user question unchanged before broad file search. Use authenticated evidence when it is returned; otherwise report the explicit boundary and continue with only focused verification.'
const LEGACY_HOME_SECTION = '# madar\n- **madar** (`~/.claude/skills/madar/SKILL.md`) - any input to knowledge graph. Trigger: `/madar`\nWhen the user types `/madar`, invoke the Skill tool with `skill: "madar"` before doing anything else.\n'
const LEGACY_SKILL = `---
name: madar
description: query authenticated JavaScript and TypeScript repository evidence
trigger: /madar
---

# /madar

Madar builds a canonical JavaScript/TypeScript graph and exposes one retrieval operation.

## Workflow

1. Run \`madar status\`.
2. If the canonical index is missing, unavailable, or corrupt, run \`madar generate .\`.
3. For a repository question, call the Madar \`retrieve\` MCP tool exactly once with the user's question unchanged. If MCP is unavailable, run \`madar query "<question>"\`.
4. When \`outcome\` is \`evidence\`, answer from the authenticated excerpts and stored relationships.
5. Otherwise report the explicit boundary and perform only the focused verification needed to continue.
6. For code changes, verify edits with normal tests; graph evidence does not replace runtime verification.

\`\`\`bash
madar status
madar generate .
madar query "where is authentication implemented?"
\`\`\`

## Safety

Enable project hooks and local MCP servers only in repositories you trust. Never invent nodes, relationships, paths, or coverage claims.
`
const LEGACY_WINDOWS_SKILL = LEGACY_SKILL.replace('```bash', '```powershell')

function legacyPromptScript(client: 'Claude' | 'Codex'): string {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: LEGACY_ROUTING_GUIDE,
    },
  })
  return `// madar managed ${client} UserPromptSubmit hook\n'use strict'\nprocess.stdout.write(${JSON.stringify(payload)})\n`
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  if (code !== 0) {
    throw new Error(`Installer child exited with code ${code} and signal ${signal ?? 'none'}`)
  }
}

describe('thin-delivery client installer', () => {
  it.each(['claude', 'codex'] as const)(
    'keeps every repository byte, mode, and Git status unchanged across fresh %s lifecycle',
    (client) => {
      const sandbox = makeSandbox()
      try {
        const workspace = join(sandbox, 'workspace')
        const homeDir = join(sandbox, 'home')
        const codexHome = join(homeDir, '.codex')
        const claudePath = join(homeDir, '.claude.json')
        const calls: ClaudeCall[] = []
        createRepository(workspace)
        const options: InstallOptions = {
          homeDir,
          codexHome,
          runClaude: claudeRunner(claudePath, calls),
        }
        const initial = repositorySnapshot(workspace)

        const installed = installClient(client, workspace, options)
        expect(installed.action).toBe('installed')
        expect(installed.repositoryChanges).toEqual([])
        expect(installed.repositoryWarnings).toEqual([])
        expect(repositorySnapshot(workspace)).toEqual(initial)

        const reinstalled = installClient(client, workspace, options)
        expect(reinstalled.action).toBe('already-installed')
        expect(repositorySnapshot(workspace)).toEqual(initial)

        const removed = uninstallClient(client, workspace, options)
        expect(removed.action).toBe('removed')
        expect(repositorySnapshot(workspace)).toEqual(initial)

        const removedAgain = uninstallClient(client, workspace, options)
        expect(removedAgain.action).toBe('not-installed')
        expect(repositorySnapshot(workspace)).toEqual(initial)
      } finally {
        removeSandbox(sandbox)
      }
    },
  )

  it('uses Claude Code local scope with exact argv/cwd and accepts only its realistic external registration', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const homeDir = join(sandbox, 'home')
      const configPath = resolveClaudeConfigPath({ homeDir })
      const calls: ClaudeCall[] = []
      createRepository(workspace)

      const receipt = installClient('claude', workspace, {
        homeDir,
        runClaude: claudeRunner(configPath, calls),
      })

      const canonical = canonicalWorkspace(workspace)
      const serverName = workspaceServerName(workspace)
      expect(calls).toEqual([{
        args: ['mcp', 'add', '--scope', 'local', serverName, '--', 'madar', 'mcp'],
        cwd: canonical,
      }])
      expect(receipt.wiring).toMatchObject({
        status: 'exact',
        workspace: canonical,
        configPath,
        serverName,
      })
      expect(readJson(configPath)).toMatchObject({
        theme: 'dark',
        projects: {
          [canonical]: {
            permissions: { allow: [] },
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

      uninstallClient('claude', workspace, {
        homeDir,
        runClaude: claudeRunner(configPath, calls),
      })
      expect(calls[1]).toEqual({
        args: ['mcp', 'remove', '--scope', 'local', serverName],
        cwd: canonical,
      })
      expect(inspectClient('claude', workspace, { homeDir }).status).toBe('missing')
    } finally {
      removeSandbox(sandbox)
    }
  })

  it('hashes canonical workspace ownership and resolves an external Claude add/remove race safely', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const other = join(sandbox, 'other')
      const homeDir = join(sandbox, 'home')
      const configPath = resolveClaudeConfigPath({ homeDir })
      createRepository(workspace)
      createRepository(other)

      expect(workspaceServerName(workspace)).toBe(expectedServerName(workspace))
      expect(workspaceServerName(workspace)).toMatch(/^madar_[0-9a-f]{12}$/)
      expect(workspaceServerName(other)).not.toBe(workspaceServerName(workspace))

      const calls: ClaudeCall[] = []
      const racingRunner = claudeRunner(configPath, calls, (operation) => {
        throw new Error(`simulated ${operation} race`)
      })
      expect(installClient('claude', workspace, {
        homeDir,
        runClaude: racingRunner,
      }).action).toBe('already-installed')
      expect(inspectClient('claude', workspace, { homeDir }).status).toBe('exact')
      expect(uninstallClient('claude', workspace, {
        homeDir,
        runClaude: racingRunner,
      }).action).toBe('removed')

      const serverName = workspaceServerName(workspace)
      writeJson(configPath, {
        projects: {
          [canonicalWorkspace(workspace)]: {
            mcpServers: {
              [serverName]: { command: 'user-server', args: [] },
            },
          },
        },
      })
      const before = readFileSync(configPath)
      expect(() => installClient('claude', workspace, {
        homeDir,
        runClaude: claudeRunner(configPath, calls),
      })).toThrow('workspace server name is not Madar-owned')
      expect(readFileSync(configPath)).toEqual(before)
    } finally {
      removeSandbox(sandbox)
    }
  })

  it('preserves CRLF, no-final-newline TOML, comments, fake multiline markers, and permissions', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const codexHome = join(sandbox, 'codex-home')
      const configPath = resolveCodexConfigPath({ codexHome })
      createRepository(workspace)
      mkdirSync(dirname(configPath), { recursive: true })
      const fake = workspaceServerName(workspace)
      const original = [
        '# user comment',
        'model = "gpt-test"',
        'notes = """',
        managedMarker(fake, 'start'),
        managedMarker(fake, 'end'),
        '"""',
        'approval_policy = "never"',
      ].join('\r\n')
      writeFileSync(configPath, original, 'utf8')
      if (process.platform !== 'win32') chmodSync(configPath, 0o640)
      const originalMode = statSync(configPath).mode & 0o777
      const originalInode = statSync(configPath).ino

      const installed = installClient('codex', workspace, { codexHome })
      const content = readFileSync(configPath, 'utf8')
      expect(installed.action).toBe('installed')
      expect(content.startsWith(`${original}\r\n`)).toBe(true)
      expect(content.replaceAll('\r\n', '')).not.toContain('\n')
      expectExactCodexBlock(content, workspace)
      expect(statSync(configPath).mode & 0o777).toBe(originalMode)
      expect(statSync(configPath).ino).toBe(originalInode)

      expect(uninstallClient('codex', workspace, { codexHome }).action).toBe('removed')
      expect(readFileSync(configPath, 'utf8')).toBe(original)
      expect(statSync(configPath).mode & 0o777).toBe(originalMode)
      expect(statSync(configPath).ino).toBe(originalInode)
    } finally {
      removeSandbox(sandbox)
    }
  })

  it('refuses to extend a user-owned root inline mcp_servers table', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const codexHome = join(sandbox, 'codex-home')
      const configPath = resolveCodexConfigPath({ codexHome })
      createRepository(workspace)
      mkdirSync(dirname(configPath), { recursive: true })
      const original = 'mcp_servers = { other = { command = "other" } }\n'
      writeFileSync(configPath, original, 'utf8')

      expect(() => installClient('codex', workspace, { codexHome }))
        .toThrow(`Refusing to replace user-managed Codex server ${workspaceServerName(workspace)}`)
      expect(readFileSync(configPath, 'utf8')).toBe(original)
      expect(inspectClient('codex', workspace, { codexHome }).status).toBe('conflict')
    } finally {
      removeSandbox(sandbox)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'resolves symlinked client roots before enforcing repository isolation',
    () => {
      const sandbox = makeSandbox()
      try {
        const workspace = join(sandbox, 'workspace')
        const target = join(workspace, 'user-config')
        const linkedRoot = join(sandbox, 'linked-config')
        createRepository(workspace)
        mkdirSync(target)
        symlinkSync(target, linkedRoot, 'dir')

        expect(() => installClient('codex', workspace, {
          codexHome: linkedRoot,
        })).toThrow('Refusing to write client configuration inside the workspace')
        expect(() => installClient('claude', workspace, {
          claudeConfigDir: linkedRoot,
          runClaude: () => {
            throw new Error('Claude runner must not run')
          },
        })).toThrow('Refusing to write client configuration inside the workspace')
        expect(existsSync(join(target, 'config.toml'))).toBe(false)
        expect(existsSync(join(target, '.claude.json'))).toBe(false)
      } finally {
        removeSandbox(sandbox)
      }
    },
  )

  it('keeps two Codex workspaces independent and refuses user-owned or drifted blocks byte-for-byte', () => {
    const sandbox = makeSandbox()
    try {
      const first = join(sandbox, 'first')
      const second = join(sandbox, 'second')
      const codexHome = join(sandbox, 'codex-home')
      const configPath = resolveCodexConfigPath({ codexHome })
      createRepository(first)
      createRepository(second)

      installClient('codex', first, { codexHome })
      installClient('codex', second, { codexHome })
      expect(installClient('codex', first, { codexHome }).action)
        .toBe('already-installed')
      let content = readFileSync(configPath, 'utf8')
      expectExactCodexBlock(content, first)
      expectExactCodexBlock(content, second)
      expect(existsSync(`${configPath}.madar.lock`)).toBe(false)

      const firstName = workspaceServerName(first)
      content = content.replace(
        `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
        `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS + 1}`,
      )
      writeFileSync(configPath, content, 'utf8')
      const drifted = readFileSync(configPath)
      expect(inspectClient('codex', first, { codexHome }).status).toBe('stale')
      expect(() => installClient('codex', first, { codexHome }))
        .toThrow(`Refusing to replace modified Codex block for ${firstName}`)
      expect(() => uninstallClient('codex', first, { codexHome }))
        .toThrow(`Refusing to remove modified Codex block for ${firstName}`)
      expect(readFileSync(configPath)).toEqual(drifted)
      expect(inspectClient('codex', second, { codexHome }).status).toBe('exact')
      expect(existsSync(`${configPath}.madar.lock`)).toBe(false)

      const conflictHome = join(sandbox, 'conflict-home')
      const conflictPath = resolveCodexConfigPath({ codexHome: conflictHome })
      mkdirSync(dirname(conflictPath), { recursive: true })
      const userConfig = `[mcp_servers.${firstName}]\ncommand = "user-server"\n`
      writeFileSync(conflictPath, userConfig, 'utf8')
      expect(() => installClient('codex', first, { codexHome: conflictHome }))
        .toThrow(`Refusing to replace user-managed Codex server ${firstName}`)
      expect(readFileSync(conflictPath, 'utf8')).toBe(userConfig)
    } finally {
      removeSandbox(sandbox)
    }
  })

  it('serializes genuinely concurrent Codex install and uninstall requests without lock leakage', async () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const codexHome = join(sandbox, 'codex-home')
      const configPath = resolveCodexConfigPath({ codexHome })
      createRepository(workspace)

      const sourcePath = resolve('src/adapters/cli/install.ts')
      const compiledPath = join(sandbox, 'install.mjs')
      const transpiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: sourcePath,
      }).outputText
      writeFileSync(compiledPath, transpiled, 'utf8')
      const moduleUrl = pathToFileURL(compiledPath).href
      const run = (operation: 'installClient' | 'uninstallClient') => spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { ${operation} } from ${JSON.stringify(moduleUrl)}; ${operation}('codex', process.argv[1], { codexHome: process.argv[2] })`,
          workspace,
          codexHome,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      )

      await Promise.all(Array.from({ length: 4 }, () => waitForChild(run('installClient'))))
      expect(inspectClient('codex', workspace, { codexHome }).status).toBe('exact')
      expectExactCodexBlock(readFileSync(configPath, 'utf8'), workspace)
      expect(existsSync(`${configPath}.madar.lock`)).toBe(false)

      await Promise.all(Array.from({ length: 4 }, () => waitForChild(run('uninstallClient'))))
      expect(inspectClient('codex', workspace, { codexHome }).status).toBe('missing')
      expect(readFileSync(configPath, 'utf8')).toBe('')
      expect(existsSync(`${configPath}.madar.lock`)).toBe(false)
    } finally {
      removeSandbox(sandbox)
    }
  }, 20_000)

  it('enumerates exact legacy migration and leaves modified legacy artifacts untouched', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const codexHome = join(sandbox, 'codex-home')
      createRepository(workspace)
      writeFileSync(
        join(workspace, 'CLAUDE.md'),
        `# User Claude\n\n${LEGACY_CLAUDE_SECTION}\n## madar\n\nmodified guidance\n`,
      )
      writeFileSync(
        join(workspace, 'AGENTS.md'),
        `# User Agents\n\n${LEGACY_CODEX_SECTION}`,
      )
      mkdirSync(join(workspace, '.claude'), { recursive: true })
      mkdirSync(join(workspace, '.codex'), { recursive: true })
      writeFileSync(
        join(workspace, '.claude', 'madar-user-prompt-submit.cjs'),
        legacyPromptScript('Claude'),
        { encoding: 'utf8', flag: 'w' },
      )
      const modifiedCodexScript = `${legacyPromptScript('Codex')}// user edit\n`
      writeFileSync(
        join(workspace, '.codex', 'madar-user-prompt-submit.cjs'),
        modifiedCodexScript,
        { encoding: 'utf8', flag: 'w' },
      )
      writeJson(join(workspace, '.mcp.json'), {
        user: true,
        mcpServers: {
          other: { command: 'other' },
          madar: {
            command: 'madar',
            args: ['serve', '--stdio', '--auto-refresh'],
            env: {},
          },
        },
      })
      const exactHook = {
        hooks: [{
          type: 'command',
          command: 'node .claude/madar-user-prompt-submit.cjs',
        }],
        name: 'madar',
        source: 'madar',
      }
      const modifiedHook = {
        source: 'madar',
        hooks: [{ type: 'command', command: 'node user-owned.cjs' }],
      }
      writeJson(join(workspace, '.claude', 'settings.json'), {
        theme: 'dark',
        hooks: { UserPromptSubmit: [exactHook, { source: 'user', hooks: [] }] },
      })
      writeJson(join(workspace, '.codex', 'hooks.json'), {
        hooks: { UserPromptSubmit: [exactHook, modifiedHook] },
      })
      writeFileSync(join(workspace, '.codex', 'config.toml'), [
        '# >>> madar managed mcp >>>',
        '[mcp_servers.madar]',
        'command = "madar"',
        'args = ["serve", "--stdio", "--auto-refresh"]',
        `cwd = ${JSON.stringify(canonicalWorkspace(workspace))}`,
        'enabled = true',
        `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SECONDS}`,
        `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
        '# <<< madar managed mcp <<<',
        '',
      ].join('\n'))
      const gitHook = execFileSync(
        'git',
        ['rev-parse', '--git-path', 'hooks/post-commit'],
        { cwd: workspace, encoding: 'utf8' },
      ).trim()
      const modifiedGitHook = '#!/bin/sh\n# madar-hook-start\n# Installed by madar\nmadar update .\n# madar-hook-end\necho user\n'
      writeFileSync(resolve(workspace, gitHook), modifiedGitHook)

      const receipt = installClient('codex', workspace, { codexHome })

      expect(receipt.repositoryChanges).toEqual([
        'CLAUDE.md: removed exact generated Madar section',
        'AGENTS.md: removed exact generated Madar section',
        '.claude/madar-user-prompt-submit.cjs: removed exact generated file',
        '.mcp.json: removed exact legacy Madar entries',
        '.claude/settings.json: removed exact legacy Madar entries',
        '.codex/hooks.json: removed exact legacy Madar entries',
        '.codex/config.toml: removed exact obsolete project-local block',
      ])
      expect(receipt.repositoryWarnings).toEqual([
        '.codex/madar-user-prompt-submit.cjs: modified legacy file left unchanged',
        '.codex/hooks.json: modified legacy Madar hook left unchanged',
        '.git/hooks/post-commit: modified legacy span left unchanged',
      ])
      expect(readFileSync(join(workspace, 'CLAUDE.md'), 'utf8')).toContain(
        '## madar\n\nmodified guidance',
      )
      expect(readFileSync(
        join(workspace, '.codex', 'madar-user-prompt-submit.cjs'),
        'utf8',
      )).toBe(modifiedCodexScript)
      expect(readJson(join(workspace, '.mcp.json'))).toEqual({
        user: true,
        mcpServers: { other: { command: 'other' } },
      })
      expect(object(readJson(join(workspace, '.codex', 'hooks.json')).hooks)
        .UserPromptSubmit).toEqual([modifiedHook])
      expect(existsSync(join(workspace, '.codex', 'config.toml'))).toBe(false)
      expect(readFileSync(resolve(workspace, gitHook), 'utf8')).toBe(modifiedGitHook)
    } finally {
      removeSandbox(sandbox)
    }
  })

  it('removes only exact legacy JSON ranges and preserves every surrounding byte', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const codexHome = join(sandbox, 'codex-home')
      createRepository(workspace)
      const exactFragment = '\r\n\t\t"madar" : {"command":"madar","args":["serve","--stdio","--auto-refresh"],"env":{}},'
      const original = `{\r\n\t"mcpServers": {${exactFragment}\r\n\t\t"other": {"command":"other"}\r\n\t},\r\n\t"user": "keep\\\\u0020bytes"\r\n}\r\n`
      writeFileSync(join(workspace, '.mcp.json'), original, 'utf8')
      mkdirSync(join(workspace, '.claude'), { recursive: true })
      const modified = '{"mcpServers":{"madar":{"command":"madar","args":["serve","--stdio","--auto-refresh"],"env":{"USER_OWNED_TOKEN":"keep-me"}}}}\n'
      writeFileSync(join(workspace, '.claude', 'settings.json'), modified, 'utf8')

      const receipt = installClient('codex', workspace, { codexHome })

      expect(readFileSync(join(workspace, '.mcp.json'), 'utf8'))
        .toBe(original.replace(exactFragment, ''))
      expect(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'))
        .toBe(modified)
      expect(receipt.repositoryChanges).toContain(
        '.mcp.json: removed exact legacy Madar entries',
      )
      expect(receipt.repositoryWarnings).toContain(
        '.claude/settings.json: modified legacy Madar MCP entry left unchanged',
      )
    } finally {
      removeSandbox(sandbox)
    }
  })

  it('preserves ambiguous duplicate-key legacy JSON byte-for-byte', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const homeDir = join(sandbox, 'home')
      createRepository(workspace)
      const mcp = '{"mcpServers":{"madar":{"command":"madar","args":["serve","--stdio","--auto-refresh"],"env":{"USER_TOKEN":"keep"},"env":{}}}}\n'
      const hook = '{"hooks":{"UserPromptSubmit":[{"name":"user-owned","name":"madar","source":"madar","hooks":[{"type":"command","command":"node .claude/madar-user-prompt-submit.cjs"}]}]}}\n'
      writeFileSync(join(workspace, '.mcp.json'), mcp, 'utf8')
      mkdirSync(join(workspace, '.claude'))
      writeFileSync(join(workspace, '.claude', 'settings.json'), hook, 'utf8')

      const receipt = installClient('codex', workspace, { homeDir })

      expect(readFileSync(join(workspace, '.mcp.json'), 'utf8')).toBe(mcp)
      expect(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'))
        .toBe(hook)
      expect(receipt.repositoryWarnings).toEqual(expect.arrayContaining([
        '.mcp.json: ambiguous legacy Madar MCP entry left unchanged',
        '.claude/settings.json: ambiguous legacy Madar hook left unchanged',
      ]))
    } finally {
      removeSandbox(sandbox)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'does not follow repository migration directories outside the workspace',
    () => {
      const sandbox = makeSandbox()
      try {
        const workspace = join(sandbox, 'workspace')
        const external = join(sandbox, 'shared-claude')
        const homeDir = join(sandbox, 'home')
        createRepository(workspace)
        mkdirSync(external)
        const settings = '{"mcpServers":{"madar":{"command":"madar","args":["serve","--stdio","--auto-refresh"]}}}\n'
        writeFileSync(join(external, 'settings.json'), settings, 'utf8')
        symlinkSync(external, join(workspace, '.claude'), 'dir')

        const receipt = installClient('codex', workspace, { homeDir })

        expect(readFileSync(join(external, 'settings.json'), 'utf8')).toBe(settings)
        expect(receipt.repositoryChanges).not.toContain(
          '.claude/settings.json: removed exact legacy Madar entries',
        )
      } finally {
        removeSandbox(sandbox)
      }
    },
  )

  it('removes exact predecessor home skills and routing while preserving edits', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const homeDir = join(sandbox, 'home')
      const claudeSkill = join(homeDir, '.claude', 'skills', 'madar')
      const codexSkill = join(homeDir, '.agents', 'skills', 'madar')
      createRepository(workspace)
      mkdirSync(claudeSkill, { recursive: true })
      mkdirSync(codexSkill, { recursive: true })
      writeFileSync(join(claudeSkill, 'SKILL.md'), LEGACY_WINDOWS_SKILL, 'utf8')
      writeFileSync(join(claudeSkill, '.madar_version'), '0.32.0', 'utf8')
      writeFileSync(join(codexSkill, 'SKILL.md'), `${LEGACY_SKILL}\nuser edit\n`, 'utf8')
      writeFileSync(
        join(homeDir, '.claude', 'CLAUDE.md'),
        `# User instructions\n\n${LEGACY_HOME_SECTION}`,
        'utf8',
      )

      const receipt = installClient('codex', workspace, { homeDir })

      expect(existsSync(join(claudeSkill, 'SKILL.md'))).toBe(false)
      expect(existsSync(join(claudeSkill, '.madar_version'))).toBe(false)
      expect(readFileSync(join(codexSkill, 'SKILL.md'), 'utf8'))
        .toBe(`${LEGACY_SKILL}\nuser edit\n`)
      expect(readFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'utf8'))
        .toBe('# User instructions\n')
      expect(receipt.repositoryChanges).toContain(
        '~/.claude/skills/madar/SKILL.md: removed exact generated skill',
      )
      expect(receipt.repositoryWarnings).toContain(
        '~/.agents/skills/madar/SKILL.md: modified legacy skill left unchanged',
      )
    } finally {
      removeSandbox(sandbox)
    }
  })

  it('removes only the exact historical Git hook span without normalizing user bytes', () => {
    const sandbox = makeSandbox()
    try {
      const workspace = join(sandbox, 'workspace')
      const codexHome = join(sandbox, 'codex-home')
      createRepository(workspace)
      const hookPath = resolve(workspace, git(
        workspace,
        ['rev-parse', '--git-path', 'hooks/post-commit'],
      ).trim())
      const span = '# madar-hook-start\n# Installed by madar\nCHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null)\nif [ -n "$CHANGED" ]; then\n  echo "[madar] Changes detected - rebuild the out bundle if needed."\nfi\n# madar-hook-end\n'
      const original = `#!/bin/bash\n# user before\n\n${span}# user after\n`
      writeFileSync(hookPath, original, 'utf8')

      const receipt = installClient('codex', workspace, { codexHome })

      expect(readFileSync(hookPath, 'utf8')).toBe(original.replace(span, ''))
      expect(receipt.repositoryChanges).toContain(
        '.git/hooks/post-commit: removed exact Madar span',
      )
    } finally {
      removeSandbox(sandbox)
    }
  })
})
