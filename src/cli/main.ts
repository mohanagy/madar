import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import { loadGraphArtifact } from '../adapters/filesystem/graph-artifact.js'
import {
  retrieveContext,
  serializeRetrieveContextResult,
} from '../application/retrieve-context.js'
import { inspectQueryIndex } from '../domain/query/index-status.js'
import { loadBenchmarkQuestions, type BenchmarkResult, printBenchmark, runBenchmark } from '../infrastructure/benchmark.js'
import { runBenchmarkSuite } from '../infrastructure/benchmark/suite.js'
import { evaluateRetrievalQuality, formatQualityReport } from '../infrastructure/benchmark/quality.js'
import { runCompareCommand } from '../infrastructure/compare.js'
import { buildDoctorReport, runDoctorCommand, runStatusCommand } from '../infrastructure/doctor.js'
import { federate } from '../pipeline/federate.js'
import { generateIndex, type GenerateIndexResult, type ProgressStep } from '../application/generate-index.js'
import { updateIndex } from '../application/update-index.js'
import { install as installHooks, status as hookStatus, uninstall as uninstallHooks } from '../infrastructure/hooks.js'
import {
  agentsInstall,
  agentsUninstall,
  claudeInstall,
  claudeUninstall,
  cursorInstall,
  cursorUninstall,
  defaultInstallPlatform,
  geminiInstall,
  geminiUninstall,
  installCopilotMcp,
  installSkill,
  isAgentPlatform,
  type AgentPlatform,
  uninstallCopilotMcp,
  uninstallSkill,
} from '../infrastructure/install.js'
import { pushGraphToNeo4j } from '../infrastructure/neo4j.js'
import { watchIndex } from '../infrastructure/watch-index.js'
import { diffGraphs } from '../runtime/diff.js'
import { buildGraphSummary, type GraphSummary } from '../runtime/graph-summary.js'
import { serveGraphStdio } from '../runtime/stdio-server.js'
import { findPackageRoot, readPackageName, readPackageVersion } from '../shared/package-metadata.js'
import { resolveWorkspaceGraphPath } from '../shared/workspace.js'
import {
  disableTelemetry,
  enableTelemetry,
  formatTelemetryStatus,
  graphSizeBucketFromNodeCount,
  getTelemetryStatus,
  readTelemetryReport,
  clearTelemetry,
  recordTelemetryEvent as persistTelemetryEvent,
  repoSizeBucketFromFileCount,
  type TelemetryFailureBucket,
  type TelemetryEventInput,
  type TelemetryStatusBucket,
} from '../shared/telemetry.js'
import { getUpdateNotification } from '../shared/update-notifier.js'
import {
  parseBenchmarkArgs,
  parseBenchSuiteArgs,
  type BenchSuiteCliOptions,
  type BenchmarkCliOptions,
  parseCompareArgs,
  parseDoctorArgs,
  parseDiffArgs,
  parseGenerateArgs,
  parseHookArgs,
  parseInstallArgs,
  parsePlatformActionArgs,
  parseQueryArgs,
  parseSummaryArgs,
  parseServeArgs,
  parseTelemetryArgs,
  parseWatchArgs,
  type CompareCliOptions,
  UsageError,
} from './parser.js'

export interface CliIO {
  log(message?: string): void
  error(message?: string): void
}

export interface CompareCommandContext {
  options: CompareCliOptions
  io: CliIO
  confirm(message: string): Promise<boolean>
}

export interface BenchmarkCommandContext {
  options: BenchmarkCliOptions
  io: CliIO
}

export interface BenchSuiteCommandContext {
  options: BenchSuiteCliOptions
  io: CliIO
}

export interface EvalCommandContext {
  options: BenchmarkCliOptions
  io: CliIO
}

