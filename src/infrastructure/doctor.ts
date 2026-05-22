import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { graphFreshnessMetadata } from '../runtime/freshness.js'
import { findPackageRoot, readPackageVersion } from '../shared/package-metadata.js'

const MADAR_SECTION_MARKER = '## madar'
const GRAPH_FRESH_THRESHOLD_MS = 60 * 60 * 1000
const GRAPH_RECENT_THRESHOLD_MS = 24 * 60 * 60 * 1000

type AgentStatus = 'configured' | 'partial' | 'missing'
type McpStatus = 'ok' | 'missing' | 'stale'
type GraphFreshness = 'fresh' | 'recent' | 'stale' | 'missing'

interface McpCheck {
  label: 'claude' | 'cursor' | 'copilot'
  configPath: string
  status: McpStatus
  reason: string
}

interface AgentCheck {
  label: 'claude' | 'cursor' | 'gemini' | 'copilot'
  status: AgentStatus
  detail: string
}

interface GraphCheck {
  graphPath: string
  exists: boolean
  freshness: GraphFreshness
  ageMs: number | null
  modifiedAt: string | null
  graphVersion: string | null
}

interface DoctorReport {
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

const OUT_PATH_SEGMENT_PATTERN = /(^|[^a-z0-9_])out(?:[\\/]|[^a-z0-9_]|$)/i

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

function extractGraphPathFromArgs(args: unknown): string | null {
  if (!Array.isArray(args)) {
    return null
  }

  const normalizedArgs = args.filter((value): value is string => typeof value === 'string')
  const stdioIndex = normalizedArgs.indexOf('--stdio')
  if (stdioIndex >= 0) {
    const candidate = normalizedArgs[stdioIndex + 1]
    if (candidate && candidate.trim().length > 0) {
      return candidate
    }
  }

  const graphPathCandidate = normalizedArgs.find((value) => /out[\\/]+graph\.json$/i.test(value))
  return graphPathCandidate ?? null
}

function readMcpCheck(
  label: McpCheck['label'],
  configPath: string,
  serversKey: 'mcpServers' | 'servers',
  expectedGraphPath: string,
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

  const declaredGraphPath = extractGraphPathFromArgs(server.args)
  if (!declaredGraphPath) {
    return {
      label,
      configPath,
      status: 'stale',
      reason: "graph path is missing from server args (expected '--stdio <graph-path>')",
    }
  }

  const resolvedDeclaredGraphPath = resolve(declaredGraphPath)
  if (resolvedDeclaredGraphPath !== expectedGraphPath) {
    return {
      label,
      configPath,
      status: 'stale',
      reason: `points to ${resolvedDeclaredGraphPath}, expected ${expectedGraphPath}`,
    }
  }

  return {
    label,
    configPath,
    status: 'ok',
    reason: 'server entry looks valid',
  }
}

function readGraphCheck(graphPath: string, now: number): GraphCheck {
  const resolvedGraphPath = resolve(graphPath)
  if (!existsSync(resolvedGraphPath)) {
    return {
      graphPath: resolvedGraphPath,
      exists: false,
      freshness: 'missing',
      ageMs: null,
      modifiedAt: null,
      graphVersion: null,
    }
  }

  const graphStats = statSync(resolvedGraphPath)
  const ageMs = Math.max(0, Math.trunc(now - graphStats.mtimeMs))

  let freshness: GraphFreshness = 'stale'
  if (ageMs <= GRAPH_FRESH_THRESHOLD_MS) {
    freshness = 'fresh'
  } else if (ageMs <= GRAPH_RECENT_THRESHOLD_MS) {
    freshness = 'recent'
  }

  let graphVersion: string | null = null
  try {
    graphVersion = graphFreshnessMetadata(resolvedGraphPath).graphVersion
  } catch {
    graphVersion = null
  }

  return {
    graphPath: resolvedGraphPath,
    exists: true,
    freshness,
    ageMs,
    modifiedAt: new Date(graphStats.mtimeMs).toISOString(),
    graphVersion,
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

function computeNextCommands(report: Omit<DoctorReport, 'nextCommands' | 'healthy'>): string[] {
  const nextCommands = new Set<string>()

  if (!report.graph.exists) {
    nextCommands.add('madar generate .')
  } else if (report.graph.freshness === 'stale') {
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

  return [...nextCommands]
}

function buildDoctorReport(options: DoctorCommandOptions = {}): DoctorReport {
  const graphPath = options.graphPath ?? 'out/graph.json'
  const projectDir = resolve(options.projectDir ?? '.')
  const now = options.now ?? Date.now()
  const resolvedGraphPath = resolve(projectDir, graphPath)
  const packageVersion = readPackageVersion(findPackageRoot())
  const graph = readGraphCheck(resolvedGraphPath, now)

  const claudeMcp = readMcpCheck('claude', resolve(projectDir, '.mcp.json'), 'mcpServers', resolvedGraphPath)
  const cursorMcp = readMcpCheck('cursor', resolve(projectDir, '.cursor', 'mcp.json'), 'mcpServers', resolvedGraphPath)
  const copilotMcp = readMcpCheck('copilot', resolve(projectDir, '.vscode', 'mcp.json'), 'servers', resolvedGraphPath)

  const claudeRuleConfigured = hasSectionMarker(resolve(projectDir, 'CLAUDE.md'))
  const claudeHookConfigured = findHookEntry(resolve(projectDir, '.claude', 'settings.json'), 'PreToolUse')
  const claudeMcpConfigured = claudeMcp.status === 'ok'

  const cursorRuleConfigured = existsSync(resolve(projectDir, '.cursor', 'rules', 'madar.mdc'))
  const cursorMcpConfigured = cursorMcp.status === 'ok'

  const geminiRuleConfigured = hasSectionMarker(resolve(projectDir, 'GEMINI.md'))
  const geminiHookConfigured = findHookEntry(resolve(projectDir, '.gemini', 'settings.json'), 'BeforeTool')

  const copilotMcpConfigured = copilotMcp.status === 'ok'

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
      status: agentStatusFromFlags([geminiRuleConfigured, geminiHookConfigured]),
      detail: `rules=${geminiRuleConfigured ? 'yes' : 'no'}, hook=${geminiHookConfigured ? 'yes' : 'no'}`,
    },
    {
      label: 'copilot',
      status: copilotMcpConfigured ? 'configured' : copilotMcp.status === 'stale' ? 'partial' : 'missing',
      detail: `mcp=${copilotMcp.status}`,
    },
  ]

  const mcpChecks = [claudeMcp, cursorMcp, copilotMcp]

  const partialReport = {
    packageVersion,
    graph,
    agents,
    mcpChecks,
  }
  const nextCommands = computeNextCommands(partialReport)
  const healthy = graph.exists && graph.freshness !== 'stale' && agents.every((agent) => agent.status === 'configured') && mcpChecks.every((check) => check.status === 'ok')

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

  const freshnessText = graph.freshness === 'fresh'
    ? 'fresh'
    : graph.freshness === 'recent'
      ? 'recent'
      : 'stale'
  const ageText = graph.ageMs === null ? 'unknown' : ageLabel(graph.ageMs)
  const modifiedText = graph.modifiedAt ?? 'unknown'
  const versionText = graph.graphVersion ?? 'unknown'

  return [
    `- graph: found (${graph.graphPath})`,
    `- graph freshness: ${freshnessText} (${ageText} old, modified ${modifiedText}, graph_version ${versionText})`,
  ]
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
    ? `${report.graph.freshness} (${report.graph.ageMs === null ? 'unknown age' : ageLabel(report.graph.ageMs)})`
    : 'missing'
  const agentSummary = report.agents.map((agent) => `${agent.label}:${agent.status}`).join(' ')
  const mcpSummary = report.mcpChecks.map((check) => `${check.label}:${check.status}`).join(' ')
  const nextSummary = report.nextCommands.length === 0 ? 'none' : report.nextCommands.join('; ')

  return [
    `[madar status] ${report.healthy ? 'healthy' : 'attention needed'}`,
    `version ${report.packageVersion}`,
    `graph ${graphStatus}`,
    `agents ${agentSummary}`,
    `mcp ${mcpSummary}`,
    `next ${nextSummary}`,
  ].join('\n')
}
