import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { vi } from 'vitest'

import * as sourceEvidenceResponse from '../../../src/runtime/source-evidence-response.js'
import { runContextPackCommand } from '../../../src/infrastructure/context-pack-command.js'
import { generateGraph, type GenerateGraphResult } from '../../../src/infrastructure/generate.js'

import { normalizeAssertionPath } from './platform.js'

const PACK_QUALITY_FIXTURE_ORDER = [
  'controller-service-test-flow',
  'queue-job-retry-workflow',
  'cli-command-implementation',
  'api-route-schema-service',
  'monorepo-package-boundary',
  'source-test-adjacency',
  'noisy-helper-distractor',
  'indirect-seed-workflow-owner',
  'framework-request-flow-owner',
  'framework-runtime-boundary-distractor',
  'runtime-generation-explain-report-flow',
] as const

const PACK_QUALITY_FIXTURE_ROOT = resolve('tests/fixtures/pack-quality')

interface PackQualityFixtureManifest {
  task?: 'implement' | 'explain'
  prompt: string
  budget?: number
  use_spi?: boolean
  expected_workflow_centers: string[]
  expected_likely_edit_files: string[]
  expected_likely_test_files: string[]
  expected_validation_commands: string[]
  expected_negative_guidance: string[]
  expected_retrieval_pipeline_phases?: string[]
}

interface PackDiagnostics {
  workflow_centers?: Array<{ path?: string }>
  recommended_first_read?: Array<{ path?: string }>
  likely_edit_files?: Array<{ path?: string }>
  likely_test_files?: Array<{ path?: string }>
  validation_commands?: string[]
  negative_guidance?: string[]
  claims?: Array<{ node_labels?: string[] }>
  expandable?: Array<{
    preview?: Array<{ label?: string }>
  }>
  retrieval_pipeline?: {
    phases?: Array<{ phase?: string }>
  }
}

export interface SourceEvidenceNode {
  node_id: string
  label: string
  source_file: string
  snippet?: string
  snippet_ref?: string
  snippet_line_range?: { start_line: number; end_line: number }
  snippet_omitted_ranges?: Array<{ start_line: number; end_line: number }>
  snippet_unverified?: boolean
}

interface SourceEvidencePayload {
  response_format: string
  pack: {
    matched_nodes: SourceEvidenceNode[]
    execution_slice?: { steps?: Array<{ label: string; source_file: string; line_number: number }> }
    answer_contract?: { do_not_claim?: string[] }
  }
  implementation?: Pick<PackDiagnostics, 'likely_edit_files' | 'likely_test_files' | 'validation_commands'>
  evidence: { answerability: { advisory: boolean; answer_scope?: string; missing_obligations?: string[] } }
  expandable?: Array<{
    handle_id: string
    focus_files?: string[]
    focus_ranges?: Array<{ source_file: string; start_line: number; end_line: number }>
  }>
  serialized_budget: { max_tokens: number; token_count: number; enforced: boolean }
}

export interface PackQualityFixtureRunResult {
  fixture: PackQualityFixtureManifest
  graph: GenerateGraphResult
  payload: SourceEvidencePayload
  output: string
  diagnostics: PackDiagnostics
}

function withTempDir<T>(callback: (tempDir: string) => T | Promise<T>): T | Promise<T> {
  const tempDir = mkdtempSync(join(tmpdir(), 'madar-pack-quality-'))
  const finalize = () => rmSync(tempDir, { recursive: true, force: true })
  try {
    const result = callback(tempDir)
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).finally(finalize)
    }
    finalize()
    return result
  } catch (error) {
    finalize()
    throw error
  }
}

function fixtureDir(name: string): string {
  return join(PACK_QUALITY_FIXTURE_ROOT, name)
}

function fixtureManifestPath(name: string): string {
  return join(fixtureDir(name), 'fixture.json')
}

function fixtureWorkspaceRoot(name: string): string {
  return join(fixtureDir(name), 'workspace')
}

