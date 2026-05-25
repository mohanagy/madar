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
] as const

const PACK_QUALITY_FIXTURE_ROOT = resolve('tests/fixtures/pack-quality')

interface PackQualityFixtureManifest {
  prompt: string
  budget?: number
  expected_workflow_centers: string[]
  expected_likely_edit_files: string[]
  expected_likely_test_files: string[]
  expected_validation_commands: string[]
  expected_negative_guidance: string[]
}

interface PackSchemaPayload {
  workflow_centers?: Array<{ path?: string }>
  likely_edit_files?: Array<{ path?: string }>
  likely_test_files?: Array<{ path?: string }>
  validation_commands?: string[]
  negative_guidance?: string[]
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
  return {
    prompt: parsed.prompt ?? '',
    ...(typeof parsed.budget === 'number' ? { budget: parsed.budget } : {}),
    expected_workflow_centers: parsed.expected_workflow_centers ?? [],
    expected_likely_edit_files: parsed.expected_likely_edit_files ?? [],
    expected_likely_test_files: parsed.expected_likely_test_files ?? [],
    expected_validation_commands: parsed.expected_validation_commands ?? [],
    expected_negative_guidance: parsed.expected_negative_guidance ?? [],
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

  return PACK_QUALITY_FIXTURE_ORDER.filter((name) =>
    fixtureNames.includes(name) && existsSync(fixtureManifestPath(name)) && existsSync(fixtureWorkspaceRoot(name)))
}

export async function runPackQualityFixture(name: string): Promise<PackQualityFixtureRunResult> {
  const fixture = loadPackQualityFixture(name)
  return withTempDir(async (tempDir) => {
    const workspaceRoot = copyFixtureWorkspace(name, tempDir)
    const graph = generateGraph(workspaceRoot, { noHtml: true })
    const graphPath = join(workspaceRoot, 'out', 'graph.json')
    const packOutput = await runContextPackCommand({
      prompt: fixture.prompt,
      budget: fixture.budget ?? 1800,
      task: 'implement',
      taskExplicit: true,
      graphPath,
      format: 'json',
    } as never)

    return {
      fixture,
      graph,
      payload: normalizePayload(JSON.parse(packOutput) as PackSchemaPayload),
    }
  })
}
