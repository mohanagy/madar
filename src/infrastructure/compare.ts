import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import { CODE_EXTENSIONS, DOC_EXTENSIONS, MANIFEST_METADATA_KEY, OFFICE_EXTENSIONS, PAPER_EXTENSIONS } from '../pipeline/detect.js'
import { extractCompareBaselineNonCodeText } from '../pipeline/extract/non-code.js'
import { loadBenchmarkQuestions } from './benchmark/questions.js'
import { retrieveContext, tokenizeLabel, type RetrieveResult } from '../runtime/retrieve.js'
import { QUERY_TOKEN_ESTIMATOR, estimateQueryTokens, loadGraph } from '../runtime/serve.js'
import { sidecarAwareFileFingerprint } from '../shared/binary-ingest-sidecar.js'
import { MAX_TEXT_BYTES, validateGraphOutputPath, validateGraphPath } from '../shared/security.js'

export type CompareBaselineMode = 'full' | 'bounded'
export type CompareRunMode = 'baseline' | 'graphify'
export type CompareRunStatus = 'not_run' | 'succeeded' | 'failed' | 'context_overflow'
export type CompareFailureReason = 'prompt_too_long' | 'runner_error' | 'exec_error'
export type ComparePromptTokenSource = 'estimated_cl100k_base' | 'claude_reported_input'

export interface ComparePromptPack {
  kind: 'baseline' | 'graphify'
  question: string
  prompt: string
  token_count: number
}

export interface BuildBaselinePromptPackInput {
  question: string
  graph: KnowledgeGraph
  corpusText: string
  mode: CompareBaselineMode
  maxTokens?: number
}

export interface BuildGraphifyPromptPackInput {
  question: string
  retrieval: RetrieveResult
}

export interface ComparePromptArtifactPaths {
  output_dir: string
  baseline_prompt: string
  graphify_prompt: string
  report: string
}

export interface CompareAnswerArtifactPaths {
  baseline: string
  graphify: string
}

export interface CompareExecCommandSummary {
  command: string | null
  placeholders: string[]
  redacted: true
}

export interface ComparePromptTokenEstimator {
  source: string
  model: string
  exact: boolean
}

export interface ComparePromptUsage {
  provider: 'claude'
  source: 'structured_stdout'
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_total_tokens: number
  total_tokens: number
}

export interface ComparePromptReport {
  question: string
  graph_path: string
  exec_command: CompareExecCommandSummary
  baseline_mode: CompareBaselineMode
  baseline_prompt_tokens: number
  graphify_prompt_tokens: number
  reduction_ratio: number
  baseline_total_tokens: number | null
  graphify_total_tokens: number | null
  total_reduction_ratio: number | null
  baseline_prompt_tokens_estimated: number
  graphify_prompt_tokens_estimated: number
  reduction_ratio_estimated: number
  prompt_token_estimator: ComparePromptTokenEstimator
  prompt_token_source: {
    baseline: ComparePromptTokenSource
    graphify: ComparePromptTokenSource
  }
  usage: {
    baseline: ComparePromptUsage | null
    graphify: ComparePromptUsage | null
  }
  started_at: string
  completed_at: string
  elapsed_ms: {
    baseline: number
    graphify: number
  }
  status: {
    baseline: CompareRunStatus
    graphify: CompareRunStatus
  }
  answer_paths: CompareAnswerArtifactPaths
  exit_code: {
    baseline: number | null
    graphify: number | null
  }
  stderr: {
    baseline: string | null
    graphify: string | null
  }
  failure_reason: {
    baseline: CompareFailureReason | null
    graphify: CompareFailureReason | null
  }
  evidence: {
    baseline: string | null
    graphify: string | null
  }
  paths: ComparePromptArtifactPaths
}

export interface GenerateCompareArtifactsInput {
  graphPath: string
  question?: string | null
  questionsPath?: string | null
  outputDir: string
  execTemplate: string
  baselineMode: CompareBaselineMode
  corpusText?: string
  limit?: number | null
  retrievalBudget?: number
  baselineMaxTokens?: number
  now?: Date
}

export interface GenerateCompareArtifactsResult {
  graph_path: string
  output_root: string
  reports: ComparePromptReport[]
}

export interface CompareExecTemplateValues {
  promptFile: string
  question: string
  mode: CompareRunMode
  outputFile: string
}

export interface ComparePromptExecution {
  mode: CompareRunMode
  question: string
  promptFile: string
  outputFile: string
  command: string
}

export interface ComparePromptRunnerResult {
  exitCode: number
  stdout: string
  stderr: string
  elapsedMs: number
}

export interface ExecuteCompareRunsDependencies {
  runner?: (execution: ComparePromptExecution) => Promise<ComparePromptRunnerResult>
  now?: () => Date
}

