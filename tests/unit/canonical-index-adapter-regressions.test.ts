import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'

const sandboxes: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
})

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-canonical-regression-'))
  sandboxes.push(root)
  return root
}

function write(root: string, path: string, source: string): string {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, source, 'utf8')
  return absolute
}

describe('canonical TypeScript adapter regressions', () => {
  it('resolves scanner-relative paths against root and excludes omitted in-root sources', () => {
    const root = sandbox()
    write(root, 'tsconfig.json', '{ "compilerOptions": { "resolveJsonModule": true }, "include": ["src/**/*"] }')
    write(root, 'src/included.ts', 'import { omitted } from "./omitted"\nimport "./hidden.mts"\nimport secret from "./secret.json"\nexport function included() { omitted(); return secret }\n')
    const omitted = write(root, 'src/omitted.ts', 'export function omitted() {}\n')
    const hidden = write(root, 'src/hidden.mts', 'throw new Error("must not read")\n')
    const secret = write(root, 'src/secret.json', '{ "token": "must-not-read" }\n')
    const readFile = vi.spyOn(ts.sys, 'readFile')

    const result = buildCanonicalTypeScriptIndex({ root, files: ['src/included.ts'] })

    expect(readFile.mock.calls.map(([path]) => resolve(path))).not.toContain(resolve(omitted))
    expect(readFile.mock.calls.map(([path]) => resolve(path))).not.toContain(resolve(hidden))
    expect(readFile.mock.calls.map(([path]) => resolve(path))).not.toContain(resolve(secret))
    readFile.mockRestore()
    expect(result.files.map((file) => file.path)).toEqual(['src/included.ts'])
    expect(result.graph.nodeEntries().map(([, fact]) => fact.source_file)).not.toContain('src/omitted.ts')
    expect(result.graph.edgeEntries().map(([, , fact]) => fact.source_file)).not.toContain('src/omitted.ts')
  })

  it('coalesces overloads and merged declarations into stable code units', () => {
    const root = sandbox()
    const file = write(root, 'src/merged.ts', [
      'export function convert(value: string): string',
      'export function convert(value: number): number',
      'export function convert(value: unknown) { return value }',
      'export class Box {',
      '  get(value: string): string',
      '  get(value: unknown) { return value }',
      '}',
      'export interface Shape { width: number }',
      'export interface Shape { height: number }',
    ].join('\n'))

    const result = buildCanonicalTypeScriptIndex({ root, files: [file] })
    const facts = result.graph.nodeEntries().map(([, fact]) => fact)
    const nodes = new Map(result.graph.nodeEntries())
    const boxMemberRelations = result.graph.edgeEntries()
      .filter(([from, to]) => nodes.get(from)?.label === 'Box' && nodes.get(to)?.label === '.get()')
      .map(([, , fact]) => fact.relation)

    expect(facts.filter((fact) => fact.label === 'convert()')).toHaveLength(1)
    expect(facts.filter((fact) => fact.label === '.get()')).toHaveLength(1)
    expect(facts.filter((fact) => fact.label === 'Shape')).toHaveLength(1)
    expect(facts.find((fact) => fact.label === 'convert()')).toMatchObject({ line_number: 1, end_line_number: 3 })
    expect(boxMemberRelations).toEqual(expect.arrayContaining(['contains', 'method']))
  })

  it('records local aliases, anonymous defaults, and direct CommonJS exports', () => {
    const root = sandbox()
    const files = [
      write(root, 'src/alias.ts', 'const internal = () => 1\nexport { internal as publicValue }\n'),
      write(root, 'src/default-function.ts', 'export default function () { return 1 }\n'),
      write(root, 'src/default-class.ts', 'export default class { run() {} }\n'),
      write(root, 'src/direct.cjs.js', 'module.exports.handler = function () {}\nexports.Worker = class { run() {} }\n'),
    ]

    const result = buildCanonicalTypeScriptIndex({ root, files })
    const facts = result.graph.nodeEntries().map(([, fact]) => fact)

    expect(facts.find((fact) => fact.label === 'internal')).toMatchObject({ exported: true, export_aliases: ['publicValue'] })
    expect(facts.find((fact) => fact.source_file === 'src/default-function.ts' && fact.label === 'default()')).toMatchObject({ exported: true })
    expect(facts.find((fact) => fact.source_file === 'src/default-class.ts' && fact.label === 'default')).toMatchObject({ exported: true })
    expect(facts.find((fact) => fact.source_file === 'src/direct.cjs.js' && fact.label === 'handler()')).toMatchObject({ exported: true })
    expect(facts.find((fact) => fact.source_file === 'src/direct.cjs.js' && fact.label === 'Worker')).toMatchObject({ exported: true })
  })

  it('reports compiler/config diagnostics with source evidence without promoting info receipts', () => {
    const root = sandbox()
    write(root, 'tsconfig.json', '{ "compilerOptions": { "target": "not-a-target" } }')
    const source = write(root, 'src/broken.ts', 'export const = 1\n')
    const result = buildCanonicalTypeScriptIndex({ root, files: [source] })
    const copiedRoot = sandbox()
    write(copiedRoot, 'tsconfig.json', '{ "compilerOptions": { "target": "not-a-target" } }')
    const copiedSource = write(copiedRoot, 'src/broken.ts', 'export const = 1\n')
    const copied = buildCanonicalTypeScriptIndex({ root: copiedRoot, files: [copiedSource] })
    const file = result.files[0]

    expect(copied.diagnostics.map(({ id, level }) => ({ id, level })))
      .toEqual(result.diagnostics.map(({ id, level }) => ({ id, level })))
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining('.config.'), level: 'error' }),
      expect.objectContaining({ id: expect.stringContaining('.compiler.'), level: 'error', evidence: { file_id: file?.id, range: expect.any(Object) } }),
    ]))

    if (!file) throw new Error('expected indexed fixture file')
  })

  it('keeps overloaded Nest routes and Bull job edges on coalesced method symbols', () => {
    const root = sandbox()
    write(root, 'tsconfig.json', '{ "compilerOptions": { "experimentalDecorators": true } }')
    const source = write(root, 'src/nest.ts', [
      'import { Controller, Get } from "@nestjs/common"',
      'declare function Processor(name: string): ClassDecorator',
      'declare function Process(name: string): MethodDecorator',
      'class Queue { add(name: string): void {} }',
      '@Controller("items")',
      'export class ItemsController {',
      '  list(id: string): string',
      '  @Get(":id") list(id: unknown) { return String(id) }',
      '}',
      '@Processor("emails")',
      'export class EmailWorker {',
      '  handle(job: string): void',
      '  @Process("send") handle(job: unknown) {}',
      '}',
      'export class Producer {',
      '  constructor(private queue: Queue) {}',
      '  send(id: string): void',
      '  send(id: unknown) { this.queue.add("emails.send") }',
      '}',
    ].join('\n'))
    const result = buildCanonicalTypeScriptIndex({ root, files: [source] })
    const nodes = new Map(result.graph.nodeEntries())
    const edges = result.graph.edgeEntries().map(([from, to, fact]) => ({
      relation: fact.relation,
      from: nodes.get(from)?.label,
      to: nodes.get(to)?.label,
    }))

    expect(edges).toEqual(expect.arrayContaining([
      { relation: 'controller_route', from: 'ItemsController', to: '.list()' },
      { relation: 'enqueues_job', from: '.send()', to: '.handle()' },
    ]))
    expect(result.graph.edgeEntries().some(([from, to]) => from.includes('#') || to.includes('#'))).toBe(false)
  })

  it('keeps same-line calls and route registrations distinct by full source range', () => {
    const root = sandbox()
    const source = write(root, 'src/routes.ts', [
      'import express from "express"',
      'export function target() {}',
      'export function caller() { target(); target() }',
      'export const app = express()',
      'app.get("/a", target); app.get("/b", target)',
    ].join('\n'))
    const result = buildCanonicalTypeScriptIndex({ root, files: [source] })
    const nodes = new Map(result.graph.nodeEntries())
    const selected = result.graph.edgeEntries().filter(([from, to, fact]) =>
      ((nodes.get(from)?.label === 'caller()' && fact.relation === 'calls')
        || (nodes.get(from)?.label === 'app' && fact.relation === 'route_handler'))
      && nodes.get(to)?.label === 'target()')

    expect(selected.filter(([, , fact]) => fact.relation === 'calls')).toHaveLength(2)
    expect(selected.filter(([, , fact]) => fact.relation === 'route_handler')).toHaveLength(2)
    for (const [, , fact] of selected) expect(fact.evidence).toMatchObject({ range: { start: { column: expect.any(Number) } } })
  })

  it('indexes default/CJS direct exports and owns calls inside their bodies', () => {
    const root = sandbox()
    const files = [
      write(root, 'src/alias-default.ts', 'const selected = 1\nexport default selected\n'),
      write(root, 'src/default.ts', 'function helper() {}\nexport default function () { helper() }\n'),
      write(root, 'src/direct.js', 'function helper() {}\nmodule.exports = () => { helper() }\nexports.handler = function namedHandler() { helper() }\nexports.Worker = class InternalWorker { run() { helper() } }\n'),
    ]
    const result = buildCanonicalTypeScriptIndex({ root, files })
    const nodes = new Map(result.graph.nodeEntries())
    const facts = [...nodes.values()]
    const calls = result.graph.edgeEntries().filter(([, , fact]) => fact.relation === 'calls')
      .map(([from, to]) => [nodes.get(from)?.qualified_name, nodes.get(to)?.qualified_name])

    expect(facts.find((fact) => fact.qualified_name === 'selected')).toMatchObject({ exported: true, export_aliases: ['default'] })
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_file: 'src/default.ts', qualified_name: 'default', exported: true }),
      expect.objectContaining({ source_file: 'src/direct.js', qualified_name: 'default', exported: true }),
      expect.objectContaining({ source_file: 'src/direct.js', qualified_name: 'handler', exported: true }),
      expect.objectContaining({ source_file: 'src/direct.js', qualified_name: 'Worker', exported: true }),
    ]))
    expect(calls).toEqual(expect.arrayContaining([
      ['default', 'helper'],
      ['handler', 'helper'],
      ['Worker.run', 'helper'],
    ]))
  })
})
