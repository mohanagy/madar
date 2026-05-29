import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import { loadBenchmarkQuestions, type BenchmarkResult, printBenchmark, runBenchmark } from '../infrastructure/benchmark.js'
import { runBenchmarkSuite } from '../infrastructure/benchmark/suite.js'
import { evaluateRetrievalQuality, formatQualityReport } from '../infrastructure/benchmark/quality.js'
import { BenchmarkReadinessError, NativeAgentInstallRequiredError, runCompareCommand } from '../infrastructure/compare.js'
import { runContextPackCommand } from '../infrastructure/context-pack-command.js'
import { runContextPromptCommand } from '../infrastructure/context-prompt-command.js'
import { runDoctorCommand, runStatusCommand } from '../infrastructure/doctor.js'
import { runReviewCompareCommand } from '../infrastructure/review-compare.js'
import { saveQueryResult } from '../infrastructure/save-query-result.js'
import { compareRefs } from '../infrastructure/time-travel.js'
import { federate } from '../pipeline/federate.js'
import { generateGraph, type GenerateGraphResult, type ProgressStep } from '../infrastructure/generate.js'
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
import { watch as watchGraph } from '../infrastructure/watch.js'
import { serveGraph } from '../runtime/http-server.js'
import { diffGraphs } from '../runtime/diff.js'
import { buildGraphSummary, type GraphSummary } from '../runtime/graph-summary.js'
import { serveGraphStdio } from '../runtime/stdio-server.js'
import { getNeighbors, getNode, loadGraph, queryGraph, shortestPath } from '../runtime/serve.js'
import { formatTimeTravelResult } from '../runtime/time-travel.js'
import { findPackageRoot, readPackageName, readPackageVersion } from '../shared/package-metadata.js'
import { getUpdateNotification } from '../shared/update-notifier.js'
import {
  parseBenchmarkArgs,
  parseBenchSuiteArgs,
  type BenchSuiteCliOptions,
  type BenchmarkCliOptions,
  parseCompareArgs,
  parseDoctorArgs,
  parsePackArgs,
  parseDiffArgs,
  parseExplainArgs,
  parseGenerateArgs,
  parseHookArgs,
  parseInstallArgs,
  parsePathArgs,
  parsePlatformActionArgs,
  parsePromptArgs,
  parseQueryArgs,
  parseReviewCompareArgs,
  parseSaveResultArgs,
  parseSummaryArgs,
  parseServeArgs,
  parseTimeTravelArgs,
  type PackCliOptions,
  type PromptCliOptions,
  parseWatchArgs,
  type CompareCliOptions,
  type ReviewCompareCliOptions,
  type TimeTravelCliOptions,
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

export interface ReviewCompareCommandContext {
  options: ReviewCompareCliOptions
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

export interface TimeTravelCommandContext {
  options: TimeTravelCliOptions
  io: CliIO
}

export interface ContextPackCommandContext {
  options: PackCliOptions
  io: CliIO
}

export interface ContextPromptCommandContext {
  options: PromptCliOptions
  io: CliIO
}

export interface CliDependencies {
  loadGraph: typeof loadGraph
  queryGraph: typeof queryGraph
  saveQueryResult: typeof saveQueryResult
  runBenchmark: (context: BenchmarkCommandContext) => Promise<BenchmarkResult> | BenchmarkResult
  runBenchSuite: (context: BenchSuiteCommandContext) => Promise<string | void> | string | void
  runEval: (context: EvalCommandContext) => Promise<string | void> | string | void
  runCompare: (context: CompareCommandContext) => Promise<string | void> | string | void
  runReviewCompare: (context: ReviewCompareCommandContext) => Promise<string | void> | string | void
  runTimeTravel: (context: TimeTravelCommandContext) => Promise<string | void> | string | void
  runContextPack: (context: ContextPackCommandContext) => Promise<string | void> | string | void
  runContextPrompt: (context: ContextPromptCommandContext) => Promise<string | void> | string | void
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
  generateGraph: typeof generateGraph
  watchGraph: typeof watchGraph
  serveGraph: typeof serveGraph
  serveGraphStdio: typeof serveGraphStdio
  claudeInstall: typeof claudeInstall
  claudeUninstall: typeof claudeUninstall
  agentsInstall: typeof agentsInstall
  agentsUninstall: typeof agentsUninstall
  notifyUpdate?: () => Promise<string | null> | string | null
  readInstalledVersion?: () => string
}

const COMPARE_WARNING_MESSAGE = 'compare will execute a baseline prompt and a madar prompt for each question. This may consume paid model tokens.'
const REVIEW_COMPARE_WARNING_MESSAGE = 'review-compare will execute verbose and compact pr_impact prompts for the current git diff. This may consume paid model tokens.'
const BENCHMARK_WARNING_MESSAGE = 'benchmark will execute the benchmark/eval runner. This may consume paid model tokens.'
const BENCH_SUITE_WARNING_MESSAGE = 'bench:suite will execute baseline, madar, and SPI suite prompts. This may consume paid model tokens.'
const EVAL_WARNING_MESSAGE = 'eval will execute the benchmark/eval runner. This may consume paid model tokens.'

const DEFAULT_DEPENDENCIES: CliDependencies = {
  loadGraph,
  queryGraph,
  saveQueryResult,
  runBenchmark: ({ options }) => {
    const questions = options.questionsPath ? loadBenchmarkQuestions(options.questionsPath) : undefined
    return runBenchmark(options.graphPath, undefined, questions, { execTemplate: options.execTemplate })
  },
  runBenchSuite: async ({ options }) => {
    const result = await runBenchmarkSuite(options)
    return result.text
  },
  runEval: async ({ options }) => {
    const graph = loadGraph(options.graphPath)
    const questions = options.questionsPath ? loadBenchmarkQuestions(options.questionsPath) : undefined
    const report = await evaluateRetrievalQuality(graph, questions, 3000, {
      graphPath: options.graphPath,
      execTemplate: options.execTemplate,
    })
    return formatQualityReport(report)
  },
  runCompare: async ({ options }) => {
    try {
      return await runCompareCommand({
        graphPath: options.graphPath,
        question: options.question,
        questionsPath: options.questionsPath,
        outputDir: options.outputDir,
        execTemplate: options.execTemplate,
        ...(options.task ? { task: options.task } : {}),
        baselineMode: options.baselineMode,
        perArmTimeoutSeconds: options.perArmTimeoutSeconds,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        strictMadarFirst: options.strictMadarFirst,
        strictBenchmarkReadiness: options.strictBenchmarkReadiness,
        allowNoInstall: options.allowNoInstall,
        limit: options.limit,
        ...(options.why ? { why: true } : {}),
      })
    } catch (error) {
      if (error instanceof NativeAgentInstallRequiredError) {
        throw new UsageError(error.message)
      }
      if (error instanceof BenchmarkReadinessError) {
        throw new UsageError(error.message)
      }
      throw error
    }
  },
  runReviewCompare: async ({ options }) => {
    return await runReviewCompareCommand({
      graphPath: options.graphPath,
      execTemplate: options.execTemplate,
      outputDir: options.outputDir,
      ...(options.baseBranch !== null ? { baseBranch: options.baseBranch } : {}),
      ...(options.budget !== null ? { budget: options.budget } : {}),
    })
  },
  runTimeTravel: async ({ options }) => {
    const result = await compareRefs(options)
    return options.json ? JSON.stringify(result, null, 2) : formatTimeTravelResult(result)
  },
  runContextPack: async ({ options }) => {
    return await runContextPackCommand(options)
  },
  runContextPrompt: async ({ options }) => {
    return await runContextPromptCommand(options)
  },
  runDoctor: (graphPath) => runDoctorCommand({ graphPath }),
  runStatus: (graphPath) => runStatusCommand({ graphPath }),
  runGraphSummary: (graphPath) => buildGraphSummary(loadGraph(graphPath)),
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
  generateGraph,
  watchGraph,
  serveGraph,
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
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatProgress(progress: ProgressStep): string {
  const prefix = `[madar ${progress.step}]`
  if (progress.step === 'extract' && progress.current !== undefined && progress.total !== undefined && progress.total > 0) {
    return `${prefix} ${progress.message} (${progress.current}/${progress.total})`
  }
  return `${prefix} ${progress.message}`
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
    '  generate [path]       build graph artifacts for a folder (default .)',
    '    --update             rebuild incrementally from the manifest, re-extracting changed files only',
    '    --cluster-only       re-cluster an existing graph.json without re-extraction',
    '    --watch              keep watching after the initial build',
    '    --directed           preserve edge direction (source → target) in the built graph',
    '    --follow-symlinks    include in-root symlink targets',
    '    --debounce S         watch debounce seconds (default 3)',
    '    --include-docs       include .md/.txt/.rst document files (excluded by default)',
    '    --docs               generate module documentation in out/docs/',
    '    --no-html            skip graph.html generation',
    '    --wiki               also export a crawlable wiki to out/wiki',
    '    --obsidian           also export an Obsidian vault',
    '    --obsidian-dir DIR   custom Obsidian vault path (implies --obsidian)',
    '    --svg                also export graph.svg for static embeds',
    '    --graphml            also export graph.graphml for graph tools',
    '    --neo4j              also export cypher.txt for Neo4j import',
    '    --neo4j-push URI     also push the generated graph directly to Neo4j',
    '    --neo4j-user USER    Neo4j username (defaults to NEO4J_USER or neo4j)',
    '    --neo4j-password PW  Neo4j password (or set NEO4J_PASSWORD/.env)',
    '    --neo4j-database DB  Neo4j database (defaults to NEO4J_DATABASE or neo4j)',
    '  federate <g1> <g2>... merge graphs from multiple repos into one',
    '    --output DIR         output directory (default out-federated)',
    '  watch [path]          build once, then watch for code/doc changes',
    '    --follow-symlinks    include in-root symlink targets',
    '    --debounce S         watch debounce seconds (default 3)',
    '    --no-html            skip graph.html generation during the initial build',
    '  serve [graph.json]    serve graph artifacts over HTTP or stdio',
    '    --host H             host interface (default 127.0.0.1)',
    '    --port N             port (default 4173; use 0 for a random port)',
    '    --transport MODE     choose http or stdio explicitly',
    '    --http               explicit alias for HTTP transport',
    '    --stdio              serve graph query methods over stdio (JSON lines)',
    '    --mcp                alias for --stdio for installer/runtime parity',
    '  summary [graph.json]  print a compact deterministic graph summary as JSON',
    '  query "<question>"     traverse graph.json for a question',
    '    --dfs                 use depth-first instead of breadth-first',
    '    --budget N            cap output at N tokens (default 2000)',
    '    --graph <path>        path to graph.json (default out/graph.json)',
    '    --rank-by MODE        rank matches by relevance or degree (default relevance)',
    '    --community ID        limit traversal to one community id',
    '    --file-type TYPE      limit traversal to one file type (for example code or document)',
    '  pack "<prompt>"       compile a task-aware context pack / execution brief',
    '    --budget N            cap context pack assembly at N tokens (default 3000)',
    '    --task KIND          explain|implement|review|impact (default infer from prompt; fallback explain)',
    '    --graph <path>       path to graph.json (default out/graph.json)',
    '    --format MODE       json|text|markdown|claude|copilot (default json)',
    '    --why               include retrieval-routing debug metadata in the pack output',
    '  prompt "<prompt>"     compile a provider-ready prompt payload',
    '    --provider NAME      claude|gemini',
    '    --graph <path>       path to graph.json (default out/graph.json)',
    '  diff <baseline-graph.json> compare a baseline graph.json to the current graph snapshot',
    '    --graph <path>        path to the current graph.json (default out/graph.json)',
    '    --limit N             maximum items to show per change section (default 10)',
    '  path <source> <target> find the shortest path between two concepts',
    '    --graph <path>        path to graph.json (default out/graph.json)',
    '    --max-hops N          maximum allowed hops before reporting overflow (default 8)',
    '  explain <label>        explain one node and its neighborhood from graph evidence',
    '    --graph <path>        path to graph.json (default out/graph.json)',
    '    --relation REL        optional relation filter for neighbors',
    '  save-result            save a Q&A result to out/memory/',
    '    --question Q          the question asked',
    '    --answer A            the answer to save',
    '    --type T              query type: query|path_query|explain (default query)',
    '    --nodes N1 N2 ...     source node labels cited in the answer',
    '    --memory-dir DIR      memory directory (default out/memory)',
    '  benchmark [graph.json] measure token reduction, question coverage, and structure signals through the benchmark/eval runner. This may consume paid model tokens.',
    '    --exec TEMPLATE       required command template; supports {prompt_file}, {question}, {mode}, and {output_file}',
    '    --questions PATH      load benchmark/eval questions from a JSON file',
    '    --yes                 skip confirmation before running the paid benchmark/eval prompts',
    '  bench:suite           run the reproducible benchmark matrix and write results under docs/benchmarks/suite/results/',
    '    --exec TEMPLATE       required unless --dry-run; supports {prompt_file}, {question}, {mode}, and {output_file}',
    '    --repo ID             limit the suite to one repo id from docs/benchmarks/suite/repos.json',
    '    --task ID             limit the suite to one task id from docs/benchmarks/suite/tasks.json',
    '    --mode MODE           cold | warm | all (default all)',
    '    --trials N            measured trials per runnable cell (default 3)',
    '    --output-dir DIR      suite results directory (default docs/benchmarks/suite/results)',
    '    --dry-run             list planned and runnable suite cells without executing prompts',
    '    --yes                 skip confirmation before running the paid suite prompts',
    '  eval [graph.json]      measure retrieval quality: recall, MRR, and snippet coverage through the benchmark/eval runner. This may consume paid model tokens.',
    '    --exec TEMPLATE       required command template; supports {prompt_file}, {question}, {mode}, and {output_file}',
    '    --questions PATH      load benchmark/eval questions from a JSON file',
    '    --yes                 skip confirmation before running the paid benchmark/eval prompts',
    '  compare [question]    run a real baseline vs madar prompt comparison',
    '    --graph <path>        path to graph.json (default out/graph.json)',
    '    --exec TEMPLATE       required command template; supports {prompt_file}, {question}, {mode}, and {output_file}',
    '    --questions PATH      load questions from a JSON file instead of a positional question',
    '    --output-dir DIR      compare output directory (default out/compare)',
    '    --task KIND           explain|implement|review|impact (default explain)',
    '    --baseline-mode MODE  full | bounded | pack_only | native_agent (default full; pack_only compares one bounded raw-context prompt against one compiled madar pack; native_agent runs --exec twice, uses Anthropic JSON usage when available, and otherwise saves answer-only artifacts)',
    '      For Claude MCP attribution in native_agent mode, include --verbose with --output-format json',
    '    --per-arm-timeout S   per-arm timeout seconds for native_agent runs (default 600)',
    '    --heartbeat-interval-ms N  stderr heartbeat interval for native_agent runs (default 30000; 0 disables)',
    '    --strict-madar-first  treat pre-Madar broad exploration as degraded/non-winning in native_agent mode',
    '    --strict / --strict-benchmark-readiness  fail native_agent compare before runner spend when benchmark readiness is degraded or not_ready',
    '    --allow-no-install    allow native_agent compare without a verified Madar install and mark the run invalid',
    '    --yes                 skip confirmation before running the paid prompt comparison',
    '    --limit N             cap processed prompts/questions for the comparison run',
    '    --why                 include retrieval-routing debug metadata in the compare summary and reports',
    '  review-compare [graph.json] compare full vs compact pr_impact review prompts on the current git diff',
    '    --exec TEMPLATE       required command template; supports {prompt_file}, {mode}, and {output_file}',
    '    --output-dir DIR      review compare output directory (default out/review-compare)',
    '    --base-branch BRANCH  override the PR base branch used for diff selection',
    '    --budget N            override the pr_impact review bundle token budget',
    '    --yes                 skip confirmation before running the paid review comparison',
    '  time-travel <from> <to> compare two refs using on-demand cached graph snapshots',
    '    --view MODE          summary|risk|drift|timeline (default summary)',
    '    --json               emit machine-readable JSON',
    '    --refresh            rebuild snapshots instead of using cache',
    '    --limit N            cap view items (default 10)',
    '  doctor [graph.json]   check graph freshness, agent config, and MCP wiring',
    '    --graph <path>      path to graph.json to validate (default out/graph.json)',
    '  status [graph.json]   compact readiness summary with next commands',
    '    --graph <path>      path to graph.json to validate (default out/graph.json)',
    '  install [--platform P] install the platform skill or local madar config',
    '    platforms            claude|windows|gemini|cursor|codex|opencode|aider|claw|droid|trae|trae-cn|copilot',
    '    If you update madar, re-run your platform install command to refresh local agent rules:',
    '    madar install --platform <platform>',
    '  hook <action>          manage git hooks for madar rebuild reminders',
    '    install              install post-commit and post-checkout hooks',
    '    uninstall            remove madar hook sections',
    '    status               show whether madar hooks are installed',
    '  aider <install|uninstall>   manage local AGENTS.md rules',
    '  claude <install|uninstall> [--profile core|full|strict]  manage local CLAUDE.md madar rules',
    '  cursor <install|uninstall> [--profile core|full|strict]  manage local Cursor madar rules',
    '  gemini <install|uninstall> [--profile core|full|strict]  manage local GEMINI.md rules and Gemini CLI hook config',
    '  copilot <install|uninstall> [--profile core|full|strict] install or remove the GitHub Copilot skill',
    '  codex <install|uninstall>   manage local AGENTS.md + Codex hook rules',
    '  opencode <install|uninstall> manage local AGENTS.md + OpenCode plugin/MCP rules',
    '  claw <install|uninstall>    manage local AGENTS.md rules',
    '  droid <install|uninstall>   manage local AGENTS.md rules',
    '  trae <install|uninstall>    manage local AGENTS.md rules',
    '  trae-cn <install|uninstall> manage local AGENTS.md rules',
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
    argument === '--directed' ||
    argument === '--follow-symlinks' ||
    argument === '--no-html' ||
    argument === '--wiki' ||
    argument === '--obsidian' ||
    argument === '--svg' ||
    argument === '--graphml' ||
    argument === '--neo4j' ||
    argument === '--neo4j-push' ||
    argument === '--neo4j-user' ||
    argument === '--neo4j-password' ||
    argument === '--neo4j-database' ||
    argument === '--obsidian-dir' ||
    argument === '--debounce' ||
    argument === '--include-docs' ||
    argument === '--docs' ||
    argument.startsWith('--neo4j-push=') ||
    argument.startsWith('--neo4j-user=') ||
    argument.startsWith('--neo4j-password=') ||
    argument.startsWith('--neo4j-database=') ||
    argument.startsWith('--obsidian-dir=') ||
    argument.startsWith('--debounce=')
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

function formatGenerateSummary(result: GenerateGraphResult): string {
  const lines = [
    `[madar generate] ${result.mode} completed for ${result.rootPath}`,
    `- Corpus: ${result.totalFiles} file(s) · ~${result.totalWords.toLocaleString()} words`,
    `- Extracted: ${result.codeFiles} code file(s)` + (result.nonCodeFiles > 0 ? ` (+${result.nonCodeFiles} non-code detected)` : ''),
    `- Graph: ${result.nodeCount} nodes · ${result.edgeCount} edges · ${result.communityCount} communities`,
    ...(typeof result.semanticAnomalyCount === 'number' ? [`- Semantic anomalies: ${result.semanticAnomalyCount} high-signal item(s)`] : []),
    `- Outputs: ${result.graphPath}, ${result.reportPath}`,
  ]

  if (result.htmlPath) {
    lines.push(`- HTML: ${result.htmlPath}`)
  }

  if (result.wikiPath) {
    lines.push(`- Wiki: ${result.wikiPath}`)
  }

  if (result.obsidianPath) {
    lines.push(`- Obsidian: ${result.obsidianPath}`)
  }

  if (result.svgPath) {
    lines.push(`- SVG: ${result.svgPath}`)
  }

  if (result.graphmlPath) {
    lines.push(`- GraphML: ${result.graphmlPath}`)
  }

  if (result.cypherPath) {
    lines.push(`- Neo4j Cypher: ${result.cypherPath}`)
  }

  if (result.docsPath) {
    lines.push(`- Docs: ${result.docsPath}`)
  }

  if (result.changedFiles > 0 || result.deletedFiles > 0) {
    lines.push(`- Incremental: ${result.changedFiles} changed · ${result.deletedFiles} deleted`)
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
  lines.push('  madar cursor install    # Cursor')
  lines.push('  madar copilot install   # GitHub Copilot')
  lines.push('  madar gemini install    # Gemini CLI')

  return lines.join('\n')
}

function formatExplainSummary(graph: ReturnType<typeof loadGraph>, label: string, relation = ''): string {
  const nodeDetails = getNode(graph, label)
  if (nodeDetails.startsWith('No node matching')) {
    return nodeDetails
  }

  return `${nodeDetails}\n\n${getNeighbors(graph, label, relation)}`
}

function handleAgentCommand(command: AgentPlatform, args: string[], io: CliIO, dependencies: CliDependencies): number {
  const options = parsePlatformActionArgs(command, args)
  if (options.action === 'install') {
    io.log(dependencies.agentsInstall('.', command))
    return 0
  }

  io.log(dependencies.agentsUninstall('.', command))
  return 0
}

export async function executeCli(argv: string[], io: CliIO = console, dependencies: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
  const [command, ...args] = argv

  if (!command || command === '-h' || command === '--help') {
    io.log(formatHelp())
    return 0
  }

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
      const confirm = async (message: string) => await dependencies.confirm(message)
      if (!options.yes) {
        io.log(`Warning: ${COMPARE_WARNING_MESSAGE}`)
        if (!(await confirm(COMPARE_WARNING_MESSAGE))) {
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
      return 0
    }

    if (command === 'review-compare') {
      const options = parseReviewCompareArgs(args)
      const confirm = async (message: string) => await dependencies.confirm(message)
      if (!(await confirmPaidCommand(
        'review-compare',
        REVIEW_COMPARE_WARNING_MESSAGE,
        'Review compare cancelled.',
        options.yes,
        io,
        dependencies,
      ))) {
        return 1
      }
      const output = await dependencies.runReviewCompare({
        options,
        io,
        confirm,
      })
      if (output !== undefined) {
        io.log(output)
      }
      return 0
    }

    if (command === 'time-travel') {
      const options = parseTimeTravelArgs(args)
      const output = await dependencies.runTimeTravel({ options, io })
      if (output !== undefined) {
        io.log(output)
      }
      return 0
    }

    if (command === 'doctor') {
      const options = parseDoctorArgs(args, 'doctor')
      io.log(dependencies.runDoctor(options.graphPath))
      return 0
    }

    if (command === 'status') {
      const options = parseDoctorArgs(args, 'status')
      io.log(dependencies.runStatus(options.graphPath))
      return 0
    }

    if (command === 'summary') {
      const options = parseSummaryArgs(args)
      const runGraphSummary = dependencies.runGraphSummary ?? ((graphPath: string) => buildGraphSummary(dependencies.loadGraph(graphPath)))
      io.log(JSON.stringify(await runGraphSummary(options.graphPath), null, 2))
      return 0
    }

    if (command === 'pack') {
      const options = parsePackArgs(args)
      const output = await dependencies.runContextPack({ options, io })
      if (output !== undefined) {
        io.log(output)
      }
      return 0
    }

    if (command === 'prompt') {
      const options = parsePromptArgs(args)
      const output = await dependencies.runContextPrompt({ options, io })
      if (output !== undefined) {
        io.log(output)
      }
      return 0
    }

    if (command === 'generate' || (command !== undefined && !isAgentPlatform(command) && isImplicitGenerateCommand(command))) {
      const generateArgs = command === 'generate' ? args : [command, ...args]
      const options = parseGenerateArgs(generateArgs)
      const result = dependencies.generateGraph(options.path, {
        update: options.update,
        clusterOnly: options.clusterOnly,
        directed: options.directed,
        followSymlinks: options.followSymlinks,
        noHtml: options.noHtml,
        wiki: options.wiki,
        obsidian: options.obsidian,
        obsidianDir: options.obsidianDir,
        svg: options.svg,
        graphml: options.graphml,
        neo4j: options.neo4j,
        includeDocs: options.includeDocs,
        docs: options.docs,
        useSpi: options.useSpi,
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
        io.log(`[madar neo4j] Pushed ${pushResult.nodes} nodes and ${pushResult.edges} edges to ${pushResult.uri} (database ${pushResult.database})`)
      }

      if (options.watch) {
        await dependencies.watchGraph(options.path, options.debounceSeconds, {
          followSymlinks: options.followSymlinks,
          noHtml: options.noHtml,
          logger: io,
        })
      }
      return 0
    }

    if (command === 'watch') {
      const options = parseWatchArgs(args)
      const result = dependencies.generateGraph(options.path, {
        followSymlinks: options.followSymlinks,
        noHtml: options.noHtml,
        onProgress: (step) => io.log(formatProgress(step)),
      })
      io.log(formatGenerateSummary(result))
      await dependencies.watchGraph(options.path, options.debounceSeconds, {
        followSymlinks: options.followSymlinks,
        noHtml: options.noHtml,
        logger: io,
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
      if (options.transport === 'stdio') {
        await dependencies.serveGraphStdio({
          graphPath: options.graphPath,
          logger: io,
        })
        return 0
      }

      await dependencies.serveGraph({
        graphPath: options.graphPath,
        host: options.host,
        port: options.port,
        logger: io,
      })
      return 0
    }

    if (command === 'query') {
      const options = parseQueryArgs(args)
      const graph = dependencies.loadGraph(options.graphPath)
      const filters = {
        ...(options.community !== null ? { community: options.community } : {}),
        ...(options.fileType ? { fileType: options.fileType } : {}),
      }
      io.log(
        dependencies.queryGraph(graph, options.question, {
          mode: options.mode,
          tokenBudget: options.tokenBudget,
          rankBy: options.rankBy,
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
        }),
      )
      return 0
    }

    if (command === 'diff') {
      const options = parseDiffArgs(args)
      const baselineGraph = dependencies.loadGraph(options.baselineGraphPath)
      const graph = dependencies.loadGraph(options.graphPath)
      io.log(diffGraphs(baselineGraph, graph, { limit: options.limit }))
      return 0
    }

    if (command === 'path') {
      const options = parsePathArgs(args)
      const graph = dependencies.loadGraph(options.graphPath)
      io.log(shortestPath(graph, options.source, options.target, options.maxHops))
      return 0
    }

    if (command === 'explain') {
      const options = parseExplainArgs(args)
      const graph = dependencies.loadGraph(options.graphPath)
      io.log(formatExplainSummary(graph, options.label, options.relation))
      return 0
    }

    if (command === 'save-result') {
      const options = parseSaveResultArgs(args)
      const outputPath = dependencies.saveQueryResult(options.question, options.answer, options.memoryDir, {
        queryType: options.queryType,
        sourceNodes: options.sourceNodes,
      })
      io.log(`Saved to ${outputPath}`)
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
      if (options.platform === 'gemini') {
        io.log(dependencies.geminiInstall('.'))
      } else if (options.platform === 'cursor') {
        io.log(dependencies.cursorInstall('.'))
      } else {
        io.log(dependencies.installSkill(options.platform))
      }
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
      if (options.action === 'install' && !existsSync('out/graph.json')) {
        io.log("Warning: out/graph.json not found. Run 'madar generate .' first, then re-run this command.")
      }
      io.log(options.action === 'install'
        ? dependencies.claudeInstall('.', options.profile ? { profile: options.profile } : {})
        : dependencies.claudeUninstall('.'))
      return 0
    }

    if (command === 'cursor') {
      const options = parsePlatformActionArgs(command, args)
      if (options.action === 'install' && !existsSync('out/graph.json')) {
        io.log("Warning: out/graph.json not found. Run 'madar generate .' first, then re-run this command.")
      }
      io.log(options.action === 'install'
        ? dependencies.cursorInstall('.', options.profile ? { profile: options.profile } : {})
        : dependencies.cursorUninstall('.'))
      return 0
    }

    if (command === 'gemini') {
      const options = parsePlatformActionArgs(command, args)
      if (options.action === 'install' && !existsSync('out/graph.json')) {
        io.log("Warning: out/graph.json not found. Run 'madar generate .' first, then re-run this command.")
      }
      io.log(options.action === 'install' ? dependencies.geminiInstall('.', options.profile ? { profile: options.profile } : {}) : dependencies.geminiUninstall('.'))
      return 0
    }

    if (command === 'copilot') {
      const options = parsePlatformActionArgs(command, args)
      if (options.action === 'install') {
        if (!existsSync('out/graph.json')) {
          io.log("Warning: out/graph.json not found. Run 'madar generate .' first, then re-run this command.")
        }
        io.log(dependencies.installSkill('copilot'))
        io.log(dependencies.installCopilotMcp('.', options.profile ? { profile: options.profile } : {}))
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
    if (error instanceof UsageError) {
      io.error(error.message)
      return 2
    }

    io.error(`error: ${messageFromError(error)}`)
    return 1
  }
}