export interface CliDependencies {
  loadGraph: typeof loadGraphArtifact
  inspectQueryIndex: typeof inspectQueryIndex
  retrieveContext: typeof retrieveContext
  runBenchmark: (context: BenchmarkCommandContext) => Promise<BenchmarkResult> | BenchmarkResult
  runBenchSuite: (context: BenchSuiteCommandContext) => Promise<string | void> | string | void
  runEval: (context: EvalCommandContext) => Promise<string | void> | string | void
  runCompare: (context: CompareCommandContext) => Promise<string | void> | string | void
  runDoctor: (graphPath: string) => string
  runStatus: (graphPath: string) => string
  runGraphSummary?: (graphPath: string) => Promise<GraphSummary> | GraphSummary
  confirm: (message: string) => Promise<boolean>
  printBenchmark: (result: BenchmarkResult) => void
  installHooks: typeof installHooks
  uninstallHooks: typeof uninstallHooks
  hookStatus: typeof hookStatus
  geminiInstall: typeof geminiInstall
  geminiUninstall: typeof geminiUninstall
  installSkill: typeof installSkill
  uninstallSkill: typeof uninstallSkill
  cursorInstall: typeof cursorInstall
  cursorUninstall: typeof cursorUninstall
  installCopilotMcp: typeof installCopilotMcp
  uninstallCopilotMcp: typeof uninstallCopilotMcp
  pushGraphToNeo4j: typeof pushGraphToNeo4j
  generateGraph: typeof generateIndex
  updateIndex: typeof updateIndex
  watchGraph: typeof watchIndex
  serveGraphStdio: typeof serveGraphStdio
  claudeInstall: typeof claudeInstall
  claudeUninstall: typeof claudeUninstall
  agentsInstall: typeof agentsInstall
  agentsUninstall: typeof agentsUninstall
  notifyUpdate?: () => Promise<string | null> | string | null
  readInstalledVersion?: () => string
  enableTelemetry?: () => string
  disableTelemetry?: () => string
  readTelemetryStatus?: () => string
  clearTelemetry?: () => string
  readTelemetryReport?: (spoolPaths?: string[]) => string
  readDoctorTelemetryBucket?: (graphPath: string) => TelemetryStatusBucket
  readStatusTelemetryBucket?: (graphPath: string) => TelemetryStatusBucket
  recordTelemetryEvent?: (event: TelemetryEventInput) => void
}

const COMPARE_WARNING_MESSAGE = 'compare will execute one baseline prompt and one madar prompt. This may consume paid model tokens.'

const BENCHMARK_WARNING_MESSAGE = 'benchmark will execute the benchmark/eval runner. This may consume paid model tokens.'
const BENCH_SUITE_WARNING_MESSAGE = 'bench:suite will execute baseline and madar suite prompts. This may consume paid model tokens.'
const EVAL_WARNING_MESSAGE = 'eval will execute the benchmark/eval runner. This may consume paid model tokens.'

const DEFAULT_DEPENDENCIES: CliDependencies = {
  loadGraph: loadGraphArtifact,
  inspectQueryIndex,
  retrieveContext,
  runBenchmark: ({ options }) => {
    const questions = options.questionsPath ? loadBenchmarkQuestions(options.questionsPath) : undefined
    return runBenchmark(options.graphPath, undefined, questions, { execTemplate: options.execTemplate })
  },
  runBenchSuite: async ({ options }) => {
    const result = await runBenchmarkSuite(options)
    return result.text
  },
  runEval: async ({ options }) => {
    const graph = loadGraphArtifact(options.graphPath)
    const questions = options.questionsPath ? loadBenchmarkQuestions(options.questionsPath) : undefined
    const report = await evaluateRetrievalQuality(graph, questions, 3000, {
      graphPath: options.graphPath,
      execTemplate: options.execTemplate,
    })
    return formatQualityReport(report)
  },
  runCompare: async ({ options }) => {
    return await runCompareCommand({
      graphPath: options.graphPath,
      question: options.question,
      outputDir: options.outputDir,
      execTemplate: options.execTemplate,
      perArmTimeoutSeconds: options.perArmTimeoutSeconds,
    })
  },
  runDoctor: (graphPath) => runDoctorCommand({ graphPath }),
  runStatus: (graphPath) => runStatusCommand({ graphPath }),
  runGraphSummary: (graphPath) => buildGraphSummary(loadGraphArtifact(graphPath)),
  confirm: async (message) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new UsageError('error: compare requires --yes in non-interactive mode.')
    }
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    try {
      const answer = await readline.question(`${message} [y/N] `)
      return /^y(?:es)?$/i.test(answer.trim())
    } finally {
      readline.close()
    }
  },
  printBenchmark,
  installHooks,
  uninstallHooks,
  hookStatus,
  geminiInstall,
  geminiUninstall,
  installSkill,
  uninstallSkill,
  cursorInstall,
  cursorUninstall,
  installCopilotMcp,
  uninstallCopilotMcp,
  pushGraphToNeo4j,
  generateGraph: generateIndex,
  updateIndex,
  watchGraph: watchIndex,
  serveGraphStdio,
  claudeInstall,
  claudeUninstall,
  agentsInstall,
  agentsUninstall,
  notifyUpdate: async () => await getUpdateNotification({
    packageName: readPackageName(findPackageRoot()),
    currentVersion: readPackageVersion(findPackageRoot()),
  }),
  readInstalledVersion: () => readPackageVersion(findPackageRoot()),
  enableTelemetry: () => enableTelemetry(),
  disableTelemetry: () => disableTelemetry(),
  readTelemetryStatus: () => formatTelemetryStatus(getTelemetryStatus()),
  clearTelemetry: () => clearTelemetry(),
  readTelemetryReport: (spoolPaths) => readTelemetryReport({}, spoolPaths),
  readDoctorTelemetryBucket: (graphPath) => buildDoctorReport({ graphPath }).healthy ? 'healthy' : 'attention_needed',
  readStatusTelemetryBucket: (graphPath) => buildDoctorReport({ graphPath }).healthy ? 'healthy' : 'attention_needed',
  recordTelemetryEvent: (event) => {
    persistTelemetryEvent(event)
  },
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatProgress(progress: ProgressStep): string {
  const prefix = `[madar ${progress.step}]`
  if (progress.step === 'index' && progress.current !== undefined && progress.total !== undefined && progress.total > 0) {
    return `${prefix} ${progress.message} (${progress.current}/${progress.total})`
  }
  return `${prefix} ${progress.message}`
}

