import { describe, expect, it } from 'vitest'

import {
  assertClosedGoldBucket,
  buildCanonicalFixtureFacts,
  matchesGoldSelector,
  measureGoldBucket,
  readCanonicalGoldDefinition,
  type GoldMeasurement,
  type GoldSelector,
} from '../helpers/canonical-index-gold.js'

const FRAMEWORK_EDGE_RELATIONS: Record<string, ReadonlySet<string>> = {
  express: new Set(['route_handler']),
  nestjs: new Set([
    'controller_route',
    'guards',
    'injects',
    'intercepts',
    'module_exports',
    'module_imports',
    'module_provides',
    'pipes',
    'registers_controller',
  ]),
  nextjs: new Set(['contains']),
  trpc: new Set(['route_handler']),
  prisma: new Set(['calls']),
  'react-router': new Set(['route_handler']),
  fastify: new Set(['route_handler']),
  hono: new Set(['route_handler']),
}

function withBucket(bucket: string, fact: GoldSelector): GoldSelector {
  return { bucket, ...fact }
}

function endpointKey(file: string, name: string): string {
  return `${file}|${name}`
}

function touchesFrameworkNode(
  fact: { from_file: string; from_name: string; to_file: string; to_name: string },
  frameworkNodeKeys: ReadonlySet<string>,
): boolean {
  return frameworkNodeKeys.has(endpointKey(fact.from_file, fact.from_name))
    || frameworkNodeKeys.has(endpointKey(fact.to_file, fact.to_name))
}

function isFrameworkSpecificNegativeEdge(
  relation: string,
  connectedToFrameworkNode: boolean,
): boolean {
  // `contains` and `calls` are generic graph facts. They become framework
  // evidence only when attached to a framework-tagged endpoint. The other
  // allowed relations are emitted solely by framework recognition.
  return relation === 'contains' || relation === 'calls'
    ? connectedToFrameworkNode
    : true
}