interface ParsedCompareRunnerOutput {
  answerText: string | null
  usage: ComparePromptUsage | null
}

const DEFAULT_RETRIEVAL_BUDGET = 3_000
const DEFAULT_BOUNDED_BASELINE_TOKENS = 4_000
const EXEC_TEMPLATE_PLACEHOLDER_PATTERN = /\{[a-z_][a-z0-9_]*\}/gi
const COMPARE_EXEC_PLACEHOLDERS = new Set(['{prompt_file}', '{question}', '{mode}', '{output_file}'])
const CONTEXT_OVERFLOW_PATTERNS = [
  /\bprompt is too long\b/i,
  /\bcontext (?:window|length) (?:exceeded|overflow|too (?:long|large|big))\b/i,
  /\b(?:maximum|max) context\b/i,
  /\btoo many tokens\b/i,
]
const PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS = [
  /\$\([^)]*\{prompt_file\}[^)]*\)/i,
  /`[^`]*\{prompt_file\}[^`]*`/i,
]

function timestampDirectoryName(date: Date): string {
  const iso = date.toISOString()
  return iso.slice(0, 19).replace(/:/g, '-')
}

function summarizeExecTemplate(execTemplate: string): CompareExecCommandSummary {
  const placeholders = [...execTemplate.matchAll(EXEC_TEMPLATE_PLACEHOLDER_PATTERN)].map((match) => match[0])

  return {
    command: null,
    placeholders: [...new Set(placeholders)],
    redacted: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseStructuredCompareAnswer(payload: Record<string, unknown>): string | null {
  if (typeof payload.result === 'string') {
    return payload.result
  }
  if (typeof payload.completion === 'string') {
    return payload.completion
  }
  return null
}

function parseClaudeStructuredUsage(payload: Record<string, unknown>): ComparePromptUsage | null {
  if (!isRecord(payload.usage)) {
    return null
  }

  const inputTokens = parseNonNegativeNumber(payload.usage.input_tokens)
  const outputTokens = parseNonNegativeNumber(payload.usage.output_tokens)
  if (inputTokens === null || outputTokens === null) {
    return null
  }

  const cacheCreationInputTokens = parseNonNegativeNumber(payload.usage.cache_creation_input_tokens) ?? 0
  const cacheReadInputTokens = parseNonNegativeNumber(payload.usage.cache_read_input_tokens) ?? 0
  const inputTotalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens

  return {
    provider: 'claude',
    source: 'structured_stdout',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    input_total_tokens: inputTotalTokens,
    total_tokens: inputTotalTokens + outputTokens,
  }
}

function parseStructuredCompareRunnerOutput(stdout: string): ParsedCompareRunnerOutput | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (!isRecord(payload)) {
    return null
  }

  const answerText = parseStructuredCompareAnswer(payload)
  const usage = parseClaudeStructuredUsage(payload)
  if (answerText === null && usage === null) {
    return null
  }

  return {
    answerText,
    usage,
  }
}

function validateCompareExecTemplate(template: string): void {
  if (PROMPT_FILE_COMMAND_SUBSTITUTION_PATTERNS.some((pattern) => pattern.test(template))) {
    throw new Error(
      'Exec templates must not expand {prompt_file} with shell command substitution. Use stdin or file redirection with {prompt_file}, for example: cat {prompt_file} | claude -p',
    )
  }
}

function shellEscape(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `'${value.replaceAll("'", "''")}'`
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

export function expandCompareExecTemplate(
  template: string,
  values: CompareExecTemplateValues,
  platform: NodeJS.Platform = process.platform,
): string {
  return template.replaceAll(EXEC_TEMPLATE_PLACEHOLDER_PATTERN, (placeholder) => {
    const normalizedPlaceholder = placeholder.toLowerCase()
    if (!COMPARE_EXEC_PLACEHOLDERS.has(normalizedPlaceholder)) {
      throw new Error(`Unknown compare exec placeholder: ${placeholder}`)
    }

    if (normalizedPlaceholder === '{prompt_file}') {
      return shellEscape(values.promptFile, platform)
    }
    if (normalizedPlaceholder === '{question}') {
      return shellEscape(values.question, platform)
    }
    if (normalizedPlaceholder === '{mode}') {
      return shellEscape(values.mode, platform)
    }
    return shellEscape(values.outputFile, platform)
  })
}

function writeCompareReport(report: ComparePromptReport): void {
  writeFileSync(
    report.paths.report,
    `${JSON.stringify(
      {
        ...report,
        graph_path: portablePath(report.graph_path),
        answer_paths: {
          baseline: portablePath(report.answer_paths.baseline),
          graphify: portablePath(report.answer_paths.graphify),
        },
        paths: {
          output_dir: portablePath(report.paths.output_dir),
          baseline_prompt: portablePath(report.paths.baseline_prompt),
          graphify_prompt: portablePath(report.paths.graphify_prompt),
          report: portablePath(report.paths.report),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

async function defaultComparePromptRunner(execution: ComparePromptExecution): Promise<ComparePromptRunnerResult> {
  const startedAt = Date.now()

  return await new Promise<ComparePromptRunnerResult>((resolveExecution, rejectExecution) => {
    const command =
      process.platform === 'win32'
        ? {
            file: 'powershell.exe',
            args: ['-NoProfile', '-Command', execution.command],
          }
        : {
            file: '/bin/sh',
            args: ['-lc', execution.command],
          }
    const child = spawn(command.file, command.args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: string | Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      rejectExecution(error)
    })
    child.on('close', (code) => {
      resolveExecution({
        exitCode: code ?? 1,
        stdout,
        stderr,
        elapsedMs: Date.now() - startedAt,
      })
    })
  })
}

function answerFilePath(outputDir: string, mode: CompareRunMode): string {
  return join(outputDir, `${mode}-answer.txt`)
}

function ensureCompareAnswerFile(filePath: string, stdout: string): void {
  if (existsSync(filePath)) {
    return
  }
  writeFileSync(filePath, stdout, 'utf8')
}

function sanitizeCompareStderr(stderr: string): string | null {
  const trimmed = stderr.trim()
  if (!trimmed) {
    return null
  }

  const redacted = trimmed
    .replaceAll(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replaceAll(/(Bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
  const maxLength = 2_000
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength).trimEnd()}\n…[truncated]` : redacted
}

function summarizeCompareRunnerStderr(stderr: string): string | null {
  const sanitized = sanitizeCompareStderr(stderr)
  if (sanitized === null) {
    return null
  }
  return `stderr omitted for safety (${sanitized.length} chars captured)`
}

function extractContextOverflowEvidence(...messages: string[]): string | null {
  const combined = messages.map((message) => message.trim()).filter((message) => message.length > 0).join('\n')
  if (!CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(combined))) {
    return null
  }

  const matchingLine = combined.split(/\r?\n/).find((line) => CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(line))) ?? combined
  return sanitizeCompareStderr(matchingLine)
}

function createCompareOutputRoot(outputDir: string, date: Date): string {
  mkdirSync(outputDir, { recursive: true })

  const timestampDirectory = timestampDirectoryName(date)
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = join(
      outputDir,
      suffix === 0 ? timestampDirectory : `${timestampDirectory}-${String(suffix).padStart(3, '0')}`,
    )

    try {
      mkdirSync(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue
      }
      throw error
    }
  }

  throw new Error(`Unable to create a unique compare output directory inside ${outputDir}`)
}