function readInstalledVersionForTelemetry(dependencies: CliDependencies): string {
  const readInstalledVersion = dependencies.readInstalledVersion ?? (() => readPackageVersion(findPackageRoot()))
  return readInstalledVersion()
}

function readNodeMajorForTelemetry(): number {
  const major = Number.parseInt(process.versions.node.split('.', 1)[0] ?? '', 10)
  return Number.isInteger(major) && major > 0 ? major : 0
}

function emitTelemetry(io: CliIO, dependencies: CliDependencies, buildEvent: () => TelemetryEventInput): void {
  if (!dependencies.recordTelemetryEvent) {
    return
  }
  try {
    dependencies.recordTelemetryEvent(buildEvent())
  } catch (error) {
    io.error(`[madar telemetry] ${messageFromError(error)}`)
  }
}

function repoSizeBucketForGraph(dependencies: CliDependencies, graphPath: string) {
  return repoSizeBucketFromFileCount(buildGraphSummary(dependencies.loadGraph(graphPath)).file_count)
}

function graphSizeBucketForGraph(dependencies: CliDependencies, graphPath: string) {
  return graphSizeBucketFromNodeCount(buildGraphSummary(dependencies.loadGraph(graphPath)).node_count)
}

function telemetryBase(dependencies: CliDependencies) {
  return {
    version: readInstalledVersionForTelemetry(dependencies),
    os: process.platform,
    nodeMajor: readNodeMajorForTelemetry(),
  } as const
}

function classifyTelemetryFailure(error: unknown): TelemetryFailureBucket {
  const message = messageFromError(error).toLowerCase()
  if (message.includes('invalid params')) {
    return 'invalid_params'
  }
  if (message.includes('graph file not found') || message.includes('out/graph.json not found') || message.includes('graph.json not found')) {
    return 'missing_graph'
  }
  if (message.includes('unsupported corpus')) {
    return 'unsupported_corpus'
  }
  if (message.includes('install')) {
    return 'install_error'
  }
  return error instanceof UsageError ? 'usage_error' : 'unknown'
}

async function confirmPaidCommand(
  commandName: string,
  warningMessage: string,
  cancelledMessage: string,
  yes: boolean,
  io: CliIO,
  dependencies: CliDependencies,
): Promise<boolean> {
  if (yes) {
    return true
  }

  io.log(`Warning: ${warningMessage}`)

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError(`error: ${commandName} requires --yes in non-interactive mode.`)
  }

  if (!(await dependencies.confirm(warningMessage))) {
    io.log(cancelledMessage)
    return false
  }

  return true
}

