import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

export interface BenchmarkEnvironment {
  claude_code_version: string | null
  host_os: string
  node_version: string
  mcp_servers_active: string[]
  mcp_server_count: number
  skills_loaded: string[]
  skills_loaded_count: number
  plugins_active: string[]
  user_claude_md_hash: string | null
  project_claude_md_hash: string | null
  parent_claude_md_hashes: string[]
  hooks_active: {
    user_prompt_submit: string[]
    pre_tool_use: string[]
    post_tool_use: string[]
  }
}

export interface BenchmarkEnvironmentContamination {
  skills_activated_during_run: string[]
  skills_conflicting_with_madar_rules: string[]
  calls_to_other_mcps: Record<string, number>
  subagent_dispatches_detected: number
  skill_alignment_score: number
}

export interface CaptureBenchmarkEnvironmentOptions {
  projectRoot: string
  claudeConfigDir?: string | null
  getClaudeCodeVersion?: (() => string | null | Promise<string | null>) | null
}

export interface BenchmarkExpectedEnvironment {
  isolation_required?: boolean
  claude_code_version?: string | null
  host_os?: string | null
  node_version?: string | null
  mcp_servers_active?: string[]
  skills_loaded?: string[]
  plugins_active?: string[]
  user_claude_md_hash?: string | null
  project_claude_md_hash?: string | null
  parent_claude_md_hashes?: string[]
  hooks_active?: Partial<BenchmarkEnvironment['hooks_active']>
}

const CONFLICTING_SKILL_PATTERN = /(?:documentation-lookup|systematic-debugging|dispatching-parallel-agents|subagent-driven-development)/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeName(value: string): string {
  return value.trim()
}

function normalizeHookKey(value: string): 'user_prompt_submit' | 'pre_tool_use' | 'post_tool_use' | null {
  switch (value) {
    case 'UserPromptSubmit':
      return 'user_prompt_submit'
    case 'PreToolUse':
      return 'pre_tool_use'
    case 'PostToolUse':
      return 'post_tool_use'
    default:
      return null
  }
}

function emptyHooksActive(): BenchmarkEnvironment['hooks_active'] {
  return {
    user_prompt_submit: [],
    pre_tool_use: [],
    post_tool_use: [],
  }
}

function emptyBenchmarkEnvironmentContamination(): BenchmarkEnvironmentContamination {
  return {
    skills_activated_during_run: [],
    skills_conflicting_with_madar_rules: [],
    calls_to_other_mcps: {},
    subagent_dispatches_detected: 0,
    skill_alignment_score: 1,
  }
}

export { emptyBenchmarkEnvironmentContamination }

export function benchmarkIsolationEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.MADAR_BENCH_ISOLATION ?? '')
}

function parseJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sha256File(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null
  }
  return `sha256:${createHash('sha256').update(readFileSync(filePath)).digest('hex')}`
}

function listDirectoryNames(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) {
    return []
  }
  return readdirSync(directoryPath)
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => {
      try {
        return statSync(join(directoryPath, entry)).isDirectory()
      } catch {
        return false
      }
    })
    .map(normalizeName)
    .sort((left, right) => left.localeCompare(right))
}

function listPluginNames(directoryPath: string): string[] {
  if (!existsSync(directoryPath)) {
    return []
  }
  return readdirSync(directoryPath)
    .filter((entry) => !entry.startsWith('.'))
    .filter((entry) => {
      try {
        return statSync(join(directoryPath, entry)).isFile()
      } catch {
        return false
      }
    })
    .map((entry) => basename(entry, extname(entry)).trim())
    .filter((entry) => entry.length > 0)
    .sort((left, right) => left.localeCompare(right))
}

function collectMcpServers(configPath: string): string[] {
  const parsed = parseJsonFile(configPath)
  if (parsed === null) {
    return []
  }
  const servers =
    (isRecord(parsed.mcpServers) ? parsed.mcpServers : null)
    ?? (isRecord(parsed.servers) ? parsed.servers : null)
  if (servers === null) {
    return []
  }
  return Object.keys(servers).map(normalizeName).filter((entry) => entry.length > 0)
}

