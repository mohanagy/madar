import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { TryCliOptions, PackCliOptions } from '../cli/parser.js'
import { generateIndex, GenerateUnsupportedCorpusError } from '../application/generate-index.js'
import { runContextPackCommand } from './context-pack-command.js'
import { defaultInstallPlatform, type InstallPlatform } from './install.js'
import { buildGraphSummary, type GraphSummary } from '../runtime/graph-summary.js'
import { analyzeGraphContextFreshness, graphFreshnessStatusLabel, type GraphContextFreshness } from '../runtime/freshness.js'
import { loadGraph } from '../runtime/serve.js'
import { findPackageRoot } from '../shared/package-metadata.js'
import { resolveMadarWorkspace } from '../shared/workspace.js'

interface TrialIo {
  log(message?: string): void
  error(message?: string): void
}

interface TrialWorkspaceSuccess {
  status: 'success'
  workspace: string
  graphPath: string
  packOutput: string
  notes: string[]
}

interface TrialWorkspaceFailure {
  status: 'failure'
  workspace: string
  reason: string
  notes: string[]
  fallbackEligible: boolean
}

type TrialWorkspaceResult = TrialWorkspaceSuccess | TrialWorkspaceFailure

export interface TryCommandDependencies {
  generateGraph: typeof generateIndex
  runContextPack: (context: { options: PackCliOptions; io: TrialIo }) => Promise<string | void> | string | void
  analyzeFreshness: (graphPath: string) => GraphContextFreshness
  summarizeGraph: (graphPath: string) => GraphSummary
  resolvePackageRoot: () => string
  pathExists: (path: string) => boolean
  readNodeMajorVersion: () => number
  defaultInstallPlatform: () => InstallPlatform
}

const DEFAULT_DEPENDENCIES: TryCommandDependencies = {
  generateGraph: generateIndex,
  runContextPack: async ({ options }) => await runContextPackCommand(options),
  analyzeFreshness: (graphPath) => analyzeGraphContextFreshness(graphPath),
  summarizeGraph: (graphPath) => buildGraphSummary(loadGraph(graphPath)),
  resolvePackageRoot: () => findPackageRoot(),
  pathExists: (path) => existsSync(path),
  readNodeMajorVersion: () => Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
  defaultInstallPlatform: () => defaultInstallPlatform(),
}

const TRY_PACK_BUDGET = 3000
const MIN_TRIAL_NODES = 10
const GETTING_STARTED_URL = 'https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md'

function trialGraphPath(workspace: string): string {
  return resolveMadarWorkspace(workspace).graphPath
}

function isReusableFreshnessStatus(status: GraphContextFreshness['status']): boolean {
  return status === 'fresh'
}

function tooSmallReason(nodeCount: number): string | null {
  if (nodeCount >= MIN_TRIAL_NODES) {
    return null
  }

  return `Current repo graph is too small for a useful first-run result (${nodeCount} nodes; need at least ${MIN_TRIAL_NODES}).`
}

function isFallbackEligibleGenerateError(error: unknown): boolean {
  return error instanceof GenerateUnsupportedCorpusError
}

function recommendInstallPlatform(workspace: string, dependencies: TryCommandDependencies): InstallPlatform {
  const hints: Array<{ path: string; platform: InstallPlatform }> = [
    { path: join(workspace, '.cursor'), platform: 'cursor' },
    { path: join(workspace, '.copilot'), platform: 'copilot' },
    { path: join(workspace, '.gemini'), platform: 'gemini' },
    { path: join(workspace, 'GEMINI.md'), platform: 'gemini' },
    { path: join(workspace, '.claude'), platform: 'claude' },
    { path: join(workspace, 'CLAUDE.md'), platform: 'claude' },
  ]

  const hintedPlatform = hints.find((hint) => dependencies.pathExists(hint.path))
  return hintedPlatform?.platform ?? dependencies.defaultInstallPlatform()
}

function buildPackOptions(prompt: string, graphPath: string): PackCliOptions {
  return {
    prompt,
    budget: TRY_PACK_BUDGET,
    task: 'explain',
    graphPath,
    format: 'text',
  }
}

async function runPackForWorkspace(
  workspace: string,
  prompt: string,
  graphPath: string,
  notes: string[],
  io: TrialIo,
  dependencies: TryCommandDependencies,
): Promise<TrialWorkspaceSuccess> {
  const packOutput = await dependencies.runContextPack({
    options: buildPackOptions(prompt, graphPath),
    io,
  })

  return {
    status: 'success',
    workspace,
    graphPath,
    packOutput: String(packOutput ?? ''),
    notes,
  }
}

