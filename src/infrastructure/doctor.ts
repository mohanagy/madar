import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  loadAcceptedIndex,
  readMatchingDiagnostics,
  type IndexDiagnostics,
} from '../adapters/filesystem/index-store.js'
import {
  CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH,
  CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH,
  OPENCODE_MCP_SERVER_NAME,
  OPENCODE_PLUGIN_RELATIVE_PATH,
  claudePromptHookCommand,
  codexPromptHookCommand,
  hasManagedClaudePromptHookScript,
  hasManagedCodexPromptHookScript,
  isCurrentMadarClaudePromptHook,
  isMadarProjectHook,
  isMadarCodexMcpConfig,
  isMadarCodexLegacyHook,
  isMadarCodexPromptHook,
  isCurrentMadarCodexPromptHook,
  readOpencodeConfig,
  resolveCodexMcpConfigPath,
  resolveOpencodeConfigPath,
} from './install.js'
import { analyzeGraphContextFreshness, graphFreshnessStatusLabel, type GraphContextFreshnessStatus } from '../runtime/freshness.js'
import { isSemanticRuntimeAvailable } from '../runtime/semantic.js'
import type { IndexBuildState } from '../domain/index/build-state.js'
import { findPackageRoot, readPackageVersion } from '../shared/package-metadata.js'
import { resolveWorkspaceGraphPath } from '../shared/workspace.js'
import {
  readDiscoverySafetyMetadata,
  type DiscoveryExclusion,
  type DiscoverySafetySummary,
} from '../shared/discovery-safety.js'

const MADAR_SECTION_MARKER = '## madar'

type AgentStatus = 'configured' | 'partial' | 'missing'
type McpStatus = 'ok' | 'missing' | 'stale'

interface McpCheck {
  label: 'claude' | 'cursor' | 'gemini' | 'copilot'
  configPath: string
  status: McpStatus
  reason: string
}

interface AgentCheck {
  label: 'claude' | 'cursor' | 'gemini' | 'copilot' | 'aider' | 'codex' | 'opencode'
  status: AgentStatus
  detail: string
}

interface GraphCheck {
  graphPath: string
  exists: boolean
  freshness: GraphContextFreshnessStatus
  ageMs: number | null
  generatedAt: string | null
  graphVersion: string | null
  indexedFileCount: number
  changedSourceCount: number
  missingSourceCount: number
  recommendation: string
  discoverySafety: DiscoverySafetySummary | null
  discoveryExclusions: DiscoveryExclusion[]
  buildState: IndexBuildState | null
  indexingDiagnostics: IndexDiagnostics | null
  generationPolicy: {
    storedFingerprint: string | null
    currentFingerprint: string | null
    match: boolean | null
    reason: string
  }
}

export interface DoctorReport {
  packageVersion: string
  graph: GraphCheck
  agents: AgentCheck[]
  mcpChecks: McpCheck[]
  /** Availability of the optional semantic/rerank runtime. Informational
   *  only — never part of the `healthy` computation. */
  semantic: SemanticCheck
  nextCommands: string[]
  healthy: boolean
}

interface SemanticCheck {
  available: boolean
  detail: string
}

interface JsonObject {
  [key: string]: unknown
}

const OUT_PATH_SEGMENT_PATTERN = /(^|[^a-z0-9_])out(?:[\\/]|[^a-z0-9_]|$)/i
const AIDER_SKILL_PATH = '.aider/madar/SKILL.md'
const CODEX_SKILL_PATH = '.agents/skills/madar/SKILL.md'
const OPENCODE_SKILL_PATH = '.config/opencode/skills/madar/SKILL.md'
const AIDER_INSTRUCTION_SNIPPETS = [
  '### Aider profile',
  'Use a strict context-pack-first workflow',
  'Before broad code search or manual file expansion',
  'madar pack "<task or question>" --task explain',
]
const CODEX_INSTRUCTION_SNIPPETS = [
  '### Codex CLI profile',
  'Use a strict context-pack-first workflow',
  'First decide whether the task needs local repository source-code context',
  'madar pack "<task or question>" --task explain',
  'Do not dispatch `spawn_agent` workers first',
]
const OPENCODE_INSTRUCTION_SNIPPETS = [
  '### OpenCode profile',
  'Use a strict context-pack-first workflow',
  'Before broad code search, bash-heavy exploration, or worker dispatch',
  'madar pack "<task or question>" --task explain',
  'Install artifacts:',
]