function collectHookSummaries(
  settingsPath: string,
  scope: 'user' | 'project',
  target: BenchmarkEnvironment['hooks_active'],
): void {
  const parsed = parseJsonFile(settingsPath)
  if (parsed === null || !isRecord(parsed.hooks)) {
    return
  }

  for (const [hookName, hookEntries] of Object.entries(parsed.hooks)) {
    const normalizedHookName = normalizeHookKey(hookName)
    if (normalizedHookName === null || !Array.isArray(hookEntries)) {
      continue
    }

    const bucket = new Set(target[normalizedHookName])
    for (const hookEntry of hookEntries) {
      if (!isRecord(hookEntry)) {
        continue
      }
      const matcher = typeof hookEntry.matcher === 'string' && hookEntry.matcher.trim().length > 0
        ? hookEntry.matcher.trim()
        : '*'
      const nestedHooks = Array.isArray(hookEntry.hooks) ? hookEntry.hooks : [hookEntry]
      for (const nestedHook of nestedHooks) {
        if (!isRecord(nestedHook)) {
          continue
        }
        const hookType = typeof nestedHook.type === 'string' && nestedHook.type.trim().length > 0
          ? nestedHook.type.trim()
          : 'unknown'
        bucket.add(`${scope}:${hookType}:${matcher}`)
      }
    }
    target[normalizedHookName] = [...bucket].sort((left, right) => left.localeCompare(right))
  }
}

function parseAnthropicTraceRecords(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return []
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord)
    }
    if (isRecord(parsed)) {
      return [parsed]
    }
  } catch {
    // Fall through to line-mode parsing below.
  }

  const records: Record<string, unknown>[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    const stripped = line.trim()
    if (stripped.length === 0) {
      continue
    }
    try {
      const parsed = JSON.parse(stripped) as unknown
      if (isRecord(parsed)) {
        records.push(parsed)
      }
    } catch {
      continue
    }
  }

  return records
}

function extractAssistantContentRecords(stdout: string): Record<string, unknown>[] {
  const parsedRecords = parseAnthropicTraceRecords(stdout)
  if (parsedRecords.length === 0) {
    return []
  }
  return parsedRecords.flatMap((record) => {
    if (Array.isArray(record.content)) {
      return record.content.filter(isRecord)
    }
    if (record.type === 'assistant' && isRecord(record.message) && Array.isArray(record.message.content)) {
      return record.message.content.filter(isRecord)
    }
    return []
  })
}

function extractSkillActivations(text: string): string[] {
  const found = new Set<string>()

  for (const match of text.matchAll(/<command-name>([^<]+)<\/command-name>/g)) {
    const skillName = match[1]?.trim()
    if (skillName) {
      found.add(skillName)
    }
  }

  for (const match of text.matchAll(/"skill"\s*:\s*"([^"]+)"/g)) {
    const skillName = match[1]?.trim()
    if (skillName) {
      found.add(skillName)
    }
  }

  return [...found]
}

function roundAlignmentScore(value: number): number {
  return Number(value.toFixed(2))
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (left === undefined || left.length !== right.length) {
    return false
  }
  return left.every((entry, index) => entry === right[index])
}

function compareExpectedArray(
  mismatches: string[],
  key: keyof BenchmarkExpectedEnvironment,
  expected: readonly string[] | undefined,
  actual: readonly string[],
): void {
  if (expected === undefined) {
    return
  }
  if (!sameStringArray(expected, actual)) {
    mismatches.push(`${key}: expected [${expected.join(', ')}] but got [${actual.join(', ')}]`)
  }
}

