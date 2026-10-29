import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractJs } from '../../src/pipeline/extract.js'
import { resolveSourceSymbolRange, sourceRangeMatchesSymbol } from '../../src/runtime/retrieve/source-evidence.js'

describe('source function occurrences', () => {
  it('preserves distinct assignment/callback source owners without changing existing call targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-function-occurrences-'))
    const path = join(root, 'fixture.js')
    try {
      writeFileSync(path, [
        'function same() { return "REAL"; }',
        'function invoke() { return same(); }',
        'api.run = function run() { return "FIRST"; };',
        'api.run = () => "SECOND";',
        'exports.compile = (value) => value + 3;',
        'register(api, "property", function same() { return "CALLBACK"; });',
        'api[key] = function dynamic() { return "DYNAMIC"; };',
      ].join('\n'))
      const graph = extractJs(path)
      const occurrences = graph.nodes.filter(node => node.id.includes('__source_function_'))
      expect(occurrences.map(node => node.label)).toEqual(['api.run()', 'api.run()', 'exports.compile()', 'same()'])
      expect(new Set(occurrences.map(node => node.id)).size).toBe(4)
      const ids = new Set(occurrences.map(node => node.id))
      expect(graph.edges.filter(edge => ids.has(edge.source) || ids.has(edge.target)).every(edge => edge.relation === 'contains')).toBe(true)
      expect(graph.edges.find(edge => edge.source === 'fixture_invoke' && edge.relation === 'calls')?.target).toBe('fixture_same')
      expect(occurrences[0]?.snippet).toBe('api.run = function run() { return "FIRST"; }')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('requires current qualified source syntax and refuses ambiguous or invalid occurrences', () => {
    const matches = (source: string, label: string, end: number) => sourceRangeMatchesSymbol(source.split('\n'), { start: 1, end }, label, 'fixture.js')
    expect(matches('api.run = function run() {\n return 1;\n};', 'api.run()', 3)).toBe(true)
    expect(matches('function run() {\n return 2;\n}', 'api.run()', 3)).toBe(false)
    expect(matches('register(api, "value", function inspect() {\n return 1;\n});', 'api.inspect()', 3)).toBe(false)
    expect(matches('api.left = () => 1; api.right = () => 2;', 'api.left()', 1)).toBe(false)
    expect(matches('api.run = function run( {\n return 1;\n', 'api.run()', 1)).toBe(false)
    expect(matches('function ordinary() { register({}, "x", function nested() { return 1; }); }', 'ordinary()', 1)).toBe(true)
  })

  it('does not expand old point ranges to an arbitrary same-start occurrence', () => {
    const source = 'api.run = () => { api.run = () => {\n return 1;\n};\n return 2;\n};'.split('\n')
    expect(sourceRangeMatchesSymbol(source, { start: 1, end: 1 }, 'api.run()', 'fixture.js')).toBe(false)
    expect(resolveSourceSymbolRange(source, { start: 1, end: 1 }, 'api.run()', 'fixture.js')).toBeNull()
    expect(resolveSourceSymbolRange(source, { start: 1, end: 5 }, 'api.run()', 'fixture.js')).toEqual({ start: 1, end: 5 })
    expect(resolveSourceSymbolRange(source, { start: 1, end: 3 }, 'api.run()', 'fixture.js')).toEqual({ start: 1, end: 3 })
    const nested = 'register({}, "x", function same() { function same() { return 1; }\n return 2;\n});'.split('\n')
    expect(resolveSourceSymbolRange(nested, { start: 1, end: 1 }, 'same()', 'fixture.js')).toEqual({ start: 1, end: 1 })
    const reverse = "register({}, 'x', function same() { return 1; }); function same() {\n return 2;\n}".split('\n')
    expect(resolveSourceSymbolRange(reverse, { start: 1, end: 1 }, 'same()', 'fixture.js')).toBeNull()
    const unique = "register({}, 'x', function one() { return 1; });".split('\n')
    expect(resolveSourceSymbolRange(unique, { start: 1, end: 1 }, 'one()', 'fixture.js')).toEqual({ start: 1, end: 1 })
  })

  it('recovers unambiguous IIFE declarations as source owners only', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-iife-owner-'))
    const path = join(root, 'ordinary.cjs')
    const source = "var Wrapper = (function () {\n  function InnerThing(value) {\n    return value;\n  }\n  return InnerThing;\n}());\nfunction ExistingOwner() { return 3; }\n"
    try {
      writeFileSync(path, source)
      const graph = extractJs(path)
      const owners = graph.nodes.filter(node => node.label === 'InnerThing()')
      expect(owners).toHaveLength(1)
      const owner = owners[0]!
      expect(owner.source_location).toBe('L2-L4')
      expect(owner.snippet).toBe('function InnerThing(value) {\n    return value;\n  }')
      expect(sourceRangeMatchesSymbol(source.split('\n'), { start: 2, end: 4 }, owner.label, path)).toBe(true)
      expect(resolveSourceSymbolRange(source.split('\n'), { start: 2, end: 4 }, owner.label, path)).toEqual({ start: 2, end: 4 })
      const incident = graph.edges.filter(edge => edge.source === owner.id || edge.target === owner.id)
      expect(incident).toHaveLength(1)
      expect(incident[0]).toMatchObject({ target: owner.id, relation: 'contains' })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('withholds ambiguous IIFE owners and preserves existing declaration identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-iife-ambiguity-'))
    const path = join(root, 'ambiguity.cjs')
    try {
      writeFileSync(path, "var Single = (function () { function Single() {}\n  return Single;\n}());\nvar First = (function () { function Repeat() {} return Repeat; }()); var Second = (function () { function Repeat() {} return Repeat; }());\nfunction Same() { return 0; } var Left = (function () { function Same() { return 1; } return Same; }()); var Right = (function () { function Same() { return 2; } return Same; }());\nfunction ExistingOwner() { return 3; }\nvar Box = (function () { function Collision() {} return Collision; }()); obj.Collision = function () {};\n\nfunction Outer() {\n return (function () { function\n Inner() { return 4; }\n return Inner; })();\n}\n")
      const graph = extractJs(path)
      expect(graph.nodes.filter(node => node.id.includes('__source_function_') && node.label === 'Same()')).toHaveLength(0)
      expect(graph.nodes.filter(node => ['Single()', 'Repeat()', 'Collision()'].includes(node.label))).toHaveLength(0)
      for (const label of ['Same()', 'ExistingOwner()', 'obj.Collision()', 'Inner()']) {
        expect(graph.nodes.filter(node => node.label === label)).toHaveLength(1)
      }
      expect(graph.nodes.find(node => node.label === 'Inner()')?.id).not.toContain('__source_function_')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