function renderBaselinePrompt(question: string, graph: KnowledgeGraph, corpusBody: string, mode: CompareBaselineMode): string {
  return [
    'Answer the question using only the provided project corpus.',
    'If the corpus does not contain the answer, say so.',
    '',
    `Question:\n${question}`,
    '',
    'Project graph summary:',
    `- Nodes: ${graph.numberOfNodes()}`,
    `- Edges: ${graph.numberOfEdges()}`,
    '',
    `Corpus (${mode}):`,
    corpusBody,
    '',
    'Answer:',
  ].join('\n')
}

function buildBoundedCorpusExcerpt(question: string, graph: KnowledgeGraph, corpusText: string, maxTokens: number): string {
  const note = '[bounded baseline excerpt]'
  let excerpt = corpusText.trim()
  let prompt = renderBaselinePrompt(question, graph, `${note}\n${excerpt}`, 'bounded')
  while (estimateQueryTokens(prompt) > maxTokens && excerpt.length > 0) {
    excerpt = excerpt.slice(0, Math.max(0, Math.floor(excerpt.length * 0.9))).trimEnd()
    prompt = renderBaselinePrompt(question, graph, `${note}\n${excerpt}`, 'bounded')
  }

  if (estimateQueryTokens(prompt) > maxTokens) {
    throw new Error(`Bounded baseline token budget ${maxTokens} is too small for the compare prompt floor.`)
  }

  return `${note}\n${excerpt}`.trimEnd()
}

function formatGraphifyContext(retrieval: RetrieveResult): string {
  const nodeLines = retrieval.matched_nodes.map((node) => {
    const source = node.source_file ? ` @ ${node.source_file}${node.line_number > 0 ? `:${node.line_number}` : ''}` : ''
    const community = node.community_label ? ` [${node.community_label}]` : ''
    const snippet = node.snippet ? `\n  ${node.snippet}` : ''
    return `- ${node.label}${source}${community}${snippet}`
  })
  const relationshipLines = retrieval.relationships.map((relationship) => `- ${relationship.from} -[${relationship.relation}]-> ${relationship.to}`)
  const communityLines = retrieval.community_context.map((community) => `- ${community.label} (${community.node_count} nodes)`)
  const signalLines = [...retrieval.graph_signals.god_nodes, ...retrieval.graph_signals.bridge_nodes]

  const sections = [
    ['Matched nodes:', ...(nodeLines.length > 0 ? nodeLines : ['- (none)'])],
    ['Relationships:', ...(relationshipLines.length > 0 ? relationshipLines : ['- (none)'])],
    ...(communityLines.length > 0 ? [['Community context:', ...communityLines]] : []),
    ...(signalLines.length > 0 ? [['Graph signals:', `- ${signalLines.join(', ')}`]] : []),
  ]

  return sections.map((section) => section.join('\n')).join('\n\n')
}

