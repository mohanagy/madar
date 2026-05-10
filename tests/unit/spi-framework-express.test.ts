import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-express-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function build(root: string): SemanticProgramIndex {
  return buildSpi({
    root,
    graphifyVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-slice-1c-ii.b',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('SPI Express framework detector (slice 1c-ii.b)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('app factory detection', () => {
    it('tags `const app = express()` with framework_role express_app via default import', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/server.ts', 'app')
      expect(sym?.framework_role).toBe('express_app')
    })

    it('tags `const app = express.default()` via named-default import', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import { default as expressFactory } from "express"',
        'export const app = expressFactory()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/server.ts', 'app')
      expect(sym?.framework_role).toBe('express_app')
    })

    it('tags `const app = e()` via namespace import alias', () => {
      writeFile(sandbox, 'src/server.ts', [
        'import * as e from "express"',
        'export const app = e.default()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/server.ts', 'app')
      expect(sym?.framework_role).toBe('express_app')
    })
  })

  describe('router factory detection', () => {
    it('tags `const router = Router()` via named import', () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import { Router } from "express"',
        'export const router = Router()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/routes.ts', 'router')
      expect(sym?.framework_role).toBe('express_router')
    })

    it('tags `const router = e.Router()` via namespace alias', () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import * as e from "express"',
        'export const router = e.Router()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/routes.ts', 'router')
      expect(sym?.framework_role).toBe('express_router')
    })
  })

  describe('non-Express files', () => {
    it('does not tag variables in files that do not import express', () => {
      writeFile(sandbox, 'src/plain.ts', [
        'function notExpress(): { use: () => void } { return { use: () => {} } }',
        'export const app = notExpress()',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/plain.ts', 'app')
      expect(sym?.framework_role).toBeUndefined()
    })

    it('does not tag variables when express is imported but not used as a factory', () => {
      writeFile(sandbox, 'src/types.ts', [
        'import type { Application } from "express"',
        'export const app: Application | null = null',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/types.ts', 'app')
      // Type-only imports skip the bindings collector entirely.
      expect(sym?.framework_role).toBeUndefined()
    })
  })

  describe('projector — framework propagation through to ExtractionNode', () => {
    it('an express_app variable surfaces with framework=express on the projected ExtractionNode', async () => {
      writeFile(sandbox, 'src/server.ts', [
        'import express from "express"',
        'export const app = express()',
      ].join('\n') + '\n')
      // Lazy-import projector to avoid pulling extraction-side deps for
      // tests that only need the SPI substrate.
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'app')
      expect(node?.framework).toBe('express')
      expect(node?.framework_role).toBe('express_app')
      expect(node?.node_kind).toBe('function')
    })

    it('an express_router variable projects with node_kind=router', async () => {
      writeFile(sandbox, 'src/routes.ts', [
        'import { Router } from "express"',
        'export const router = Router()',
      ].join('\n') + '\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'router')
      expect(node?.framework).toBe('express')
      expect(node?.framework_role).toBe('express_router')
      expect(node?.node_kind).toBe('router')
    })
  })
})
