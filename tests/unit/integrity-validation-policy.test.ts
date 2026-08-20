import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../../src/contracts/graph.js'
import { buildFromJson } from '../../src/pipeline/build.js'

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

const SNAPSHOT_SRC = 'src/contracts/graph-integrity-snapshot.ts'
const VALIDATION_SRC = 'src/contracts/graph-integrity-validation.ts'
const GRAPH_SRC = 'src/contracts/graph.ts'
const MUTATIONS = 'scripts/verify-integrity-mutations.mjs'
const RECEIPTS = 'scripts/verify-integrity-receipts.mjs'

/**
 * Policy tests, not behaviour tests.
 *
 * Each one fails when a future change quietly opts out of a rule the review
 * established, rather than when it produces a wrong answer. A wrong answer is
 * caught by the behaviour suites; opting out is not, because the opted-out path
 * simply stops being exercised.
 */

function snapshotFields(): string[] {
  const source = read(SNAPSHOT_SRC)
  const start = source.indexOf('export interface FinalizedNormalizedIntegritySnapshot {')
  const body = source.slice(start, source.indexOf('\n}', start))
  return [...body.matchAll(/^\s*readonly (\w+)[?]?:/gm)].map((match) => match[1]!)
}

describe('policy — every serializer-facing snapshot field is validated', () => {
  it('routes every snapshot field through the total validator', () => {
    // Fields the validator derives rather than receives: they are computed from
    // inputs it has already validated, so validating them again would check
    // this module's own arithmetic rather than the data.
    const derived = new Set(['accountingScope', 'status', 'reasons', 'graphTotals'])
    const validation = read(VALIDATION_SRC)
    const finalization = read(SNAPSHOT_SRC)

    const unvalidated = snapshotFields().filter((field) => (
      !derived.has(field)
      && !validation.includes(field)
      && !finalization.includes(`${field}:`)
    ))
    expect(unvalidated, `snapshot fields never seen by the validator: ${unvalidated.join(', ')}`).toEqual([])
  })

  it('passes terminalReasonCounts into the validator rather than only freezing it', () => {
    expect(read(SNAPSHOT_SRC)).toContain('terminalReasonCounts: accounting.terminalReasonCounts')
    expect(read(VALIDATION_SRC)).toContain('assertTerminalReasonCounts(input.terminalReasonCounts)')
  })

  it('finalizes only through the single validating entry point', () => {
    const source = read(SNAPSHOT_SRC)
    expect(source).toContain('assertSerializerFacingIntegrity(')
    // One call, so no second construction path can skip it.
    expect(source.match(/assertSerializerFacingIntegrity\(/g)).toHaveLength(1)
  })
})

describe('policy — structured schemas declare exact keys', () => {
  it('declares a closed key set for every structured serializer-facing schema', () => {
    const validation = read(VALIDATION_SRC)
    for (const schema of [
      'verificationTarget', 'sourceRange', 'sourcePosition', 'graphTotals',
      'storageAdmission', 'occurrence', 'occurrenceOwner', 'recordRetention',
    ]) {
      const declaration = validation.indexOf(`  ${schema}: {`)
      expect(declaration, `SCHEMA.${schema} is not declared`).toBeGreaterThan(-1)
      // Declared with an explicit required set, however it happens to be
      // formatted across lines.
      expect(validation.slice(declaration, declaration + 260), `SCHEMA.${schema} declares no required keys`)
        .toContain('required:')
    }
  })

  it('validates retention through the exact-key owner, not a field-by-field read', () => {
    expect(read('src/contracts/graph-integrity.ts'))
      .toContain('assertExactObjectShape(retention, field, DETAIL_RETENTION_KEYS)')
  })

  it('keeps one owner for plain-object and exact-key checking', () => {
    const contracts = read('src/contracts/graph-integrity.ts')
    expect(contracts.match(/export function assertPlainJsonObject\(/g)).toHaveLength(1)
    expect(contracts.match(/export function assertExactObjectShape\(/g)).toHaveLength(1)
  })
})

describe('policy — every graph state mutation participates in invalidation', () => {
  it('clears the snapshot only inside the single seam', () => {
    const source = read(GRAPH_SRC)
    expect(source.match(/this\.integritySnapshot\s*=\s*null/g) ?? []).toHaveLength(1)
    expect(source).toContain('private invalidateIntegritySnapshot(): void {')
  })

  it('compares both halves of node state before deciding a no-op', () => {
    const source = read(GRAPH_SRC)
    const start = source.indexOf('  addNode(')
    const body = source.slice(start, source.indexOf('\n  }', start))
    expect(body).toContain('nodeEndpointIdentityMap.get(id)')
    expect(body).toContain('invalidateIntegritySnapshot()')
  })

  it('never recomputes the snapshot inside a read accessor', () => {
    const source = read(GRAPH_SRC)
    const start = source.indexOf('normalizedIntegritySnapshot()')
    expect(source.slice(start, source.indexOf('\n  }', start))).not.toContain('finalizeNormalizedIntegritySnapshot')
  })

  it('leaves no state-mutating path without an invalidation decision', () => {
    // Every writer of node, fact, occurrence or admission state must either
    // call the seam or be one of the reviewed pass-through helpers that
    // delegates to a path which does.
    const source = read(GRAPH_SRC)
    const writers = [...source.matchAll(/^\s{4}this\.(nodeMap|occurrenceMap|factMap|unregisteredRelationAdmissions)\.set\(/gm)]
    expect(writers.length).toBeGreaterThan(0)
    for (const writer of writers) {
      const after = source.slice(writer.index!, writer.index! + 1400)
      expect(
        after.includes('invalidateIntegritySnapshot()'),
        `a writer near "${writer[0]!.trim()}" makes no invalidation decision`,
      ).toBe(true)
    }
  })
})

describe('policy — mutation controls stay attributable', () => {
  it('declares a focused suite and an expectation for every mutant', () => {
    const source = read(MUTATIONS)
    const names = source.match(/^ {4}name: '/gm) ?? []
    const tests = source.match(/^ {4}test: /gm) ?? []
    const expects = source.match(/^ {4}expect: \[/gm) ?? []
    // Deliberately not a fixed count: the gate is that every mutant is
    // attributable, not that there are exactly N of them.
    expect(names.length).toBeGreaterThan(0)
    expect(tests).toHaveLength(names.length)
    expect(expects).toHaveLength(names.length)
  })

  it('declares at least one expected test name per mutant', () => {
    const source = read(MUTATIONS)
    const empty = source.match(/^ {4}expect: \[\s*\]/gm) ?? []
    expect(empty, 'a mutant declares an empty expectation and can never be caught').toHaveLength(0)
  })
})

describe('policy — the invalidation seam is reachable from a real build', () => {
  it('attaches and invalidates on a production graph', () => {
    const graph: KnowledgeGraph = buildFromJson({
      schema_version: 1,
      directed: true,
      nodes: [{ id: 'alpha', label: 'A', file_type: 'code', source_file: 'src/a.ts' }],
      edges: [{ source: 'alpha', target: 'missing', relation: 'calls', confidence: 'EXTRACTED' }],
    }, { directed: true, accounting: 'normalized_extraction_boundary' })
    expect(graph.normalizedIntegritySnapshot()).not.toBeNull()
    graph.addNode('beta', {})
    expect(graph.normalizedIntegritySnapshot()).toBeNull()
  })
})

describe('policy — the receipt command cannot qualify without an exact baseline', () => {
  it('refuses to produce a receipt with no comparison at all', () => {
    const source = read(RECEIPTS)
    expect(source).toContain('refusing to produce a receipt with no comparison')
    expect(source).toContain("argOf('--baseline-ref')")
  })

  it('resolves the baseline ref itself rather than trusting a prepared checkout', () => {
    const source = read(RECEIPTS)
    expect(source).toContain("execFileSync('git', ['worktree', 'add', '--detach'")
    expect(source).toContain("execFileSync('npm', step,")
    expect(source).toContain('refusing to measure a dirty tree')
    expect(source).toContain('baseline ref cannot be resolved')
  })

  it('cleans the temporary worktree on success, failure and signal', () => {
    const source = read(RECEIPTS)
    expect(source).toContain("process.on('SIGINT', onSignal)")
    expect(source).toContain("process.on('SIGTERM', onSignal)")
    expect(source).toContain('} finally {')
    expect(source).toContain("execFileSync('git', ['worktree', 'prune']")
  })

  it('requires both arms to receive identical input', () => {
    const source = read(RECEIPTS)
    expect(source).toContain('arms did not receive identical input')
    expect(source).toContain('canonical_input_checksum')
  })

  it('runs arms in separate processes with counterbalanced order', () => {
    const source = read(RECEIPTS)
    expect(source).toContain("order: 'baseline-first'")
    expect(source).toContain("order: 'candidate-first'")
    expect(source).toContain('--measure-arm')
  })

  it('gates on wall time and RSS alike', () => {
    expect(read(RECEIPTS)).toContain("ratio > 2 || rssRatio > 2 ? 'HUMAN_GATE'")
  })
})
