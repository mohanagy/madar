import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-react-router-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function build(root: string): SemanticProgramIndex {
  return buildSpi({
    root,
    sadeemVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-slice-1c-v.a',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('SPI React Router framework detector (slice 1c-v.a)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('router factory detection', () => {
    it('tags `const router = createBrowserRouter([])` with react_router_router', () => {
      writeFile(sandbox, 'src/router.ts', [
        'import { createBrowserRouter } from "react-router-dom"',
        'export const router = createBrowserRouter([])',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/router.ts', 'router')
      expect(sym?.framework_role).toBe('react_router_router')
    })

    it('recognizes createHashRouter, createMemoryRouter, createStaticRouter', () => {
      writeFile(sandbox, 'src/hash.ts', [
        'import { createHashRouter } from "react-router-dom"',
        'export const router = createHashRouter([])',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/memory.ts', [
        'import { createMemoryRouter } from "react-router-dom"',
        'export const router = createMemoryRouter([])',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/static.ts', [
        'import { createStaticRouter } from "react-router-dom"',
        'export const router = createStaticRouter([])',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/hash.ts', 'router')?.framework_role).toBe('react_router_router')
      expect(findSymbol(spi, 'src/memory.ts', 'router')?.framework_role).toBe('react_router_router')
      expect(findSymbol(spi, 'src/static.ts', 'router')?.framework_role).toBe('react_router_router')
    })

    it('works for imports from `react-router` (not just react-router-dom)', () => {
      writeFile(sandbox, 'src/router.ts', [
        'import { createBrowserRouter } from "react-router"',
        'export const router = createBrowserRouter([])',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/router.ts', 'router')
      expect(sym?.framework_role).toBe('react_router_router')
    })

    it('handles aliased imports (`createBrowserRouter as createRouter`)', () => {
      writeFile(sandbox, 'src/router.ts', [
        'import { createBrowserRouter as createRouter } from "react-router-dom"',
        'export const router = createRouter([])',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/router.ts', 'router')
      expect(sym?.framework_role).toBe('react_router_router')
    })

    it('does NOT tag when the factory comes from an unrelated module', () => {
      writeFile(sandbox, 'src/router.ts', [
        'function createBrowserRouter(_: unknown[]): unknown { return null }',
        'export const router = createBrowserRouter([])',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/router.ts', 'router')
      expect(sym?.framework_role).toBeUndefined()
    })
  })

  describe('loader / action route-module exports', () => {
    it('tags `export function loader()` as react_router_loader', () => {
      writeFile(sandbox, 'src/routes/users.tsx', [
        'import { useLoaderData } from "react-router-dom"',
        'export function loader(): { ok: boolean } { return { ok: true } }',
        'export default function Users(): null { void useLoaderData; return null }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/routes/users.tsx', 'loader')?.framework_role).toBe('react_router_loader')
    })

    it('tags `export const loader = () => ...` (variable form)', () => {
      writeFile(sandbox, 'src/routes/users.tsx', [
        'import { useLoaderData } from "react-router-dom"',
        'export const loader = (): { ok: boolean } => ({ ok: true })',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/routes/users.tsx', 'loader')?.framework_role).toBe('react_router_loader')
    })

    it('tags `export function action()` as react_router_action', () => {
      writeFile(sandbox, 'src/routes/users.tsx', [
        'import { useActionData } from "react-router-dom"',
        'export function action(): { ok: boolean } { return { ok: true } }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/routes/users.tsx', 'action')?.framework_role).toBe('react_router_action')
    })

    it('does NOT tag loader/action in files that do not import react-router(-dom)', () => {
      writeFile(sandbox, 'src/utils/loader.ts', [
        'export function loader(): void {}',
        'export const action = (): void => {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/utils/loader.ts', 'loader')?.framework_role).toBeUndefined()
      expect(findSymbol(spi, 'src/utils/loader.ts', 'action')?.framework_role).toBeUndefined()
    })

    it('only tags the exact names `loader` and `action`, not similarly-named exports', () => {
      writeFile(sandbox, 'src/routes/users.tsx', [
        'import { useLoaderData } from "react-router-dom"',
        'export function loaderHelper(): void {}',
        'export const myAction = (): void => {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/routes/users.tsx', 'loaderHelper')?.framework_role).toBeUndefined()
      expect(findSymbol(spi, 'src/routes/users.tsx', 'myAction')?.framework_role).toBeUndefined()
    })
  })

  describe('projector — framework propagation', () => {
    it('projects react_router_router → framework: react-router, node_kind: router', async () => {
      writeFile(sandbox, 'src/router.ts', [
        'import { createBrowserRouter } from "react-router-dom"',
        'export const router = createBrowserRouter([])',
      ].join('\n') + '\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'router')
      expect(node?.framework).toBe('react-router')
      expect(node?.framework_role).toBe('react_router_router')
      expect(node?.node_kind).toBe('router')
    })

    it('projects loader/action → framework: react-router, node_kind: function', async () => {
      writeFile(sandbox, 'src/routes/users.tsx', [
        'import { useLoaderData } from "react-router-dom"',
        'export function loader(): { ok: boolean } { return { ok: true } }',
        'export function action(): { ok: boolean } { return { ok: true } }',
      ].join('\n') + '\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const loader = extraction.nodes.find((n) => n.label === 'loader()')
      const action = extraction.nodes.find((n) => n.label === 'action()')
      expect(loader?.framework).toBe('react-router')
      expect(loader?.framework_role).toBe('react_router_loader')
      expect(loader?.node_kind).toBe('function')
      expect(action?.framework).toBe('react-router')
      expect(action?.framework_role).toBe('react_router_action')
    })
  })
})