function compareExpectedScalar(
  mismatches: string[],
  key: keyof BenchmarkExpectedEnvironment,
  expected: string | null | boolean | undefined,
  actual: string | null | boolean,
): void {
  if (expected !== undefined && expected !== actual) {
    mismatches.push(`${key}: expected ${String(expected)} but got ${String(actual)}`)
  }
}

async function defaultClaudeCodeVersion(): Promise<string | null> {
  try {
    const versionOutput = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    const versionMatch = versionOutput.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
    return versionMatch?.[0] ?? (versionOutput.length > 0 ? versionOutput : null)
  } catch {
    return null
  }
}

export async function captureBenchmarkEnvironment(
  options: CaptureBenchmarkEnvironmentOptions,
): Promise<BenchmarkEnvironment> {
  const projectRoot = resolve(options.projectRoot)
  const claudeConfigDir = resolve(
    options.claudeConfigDir
      ?? process.env.CLAUDE_CONFIG_DIR
      ?? join(process.env.HOME ?? process.cwd(), '.claude'),
  )
  const hooksActive = emptyHooksActive()
  const homeDir = dirname(claudeConfigDir)
  const skillNames = new Set<string>([
    ...listDirectoryNames(join(claudeConfigDir, 'skills')),
    ...listDirectoryNames(join(claudeConfigDir, '.agents', 'skills')),
    ...listDirectoryNames(join(claudeConfigDir, '.cursor', 'skills')),
    ...listDirectoryNames(join(projectRoot, '.claude', 'skills')),
  ])
  const mcpServersActive = new Set<string>([
    ...collectMcpServers(join(homeDir, '.cursor', 'mcp.json')),
    ...collectMcpServers(join(projectRoot, '.mcp.json')),
    ...collectMcpServers(join(projectRoot, '.claude', 'mcp.json')),
    ...collectMcpServers(join(projectRoot, '.cursor', 'mcp.json')),
    ...collectMcpServers(join(projectRoot, '.vscode', 'mcp.json')),
  ])

  collectHookSummaries(join(claudeConfigDir, 'settings.json'), 'user', hooksActive)
  collectHookSummaries(join(projectRoot, '.claude', 'settings.json'), 'project', hooksActive)

  const parentClaudeMdHashes: string[] = []
  let currentParent = dirname(projectRoot)
  while (currentParent !== dirname(currentParent)) {
    const parentHash = sha256File(join(currentParent, 'CLAUDE.md'))
    if (parentHash !== null) {
      parentClaudeMdHashes.push(parentHash)
    }
    currentParent = dirname(currentParent)
  }

  const getClaudeCodeVersion = options.getClaudeCodeVersion ?? defaultClaudeCodeVersion
  const claudeCodeVersion = await getClaudeCodeVersion?.() ?? null
  const skillsLoaded = [...skillNames].sort((left, right) => left.localeCompare(right))
  const pluginsActive = listPluginNames(join(claudeConfigDir, '.opencode', 'plugins'))
  const activeMcpServers = [...mcpServersActive].sort((left, right) => left.localeCompare(right))

  return {
    claude_code_version: claudeCodeVersion,
    host_os: `${process.platform}-${process.arch}`,
    node_version: process.version,
    mcp_servers_active: activeMcpServers,
    mcp_server_count: activeMcpServers.length,
    skills_loaded: skillsLoaded,
    skills_loaded_count: skillsLoaded.length,
    plugins_active: pluginsActive,
    user_claude_md_hash: sha256File(join(claudeConfigDir, 'CLAUDE.md')),
    project_claude_md_hash: sha256File(join(projectRoot, 'CLAUDE.md')),
    parent_claude_md_hashes: parentClaudeMdHashes,
    hooks_active: hooksActive,
  }
}

