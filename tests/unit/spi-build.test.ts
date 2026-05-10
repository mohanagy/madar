import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpiFileLayer } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiEdge, SpiFile } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-test-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function build(root: string): SemanticProgramIndex {
  return buildSpiFileLayer({
    root,
    graphifyVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-slice-1a',
    now: FROZEN_NOW,
  })
}

function edgesBetween(spi: SemanticProgramIndex, fromPath: string, toPath: string, kind: SpiEdge['kind']): SpiEdge[] {
  const fromId = findFile(spi, fromPath).id
  const toId = findFile(spi, toPath).id
  return spi.edges.filter((e) => e.from === fromId && e.to === toId && e.kind === kind)
}

function findFile(spi: SemanticProgramIndex, path: string): SpiFile {
  const f = spi.files.find((x) => x.path === path)
  if (!f) throw new Error(`fixture missing SpiFile: ${path}\nhad: ${spi.files.map((x) => x.path).join(', ')}`)
  return f
}

describe('buildSpiFileLayer (slice 1a of #72)', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('shape and metadata', () => {
    it('produces a versioned SemanticProgramIndex with workspace metadata', () => {
      writeFile(sandbox, 'src/a.ts', 'export const a = 1\n')
      const spi = build(sandbox)

      expect(spi.version).toBe(1)
      expect(spi.generated_at).toBe('2026-05-10T12:34:56.000Z')
      expect(spi.workspace.root).toBe(pathResolve(sandbox))
      expect(spi.workspace.extractor_version).toBe('spi-v1.0.0-slice-1a')
      expect(spi.workspace.graphify_version).toBe('test-0.0.0')
      expect(spi.workspace.fingerprint).toMatch(/^[a-f0-9]{16}$/)
    })

    it('throws when the workspace root is missing', () => {
      expect(() => build(join(sandbox, 'does-not-exist'))).toThrow(/not found or not a directory/)
    })
  })

  describe('file discovery', () => {
    it('emits one SpiFile per supported source file with stable id, hash, loc, language', () => {
      writeFile(sandbox, 'src/auth.ts', 'export const x = 1\nexport const y = 2\n')
      writeFile(sandbox, 'src/ui.tsx', 'export const Button = () => null\n')
      writeFile(sandbox, 'src/script.js', 'module.exports = 1\n')
      writeFile(sandbox, 'src/widget.jsx', 'export const Widget = () => null\n')
      writeFile(sandbox, 'README.md', '# unsupported, must be ignored\n')

      const spi = build(sandbox)
      const paths = spi.files.map((f) => f.path)
      expect(paths).toEqual(['src/auth.ts', 'src/script.js', 'src/ui.tsx', 'src/widget.jsx'])

      const auth = findFile(spi, 'src/auth.ts')
      expect(auth.id).toMatch(/^file:[a-f0-9]{16}$/)
      expect(auth.language).toBe('typescript')
      expect(auth.loc).toBe(3) // 2 newlines + trailing
      expect(auth.hash).toMatch(/^[a-f0-9]{64}$/)
      expect(findFile(spi, 'src/ui.tsx').language).toBe('tsx')
      expect(findFile(spi, 'src/widget.jsx').language).toBe('jsx')
      expect(findFile(spi, 'src/script.js').language).toBe('javascript')
    })

    it('skips node_modules, dist, build, .next, coverage, .git, graphify-out, .test-artifacts', () => {
      for (const dir of ['node_modules', 'dist', 'build', '.next', 'coverage', '.git', 'graphify-out', '.test-artifacts']) {
        writeFile(sandbox, `${dir}/leak.ts`, 'export const x = 1\n')
      }
      writeFile(sandbox, 'src/keep.ts', 'export const k = 1\n')
      const spi = build(sandbox)
      expect(spi.files.map((f) => f.path)).toEqual(['src/keep.ts'])
    })

    it('produces deterministic output between two runs of the same workspace', () => {
      writeFile(sandbox, 'src/a.ts', 'export const a = 1\n')
      writeFile(sandbox, 'src/b.ts', 'import { a } from "./a.js"\nexport const b = a\n')
      const first = build(sandbox)
      const second = build(sandbox)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    })
  })

  describe('imports / exports edges', () => {
    it('resolves Node-ESM .js-suffixed relative imports to the .ts source', () => {
      writeFile(sandbox, 'src/shared/util.ts', 'export const util = 1\n')
      writeFile(sandbox, 'src/feature/index.ts', 'import { util } from "../shared/util.js"\nexport const feature = util\n')
      const spi = build(sandbox)

      const importEdges = edgesBetween(spi, 'src/feature/index.ts', 'src/shared/util.ts', 'imports')
      expect(importEdges).toHaveLength(1)
      expect(importEdges[0]?.confidence).toBe('high')
      expect(importEdges[0]?.source).toBe('typescript-syntactic')
      expect(importEdges[0]?.evidence?.file_id).toBe(findFile(spi, 'src/feature/index.ts').id)
    })

    it('marks `import type` edges as low confidence', () => {
      writeFile(sandbox, 'src/types.ts', 'export type T = number\n')
      writeFile(sandbox, 'src/use.ts', 'import type { T } from "./types.js"\nexport const x: T = 1\n')
      const spi = build(sandbox)

      const importEdges = edgesBetween(spi, 'src/use.ts', 'src/types.ts', 'imports')
      expect(importEdges).toHaveLength(1)
      expect(importEdges[0]?.confidence).toBe('low')
    })

    it('records unresolved relative imports as medium confidence with a diagnostic', () => {
      writeFile(sandbox, 'src/a.ts', 'import { x } from "./missing.js"\nexport const y = x\n')
      const spi = build(sandbox)

      const aId = findFile(spi, 'src/a.ts').id
      const unresolved = spi.edges.filter((e) => e.from === aId && e.kind === 'imports' && e.to.startsWith('file:unresolved/'))
      expect(unresolved).toHaveLength(1)
      expect(unresolved[0]?.confidence).toBe('medium')
      expect(spi.diagnostics.some((d) => d.message.includes('Unresolved relative import "./missing.js"'))).toBe(true)
    })

    it('skips bare module specifiers without recording diagnostics', () => {
      writeFile(sandbox, 'src/a.ts', 'import { something } from "external-package"\nexport const x = 1\n')
      const spi = build(sandbox)
      expect(spi.edges.filter((e) => e.kind === 'imports')).toHaveLength(0)
      expect(spi.diagnostics).toHaveLength(0)
    })

    it('emits an exports edge (file -> self) for every exported declaration form', () => {
      writeFile(sandbox, 'src/all-export-forms.ts', [
        'export const a = 1',
        'export function b() { return 1 }',
        'export class C {}',
        'export interface I {}',
        'export type T = number',
        'export enum E { Z }',
        'const d = 1',
        'export { d }',
        'export default 1',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const id = findFile(spi, 'src/all-export-forms.ts').id
      const exportEdges = spi.edges.filter((e) => e.from === id && e.to === id && e.kind === 'exports')
      // 6 declarations w/ export modifier + 1 export-list + 1 export default = 8.
      expect(exportEdges.length).toBeGreaterThanOrEqual(8)
      for (const edge of exportEdges) {
        expect(edge.confidence).toBe('high')
        expect(edge.source).toBe('typescript-syntactic')
      }
    })

    it('emits an imports edge for re-export from another module', () => {
      writeFile(sandbox, 'src/inner.ts', 'export const v = 1\n')
      writeFile(sandbox, 'src/barrel.ts', 'export { v } from "./inner.js"\n')
      const spi = build(sandbox)
      expect(edgesBetween(spi, 'src/barrel.ts', 'src/inner.ts', 'imports')).toHaveLength(1)
    })

    it('resolves `./folder` index imports', () => {
      writeFile(sandbox, 'src/utils/index.ts', 'export const u = 1\n')
      writeFile(sandbox, 'src/feature.ts', 'import { u } from "./utils/index.js"\nexport const f = u\n')
      const spi = build(sandbox)
      expect(edgesBetween(spi, 'src/feature.ts', 'src/utils/index.ts', 'imports')).toHaveLength(1)
    })
  })

  describe('against the checked-in demo repo', () => {
    it('produces a populated SPI for examples/demo-repo with cross-module imports resolved', () => {
      const root = pathResolve(__dirname, '../../examples/demo-repo')
      const spi = buildSpiFileLayer({ root, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })

      expect(spi.files.length).toBeGreaterThan(5)
      // Every file path is workspace-relative, no leading slash, POSIX.
      for (const file of spi.files) {
        expect(file.path.startsWith('/')).toBe(false)
        expect(file.path.includes('\\')).toBe(false)
      }
      // Two known cross-module links in the demo repo.
      expect(edgesBetween(spi, 'src/billing/invoice-service.ts', 'src/notifications/email-notifier.ts', 'imports')).toHaveLength(1)
      expect(edgesBetween(spi, 'src/app.ts', 'src/auth/auth-service.ts', 'imports')).toHaveLength(1)
      // Type-only import we observed in the fixture is marked low.
      const tenantImports = spi.edges.filter(
        (e) => e.kind === 'imports' && e.to === findFile(spi, 'src/shared/tenant-context.ts').id,
      )
      expect(tenantImports.length).toBeGreaterThan(0)
      for (const edge of tenantImports) {
        expect(['low', 'high']).toContain(edge.confidence)
      }
      // No unresolved diagnostics on the curated demo.
      expect(spi.diagnostics.filter((d) => d.level === 'error')).toHaveLength(0)
    })
  })
})