export function formatHelp(binaryName = 'madar'): string {
  return [
    `Usage: ${binaryName} <command>`,
    '',
    'Run with --help or -h to see this message, or --version / -v to print the installed version.',
    '',
    'Commands:',
    '  generate [path]       build canonical graph artifacts for a folder (default .)',
    '    --update             reuse an unchanged graph; reconcile changed source',
    '    --cluster-only       re-cluster an existing graph without re-indexing source',
    '    --watch              keep the graph reconciled after generation',
    '    --follow-symlinks    include in-root symlink targets',
    '    --respect-gitignore  exclude files ignored by Git',
    '    --strict-indexing    fail when any candidate is failed or unsupported',
    '    --max-indexing-failed N       permit N failed candidates (enables strict mode)',
    '    --max-indexing-unsupported N  permit N unsupported candidates (enables strict mode)',
    '    --debounce S         watch debounce seconds (default 3)',
    '    --no-html            accepted as a no-op; Core Reset emits no HTML graph',
    '    --neo4j-push URI     also push the generated graph to Neo4j',
    '    --neo4j-user USER    Neo4j username',
    '    --neo4j-password PW  Neo4j password',
    '    --neo4j-database DB  Neo4j database',
    '  watch [path]          generate and keep the canonical graph reconciled',
    '  serve [graph.json]    serve the single retrieve tool over MCP stdio',
    '    --stdio / --mcp      explicit stdio aliases',
    '    --auto-refresh       reconcile the graph while serving',
    '  query "<question>"     retrieve authenticated evidence as canonical JSON',
    '    --budget N            positive requested budget (effective cap 4000)',
    '    --graph PATH          graph artifact (default out/graph.json)',
    '  diff <baseline.json>  compare two canonical graph snapshots',
    '    --graph PATH          current graph (default out/graph.json)',
    '    --limit N             maximum items per section (default 10)',
    '  summary [graph.json]  print a deterministic graph summary as JSON',
    '  federate <g1> <g2>... merge canonical graphs into one',
    '    --output DIR         output directory (default out-federated)',
    '  benchmark [graph.json] run benchmark questions through the configured model runner',
    '    --exec TEMPLATE      required prompt-runner command template',
    '    --questions PATH     alternate benchmark questions',
    '    --yes                skip paid-run confirmation',
    '  bench:suite           run the reproducible benchmark matrix',
    '  eval [graph.json]      measure retrieval quality through the benchmark runner',
    '  compare [question]    run baseline vs Madar evidence comparison',
    '  doctor [graph.json]   diagnose graph and agent wiring',
    '  status [graph.json]   print compact graph and agent readiness',
    '  install [platform]    install a platform skill or local Madar config',
    '  hook <action>         install, uninstall, or inspect rebuild-reminder hooks',
    '  telemetry <action>    enable, disable, inspect, clear, or report local telemetry',
    '  aider <install|uninstall>',
    '  claude <install|uninstall>',
    '  cursor <install|uninstall>',
    '  gemini <install|uninstall>',
    '  copilot <install|uninstall>',
    '  codex <install|uninstall>',
    '  opencode <install|uninstall>',
    '  claw <install|uninstall>',
    '  droid <install|uninstall>',
    '  trae <install|uninstall>',
    '  trae-cn <install|uninstall>',
    '',
    `Tip: '${binaryName} . --update' is treated like '${binaryName} generate . --update'.`,
    '',
  ].join('\n')
}

function isGenerateLikeArgument(argument: string): boolean {
  return (
    argument === '--update' ||
    argument === '--cluster-only' ||
    argument === '--watch' ||
    argument === '--follow-symlinks' ||
    argument === '--respect-gitignore' ||
    argument === '--neo4j-push' ||
    argument === '--neo4j-user' ||
    argument === '--neo4j-password' ||
    argument === '--neo4j-database' ||
    argument === '--debounce' ||
    argument === '--strict-indexing' ||
    argument === '--max-indexing-failed' ||
    argument === '--max-indexing-unsupported' ||
    argument.startsWith('--neo4j-push=') ||
    argument.startsWith('--neo4j-user=') ||
    argument.startsWith('--neo4j-password=') ||
    argument.startsWith('--neo4j-database=') ||
    argument.startsWith('--debounce=') ||
    argument.startsWith('--max-indexing-failed=') ||
    argument.startsWith('--max-indexing-unsupported=')
  )
}

function isImplicitGenerateCommand(argument: string): boolean {
  if (isGenerateLikeArgument(argument)) {
    return true
  }

  if (argument.startsWith('--')) {
    return false
  }

  return existsSync(argument)
}

function formatGenerateSummary(result: GenerateIndexResult): string {
  const indexingLines = result.indexing
    ? [
        `- Indexing: ${result.indexing.state.toUpperCase()} (${result.indexing.counts.indexed} indexed, ${result.indexing.counts.indexed_with_warnings} warnings, ${result.indexing.counts.skipped_by_policy} policy skips, ${result.indexing.counts.unsupported} unsupported, ${result.indexing.counts.failed} failed)`,
        ...(result.indexingManifestPath ? [`- Derived indexing diagnostics: ${result.indexingManifestPath}`] : []),
      ]
    : []
  const lines = [
    `[madar generate] ${result.mode} completed for ${result.rootPath}`,
    `- Corpus: ${result.totalFiles} file(s) · ~${result.totalWords.toLocaleString()} words`,
    `- Indexed: ${result.indexedFiles}/${result.totalFiles} JavaScript/TypeScript file(s)`,
    `- Graph: ${result.nodeCount} nodes · ${result.edgeCount} edges · ${result.communityCount} communities`,
    ...indexingLines,
    ...(typeof result.semanticAnomalyCount === 'number' ? [`- Semantic anomalies: ${result.semanticAnomalyCount} high-signal item(s)`] : []),
    `- Outputs: ${result.graphPath}, ${result.reportPath}`,
  ]
  if (result.updateReceipt) {
    const receipt = result.updateReceipt
    lines.push(
      `- Update: mode=${receipt.mode}, scanned=${receipt.scanned_files}, parsed=${receipt.parsed_files}, reused=${receipt.reused_files}, invalidated=${receipt.invalidated_files}, closure=${receipt.dependency_closure_size}`,
      `- Publication: fallback=${receipt.fallback_reason ?? 'none'}, previous=${receipt.previous_build_id ?? 'none'}, accepted=${receipt.accepted_build_id}, advanced=${receipt.publication_advanced}`,
    )
  }

  if (result.discoverySafety && result.discoverySafety.summary.total > 0) {
    lines.push(
      `- Safety exclusions: ${result.discoverySafety.summary.total} (${result.discoverySafety.summary.sensitive} sensitive, ${result.discoverySafety.summary.unreadable} unreadable)`,
    )
    for (const exclusion of result.discoverySafety.exclusions.slice(0, 20)) {
      lines.push(`  - ${JSON.stringify(exclusion.path)} (${exclusion.reason})`)
    }
    const exclusionCount = result.discoverySafety.exclusions.length
    if (exclusionCount > 20) {
      lines.push(`  - ... ${exclusionCount - 20} more; inspect graph.json discovery_safety.exclusions`)
    }
  }

  if (result.warning) {
    lines.push(`- Warning: ${result.warning}`)
  }

  for (const note of result.notes) {
    lines.push(`- Note: ${note}`)
  }

  lines.push('')
  lines.push('Next: connect your AI assistant:')
  lines.push('  madar claude install    # Claude Code')
  lines.push('  madar codex install     # Codex CLI')
  lines.push('  madar cursor install    # Cursor')
  lines.push('  madar copilot install   # GitHub Copilot')
  lines.push('  madar gemini install    # Gemini CLI')

  return lines.join('\n')
}