function computeReductionRatio(baselinePromptTokens: number, graphifyPromptTokens: number): number {
  if (baselinePromptTokens <= 0 || graphifyPromptTokens <= 0) {
    return 0
  }
  return Number((baselinePromptTokens / graphifyPromptTokens).toFixed(1))
}

function formatTokenComparison(baselineTokens: number, graphifyTokens: number): string {
  if (baselineTokens <= 0 || graphifyTokens <= 0) {
    return 'n/a'
  }
  if (baselineTokens === graphifyTokens) {
    return 'same size'
  }
  if (baselineTokens > graphifyTokens) {
    return `${computeReductionRatio(baselineTokens, graphifyTokens)}x smaller`
  }
  return `${Number((graphifyTokens / baselineTokens).toFixed(1))}x larger`
}

function syncComparePromptMetrics(report: ComparePromptReport): void {
  report.baseline_prompt_tokens = report.usage.baseline?.input_total_tokens ?? report.baseline_prompt_tokens_estimated
  report.graphify_prompt_tokens = report.usage.graphify?.input_total_tokens ?? report.graphify_prompt_tokens_estimated
  report.reduction_ratio = computeReductionRatio(report.baseline_prompt_tokens, report.graphify_prompt_tokens)
  report.baseline_total_tokens = report.usage.baseline?.total_tokens ?? null
  report.graphify_total_tokens = report.usage.graphify?.total_tokens ?? null
  report.total_reduction_ratio =
    report.baseline_total_tokens !== null && report.graphify_total_tokens !== null
      ? computeReductionRatio(report.baseline_total_tokens, report.graphify_total_tokens)
      : null
  report.prompt_token_source.baseline = report.usage.baseline === null ? 'estimated_cl100k_base' : 'claude_reported_input'
  report.prompt_token_source.graphify = report.usage.graphify === null ? 'estimated_cl100k_base' : 'claude_reported_input'
}

function portablePath(path: string): string {
  return relative(process.cwd(), path) || '.'
}

function inferProjectRootFromGraphPath(graphPath: string): string {
  let currentPath = dirname(resolve(graphPath))

  while (dirname(currentPath) !== currentPath) {
    if (basename(currentPath) === 'graphify-out') {
      return dirname(currentPath)
    }
    currentPath = dirname(currentPath)
  }

  return dirname(resolve(graphPath))
}

function loadGraphBackedManifestFingerprints(graphPath: string): Map<string, number> {
  const manifestPath = join(dirname(resolve(graphPath)), 'manifest.json')
  if (!existsSync(manifestPath)) {
    return new Map()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  } catch {
    throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
  }

  const manifestEntries = Object.entries(parsed as Record<string, unknown>).filter(([key]) => key !== MANIFEST_METADATA_KEY)
  for (const [, fingerprint] of manifestEntries) {
    if (typeof fingerprint !== 'number' || !Number.isFinite(fingerprint)) {
      throw new Error(`Compare baseline manifest is invalid: ${manifestPath}`)
    }
  }

  return new Map(manifestEntries.map(([filePath, fingerprint]) => [resolve(filePath), fingerprint as number]))
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, targetPath)
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function isReadableCorpusPath(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return (
    CODE_EXTENSIONS.has(extension) ||
    DOC_EXTENSIONS.has(extension) ||
    PAPER_EXTENSIONS.has(extension) ||
    OFFICE_EXTENSIONS.has(extension)
  )
}

function collectGraphBackedCorpusFiles(graph: KnowledgeGraph, projectRoot: string): string[] {
  return graph.nodeEntries()
    .map(([, attributes]) => String(attributes.source_file ?? '').trim())
    .filter((sourceFile) => sourceFile.length > 0)
    .map((sourceFile) => resolve(projectRoot, sourceFile))
}

function collectBaselineCorpusFiles(graph: KnowledgeGraph, projectRoot: string, manifestFingerprints: ReadonlyMap<string, number>): string[] {
  if (manifestFingerprints.size > 0) {
    return [...manifestFingerprints.keys()]
  }

  return collectGraphBackedCorpusFiles(graph, projectRoot)
}