export interface DoctorCommandOptions {
  graphPath?: string
  projectDir?: string
  now?: number
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonObject(filePath: string): JsonObject | null {
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

function ageLabel(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) {
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

function hasSectionMarker(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false
  }
  return readFileSync(filePath, 'utf8').includes(MADAR_SECTION_MARKER)
}

function readText(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null
  }
  return readFileSync(filePath, 'utf8')
}

function fileContainsSnippets(filePath: string, snippets: readonly string[]): boolean {
  const content = readText(filePath)
  return content !== null && snippets.every((snippet) => content.includes(snippet))
}

function findHookEntry(settingsPath: string, hookName: 'PreToolUse' | 'BeforeTool'): boolean {
  const settings = readJsonObject(settingsPath)
  if (!settings) {
    return false
  }

  const hooks = settings.hooks
  if (!isRecord(hooks)) {
    return false
  }

  const hookEntries = hooks[hookName]
  if (!Array.isArray(hookEntries)) {
    return false
  }

  return hookEntries.some(containsOutPathReference)
}

function findClaudeHookEntry(settingsPath: string, hookScriptPath: string): boolean {
  const settings = readJsonObject(settingsPath)
  if (!settings) {
    return false
  }

  const hooks = settings.hooks
  if (!isRecord(hooks)) {
    return false
  }

  const userPromptSubmit = hooks.UserPromptSubmit
  const currentPromptHook = Array.isArray(userPromptSubmit)
    && userPromptSubmit.some((hook) => isCurrentMadarClaudePromptHook(hook, claudePromptHookCommand()))
    && hasManagedClaudePromptHookScript(hookScriptPath)
  const legacyPreToolUse = hooks.PreToolUse
  const legacyHook = Array.isArray(legacyPreToolUse)
    && legacyPreToolUse.some((hook) => isMadarProjectHook(hook, 'Glob|Grep|Bash|Agent|Read'))

  return currentPromptHook || legacyHook
}

function findCodexHookEntry(settingsPath: string, expectedCommand: string): boolean {
  const settings = readJsonObject(settingsPath)
  if (!settings) {
    return false
  }

  const hooks = settings.hooks
  if (!isRecord(hooks)) {
    return false
  }

  const hookEntries = hooks.UserPromptSubmit
  if (!Array.isArray(hookEntries)) {
    return false
  }

  const managedPromptHooks = hookEntries.filter(isMadarCodexPromptHook)
  const currentManagedPromptHooks = managedPromptHooks.filter((hook) => isCurrentMadarCodexPromptHook(hook, expectedCommand))
  const legacyPreToolUse = Array.isArray(hooks.PreToolUse) && hooks.PreToolUse.some(isMadarCodexLegacyHook)

  return managedPromptHooks.length === 1 && currentManagedPromptHooks.length === 1 && !legacyPreToolUse
}

function hasManagedCodexMcpConfig(configPath: string, projectDir: string): boolean {
  if (!existsSync(configPath)) {
    return false
  }

  return isMadarCodexMcpConfig(readFileSync(configPath, 'utf8'), projectDir)
}

function containsOutPathReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return OUT_PATH_SEGMENT_PATTERN.test(value)
  }
  if (Array.isArray(value)) {
    return value.some(containsOutPathReference)
  }
  if (isRecord(value)) {
    return Object.values(value).some(containsOutPathReference)
  }
  return false
}

function hasWorkspaceAutoRefreshArgs(args: unknown): boolean {
  if (!Array.isArray(args)) {
    return false
  }

  const normalizedArgs = args.filter((value): value is string => typeof value === 'string')
  return normalizedArgs.includes('serve')
    && normalizedArgs.includes('--stdio')
    && normalizedArgs.includes('--auto-refresh')
}