function handleAgentCommand(command: AgentPlatform, args: string[], io: CliIO, dependencies: CliDependencies): number {
  const options = parsePlatformActionArgs(command, args)
  if (options.action === 'install') {
    emitTelemetry(io, dependencies, () => ({
      command: 'install',
      stage: 'started',
      ...telemetryBase(dependencies),
      agentTarget: command,
    }))
    try {
      io.log(dependencies.agentsInstall('.', command))
      emitTelemetry(io, dependencies, () => ({
        command: 'install',
        stage: 'succeeded',
        ...telemetryBase(dependencies),
        agentTarget: command,
      }))
      return 0
    } catch (error) {
      emitTelemetry(io, dependencies, () => ({
        command: 'install',
        stage: 'failed',
        ...telemetryBase(dependencies),
        agentTarget: command,
        failureBucket: classifyTelemetryFailure(error),
      }))
      throw error
    }
  }

  io.log(dependencies.agentsUninstall('.', command))
  return 0
}

function warnWhenWorkspaceGraphIsMissing(io: CliIO): void {
  if (!existsSync(resolveWorkspaceGraphPath())) {
    io.log("Warning: out/graph.json not found. Run 'madar generate .' first, then re-run this command.")
  }
}

export async function executeCli(argv: string[], io: CliIO = console, dependencies: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
  const [command, ...args] = argv

  if (!command || command === '-h' || command === '--help') {
    io.log(formatHelp())
    return 0
  }

  let failureTelemetry: ((bucket: TelemetryFailureBucket) => TelemetryEventInput) | null = null
  try {
    if (command === '-v' || command === '--version') {
      const readInstalledVersion = dependencies.readInstalledVersion ?? (() => readPackageVersion(findPackageRoot()))
      io.log(readInstalledVersion())
      return 0
    }

    if (!args.includes('--json') && dependencies.notifyUpdate) {
      try {
        const updateNotice = await dependencies.notifyUpdate()
        if (updateNotice) {
          io.log(updateNotice)
        }
      } catch {
        // Update checks are best-effort and must never block the CLI command itself.
      }
    }

    if (command === 'compare') {
      const options = parseCompareArgs(args)
      failureTelemetry = (failureBucket) => ({
        command: 'compare',
        stage: 'failed',
        ...telemetryBase(dependencies),
        failureBucket,
      })
      const confirm = async (message: string) => await dependencies.confirm(message)
      const warningMessage = COMPARE_WARNING_MESSAGE
      if (!options.yes) {
        io.log(`Warning: ${warningMessage}`)
        if (!(await confirm(warningMessage))) {
          io.log('Compare cancelled.')
          return 1
        }
      }
      const output = await dependencies.runCompare({
        options,
        io,
        confirm,
      })
      if (output !== undefined) {
        io.log(output)
      }
      emitTelemetry(io, dependencies, () => ({
        command: 'compare',
        stage: 'succeeded',
        ...telemetryBase(dependencies),
        repoSizeBucket: repoSizeBucketForGraph(dependencies, options.graphPath),
      }))
      return 0
    }


    if (command === 'doctor') {
      const options = parseDoctorArgs(args, 'doctor')
      failureTelemetry = (failureBucket) => ({
        command: 'doctor',
        stage: 'failed',
        ...telemetryBase(dependencies),
        failureBucket,
      })
      io.log(dependencies.runDoctor(options.graphPath))
      emitTelemetry(io, dependencies, () => ({
        command: 'doctor',
        stage: 'succeeded',
        ...telemetryBase(dependencies),
        statusBucket: (dependencies.readDoctorTelemetryBucket ?? ((graphPath: string) => buildDoctorReport({ graphPath }).healthy ? 'healthy' : 'attention_needed'))(options.graphPath),
      }))
      return 0
    }

    if (command === 'status') {
      const options = parseDoctorArgs(args, 'status')
      failureTelemetry = (failureBucket) => ({
        command: 'status',
        stage: 'failed',
        ...telemetryBase(dependencies),
        failureBucket,
      })
      io.log(dependencies.runStatus(options.graphPath))
      emitTelemetry(io, dependencies, () => ({
        command: 'status',
        stage: 'succeeded',
        ...telemetryBase(dependencies),
        statusBucket: (dependencies.readStatusTelemetryBucket ?? ((graphPath: string) => buildDoctorReport({ graphPath }).healthy ? 'healthy' : 'attention_needed'))(options.graphPath),
      }))
      return 0
    }

    if (command === 'summary') {
      const options = parseSummaryArgs(args)
      const runGraphSummary = dependencies.runGraphSummary
        ?? ((graphPath: string) => buildGraphSummary(dependencies.loadGraph(graphPath)))
      io.log(JSON.stringify(await runGraphSummary(options.graphPath), null, 2))
      return 0
    }

    if (command === 'telemetry') {
      const options = parseTelemetryArgs(args)
      if (options.action === 'enable') {
        io.log((dependencies.enableTelemetry ?? (() => enableTelemetry()))())
        return 0
      }
      if (options.action === 'disable') {
        io.log((dependencies.disableTelemetry ?? (() => disableTelemetry()))())
        return 0
      }
      if (options.action === 'clear') {
        io.log((dependencies.clearTelemetry ?? (() => clearTelemetry()))())
        return 0
      }
      if (options.action === 'report') {
        io.log((dependencies.readTelemetryReport
          ?? ((spoolPaths?: string[]) => readTelemetryReport({}, spoolPaths)))(
          options.spoolPaths,
        ))
        return 0
      }
      io.log((dependencies.readTelemetryStatus
        ?? (() => formatTelemetryStatus(getTelemetryStatus())))())
      return 0
    }

    if (command === 'generate'
      || (command !== undefined
        && !isAgentPlatform(command)
        && isImplicitGenerateCommand(command))) {
      const generateArgs = command === 'generate' ? args : [command, ...args]
      const options = parseGenerateArgs(generateArgs)
      failureTelemetry = (failureBucket) => ({
        command: 'generate',
        stage: 'failed',
        ...telemetryBase(dependencies),
        failureBucket,
      })
      emitTelemetry(io, dependencies, () => ({
        command: 'generate',
        stage: 'started',
        ...telemetryBase(dependencies),
      }))
      const generate = options.update
        ? dependencies.updateIndex
        : dependencies.generateGraph
      const result = generate(options.path, {
        clusterOnly: options.clusterOnly,
        ...(options.followSymlinks === undefined
          ? {}
          : { followSymlinks: options.followSymlinks }),
        ...(options.respectGitignore === undefined
          ? {}
          : { respectGitignore: options.respectGitignore }),
        ...(options.strictIndexing
          ? {
              indexingStrict: {
                maxFailed: options.maxIndexingFailed,
                maxUnsupported: options.maxIndexingUnsupported,
              },
            }
          : {}),
        onProgress: (step) => io.log(formatProgress(step)),
      })
      io.log(formatGenerateSummary(result))

      if (options.neo4jPushUri) {
        const graph = dependencies.loadGraph(result.graphPath)
        const pushResult = await dependencies.pushGraphToNeo4j(graph, {
          uri: options.neo4jPushUri,
          user: options.neo4jUser,
          password: options.neo4jPassword,
          database: options.neo4jDatabase,
          projectRoot: result.rootPath,
        })
        io.log(
          `[madar neo4j] Pushed ${pushResult.nodes} nodes and ${pushResult.edges} edges to ${pushResult.uri} (database ${pushResult.database})`,
        )
      }

      emitTelemetry(io, dependencies, () => ({
        command: 'generate',
        stage: 'succeeded',
        ...telemetryBase(dependencies),
        repoSizeBucket: repoSizeBucketFromFileCount(result.totalFiles),
        graphSizeBucket: graphSizeBucketFromNodeCount(result.nodeCount),
      }))
      if (options.watch) {
        await dependencies.watchGraph(options.path, options.debounceSeconds, {
          ...(options.followSymlinks === undefined
            ? {}
            : { followSymlinks: options.followSymlinks }),
          ...(options.respectGitignore === undefined
            ? {}
            : { respectGitignore: options.respectGitignore }),
          ...(options.strictIndexing
            ? {
                indexingStrict: {
                  maxFailed: options.maxIndexingFailed,
                  maxUnsupported: options.maxIndexingUnsupported,
                },
              }
            : {}),
          logger: io,
          seed: result,
        })
      }
      return 0
    }
    if (command === 'watch') {
      const options = parseWatchArgs(args)
      const result = dependencies.generateGraph(options.path, {
        followSymlinks: options.followSymlinks,
        respectGitignore: options.respectGitignore,
        onProgress: (step) => io.log(formatProgress(step)),
      })
      io.log(formatGenerateSummary(result))
      await dependencies.watchGraph(options.path, options.debounceSeconds, {
        followSymlinks: options.followSymlinks,
        respectGitignore: options.respectGitignore,
        logger: io,
        seed: result,
      })
      return 0
    }

    if (command === 'federate') {
      if (args.length === 0) {
        throw new UsageError('Usage: madar federate <graph1.json> <graph2.json> ... [--output DIR]')
      }

      const graphPaths: string[] = []
      let outputDir: string | undefined

      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]
        if (!argument) {
          continue
        }
        if (argument === '--output' || argument === '--output-dir') {
          outputDir = args[index + 1]
          index += 1
          continue
        }
        if (argument.startsWith('--output=') || argument.startsWith('--output-dir=')) {
          const [, value] = argument.split('=', 2)
          outputDir = value
          continue
        }
        graphPaths.push(argument)
      }

      const result = federate(graphPaths, { outputDir })
      io.log([
        `[madar federate] merged ${result.repos.length} repos: ${result.repos.join(', ')}`,
        `- Graph: ${result.totalNodes} nodes · ${result.totalEdges} edges · ${result.communityCount} communities`,
        `- Cross-repo edges: ${result.crossRepoEdges} inferred connections`,
        `- Outputs: ${result.graphPath}, ${result.reportPath}`,
      ].join('\n'))
      return 0
    }

    if (command === 'serve') {
      const options = parseServeArgs(args)
      const graphPath = resolveWorkspaceGraphPath(options.graphPath)
      await dependencies.serveGraphStdio({
        graphPath,
        ...(options.autoRefresh
          ? { autoRefresh: true, workspaceRoot: process.cwd() }
          : {}),
        logger: io,
      })
      return 0
    }

    if (command === 'query') {
      const options = parseQueryArgs(args)
      const graph = dependencies.loadGraph(options.graphPath)
      const result = dependencies.retrieveContext(
        dependencies.inspectQueryIndex(graph),
        {
          question: options.question,
          ...(options.budget === undefined ? {} : { budget: options.budget }),
        },
      )
      io.log(serializeRetrieveContextResult(result))
      return 0
    }

    if (command === 'diff') {
      const options = parseDiffArgs(args)
      const baselineGraph = dependencies.loadGraph(options.baselineGraphPath)
      const graph = dependencies.loadGraph(options.graphPath)
      io.log(diffGraphs(baselineGraph, graph, { limit: options.limit }))
      return 0
    }

    if (command === 'benchmark') {
      const options = parseBenchmarkArgs(args)
      if (!(await confirmPaidCommand('benchmark', BENCHMARK_WARNING_MESSAGE, 'Benchmark cancelled.', options.yes, io, dependencies))) {
        return 1
      }
      const result = await dependencies.runBenchmark({ options, io })
      dependencies.printBenchmark(result)
      return 0
    }

    if (command === 'bench:suite') {
      const options = parseBenchSuiteArgs(args)
      if (!options.dryRun) {
        if (!(await confirmPaidCommand('bench:suite', BENCH_SUITE_WARNING_MESSAGE, 'Benchmark suite cancelled.', options.yes, io, dependencies))) {
          return 1
        }
      }
      const output = await dependencies.runBenchSuite({ options, io })
      if (output) {
        io.log(output)
      }
      return 0
    }

    if (command === 'eval') {
      const options = parseBenchmarkArgs(args, 'eval')
      if (!(await confirmPaidCommand('eval', EVAL_WARNING_MESSAGE, 'Eval cancelled.', options.yes, io, dependencies))) {
        return 1
      }
      const output = await dependencies.runEval({ options, io })
      if (output) {
        io.log(output)
      }
      return 0
    }

    if (command === 'install') {
      const options = parseInstallArgs(args, defaultInstallPlatform())
      failureTelemetry = (failureBucket) => ({
        command: 'install',
        stage: 'failed',
        ...telemetryBase(dependencies),
        failureBucket,
        agentTarget: options.platform,
      })
      emitTelemetry(io, dependencies, () => ({
        command: 'install',
        stage: 'started',
        ...telemetryBase(dependencies),
        agentTarget: options.platform,
      }))
      if (options.platform === 'gemini') {
        io.log(dependencies.geminiInstall('.'))
      } else if (options.platform === 'cursor') {
        io.log(dependencies.cursorInstall('.'))
      } else {
        io.log(dependencies.installSkill(options.platform))
      }
      emitTelemetry(io, dependencies, () => ({
        command: 'install',
        stage: 'succeeded',
        ...telemetryBase(dependencies),
        agentTarget: options.platform,
      }))
      return 0
    }

    if (command === 'hook') {
      const options = parseHookArgs(args)
      if (options.action === 'install') {
        io.log(dependencies.installHooks('.'))
        return 0
      }
      if (options.action === 'uninstall') {
        io.log(dependencies.uninstallHooks('.'))
        return 0
      }
      io.log(dependencies.hookStatus('.'))
      return 0
    }

    if (command === 'claude') {
      const options = parsePlatformActionArgs(command, args)
      if (options.action === 'install') {
        warnWhenWorkspaceGraphIsMissing(io)
      }
      if (options.action === 'install') {
        failureTelemetry = (failureBucket) => ({
          command: 'install',
          stage: 'failed',
          ...telemetryBase(dependencies),
          failureBucket,
          agentTarget: 'claude',
        })
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'started',
          ...telemetryBase(dependencies),
          agentTarget: 'claude',
        }))
      }
      io.log(options.action === 'install'
        ? dependencies.claudeInstall('.')
        : dependencies.claudeUninstall('.'))
      if (options.action === 'install') {
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'succeeded',
          ...telemetryBase(dependencies),
          agentTarget: 'claude',
        }))
      }
      return 0
    }

    if (command === 'cursor') {
      const options = parsePlatformActionArgs(command, args)
      if (options.action === 'install') {
        warnWhenWorkspaceGraphIsMissing(io)
      }
      if (options.action === 'install') {
        failureTelemetry = (failureBucket) => ({
          command: 'install',
          stage: 'failed',
          ...telemetryBase(dependencies),
          failureBucket,
          agentTarget: 'cursor',
        })
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'started',
          ...telemetryBase(dependencies),
          agentTarget: 'cursor',
        }))
      }
      io.log(options.action === 'install'
        ? dependencies.cursorInstall('.')
        : dependencies.cursorUninstall('.'))
      if (options.action === 'install') {
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'succeeded',
          ...telemetryBase(dependencies),
          agentTarget: 'cursor',
        }))
      }
      return 0
    }

    if (command === 'gemini') {
      const options = parsePlatformActionArgs(command, args)
      if (options.action === 'install') {
        warnWhenWorkspaceGraphIsMissing(io)
      }
      if (options.action === 'install') {
        failureTelemetry = (failureBucket) => ({
          command: 'install',
          stage: 'failed',
          ...telemetryBase(dependencies),
          failureBucket,
          agentTarget: 'gemini',
        })
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'started',
          ...telemetryBase(dependencies),
          agentTarget: 'gemini',
        }))
      }
      io.log(options.action === 'install' ? dependencies.geminiInstall('.') : dependencies.geminiUninstall('.'))
      if (options.action === 'install') {
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'succeeded',
          ...telemetryBase(dependencies),
          agentTarget: 'gemini',
        }))
      }
      return 0
    }

    if (command === 'copilot') {
      const options = parsePlatformActionArgs(command, args)
      if (options.action === 'install') {
        failureTelemetry = (failureBucket) => ({
          command: 'install',
          stage: 'failed',
          ...telemetryBase(dependencies),
          failureBucket,
          agentTarget: 'copilot',
        })
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'started',
          ...telemetryBase(dependencies),
          agentTarget: 'copilot',
        }))
        warnWhenWorkspaceGraphIsMissing(io)
        io.log(dependencies.installSkill('copilot'))
        io.log(dependencies.installCopilotMcp('.'))
        emitTelemetry(io, dependencies, () => ({
          command: 'install',
          stage: 'succeeded',
          ...telemetryBase(dependencies),
          agentTarget: 'copilot',
        }))
      } else {
        io.log(dependencies.uninstallCopilotMcp('.'))
        io.log(dependencies.uninstallSkill('copilot'))
      }
      return 0
    }

    if (isAgentPlatform(command)) {
      return handleAgentCommand(command, args, io, dependencies)
    }

    io.error(`error: unknown command '${command}'`)
    io.error(`Run 'madar --help' for usage.`)
    return 1
  } catch (error) {
    if (failureTelemetry) {
      emitTelemetry(io, dependencies, () => failureTelemetry!(classifyTelemetryFailure(error)))
    }
    if (error instanceof UsageError) {
      io.error(error.message)
      return 2
    }

    io.error(`error: ${messageFromError(error)}`)
    return 1
  }
}