function resolveCompareSnippetPath(sourceFile: string, projectRoot: string): string | null {
  if (sourceFile.length === 0) {
    return null
  }

  const candidatePath = isAbsolute(sourceFile) ? sourceFile : resolve(projectRoot, sourceFile)
  const normalizedPath = existsSync(candidatePath) ? realpathSync(candidatePath) : resolve(candidatePath)

  if (isPathWithinRoot(normalizedPath, projectRoot)) {
    return normalizedPath
  }

  return null
}

function createCompareRetrievalGraph(
  graph: KnowledgeGraph,
  projectRoot: string,
): { graph: KnowledgeGraph; originalSourceFiles: Map<string, string> } {
  const retrievalGraph = new KnowledgeGraph(graph.isDirected())
  Object.assign(retrievalGraph.graph, graph.graph)

  const originalSourceFiles = new Map<string, string>()
  let outsideSourceIndex = 0
  for (const [id, attributes] of graph.nodeEntries()) {
    const sourceFile = String(attributes.source_file ?? '')
    const safeSourceFileTokens = tokenizeLabel(sourceFile)
    const retrievalSourceFile =
      sourceFile.length > 0 && resolveCompareSnippetPath(sourceFile, projectRoot) === null
        ? `__compare_outside__/${
            safeSourceFileTokens.length > 0 ? safeSourceFileTokens.join('/') : 'source'
          }%${outsideSourceIndex}`
        : sourceFile
    if (retrievalSourceFile !== sourceFile) {
      outsideSourceIndex += 1
    }

    retrievalGraph.addNode(id, {
      ...attributes,
      ...(retrievalSourceFile !== sourceFile ? { source_file: retrievalSourceFile } : {}),
    })
    if (retrievalSourceFile !== sourceFile) {
      originalSourceFiles.set(retrievalSourceFile, sourceFile)
    }
  }

  for (const [source, target, attributes] of graph.edgeEntries()) {
    retrievalGraph.addEdge(source, target, attributes)
  }

  return { graph: retrievalGraph, originalSourceFiles }
}

function retrieveCompareContext(graph: KnowledgeGraph, question: string, budget: number, projectRoot: string): RetrieveResult {
  const { graph: retrievalGraph, originalSourceFiles } = createCompareRetrievalGraph(graph, projectRoot)
  const originalCwd = process.cwd()
  try {
    process.chdir(projectRoot)
    const retrieval = retrieveContext(retrievalGraph, { question, budget })
    for (const matchedNode of retrieval.matched_nodes) {
      matchedNode.source_file = originalSourceFiles.get(matchedNode.source_file) ?? matchedNode.source_file
    }
    return retrieval
  } finally {
    process.chdir(originalCwd)
  }
}

function addBaselineCorpusFile(
  files: Map<string, string>,
  candidatePath: string,
  realProjectRoot: string,
  manifestFingerprints: ReadonlyMap<string, number>,
): void {
  const expectsTextContent = isReadableCorpusPath(candidatePath)
  const expectedFingerprint = manifestFingerprints.get(resolve(candidatePath))
  let absolutePath: string
  try {
    absolutePath = realpathSync(candidatePath)
  } catch {
    if (expectsTextContent) {
      throw new Error(`Compare baseline could not read graph-backed file: ${candidatePath}`)
    }
    return
  }

  if (!isPathWithinRoot(absolutePath, realProjectRoot)) {
    return
  }

  if (!isReadableCorpusPath(absolutePath)) {
    return
  }

  if (expectedFingerprint !== undefined) {
    const modifiedAt = statSync(candidatePath).mtimeMs
    if (sidecarAwareFileFingerprint(candidatePath, modifiedAt) !== expectedFingerprint) {
      throw new Error(`Compare baseline graph-backed file is out of sync with the saved graph snapshot: ${candidatePath}`)
    }
  }

  const corpusPath = relative(realProjectRoot, absolutePath).replaceAll(sep, '/')
  if (files.has(corpusPath)) {
    return
  }

  const corpusText = readBaselineCorpusFile(absolutePath)
  if (corpusText === null) {
    return
  }

  files.set(corpusPath, corpusText)
}

function readBaselineCorpusFile(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase()

  if (CODE_EXTENSIONS.has(extension) || DOC_EXTENSIONS.has(extension)) {
    if (statSync(filePath).size > MAX_TEXT_BYTES) {
      return null
    }
    return readFileSync(filePath, 'utf8').trimEnd()
  }

  const nonCodeText = extractCompareBaselineNonCodeText(filePath)
  return nonCodeText
}