function readMcpCheck(
  label: McpCheck['label'],
  configPath: string,
  serversKey: 'mcpServers' | 'servers',
): McpCheck {
  if (!existsSync(configPath)) {
    return {
      label,
      configPath,
      status: 'missing',
      reason: 'config file missing',
    }
  }

  const config = readJsonObject(configPath)
  if (!config) {
    return {
      label,
      configPath,
      status: 'stale',
      reason: 'config is not valid JSON object',
    }
  }

  const servers = config[serversKey]
  if (!isRecord(servers)) {
    return {
      label,
      configPath,
      status: 'missing',
      reason: `missing '${serversKey}.madar' entry`,
    }
  }

  const server = servers.madar
  if (!isRecord(server)) {
    return {
      label,
      configPath,
      status: 'missing',
      reason: `missing '${serversKey}.madar' entry`,
    }
  }

  if (!hasWorkspaceAutoRefreshArgs(server.args)) {
    return {
      label,
      configPath,
      status: 'stale',
      reason: "server args must include 'serve --stdio --auto-refresh' to select the active workspace graph",
    }
  }

  return {
    label,
    configPath,
    status: 'ok',
    reason: 'server entry looks valid',
  }
}

function readGenerationPolicyCheck(
  buildState: IndexBuildState | null,
  freshness: ReturnType<typeof analyzeGraphContextFreshness>,
): GraphCheck['generationPolicy'] {
  if (!buildState) {
    return {
      storedFingerprint: null,
      currentFingerprint: null,
      match: false,
      reason: 'authoritative build state is unavailable; a full rebuild is required',
    }
  }
  const storedPolicy = buildState.policy
  const currentFingerprint = freshness.current_generation_policy_fingerprint ?? null
  const match = currentFingerprint !== null && storedPolicy.fingerprint === currentFingerprint
  return {
    storedFingerprint: storedPolicy.fingerprint,
    currentFingerprint,
    match,
    reason: currentFingerprint === null
      ? `unable to evaluate current policy: ${freshness.generation_policy_error ?? 'unknown error'}`
      : match ? 'stored policy matches current corpus controls' : 'corpus controls changed; a full rebuild is required',
  }
}

function readGraphCheck(graphPath: string, now: number): GraphCheck {
  const resolvedGraphPath = resolve(graphPath)
  const freshness = analyzeGraphContextFreshness(resolvedGraphPath)
  const ageMs = freshness.generated_ms === null
    ? null
    : Math.max(0, Math.trunc(now - freshness.generated_ms))
  const discoverySafety = readDiscoverySafetyMetadata(resolvedGraphPath)
  const accepted = loadAcceptedIndex(resolvedGraphPath)
  const buildState = accepted?.state ?? null
  const indexingDiagnostics = buildState ? readMatchingDiagnostics(resolvedGraphPath) : null
  const generationPolicy = readGenerationPolicyCheck(buildState, freshness)

  return {
    graphPath: resolvedGraphPath,
    exists: freshness.status !== 'missing',
    freshness: freshness.status,
    ageMs,
    generatedAt: freshness.generated_at,
    graphVersion: freshness.graph_version,
    indexedFileCount: freshness.indexed_file_count,
    changedSourceCount: freshness.changed_source_count,
    missingSourceCount: freshness.missing_source_count,
    recommendation: freshness.recommendation,
    discoverySafety: discoverySafety?.summary ?? null,
    discoveryExclusions: discoverySafety?.exclusions ?? [],
    buildState,
    indexingDiagnostics,
    generationPolicy,
  }
}

function agentStatusFromFlags(flags: boolean[]): AgentStatus {
  const positives = flags.filter(Boolean).length
  if (positives === 0) {
    return 'missing'
  }
  if (positives === flags.length) {
    return 'configured'
  }
  return 'partial'
}

