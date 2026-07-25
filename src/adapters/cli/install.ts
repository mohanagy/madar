import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
export const CLIENTS = ['claude', 'codex'] as const
export type Client = (typeof CLIENTS)[number]
export const CODEX_STARTUP_TIMEOUT_SECONDS = 180
export const CODEX_TOOL_TIMEOUT_SECONDS = 60
const LOCK_TIMEOUT_MS = 10_000
const LOCK_RETRY_MS = 25
const DEFAULT_CONFIG_MODE = 0o600
const OWNED_LINE_ENDING = '# madar managed mcp: preceding line ending owned'
const LEGACY_CODEX_PROMPT_COMMAND = `node -e "const fs=require('fs');const path=require('path');let dir=process.cwd();for(;;){const script=path.join(dir,'.codex','madar-user-prompt-submit.cjs');if(fs.existsSync(script)){require(script);break}const parent=path.dirname(dir);if(parent===dir){process.exit(0)}dir=parent}"`
const LEGACY_SKILL_SHA256 = new Set(['5a2cda08bf8adb096759962198b425cf42df88a66d685bc8f9bc98fe7187b68f', 'a15408f43db4a2cdf93428a66b34de34d46b36652a8f5fd77c26e5f2d3068428'])
const LEGACY_HOME_SECTION = '# madar\n- **madar** (`~/.claude/skills/madar/SKILL.md`) - any input to knowledge graph. Trigger: `/madar`\nWhen the user types `/madar`, invoke the Skill tool with `skill: "madar"` before doing anything else.\n'
const LEGACY_GIT_HOOKS = {
  'post-commit': '# madar-hook-start\n# Installed by madar\nCHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null)\nif [ -n "$CHANGED" ]; then\n  echo "[madar] Changes detected - rebuild the out bundle if needed."\nfi\n# madar-hook-end\n',
  'post-checkout': '# madar-checkout-hook-start\n# Installed by madar\necho "[madar] Branch switched - rebuild the out bundle if needed."\n# madar-checkout-hook-end\n',
} as const
export interface InstallOptions {
  homeDir?: string
  claudeConfigDir?: string
  codexHome?: string
  runClaude?: (args: readonly string[], cwd: string) => void
}
export interface WiringInspection {
  client: Client
  status: 'exact' | 'missing' | 'conflict' | 'stale'
  workspace: string
  configPath: string
  serverName: string
  detail: string
}
export interface InstallReceipt {
  client: Client
  action: 'installed' | 'already-installed' | 'removed' | 'not-installed'
  wiring: WiringInspection
  repositoryChanges: readonly string[]
  repositoryWarnings: readonly string[]
}
interface TextRange { start: number; end: number }
interface ManagedBlock extends TextRange {
  content: string
  ownsPrecedingLineEnding: boolean
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
export function canonicalWorkspace(path = '.'): string {
  const resolved = resolve(path)
  try { return realpathSync.native(resolved) } catch { return resolved }
}
export function workspaceServerName(path = '.'): string {
  return `madar_${createHash('sha256')
    .update(canonicalWorkspace(path))
    .digest('hex')
    .slice(0, 12)}`
}
export function resolveClaudeConfigPath(options: InstallOptions = {}): string {
  const root = options.claudeConfigDir
    ?? process.env.CLAUDE_CONFIG_DIR?.trim()
    ?? options.homeDir
    ?? homedir()
  return join(resolve(root), '.claude.json')
}
export function resolveCodexConfigPath(options: InstallOptions = {}): string {
  const root = options.codexHome
    ?? process.env.CODEX_HOME?.trim()
    ?? join(options.homeDir ?? homedir(), '.codex')
  return join(resolve(root), 'config.toml')
}
function resolvedTarget(path: string): string {
  const unresolved: string[] = []
  let ancestor = resolve(path)
  for (;;) {
    try {
      lstatSync(ancestor)
      break
    } catch {}
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    unresolved.unshift(basename(ancestor))
    ancestor = parent
  }
  try {
    return resolve(realpathSync.native(ancestor), ...unresolved)
  } catch {
    throw new Error(`Refusing to use an unresolved path: ${path}`)
  }
}
function assertExternal(configPath: string, workspace: string): void {
  const target = resolvedTarget(configPath)
  const path = relative(canonicalWorkspace(workspace), target)
  if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) {
    throw new Error(`Refusing to write client configuration inside the workspace: ${configPath}`)
  }
}
function workspaceFile(workspace: string, relativePath: string): string | null {
  const path = join(workspace, relativePath)
  let target: string
  try { target = resolvedTarget(path) } catch { return null }
  const location = relative(canonicalWorkspace(workspace), target)
  return (location === '' || (!location.startsWith('..') && !isAbsolute(location)))
    && existsSync(target) && lstatSync(target).isFile() ? target : null
}
function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}
function withFileLock<T>(target: string, action: () => T): T {
  const lockPath = `${target}.madar.lock`
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const started = Date.now()
  for (;;) {
    let descriptor: number | null = null
    try { descriptor = openSync(lockPath, 'wx', DEFAULT_CONFIG_MODE) } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error
    }
    if (descriptor !== null) {
      try { return action() } finally {
        try { closeSync(descriptor) } finally { rmSync(lockPath, { force: true }) }
      }
    }
    if (Date.now() - started >= LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for client configuration lock: ${lockPath}`)
    }
    pause(LOCK_RETRY_MS)
  }
}
function writePreservingMetadata(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path)) {
    const descriptor = openSync(path, 'r+')
    try {
      ftruncateSync(descriptor, 0)
      writeFileSync(descriptor, content, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    return
  }
  const mode = DEFAULT_CONFIG_MODE
  const temporary = join(
    dirname(path),
    `.${basename(path)}.madar-${process.pid}-${randomUUID()}.tmp`,
  )
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', mode)
    writeFileSync(descriptor, content, 'utf8')
    chmodSync(temporary, mode)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporary, path)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
    rmSync(temporary, { force: true })
  }
}
function readJsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const object = record(parsed)
  if (!object) throw new Error(`Expected a JSON object in ${path}`)
  return object
}
function exactClaudeEntry(value: unknown): boolean {
  const entry = record(value)
  return Boolean(entry
    && entry.type === 'stdio'
    && entry.command === 'madar'
    && Array.isArray(entry.args)
    && entry.args.length === 1
    && entry.args[0] === 'mcp'
    && record(entry.env)
    && Object.keys(entry.env as Record<string, unknown>).length === 0
    && Object.keys(entry).every((key) =>
      key === 'type' || key === 'command' || key === 'args' || key === 'env'))
}
function inspectClaude(
  workspace: string,
  options: InstallOptions,
): WiringInspection {
  const configPath = resolveClaudeConfigPath(options)
  const serverName = workspaceServerName(workspace)
  const base = { client: 'claude' as const, workspace, configPath, serverName }
  if (!existsSync(configPath)) {
    return { ...base, status: 'missing', detail: 'local registration is absent' }
  }
  try {
    const config = readJsonObject(configPath)
    const project = record(record(config.projects)?.[workspace])
    const servers = record(project?.mcpServers)
    if (!servers || !Object.hasOwn(servers, serverName)) {
      return { ...base, status: 'missing', detail: 'local registration is absent' }
    }
    return exactClaudeEntry(servers[serverName])
      ? { ...base, status: 'exact', detail: 'supported local registration is exact' }
      : { ...base, status: 'conflict', detail: 'workspace server name is not Madar-owned' }
  } catch {
    return { ...base, status: 'stale', detail: 'Claude configuration is not readable JSON' }
  }
}
function lineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n'
}
function multilineTomlRanges(content: string): TextRange[] {
  const ranges: TextRange[] = []
  let mode: 'normal' | 'basic' | 'literal' | 'multi-basic' | 'multi-literal' = 'normal'
  let start = -1
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!
    if (mode === 'normal') {
      if (character === '#') {
        const end = content.indexOf('\n', index)
        if (end < 0) break
        index = end
      } else if (content.startsWith('"""', index)) {
        mode = 'multi-basic'; start = index; index += 2
      } else if (content.startsWith("'''", index)) {
        mode = 'multi-literal'; start = index; index += 2
      } else if (character === '"') mode = 'basic'
      else if (character === "'") mode = 'literal'
      continue
    }
    if (mode === 'basic') {
      if (character === '\\') index += 1
      else if (character === '"' || character === '\n') mode = 'normal'
      continue
    }
    if (mode === 'literal') {
      if (character === "'" || character === '\n') mode = 'normal'
      continue
    }
    const delimiter = mode === 'multi-basic' ? '"""' : "'''"
    if (content.startsWith(delimiter, index)) {
      let escaped = false
      if (mode === 'multi-basic') {
        let slashes = 0
        for (let cursor = index - 1; content[cursor] === '\\'; cursor -= 1) slashes += 1
        escaped = slashes % 2 === 1
      }
      if (!escaped) {
        ranges.push({ start, end: index + 3 })
        mode = 'normal'; start = -1; index += 2
      }
    }
  }
  if (start >= 0) ranges.push({ start, end: content.length })
  return ranges
}
function markerPositions(content: string, marker: string): number[] {
  const ranges = multilineTomlRanges(content)
  const positions: number[] = []
  let cursor = 0
  while (cursor < content.length) {
    const index = content.indexOf(marker, cursor)
    if (index < 0) break
    const lineStart = content.lastIndexOf('\n', index - 1) + 1
    const lineEnd = content.indexOf('\n', index)
    const line = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd)
      .replace(/\r$/, '')
    if (!ranges.some((range) => index >= range.start && index < range.end)
      && line.trim() === marker) positions.push(index)
    cursor = index + marker.length
  }
  return positions
}
function markers(serverName: string): [string, string] {
  return [
    `# >>> madar managed mcp: ${serverName} >>>`,
    `# <<< madar managed mcp: ${serverName} <<<`,
  ]
}
function readManagedBlock(content: string, serverName: string): ManagedBlock | null {
  const [startMarker, endMarker] = markers(serverName)
  const starts = markerPositions(content, startMarker)
  const ends = markerPositions(content, endMarker)
  if (starts.length === 0 && ends.length === 0) return null
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    throw new Error(`Malformed Codex Madar MCP marker block for ${serverName}`)
  }
  const start = starts[0]!
  const nextLine = content.indexOf('\n', ends[0]!)
  const end = nextLine < 0 ? content.length : nextLine + 1
  const block = content.slice(start, end)
  return {
    start,
    end,
    content: block,
    ownsPrecedingLineEnding: block.replaceAll('\r\n', '\n')
      .startsWith(`${startMarker}\n${OWNED_LINE_ENDING}\n`),
  }
}
function renderCodexBlock(
  workspace: string,
  serverName: string,
  newline: string,
  ownsPrecedingLineEnding: boolean,
): string {
  const [start, end] = markers(serverName)
  return [
    start,
    ...(ownsPrecedingLineEnding ? [OWNED_LINE_ENDING] : []),
    `[mcp_servers.${serverName}]`,
    'command = "madar"',
    'args = ["mcp"]',
    `cwd = ${JSON.stringify(workspace)}`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SECONDS}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
    end,
    '',
  ].join(newline)
}
function withoutTomlComments(content: string): string {
  const ranges = multilineTomlRanges(content)
  let output = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!
    if (ranges.some((range) => index >= range.start && index < range.end)) {
      output += character === '\n' ? '\n' : ' '
    } else if (quote) {
      output += character
      if (quote === '"' && escaped) escaped = false
      else if (quote === '"' && character === '\\') escaped = true
      else if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character; output += character
    } else if (character === '#') {
      while (index < content.length && content[index] !== '\n') index += 1
      if (index < content.length) output += '\n'
    } else output += character
  }
  return output
}
function hasUserCodexDeclaration(content: string, serverName: string): boolean {
  const path = `mcp_servers.${serverName}`
  let table: string | null = null
  for (const line of withoutTomlComments(content).split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line)?.[1]
    if (header) {
      table = header.replace(/[\s"']/g, '')
      if (table === path || table.startsWith(`${path}.`)) return true
      continue
    }
    const equals = line.indexOf('=')
    if (equals < 0) continue
    const key = line.slice(0, equals).replace(/[\s"']/g, '')
    if ((table === null && (key === 'mcp_servers'
        || key === path || key.startsWith(`${path}.`)))
      || (table === 'mcp_servers'
        && (key === serverName || key.startsWith(`${serverName}.`)))) return true
  }
  return false
}
function inspectCodex(
  workspace: string,
  options: InstallOptions,
): WiringInspection {
  const configPath = resolveCodexConfigPath(options)
  const serverName = workspaceServerName(workspace)
  const base = { client: 'codex' as const, workspace, configPath, serverName }
  if (!existsSync(configPath)) {
    return { ...base, status: 'missing', detail: 'global registration is absent' }
  }
  try {
    const content = readFileSync(configPath, 'utf8')
    const block = readManagedBlock(content, serverName)
    if (!block) {
      return hasUserCodexDeclaration(content, serverName)
        ? { ...base, status: 'conflict', detail: 'workspace server name is user-managed' }
        : { ...base, status: 'missing', detail: 'global registration is absent' }
    }
    const expected = renderCodexBlock(
      workspace,
      serverName,
      lineEnding(content),
      block.ownsPrecedingLineEnding,
    )
    return block.content === expected
      ? { ...base, status: 'exact', detail: 'workspace-scoped block is exact' }
      : { ...base, status: 'stale', detail: 'managed block was modified' }
  } catch (error) {
    return {
      ...base,
      status: 'stale',
      detail: error instanceof Error ? error.message : 'Codex configuration is invalid',
    }
  }
}
export function inspectClient(
  client: Client,
  path = '.',
  options: InstallOptions = {},
): WiringInspection {
  const workspace = canonicalWorkspace(path)
  return client === 'claude'
    ? inspectClaude(workspace, options)
    : inspectCodex(workspace, options)
}
function runClaudeCommand(
  args: readonly string[],
  workspace: string,
  options: InstallOptions,
): void {
  if (options.runClaude) return options.runClaude(args, workspace)
  const result = spawnSync('claude', args, {
    cwd: workspace,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: dirname(resolveClaudeConfigPath(options)),
    },
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim()
      || result.stdout.trim()
      || `Claude Code exited with status ${result.status ?? 'unknown'}`,
    )
  }
}
function installClaude(
  workspace: string,
  options: InstallOptions,
): InstallReceipt['action'] {
  const before = inspectClaude(workspace, options)
  assertExternal(before.configPath, workspace)
  if (before.status === 'exact') return 'already-installed'
  if (before.status !== 'missing') {
    throw new Error(`Refusing Claude registration: ${before.detail}`)
  }
  try {
    runClaudeCommand(
      ['mcp', 'add', '--scope', 'local', before.serverName, '--', 'madar', 'mcp'],
      workspace,
      options,
    )
  } catch (error) {
    if (inspectClaude(workspace, options).status === 'exact') return 'already-installed'
    throw error
  }
  if (inspectClaude(workspace, options).status !== 'exact') {
    throw new Error('Claude Code did not create the exact local Madar registration')
  }
  return 'installed'
}
function uninstallClaude(
  workspace: string,
  options: InstallOptions,
): InstallReceipt['action'] {
  const before = inspectClaude(workspace, options)
  assertExternal(before.configPath, workspace)
  if (before.status === 'missing') return 'not-installed'
  if (before.status !== 'exact') {
    throw new Error(`Refusing Claude uninstall: ${before.detail}`)
  }
  try {
    runClaudeCommand(
      ['mcp', 'remove', '--scope', 'local', before.serverName],
      workspace,
      options,
    )
  } catch (error) {
    if (inspectClaude(workspace, options).status === 'missing') return 'removed'
    throw error
  }
  if (inspectClaude(workspace, options).status !== 'missing') {
    throw new Error('Claude Code did not remove the exact local Madar registration')
  }
  return 'removed'
}
function legacyCodexBlock(
  workspace: string,
  serverName: string,
  newline: string,
  ownsPrecedingLineEnding: boolean,
): string {
  const [start, end] = markers(serverName)
  return [
    start,
    ...(ownsPrecedingLineEnding ? [OWNED_LINE_ENDING] : []),
    `[mcp_servers.${serverName}]`,
    'command = "madar"',
    'args = ["serve", "--stdio", "--auto-refresh"]',
    `cwd = ${JSON.stringify(workspace)}`,
    'enabled = true',
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SECONDS}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
    end,
    '',
  ].join(newline)
}
function installCodex(
  workspace: string,
  options: InstallOptions,
): InstallReceipt['action'] {
  const configPath = resolveCodexConfigPath(options)
  assertExternal(configPath, workspace)
  const serverName = workspaceServerName(workspace)
  return withFileLock(configPath, () => {
    const content = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    const block = readManagedBlock(content, serverName)
    const newline = lineEnding(content)
    if (block) {
      const expected = renderCodexBlock(
        workspace, serverName, newline, block.ownsPrecedingLineEnding,
      )
      if (block.content === expected) return 'already-installed'
      const legacy = legacyCodexBlock(
        workspace, serverName, newline, block.ownsPrecedingLineEnding,
      )
      if (block.content !== legacy) {
        throw new Error(`Refusing to replace modified Codex block for ${serverName}`)
      }
      writePreservingMetadata(
        configPath,
        `${content.slice(0, block.start)}${expected}${content.slice(block.end)}`,
      )
      return 'installed'
    }
    if (hasUserCodexDeclaration(content, serverName)) {
      throw new Error(`Refusing to replace user-managed Codex server ${serverName}`)
    }
    const ownsLineEnding = content.length > 0 && !content.endsWith('\n')
    const blockContent = renderCodexBlock(
      workspace, serverName, newline, ownsLineEnding,
    )
    writePreservingMetadata(
      configPath,
      `${content}${ownsLineEnding ? newline : ''}${blockContent}`,
    )
    return 'installed'
  })
}
function removeBlock(content: string, block: ManagedBlock): string {
  const before = content.slice(0, block.start)
  const after = content.slice(block.end)
  const preceding = before.endsWith('\r\n') ? '\r\n' : before.endsWith('\n') ? '\n' : ''
  const keptBefore = block.ownsPrecedingLineEnding && preceding
    ? before.slice(0, -preceding.length)
    : before
  const separator = block.ownsPrecedingLineEnding
    && preceding
    && after.length > 0
    && !after.startsWith('\n')
    && !after.startsWith('\r')
    ? preceding
    : ''
  return `${keptBefore}${separator}${after}`
}
function uninstallCodex(
  workspace: string,
  options: InstallOptions,
): InstallReceipt['action'] {
  const configPath = resolveCodexConfigPath(options)
  assertExternal(configPath, workspace)
  const serverName = workspaceServerName(workspace)
  return withFileLock(configPath, () => {
    if (!existsSync(configPath)) return 'not-installed'
    const content = readFileSync(configPath, 'utf8')
    const block = readManagedBlock(content, serverName)
    if (!block) return 'not-installed'
    const expected = renderCodexBlock(
      workspace, serverName, lineEnding(content), block.ownsPrecedingLineEnding,
    )
    if (block.content !== expected) {
      throw new Error(`Refusing to remove modified Codex block for ${serverName}`)
    }
    writePreservingMetadata(configPath, removeBlock(content, block))
    return 'removed'
  })
}
const CLAUDE_SECTION = `## madar

This project has a Madar knowledge graph.

1. For a repository question, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search.
2. Use returned authenticated excerpts and relationships when \`outcome\` is \`evidence\`.
3. When retrieval returns a boundary instead of evidence, state it and use only focused verification needed to continue.
4. Skip Madar for tasks that do not require local repository context.
`
const CODEX_SECTION = `## madar

### Codex CLI integration

For repository questions, call Madar's \`retrieve\` MCP tool exactly once with the user's question unchanged before broad file search. Use authenticated evidence when available and report explicit boundaries otherwise.
`
const ROUTING_GUIDE = 'This project has a Madar knowledge graph. For a repository question, call the Madar retrieve tool exactly once with the user question unchanged before broad file search. Use authenticated evidence when it is returned; otherwise report the explicit boundary and continue with only focused verification.'
function promptScript(client: 'Claude' | 'Codex'): string {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ROUTING_GUIDE,
    },
  })
  return `// madar managed ${client} UserPromptSubmit hook\n'use strict'\nprocess.stdout.write(${JSON.stringify(payload)})\n`
}
function removeKnownSection(
  workspace: string,
  relativePath: string,
  section: string,
  changes: string[],
): void {
  const path = workspaceFile(workspace, relativePath)
  if (!path) return
  const content = readFileSync(path, 'utf8')
  const candidates = [section, section.replaceAll('\n', '\r\n')]
  const match = candidates
    .map((value) => ({ value, index: content.indexOf(value) }))
    .find(({ index }) => index >= 0)
  if (!match) return
  let start = match.index
  const prefix = content.slice(0, start)
  if (prefix.endsWith('\r\n\r\n')) start -= 2
  else if (prefix.endsWith('\n\n')) start -= 1
  const next = `${content.slice(0, start)}${content.slice(match.index + match.value.length)}`
  if (next.length === 0) rmSync(path)
  else writePreservingMetadata(path, next)
  changes.push(`${relativePath}: removed exact generated Madar section`)
}
function removeKnownFile(
  workspace: string,
  relativePath: string,
  expected: string,
  changes: string[],
  warnings: string[],
): void {
  const path = workspaceFile(workspace, relativePath)
  if (!path) return
  const content = readFileSync(path, 'utf8')
  if (content === expected) {
    rmSync(path)
    changes.push(`${relativePath}: removed exact generated file`)
  } else if (/madar managed .*UserPromptSubmit hook/.test(content)) {
    warnings.push(`${relativePath}: modified legacy file left unchanged`)
  }
}
function legacyMcpEntry(value: unknown): boolean {
  const entry = record(value)
  const env = entry && Object.hasOwn(entry, 'env') ? record(entry.env) : {}
  return Boolean(entry
    && entry.command === 'madar'
    && Array.isArray(entry.args)
    && entry.args.join('\0') === ['serve', '--stdio', '--auto-refresh'].join('\0')
    && env
    && Object.keys(env).length === 0
    && Object.keys(entry).every((key) =>
      key === 'command' || key === 'args' || key === 'env'))
}
function legacyHook(value: unknown): boolean {
  const hook = record(value)
  const entry = hook && Array.isArray(hook.hooks) && hook.hooks.length === 1
    ? record(hook.hooks[0])
    : null
  return Boolean(hook
    && hook.name === 'madar'
    && hook.source === 'madar'
    && Object.keys(hook).every((key) =>
      key === 'hooks' || key === 'name' || key === 'source')
    && entry?.type === 'command'
    && (entry.command === 'node .claude/madar-user-prompt-submit.cjs'
      || entry.command === LEGACY_CODEX_PROMPT_COMMAND)
    && Object.keys(entry).every((key) => key === 'type' || key === 'command'))
}
function exactJsonFragment(source: string, predicate: (value: unknown) => boolean): boolean {
  let compact = ''
  let quoted = false
  let escaped = false
  for (const character of source) {
    if (quoted) {
      compact += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') { quoted = true; compact += character }
    else if (!/\s/.test(character)) compact += character
  }
  try {
    const parsed = JSON.parse(source) as unknown
    return compact === JSON.stringify(parsed) && predicate(parsed)
  } catch { return false }
}
interface JsonSourceRange extends TextRange {
  removeStart: number
  removeEnd: number
}
function skipJsonWhitespace(source: string, offset: number): number {
  let cursor = offset
  while (/\s/.test(source[cursor] ?? '')) cursor += 1
  return cursor
}
function jsonValueEnd(source: string, offset: number): number {
  const start = skipJsonWhitespace(source, offset)
  const opener = source[start]
  if (opener === '"') {
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') cursor += 1
      else if (source[cursor] === '"') return cursor + 1
    }
  } else if (opener === '{' || opener === '[') {
    const closer = opener === '{' ? '}' : ']'
    let depth = 1
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      if (source[cursor] === '"') cursor = jsonValueEnd(source, cursor) - 1
      else if (source[cursor] === opener) depth += 1
      else if (source[cursor] === closer && --depth === 0) return cursor + 1
    }
  } else {
    let cursor = start
    while (cursor < source.length && !/[\s,\]}]/.test(source[cursor]!)) cursor += 1
    return cursor
  }
  throw new Error('Invalid JSON source range')
}
function jsonProperty(
  source: string,
  objectStart: number,
  key: string,
): JsonSourceRange | null {
  let cursor = skipJsonWhitespace(source, objectStart) + 1
  let previousComma: number | null = null
  let found: JsonSourceRange | null = null
  while (cursor < source.length) {
    const entryStart = cursor
    cursor = skipJsonWhitespace(source, cursor)
    if (source[cursor] === '}') return found
    const keyEnd = jsonValueEnd(source, cursor)
    const parsedKey = JSON.parse(source.slice(cursor, keyEnd)) as unknown
    cursor = skipJsonWhitespace(source, keyEnd)
    if (source[cursor] !== ':') throw new Error('Invalid JSON object')
    const start = skipJsonWhitespace(source, cursor + 1)
    const end = jsonValueEnd(source, start)
    const after = skipJsonWhitespace(source, end)
    const comma = source[after] === ',' ? after : null
    if (parsedKey === key) {
      if (found) return null
      found = {
        start,
        end,
        removeStart: comma === null ? previousComma ?? entryStart : entryStart,
        removeEnd: comma === null ? end : comma + 1,
      }
    }
    if (comma === null) return found
    previousComma = comma
    cursor = comma + 1
  }
  return found
}
function jsonPropertyPath(source: string, keys: readonly string[]): JsonSourceRange | null {
  let objectStart = skipJsonWhitespace(source, 0)
  let property: JsonSourceRange | null = null
  for (const key of keys) {
    property = jsonProperty(source, objectStart, key)
    if (!property) return null
    objectStart = property.start
  }
  return property
}
function removeJsonProperty(source: string, keys: readonly string[]): string | null {
  const property = jsonPropertyPath(source, keys)
  return property
    ? `${source.slice(0, property.removeStart)}${source.slice(property.removeEnd)}`
    : null
}
function jsonArrayElements(source: string, arrayStart: number): JsonSourceRange[] {
  const elements: JsonSourceRange[] = []
  let cursor = skipJsonWhitespace(source, arrayStart) + 1
  let previousComma: number | null = null
  while (cursor < source.length) {
    const entryStart = cursor
    const start = skipJsonWhitespace(source, cursor)
    if (source[start] === ']') break
    const end = jsonValueEnd(source, start)
    const after = skipJsonWhitespace(source, end)
    const comma = source[after] === ',' ? after : null
    elements.push({
      start,
      end,
      removeStart: comma === null ? previousComma ?? entryStart : entryStart,
      removeEnd: comma === null ? end : comma + 1,
    })
    if (comma === null) break
    previousComma = comma
    cursor = comma + 1
  }
  return elements
}
function removeFirstLegacyHook(
  source: string,
  key: 'UserPromptSubmit' | 'PreToolUse',
): string | null {
  const property = jsonPropertyPath(source, ['hooks', key])
  if (!property || source[skipJsonWhitespace(source, property.start)] !== '[') return null
  const legacy = jsonArrayElements(source, property.start).find((element) =>
    exactJsonFragment(source.slice(element.start, element.end), legacyHook))
  return legacy
    ? `${source.slice(0, legacy.removeStart)}${source.slice(legacy.removeEnd)}`
    : null
}
function rewriteLegacyJson(
  workspace: string,
  relativePath: string,
  changes: string[],
  warnings: string[],
): void {
  const path = workspaceFile(workspace, relativePath)
  if (!path) return
  const original = readFileSync(path, 'utf8')
  let config: Record<string, unknown>
  try { config = readJsonObject(path) } catch {
    warnings.push(`${relativePath}: unreadable legacy JSON left unchanged`)
    return
  }
  let next = original
  const servers = record(config.mcpServers)
  if (servers && Object.hasOwn(servers, 'madar')) {
    if (legacyMcpEntry(servers.madar)) {
      const property = jsonPropertyPath(next, ['mcpServers', 'madar'])
      const updated = property
        && exactJsonFragment(next.slice(property.start, property.end), legacyMcpEntry)
        ? removeJsonProperty(next, ['mcpServers', 'madar'])
        : null
      if (updated) next = updated
      else warnings.push(`${relativePath}: ambiguous legacy Madar MCP entry left unchanged`)
    } else {
      warnings.push(`${relativePath}: modified legacy Madar MCP entry left unchanged`)
    }
  }
  const hooks = record(config.hooks)
  for (const key of ['UserPromptSubmit', 'PreToolUse'] as const) {
    const entries = hooks?.[key]
    if (!Array.isArray(entries)) continue
    if (entries.some((entry) => record(entry)?.source === 'madar' && !legacyHook(entry))) {
      warnings.push(`${relativePath}: modified legacy Madar hook left unchanged`)
    }
    const hadLegacy = entries.some(legacyHook)
    let removedLegacy = false
    for (;;) {
      const updated = removeFirstLegacyHook(next, key)
      if (!updated) break
      next = updated
      removedLegacy = true
    }
    const remaining = record(record(JSON.parse(next) as unknown)?.hooks)?.[key]
    if (hadLegacy && (!removedLegacy
      || (Array.isArray(remaining) && remaining.some(legacyHook)))) {
      warnings.push(`${relativePath}: ambiguous legacy Madar hook left unchanged`)
    }
  }
  if (next === original) return
  writePreservingMetadata(path, next)
  changes.push(`${relativePath}: removed exact legacy Madar entries`)
}
function removeGitHookSpan(
  workspace: string,
  name: 'post-commit' | 'post-checkout',
  changes: string[],
  warnings: string[],
): void {
  const result = spawnSync('git', ['rev-parse', '--git-path', `hooks/${name}`], {
    cwd: workspace, encoding: 'utf8', windowsHide: true,
  })
  if (result.status !== 0) return
  const path = resolve(workspace, result.stdout.trim())
  if (!existsSync(path) || !lstatSync(path).isFile()) return
  const content = readFileSync(path, 'utf8')
  const marker = name === 'post-commit'
    ? '# madar-hook-start'
    : '# madar-checkout-hook-start'
  if (!content.includes(marker)) return
  const candidates = [LEGACY_GIT_HOOKS[name], LEGACY_GIT_HOOKS[name].replaceAll('\n', '\r\n')]
  const matched = candidates.find((candidate) =>
    content.indexOf(candidate) >= 0
      && content.indexOf(candidate) === content.lastIndexOf(candidate))
  if (!matched) {
    warnings.push(`.git/hooks/${name}: modified legacy span left unchanged`)
    return
  }
  const generated = `#!/bin/sh${matched.includes('\r\n') ? '\r\n' : '\n'}${matched}`
  const next = content.replace(matched, '')
  if (content === generated) rmSync(path)
  else writePreservingMetadata(path, next)
  changes.push(`.git/hooks/${name}: removed exact Madar span`)
}
function removeLegacyProjectCodex(
  workspace: string,
  changes: string[],
  warnings: string[],
): void {
  const relativePath = '.codex/config.toml'
  const path = workspaceFile(workspace, relativePath)
  if (!path) return
  const content = readFileSync(path, 'utf8')
  const startMarker = '# >>> madar managed mcp >>>'
  const endMarker = '# <<< madar managed mcp <<<'
  const starts = markerPositions(content, startMarker)
  const ends = markerPositions(content, endMarker)
  if (starts.length === 0 && ends.length === 0) return
  if (starts.length !== 1 || ends.length !== 1 || ends[0]! < starts[0]!) {
    warnings.push(`${relativePath}: malformed legacy block left unchanged`)
    return
  }
  const start = starts[0]!
  const nextLine = content.indexOf('\n', ends[0]!)
  const end = nextLine < 0 ? content.length : nextLine + 1
  const blockContent = content.slice(start, end)
  const lines = blockContent.replaceAll('\r\n', '\n').trimEnd().split('\n')
  const expected = [
    startMarker,
    ...(lines[1] === OWNED_LINE_ENDING ? [OWNED_LINE_ENDING] : []),
    '[mcp_servers.madar]',
    'command = "madar"',
    'args = ["serve", "--stdio", "--auto-refresh"]',
    `cwd = ${JSON.stringify(workspace)}`,
    'enabled = true',
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SECONDS}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`,
    endMarker,
  ]
  if (JSON.stringify(lines) !== JSON.stringify(expected)) {
    warnings.push(`${relativePath}: modified legacy block left unchanged`)
    return
  }
  const next = removeBlock(content, {
    start,
    end,
    content: blockContent,
    ownsPrecedingLineEnding: lines[1] === OWNED_LINE_ENDING,
  })
  if (next.length === 0) rmSync(path)
  else writePreservingMetadata(path, next)
  changes.push(`${relativePath}: removed exact obsolete project-local block`)
}
function removeLegacyHome(home: string, changes: string[], warnings: string[]): void {
  for (const relativePath of [
    '.claude/skills/madar/SKILL.md',
    '.agents/skills/madar/SKILL.md',
  ]) {
    const path = workspaceFile(home, relativePath)
    if (!path) continue
    if (!LEGACY_SKILL_SHA256.has(createHash('sha256').update(readFileSync(path)).digest('hex'))) {
      warnings.push(`~/${relativePath}: modified legacy skill left unchanged`)
      continue
    }
    rmSync(path)
    const version = join(dirname(path), '.madar_version')
    if (existsSync(version) && lstatSync(version).isFile()
      && readFileSync(version, 'utf8') === '0.32.0') rmSync(version)
    changes.push(`~/${relativePath}: removed exact generated skill`)
  }
  removeKnownSection(home, '.claude/CLAUDE.md', LEGACY_HOME_SECTION, changes)
}
function migrateLegacy(workspace: string, home: string): {
  changes: string[]
  warnings: string[]
} {
  const changes: string[] = []
  const warnings: string[] = []
  removeKnownSection(workspace, 'CLAUDE.md', CLAUDE_SECTION, changes)
  removeKnownSection(workspace, 'AGENTS.md', CODEX_SECTION, changes)
  removeKnownFile(
    workspace, '.claude/madar-user-prompt-submit.cjs',
    promptScript('Claude'), changes, warnings,
  )
  removeKnownFile(
    workspace, '.codex/madar-user-prompt-submit.cjs',
    promptScript('Codex'), changes, warnings,
  )
  for (const path of ['.mcp.json', '.claude/settings.json', '.codex/hooks.json']) {
    rewriteLegacyJson(workspace, path, changes, warnings)
  }
  removeLegacyProjectCodex(workspace, changes, warnings)
  removeGitHookSpan(workspace, 'post-commit', changes, warnings)
  removeGitHookSpan(workspace, 'post-checkout', changes, warnings)
  removeLegacyHome(home, changes, warnings)
  return { changes, warnings }
}
export function installClient(
  client: Client,
  path = '.',
  options: InstallOptions = {},
): InstallReceipt {
  const workspace = canonicalWorkspace(path)
  const action = client === 'claude'
    ? installClaude(workspace, options)
    : installCodex(workspace, options)
  const migration = migrateLegacy(workspace, resolve(options.homeDir ?? homedir()))
  return {
    client,
    action,
    wiring: inspectClient(client, workspace, options),
    repositoryChanges: migration.changes,
    repositoryWarnings: migration.warnings,
  }
}
export function uninstallClient(
  client: Client,
  path = '.',
  options: InstallOptions = {},
): InstallReceipt {
  const workspace = canonicalWorkspace(path)
  const action = client === 'claude'
    ? uninstallClaude(workspace, options)
    : uninstallCodex(workspace, options)
  return {
    client,
    action,
    wiring: inspectClient(client, workspace, options),
    repositoryChanges: [],
    repositoryWarnings: [],
  }
}
export function formatInstallReceipt(receipt: InstallReceipt): string {
  return [
    `[madar install] ${receipt.client}: ${receipt.action}`,
    `- workspace: ${receipt.wiring.workspace}`,
    `- registration: ${receipt.wiring.status} (${receipt.wiring.serverName})`,
    `- config: ${receipt.wiring.configPath}`,
    ...(receipt.repositoryChanges.length === 0
      ? ['- repository changes: none']
      : [
          '- legacy migration:',
          ...receipt.repositoryChanges.map((change) => `  - ${change}`),
        ]),
    ...receipt.repositoryWarnings.map((warning) => `- warning: ${warning}`),
  ].join('\n')
}
