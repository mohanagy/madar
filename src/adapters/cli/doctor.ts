import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { loadGraphArtifact } from '../filesystem/graph-artifact.js'
import { readBuildState } from '../../domain/index/build-state.js'
import { inspectQueryIndex } from '../../domain/query/index-status.js'
import { resolveMadarWorkspace } from '../../shared/workspace.js'
import {
  inspectClient,
  type InstallOptions,
  type WiringInspection,
} from './install.js'
export interface DiagnosticOptions {
  projectDir?: string
  graphPath?: string
  install?: InstallOptions
}
export interface GraphDiagnostic {
  path: string
  state: 'ready' | 'missing' | 'unavailable' | 'corrupt' | 'stale'
  subject: string | null
  buildId: string | null
  completeness: string | null
}
export interface DiagnosticReport {
  workspace: string
  linkedWorktree: boolean
  graph: GraphDiagnostic
  clients: readonly [WiringInspection, WiringInspection]
  healthy: boolean
}
function samePath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right) } catch {
    return resolve(left) === resolve(right)
  }
}
function graphDiagnostic(
  workspace: ReturnType<typeof resolveMadarWorkspace>,
  requestedPath?: string,
): GraphDiagnostic {
  const path = requestedPath
    ? resolve(workspace.rootPath, requestedPath)
    : workspace.graphPath
  if (!existsSync(path)) {
    return {
      path,
      state: 'missing',
      subject: 'canonical graph artifact',
      buildId: null,
      completeness: null,
    }
  }
  try {
    const graph = loadGraphArtifact(path)
    const index = inspectQueryIndex(graph)
    const build = readBuildState(graph)
    if (index.state !== 'ready') {
      return {
        path,
        state: index.state,
        subject: index.subject,
        buildId: build?.build_id ?? null,
        completeness: build?.completeness.summary.state ?? null,
      }
    }
    if (!samePath(index.root_path, workspace.rootPath)) {
      return {
        path,
        state: 'stale',
        subject: 'graph belongs to a different workspace',
        buildId: build?.build_id ?? null,
        completeness: build?.completeness.summary.state ?? null,
      }
    }
    return {
      path,
      state: 'ready',
      subject: null,
      buildId: build?.build_id ?? null,
      completeness: build?.completeness.summary.state ?? null,
    }
  } catch {
    return {
      path,
      state: 'corrupt',
      subject: 'canonical graph artifact',
      buildId: null,
      completeness: null,
    }
  }
}
export function buildDiagnosticReport(
  options: DiagnosticOptions = {},
): DiagnosticReport {
  const workspace = resolveMadarWorkspace(options.projectDir ?? process.cwd())
  const graphPath = options.graphPath && isAbsolute(options.graphPath)
    ? options.graphPath
    : options.graphPath
  const graph = graphDiagnostic(workspace, graphPath)
  const clients = [
    inspectClient('claude', workspace.rootPath, options.install),
    inspectClient('codex', workspace.rootPath, options.install),
  ] as const
  return {
    workspace: workspace.rootPath,
    linkedWorktree: workspace.isLinkedWorktree,
    graph,
    clients,
    healthy: graph.state === 'ready'
      && clients.every((client) => client.status === 'exact'),
  }
}
export function formatStatusReport(report: DiagnosticReport): string {
  return [
    `workspace=${report.workspace}`,
    `graph=${report.graph.state}`,
    ...report.clients.map((client) => `${client.client}=${client.status}`),
  ].join(' ')
}
export function formatDoctorReport(report: DiagnosticReport): string {
  return [
    `[madar doctor] ${report.healthy ? 'ready' : 'attention required'}`,
    `- workspace: ${report.workspace}`,
    `- linked worktree: ${report.linkedWorktree ? 'yes' : 'no'}`,
    `- graph: ${report.graph.state} (${report.graph.path})`,
    ...(report.graph.buildId ? [`- build: ${report.graph.buildId}`] : []),
    ...(report.graph.completeness
      ? [`- completeness: ${report.graph.completeness}`]
      : []),
    ...(report.graph.subject ? [`- graph detail: ${report.graph.subject}`] : []),
    ...report.clients.flatMap((client) => [
      `- ${client.client}: ${client.status} (${client.serverName})`,
      `  ${client.detail}; config ${client.configPath}`,
    ]),
  ].join('\n')
}
export function runStatusCommand(options: DiagnosticOptions = {}): string {
  return formatStatusReport(buildDiagnosticReport(options))
}
export function runDoctorCommand(options: DiagnosticOptions = {}): string {
  return formatDoctorReport(buildDiagnosticReport(options))
}