function optionalAgentStatus(signals: boolean[], configuredFlags: boolean[]): AgentStatus | null {
  if (!signals.some(Boolean)) {
    return null
  }
  return configuredFlags.every(Boolean) ? 'configured' : 'partial'
}

function isOpencodePluginRegistered(config: JsonObject | null): boolean {
  if (!config) {
    return false
  }

  const plugin = config.plugin
  if (!Array.isArray(plugin)) {
    return false
  }

  return plugin.includes(OPENCODE_PLUGIN_RELATIVE_PATH)
}

function hasOpencodeMcpEntry(config: JsonObject | null): boolean {
  return config !== null && isRecord(config.mcp) && isRecord(config.mcp[OPENCODE_MCP_SERVER_NAME])
}

function isOpencodeMcpConfigured(config: JsonObject | null): boolean {
  if (!config || !isRecord(config.mcp)) {
    return false
  }

  const server = config.mcp[OPENCODE_MCP_SERVER_NAME]
  if (!isRecord(server)) {
    return false
  }

  const command = server.command
  if (!Array.isArray(command)) {
    return false
  }

  return hasWorkspaceAutoRefreshArgs(command)
}

function computeNextCommands(report: Omit<DoctorReport, 'nextCommands' | 'healthy'>): string[] {
  const nextCommands = new Set<string>()

  if (!report.graph.exists) {
    nextCommands.add('madar generate .')
  } else if (
    report.graph.freshness === 'possibly_stale'
    || report.graph.freshness === 'stale'
    || report.graph.generationPolicy.match === false
  ) {
    nextCommands.add('madar generate . --update')
  }

  const agentByLabel = new Map(report.agents.map((entry) => [entry.label, entry]))
  const mcpByLabel = new Map(report.mcpChecks.map((entry) => [entry.label, entry]))

  const claude = agentByLabel.get('claude')
  if (claude && claude.status !== 'configured') {
    nextCommands.add('madar claude install')
  } else {
    const claudeMcp = mcpByLabel.get('claude')
    if (claudeMcp && claudeMcp.status === 'stale') {
      nextCommands.add('madar claude install')
    }
  }

  const cursor = agentByLabel.get('cursor')
  if (cursor && cursor.status !== 'configured') {
    nextCommands.add('madar cursor install')
  } else {
    const cursorMcp = mcpByLabel.get('cursor')
    if (cursorMcp && cursorMcp.status === 'stale') {
      nextCommands.add('madar cursor install')
    }
  }

  const gemini = agentByLabel.get('gemini')
  if (gemini && gemini.status !== 'configured') {
    nextCommands.add('madar gemini install')
  }

  const copilot = agentByLabel.get('copilot')
  if (copilot && copilot.status !== 'configured') {
    nextCommands.add('madar copilot install')
  } else {
    const copilotMcp = mcpByLabel.get('copilot')
    if (copilotMcp && copilotMcp.status === 'stale') {
      nextCommands.add('madar copilot install')
    }
  }

  for (const label of ['aider', 'codex', 'opencode'] as const) {
    const agent = agentByLabel.get(label)
    if (agent && agent.status !== 'configured') {
      nextCommands.add(`madar ${label} install`)
    }
  }

  return [...nextCommands]
}

