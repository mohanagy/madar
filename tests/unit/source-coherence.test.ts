import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyTaskContract, compileContextPack, type ContextPackNodeCandidate } from '../../src/runtime/context-pack.js'
import { sourceCoherencePriority } from '../../src/runtime/retrieve/source-coherence.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(bridge = 'dispatch() { const first = this.first(); return this.finish(first, this.second()); }', second = 'second() { return "audit"; }') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'madar-source-coherence-')))
  roots.push(root)
  const sourceFile = join(root, 'ledger.ts')
  const lines = [
    'export class Ledger {',
    '  first() { return "invoice"; }',
    `  ${second}`,
    `  ${bridge}`,
    '  finish(...values: unknown[]) { return values; }',
    '}',
    'export class Other {',
    '  second() { return "different"; }',
    '}',
    'export const unrelated = "invoice audit";',
  ]
  writeFileSync(sourceFile, lines.join('\n'))
  const node = (id: string, label: string, line: number) => ({ id, label, sourceFile, sourceLocation: `L${line}-L${line}` })
  const first = node('first', '.first()', 2), next = node('second', '.second()', 3)
  const dispatch = node('dispatch', '.dispatch()', 4), finish = node('finish', '.finish()', 5)
  const other = node('other-second', '.second()', 8), unrelated = node('unrelated', 'unrelated', 10)
  const candidates = [first, next, unrelated, dispatch, finish, other]
  return { root, lines, first, next, dispatch, finish, other, unrelated, candidates }
}

describe('bounded current source coherence', () => {
  it('prioritizes existing same-class source without changing evidence classes or inventing call relationships', () => {
    const f = fixture()
    const independent = Object.freeze([f.first, f.next, f.unrelated])
    const candidates = Object.freeze(f.candidates.map(node => Object.freeze(node)))
    const before = JSON.stringify({ independent, candidates })
    const priority = sourceCoherencePriority(independent, candidates, undefined, f.root)
    expect(priority).toEqual(['first', 'second', 'dispatch', 'finish'])
    expect(priority.every(id => candidates.some(candidate => candidate.id === id))).toBe(true)
    const nodes: ContextPackNodeCandidate[] = candidates.map(node => {
      const evidence_class = node.id === 'finish' ? 'supporting' : 'primary'
      return {
        label: node.label, node_id: node.id, source_file: 'ledger.ts', file_type: 'code', node_kind: 'method', evidence_class,
        estimate_tokens: () => 40,
        build_entry: () => ({ node_id: node.id, label: node.label, source_file: 'ledger.ts', line_number: 1,
          snippet: node.label, evidence_class, file_type: 'code', node_kind: 'method' }),
      }
    })
    const input = { task_contract: classifyTaskContract('explain', { budget: 160 }), nodes, relationships: [], selection_strategy: 'value-per-token' as const }
    const ordinary = compileContextPack(input)
    expect(ordinary.nodes.map(node => node.node_id)).toEqual(['first', 'second', 'unrelated', 'dispatch'])
    const pack = compileContextPack({ ...input, source_priority_ids: priority })
    expect(pack.nodes.map(node => node.node_id)).toEqual(priority)
    expect(pack.nodes.find(node => node.node_id === 'finish')?.evidence_class).toBe('supporting')
    expect(pack.relationships).toEqual([])
    expect(JSON.stringify({ independent, candidates })).toBe(before)
  })

  it.each(['different class', 'static target', 'static bridge', 'nested function', 'nested class'])(
    'does not derive same-receiver affinity from %s', scenario => {
      const bridge = scenario === 'static bridge' ? 'static dispatch() { return [this.first(), this.second()]; }'
        : scenario === 'nested function' ? 'dispatch() { function nested() { return [this.first(), this.second()]; } return nested; }'
          : scenario === 'nested class' ? 'dispatch() { return class Nested { run() { return [this.first(), this.second()]; } }; }'
            : undefined
      const f = fixture(bridge, scenario === 'static target' ? 'static second() { return "audit"; }' : undefined)
      const independent = [f.first, scenario === 'different class' ? f.other : f.next]
      expect(sourceCoherencePriority(independent, f.candidates, undefined, f.root)).toEqual([])
    },
  )

  it.each(['duplicate owner', 'stale range', 'unadmitted bridge', 'higher-ranked value'])(
    'keeps ambiguous or unsupported discovery unchanged: %s', scenario => {
      const f = fixture()
      const independent = scenario === 'higher-ranked value' ? [f.unrelated, f.first, f.next]
        : scenario === 'stale range' ? [{ ...f.first, sourceLocation: 'L99-L99' }, f.next] : [f.first, f.next]
      const candidates = scenario === 'duplicate owner' ? [...f.candidates, { ...f.dispatch, id: 'duplicate-dispatch' }]
        : scenario === 'unadmitted bridge' ? f.candidates.filter(node => node.id !== 'dispatch') : f.candidates
      expect(sourceCoherencePriority(independent, candidates, undefined, f.root)).toEqual([])
    },
  )
})
