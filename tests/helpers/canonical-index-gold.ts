import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'
import type { GraphAttributes } from '../../src/domain/graph/directed-multigraph.js'

export type CanonicalNodeFact = {
  key: string
  source_file: string
  label: string
  qualified_name: string
  node_kind: string
  language: string
  framework: string
  framework_role: string
  route_path: string
  storage_operation: string
  exported: boolean
}

export type CanonicalEdgeFact = {
  key: string
  source_file: string
  source_location: string
  relation: string
  from_file: string
  from_name: string
  to_file: string
  to_name: string
  module_form: string
  module_bindings: string[]
  is_type_only: boolean
}

export type CanonicalGoldFacts = {
  nodes: CanonicalNodeFact[]
  edges: CanonicalEdgeFact[]
  diagnostics: Array<{ id: string; level: string; path: string }>
}

export type GoldSelector = Record<string, unknown>

export type GoldMeasurement = {
  name: string
  expected: number
  actual: number
  matched: number
  recall: number
  precision: number
  missing: GoldSelector[]
  unexpected: GoldSelector[]
}

export type CanonicalGoldDefinition = {
  required_nodes: GoldSelector[]
  module_facts: GoldSelector[]
  semantic_facts: GoldSelector[]
  calls: GoldSelector[]
  frameworks: Record<string, {
    negative_file: string
    nodes: GoldSelector[]
    edges: GoldSelector[]
  }>
  forbidden: {
    framework_roles_in_negative_files: boolean
    absolute_source_paths: boolean
    decorator_runtime_calls: GoldSelector[]
  }
  thresholds: {
    module_recall: number
    call_framework_recall: number
  }
}

export const CANONICAL_INDEX_FIXTURE_ROOT = resolve('tests/fixtures/canonical-index')

export function readCanonicalGoldDefinition(): CanonicalGoldDefinition {
  return JSON.parse(readFileSync(join(CANONICAL_INDEX_FIXTURE_ROOT, 'gold.json'), 'utf8')) as CanonicalGoldDefinition
}

function equalSelectorValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  }
  return actual === expected
}

export function matchesGoldSelector(fact: GoldSelector, selector: GoldSelector): boolean {
  return Object.entries(selector).every(([key, value]) => equalSelectorValue(fact[key], value))
}

export function measureGoldBucket(
  name: string,
  actual: readonly GoldSelector[],
  expected: readonly GoldSelector[],
): GoldMeasurement {
  // Match facts one-to-one. A set-membership check lets duplicate actual facts
  // reuse one expected selector and falsely report perfect precision. The
  // augmenting-path matcher preserves the most matches when selectors overlap
  // while leaving every duplicate or otherwise unclaimed actual fact visible.
  const expectedByActual = Array<number>(actual.length).fill(-1)

  const claimActual = (expectedIndex: number, visitedActual: Set<number>): boolean => {
    for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
      if (visitedActual.has(actualIndex) || !matchesGoldSelector(actual[actualIndex]!, expected[expectedIndex]!)) {
        continue
      }
      visitedActual.add(actualIndex)
      const previousExpected = expectedByActual[actualIndex]!
      if (previousExpected === -1 || claimActual(previousExpected, visitedActual)) {
        expectedByActual[actualIndex] = expectedIndex
        return true
      }
    }
    return false
  }

  const matchedExpected = new Set<number>()
  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    if (claimActual(expectedIndex, new Set())) matchedExpected.add(expectedIndex)
  }

  const missing = expected.filter((_, index) => !matchedExpected.has(index))
  const unexpected = actual.filter((_, index) => expectedByActual[index] === -1)
  const matched = matchedExpected.size
  return {
    name,
    expected: expected.length,
    actual: actual.length,
    matched,
    recall: expected.length === 0 ? 1 : matched / expected.length,
    precision: actual.length === 0 ? 1 : matched / actual.length,
    missing,
    unexpected,
  }
}

export function assertClosedGoldBucket(
  measurement: GoldMeasurement,
  minimumRecall: number,
): void {
  if (measurement.recall < minimumRecall || measurement.unexpected.length > 0) {
    throw new Error([
      `Canonical gold bucket ${measurement.name} failed`,
      `recall=${measurement.recall.toFixed(4)} required=${minimumRecall.toFixed(4)}`,
      `precision=${measurement.precision.toFixed(4)}`,
      `missing=${JSON.stringify(measurement.missing, null, 2)}`,
      `unexpected=${JSON.stringify(measurement.unexpected, null, 2)}`,
    ].join('\n'))
  }
}

