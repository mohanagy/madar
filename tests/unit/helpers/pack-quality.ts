import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

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
  expected_workflow_centers: string[]
  expected_likely_edit_files: string[]
  expected_likely_test_files: string[]
  expected_validation_commands: string[]
  expected_negative_guidance: string[]
  expected_retrieval_pipeline_phases?: string[]
}

interface PackSchemaPayload {
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

export interface PackQualityFixtureRunResult {
  fixture: PackQualityFixtureManifest
  graph: GenerateGraphResult
  payload: PackSchemaPayload
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
    expected_workflow_centers: expectedWorkflowCenters,
    expected_likely_edit_files: expectedLikelyEditFiles,
    expected_likely_test_files: expectedLikelyTestFiles,
    expected_validation_commands: expectedValidationCommands,
    expected_negative_guidance: expectedNegativeGuidance,
    ...(expectedRetrievalPipelinePhases ? { expected_retrieval_pipeline_phases: expectedRetrievalPipelinePhases } : {}),
  }
}

function normalizePayload(payload: PackSchemaPayload): PackSchemaPayload {
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
    const graph = generateGraph(workspaceRoot)
    const graphPath = join(workspaceRoot, 'out', 'graph.json')
    const packOutput = await runContextPackCommand({
      prompt: runFixture.prompt,
      budget: runFixture.budget ?? 1800,
      task: runFixture.task ?? 'implement',
      taskExplicit: true,
      graphPath,
      format: 'json',
    } as never)

    return {
      fixture: runFixture,
      graph,
      payload: normalizePayload(JSON.parse(packOutput) as PackSchemaPayload),
    }
  })
}
