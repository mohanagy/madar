import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import {
  inspectQueryIndex,
  type QueryIndex,
} from '../domain/query/index-status.js'
import {
  readBuildState,
  type IndexBuildState,
} from '../domain/index/build-state.js'
import { findPackageRoot, readPackageVersion } from '../shared/package-metadata.js'
import { resolveWorkspaceGraphPath } from '../shared/workspace.js'
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
  isCurrentMadarCodexPromptHook,
  isCurrentMadarGeminiHook,
  isMadarCodexLegacyHook,
  isMadarCodexMcpConfig,
  isMadarCodexPromptHook,
  isMadarProjectHook,
  readOpencodeConfig,
  resolveCodexMcpConfigPath,
  resolveOpencodeConfigPath,
} from './install.js'

const MADAR_SECTION_MARKER = '## madar'
const AIDER_SKILL_PATH = '.aider/madar/SKILL.md'
const CODEX_SKILL_PATH = '.agents/skills/madar/SKILL.md'
const OPENCODE_SKILL_PATH = '.config/opencode/skills/madar/SKILL.md'

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
  indexState: QueryIndex['state'] | 'missing'
  indexSubject: string | null
  buildState: IndexBuildState | null
}

export interface DoctorReport {
  packageVersion: string
  graph: GraphCheck
  agents: AgentCheck[]
  mcpChecks: McpCheck[]
  nextCommands: string[]
  healthy: boolean
}

interface JsonObject {
  [key: string]: unknown
}