describe('canonical framework gold facts', () => {
  const gold = readCanonicalGoldDefinition()
  const facts = buildCanonicalFixtureFacts()

  it('fails immediately on every forbidden framework or provenance fact', () => {
    for (const [framework, definition] of Object.entries(gold.frameworks)) {
      expect(
        facts.nodes.some((fact) => fact.source_file === definition.negative_file && fact.framework_role.length > 0),
        `${framework} negative candidate was tagged`,
      ).toBe(false)
      expect(facts.nodes.some((fact) => fact.source_file === definition.negative_file)).toBe(true)
    }

    for (const selector of gold.forbidden.decorator_runtime_calls) {
      expect(facts.edges.some((fact) => matchesGoldSelector({ ...fact }, selector))).toBe(false)
    }
    expect(facts.nodes.some((fact) => fact.source_file.startsWith('/'))).toBe(false)
    expect(facts.edges.some((fact) => fact.source_file.startsWith('/'))).toBe(false)
  })

  it('reports exact node and connected-edge precision independently for every accepted framework', () => {
    const reports: Array<{ framework: string; nodes: GoldMeasurement; edges: GoldMeasurement }> = []
    for (const [framework, definition] of Object.entries(gold.frameworks)) {
      const positiveFiles = new Set(definition.nodes.map((selector) => String(selector.source_file)))
      const frameworkNodeKeys = new Set(facts.nodes
        .filter((fact) => fact.framework === framework)
        .map((fact) => endpointKey(fact.source_file, fact.qualified_name || fact.label)))
      const allowedRelations = FRAMEWORK_EDGE_RELATIONS[framework]
      expect(allowedRelations, `missing edge relation contract for ${framework}`).toBeDefined()

      const positiveEdges = facts.edges.filter((fact) =>
        positiveFiles.has(fact.from_file)
        && allowedRelations!.has(fact.relation)
        && touchesFrameworkNode(fact, frameworkNodeKeys))
      const negativeEdges = facts.edges.filter((fact) =>
        (fact.from_file === definition.negative_file || fact.source_file === definition.negative_file)
        && allowedRelations!.has(fact.relation)
        && isFrameworkSpecificNegativeEdge(
          fact.relation,
          touchesFrameworkNode(fact, frameworkNodeKeys),
        ))
      const actualEdges = [...new Map(
        [...positiveEdges, ...negativeEdges].map((fact) => [fact.key, fact]),
      ).values()]

      const nodeReport = measureGoldBucket(
        `framework:${framework}:nodes`,
        facts.nodes.filter((fact) => fact.framework === framework) as unknown as GoldSelector[],
        definition.nodes,
      )
      const edgeReport = measureGoldBucket(
        `framework:${framework}:edges`,
        actualEdges as unknown as GoldSelector[],
        definition.edges,
      )
      assertClosedGoldBucket(nodeReport, 1)
      assertClosedGoldBucket(edgeReport, 1)
      expect(nodeReport.precision).toBe(1)
      expect(edgeReport.precision).toBe(1)
      reports.push({ framework, nodes: nodeReport, edges: edgeReport })
    }

    console.info('[canonical-index-framework-precision]', JSON.stringify(reports.map((report) => ({
      framework: report.framework,
      nodes: {
        expected: report.nodes.expected,
        actual: report.nodes.actual,
        recall: report.nodes.recall,
        precision: report.nodes.precision,
        unexpected: report.nodes.unexpected,
      },
      edges: {
        expected: report.edges.expected,
        actual: report.edges.actual,
        recall: report.edges.recall,
        precision: report.edges.precision,
        unexpected: report.edges.unexpected,
      },
    }))))
  })

  it('meets the aggregate call/framework recall gate with no unexpected facts', () => {
    const actualCalls = facts.edges
      .filter((fact) => fact.relation === 'calls')
      .map((fact) => withBucket('calls', { ...fact }))
    const expectedCalls = gold.calls
      .map((fact) => withBucket('calls', { relation: 'calls', ...fact }))
    const actualFramework: GoldSelector[] = []
    const expectedFramework: GoldSelector[] = []
    for (const [framework, definition] of Object.entries(gold.frameworks)) {
      const positiveFiles = new Set(definition.nodes.map((selector) => String(selector.source_file)))
      const frameworkNodeKeys = new Set(facts.nodes
        .filter((fact) => fact.framework === framework)
        .map((fact) => endpointKey(fact.source_file, fact.qualified_name || fact.label)))
      const allowedRelations = FRAMEWORK_EDGE_RELATIONS[framework]!
      const connected = facts.edges.filter((fact) =>
        allowedRelations.has(fact.relation)
        && (
          (
            positiveFiles.has(fact.from_file)
            && touchesFrameworkNode(fact, frameworkNodeKeys)
          )
          || (
            (fact.from_file === definition.negative_file || fact.source_file === definition.negative_file)
            && isFrameworkSpecificNegativeEdge(
              fact.relation,
              touchesFrameworkNode(fact, frameworkNodeKeys),
            )
          )
        ))
      actualFramework.push(...[...new Map(connected.map((fact) => [fact.key, fact])).values()]
        .map((fact) => withBucket(`framework:${framework}`, { ...fact })))
      expectedFramework.push(...definition.edges
        .map((fact) => withBucket(`framework:${framework}`, fact)))
    }
    const callReport = measureGoldBucket('calls', actualCalls, expectedCalls)
    const aggregate = measureGoldBucket(
      'calls-and-frameworks',
      [...actualCalls, ...actualFramework],
      [...expectedCalls, ...expectedFramework],
    )

    assertClosedGoldBucket(callReport, 1)
    assertClosedGoldBucket(aggregate, gold.thresholds.call_framework_recall)
    expect(aggregate.recall).toBeGreaterThanOrEqual(0.9)
    expect(callReport.precision).toBe(1)
  })
})