function formatTrialOutput(
  result: TrialWorkspaceSuccess,
  installPlatform: InstallPlatform,
  primaryWorkspace: string,
  fallbackReason?: string,
): string {
  const lines = [`[madar try] ${result.workspace === primaryWorkspace ? 'Local proof ready.' : 'Local proof ready from the bundled sample workspace.'}`]

  if (fallbackReason) {
    lines.push(`[madar try] ${fallbackReason}`)
    lines.push(`[madar try] Falling back to ${result.workspace}.`)
  }

  lines.push(...result.notes)
  lines.push('')
  if (result.packOutput.trim().length > 0) {
    lines.push(result.packOutput.trim())
    lines.push('')
  }
  lines.push('[madar try] Next recommended install:')
  lines.push(`  madar ${installPlatform} install`)
  return lines.join('\n')
}

async function prepareWorkspace(
  workspace: string,
  prompt: string,
  io: TrialIo,
  dependencies: TryCommandDependencies,
): Promise<TrialWorkspaceResult> {
  const graphPath = trialGraphPath(workspace)
  const notes: string[] = []
  let reuseExistingGraph = false

  if (dependencies.pathExists(graphPath)) {
    try {
      const freshness = dependencies.analyzeFreshness(graphPath)
      if (isReusableFreshnessStatus(freshness.status)) {
        const summary = dependencies.summarizeGraph(graphPath)
        const graphTooSmall = tooSmallReason(summary.node_count)
        if (graphTooSmall) {
          return {
            status: 'failure',
            workspace,
            reason: graphTooSmall,
            notes,
            fallbackEligible: true,
          }
        }

        notes.push(`[madar try] Reusing ${graphPath} (${graphFreshnessStatusLabel(freshness.status)}).`)
        reuseExistingGraph = true
      } else {
        notes.push(`[madar try] Existing graph is ${graphFreshnessStatusLabel(freshness.status)}; rebuilding ${workspace}.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notes.push(`[madar try] Existing graph could not be read (${message}); rebuilding ${workspace}.`)
    }

    if (reuseExistingGraph) {
      return await runPackForWorkspace(workspace, prompt, graphPath, notes, io, dependencies)
    }
  } else {
    notes.push(`[madar try] No graph found at ${graphPath}; building one now.`)
  }

  try {
    const result = dependencies.generateGraph(workspace, {})
    const graphTooSmall = tooSmallReason(result.nodeCount)
    if (graphTooSmall) {
      return {
        status: 'failure',
        workspace,
        reason: graphTooSmall,
        notes,
        fallbackEligible: true,
      }
    }

    notes.push(`[madar try] Built ${result.graphPath} with ${result.nodeCount} nodes for a local first proof.`)
    return await runPackForWorkspace(workspace, prompt, result.graphPath, notes, io, dependencies)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: 'failure',
      workspace,
      reason,
      notes,
      fallbackEligible: isFallbackEligibleGenerateError(error),
    }
  }
}

function sampleWorkspacePath(dependencies: TryCommandDependencies): string {
  return resolve(dependencies.resolvePackageRoot(), 'examples', 'sample-workspace')
}

function fallbackUnavailableMessage(reason: string): string {
  return `${reason}\nPackaged sample workspace is not available in this install. Follow the first-run tutorial: ${GETTING_STARTED_URL}`
}

export async function runTryCommand(
  options: TryCliOptions,
  io: TrialIo,
  dependencies: TryCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const nodeMajorVersion = dependencies.readNodeMajorVersion()
  if (!Number.isFinite(nodeMajorVersion) || nodeMajorVersion < 20) {
    throw new Error(`madar try requires Node.js 20+; detected Node.js ${nodeMajorVersion}.`)
  }

  const primaryWorkspace = resolve(options.path)
  const primaryResult = await prepareWorkspace(primaryWorkspace, options.prompt, io, dependencies)
  if (primaryResult.status === 'success') {
    return formatTrialOutput(primaryResult, recommendInstallPlatform(primaryWorkspace, dependencies), primaryWorkspace)
  }

  if (!primaryResult.fallbackEligible) {
    throw new Error(primaryResult.reason)
  }

  const sampleWorkspace = sampleWorkspacePath(dependencies)
  if (sampleWorkspace === primaryWorkspace || !dependencies.pathExists(sampleWorkspace)) {
    throw new Error(fallbackUnavailableMessage(primaryResult.reason))
  }

  const sampleResult = await prepareWorkspace(sampleWorkspace, options.prompt, io, dependencies)
  if (sampleResult.status === 'failure') {
    throw new Error(`${primaryResult.reason}\n${sampleResult.reason}`)
  }

  return formatTrialOutput(sampleResult, recommendInstallPlatform(primaryWorkspace, dependencies), primaryWorkspace, primaryResult.reason)
}