export function buildDoctorReport(options: DoctorCommandOptions = {}): DoctorReport {
  const projectDir = resolve(options.projectDir ?? '.')
  const graphPath = resolveWorkspaceGraphPath(options.graphPath ?? 'out/graph.json', projectDir)
  const now = options.now ?? Date.now()
  const resolvedGraphPath = resolve(projectDir, graphPath)
  const packageVersion = readPackageVersion(findPackageRoot())
  const graph = readGraphCheck(resolvedGraphPath, now)

  const claudeMcp = readMcpCheck('claude', resolve(projectDir, '.mcp.json'), 'mcpServers')
  const cursorMcp = readMcpCheck('cursor', resolve(projectDir, '.cursor', 'mcp.json'), 'mcpServers')
  const geminiMcp = readMcpCheck('gemini', resolve(projectDir, '.gemini', 'settings.json'), 'mcpServers')
  const copilotMcp = readMcpCheck('copilot', resolve(projectDir, '.vscode', 'mcp.json'), 'servers')

  const claudeRuleConfigured = hasSectionMarker(resolve(projectDir, 'CLAUDE.md'))
  const claudeHookConfigured = findClaudeHookEntry(
    resolve(projectDir, '.claude', 'settings.json'),
    resolve(projectDir, CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH),
  )
  const claudeMcpConfigured = claudeMcp.status === 'ok'

  const cursorRuleConfigured = existsSync(resolve(projectDir, '.cursor', 'rules', 'madar.mdc'))
  const cursorMcpConfigured = cursorMcp.status === 'ok'

  const geminiRuleConfigured = hasSectionMarker(resolve(projectDir, 'GEMINI.md'))
  const geminiHookConfigured = findHookEntry(resolve(projectDir, '.gemini', 'settings.json'), 'BeforeTool')
  const geminiMcpConfigured = geminiMcp.status === 'ok'

  const copilotMcpConfigured = copilotMcp.status === 'ok'

  const agentsPath = resolve(projectDir, 'AGENTS.md')
  const aiderSkillConfigured = existsSync(resolve(projectDir, AIDER_SKILL_PATH))
  const aiderInstructionsConfigured = fileContainsSnippets(agentsPath, AIDER_INSTRUCTION_SNIPPETS)
  const aiderStatus = optionalAgentStatus(
    [aiderSkillConfigured, aiderInstructionsConfigured],
    [aiderInstructionsConfigured],
  )

  const codexSkillConfigured = existsSync(resolve(projectDir, CODEX_SKILL_PATH))
  const codexInstructionsConfigured = fileContainsSnippets(agentsPath, CODEX_INSTRUCTION_SNIPPETS)
  const codexPromptHookScriptPath = resolve(projectDir, CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  const codexHookConfigured =
    hasManagedCodexPromptHookScript(codexPromptHookScriptPath)
    && findCodexHookEntry(resolve(projectDir, '.codex', 'hooks.json'), codexPromptHookCommand())
  const codexMcpConfigured = hasManagedCodexMcpConfig(resolveCodexMcpConfigPath(), projectDir)
  const codexStatus = optionalAgentStatus(
    [codexSkillConfigured, codexInstructionsConfigured, codexHookConfigured, codexMcpConfigured],
    [codexInstructionsConfigured, codexHookConfigured, codexMcpConfigured],
  )

  const opencodeSkillConfigured = existsSync(resolve(projectDir, OPENCODE_SKILL_PATH))
  const opencodeInstructionsConfigured = fileContainsSnippets(agentsPath, OPENCODE_INSTRUCTION_SNIPPETS)
  const opencodePluginFileConfigured = existsSync(resolve(projectDir, OPENCODE_PLUGIN_RELATIVE_PATH))
  const opencodeConfigPath = resolveOpencodeConfigPath(projectDir)
  const opencodeConfig = existsSync(opencodeConfigPath)
    ? (() => {
      try {
        return readOpencodeConfig(opencodeConfigPath) as JsonObject
      } catch {
        return null
      }
    })()
    : null
  const opencodeMcpEntryPresent = hasOpencodeMcpEntry(opencodeConfig)
  const opencodePluginConfigured = opencodePluginFileConfigured && isOpencodePluginRegistered(opencodeConfig)
  const opencodeMcpConfigured = isOpencodeMcpConfigured(opencodeConfig)
  const opencodeStatus = optionalAgentStatus(
    [opencodeSkillConfigured, opencodeInstructionsConfigured, opencodePluginFileConfigured, opencodeMcpEntryPresent],
    [opencodeInstructionsConfigured, opencodePluginConfigured, opencodeMcpConfigured],
  )

  const agents: AgentCheck[] = [
    {
      label: 'claude',
      status: agentStatusFromFlags([claudeRuleConfigured, claudeHookConfigured, claudeMcpConfigured]),
      detail: `rules=${claudeRuleConfigured ? 'yes' : 'no'}, hook=${claudeHookConfigured ? 'yes' : 'no'}, mcp=${claudeMcp.status}`,
    },
    {
      label: 'cursor',
      status: agentStatusFromFlags([cursorRuleConfigured, cursorMcpConfigured]),
      detail: `rules=${cursorRuleConfigured ? 'yes' : 'no'}, mcp=${cursorMcp.status}`,
    },
    {
      label: 'gemini',
      status: agentStatusFromFlags([geminiRuleConfigured, geminiHookConfigured, geminiMcpConfigured]),
      detail: `rules=${geminiRuleConfigured ? 'yes' : 'no'}, hook=${geminiHookConfigured ? 'yes' : 'no'}, mcp=${geminiMcp.status}`,
    },
    {
      label: 'copilot',
      status: copilotMcpConfigured ? 'configured' : copilotMcp.status === 'stale' ? 'partial' : 'missing',
      detail: `mcp=${copilotMcp.status}`,
    },
  ]

  if (aiderStatus) {
    agents.push({
      label: 'aider',
      status: aiderStatus,
      detail: `instructions=${aiderInstructionsConfigured ? 'yes' : 'no'}`,
    })
  }

  if (codexStatus) {
    agents.push({
      label: 'codex',
      status: codexStatus,
      detail: `instructions=${codexInstructionsConfigured ? 'yes' : 'no'}, hook=${codexHookConfigured ? 'yes' : 'no'}, mcp=${codexMcpConfigured ? 'yes' : 'no'}`,
    })
  }

  if (opencodeStatus) {
    agents.push({
      label: 'opencode',
      status: opencodeStatus,
      detail: `instructions=${opencodeInstructionsConfigured ? 'yes' : 'no'}, plugin=${opencodePluginConfigured ? 'yes' : 'no'}, mcp=${opencodeMcpConfigured ? 'yes' : 'no'}`,
    })
  }

  const mcpChecks = [claudeMcp, cursorMcp, geminiMcp, copilotMcp]

  const semanticAvailable = isSemanticRuntimeAvailable(projectDir)
  const semantic: SemanticCheck = semanticAvailable
    ? { available: true, detail: 'optional @huggingface/transformers resolved' }
    : { available: false, detail: 'optional — run `npm install @huggingface/transformers` in this project to enable semantic/rerank' }

  const partialReport = {
    packageVersion,
    graph,
    agents,
    mcpChecks,
    semantic,
  }
  const nextCommands = computeNextCommands(partialReport)
  const indexingRequiresAttention = graph.buildState !== null
    && graph.buildState.completeness.summary.state !== 'complete'
  const healthy = graph.exists
    && graph.buildState !== null
    && graph.freshness === 'fresh'
    && !indexingRequiresAttention
    && graph.generationPolicy.match !== false
    && agents.every((agent) => agent.status === 'configured')
    && mcpChecks.every((check) => check.status === 'ok')

  return {
    ...partialReport,
    nextCommands,
    healthy,
  }
}

function formatGraphLine(graph: GraphCheck): string[] {
  if (!graph.exists) {
    return [
      `- graph: missing (${graph.graphPath})`,
      "- graph freshness: missing (run 'madar generate .')",
    ]
  }

  const ageText = graph.ageMs === null ? 'unknown' : ageLabel(graph.ageMs)
  const generatedText = graph.generatedAt ?? 'unknown'
  const versionText = graph.graphVersion ?? 'unknown'

  const lines = [
    `- graph: found (${graph.graphPath})`,
    `- graph freshness: ${graphFreshnessStatusLabel(graph.freshness)} (${ageText} old, generated ${generatedText}, graph_version ${versionText})`,
    `- indexed files: ${graph.indexedFileCount}`,
    `- changed since graph: ${graph.changedSourceCount} source file${graph.changedSourceCount === 1 ? '' : 's'}`,
    `- missing since graph: ${graph.missingSourceCount} source file${graph.missingSourceCount === 1 ? '' : 's'}`,
    `- recommendation: ${graph.recommendation}`,
  ]
  const policy = graph.generationPolicy
  lines.push(
    `- generation policy: ${policy.match === null ? 'unavailable' : policy.match ? 'match' : 'mismatch'} (${policy.reason})`,
  )
  if (graph.buildState) {
    lines.push(`- authoritative index: accepted (build ${graph.buildState.build_id})`)
    lines.push(graph.indexingDiagnostics
      ? `- derived diagnostics: current (build ${graph.indexingDiagnostics.build_id})`
      : '- derived diagnostics: unavailable or mismatched (optional; accepted graph remains authoritative)')
  } else {
    lines.push('- authoritative index: unavailable (graph has no valid authenticated build state)')
    lines.push('- derived diagnostics: unavailable')
  }
  if (graph.discoverySafety && graph.discoverySafety.total > 0) {
    lines.push(
      `- safety exclusions: ${graph.discoverySafety.total} (${graph.discoverySafety.sensitive} sensitive, ${graph.discoverySafety.unreadable} unreadable)`,
      '- skipped paths:',
    )
    for (const exclusion of graph.discoveryExclusions.slice(0, 20)) {
      lines.push(`  - ${JSON.stringify(exclusion.path)} (${exclusion.reason})`)
    }
    if (graph.discoveryExclusions.length > 20) {
      lines.push(`  - ... ${graph.discoveryExclusions.length - 20} more; inspect graph.json discovery_safety.exclusions`)
    }
  } else {
    lines.push('- safety exclusions: none')
  }
  if (graph.buildState) {
    const { summary } = graph.buildState.completeness
    lines.push(
      `- indexing completeness: ${summary.state} (${summary.counts.indexed} indexed, ${summary.counts.indexed_with_warnings} warnings, ${summary.counts.skipped_by_policy} policy skips, ${summary.counts.unsupported} unsupported, ${summary.counts.failed} failed)`,
    )
    if (graph.indexingDiagnostics) {
      const affected = graph.indexingDiagnostics.outcomes.filter((outcome) =>
        outcome.status === 'failed' || outcome.status === 'unsupported' || outcome.status === 'indexed_with_warnings')
      if (affected.length > 0) {
        lines.push('- indexing detail paths:')
        for (const outcome of affected.slice(0, 20)) {
          lines.push(`  - ${JSON.stringify(outcome.path)} (${outcome.status}; ${outcome.reason}; ${outcome.capability ?? 'no capability'})`)
        }
        if (affected.length > 20) {
          lines.push(`  - ... ${affected.length - 20} more; inspect indexing-manifest.json`)
        }
      }
      if (graph.indexingDiagnostics.index_diagnostics.length > 0) {
        lines.push(`- Index diagnostics: ${graph.indexingDiagnostics.index_diagnostics.length} (inspect indexing-manifest.json)`)
      }
    } else if (graph.buildState.completeness.supported_failures.length > 0) {
      lines.push('- supported indexing failures:')
      for (const failure of graph.buildState.completeness.supported_failures.slice(0, 20)) {
        lines.push(`  - ${JSON.stringify(failure.path)} (${failure.reason})`)
      }
    }
  } else {
    lines.push("- indexing completeness: unavailable (regenerate with 'madar generate . --update')")
  }
  return lines
}

export function runDoctorCommand(options: DoctorCommandOptions = {}): string {
  const report = buildDoctorReport(options)
  const lines: string[] = []
  lines.push(`[madar doctor] ${report.healthy ? 'healthy' : 'attention needed'}`)
  lines.push(`- installed version: ${report.packageVersion}`)
  lines.push(...formatGraphLine(report.graph))
  lines.push('- agent configs:')
  for (const agent of report.agents) {
    lines.push(`  - ${agent.label}: ${agent.status} (${agent.detail})`)
  }
  lines.push('- mcp configs:')
  for (const check of report.mcpChecks) {
    lines.push(`  - ${check.label}: ${check.status} (${check.configPath}; ${check.reason})`)
  }
  lines.push(`- semantic/rerank: ${report.semantic.available ? 'available' : 'unavailable'} (${report.semantic.detail})`)

  if (report.nextCommands.length === 0) {
    lines.push('- next commands: none')
  } else {
    lines.push('- next commands:')
    for (const command of report.nextCommands) {
      lines.push(`  - ${command}`)
    }
  }

  return lines.join('\n')
}

export function runStatusCommand(options: DoctorCommandOptions = {}): string {
  const report = buildDoctorReport(options)
  const graphStatus = report.graph.exists
    ? `${report.graph.freshness} (${report.graph.ageMs === null ? 'unknown age' : ageLabel(report.graph.ageMs)}, changed=${report.graph.changedSourceCount}, missing=${report.graph.missingSourceCount})`
    : 'missing'
  const agentSummary = report.agents.map((agent) => `${agent.label}:${agent.status}`).join(' ')
  const mcpSummary = report.mcpChecks.map((check) => `${check.label}:${check.status}`).join(' ')
  const nextSummary = report.nextCommands.length === 0 ? 'none' : report.nextCommands.join('; ')
  const safetySummary = report.graph.discoverySafety && report.graph.discoverySafety.total > 0
    ? `${report.graph.discoverySafety.total} (sensitive=${report.graph.discoverySafety.sensitive}, unreadable=${report.graph.discoverySafety.unreadable})`
    : 'none'
  const skippedPaths = report.graph.discoveryExclusions.length > 0
    ? report.graph.discoveryExclusions
        .slice(0, 20)
        .map((entry) => `${JSON.stringify(entry.path)}[${entry.reason}]`)
        .join(', ')
    : 'none'
  const buildState = report.graph.buildState
  const indexing = buildState?.completeness.summary ?? null
  const indexingSummary = indexing
    ? `${indexing.state} (indexed=${indexing.counts.indexed}, warnings=${indexing.counts.indexed_with_warnings}, skipped=${indexing.counts.skipped_by_policy}, unsupported=${indexing.counts.unsupported}, failed=${indexing.counts.failed})`
    : 'unavailable'
  const incompletePaths = report.graph.indexingDiagnostics
    ? report.graph.indexingDiagnostics.outcomes
        .filter((outcome) => outcome.status === 'failed' || outcome.status === 'unsupported' || outcome.status === 'indexed_with_warnings')
        .slice(0, 20)
        .map((outcome) => `${JSON.stringify(outcome.path)}[${outcome.reason}]`)
        .join(', ') || 'none'
    : buildState?.completeness.supported_failures
        .slice(0, 20)
        .map((failure) => `${JSON.stringify(failure.path)}[${failure.reason}]`)
        .join(', ') || 'none'
  const acceptedSummary = buildState ? `accepted (${buildState.build_id})` : 'unavailable'
  const diagnosticsSummary = report.graph.indexingDiagnostics
    ? `current (${report.graph.indexingDiagnostics.build_id})`
    : buildState
      ? 'unavailable-or-mismatched (optional)'
      : 'unavailable'
  const policy = report.graph.generationPolicy
  const policySummary = `${policy.match === null ? 'unavailable' : policy.match ? 'match' : 'mismatch'} (stored=${policy.storedFingerprint?.slice(0, 12) ?? 'none'}, current=${policy.currentFingerprint?.slice(0, 12) ?? 'none'}; ${policy.reason})`

  return [
    `[madar status] ${report.healthy ? 'healthy' : 'attention needed'}`,
    `version ${report.packageVersion}`,
    `graph ${graphStatus}`,
    `build ${acceptedSummary}`,
    `generation-policy ${policySummary}`,
    `diagnostics ${diagnosticsSummary}`,
    `agents ${agentSummary}`,
    `mcp ${mcpSummary}`,
    `safety ${safetySummary}`,
    `skipped ${skippedPaths}${report.graph.discoveryExclusions.length > 20 ? `, ... ${report.graph.discoveryExclusions.length - 20} more` : ''}`,
    `indexing ${indexingSummary}`,
    `incomplete ${incompletePaths}`,
    `next ${nextSummary}`,
  ].join('\n')
}