function deriveBaselineCorpusText(graphPath: string, graph: KnowledgeGraph): string {
  const projectRoot = inferProjectRootFromGraphPath(graphPath)
  const realProjectRoot = realpathSync(projectRoot)
  const manifestFingerprints = loadGraphBackedManifestFingerprints(graphPath)
  const candidateFiles = collectBaselineCorpusFiles(graph, projectRoot, manifestFingerprints)
  const files = new Map<string, string>()

  for (const candidatePath of candidateFiles) {
    addBaselineCorpusFile(files, candidatePath, realProjectRoot, manifestFingerprints)
  }

  if (files.size === 0) {
    throw new Error('Unable to derive a baseline corpus from graph-backed project files.')
  }

  return [...files.entries()]
    .flatMap(([filePath, content]) => [filePath, content, ''])
    .join('\n')
    .trimEnd()
}

export function buildBaselinePromptPack(input: BuildBaselinePromptPackInput): ComparePromptPack {
  const corpusText = input.corpusText.trim()
  const corpusBody =
    input.mode === 'bounded'
      ? buildBoundedCorpusExcerpt(input.question, input.graph, corpusText, input.maxTokens ?? DEFAULT_BOUNDED_BASELINE_TOKENS)
      : corpusText
  const prompt = renderBaselinePrompt(input.question, input.graph, corpusBody, input.mode)

  return {
    kind: 'baseline',
    question: input.question,
    prompt,
    token_count: estimateQueryTokens(prompt),
  }
}

export function buildGraphifyPromptPack(input: BuildGraphifyPromptPackInput): ComparePromptPack {
  const prompt = [
    'Answer the question using only the provided graph-guided retrieval output.',
    'If the retrieval does not contain the answer, say so.',
    '',
    `Question:\n${input.question}`,
    '',
    'Retrieved graph context:',
    formatGraphifyContext(input.retrieval),
    '',
    'Answer:',
  ].join('\n')

  return {
    kind: 'graphify',
    question: input.question,
    prompt,
    token_count: estimateQueryTokens(prompt),
  }
}

export function resolveCompareQuestions(options: Pick<GenerateCompareArtifactsInput, 'question' | 'questionsPath' | 'limit'>): string[] {
  if (options.question !== undefined && options.question !== null && options.questionsPath !== undefined && options.questionsPath !== null) {
    throw new Error('Compare runtime accepts either a single question or a questions path, but not both.')
  }

  if (options.limit !== undefined && options.limit !== null) {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new Error('Compare runtime limit must be a positive integer.')
    }
  }

  const rawQuestions =
    options.questionsPath !== undefined && options.questionsPath !== null
      ? loadBenchmarkQuestions(options.questionsPath).map((entry) => entry.question)
      : options.question !== undefined && options.question !== null
        ? [options.question]
        : []

  const trimmedQuestions = rawQuestions.map((question) => question.trim()).filter((question) => question.length > 0)
  if (trimmedQuestions.length === 0) {
    throw new Error('No compare questions were provided.')
  }

  if (options.limit !== undefined && options.limit !== null) {
      return trimmedQuestions.slice(0, options.limit)
  }

  return trimmedQuestions
}