export interface DoctorCommandOptions {
  graphPath?: string
  projectDir?: string
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonObject(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function hasSectionMarker(filePath: string): boolean {
  return existsSync(filePath) && readFileSync(filePath, 'utf8').includes(MADAR_SECTION_MARKER)
}

function hasRetrieveInstructions(filePath: string, heading: string): boolean {
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, 'utf8')
  return content.includes(MADAR_SECTION_MARKER)
    && content.includes(heading)
    && content.includes('retrieve')
}

function findClaudeHookEntry(settingsPath: string, hookScriptPath: string): boolean {
  const settings = readJsonObject(settingsPath)
  const hooks = settings?.hooks
  if (!isRecord(hooks)) return false
  const current = Array.isArray(hooks.UserPromptSubmit)
    && hooks.UserPromptSubmit.some((hook) =>
      isCurrentMadarClaudePromptHook(hook, claudePromptHookCommand()))
    && hasManagedClaudePromptHookScript(hookScriptPath)
  const legacy = Array.isArray(hooks.PreToolUse)
    && hooks.PreToolUse.some((hook) =>
      isMadarProjectHook(hook, 'Glob|Grep|Bash|Agent|Read'))
  return current && !legacy
}

function findGeminiHookEntry(settingsPath: string): boolean {
  const settings = readJsonObject(settingsPath)
  const hooks = settings?.hooks
  if (!isRecord(hooks)) return false
  const entries = Array.isArray(hooks.BeforeTool) ? hooks.BeforeTool : []
  const managed = entries.filter((entry) => isMadarProjectHook(entry))
  return managed.length === 1 && isCurrentMadarGeminiHook(managed[0])
}

function findCodexHookEntry(settingsPath: string, expectedCommand: string): boolean {
  const settings = readJsonObject(settingsPath)
  const hooks = settings?.hooks
  if (!isRecord(hooks)) return false
  const entries = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : []
  const managed = entries.filter(isMadarCodexPromptHook)
  const current = managed.filter((hook) =>
    isCurrentMadarCodexPromptHook(hook, expectedCommand))
  const legacy = Array.isArray(hooks.PreToolUse)
    && hooks.PreToolUse.some(isMadarCodexLegacyHook)
  return managed.length === 1 && current.length === 1 && !legacy
}

function hasWorkspaceAutoRefreshArgs(args: unknown): boolean {
  if (!Array.isArray(args)) return false
  const values = args.filter((value): value is string => typeof value === 'string')
  return values.includes('serve')
    && values.includes('--stdio')
    && values.includes('--auto-refresh')
}

function readMcpCheck(
  label: McpCheck['label'],
  configPath: string,
  serversKey: 'mcpServers' | 'servers',
): McpCheck {
  if (!existsSync(configPath)) {
    return { label, configPath, status: 'missing', reason: 'config file missing' }
  }
  const config = readJsonObject(configPath)
  if (!config) {
    return { label, configPath, status: 'stale', reason: 'config is not a valid JSON object' }
  }
  const servers = config[serversKey]
  const server = isRecord(servers) ? servers.madar : null
  if (!isRecord(server)) {
    return { label, configPath, status: 'missing', reason: `missing '${serversKey}.madar' entry` }
  }
  if (!hasWorkspaceAutoRefreshArgs(server.args)) {
    return {
      label,
      configPath,
      status: 'stale',
      reason: "server args must include 'serve --stdio --auto-refresh'",
    }
  }
  if (isRecord(server.env) && Object.hasOwn(server.env, 'MADAR_TOOL_PROFILE')) {
    return {
      label,
      configPath,
      status: 'stale',
      reason: 'server still declares the retired MADAR_TOOL_PROFILE setting',
    }
  }
  return { label, configPath, status: 'ok', reason: 'server entry looks valid' }
}

function readGraphCheck(graphPath: string): GraphCheck {
  const resolvedGraphPath = resolve(graphPath)
  if (!existsSync(resolvedGraphPath)) {
    return {
      graphPath: resolvedGraphPath,
      exists: false,
      indexState: 'missing',
      indexSubject: 'canonical graph artifact',
      buildState: null,
    }
  }
  try {
    const graph = loadGraphArtifact(resolvedGraphPath)
    const index = inspectQueryIndex(graph)
    return {
      graphPath: resolvedGraphPath,
      exists: true,
      indexState: index.state,
      indexSubject: index.state === 'ready' ? null : index.subject,
      buildState: readBuildState(graph),
    }
  } catch {
    return {
      graphPath: resolvedGraphPath,
      exists: true,
      indexState: 'corrupt',
      indexSubject: 'canonical graph artifact',
      buildState: null,
    }
  }
}

function agentStatus(flags: boolean[]): AgentStatus {
  const configured = flags.filter(Boolean).length
  if (configured === 0) return 'missing'
  return configured === flags.length ? 'configured' : 'partial'
}

function optionalAgentStatus(signals: boolean[], required: boolean[]): AgentStatus | null {
  if (!signals.some(Boolean)) return null
  return required.every(Boolean) ? 'configured' : 'partial'
}

function hasManagedCodexMcpConfig(configPath: string, projectDir: string): boolean {
  return existsSync(configPath)
    && isMadarCodexMcpConfig(readFileSync(configPath, 'utf8'), projectDir)
}

function isOpencodePluginRegistered(config: JsonObject | null): boolean {
  return Array.isArray(config?.plugin)
    && config.plugin.includes(OPENCODE_PLUGIN_RELATIVE_PATH)
}

function hasOpencodeMcpEntry(config: JsonObject | null): boolean {
  return config !== null
    && isRecord(config.mcp)
    && isRecord(config.mcp[OPENCODE_MCP_SERVER_NAME])
}

function isOpencodeMcpConfigured(config: JsonObject | null): boolean {
  if (!config || !isRecord(config.mcp)) return false
  const server = config.mcp[OPENCODE_MCP_SERVER_NAME]
  return isRecord(server)
    && hasWorkspaceAutoRefreshArgs(server.command)
    && !(isRecord(server.environment) && Object.hasOwn(server.environment, 'MADAR_TOOL_PROFILE'))
}

function computeNextCommands(
  graph: GraphCheck,
  agents: AgentCheck[],
  mcpChecks: McpCheck[],
): string[] {
  const commands = new Set<string>()
  if (graph.indexState !== 'ready') commands.add('madar generate .')
  const agentByLabel = new Map(agents.map((entry) => [entry.label, entry]))
  const mcpByLabel = new Map(mcpChecks.map((entry) => [entry.label, entry]))
  for (const label of ['claude', 'cursor', 'gemini', 'copilot'] as const) {
    const status = agentByLabel.get(label)?.status
    if (status === 'partial' || (status !== 'missing' && mcpByLabel.get(label)?.status === 'stale')) {
      commands.add(`madar ${label} install`)
    }
  }
  for (const label of ['aider', 'codex', 'opencode'] as const) {
    const agent = agentByLabel.get(label)
    if (agent && agent.status !== 'configured') commands.add(`madar ${label} install`)
  }
  return [...commands]
}

export function buildDoctorReport(options: DoctorCommandOptions = {}): DoctorReport {
  const projectDir = resolve(options.projectDir ?? '.')
  const graphPath = resolveWorkspaceGraphPath(options.graphPath ?? 'out/graph.json', projectDir)
  const graph = readGraphCheck(resolve(projectDir, graphPath))
  const packageVersion = readPackageVersion(findPackageRoot())

  const claudeMcp = readMcpCheck('claude', resolve(projectDir, '.mcp.json'), 'mcpServers')
  const cursorMcp = readMcpCheck('cursor', resolve(projectDir, '.cursor', 'mcp.json'), 'mcpServers')
  const geminiMcp = readMcpCheck('gemini', resolve(projectDir, '.gemini', 'settings.json'), 'mcpServers')
  const copilotMcp = readMcpCheck('copilot', resolve(projectDir, '.vscode', 'mcp.json'), 'servers')

  const claudeRule = hasSectionMarker(resolve(projectDir, 'CLAUDE.md'))
  const claudeHook = findClaudeHookEntry(
    resolve(projectDir, '.claude', 'settings.json'),
    resolve(projectDir, CLAUDE_PROMPT_HOOK_SCRIPT_RELATIVE_PATH),
  )
  const cursorRule = existsSync(resolve(projectDir, '.cursor', 'rules', 'madar.mdc'))
  const geminiRule = hasSectionMarker(resolve(projectDir, 'GEMINI.md'))
  const geminiHook = findGeminiHookEntry(resolve(projectDir, '.gemini', 'settings.json'))

  const agents: AgentCheck[] = [
    {
      label: 'claude',
      status: agentStatus([claudeRule, claudeHook, claudeMcp.status === 'ok']),
      detail: `rules=${claudeRule ? 'yes' : 'no'}, hook=${claudeHook ? 'yes' : 'no'}, mcp=${claudeMcp.status}`,
    },
    {
      label: 'cursor',
      status: agentStatus([cursorRule, cursorMcp.status === 'ok']),
      detail: `rules=${cursorRule ? 'yes' : 'no'}, mcp=${cursorMcp.status}`,
    },
    {
      label: 'gemini',
      status: agentStatus([geminiRule, geminiHook, geminiMcp.status === 'ok']),
      detail: `rules=${geminiRule ? 'yes' : 'no'}, hook=${geminiHook ? 'yes' : 'no'}, mcp=${geminiMcp.status}`,
    },
    {
      label: 'copilot',
      status: copilotMcp.status === 'ok'
        ? 'configured'
        : copilotMcp.status === 'stale' ? 'partial' : 'missing',
      detail: `mcp=${copilotMcp.status}`,
    },
  ]

  const agentsPath = resolve(projectDir, 'AGENTS.md')
  const aiderInstructions = hasRetrieveInstructions(agentsPath, '### Aider integration')
  const aiderStatus = optionalAgentStatus(
    [existsSync(resolve(projectDir, AIDER_SKILL_PATH)), aiderInstructions],
    [aiderInstructions],
  )
  if (aiderStatus) {
    agents.push({
      label: 'aider',
      status: aiderStatus,
      detail: `instructions=${aiderInstructions ? 'yes' : 'no'}`,
    })
  }

  const codexInstructions = hasRetrieveInstructions(agentsPath, '### Codex CLI integration')
  const codexHookScript = resolve(projectDir, CODEX_PROMPT_HOOK_SCRIPT_RELATIVE_PATH)
  const codexHook = hasManagedCodexPromptHookScript(codexHookScript)
    && findCodexHookEntry(resolve(projectDir, '.codex', 'hooks.json'), codexPromptHookCommand())
  const codexMcp = hasManagedCodexMcpConfig(resolveCodexMcpConfigPath(), projectDir)
  const codexStatus = optionalAgentStatus(
    [
      existsSync(resolve(projectDir, CODEX_SKILL_PATH)),
      codexInstructions,
      codexHook,
      codexMcp,
    ],
    [codexInstructions, codexHook, codexMcp],
  )
  if (codexStatus) {
    agents.push({
      label: 'codex',
      status: codexStatus,
      detail: `instructions=${codexInstructions ? 'yes' : 'no'}, hook=${codexHook ? 'yes' : 'no'}, mcp=${codexMcp ? 'yes' : 'no'}`,
    })
  }

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
  const opencodeInstructions = hasRetrieveInstructions(agentsPath, '### OpenCode integration')
  const opencodePlugin = existsSync(resolve(projectDir, OPENCODE_PLUGIN_RELATIVE_PATH))
    && isOpencodePluginRegistered(opencodeConfig)
  const opencodeMcp = isOpencodeMcpConfigured(opencodeConfig)
  const opencodeStatus = optionalAgentStatus(
    [
      existsSync(resolve(projectDir, OPENCODE_SKILL_PATH)),
      opencodeInstructions,
      opencodePlugin,
      hasOpencodeMcpEntry(opencodeConfig),
    ],
    [opencodeInstructions, opencodePlugin, opencodeMcp],
  )
  if (opencodeStatus) {
    agents.push({
      label: 'opencode',
      status: opencodeStatus,
      detail: `instructions=${opencodeInstructions ? 'yes' : 'no'}, plugin=${opencodePlugin ? 'yes' : 'no'}, mcp=${opencodeMcp ? 'yes' : 'no'}`,
    })
  }

  const mcpChecks = [claudeMcp, cursorMcp, geminiMcp, copilotMcp]
  const nextCommands = computeNextCommands(graph, agents, mcpChecks)
  const configuredLabels = new Set(
    agents
      .filter((agent) => agent.status !== 'missing')
      .map((agent) => agent.label),
  )
  const healthy = graph.indexState === 'ready'
    && agents.every((agent) => agent.status === 'missing' || agent.status === 'configured')
    && mcpChecks.every((check) => !configuredLabels.has(check.label) || check.status === 'ok')
  return { packageVersion, graph, agents, mcpChecks, nextCommands, healthy }
}

function indexingSummary(state: IndexBuildState | null): string {
  if (!state) return 'unavailable'
  const counts = state.completeness.summary.counts
  return `${state.completeness.summary.state} (indexed=${counts.indexed}, warnings=${counts.indexed_with_warnings}, skipped=${counts.skipped_by_policy}, unsupported=${counts.unsupported}, failed=${counts.failed})`
}

function formatGraphLines(graph: GraphCheck): string[] {
  if (!graph.exists) {
    return [
      `- graph: missing (${graph.graphPath})`,
      "- query index: missing (run 'madar generate .')",
    ]
  }
  const lines = [
    `- graph: found (${graph.graphPath})`,
    `- query index: ${graph.indexState}${graph.indexSubject ? ` (${graph.indexSubject})` : ''}`,
    graph.buildState
      ? `- build: authenticated (${graph.buildState.build_id})`
      : '- build: unavailable',
    `- indexing: ${indexingSummary(graph.buildState)}`,
  ]
  if (graph.buildState) {
    lines.push(
      `- corpus: ${graph.buildState.corpus.supported_files} supported, ${graph.buildState.corpus.unsupported_files} unsupported`,
    )
  }
  return lines
}

export function runDoctorCommand(options: DoctorCommandOptions = {}): string {
  const report = buildDoctorReport(options)
  const lines = [
    `[madar doctor] ${report.healthy ? 'healthy' : 'attention needed'}`,
    `- installed version: ${report.packageVersion}`,
    ...formatGraphLines(report.graph),
    '- agent configs:',
    ...report.agents.map((agent) =>
      `  - ${agent.label}: ${agent.status} (${agent.detail})`),
    '- mcp configs:',
    ...report.mcpChecks.map((check) =>
      `  - ${check.label}: ${check.status} (${check.configPath}; ${check.reason})`),
  ]
  if (report.nextCommands.length === 0) {
    lines.push('- next commands: none')
  } else {
    lines.push('- next commands:', ...report.nextCommands.map((command) => `  - ${command}`))
  }
  return lines.join('\n')
}

export function runStatusCommand(options: DoctorCommandOptions = {}): string {
  const report = buildDoctorReport(options)
  const agentSummary = report.agents
    .map((agent) => `${agent.label}:${agent.status}`)
    .join(' ')
  const mcpSummary = report.mcpChecks
    .map((check) => `${check.label}:${check.status}`)
    .join(' ')
  return [
    `[madar status] ${report.healthy ? 'healthy' : 'attention needed'}`,
    `version ${report.packageVersion}`,
    `graph ${report.graph.exists ? 'found' : 'missing'}`,
    `index ${report.graph.indexState}${report.graph.indexSubject ? ` (${report.graph.indexSubject})` : ''}`,
    `build ${report.graph.buildState?.build_id ?? 'unavailable'}`,
    `indexing ${indexingSummary(report.graph.buildState)}`,
    `agents ${agentSummary}`,
    `mcp ${mcpSummary}`,
    `next ${report.nextCommands.length === 0 ? 'none' : report.nextCommands.join('; ')}`,
  ].join('\n')
}
