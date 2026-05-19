import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { strToU8, zipSync } from 'fflate'
import { vi } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import {
  buildBaselinePromptPack,
  buildGraphifyPromptPack,
  executeCompareRuns,
  expandCompareExecTemplate,
  formatCompareSummary,
  generateCompareArtifacts,
  runCompareCommand,
  resolveCompareQuestions,
} from '../../src/infrastructure/compare.js'
import { parsePromptRunnerOutput } from '../../src/infrastructure/prompt-runner.js'
import { saveManifest } from '../../src/pipeline/manifest.js'
import { toJson } from '../../src/pipeline/export.js'
import * as retrieveRuntime from '../../src/runtime/retrieve.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { estimateQueryTokens } from '../../src/runtime/serve.js'
import { MAX_TEXT_BYTES } from '../../src/shared/security.js'
import { sanitizeShareSafeText } from '../../src/shared/share-safe-artifacts.js'

const PROJECT_FIXTURE_ROOT = resolve('graphify-out', 'test-runtime', 'compare-runtime-project')
const GRAPH_FIXTURE_ROOT = join(PROJECT_FIXTURE_ROOT, 'graphify-out')
const COMPARE_OUTPUT_ROOT = resolve('graphify-out', 'compare', 'test-runtime')

function makeGraph(): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('auth_user', {
    label: 'authenticateUser',
    source_file: 'src/auth.ts',
    source_location: 'L10',
    line_number: 10,
    node_kind: 'function',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_manager', {
    label: 'SessionManager',
    source_file: 'src/session.ts',
    source_location: 'L3',
    line_number: 3,
    node_kind: 'class',
    file_type: 'code',
    community: 0,
  })
  graph.addNode('session_store', {
    label: 'SessionStore',
    source_file: 'src/session-store.ts',
    source_location: 'L1',
    line_number: 1,
    node_kind: 'class',
    file_type: 'code',
    community: 1,
  })
  graph.addEdge('auth_user', 'session_manager', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: 'src/auth.ts',
  })
  graph.addEdge('session_manager', 'session_store', {
    relation: 'uses',
    confidence: 'EXTRACTED',
    source_file: 'src/session.ts',
  })
  return graph
}

function makeProjectFiles(): Record<string, string> {
  return {
    'src/auth.ts': [
      'export function authenticateUser(credentials) {',
      '  return new SessionManager().createSession(credentials.userId)',
      '}',
    ].join('\n'),
    'src/session.ts': [
      'export class SessionManager {',
      '  createSession(userId) {',
      '    return new SessionStore().write(userId)',
      '  }',
      '}',
    ].join('\n'),
    'src/session-store.ts': [
      'export class SessionStore {',
      '  write(userId) {',
      '    return `session:${userId}`',
      '  }',
      '}',
    ].join('\n'),
    'src/routes.ts': [
      'export function registerRoutes(app) {',
      '  app.post("/login", authenticateUser)',
      '  app.get("/health", () => "ok")',
      '}',
    ].join('\n'),
    'src/config.ts': [
      'export const config = {',
      '  sessionCookieName: "sid",',
      '  sessionTtlSeconds: 86400,',
      '  loginAuditChannel: "auth-login",',
      '}',
    ].join('\n'),
    'docs/architecture.md': [
      'The login flow starts in the HTTP route, validates credentials, and writes a session through the session manager.',
      'The billing system, reporting jobs, and queue worker are unrelated to login but live in the same repository corpus.',
      'This full-corpus baseline intentionally includes unrelated material so the compare prompt has more naive context to carry.',
    ].join('\n'),
    'src/billing.ts': [
      'export function buildInvoiceSummary(accountId) {',
      '  return { accountId, total: 0, currency: "USD" }',
      '}',
    ].join('\n'),
    'src/reports.ts': [
      'export function buildMonthlyRevenueReport() {',
      '  return []',
      '}',
    ].join('\n'),
  }
}

function makeCorpusText(): string {
  return Object.entries(makeProjectFiles())
    .flatMap(([path, content]) => [path, content, ''])
    .join('\n')
    .trimEnd()
}

function makeGraphBackedNonCodeFixture(kind: 'pdf' | 'docx' | 'xlsx'): {
  relativePath: string
  fileType: 'paper' | 'document'
  nodeLabel: string
  expectedExcerpt: string
  content: Buffer | string
} {
  if (kind === 'pdf') {
    return {
      relativePath: 'docs/login-flow.pdf',
      fileType: 'paper',
      nodeLabel: 'Login Flow PDF',
      expectedExcerpt: 'PDF login flow creates a session token',
      content: [
        '%PDF-1.4',
        '1 0 obj',
        '<< /Title (Login Flow PDF) /Author (graphify-ts) /Subject (Authentication) >>',
        'endobj',
        'BT',
        '(PDF login flow creates a session token) Tj',
        'ET',
      ].join('\n'),
    }
  }

  if (kind === 'docx') {
    return {
      relativePath: 'docs/login-flow.docx',
      fileType: 'document',
      nodeLabel: 'Login Flow Docx',
      expectedExcerpt: 'DOCX login flow creates a session token',
      content: Buffer.from(
        zipSync({
          'word/document.xml': strToU8(
            [
              '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
              '  <w:body>',
              '    <w:p><w:r><w:t>DOCX login flow creates a session token</w:t></w:r></w:p>',
              '  </w:body>',
              '</w:document>',
            ].join(''),
          ),
          'docProps/core.xml': strToU8(
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Login Flow Docx</dc:title></cp:coreProperties>',
          ),
        }),
      ),
    }
  }

  return {
    relativePath: 'docs/login-flow.xlsx',
    fileType: 'document',
    nodeLabel: 'Login Flow Workbook',
    expectedExcerpt: 'XLSX login flow creates a session token',
    content: Buffer.from(
      zipSync({
        'xl/workbook.xml': strToU8(
          [
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <sheets>',
            '    <sheet name="LoginFlow" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
            '  </sheets>',
            '</workbook>',
          ].join(''),
        ),
        'xl/sharedStrings.xml': strToU8(
          [
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            '  <si><t>XLSX login flow creates a session token</t></si>',
            '</sst>',
          ].join(''),
        ),
      }),
    ),
  }
}

function makeLongGraphBackedExcerpt(kind: 'pdf' | 'docx' | 'xlsx'): string {
  return `${kind.toUpperCase()} login flow creates a session token ${'and preserves long extracted context '.repeat(8)}`.trim()
}

function makeSingleSourceGraph(relativePath: string, nodeLabel: string, fileType: 'paper' | 'document'): KnowledgeGraph {
  const graph = new KnowledgeGraph()
  graph.addNode('graph_backed_source', {
    label: nodeLabel,
    source_file: relativePath,
    source_location: 'L1',
    line_number: 1,
    node_kind: 'document',
    file_type: fileType,
    community: 0,
  })
  return graph
}

function writeProjectFiles(projectRoot: string = PROJECT_FIXTURE_ROOT): void {
  for (const [relativePath, content] of Object.entries(makeProjectFiles())) {
    const absolutePath = join(projectRoot, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, `${content}\n`, 'utf8')
  }
}

function writeGraphFixture(graph: KnowledgeGraph, graphFixtureRoot: string = GRAPH_FIXTURE_ROOT): string {
  mkdirSync(graphFixtureRoot, { recursive: true })
  const graphPath = join(graphFixtureRoot, 'graph.json')
  toJson(graph, { 0: ['auth_user', 'session_manager'], 1: ['session_store'] }, graphPath)
  return graphPath
}

function writeManifestFixture(
  projectRoot: string = PROJECT_FIXTURE_ROOT,
  graphFixtureRoot: string = GRAPH_FIXTURE_ROOT,
  fileOverrides?: Partial<Record<'code' | 'document' | 'paper' | 'image' | 'audio' | 'video', string[]>>,
): string {
  const manifestPath = join(graphFixtureRoot, 'manifest.json')
  const defaultCodePaths = Object.keys(makeProjectFiles())
    .filter((relativePath) => relativePath.endsWith('.ts'))
    .map((relativePath) => join(projectRoot, relativePath))
  saveManifest(
    {
      code: fileOverrides?.code ?? defaultCodePaths,
      document: fileOverrides?.document ?? [],
      paper: fileOverrides?.paper ?? [],
      image: fileOverrides?.image ?? [],
      audio: fileOverrides?.audio ?? [],
      video: fileOverrides?.video ?? [],
    },
    manifestPath,
  )
  return manifestPath
}

function makeClaudeStructuredCompareStdout(options: {
  result: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  assistant_turns?: Array<{
    turn: number
    content: Array<Record<string, unknown>>
  }>
}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: options.result,
    ...(options.usage
      ? {
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            ...options.usage,
          },
        }
      : {}),
    ...(options.assistant_turns
      ? {
          messages: options.assistant_turns.map((turn) => ({
            role: 'assistant',
            turn: turn.turn,
            content: turn.content,
          })),
        }
      : {}),
  })
}

beforeEach(() => {
  rmSync(PROJECT_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(GRAPH_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(COMPARE_OUTPUT_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(PROJECT_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(GRAPH_FIXTURE_ROOT, { recursive: true, force: true })
  rmSync(COMPARE_OUTPUT_ROOT, { recursive: true, force: true })
})

describe('shared prompt runner parsing', () => {
  it('parses Claude structured stdout through the shared prompt-runner module', () => {
    expect(
      parsePromptRunnerOutput(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'baseline answer\n',
          usage: {
            input_tokens: 1200,
            output_tokens: 90,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 20,
          },
        }),
      ),
    ).toEqual({
      answerText: 'baseline answer\n',
      usage: {
        provider: 'claude',
        source: 'structured_stdout',
        input_tokens: 1200,
        output_tokens: 90,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 20,
        input_total_tokens: 1320,
        total_tokens: 1410,
      },
    })
  })

  it('parses Gemini structured stdout through the shared prompt-runner module', () => {
    expect(
      parsePromptRunnerOutput(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'graphify answer' }, { text: '\n' }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 400,
            candidatesTokenCount: 70,
            totalTokenCount: 470,
          },
        }),
      ),
    ).toEqual({
      answerText: 'graphify answer\n',
      usage: {
        provider: 'gemini',
        source: 'structured_stdout',
        input_tokens: 400,
        output_tokens: 70,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_total_tokens: 400,
        total_tokens: 470,
      },
    })
  })

  it('falls back to raw stdout when the shared prompt-runner module cannot parse structured JSON', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      message: 'runner emitted raw JSON without parsed answer metadata',
    })

    expect(parsePromptRunnerOutput(stdout)).toEqual({
      answerText: stdout,
      usage: null,
    })
  })
})