export function generateCompareArtifacts(input: GenerateCompareArtifactsInput): GenerateCompareArtifactsResult {
  const graphPath = validateGraphPath(input.graphPath)
  const graph = loadGraph(graphPath)
  const corpusText = input.corpusText ?? deriveBaselineCorpusText(graphPath, graph)
  const questions = resolveCompareQuestions(input)
  const outputDir = validateGraphOutputPath(input.outputDir)
  const now = input.now ?? new Date()
  const outputRoot = createCompareOutputRoot(outputDir, now)

  const reports = questions.map((question, index) => {
    const questionOutputDir = questions.length === 1 ? outputRoot : join(outputRoot, `question-${String(index + 1).padStart(3, '0')}`)
    mkdirSync(questionOutputDir, { recursive: true })

    const baselinePrompt = buildBaselinePromptPack({
      question,
      graph,
      corpusText,
      mode: input.baselineMode,
      ...(input.baselineMaxTokens !== undefined ? { maxTokens: input.baselineMaxTokens } : {}),
    })
    const projectRoot = realpathSync(inferProjectRootFromGraphPath(graphPath))
    const retrievalBudget = input.retrievalBudget ?? DEFAULT_RETRIEVAL_BUDGET
    const retrieval = retrieveCompareContext(graph, question, retrievalBudget, projectRoot)
    const graphifyPrompt = buildGraphifyPromptPack({ question, retrieval })

    const paths: ComparePromptArtifactPaths = {
      output_dir: questionOutputDir,
      baseline_prompt: join(questionOutputDir, 'baseline-prompt.txt'),
      graphify_prompt: join(questionOutputDir, 'graphify-prompt.txt'),
      report: join(questionOutputDir, 'report.json'),
    }
    const answerPaths: CompareAnswerArtifactPaths = {
      baseline: answerFilePath(questionOutputDir, 'baseline'),
      graphify: answerFilePath(questionOutputDir, 'graphify'),
    }

    const baselinePromptText = baselinePrompt.prompt
    const graphifyPromptText = graphifyPrompt.prompt

    writeFileSync(paths.baseline_prompt, baselinePromptText, 'utf8')
    writeFileSync(paths.graphify_prompt, graphifyPromptText, 'utf8')

    const baselinePromptTokens = estimateQueryTokens(baselinePromptText)
    const graphifyPromptTokens = estimateQueryTokens(graphifyPromptText)

    const report: ComparePromptReport = {
      question,
      graph_path: graphPath,
      exec_command: summarizeExecTemplate(input.execTemplate),
      baseline_mode: input.baselineMode,
      baseline_prompt_tokens: baselinePromptTokens,
      graphify_prompt_tokens: graphifyPromptTokens,
      reduction_ratio: computeReductionRatio(baselinePromptTokens, graphifyPromptTokens),
      baseline_total_tokens: null,
      graphify_total_tokens: null,
      total_reduction_ratio: null,
      baseline_prompt_tokens_estimated: baselinePromptTokens,
      graphify_prompt_tokens_estimated: graphifyPromptTokens,
      reduction_ratio_estimated: computeReductionRatio(baselinePromptTokens, graphifyPromptTokens),
      prompt_token_estimator: QUERY_TOKEN_ESTIMATOR,
      prompt_token_source: {
        baseline: 'estimated_cl100k_base',
        graphify: 'estimated_cl100k_base',
      },
      usage: {
        baseline: null,
        graphify: null,
      },
      started_at: now.toISOString(),
      completed_at: now.toISOString(),
      elapsed_ms: {
        baseline: 0,
        graphify: 0,
      },
      status: {
        baseline: 'not_run',
        graphify: 'not_run',
      },
      answer_paths: answerPaths,
      exit_code: {
        baseline: null,
        graphify: null,
      },
      stderr: {
        baseline: null,
        graphify: null,
      },
      failure_reason: {
        baseline: null,
        graphify: null,
      },
      evidence: {
        baseline: null,
        graphify: null,
      },
      paths,
    }

    syncComparePromptMetrics(report)
    writeCompareReport(report)
    return report
  })

  return {
    graph_path: graphPath,
    output_root: resolve(outputRoot),
    reports,
  }
}

export async function executeCompareRuns(
  input: GenerateCompareArtifactsInput,
  dependencies: ExecuteCompareRunsDependencies = {},
): Promise<GenerateCompareArtifactsResult> {
  const result = generateCompareArtifacts(input)
  const runPrompt = dependencies.runner ?? defaultComparePromptRunner
  const now = dependencies.now ?? (() => new Date())

  for (const report of result.reports) {
    const executions: Array<{
      mode: CompareRunMode
      promptFile: string
      outputFile: string
    }> = [
      {
        mode: 'baseline',
        promptFile: report.paths.baseline_prompt,
        outputFile: report.answer_paths.baseline,
      },
      {
        mode: 'graphify',
        promptFile: report.paths.graphify_prompt,
        outputFile: report.answer_paths.graphify,
      },
    ]

    for (const execution of executions) {
      try {
        validateCompareExecTemplate(input.execTemplate)
        const command = expandCompareExecTemplate(input.execTemplate, {
          promptFile: execution.promptFile,
          question: report.question,
          mode: execution.mode,
          outputFile: execution.outputFile,
        })
        const executionResult = await runPrompt({
          ...execution,
          question: report.question,
          command,
        })
        const parsedOutput = parseStructuredCompareRunnerOutput(executionResult.stdout)
        ensureCompareAnswerFile(
          execution.outputFile,
          parsedOutput === null ? executionResult.stdout : parsedOutput.answerText ?? '',
        )
        const contextOverflowEvidence =
          executionResult.exitCode === 0 ? null : extractContextOverflowEvidence(executionResult.stdout, executionResult.stderr)
        report.usage[execution.mode] = executionResult.exitCode === 0 ? parsedOutput?.usage ?? null : null
        report.status[execution.mode] =
          executionResult.exitCode === 0 ? 'succeeded' : contextOverflowEvidence !== null ? 'context_overflow' : 'failed'
        report.elapsed_ms[execution.mode] = executionResult.elapsedMs
        report.exit_code[execution.mode] = executionResult.exitCode
        report.stderr[execution.mode] = summarizeCompareRunnerStderr(executionResult.stderr)
        report.failure_reason[execution.mode] =
          executionResult.exitCode === 0 ? null : contextOverflowEvidence !== null ? 'prompt_too_long' : 'runner_error'
        report.evidence[execution.mode] = contextOverflowEvidence
      } catch (error) {
        ensureCompareAnswerFile(execution.outputFile, '')
        report.usage[execution.mode] = null
        const errorMessage = error instanceof Error ? error.message : String(error)
        const contextOverflowEvidence = extractContextOverflowEvidence(errorMessage)
        report.status[execution.mode] = contextOverflowEvidence !== null ? 'context_overflow' : 'failed'
        report.elapsed_ms[execution.mode] = 0
        report.exit_code[execution.mode] = null
        report.stderr[execution.mode] = sanitizeCompareStderr(errorMessage)
        report.failure_reason[execution.mode] = contextOverflowEvidence !== null ? 'prompt_too_long' : 'exec_error'
        report.evidence[execution.mode] = contextOverflowEvidence
      }

      syncComparePromptMetrics(report)
      report.completed_at = now().toISOString()
      writeCompareReport(report)
    }
  }

  return result
}

function sumPromptTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number {
  return reports.reduce((total, report) => total + (mode === 'baseline' ? report.baseline_prompt_tokens : report.graphify_prompt_tokens), 0)
}

function sumTotalTokens(reports: readonly ComparePromptReport[], mode: CompareRunMode): number | null {
  let total = 0
  for (const report of reports) {
    const value = mode === 'baseline' ? report.baseline_total_tokens : report.graphify_total_tokens
    if (value === null) {
      return null
    }
    total += value
  }
  return total
}

function countPromptRuns(reports: readonly ComparePromptReport[], status: Exclude<CompareRunStatus, 'not_run'>): number {
  return reports.reduce((total, report) => {
    const baseline = report.status.baseline === status ? 1 : 0
    const graphify = report.status.graphify === status ? 1 : 0
    return total + baseline + graphify
  }, 0)
}

function countPromptUsageRuns(reports: readonly ComparePromptReport[]): number {
  return reports.reduce((total, report) => total + (report.usage.baseline === null ? 0 : 1) + (report.usage.graphify === null ? 0 : 1), 0)
}

export function formatCompareSummary(result: GenerateCompareArtifactsResult): string {
  const baselineTokens = sumPromptTokens(result.reports, 'baseline')
  const graphifyTokens = sumPromptTokens(result.reports, 'graphify')
  const baselineTotalTokens = sumTotalTokens(result.reports, 'baseline')
  const graphifyTotalTokens = sumTotalTokens(result.reports, 'graphify')
  const totalReductionRatio =
    baselineTotalTokens !== null && graphifyTotalTokens !== null ? computeReductionRatio(baselineTotalTokens, graphifyTotalTokens) : null
  const failedRuns = countPromptRuns(result.reports, 'failed')
  const contextOverflowRuns = countPromptRuns(result.reports, 'context_overflow')
  const succeededRuns = countPromptRuns(result.reports, 'succeeded')
  const usageRuns = countPromptUsageRuns(result.reports)
  const totalRuns = result.reports.length * 2
  const promptTokenLabel =
    usageRuns === totalRuns
      ? 'Input tokens (Claude reported)'
      : usageRuns > 0
        ? `Input tokens (Claude reported where available; ${QUERY_TOKEN_ESTIMATOR.model} estimate fallback)`
        : `Prompt tokens (estimated ${QUERY_TOKEN_ESTIMATOR.model})`

  const lines = [
    `[graphify compare] completed ${result.reports.length} question(s)`,
    `- Output: ${result.output_root}`,
    `- ${promptTokenLabel}: baseline ${baselineTokens} · graphify ${graphifyTokens} · ${formatTokenComparison(baselineTokens, graphifyTokens)}`,
    `- Prompt runs: ${succeededRuns} succeeded${contextOverflowRuns > 0 ? ` · ${contextOverflowRuns} context overflow` : ''}${
      failedRuns > 0 ? ` · ${failedRuns} failed` : ''
    }`,
  ]

  if (baselineTotalTokens !== null && graphifyTotalTokens !== null && totalReductionRatio !== null) {
    lines.splice(3, 0, `- Total tokens (Claude reported): baseline ${baselineTotalTokens} · graphify ${graphifyTotalTokens} · ${formatTokenComparison(baselineTotalTokens, graphifyTotalTokens)}`)
  } else if (usageRuns > 0 && usageRuns < totalRuns) {
    lines.splice(3, 0, `- Usage capture: Claude reported usage for ${usageRuns}/${totalRuns} prompt runs; remaining runs used local estimate fallback`)
  }

  return lines.join('\n')
}

export async function runCompareCommand(
  input: GenerateCompareArtifactsInput,
  dependencies: ExecuteCompareRunsDependencies = {},
): Promise<string> {
  const result = await executeCompareRuns(input, dependencies)
  const failedRuns = countPromptRuns(result.reports, 'failed')
  if (failedRuns > 0) {
    throw new Error(`[graphify compare] ${failedRuns} prompt run(s) failed. Partial artifacts were saved under ${result.output_root}`)
  }
  return formatCompareSummary(result)
}