function copyFixtureWorkspace(name: string, tempDir: string): string {
  const sourceRoot = fixtureWorkspaceRoot(name)
  const targetRoot = join(tempDir, name)
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = relative(sourceRoot, source)
      return relativePath !== 'out' && !relativePath.startsWith(`out${sep}`)
    },
  })
  return targetRoot
}

function loadPackQualityFixture(name: string): PackQualityFixtureManifest {
  const manifestPath = fixtureManifestPath(name)
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<PackQualityFixtureManifest>
  const requiredArrayFields = [
    'expected_workflow_centers',
    'expected_likely_edit_files',
    'expected_likely_test_files',
    'expected_validation_commands',
    'expected_negative_guidance',
  ] as const
  const problems: string[] = []

  if (typeof parsed.prompt !== 'string' || parsed.prompt.trim().length === 0) {
    problems.push('"prompt" must be a non-empty string')
  }
  if ('task' in parsed && parsed.task !== undefined && parsed.task !== 'implement' && parsed.task !== 'explain') {
    problems.push('"task" must be either "implement" or "explain" when provided')
  }
  if ('budget' in parsed && parsed.budget !== undefined && typeof parsed.budget !== 'number') {
    problems.push('"budget" must be a number when provided')
  }
  if ('use_spi' in parsed && parsed.use_spi !== undefined && typeof parsed.use_spi !== 'boolean') {
    problems.push('"use_spi" must be a boolean when provided')
  }
  if (
    'expected_retrieval_pipeline_phases' in parsed
    && parsed.expected_retrieval_pipeline_phases !== undefined
    && !Array.isArray(parsed.expected_retrieval_pipeline_phases)
  ) {
    problems.push('"expected_retrieval_pipeline_phases" must be an array when provided')
  }
  for (const field of requiredArrayFields) {
    if (!Array.isArray(parsed[field])) {
      problems.push(`"${field}" must be an array`)
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid fixture manifest at ${manifestPath}: ${problems.join('; ')}`)
  }

  const prompt = parsed.prompt as string
  const expectedWorkflowCenters = parsed.expected_workflow_centers as string[]
  const expectedLikelyEditFiles = parsed.expected_likely_edit_files as string[]
  const expectedLikelyTestFiles = parsed.expected_likely_test_files as string[]
  const expectedValidationCommands = parsed.expected_validation_commands as string[]
  const expectedNegativeGuidance = parsed.expected_negative_guidance as string[]
  const expectedRetrievalPipelinePhases = Array.isArray(parsed.expected_retrieval_pipeline_phases)
    ? parsed.expected_retrieval_pipeline_phases as string[]
    : undefined

  return {
    ...(parsed.task === 'implement' || parsed.task === 'explain' ? { task: parsed.task } : {}),
    prompt,
    ...(typeof parsed.budget === 'number' ? { budget: parsed.budget } : {}),
    ...(typeof parsed.use_spi === 'boolean' ? { use_spi: parsed.use_spi } : {}),
    expected_workflow_centers: expectedWorkflowCenters,
    expected_likely_edit_files: expectedLikelyEditFiles,
    expected_likely_test_files: expectedLikelyTestFiles,
    expected_validation_commands: expectedValidationCommands,
    expected_negative_guidance: expectedNegativeGuidance,
    ...(expectedRetrievalPipelinePhases ? { expected_retrieval_pipeline_phases: expectedRetrievalPipelinePhases } : {}),
  }
}

function normalizeDiagnostics(payload: PackDiagnostics): PackDiagnostics {
  return {
    ...payload,
    ...(payload.workflow_centers
      ? {
          workflow_centers: payload.workflow_centers.map((entry) => ({
            ...entry,
            ...(entry.path ? { path: normalizeAssertionPath(entry.path) } : {}),
          })),
        }
      : {}),
    ...(payload.recommended_first_read
      ? {
          recommended_first_read: payload.recommended_first_read.map((entry) => ({
            ...entry,
            ...(entry.path ? { path: normalizeAssertionPath(entry.path) } : {}),
          })),
        }
      : {}),
    ...(payload.likely_edit_files
      ? {
          likely_edit_files: payload.likely_edit_files.map((entry) => ({
            ...entry,
            ...(entry.path ? { path: normalizeAssertionPath(entry.path) } : {}),
          })),
        }
      : {}),
    ...(payload.likely_test_files
      ? {
          likely_test_files: payload.likely_test_files.map((entry) => ({
            ...entry,
            ...(entry.path ? { path: normalizeAssertionPath(entry.path) } : {}),
          })),
        }
      : {}),
  }
}

export function listPackQualityFixtures(): string[] {
  const fixtureNames = readdirSync(PACK_QUALITY_FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const unlistedFixtures = fixtureNames.filter((name) => !PACK_QUALITY_FIXTURE_ORDER.includes(name as typeof PACK_QUALITY_FIXTURE_ORDER[number]))

  if (unlistedFixtures.length > 0) {
    throw new Error(`Found unlisted pack-quality fixture directories: ${unlistedFixtures.sort((left, right) => left.localeCompare(right)).join(', ')}`)
  }

  return PACK_QUALITY_FIXTURE_ORDER.filter((name) =>
    fixtureNames.includes(name) && existsSync(fixtureManifestPath(name)) && existsSync(fixtureWorkspaceRoot(name)))
}

export async function runPackQualityFixture(
  name: string,
  overrides: Partial<Pick<PackQualityFixtureManifest, 'prompt' | 'budget' | 'task'>> = {},
): Promise<PackQualityFixtureRunResult> {
  const fixture = loadPackQualityFixture(name)
  const runFixture = {
    ...fixture,
    ...overrides,
  }
  return withTempDir(async (tempDir) => {
    const workspaceRoot = copyFixtureWorkspace(name, tempDir)
    const graph = generateGraph(workspaceRoot, {
      noHtml: true,
      // Fixtures are regression baselines: pin their extraction strategy so a
      // product-default change does not silently rewrite their expectations.
      // Default-auto behavior is exercised directly in generation tests.
      extractionMode: runFixture.use_spi ? 'spi' : 'legacy',
    })
    const graphPath = join(workspaceRoot, 'out', 'graph.json')
    const options = {
      prompt: runFixture.prompt,
      budget: runFixture.budget ?? 1800,
      task: runFixture.task ?? 'implement',
      taskExplicit: true,
      graphPath,
      format: 'json' as const,
    }
    // Observe this exact CLI run's internal planning input without changing its
    // serializer, retrieval budget, or compact response. Verbose diagnostics can
    // themselves be omitted at the fixture budget and are not source-delivery proof.
    let diagnostics: PackDiagnostics | undefined
    const finalize = sourceEvidenceResponse.finalizeSourceEvidenceResponse
    const capture = vi.spyOn(sourceEvidenceResponse, 'finalizeSourceEvidenceResponse').mockImplementation((...args) => {
      diagnostics = args[0] as PackDiagnostics
      return finalize(...args)
    })
    let packOutput: string
    try {
      packOutput = await runContextPackCommand(options)
    } finally {
      capture.mockRestore()
    }
    if (!diagnostics) throw new Error('CLI did not invoke the source-evidence finalizer')

    return {
      fixture: runFixture,
      graph,
      payload: JSON.parse(packOutput) as SourceEvidencePayload,
      output: packOutput,
      diagnostics: normalizeDiagnostics(diagnostics),
    }
  })
}

/** Read the unchanged fixture source independently of graph snippets or diagnostics. */
export function readPackQualityFixtureSource(name: string, sourceFile: string): string {
  const root = fixtureWorkspaceRoot(name)
  const path = resolve(root, sourceFile)
  const withinRoot = relative(root, path)
  if (isAbsolute(sourceFile) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) {
    throw new Error(`Fixture source path escapes workspace: ${sourceFile}`)
  }
  return readFileSync(path, 'utf8')
}