export function canonicalFixtureSourceFiles(root = CANONICAL_INDEX_FIXTURE_ROOT): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (['.js', '.jsx', '.ts', '.tsx'].includes(extname(entry.name))) files.push(path.replaceAll('\\', '/'))
    }
  }
  visit(root)
  return files.sort()
}

function stringAttribute(attributes: GraphAttributes, key: string): string {
  const value = attributes[key]
  return typeof value === 'string' ? value : ''
}

export function buildCanonicalFixtureFacts(
  root = CANONICAL_INDEX_FIXTURE_ROOT,
  files: readonly string[] = canonicalFixtureSourceFiles(root),
): CanonicalGoldFacts {
  const result = buildCanonicalTypeScriptIndex({ root, files })
  const nodesById = new Map(result.graph.nodeEntries())
  const nodes = result.graph.nodeEntries().map(([id, attributes]): CanonicalNodeFact => {
    const sourceFile = stringAttribute(attributes, 'source_file')
    const label = stringAttribute(attributes, 'label')
    const qualifiedName = stringAttribute(attributes, 'qualified_name')
    const nodeKind = stringAttribute(attributes, 'node_kind')
    const language = stringAttribute(attributes, 'language')
    const framework = stringAttribute(attributes, 'framework')
    const frameworkRole = stringAttribute(attributes, 'framework_role')
    const routePath = stringAttribute(attributes, 'route_path')
    const storageOperation = stringAttribute(attributes, 'storage_operation')
    const exported = attributes.exported === true
    return {
      key: [sourceFile, nodeKind, qualifiedName || label, frameworkRole, routePath, storageOperation].join('|'),
      source_file: sourceFile,
      label,
      qualified_name: qualifiedName,
      node_kind: nodeKind,
      language,
      framework,
      framework_role: frameworkRole,
      route_path: routePath,
      storage_operation: storageOperation,
      exported,
    }
  }).sort((left, right) => left.key.localeCompare(right.key))

  const edges = result.graph.edgeEntries().map(([from, to, attributes]): CanonicalEdgeFact => {
    const fromNode = nodesById.get(from) ?? {}
    const toNode = nodesById.get(to) ?? {}
    const sourceFile = stringAttribute(attributes, 'source_file')
    const sourceLocation = stringAttribute(attributes, 'source_location')
    const relationName = stringAttribute(attributes, 'relation')
    const fromFile = stringAttribute(fromNode, 'source_file')
    const fromName = stringAttribute(fromNode, 'qualified_name') || stringAttribute(fromNode, 'label')
    const toFile = stringAttribute(toNode, 'source_file')
    const toName = stringAttribute(toNode, 'qualified_name') || stringAttribute(toNode, 'label')
    const moduleForm = stringAttribute(attributes, 'module_form')
    const moduleBindings = Array.isArray(attributes.module_bindings)
      ? attributes.module_bindings.filter((value): value is string => typeof value === 'string')
      : []
    const isTypeOnly = attributes.is_type_only === true
    return {
      key: [fromFile, fromName, relationName, toFile, toName, sourceFile, sourceLocation, moduleForm, moduleBindings.join(','), isTypeOnly].join('|'),
      source_file: sourceFile,
      source_location: sourceLocation,
      relation: relationName,
      from_file: fromFile,
      from_name: fromName,
      to_file: toFile,
      to_name: toName,
      module_form: moduleForm,
      module_bindings: moduleBindings,
      is_type_only: isTypeOnly,
    }
  }).sort((left, right) => left.key.localeCompare(right.key))

  const filePathById = new Map(result.files.map((file) => [file.id, file.path]))
  const diagnostics = result.diagnostics.map((diagnostic) => ({
    id: diagnostic.id,
    level: diagnostic.level,
    path: diagnostic.evidence?.file_id ? filePathById.get(diagnostic.evidence.file_id) ?? '' : '',
  })).sort((left, right) => left.id.localeCompare(right.id))

  return { nodes, edges, diagnostics }
}

export function fixtureRelativePath(path: string): string {
  return relative(CANONICAL_INDEX_FIXTURE_ROOT, path).replaceAll('\\', '/')
}