export function findEnvironmentDrift(
  expected: BenchmarkExpectedEnvironment,
  actual: BenchmarkEnvironment,
  options: { isolation: boolean },
): string[] {
  const mismatches: string[] = []

  compareExpectedScalar(mismatches, 'isolation_required', expected.isolation_required, options.isolation)
  compareExpectedScalar(mismatches, 'claude_code_version', expected.claude_code_version, actual.claude_code_version)
  compareExpectedScalar(mismatches, 'host_os', expected.host_os, actual.host_os)
  compareExpectedScalar(mismatches, 'node_version', expected.node_version, actual.node_version)
  compareExpectedArray(mismatches, 'mcp_servers_active', expected.mcp_servers_active, actual.mcp_servers_active)
  compareExpectedArray(mismatches, 'skills_loaded', expected.skills_loaded, actual.skills_loaded)
  compareExpectedArray(mismatches, 'plugins_active', expected.plugins_active, actual.plugins_active)
  compareExpectedScalar(mismatches, 'user_claude_md_hash', expected.user_claude_md_hash, actual.user_claude_md_hash)
  compareExpectedScalar(mismatches, 'project_claude_md_hash', expected.project_claude_md_hash, actual.project_claude_md_hash)
  compareExpectedArray(mismatches, 'parent_claude_md_hashes', expected.parent_claude_md_hashes, actual.parent_claude_md_hashes)

  if (expected.hooks_active) {
    if (expected.hooks_active.user_prompt_submit !== undefined) {
      compareExpectedArray(
        mismatches,
        'hooks_active',
        expected.hooks_active.user_prompt_submit,
        actual.hooks_active.user_prompt_submit,
      )
    }
    if (expected.hooks_active.pre_tool_use !== undefined) {
      compareExpectedArray(
        mismatches,
        'hooks_active',
        expected.hooks_active.pre_tool_use,
        actual.hooks_active.pre_tool_use,
      )
    }
    if (expected.hooks_active.post_tool_use !== undefined) {
      compareExpectedArray(
        mismatches,
        'hooks_active',
        expected.hooks_active.post_tool_use,
        actual.hooks_active.post_tool_use,
      )
    }
  }

  return mismatches
}

export function extractEnvironmentContamination(stdout: string): BenchmarkEnvironmentContamination {
  const contamination = emptyBenchmarkEnvironmentContamination()
  const otherMcpCalls: Record<string, number> = {}
  const skillsActivated = new Set<string>()
  const assistantContent = extractAssistantContentRecords(stdout)

  for (const contentPart of assistantContent) {
    if (contentPart.type === 'tool_use' && typeof contentPart.name === 'string') {
      const toolName = contentPart.name.trim()
      if (toolName.startsWith('mcp__') && !toolName.startsWith('mcp__madar__')) {
        otherMcpCalls[toolName] = (otherMcpCalls[toolName] ?? 0) + 1
      }
    }
    if (contentPart.type === 'text' && typeof contentPart.text === 'string') {
      for (const skillName of extractSkillActivations(contentPart.text)) {
        skillsActivated.add(skillName)
      }
      const subagentMatches = contentPart.text.match(/\bspawn[_ -]?agent\b/gi)
      contamination.subagent_dispatches_detected += subagentMatches?.length ?? 0
    }
  }

  contamination.skills_activated_during_run = [...skillsActivated].sort((left, right) => left.localeCompare(right))
  contamination.skills_conflicting_with_madar_rules = contamination.skills_activated_during_run
    .filter((skillName) => CONFLICTING_SKILL_PATTERN.test(skillName))
    .sort((left, right) => left.localeCompare(right))
  contamination.calls_to_other_mcps = Object.fromEntries(
    Object.entries(otherMcpCalls).sort(([leftName], [rightName]) => leftName.localeCompare(rightName)),
  )

  if (contamination.skills_activated_during_run.length > 0) {
    const alignedSkillCount =
      contamination.skills_activated_during_run.length - contamination.skills_conflicting_with_madar_rules.length
    contamination.skill_alignment_score = roundAlignmentScore(
      alignedSkillCount / contamination.skills_activated_during_run.length,
    )
  }

  return contamination
}
