import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildCanonicalTypeScriptIndex } from '../../src/adapters/typescript/index.js'
import {
  CANONICAL_INDEX_FIXTURE_ROOT,
  buildCanonicalFixtureFacts,
  canonicalFixtureSourceFiles,
} from '../helpers/canonical-index-gold.js'

const sandboxes: string[] = []
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true })
})

describe('canonical TypeScript index integration contract', () => {
  it('is deterministic across repeated builds and machine-independent roots', () => {
    const sourceFiles = canonicalFixtureSourceFiles()
    const first = buildCanonicalTypeScriptIndex({
      root: CANONICAL_INDEX_FIXTURE_ROOT,
      files: sourceFiles,
    })
    const second = buildCanonicalTypeScriptIndex({
      root: CANONICAL_INDEX_FIXTURE_ROOT,
      files: sourceFiles,
    })
    expect(second.graph.nodeEntries()).toEqual(first.graph.nodeEntries())
    expect(second.graph.edgeEntries()).toEqual(first.graph.edgeEntries())
    expect(second.diagnostics).toEqual(first.diagnostics)

    const reversed = buildCanonicalTypeScriptIndex({
      root: CANONICAL_INDEX_FIXTURE_ROOT,
      files: [...sourceFiles].reverse(),
    })
    expect(reversed.graph.nodeEntries()).toEqual(first.graph.nodeEntries())
    expect(reversed.graph.edgeEntries()).toEqual(first.graph.edgeEntries())
    expect(reversed.diagnostics).toEqual(first.diagnostics)

    const copiedRoot = mkdtempSync(join(tmpdir(), 'madar-canonical-gold-'))
    sandboxes.push(copiedRoot)
    cpSync(CANONICAL_INDEX_FIXTURE_ROOT, copiedRoot, { recursive: true })
    const copied = buildCanonicalTypeScriptIndex({ root: copiedRoot, files: canonicalFixtureSourceFiles(copiedRoot) })
    expect(copied.graph.nodeEntries()).toEqual(first.graph.nodeEntries())
    expect(copied.graph.edgeEntries()).toEqual(first.graph.edgeEntries())
    expect(copied.diagnostics).toEqual(first.diagnostics)
  })

  it('does not emit transitive imports outside the scanner-owned explicit source set', () => {
    const onlyService = join(CANONICAL_INDEX_FIXTURE_ROOT, 'core/service.ts')
    const omittedContracts = resolve(CANONICAL_INDEX_FIXTURE_ROOT, 'core/contracts.ts').replaceAll('\\', '/')
    const readFileSpy = vi.spyOn(ts.sys, 'readFile')
    const { result, compilerReads } = (() => {
      try {
        const result = buildCanonicalTypeScriptIndex({ root: CANONICAL_INDEX_FIXTURE_ROOT, files: [onlyService] })
        const compilerReads = readFileSpy.mock.calls
          .map(([path]) => resolve(String(path)).replaceAll('\\', '/'))
        return { result, compilerReads }
      } finally {
        readFileSpy.mockRestore()
      }
    })()
    const sourceFiles = new Set(result.graph.nodeEntries().map(([, attributes]) => attributes.source_file))

    expect(result.files.map((file) => file.path)).toEqual(['core/service.ts'])
    expect(sourceFiles).toEqual(new Set(['core/service.ts']))
    expect(compilerReads).not.toContain(omittedContracts)
    expect(result.graph.nodeEntries()).not.toEqual(expect.arrayContaining([
      expect.arrayContaining([expect.any(String), expect.objectContaining({ source_file: 'core/contracts.ts' })]),
    ]))
  })

  it('does not read imported program source outside the indexed root', () => {
    const repository = mkdtempSync(join(tmpdir(), 'madar-canonical-boundary-'))
    sandboxes.push(repository)
    const root = join(repository, 'packages/app')
    const entry = join(root, 'main.ts')
    const sibling = join(repository, 'packages/shared/value.ts')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(repository, 'packages/shared'), { recursive: true })
    writeFileSync(entry, "import { value } from '../shared/value.js'\nexport const result = value\n")
    writeFileSync(sibling, 'export const value = 1\n')

    const readFileSpy = vi.spyOn(ts.sys, 'readFile')
    const first = buildCanonicalTypeScriptIndex({ root, files: [entry] })
    const compilerReads = readFileSpy.mock.calls.map(([path]) => resolve(String(path)).replaceAll('\\', '/'))
    readFileSpy.mockRestore()
    writeFileSync(sibling, 'this is invalid TypeScript }\n')
    const second = buildCanonicalTypeScriptIndex({ root, files: [entry] })

    expect(first.files.map((file) => file.path)).toEqual(['main.ts'])
    expect(compilerReads).not.toContain(resolve(sibling).replaceAll('\\', '/'))
    expect(second.graph.nodeEntries()).toEqual(first.graph.nodeEntries())
    expect(second.graph.edgeEntries()).toEqual(first.graph.edgeEntries())
    expect(second.diagnostics).toEqual(first.diagnostics)
  })

  it('indexes source-backed project references without requiring declaration outputs', () => {
    const rootConfig = JSON.parse(
      readFileSync(join(CANONICAL_INDEX_FIXTURE_ROOT, 'tsconfig.json'), 'utf8'),
    ) as { files?: unknown[]; references?: Array<{ path?: string }> }
    const appConfig = JSON.parse(
      readFileSync(join(CANONICAL_INDEX_FIXTURE_ROOT, 'packages/app/tsconfig.json'), 'utf8'),
    ) as { extends?: string; references?: Array<{ path?: string }> }

    expect(rootConfig.files).toEqual([])
    expect(rootConfig.references?.map((reference) => reference.path)).toEqual([
      './packages/shared',
      './packages/app',
    ])
    expect(appConfig).toMatchObject({
      extends: '../../tsconfig.base.json',
      references: [{ path: '../shared' }],
    })
    expect(existsSync(join(CANONICAL_INDEX_FIXTURE_ROOT, 'packages/shared/dist'))).toBe(false)

    const facts = buildCanonicalFixtureFacts()
    expect(facts.diagnostics).toEqual([])
    expect(facts.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_file: 'packages/app/src/use-shared.ts',
        from_name: 'sharedId',
        relation: 'param_type',
        to_file: 'packages/shared/src/model.ts',
        to_name: 'SharedModel',
      }),
    ]))
  })

  it('writes canonical graph facts directly with index provenance and no legacy markers', () => {
    const result = buildCanonicalTypeScriptIndex({
      root: CANONICAL_INDEX_FIXTURE_ROOT,
      files: canonicalFixtureSourceFiles(),
    })
    expect(result.graph.graph.canonical_typescript_index).toBe(true)
    for (const [, attributes] of result.graph.nodeEntries()) {
      expect(attributes).not.toHaveProperty('extraction_strategy')
      expect(String(attributes.source_file)).not.toMatch(/^\//)
      expect(attributes.provenance).toEqual(expect.arrayContaining([
        expect.objectContaining({ capability_id: 'builtin:index:typescript', stage: 'index' }),
      ]))
    }
    for (const [, , attributes] of result.graph.edgeEntries()) {
      expect(attributes).not.toHaveProperty('extraction_strategy')
      expect(attributes.provenance).toEqual(expect.arrayContaining([
        expect.objectContaining({ capability_id: 'builtin:index:typescript', stage: 'index' }),
      ]))
    }
  })

  it('contains one compiler construction and no SPI, legacy, fixture, or repository-specific imports', () => {
    const adapterDir = 'src/adapters/typescript'
    const files = readdirSync(adapterDir)
      .filter((file) => extname(file) === '.ts')
      .map((file) => join(adapterDir, file))
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n')

    expect(source.match(/ts\.createProgram\s*\(/g)).toHaveLength(1)
    expect(source).not.toMatch(/pipeline\/spi|pipeline\/extract|contracts\/extraction|contracts\/types/)
    expect(source).not.toMatch(/tests\/fixtures|UsersController|express-positive/)
  })

  it('keeps normalized gold facts stable as a developer-readable diagnostic surface', () => {
    const facts = buildCanonicalFixtureFacts()
    expect(facts.diagnostics).toEqual([])
    expect(facts.nodes.length).toBeGreaterThan(40)
    expect(facts.edges.length).toBeGreaterThan(40)
  })
})