describe('compare runtime', () => {
  it('expands compare exec placeholders safely', () => {
    expect(
      expandCompareExecTemplate('runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}', {
        promptFile: '/tmp/prompt pack.txt',
        question: 'how does login work?',
        mode: 'baseline',
        outputFile: '/tmp/output.txt',
      }),
    ).toBe("runner --prompt '/tmp/prompt pack.txt' --question 'how does login work?' --mode 'baseline' --out '/tmp/output.txt'")
  })

  it('expands compare exec placeholders safely for PowerShell on Windows', () => {
    expect(
      expandCompareExecTemplate(
        'runner --question {question} --prompt {prompt_file}',
        {
          promptFile: 'C:\\Users\\Jane Doe\\prompt.txt',
          question: "how's login work?",
          mode: 'graphify',
          outputFile: 'C:\\Users\\Jane Doe\\answer.txt',
        },
        'win32',
      ),
    ).toBe("runner --question 'how''s login work?' --prompt 'C:\\Users\\Jane Doe\\prompt.txt'")
  })

  it.each([
    'claude -p "$(cat {prompt_file})"',
    'claude -p "$(cat < {prompt_file})"',
    'claude -p "$(sed -n 1p {prompt_file})"',
    'claude -p `cat {prompt_file}`',
  ] as const)('rejects command-substitution exec templates that expand prompt files into argv: %s', async (execTemplate) => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    let runnerCalls = 0

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate,
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async () => {
          runnerCalls += 1
          return {
            exitCode: 0,
            stdout: 'unexpected\n',
            stderr: '',
            elapsedMs: 1,
          }
        },
      },
    )

    const report = result.reports[0]!
    expect(runnerCalls).toBe(0)
    expect(report.status).toEqual({
      baseline: 'failed',
      graphify: 'failed',
    })
    expect(report.stderr.baseline).toContain('Use stdin or file redirection with {prompt_file}')
    expect(report.stderr.graphify).toContain('Use stdin or file redirection with {prompt_file}')
  })

  it('builds a baseline prompt pack from graph and corpus input', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()

    const fullPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'full',
    })
    const boundedPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'bounded',
      maxTokens: 120,
    })

    expect(fullPack.prompt).toContain('Question:\nhow does login create a session')
    expect(fullPack.prompt).toContain('authenticateUser')
    expect(fullPack.prompt).toContain('SessionManager')
    expect(fullPack.prompt.indexOf('Question:\nhow does login create a session')).toBeGreaterThan(
      fullPack.prompt.indexOf('Corpus (full):'),
    )
    expect(fullPack.effective_token_count).toBe(fullPack.token_count)
    expect(fullPack.reused_context_tokens).toBe(0)
    expect(boundedPack.prompt).toContain('[bounded baseline excerpt]')
    expect(boundedPack.prompt.length).toBeLessThan(fullPack.prompt.length)
    expect(estimateQueryTokens(boundedPack.prompt)).toBeLessThanOrEqual(120)
  })

  it('reuses stable compare context across session-aware prompt packs', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()

    const firstPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'full',
    })
    const secondPack = buildBaselinePromptPack({
      question: 'where is session storage defined',
      graph,
      corpusText,
      mode: 'full',
      session: firstPack.session_state,
    })

    expect(secondPack.prompt.indexOf('Question:\nwhere is session storage defined')).toBeGreaterThan(
      secondPack.prompt.indexOf('Corpus (full):'),
    )
    expect(secondPack.reused_context_tokens).toBeGreaterThan(0)
    expect(secondPack.effective_token_count).toBe(Math.max(0, secondPack.token_count - secondPack.reused_context_tokens))
  })

  it('writes delta-oriented follow-up prompt artifacts for multi-question compare runs', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const questionsPath = join(GRAPH_FIXTURE_ROOT, 'session-compare-questions.json')
    writeFileSync(
      questionsPath,
      JSON.stringify(
        [
          { question: 'how does login create a session' },
          { question: 'where is session storage defined' },
        ],
        null,
        2,
      ),
      'utf8',
    )

    const result = generateCompareArtifacts({
      graphPath,
      corpusText,
      questionsPath,
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00.000Z'),
    })

    expect(result.reports).toHaveLength(2)
    expect(readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')).toContain('Corpus (full):')
    expect(readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')).toContain('Retrieved graph context:')
    const followUpReport = result.reports[1]!
    const followUpBaselinePrompt = readFileSync(result.reports[1]!.paths.baseline_prompt, 'utf8')
    const followUpGraphifyPrompt = readFileSync(result.reports[1]!.paths.graphify_prompt, 'utf8')

    expect(followUpBaselinePrompt).toContain('Session delta:')
    expect(followUpBaselinePrompt).toContain('Question:\nwhere is session storage defined')
    expect(followUpBaselinePrompt).not.toContain('Corpus (full):')
    expect(followUpReport.baseline_prompt_tokens_estimated).toBeGreaterThan(estimateQueryTokens(followUpBaselinePrompt))
    expect(followUpReport.baseline_effective_prompt_tokens).toBe(
      Math.max(0, followUpReport.baseline_prompt_tokens_estimated - followUpReport.baseline_reused_context_tokens),
    )
    expect(followUpGraphifyPrompt).toContain('Session delta:')
    expect(followUpGraphifyPrompt).toContain('Question:\nwhere is session storage defined')
    expect(followUpGraphifyPrompt).not.toContain('Retrieved graph context:')
    expect(followUpReport.graphify_prompt_tokens_estimated).toBeGreaterThan(estimateQueryTokens(followUpGraphifyPrompt))
    expect(followUpReport.graphify_effective_prompt_tokens).toBe(
      Math.max(0, followUpReport.graphify_prompt_tokens_estimated - followUpReport.graphify_reused_context_tokens),
    )
  })

  it('builds bounded baseline excerpts for token-dense corpus text', () => {
    const graph = makeGraph()
    const corpusText = '😀'.repeat(500)

    const boundedPack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'bounded',
      maxTokens: 120,
    })

    expect(boundedPack.prompt).toContain('[bounded baseline excerpt]')
    expect(estimateQueryTokens(boundedPack.prompt)).toBeLessThanOrEqual(120)
  })

  it('builds pack_only compare artifacts with a bounded baseline and persisted pack metadata', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}',
      baselineMode: 'pack_only',
      now: new Date('2026-04-24T19:30:00.000Z'),
    })

    const report = result.reports[0]!
    const baselinePrompt = readFileSync(report.paths.baseline_prompt, 'utf8')
    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    const savedPack = savedReport.pack as Record<string, unknown>

    expect(report.baseline_mode).toBe('pack_only')
    expect(baselinePrompt).toContain('[bounded baseline excerpt]')
    expect(report.baseline_prompt_tokens).toBeLessThanOrEqual(report.graphify_prompt_tokens)
    expect(savedReport.baseline_mode).toBe('pack_only')
    expect(savedPack.token_count).toEqual(expect.any(Number))
    expect(savedPack.matched_nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'authenticateUser',
        }),
      ]),
    )
    expect(savedPack.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'calls',
        }),
      ]),
    )
    expect(savedPack.coverage).toEqual(
      expect.objectContaining({
        entries: expect.any(Array),
      }),
    )
    expect(savedPack.selection_diagnostics).toEqual(
      expect.objectContaining({
        selection_strategy: 'value-per-token',
      }),
    )
  })

  it('preserves repo-relative pack_only source_file paths while sanitizing absolute ones in share-safe compare reports', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const outsideSourcePath = resolve(PROJECT_FIXTURE_ROOT, '..', '..', '..', 'vault', 'private', 'auth.ts')
    const originalRetrieveContext = retrieveRuntime.retrieveContext
    const retrieveSpy = vi.spyOn(retrieveRuntime, 'retrieveContext').mockImplementation((inputGraph, options) => ({
      ...originalRetrieveContext(inputGraph, options),
      matched_nodes: originalRetrieveContext(inputGraph, options).matched_nodes.map((node) =>
        node.label === 'authenticateUser' ? { ...node, source_file: outsideSourcePath } : node,
      ),
    }))

    try {
      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        corpusText: makeCorpusText(),
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}',
        baselineMode: 'pack_only',
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      const report = result.reports[0]!
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>
      const savedPack = savedReport.pack as { matched_nodes: Array<{ label: string; source_file: string }> }
      const shareSafePack = shareSafeReport.pack as { matched_nodes: Array<{ label: string; source_file: string }> }

      expect(savedPack.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'authenticateUser',
            source_file: outsideSourcePath,
          }),
          expect.objectContaining({
            label: 'SessionManager',
            source_file: 'src/session.ts',
          }),
        ]),
      )
      expect(shareSafePack.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'authenticateUser',
            source_file: 'auth.ts',
          }),
          expect.objectContaining({
            label: 'SessionManager',
            source_file: 'src/session.ts',
          }),
        ]),
      )
      expect(JSON.stringify(shareSafeReport)).not.toContain(outsideSourcePath)
    } finally {
      retrieveSpy.mockRestore()
    }
  })

  it('sanitizes outside-root relative traversal source_file paths in share-safe compare reports', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const outsideTraversalPath = '../../vault/private/auth.ts'
    const originalRetrieveContext = retrieveRuntime.retrieveContext
    const retrieveSpy = vi.spyOn(retrieveRuntime, 'retrieveContext').mockImplementation((inputGraph, options) => ({
      ...originalRetrieveContext(inputGraph, options),
      matched_nodes: originalRetrieveContext(inputGraph, options).matched_nodes.map((node) =>
        node.label === 'authenticateUser' ? { ...node, source_file: outsideTraversalPath } : node,
      ),
    }))

    try {
      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        corpusText: makeCorpusText(),
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}',
        baselineMode: 'pack_only',
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      const report = result.reports[0]!
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>
      const savedPack = savedReport.pack as { matched_nodes: Array<{ label: string; source_file: string }> }
      const shareSafePack = shareSafeReport.pack as { matched_nodes: Array<{ label: string; source_file: string }> }

      expect(savedPack.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'authenticateUser',
            source_file: outsideTraversalPath,
          }),
        ]),
      )
      expect(shareSafePack.matched_nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'authenticateUser',
            source_file: 'auth.ts',
          }),
        ]),
      )
      expect(JSON.stringify(shareSafeReport)).not.toContain(outsideTraversalPath)
    } finally {
      retrieveSpy.mockRestore()
    }
  })

  it('rejects bounded baseline budgets below the prompt floor', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()

    expect(() =>
      buildBaselinePromptPack({
        question: 'how does login create a session',
        graph,
        corpusText,
        mode: 'bounded',
        maxTokens: 10,
      }),
    ).toThrow(/too small/i)

    expect(() =>
      buildBaselinePromptPack({
        question: 'how does login create a session',
        graph,
        corpusText: '',
        mode: 'bounded',
        maxTokens: 10,
      }),
    ).toThrow(/too small/i)
  })

  it('builds a graphify prompt pack from existing retrieval output', () => {
    const graph = makeGraph()
    const retrieval = retrieveContext(graph, {
      question: 'how does login create a session',
      budget: 3000,
    })

    const pack = buildGraphifyPromptPack({ question: retrieval.question, retrieval })

    expect(pack.prompt).toContain('Retrieved graph context:')
    expect(pack.prompt).toContain('authenticateUser')
    expect(pack.prompt).toContain('SessionManager')
    expect(pack.prompt).toContain('calls')
  })

  it('computes prompt token counts from the exact prompt text', () => {
    const graph = makeGraph()
    const corpusText = makeCorpusText()
    const retrieval = retrieveContext(graph, {
      question: 'how does login create a session',
      budget: 3000,
    })

    const baselinePack = buildBaselinePromptPack({
      question: 'how does login create a session',
      graph,
      corpusText,
      mode: 'full',
    })
    const graphifyPack = buildGraphifyPromptPack({
      question: retrieval.question,
      retrieval,
    })

    expect(baselinePack.token_count).toBe(estimateQueryTokens(baselinePack.prompt))
    expect(graphifyPack.token_count).toBe(estimateQueryTokens(graphifyPack.prompt))
  })

  it('uses local tokenization rather than a fixed chars-per-token ratio for prompt counts', () => {
    expect(estimateQueryTokens('hello world')).toBe(2)
  })

  it('writes prompt artifacts and report from graph-backed files when corpusText is omitted', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const execTemplate = 'OPENAI_API_KEY=super-secret claude -p "$(cat {prompt_file})"'
    const questionsPath = join(GRAPH_FIXTURE_ROOT, 'compare-questions.json')
    writeFileSync(
      questionsPath,
      JSON.stringify([{ question: 'how does login create a session', expected_labels: ['authenticateUser'] }], null, 2),
      'utf8',
    )

    const result = generateCompareArtifacts({
      graphPath,
      questionsPath,
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate,
      baselineMode: 'full',
      limit: 1,
      now: new Date('2026-04-24T19:30:00Z'),
    })

    expect(result.reports).toHaveLength(1)
    const report = result.reports[0]
    expect(report).toBeDefined()
    expect(report?.reduction_ratio).toBe(
      Number(((report!.baseline_prompt_tokens || 0) / (report!.graphify_prompt_tokens || 1)).toFixed(1)),
    )
    expect(report?.paths.output_dir).toBe(resolve('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00'))
    expect(report?.status.baseline).toBe('not_run')
    expect(report?.status.graphify).toBe('not_run')
    expect(existsSync(report!.paths.baseline_prompt)).toBe(true)
    expect(existsSync(report!.paths.graphify_prompt)).toBe(true)
    expect(existsSync(report!.paths.report)).toBe(true)
    expect(report?.paths.share_safe_report).toBe(join(report!.paths.output_dir, 'report.share-safe.json'))
    expect(existsSync(report!.paths.share_safe_report)).toBe(true)

    const baselinePrompt = readFileSync(report!.paths.baseline_prompt, 'utf8')
    const graphifyPrompt = readFileSync(report!.paths.graphify_prompt, 'utf8')
    const savedReport = JSON.parse(readFileSync(report!.paths.report, 'utf8')) as Record<string, unknown>
    const shareSafePath = join(report!.paths.output_dir, 'report.share-safe.json')
    const shareSafeReport = JSON.parse(readFileSync(shareSafePath, 'utf8')) as Record<string, unknown>

    expect(baselinePrompt).toContain('Question:\nhow does login create a session')
    expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
    expect(baselinePrompt).toContain('export class SessionManager')
    expect(graphifyPrompt).toContain('Retrieved graph context:')
    expect(savedReport).toEqual(
      expect.objectContaining({
        question: 'how does login create a session',
        exec_command: {
          command: null,
          placeholders: ['{prompt_file}'],
          redacted: true,
        },
        graph_path: join('graphify-out', 'test-runtime', 'compare-runtime-project', 'graphify-out', 'graph.json'),
        baseline_prompt_tokens: estimateQueryTokens(baselinePrompt),
        graphify_prompt_tokens: estimateQueryTokens(graphifyPrompt),
        reduction_ratio: report!.reduction_ratio,
        baseline_prompt_tokens_estimated: estimateQueryTokens(baselinePrompt),
        graphify_prompt_tokens_estimated: estimateQueryTokens(graphifyPrompt),
        reduction_ratio_estimated: report!.reduction_ratio,
        prompt_token_estimator: {
          source: 'local_tokenizer',
          model: 'cl100k_base',
          exact: false,
        },
        paths: {
          output_dir: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00'),
          baseline_prompt: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'baseline-prompt.txt'),
          graphify_prompt: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'graphify-prompt.txt'),
          report: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'report.json'),
          share_safe_report: join('graphify-out', 'compare', 'test-runtime', '2026-04-24T19-30-00', 'report.share-safe.json'),
        },
      }),
    )
    expect(shareSafeReport).toEqual(
      expect.objectContaining({
        graph_path: '<project-root>/graphify-out/graph.json',
        paths: expect.objectContaining({
          output_dir: '<artifact-root>',
          report: '<artifact-root>/report.json',
          share_safe_report: '<artifact-root>/report.share-safe.json',
        }),
      }),
    )
    expect(JSON.stringify(savedReport)).not.toContain('super-secret')
    expect(JSON.stringify(savedReport)).not.toContain(execTemplate)
    expect(JSON.stringify(shareSafeReport)).not.toContain(report!.paths.output_dir)
  })

  it('runs compare prompts sequentially and saves answer artifacts', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const executions: Array<{
      mode: 'baseline' | 'graphify'
      command: string
      promptFile: string
      outputFile: string
      question: string
    }> = []

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --question {question} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => {
          executions.push(execution)
          return {
            exitCode: 0,
            stdout: `${execution.mode} answer\n`,
            stderr: '',
            elapsedMs: execution.mode === 'baseline' ? 11 : 17,
          }
        },
      },
    )

    const report = result.reports[0]!
    expect(executions).toHaveLength(2)
    expect(executions[0]).toEqual(
      expect.objectContaining({
        mode: 'baseline',
        question: 'how does login create a session',
        promptFile: report.paths.baseline_prompt,
        outputFile: join(report.paths.output_dir, 'baseline-answer.txt'),
      }),
    )
    expect(executions[1]).toEqual(
      expect.objectContaining({
        mode: 'graphify',
        question: 'how does login create a session',
        promptFile: report.paths.graphify_prompt,
        outputFile: join(report.paths.output_dir, 'graphify-answer.txt'),
      }),
    )
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('baseline answer\n')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('graphify answer\n')
    expect(report.status).toEqual({
      baseline: 'succeeded',
      graphify: 'succeeded',
    })
    expect(report.exit_code).toEqual({
      baseline: 0,
      graphify: 0,
    })
    expect(report.stderr).toEqual({
      baseline: null,
      graphify: null,
    })
    expect(report.elapsed_ms).toEqual({
      baseline: 11,
      graphify: 17,
    })

    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    expect(savedReport).toEqual(
      expect.objectContaining({
        status: {
          baseline: 'succeeded',
          graphify: 'succeeded',
        },
        exit_code: {
          baseline: 0,
          graphify: 0,
        },
      }),
    )
  })

  it('persists compact graphify trace metadata in report.json without raw tool payload content', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const privateQuestionPayload = 'PRIVATE_QUESTION_PAYLOAD'
    const privateToolArgument = 'PRIVATE_TOOL_ARGUMENT'

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout:
            execution.mode === 'baseline'
              ? makeClaudeStructuredCompareStdout({
                  result: 'baseline answer\n',
                  usage: {
                    input_tokens: 1200,
                    output_tokens: 90,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 20,
                  },
                })
              : makeClaudeStructuredCompareStdout({
                  result: 'graphify answer\n',
                  usage: {
                    input_tokens: 400,
                    output_tokens: 70,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 10,
                  },
                  assistant_turns: [
                    {
                      turn: 1,
                      content: [
                        { type: 'text', text: 'Let me inspect the graph.' },
                        {
                          type: 'tool_use',
                          name: 'retrieve',
                          input: { question: privateQuestionPayload },
                        },
                        {
                          type: 'tool_use',
                          name: 'mcp__graphify-ts__impact',
                          input: { label: 'SessionManager', note: privateToolArgument },
                        },
                      ],
                    },
                    {
                      turn: 2,
                      content: [
                        {
                          type: 'tool_use',
                          name: 'retrieve',
                          input: { question: `${privateQuestionPayload}_FOLLOW_UP` },
                        },
                      ],
                    },
                  ],
                }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    const graphifyTrace = savedReport.graphify_trace as Record<string, unknown> | undefined
    const graphifyTraceJson = JSON.stringify(graphifyTrace ?? null)

    expect(graphifyTrace).toEqual(
      expect.objectContaining({
        tool_call_count: 3,
        tool_calls_by_name: {
          retrieve: 2,
          'mcp__graphify-ts__impact': 1,
        },
        per_turn: [
          expect.objectContaining({
            turn: 1,
            tool_call_count: 2,
            tools: ['retrieve', 'mcp__graphify-ts__impact'],
          }),
          expect.objectContaining({
            turn: 2,
            tool_call_count: 1,
            tools: ['retrieve'],
          }),
        ],
      }),
    )
    expect(graphifyTraceJson).not.toContain(privateQuestionPayload)
    expect(graphifyTraceJson).not.toContain(privateToolArgument)
  })

  it('sorts graphify_trace per_turn by numeric turn when structured messages arrive out of order', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout:
            execution.mode === 'baseline'
              ? makeClaudeStructuredCompareStdout({
                  result: 'baseline answer\n',
                  usage: {
                    input_tokens: 1200,
                    output_tokens: 90,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 20,
                  },
                })
              : makeClaudeStructuredCompareStdout({
                  result: 'graphify answer\n',
                  usage: {
                    input_tokens: 400,
                    output_tokens: 70,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 10,
                  },
                  assistant_turns: [
                    {
                      turn: 2,
                      content: [{ type: 'tool_use', name: 'retrieve', input: { question: 'follow-up' } }],
                    },
                    {
                      turn: 1,
                      content: [{ type: 'tool_use', name: 'mcp__graphify-ts__impact', input: { label: 'SessionManager' } }],
                    },
                  ],
                }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    const graphifyTrace = savedReport.graphify_trace as Record<string, unknown> | undefined

    expect(graphifyTrace).toEqual(
      expect.objectContaining({
        per_turn: [
          expect.objectContaining({
            turn: 1,
            tool_call_count: 1,
            tools: ['mcp__graphify-ts__impact'],
          }),
          expect.objectContaining({
            turn: 2,
            tool_call_count: 1,
            tools: ['retrieve'],
          }),
        ],
      }),
    )
  })

  it('falls back to sequential turn numbers when structured messages use fractional turns', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout:
            execution.mode === 'baseline'
              ? makeClaudeStructuredCompareStdout({
                  result: 'baseline answer\n',
                  usage: {
                    input_tokens: 1200,
                    output_tokens: 90,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 20,
                  },
                })
              : makeClaudeStructuredCompareStdout({
                  result: 'graphify answer\n',
                  usage: {
                    input_tokens: 400,
                    output_tokens: 70,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 10,
                  },
                  assistant_turns: [
                    {
                      turn: 1,
                      content: [{ type: 'tool_use', name: 'retrieve', input: { question: 'initial lookup' } }],
                    },
                    {
                      turn: 1.9,
                      content: [{ type: 'tool_use', name: 'mcp__graphify-ts__impact', input: { label: 'SessionManager' } }],
                    },
                  ],
                }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    const graphifyTrace = savedReport.graphify_trace as Record<string, unknown> | undefined

    expect(graphifyTrace).toEqual(
      expect.objectContaining({
        per_turn: [
          expect.objectContaining({
            turn: 1,
            tool_call_count: 1,
            tools: ['retrieve'],
          }),
          expect.objectContaining({
            turn: 2,
            tool_call_count: 1,
            tools: ['mcp__graphify-ts__impact'],
          }),
        ],
      }),
    )
  })

  it('preserves compact graphify trace metadata when graphify exits non-zero with structured stdout', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const privateQuestionPayload = 'PRIVATE_FAILED_QUESTION_PAYLOAD'
    const privateToolArgument = 'PRIVATE_FAILED_TOOL_ARGUMENT'

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: execution.mode === 'graphify' ? 23 : 0,
          stdout:
            execution.mode === 'baseline'
              ? makeClaudeStructuredCompareStdout({
                  result: 'baseline answer\n',
                  usage: {
                    input_tokens: 1200,
                    output_tokens: 90,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 20,
                  },
                })
              : makeClaudeStructuredCompareStdout({
                  result: 'graphify partial output\n',
                  usage: {
                    input_tokens: 400,
                    output_tokens: 70,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 10,
                  },
                  assistant_turns: [
                    {
                      turn: 1,
                      content: [
                        {
                          type: 'tool_use',
                          name: 'retrieve',
                          input: { question: privateQuestionPayload },
                        },
                        {
                          type: 'tool_use',
                          name: 'mcp__graphify-ts__impact',
                          input: { label: 'SessionManager', note: privateToolArgument },
                        },
                      ],
                    },
                  ],
                }),
          stderr: execution.mode === 'graphify' ? 'runner exited with a failure\n' : '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    const graphifyTrace = savedReport.graphify_trace as Record<string, unknown> | undefined
    const graphifyTraceJson = JSON.stringify(graphifyTrace ?? null)

    expect(report.status.graphify).toBe('failed')
    expect(report.usage.graphify).toBeNull()
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('graphify partial output\n')
    expect(graphifyTrace).toEqual(
      expect.objectContaining({
        tool_call_count: 2,
        tool_calls_by_name: {
          'mcp__graphify-ts__impact': 1,
          retrieve: 1,
        },
        per_turn: [
          expect.objectContaining({
            turn: 1,
            tool_call_count: 2,
            tools: ['retrieve', 'mcp__graphify-ts__impact'],
          }),
        ],
      }),
    )
    expect(graphifyTraceJson).not.toContain(privateQuestionPayload)
    expect(graphifyTraceJson).not.toContain(privateToolArgument)
  })

  it('keeps graphify_trace absent when compare stdout does not expose trace data', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout: makeClaudeStructuredCompareStdout({
            result: `${execution.mode} answer\n`,
            usage: {
              input_tokens: execution.mode === 'baseline' ? 1200 : 400,
              output_tokens: execution.mode === 'baseline' ? 90 : 70,
              cache_creation_input_tokens: execution.mode === 'baseline' ? 100 : 0,
              cache_read_input_tokens: execution.mode === 'baseline' ? 20 : 10,
            },
          }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>

    expect(savedReport).not.toHaveProperty('graphify_trace')
  })

  it('preserves Claude structured usage parsing through compare execution', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout:
            execution.mode === 'baseline'
              ? JSON.stringify({
                  type: 'result',
                  subtype: 'success',
                  result: `${execution.mode} answer\n`,
                  usage: {
                    input_tokens: 1200,
                    output_tokens: 90,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 20,
                  },
                })
              : makeClaudeStructuredCompareStdout({
                  result: 'graphify answer\n',
                  usage: {
                    input_tokens: 400,
                    output_tokens: 70,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 10,
                  },
                  assistant_turns: [
                    {
                      turn: 1,
                      content: [
                        { type: 'tool_use', name: 'retrieve', input: { question: 'login session flow' } },
                        { type: 'tool_use', name: 'mcp__graphify-ts__impact', input: { label: 'SessionManager' } },
                      ],
                    },
                    {
                      turn: 2,
                      content: [{ type: 'tool_use', name: 'retrieve', input: { question: 'session follow-up' } }],
                    },
                  ],
                }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('baseline answer\n')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('graphify answer\n')
    expect(report.baseline_prompt_tokens).toBe(1320)
    expect(report.graphify_prompt_tokens).toBe(410)
    expect(report.baseline_effective_prompt_tokens).toBe(1300)
    expect(report.graphify_effective_prompt_tokens).toBe(400)
    expect(report.baseline_reused_context_tokens).toBe(20)
    expect(report.graphify_reused_context_tokens).toBe(10)
    expect(report.prompt_token_source).toEqual({
      baseline: 'claude_reported_input',
      graphify: 'claude_reported_input',
    })
    expect(report.provider_proof).toEqual({
      baseline: {
        provider: 'claude',
        input_tokens_source: 'claude_reported_input',
        effective_tokens_source: 'provider_cache_read_tokens',
        total_tokens_source: 'provider_reported_total',
      },
      graphify: {
        provider: 'claude',
        input_tokens_source: 'claude_reported_input',
        effective_tokens_source: 'provider_cache_read_tokens',
        total_tokens_source: 'provider_reported_total',
      },
      reduction_basis: 'provider_reported',
    })
    expect(report.usage).toEqual({
      baseline: {
        provider: 'claude',
        source: 'structured_stdout',
        input_tokens: 1200,
        output_tokens: 90,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 20,
        input_total_tokens: 1320,
        total_tokens: 1410,
      },
      graphify: {
        provider: 'claude',
        source: 'structured_stdout',
        input_tokens: 400,
        output_tokens: 70,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
        input_total_tokens: 410,
        total_tokens: 480,
      },
    })
    expect(report.baseline_total_tokens).toBe(1410)
    expect(report.graphify_total_tokens).toBe(480)
    expect(report.effective_reduction_ratio).toBe(Number((1300 / 400).toFixed(1)))
    expect(formatCompareSummary(result)).toContain('Input tokens (Claude reported): baseline 1320 · graphify 410')
    expect(formatCompareSummary(result)).toContain('Effective input tokens (cache-adjusted): baseline 1300 · graphify 400')
    expect(formatCompareSummary(result)).toContain('Total tokens (Claude reported): baseline 1410 · graphify 480')
    expect(formatCompareSummary(result)).toContain('Provider/runtime proof: Claude reported input, cache, and total tokens for 2/2 prompt runs')
    expect(formatCompareSummary(result)).toContain(
      'Graphify trace: 3 tool calls across 2 turns · top tools: retrieve×2, mcp__graphify-ts__impact×1',
    )
  })

  it('does not write structured stdout JSON into answer artifacts when usage is present without answer text', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'success',
            usage: {
              input_tokens: 1200,
              output_tokens: 90,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 20,
            },
          }),
          stderr: '',
          elapsedMs: 11,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('')
    expect(report.usage.baseline?.total_tokens).toBe(1410)
    expect(report.usage.graphify?.total_tokens).toBe(1410)
  })

  it('preserves plain-text fallback when structured parsing fails', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      message: 'runner emitted raw JSON without parsed answer metadata',
    })

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async () => ({
          exitCode: 0,
          stdout,
          stderr: '',
          elapsedMs: 11,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe(stdout)
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe(stdout)
    expect(report.usage.baseline).toBeNull()
    expect(report.usage.graphify).toBeNull()
    expect(report.prompt_token_source).toEqual({
      baseline: 'estimated_cl100k_base',
      graphify: 'estimated_cl100k_base',
    })
    expect(report.provider_proof).toEqual({
      baseline: {
        provider: null,
        input_tokens_source: 'estimated_cl100k_base',
        effective_tokens_source: 'session_reuse_estimate',
        total_tokens_source: 'not_available',
      },
      graphify: {
        provider: null,
        input_tokens_source: 'estimated_cl100k_base',
        effective_tokens_source: 'session_reuse_estimate',
        total_tokens_source: 'not_available',
      },
      reduction_basis: 'estimated',
    })
  })

  it('preserves Gemini structured usage parsing through compare execution', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: `${execution.mode} answer\n` }],
                },
              },
            ],
            usageMetadata:
              execution.mode === 'baseline'
                ? {
                    promptTokenCount: 1200,
                    candidatesTokenCount: 90,
                    totalTokenCount: 1290,
                  }
                : {
                    promptTokenCount: 400,
                    candidatesTokenCount: 70,
                    totalTokenCount: 470,
                  },
          }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('baseline answer\n')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('graphify answer\n')
    expect(report.baseline_prompt_tokens).toBe(1200)
    expect(report.graphify_prompt_tokens).toBe(400)
    expect(report.prompt_token_source).toEqual({
      baseline: 'gemini_reported_input',
      graphify: 'gemini_reported_input',
    })
    expect(report.provider_proof).toEqual({
      baseline: {
        provider: 'gemini',
        input_tokens_source: 'gemini_reported_input',
        effective_tokens_source: 'provider_input_minus_zero_cache',
        total_tokens_source: 'provider_reported_total',
      },
      graphify: {
        provider: 'gemini',
        input_tokens_source: 'gemini_reported_input',
        effective_tokens_source: 'provider_input_minus_zero_cache',
        total_tokens_source: 'provider_reported_total',
      },
      reduction_basis: 'provider_reported',
    })
    expect(report.usage.baseline).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 1200,
        output_tokens: 90,
        total_tokens: 1290,
      }),
    )
    expect(report.usage.graphify).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 400,
        output_tokens: 70,
        total_tokens: 470,
      }),
    )
    expect(formatCompareSummary(result))
      .toContain('Provider/runtime proof: Gemini reported input and total tokens; no provider cache-read tokens were reported for 2/2 prompt runs')

    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
      usage: {
        baseline: Record<string, unknown> | null
        graphify: Record<string, unknown> | null
      }
    }
    expect(savedReport.usage.baseline).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 1200,
        output_tokens: 90,
        total_tokens: 1290,
      }),
    )
    expect(savedReport.usage.graphify).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 400,
        output_tokens: 70,
        total_tokens: 470,
      }),
    )
    expect(formatCompareSummary(result)).toContain('Input tokens (Gemini reported): baseline 1200 · graphify 400')
    expect(formatCompareSummary(result)).toContain('Total tokens (Gemini reported): baseline 1290 · graphify 470')
    expect(formatCompareSummary(result))
      .toContain('Provider/runtime proof: Gemini reported input and total tokens; no provider cache-read tokens were reported for 2/2 prompt runs')
  })

  it('does not write Gemini structured stdout JSON into answer artifacts when usage metadata is present without answer text', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'text/plain' } }],
                },
              },
            ],
            usageMetadata:
              execution.mode === 'baseline'
                ? {
                    promptTokenCount: 1200,
                    candidatesTokenCount: 90,
                    totalTokenCount: 1290,
                  }
                : {
                    promptTokenCount: 400,
                    candidatesTokenCount: 70,
                    totalTokenCount: 470,
                  },
          }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('')
    expect(report.usage.baseline).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 1200,
        output_tokens: 90,
        total_tokens: 1290,
      }),
    )
    expect(report.usage.graphify).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 400,
        output_tokens: 70,
        total_tokens: 470,
      }),
    )

    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as {
      usage: {
        baseline: Record<string, unknown> | null
        graphify: Record<string, unknown> | null
      }
    }
    expect(savedReport.usage.baseline).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 1200,
        output_tokens: 90,
        total_tokens: 1290,
      }),
    )
    expect(savedReport.usage.graphify).toEqual(
      expect.objectContaining({
        provider: 'gemini',
        input_tokens: 400,
        output_tokens: 70,
        total_tokens: 470,
      }),
    )
  })

  it('saves Gemini answers when structured usage metadata is missing and keeps estimate summaries', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: `${execution.mode} answer\n` }],
                },
              },
            ],
          }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('baseline answer\n')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('graphify answer\n')
    expect(report.usage.baseline).toBeNull()
    expect(report.usage.graphify).toBeNull()
    expect(report.prompt_token_source).toEqual({
      baseline: 'estimated_cl100k_base',
      graphify: 'estimated_cl100k_base',
    })
    expect(formatCompareSummary(result)).toContain('estimate')
  })

  it('concatenates Gemini text parts from the first candidate into answer artifacts', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: `${execution.mode} ` }, { inlineData: { mimeType: 'text/plain' } }, { text: 'answer' }, { text: '\n' }],
                },
              },
              {
                content: {
                  parts: [{ text: 'ignored candidate answer\n' }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 1200,
              candidatesTokenCount: 90,
              totalTokenCount: 1290,
            },
          }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('baseline answer\n')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('graphify answer\n')
  })

  it('preserves malformed Gemini JSON stdout as the answer artifact without capturing usage', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const rawStdout = '{not valid json'

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async () => ({
          exitCode: 0,
          stdout: rawStdout,
          stderr: '',
          elapsedMs: 11,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe(rawStdout)
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe(rawStdout)
    expect(report.usage.baseline).toBeNull()
    expect(report.usage.graphify).toBeNull()
  })

  it('promotes Gemini-reported input and total tokens into compare summaries', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: `${execution.mode} answer\n` }],
                },
              },
            ],
            usageMetadata:
              execution.mode === 'baseline'
                ? {
                    promptTokenCount: 1200,
                    candidatesTokenCount: 90,
                    totalTokenCount: 1290,
                  }
                : {
                    promptTokenCount: 400,
                    candidatesTokenCount: 70,
                    totalTokenCount: 470,
                  },
          }),
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 11 : 17,
        }),
      },
    )

    const report = result.reports[0]!
    expect(report.baseline_prompt_tokens).toBe(1200)
    expect(report.graphify_prompt_tokens).toBe(400)
    expect(report.baseline_total_tokens).toBe(1290)
    expect(report.graphify_total_tokens).toBe(470)
    const summary = formatCompareSummary(result)
    expect(summary).toContain('Input tokens (Gemini reported): baseline 1200 · graphify 400')
    expect(summary).toContain('Total tokens (Gemini reported): baseline 1290 · graphify 470')
  })

  it('reports when graphify uses more Claude-reported tokens than the baseline', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: 0,
          stdout: JSON.stringify({
            type: 'result',
            subtype: 'success',
            result: `${execution.mode} answer\n`,
            usage:
              execution.mode === 'baseline'
                ? {
                    input_tokens: 300,
                    output_tokens: 50,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  }
                : {
                    input_tokens: 500,
                    output_tokens: 80,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
          }),
          stderr: '',
          elapsedMs: 1,
        }),
      },
    )

    expect(formatCompareSummary(result)).toContain('Input tokens (Claude reported): baseline 300 · graphify 500 · 1.7x larger')
    expect(formatCompareSummary(result)).toContain('Total tokens (Claude reported): baseline 350 · graphify 580 · 1.7x larger')
  })

  it('preserves partial compare results when one side fails', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: execution.mode === 'baseline' ? 23 : 0,
          stdout: execution.mode === 'baseline' ? 'baseline partial output\n' : 'graphify answer\n',
          stderr: execution.mode === 'baseline' ? 'runner exited with a failure\n' : '',
          elapsedMs: execution.mode === 'baseline' ? 5 : 9,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('baseline partial output\n')
    expect(readFileSync(report.answer_paths.graphify, 'utf8')).toBe('graphify answer\n')
    expect(report.status).toEqual({
      baseline: 'failed',
      graphify: 'succeeded',
    })
    expect(report.exit_code).toEqual({
      baseline: 23,
      graphify: 0,
    })
    expect(report.stderr).toEqual({
      baseline: expect.stringContaining('stderr omitted for safety'),
      graphify: null,
    })

    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    expect(savedReport).toEqual(
      expect.objectContaining({
        status: {
          baseline: 'failed',
          graphify: 'succeeded',
        },
        exit_code: {
          baseline: 23,
          graphify: 0,
        },
      }),
    )
  })

  it('classifies prompt-too-long runner output as context overflow evidence', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: execution.mode === 'baseline' ? 1 : 0,
          stdout: execution.mode === 'baseline' ? 'Prompt is too long\n' : 'graphify answer\n',
          stderr: '',
          elapsedMs: execution.mode === 'baseline' ? 5 : 9,
        }),
      },
    )

    const report = result.reports[0]!
    expect(readFileSync(report.answer_paths.baseline, 'utf8')).toBe('Prompt is too long\n')
    expect(report.status).toEqual({
      baseline: 'context_overflow',
      graphify: 'succeeded',
    })
    expect(report.failure_reason).toEqual({
      baseline: 'prompt_too_long',
      graphify: null,
    })
    expect(report.evidence.baseline).toBe('Prompt is too long')

    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    expect(savedReport).toEqual(
      expect.objectContaining({
        status: {
          baseline: 'context_overflow',
          graphify: 'succeeded',
        },
        failure_reason: {
          baseline: 'prompt_too_long',
          graphify: null,
        },
        evidence: {
          baseline: 'Prompt is too long',
          graphify: null,
        },
      }),
    )
    expect(formatCompareSummary(result)).toContain('1 context overflow')
  })

  it('does not treat context overflow evidence as a generic compare failure', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    await expect(
      runCompareCommand(
        {
          graphPath,
          question: 'how does login create a session',
          outputDir: COMPARE_OUTPUT_ROOT,
          execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
          baselineMode: 'full',
          now: new Date('2026-04-24T19:30:00.000Z'),
        },
        {
          runner: async (execution) => ({
            exitCode: execution.mode === 'baseline' ? 1 : 0,
            stdout: execution.mode === 'baseline' ? 'Prompt is too long\n' : 'graphify answer\n',
            stderr: '',
            elapsedMs: 1,
          }),
        },
      ),
    ).resolves.toContain('context overflow')
  })

  it('does not fail native_agent compare when the runner returns plain-text answers without provider usage metadata', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const outputTimestamp = '2026-04-24T19-30-00'

    await expect(
      runCompareCommand(
        {
          graphPath,
          question: 'how does login create a session',
          outputDir: COMPARE_OUTPUT_ROOT,
          execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
          baselineMode: 'native_agent',
          now: new Date('2026-04-24T19:30:00.000Z'),
        },
        {
          now: () => new Date('2026-04-24T19:30:00.000Z'),
          runner: async (execution) => ({
            exitCode: 0,
            stdout: execution.mode === 'baseline' ? 'baseline answer\n' : 'graphify answer\n',
            stderr: '',
            elapsedMs: 5,
          }),
        },
      ),
    ).resolves.toContain('no Anthropic usage block')

    const report = JSON.parse(readFileSync(join(COMPARE_OUTPUT_ROOT, outputTimestamp, 'report.json'), 'utf8')) as Record<string, unknown>
    const shareSafeReport = JSON.parse(readFileSync(join(COMPARE_OUTPUT_ROOT, outputTimestamp, 'report.share-safe.json'), 'utf8')) as Record<string, unknown>
    expect(report).toEqual(
      expect.objectContaining({
        baseline: expect.objectContaining({
          kind: 'answer_only',
          exit_code: 0,
        }),
        graphify: expect.objectContaining({
          kind: 'answer_only',
          exit_code: 0,
        }),
        reductions: null,
      }),
    )
    expect(shareSafeReport).toEqual(
      expect.objectContaining({
        graph_path: '<project-root>/graphify-out/graph.json',
        paths: expect.objectContaining({
          output_dir: '<artifact-root>',
          report: '<artifact-root>/report.json',
          share_safe_report: '<artifact-root>/report.share-safe.json',
          baseline_answer: '<artifact-root>/baseline-answer.txt',
          graphify_answer: '<artifact-root>/graphify-answer.txt',
          prompt_file: '<artifact-root>/native_agent-prompt.txt',
        }),
        baseline: expect.objectContaining({
          kind: 'answer_only',
          result_path: '<artifact-root>/baseline-answer.txt',
        }),
        graphify: expect.objectContaining({
          kind: 'answer_only',
          result_path: '<artifact-root>/graphify-answer.txt',
        }),
      }),
    )
    expect(JSON.stringify(shareSafeReport)).not.toContain(PROJECT_FIXTURE_ROOT)
    expect(readFileSync(join(COMPARE_OUTPUT_ROOT, outputTimestamp, 'baseline-answer.txt'), 'utf8')).toBe('baseline answer\n')
    expect(readFileSync(join(COMPARE_OUTPUT_ROOT, outputTimestamp, 'graphify-answer.txt'), 'utf8')).toBe('graphify answer\n')
  })

  it('marks invalid compare placeholders as failed runs in persisted reports', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    let runnerCalls = 0

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --out {output}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async () => {
          runnerCalls += 1
          return {
            exitCode: 0,
            stdout: 'unexpected\n',
            stderr: '',
            elapsedMs: 1,
          }
        },
      },
    )

    const report = result.reports[0]!
    expect(runnerCalls).toBe(0)
    expect(report.status).toEqual({
      baseline: 'failed',
      graphify: 'failed',
    })
    expect(report.stderr.baseline).toContain('Unknown compare exec placeholder')
    expect(report.stderr.graphify).toContain('Unknown compare exec placeholder')

    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    expect(savedReport).toEqual(
      expect.objectContaining({
        status: {
          baseline: 'failed',
          graphify: 'failed',
        },
      }),
    )
    expect(savedReport).not.toHaveProperty('graphify_trace')
  })

  it('redacts persisted compare stderr summaries', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => ({
          exitCode: execution.mode === 'baseline' ? 1 : 0,
          stdout: execution.mode === 'baseline' ? '' : 'graphify answer\n',
          stderr:
            execution.mode === 'baseline'
              ? 'OPENAI_API_KEY=super-secret\nAuthorization: Bearer abc123\nStack trace follows\n'
              : '',
          elapsedMs: 3,
        }),
      },
    )

    const report = result.reports[0]!
    expect(report.stderr.baseline).toContain('stderr omitted for safety')
    expect(report.stderr.baseline).not.toContain('super-secret')
    expect(report.stderr.baseline).not.toContain('abc123')

    const savedReport = JSON.stringify(JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>)
    expect(savedReport).toContain('stderr omitted for safety')
    expect(savedReport).not.toContain('super-secret')
    expect(savedReport).not.toContain('abc123')
  })

  it('sanitizes share-safe compare stderr and evidence paths without changing the local report', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const secretPath = join(PROJECT_FIXTURE_ROOT, 'Quarterly Reports', 'review notes.txt')
    mkdirSync(dirname(secretPath), { recursive: true })
    writeFileSync(secretPath, 'export const secret = true\n', 'utf8')
    const graphPath = writeGraphFixture(graph)
    const outputTimestamp = '2026-04-24T19-30-00'
    const questionOutputDir = join(COMPARE_OUTPUT_ROOT, outputTimestamp)
    const overflowPath = relative(questionOutputDir, secretPath)
    const expectedShareSafeSecretPath = '<project-root>/Quarterly Reports/review notes.txt'

    const result = await executeCompareRuns(
      {
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      },
      {
        runner: async (execution) => {
          if (execution.mode === 'baseline') {
            return {
              exitCode: 1,
              stdout: `Prompt is too long while loading ${overflowPath} for details\n`,
              stderr: '',
              elapsedMs: 3,
            }
          }

          throw new Error(`Runner crashed while reading ${overflowPath} for details`)
        },
      },
    )

    const report = result.reports[0]!
    const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
    const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as Record<string, unknown>
    const savedReportEvidence = (savedReport.evidence as Record<string, string | null>).baseline
    const savedReportStderr = (savedReport.stderr as Record<string, string | null>).graphify
    const shareSafeEvidence = (shareSafeReport.evidence as Record<string, string | null>).baseline
    const shareSafeStderr = (shareSafeReport.stderr as Record<string, string | null>).graphify

    expect(report.evidence.baseline).toContain(`${overflowPath} for details`)
    expect(report.stderr.graphify).toContain(`${overflowPath} for details`)
    expect(savedReportEvidence).toContain(`${overflowPath} for details`)
    expect(savedReportStderr).toContain(`${overflowPath} for details`)

    expect(shareSafeEvidence).not.toContain(overflowPath)
    expect(shareSafeStderr).not.toContain(overflowPath)
    expect(shareSafeEvidence).not.toMatch(/\.\.[\\/A-Za-z0-9_-]/)
    expect(shareSafeStderr).not.toMatch(/\.\.[\\/A-Za-z0-9_-]/)
    expect(shareSafeEvidence).toContain(`${expectedShareSafeSecretPath} for details`)
    expect(shareSafeStderr).toContain(`${expectedShareSafeSecretPath} for details`)
    expect(shareSafeEvidence).toContain('for details')
    expect(shareSafeStderr).toContain('for details')
    expect(shareSafeReport).toEqual(
      expect.objectContaining({
        evidence: expect.objectContaining({
          baseline: expect.stringContaining(`${expectedShareSafeSecretPath} for details`),
        }),
        stderr: expect.objectContaining({
          graphify: expect.stringContaining(`${expectedShareSafeSecretPath} for details`),
        }),
      }),
    )
  })

  it('continues redacting later absolute paths after spaced share-safe placeholders', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')
    const secretPath = join(PROJECT_FIXTURE_ROOT, 'Quarterly Reports', 'review notes.txt')

    mkdirSync(dirname(secretPath), { recursive: true })
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(secretPath, 'export const secret = true\n', 'utf8')

    expect(
      sanitizeShareSafeText(
        '<project-root>/Quarterly Reports/review notes.txt and /etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt and passwd')
  })

  it('preserves spaced share-safe placeholders even when the referenced file does not exist', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')

    mkdirSync(artifactRoot, { recursive: true })

    expect(
      sanitizeShareSafeText(
        '<project-root>/Quarterly Reports/missing notes.txt and /etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/missing notes.txt and passwd')
    expect(
      sanitizeShareSafeText(
        '<project-root>/Quarterly Reports/missing notes.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/missing notes.txt')
  })

  it('does not let dotted prose inside a spaced placeholder hide later absolute paths', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')

    mkdirSync(artifactRoot, { recursive: true })

    expect(
      sanitizeShareSafeText(
        '<project-root>/foo v1.2 beta.3 /etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/foo v1.2 beta.3 passwd')
  })

  it('preserves non-existent spaced placeholder directories without hiding later absolute paths', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')

    mkdirSync(artifactRoot, { recursive: true })

    expect(
      sanitizeShareSafeText(
        '<project-root>/dir with space/subdir and /etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/dir with space/subdir and passwd')
    expect(
      sanitizeShareSafeText(
        '<project-root>/dir with space/subdir',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/dir with space/subdir')
  })

  it('keeps redacting punctuation-attached absolute paths after spaced placeholders', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')
    const secretPath = join(PROJECT_FIXTURE_ROOT, 'Quarterly Reports', 'review notes.txt')

    mkdirSync(dirname(secretPath), { recursive: true })
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(secretPath, 'export const secret = true\n', 'utf8')

    const traversalPath = relative(artifactRoot, secretPath)
    expect(
      sanitizeShareSafeText(
        '<project-root>/dir with space,/etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/dir with space,passwd')
    expect(
      sanitizeShareSafeText(
        `${traversalPath},/etc/passwd`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt,passwd')
  })

  it('keeps redacting punctuation-attached Windows absolute paths after protected prefixes', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')
    const secretPath = join(PROJECT_FIXTURE_ROOT, 'Quarterly Reports', 'review notes.txt')
    const uncWindowsPath = String.raw`\\server\share\secret.txt`

    mkdirSync(dirname(secretPath), { recursive: true })
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(secretPath, 'export const secret = true\n', 'utf8')

    const traversalPath = relative(artifactRoot, secretPath)
    const windowsSlashPath = 'C:/Windows/system32/drivers/etc/hosts'
    const windowsBackslashPath = 'C:\\Windows\\system32\\drivers\\etc\\hosts'
    const spacedWindowsPath = 'C:/Users/Alice/My Secrets/secret.txt'

    expect(
      sanitizeShareSafeText(
        `<project-root>/Quarterly Reports/review notes.txt,${windowsSlashPath}`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt,hosts')
    expect(
      sanitizeShareSafeText(
        `<project-root>/Quarterly Reports/review notes.txt,${windowsBackslashPath}`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt,hosts')
    expect(
      sanitizeShareSafeText(
        `${traversalPath},${windowsSlashPath}`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt,hosts')
    expect(
      sanitizeShareSafeText(
        `<project-root>/Quarterly Reports,${spacedWindowsPath}`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports,secret.txt')
    expect(
      sanitizeShareSafeText(
        `<project-root>/Quarterly Reports/review notes.txt,${uncWindowsPath}`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt,secret.txt')
    expect(
      sanitizeShareSafeText(
        `before ${uncWindowsPath} after`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('before secret.txt after')
    expect(
      sanitizeShareSafeText(
        'x,C:/Windows/notepad.exe,C:/Windows/system.ini',
        { artifactRoot, projectRoot },
      ),
    ).toBe('x,notepad.exe,system.ini')
  })

  it('keeps redacting separator-restarted absolute paths after protected prefixes', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')

    mkdirSync(artifactRoot, { recursive: true })

    expect(
      sanitizeShareSafeText(
        '<project-root>/foo//etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/foo/passwd')
    expect(
      sanitizeShareSafeText(
        '<project-root>/foo/C:/Users/alice/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/foo/secret.txt')
    expect(
      sanitizeShareSafeText(
        '<project-root>/dir with space/subdir:/Users/alice/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/dir with space/subdir:secret.txt')
    expect(
      sanitizeShareSafeText(
        '<project-root>/missing notes:/etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/missing notes:passwd')
  })

  it('preserves punctuation-delimited prose after sanitizing traversal paths with spaces', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')
    const secretPath = join(PROJECT_FIXTURE_ROOT, 'Quarterly Reports', 'review notes.txt')

    mkdirSync(dirname(secretPath), { recursive: true })
    mkdirSync(artifactRoot, { recursive: true })
    writeFileSync(secretPath, 'export const secret = true\n', 'utf8')

    const traversalPath = relative(artifactRoot, secretPath)
    expect(
      sanitizeShareSafeText(
        `${traversalPath}: details`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt: details')
    expect(
      sanitizeShareSafeText(
        `${traversalPath}:${traversalPath}`,
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt:<project-root>/Quarterly Reports/review notes.txt')
  })

  it('preserves protocol-relative URLs while still sanitizing double-slash paths', () => {
    const projectRoot = PROJECT_FIXTURE_ROOT
    const artifactRoot = join(COMPARE_OUTPUT_ROOT, 'placeholder-run')

    mkdirSync(artifactRoot, { recursive: true })

    expect(
      sanitizeShareSafeText(
        '//example.com/foo',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//example.com/foo')
    expect(
      sanitizeShareSafeText(
        'See //example.com/foo for docs',
        { artifactRoot, projectRoot },
      ),
    ).toBe('See //example.com/foo for docs')
    expect(
      sanitizeShareSafeText(
        '//example.com/api/v1/users',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//example.com/api/v1/users')
    expect(
      sanitizeShareSafeText(
        '//api.example.com/v1/users',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//api.example.com/v1/users')
    expect(
      sanitizeShareSafeText(
        '//eng.example.com/api/v1/users',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//eng.example.com/api/v1/users')
    expect(
      sanitizeShareSafeText(
        '//example.com/API/v1/users',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//example.com/API/v1/users')
    expect(
      sanitizeShareSafeText(
        'See //example.com/blog/2026/launch for details',
        { artifactRoot, projectRoot },
      ),
    ).toBe('See //example.com/blog/2026/launch for details')
    expect(
      sanitizeShareSafeText(
        '//example.com/docs/getting-started',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//example.com/docs/getting-started')
    expect(
      sanitizeShareSafeText(
        '//github.com/openai/gpt-5',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//github.com/openai/gpt-5')
    expect(
      sanitizeShareSafeText(
        'See //example.com/foo/bar for docs',
        { artifactRoot, projectRoot },
      ),
    ).toBe('See //example.com/foo/bar for docs')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://example.com/docs/getting-started',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe://example.com/docs/getting-started')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://api.example.com/v1/users',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe://api.example.com/v1/users')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://eng.example.com/api/v1/users',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe://eng.example.com/api/v1/users')
    expect(
      sanitizeShareSafeText(
        '<project-root>/src/auth.ts://github.com/openai/gpt-5',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/src/auth.ts://github.com/openai/gpt-5')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://example.com/foo/bar',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe://example.com/foo/bar')
    expect(
      sanitizeShareSafeText(
        '//cdn.example.com/assets/app.js',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//cdn.example.com/assets/app.js')
    expect(
      sanitizeShareSafeText(
        '//img.example.com/a/b',
        { artifactRoot, projectRoot },
      ),
    ).toBe('//img.example.com/a/b')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://cdn.example.com/assets/app.js',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe://cdn.example.com/assets/app.js')
    expect(
      sanitizeShareSafeText(
        '<project-root>/Quarterly Reports/review notes.txt://example.com/foo',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/Quarterly Reports/review notes.txt://example.com/foo')
    expect(
      sanitizeShareSafeText(
        'foo.bar://example.com/a/b',
        { artifactRoot, projectRoot },
      ),
    ).toBe('foo.bar://example.com/a/b')
    expect(
      sanitizeShareSafeText(
        '//server/share/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret.txt')
    expect(
      sanitizeShareSafeText(
        '//server.example.com/share/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret.txt')
    expect(
      sanitizeShareSafeText(
        '//server.example.com/share/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret')
    expect(
      sanitizeShareSafeText(
        '//server.example.com/Engineering/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret.txt')
    expect(
      sanitizeShareSafeText(
        '//printer01.example.com/Engineering/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret')
    expect(
      sanitizeShareSafeText(
        '//server.example.com/engineering/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret')
    expect(
      sanitizeShareSafeText(
        '//corp.example.com/alice/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret')
    expect(
      sanitizeShareSafeText(
        '//eng.example.com/alice/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('secret')
    expect(
      sanitizeShareSafeText(
        '//server.example.com/Engineering',
        { artifactRoot, projectRoot },
      ),
    ).toBe('Engineering')
    expect(
      sanitizeShareSafeText(
        '<project-root>/foo//server.example.com/share/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/foo/secret.txt')
    expect(
      sanitizeShareSafeText(
        '<project-root>/foo//server.example.com/share/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/foo/secret')
    expect(
      sanitizeShareSafeText(
        '<project-root>/foo//server.example.com/Engineering/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/foo/secret.txt')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://corp.example.com/alice/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe:<external-path>secret')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://eng.example.com/alice/secret',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe:<external-path>secret')
    expect(
      sanitizeShareSafeText(
        'See //server.example.com/Engineering for access',
        { artifactRoot, projectRoot },
      ),
    ).toBe('See Engineering for access')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe:<external-path>passwd')
    expect(
      sanitizeShareSafeText(
        '<project-root>/safe://C:/Users/alice/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('<project-root>/safe:<external-path>secret.txt')
    expect(
      sanitizeShareSafeText(
        'see file:///etc/passwd and file:///C:/Users/alice/Documents/secret.txt',
        { artifactRoot, projectRoot },
      ),
    ).toBe('see file://passwd and file://secret.txt')
    expect(
      sanitizeShareSafeText(
        'See.file:///etc/passwd',
        { artifactRoot, projectRoot },
      ),
    ).toBe('See.file://passwd')
  })

  it('sanitizes escaped artifact-root answer path traversals without reclassifying them under the project root', async () => {
    const graph = makeGraph()
    writeProjectFiles()
    const secretPath = join(PROJECT_FIXTURE_ROOT, 'src', 'secret.ts')
    writeFileSync(secretPath, 'export const secret = true\n', 'utf8')
    const graphPath = writeGraphFixture(graph)
    const outputTimestamp = '2026-04-24T19-30-00'
    const questionOutputDir = join(COMPARE_OUTPUT_ROOT, outputTimestamp)
    const escapedAnswerPath = relative(questionOutputDir, secretPath)
    const originalCwd = process.cwd()

    vi.resetModules()
    vi.doMock('node:path', async () => {
      const actual = await vi.importActual<typeof import('node:path')>('node:path')
      return {
        ...actual,
        join: (...args: string[]) => {
          if (args[0] === questionOutputDir && args[1] === 'baseline-answer.txt') {
            return escapedAnswerPath
          }
          return actual.join(...args)
        },
      }
    })

    try {
      const { executeCompareRuns: executeCompareRunsWithForgedAnswerPath } = await import('../../src/infrastructure/compare.js')
      const result = await executeCompareRunsWithForgedAnswerPath(
        {
          graphPath,
          question: 'how does login create a session',
          outputDir: COMPARE_OUTPUT_ROOT,
          execTemplate: 'runner --prompt {prompt_file} --mode {mode} --out {output_file}',
          baselineMode: 'full',
          now: new Date('2026-04-24T19:30:00.000Z'),
        },
        {
          runner: async (execution) => {
            process.chdir(questionOutputDir)
            return {
              exitCode: 0,
              stdout: `${execution.mode} answer\n`,
              stderr: '',
              elapsedMs: 3,
            }
          },
        },
      )

      const report = result.reports[0]!
      const savedReport = JSON.parse(readFileSync(report.paths.report, 'utf8')) as Record<string, unknown>
      const shareSafeReport = JSON.parse(readFileSync(report.paths.share_safe_report, 'utf8')) as {
        answer_paths: {
          baseline: string
          graphify: string
        }
      }

      expect(report.answer_paths.baseline).toBe(escapedAnswerPath)
      expect((savedReport.answer_paths as { baseline: string }).baseline).toBe(escapedAnswerPath)
      expect(shareSafeReport.answer_paths.baseline).toBe('secret.ts')
      expect(shareSafeReport.answer_paths.baseline).not.toBe('<project-root>/src/secret.ts')
      expect(JSON.stringify(shareSafeReport)).not.toContain('<project-root>/src/secret.ts')
    } finally {
      process.chdir(originalCwd)
      vi.doUnmock('node:path')
      vi.resetModules()
    }
  })

  it('loads graphify snippets when compare runs from outside the inferred project root', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const originalCwd = process.cwd()
    const alternateCwd = resolve('graphify-out', 'test-runtime', 'outside-compare-runner')
    mkdirSync(alternateCwd, { recursive: true })

    try {
      process.chdir(alternateCwd)
      const alternateOutputRoot = join(alternateCwd, 'graphify-out', 'compare', 'alternate-cwd')

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: alternateOutputRoot,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      expect(process.cwd()).toBe(alternateCwd)
      const graphifyPrompt = readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')
      expect(graphifyPrompt).toContain('createSession(userId) {')
      expect(graphifyPrompt).toContain('return new SessionStore().write(userId)')
    } finally {
      process.chdir(originalCwd)
      rmSync(alternateCwd, { recursive: true, force: true })
    }
  })

  it('keeps compare-local snippet restoration within the retrieval budget', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      retrievalBudget: 25,
      now: new Date('2026-04-24T19:30:00.000Z'),
    })

    const graphifyPrompt = readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')
    expect(graphifyPrompt).toContain('SessionManager')
    expect(graphifyPrompt).toContain('export class SessionManager')
    expect(graphifyPrompt).not.toContain('export class SessionStore')
  })

  it('does not load graphify snippets from paths outside the inferred project root', () => {
    const graph = makeGraph()
    graph.addNode('secret_leak', {
      label: 'SecretLeak',
      source_file: '../../../outside-secret.txt',
      source_location: 'L1',
      line_number: 1,
      node_kind: 'file',
      file_type: 'code',
      community: 0,
    })
    writeProjectFiles()
    const outsideSecretPath = resolve(PROJECT_FIXTURE_ROOT, '..', '..', '..', 'outside-secret.txt')
    writeFileSync(outsideSecretPath, 'TOP SECRET compare snippet\n', 'utf8')
    const graphPath = writeGraphFixture(graph)

    try {
      const result = generateCompareArtifacts({
        graphPath,
        question: 'where is the secret leak',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      const graphifyPrompt = readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')
      expect(graphifyPrompt).toContain('SecretLeak')
      expect(graphifyPrompt).not.toContain('TOP SECRET compare snippet')
    } finally {
      rmSync(outsideSecretPath, { force: true })
    }
  })

  it('keeps source-path retrieval matches for outside-root nodes while suppressing snippets', () => {
    const graph = makeGraph()
    graph.addNode('outside_archive', {
      label: 'ArchiveNode',
      source_file: '../../../vault/private/notes.txt',
      source_location: 'L1',
      line_number: 1,
      node_kind: 'file',
      file_type: 'code',
      community: 0,
    })
    writeProjectFiles()
    const outsideNotesPath = resolve(PROJECT_FIXTURE_ROOT, '..', '..', '..', 'vault', 'private', 'notes.txt')
    mkdirSync(dirname(outsideNotesPath), { recursive: true })
    writeFileSync(outsideNotesPath, 'PRIVATE snippet should never appear\n', 'utf8')
    const graphPath = writeGraphFixture(graph)

    try {
      const result = generateCompareArtifacts({
        graphPath,
        question: 'where is private documented',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      const graphifyPrompt = readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')
      expect(graphifyPrompt).toContain('ArchiveNode')
      expect(graphifyPrompt).not.toContain('PRIVATE snippet should never appear')
    } finally {
      rmSync(resolve(PROJECT_FIXTURE_ROOT, '..', '..', '..', 'vault'), { recursive: true, force: true })
    }
  })

  it('restores the original outside-root source path when surrogate tokens collide', () => {
    const graph = makeGraph()
    graph.addNode('outside_dash', {
      label: 'ArchiveDash',
      source_file: '../../../vault/private-notes.txt',
      source_location: 'L1',
      line_number: 1,
      node_kind: 'file',
      file_type: 'code',
      community: 0,
    })
    graph.addNode('outside_nested', {
      label: 'ArchiveNested',
      source_file: '../../../vault/private/notes.txt',
      source_location: 'L1',
      line_number: 1,
      node_kind: 'file',
      file_type: 'code',
      community: 0,
    })
    writeProjectFiles()
    const outsideVaultRoot = resolve(PROJECT_FIXTURE_ROOT, '..', '..', '..', 'vault')
    mkdirSync(dirname(join(outsideVaultRoot, 'private-notes.txt')), { recursive: true })
    mkdirSync(join(outsideVaultRoot, 'private'), { recursive: true })
    writeFileSync(join(outsideVaultRoot, 'private-notes.txt'), 'outside dash snippet\n', 'utf8')
    writeFileSync(join(outsideVaultRoot, 'private', 'notes.txt'), 'outside nested snippet\n', 'utf8')
    const graphPath = writeGraphFixture(graph)

    try {
      const result = generateCompareArtifacts({
        graphPath,
        question: 'where are the private notes',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        retrievalBudget: 80,
        now: new Date('2026-04-24T19:30:00.000Z'),
      })

      const graphifyPrompt = readFileSync(result.reports[0]!.paths.graphify_prompt, 'utf8')
      expect(graphifyPrompt).toContain('ArchiveDash @ ../../../vault/private-notes.txt:1')
      expect(graphifyPrompt).toContain('ArchiveNested @ ../../../vault/private/notes.txt:1')
      expect(graphifyPrompt).not.toContain('outside dash snippet')
      expect(graphifyPrompt).not.toContain('outside nested snippet')
    } finally {
      rmSync(outsideVaultRoot, { recursive: true, force: true })
    }
  })

  it('creates a collision-safe compare output directory for repeated runs at the same timestamp', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const input = {
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full' as const,
      now: new Date('2026-04-24T19:30:00.000Z'),
    }

    const firstResult = generateCompareArtifacts(input)
    const secondResult = generateCompareArtifacts(input)

    expect(firstResult.output_root).not.toBe(secondResult.output_root)
    expect(firstResult.reports[0]?.paths.output_dir).not.toBe(secondResult.reports[0]?.paths.output_dir)
    expect(existsSync(firstResult.reports[0]!.paths.baseline_prompt)).toBe(true)
    expect(existsSync(secondResult.reports[0]!.paths.baseline_prompt)).toBe(true)
  })

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'writes prompt artifacts from graph-backed %s sources when corpusText is omitted',
    (kind) => {
      const fixture = makeGraphBackedNonCodeFixture(kind)
      const graph = makeSingleSourceGraph(fixture.relativePath, fixture.nodeLabel, fixture.fileType)
      const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)

      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, fixture.content)

      const graphPath = writeGraphFixture(graph)

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      })

      const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
      expect(baselinePrompt).toContain(fixture.expectedExcerpt)
      expect(existsSync(result.reports[0]!.paths.graphify_prompt)).toBe(true)
      expect(existsSync(result.reports[0]!.paths.report)).toBe(true)
    },
  )

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'fails explicitly when graph-backed %s baseline extraction cannot produce text',
    (kind) => {
      const fixture = makeGraphBackedNonCodeFixture(kind)
      const graph = makeGraph()
      graph.addNode(`broken_${kind}_source`, {
        label: fixture.nodeLabel,
        source_file: fixture.relativePath,
        source_location: 'L1',
        line_number: 1,
        node_kind: 'document',
        file_type: fixture.fileType,
        community: 0,
      })

      writeProjectFiles()

      const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(
        absolutePath,
        kind === 'pdf'
          ? [
              '%PDF-1.4',
              '1 0 obj',
              '<< /Producer (graphify-ts) >>',
              'endobj',
            ].join('\n')
          : Buffer.from('not-a-zip-archive'),
      )

      const graphPath = writeGraphFixture(graph)

      expect(() =>
        generateCompareArtifacts({
          graphPath,
          question: 'how does login create a session',
          outputDir: COMPARE_OUTPUT_ROOT,
          execTemplate: 'claude -p "$(cat {prompt_file})"',
          baselineMode: 'full',
          now: new Date('2026-04-24T19:30:00.000Z'),
        }),
      ).toThrow(/could not extract text|failed to extract/i)
    },
  )

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'preserves long extracted lines from graph-backed %s sources when corpusText is omitted',
    (kind) => {
      const fixture = makeGraphBackedNonCodeFixture(kind)
      const longExcerpt = makeLongGraphBackedExcerpt(kind)
      const graph = makeSingleSourceGraph(fixture.relativePath, fixture.nodeLabel, fixture.fileType)
      const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)

      mkdirSync(dirname(absolutePath), { recursive: true })
      if (kind === 'pdf') {
        writeFileSync(
          absolutePath,
          [
            '%PDF-1.4',
            '1 0 obj',
            '<< /Title (Login Flow PDF) /Author (graphify-ts) /Subject (Authentication) >>',
            'endobj',
            'BT',
            `(${longExcerpt}) Tj`,
            'ET',
          ].join('\n'),
        )
      } else if (kind === 'docx') {
        writeFileSync(
          absolutePath,
          Buffer.from(
            zipSync({
              'word/document.xml': strToU8(
                [
                  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
                  '  <w:body>',
                  `    <w:p><w:r><w:t>${longExcerpt}</w:t></w:r></w:p>`,
                  '  </w:body>',
                  '</w:document>',
                ].join(''),
              ),
            }),
          ),
        )
      } else {
        writeFileSync(
          absolutePath,
          Buffer.from(
            zipSync({
              'xl/workbook.xml': strToU8(
                [
                  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
                  '  <sheets>',
                  '    <sheet name="LoginFlow" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
                  '  </sheets>',
                  '</workbook>',
                ].join(''),
              ),
              'xl/sharedStrings.xml': strToU8(
                [
                  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
                  `  <si><t>${longExcerpt}</t></si>`,
                  '</sst>',
                ].join(''),
              ),
            }),
          ),
        )
      }

      const graphPath = writeGraphFixture(graph)

      const result = generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      })

      const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
      expect(longExcerpt.length).toBeGreaterThan(256)
      expect(baselinePrompt).toContain(longExcerpt)
    },
  )

  it('preserves long XLSX core metadata lines when corpusText is omitted', () => {
    const longTitle = `Workbook title ${'preserves long extracted core metadata '.repeat(8)}`.trim()
    const fixture = makeGraphBackedNonCodeFixture('xlsx')
    const graph = makeSingleSourceGraph(fixture.relativePath, fixture.nodeLabel, fixture.fileType)
    const absolutePath = join(PROJECT_FIXTURE_ROOT, fixture.relativePath)

    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(
      absolutePath,
      Buffer.from(
        zipSync({
          'docProps/core.xml': strToU8(
            `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${longTitle}</dc:title></cp:coreProperties>`,
          ),
          'xl/workbook.xml': strToU8(
            [
              '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
              '  <sheets>',
              '    <sheet name="LoginFlow" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>',
              '  </sheets>',
              '</workbook>',
            ].join(''),
          ),
          'xl/sharedStrings.xml': strToU8(
            [
              '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
              '  <si><t>XLSX login flow creates a session token</t></si>',
              '</sst>',
            ].join(''),
          ),
        }),
      ),
    )

    const graphPath = writeGraphFixture(graph)
    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(longTitle.length).toBeGreaterThan(256)
    expect(baselinePrompt).toContain(longTitle)
  })

  it('includes manifest-only files when deriving the runtime baseline corpus', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const manifestOnlyDocFilePath = join(PROJECT_FIXTURE_ROOT, 'docs', 'manifest-only.md')
    mkdirSync(dirname(manifestOnlyDocFilePath), { recursive: true })
    writeFileSync(manifestOnlyDocFilePath, 'manifest-only notes that should appear in the compare baseline prompt\n', 'utf8')
    writeManifestFixture(PROJECT_FIXTURE_ROOT, GRAPH_FIXTURE_ROOT, {
      document: [manifestOnlyDocFilePath],
    })

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
    expect(baselinePrompt).toContain('manifest-only notes that should appear in the compare baseline prompt')
  })

  it('keeps the manifest file set as the baseline boundary when it is present', () => {
    const graph = makeGraph()
    graph.addNode('graph_only_notes', {
      label: 'GraphOnlyNotes',
      source_file: 'docs/graph-only.md',
      source_location: 'L1',
      line_number: 1,
      node_kind: 'document',
      file_type: 'document',
      community: 0,
    })
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    const graphOnlyPath = join(PROJECT_FIXTURE_ROOT, 'docs', 'graph-only.md')
    mkdirSync(dirname(graphOnlyPath), { recursive: true })
    writeFileSync(graphOnlyPath, 'graph-only notes should stay out of the compare baseline prompt\n', 'utf8')
    writeManifestFixture(PROJECT_FIXTURE_ROOT, GRAPH_FIXTURE_ROOT, {
      code: [join(PROJECT_FIXTURE_ROOT, 'src', 'auth.ts')],
    })

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
    expect(baselinePrompt).not.toContain('graph-only notes should stay out of the compare baseline prompt')
  })

  it('fails when a graph-backed text file is missing from the local runtime corpus', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    rmSync(join(PROJECT_FIXTURE_ROOT, 'src', 'session.ts'))

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/graph-backed file/i)
  })

  it('fails when a graph-backed text file drifts from the saved graph snapshot manifest', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    writeManifestFixture()
    const driftedPath = join(PROJECT_FIXTURE_ROOT, 'src', 'auth.ts')
    writeFileSync(driftedPath, 'export const drifted = true\n', 'utf8')
    utimesSync(driftedPath, new Date('2026-04-24T19:30:01Z'), new Date('2026-04-24T19:30:01Z'))

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/out of sync|graph-backed file/i)
  })

  it('fails when an adjacent manifest exists but is invalid', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    writeFileSync(join(GRAPH_FIXTURE_ROOT, 'manifest.json'), '{not valid json', 'utf8')

    expect(() =>
      generateCompareArtifacts({
        graphPath,
        question: 'how does login create a session',
        outputDir: COMPARE_OUTPUT_ROOT,
        execTemplate: 'claude -p "$(cat {prompt_file})"',
        baselineMode: 'full',
        now: new Date('2026-04-24T19:30:00Z'),
      }),
    ).toThrow(/manifest/i)
  })

  it('skips oversized graph-backed text files instead of aborting compare generation', () => {
    const graph = makeGraph()
    writeProjectFiles()
    const graphPath = writeGraphFixture(graph)
    writeFileSync(join(PROJECT_FIXTURE_ROOT, 'src', 'session.ts'), `${'a'.repeat(MAX_TEXT_BYTES + 1)}\n`, 'utf8')

    const result = generateCompareArtifacts({
      graphPath,
      question: 'how does login create a session',
      outputDir: COMPARE_OUTPUT_ROOT,
      execTemplate: 'claude -p "$(cat {prompt_file})"',
      baselineMode: 'full',
      now: new Date('2026-04-24T19:30:00Z'),
    })

    const baselinePrompt = readFileSync(result.reports[0]!.paths.baseline_prompt, 'utf8')
    expect(baselinePrompt).toContain('return new SessionManager().createSession(credentials.userId)')
    expect(baselinePrompt).not.toContain('export class SessionManager')
  })

  it('rejects ambiguous question sources and invalid limits', () => {
    expect(() =>
      resolveCompareQuestions({
        question: 'how does login create a session',
        questionsPath: 'compare-questions.json',
        limit: 1,
      }),
    ).toThrow(/either a single question or a questions path/i)

    expect(() =>
      resolveCompareQuestions({
        question: 'how does login create a session',
        limit: 0,
      }),
    ).toThrow(/positive integer/i)
  })
})
