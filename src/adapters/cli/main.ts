import type {
  GenerateIndexOptions,
  ProgressStep,
} from '../../application/generate-index.js'
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}
export interface CliIO {
  log(message?: string): void
  error(message?: string): void
  write(message: string): void
}
export interface CliDependencies {
  version(): string
  cwd: string
}
export interface GenerateCliOptions {
  path: string
  update: boolean
  watch: boolean
  debounceSeconds: number
  followSymlinks?: boolean
  respectGitignore?: boolean
  strictIndexing: boolean
  maxIndexingFailed: number
  maxIndexingUnsupported: number
}
export interface QueryCliOptions {
  question: string
  graphPath: string
  budget?: number
}
export interface InstallCliOptions {
  platform: 'claude' | 'codex'
  uninstall: boolean
}
function optionValue(
  args: readonly string[],
  index: number,
  flag: string,
): { value: string; consumed: number } | null {
  const argument = args[index]
  if (argument === flag) {
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`)
    }
    return { value, consumed: 2 }
  }
  if (argument?.startsWith(`${flag}=`)) {
    const value = argument.slice(flag.length + 1)
    if (!value) throw new UsageError(`${flag} requires a value`)
    return { value, consumed: 1 }
  }
  return null
}
function positiveInteger(flag: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new UsageError(`${flag} must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError(`${flag} must be a positive integer`)
  }
  return parsed
}
function nonNegativeInteger(flag: string, value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new UsageError(`${flag} must be a non-negative integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError(`${flag} must be a non-negative integer`)
  }
  return parsed
}
function nonNegativeNumber(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || value.trim().length === 0) {
    throw new UsageError(`${flag} must be a non-negative number`)
  }
  return parsed
}
export function parseGenerateArgs(args: readonly string[]): GenerateCliOptions {
  const options: GenerateCliOptions = {
    path: '.',
    update: false,
    watch: false,
    debounceSeconds: 3,
    strictIndexing: false,
    maxIndexingFailed: 0,
    maxIndexingUnsupported: 0,
  }
  let pathSeen = false
  for (let index = 0; index < args.length;) {
    const argument = args[index]!
    if (argument === '--update') {
      options.update = true
      index += 1
      continue
    }
    if (argument === '--watch') {
      options.watch = true
      index += 1
      continue
    }
    if (argument === '--follow-symlinks') {
      options.followSymlinks = true
      index += 1
      continue
    }
    if (argument === '--respect-gitignore') {
      options.respectGitignore = true
      index += 1
      continue
    }
    if (argument === '--strict-indexing') {
      options.strictIndexing = true
      index += 1
      continue
    }
    const debounce = optionValue(args, index, '--debounce')
    if (debounce) {
      options.debounceSeconds = nonNegativeNumber('--debounce', debounce.value)
      index += debounce.consumed
      continue
    }
    const maxFailed = optionValue(args, index, '--max-indexing-failed')
    if (maxFailed) {
      options.maxIndexingFailed = nonNegativeInteger(
        '--max-indexing-failed',
        maxFailed.value,
      )
      options.strictIndexing = true
      index += maxFailed.consumed
      continue
    }
    const maxUnsupported = optionValue(
      args,
      index,
      '--max-indexing-unsupported',
    )
    if (maxUnsupported) {
      options.maxIndexingUnsupported = nonNegativeInteger(
        '--max-indexing-unsupported',
        maxUnsupported.value,
      )
      options.strictIndexing = true
      index += maxUnsupported.consumed
      continue
    }
    if (argument.startsWith('-')) {
      throw new UsageError(`unknown option for generate: ${argument}`)
    }
    if (pathSeen) throw new UsageError('Usage: madar generate [path] [options]')
    options.path = argument
    pathSeen = true
    index += 1
  }
  return options
}
export function parseQueryArgs(args: readonly string[]): QueryCliOptions {
  let question: string | null = null
  let graphPath = 'out/graph.json'
  let budget: number | undefined
  for (let index = 0; index < args.length;) {
    const graph = optionValue(args, index, '--graph')
    if (graph) {
      graphPath = graph.value
      index += graph.consumed
      continue
    }
    const requestedBudget = optionValue(args, index, '--budget')
    if (requestedBudget) {
      budget = positiveInteger('--budget', requestedBudget.value)
      index += requestedBudget.consumed
      continue
    }
    const argument = args[index]!
    if (argument.startsWith('-')) {
      throw new UsageError(`unknown option for query: ${argument}`)
    }
    if (question !== null) throw new UsageError('Usage: madar query "<question>"')
    question = argument.trim()
    index += 1
  }
  if (!question) throw new UsageError('Usage: madar query "<question>"')
  return {
    question,
    graphPath,
    ...(budget === undefined ? {} : { budget }),
  }
}
function parseDiagnosticArgs(
  command: 'doctor' | 'status',
  args: readonly string[],
): string | undefined {
  if (args.length === 0) return undefined
  if (args.length === 1 && !args[0]!.startsWith('-')) return args[0]!
  const graph = optionValue(args, 0, '--graph')
  if (graph && graph.consumed === args.length) return graph.value
  throw new UsageError(`Usage: madar ${command} [graph.json]`)
}
export function parseInstallArgs(args: readonly string[]): InstallCliOptions {
  const platform = args[0]
  if (platform !== 'claude' && platform !== 'codex') {
    throw new UsageError(
      'Usage: madar install <claude|codex> [--uninstall]',
    )
  }
  const rest = args.slice(1)
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--uninstall')) {
    throw new UsageError(
      'Usage: madar install <claude|codex> [--uninstall]',
    )
  }
  return { platform, uninstall: rest[0] === '--uninstall' }
}
function progressLine(progress: {
  step: string
  message: string
  current?: number
  total?: number
}): string {
  const count = progress.current !== undefined
    && progress.total !== undefined
    && progress.total > 0
    ? ` (${progress.current}/${progress.total})`
    : ''
  return `[madar ${progress.step}] ${progress.message}${count}`
}
function generationSummary(result: {
  mode: string
  rootPath: string
  graphPath: string
  totalFiles: number
  indexedFiles: number
  nodeCount: number
  edgeCount: number
  warning?: string | null
  notes: readonly string[]
}): string {
  return [
    `[madar generate] ${result.mode} completed for ${result.rootPath}`,
    `- Indexed: ${result.indexedFiles}/${result.totalFiles} JavaScript/TypeScript file(s)`,
    `- Graph: ${result.nodeCount} nodes · ${result.edgeCount} edges`,
    `- Output: ${result.graphPath}`,
    ...(result.warning ? [`- Warning: ${result.warning}`] : []),
    ...result.notes.map((note) => `- Note: ${note}`),
  ].join('\n')
}
async function runGenerate(
  args: readonly string[],
  io: CliIO,
): Promise<number> {
  const options = parseGenerateArgs(args)
  const generateOptions = {
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
    onProgress: (progress: ProgressStep) => io.log(progressLine(progress)),
  } satisfies GenerateIndexOptions
  const result = options.update
    ? (await import('../../application/update-index.js'))
        .updateIndex(options.path, generateOptions)
    : (await import('../../application/generate-index.js'))
        .generateIndex(options.path, generateOptions)
  io.log(generationSummary(result))
  if (options.watch) {
    const { watchIndex } = await import('../../infrastructure/watch-index.js')
    await watchIndex(options.path, options.debounceSeconds, {
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
async function runQuery(args: readonly string[], io: CliIO): Promise<number> {
  const options = parseQueryArgs(args)
  const [artifact, application, index, workspace] = await Promise.all([
    import('../filesystem/graph-artifact.js'),
    import('../../application/retrieve-context.js'),
    import('../../domain/query/index-status.js'),
    import('../../shared/workspace.js'),
  ])
  const graphPath = workspace.resolveWorkspaceGraphPath(options.graphPath)
  const result = application.retrieveContext(
    index.inspectQueryIndex(artifact.loadGraphArtifact(graphPath)),
    {
      question: options.question,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
  )
  io.write(application.serializeRetrieveContextResult(result))
  return 0
}
async function runDiagnostic(
  command: 'doctor' | 'status',
  args: readonly string[],
  io: CliIO,
  cwd: string,
): Promise<number> {
  const graphPath = parseDiagnosticArgs(command, args)
  const doctor = await import('./doctor.js')
  const options = {
    projectDir: cwd,
    ...(graphPath === undefined ? {} : { graphPath }),
  }
  io.log(command === 'doctor'
    ? doctor.runDoctorCommand(options)
    : doctor.runStatusCommand(options))
  return 0
}
async function runInstall(args: readonly string[], io: CliIO): Promise<number> {
  const options = parseInstallArgs(args)
  const installer = await import('./install.js')
  const receipt = options.uninstall
    ? installer.uninstallClient(options.platform, process.cwd())
    : installer.installClient(options.platform, process.cwd())
  io.log(installer.formatInstallReceipt(receipt))
  return 0
}
async function runMcp(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (args.length > 0) throw new UsageError('Usage: madar mcp')
  const { serveMcpServer } = await import('../mcp/server.js')
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await serveMcpServer({
      signal: controller.signal,
      version: dependencies.version(),
      cwd: dependencies.cwd,
    })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
  return 0
}
export async function executeCli(
  argv: readonly string[],
  io: CliIO = {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    write: (message) => process.stdout.write(message),
  },
  dependencies: CliDependencies = {
    version: () => {
      throw new Error('Installed version reader was not provided')
    },
    cwd: process.cwd(),
  },
): Promise<number> {
  const [command, ...args] = argv
  switch (command) {
    case 'generate':
      return await runGenerate(args, io)
    case 'query':
      return await runQuery(args, io)
    case 'status':
    case 'doctor':
      return await runDiagnostic(command, args, io, dependencies.cwd)
    case 'install':
      return await runInstall(args, io)
    case 'mcp':
      return await runMcp(args, dependencies)
    default:
      throw new UsageError(
        `Unknown command ${JSON.stringify(command)}. Run 'madar --help' for the supported surface.`,
      )
  }
}
