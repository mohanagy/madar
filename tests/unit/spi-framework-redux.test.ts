import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-redux-tests-'))
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
    extractorVersion: 'spi-v1.0.0-slice-1c-vi.a',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('SPI Redux Toolkit framework detector (slice 1c-vi.a)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('factory detection', () => {
    it('tags createSlice result with redux_slice', () => {
      writeFile(sandbox, 'src/counter.ts', [
        'import { createSlice } from "@reduxjs/toolkit"',
        'export const counterSlice = createSlice({ name: "counter", initialState: 0, reducers: {} })',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/counter.ts', 'counterSlice')?.framework_role).toBe('redux_slice')
    })

    it('tags configureStore result with redux_store', () => {
      writeFile(sandbox, 'src/store.ts', [
        'import { configureStore } from "@reduxjs/toolkit"',
        'export const store = configureStore({ reducer: {} })',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/store.ts', 'store')?.framework_role).toBe('redux_store')
    })

    it('tags legacy `createStore` from redux with redux_store too', () => {
      writeFile(sandbox, 'src/store.ts', [
        'import { createStore } from "redux"',
        'export const store = createStore((s: number) => s)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/store.ts', 'store')?.framework_role).toBe('redux_store')
    })

    it('tags createSelector / createDraftSafeSelector with redux_selector', () => {
      writeFile(sandbox, 'src/selectors.ts', [
        'import { createSelector, createDraftSafeSelector } from "@reduxjs/toolkit"',
        'export const selectFoo = createSelector(() => 1, (n: number) => n + 1)',
        'export const selectBar = createDraftSafeSelector(() => 2, (n: number) => n)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/selectors.ts', 'selectFoo')?.framework_role).toBe('redux_selector')
      expect(findSymbol(spi, 'src/selectors.ts', 'selectBar')?.framework_role).toBe('redux_selector')
    })

    it('tags createAsyncThunk result with redux_async_thunk', () => {
      writeFile(sandbox, 'src/thunks.ts', [
        'import { createAsyncThunk } from "@reduxjs/toolkit"',
        'export const fetchUser = createAsyncThunk("user/fetch", async () => ({ ok: true }))',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/thunks.ts', 'fetchUser')?.framework_role).toBe('redux_async_thunk')
    })

    it('tags createApi (RTK Query) result with redux_rtk_query_api', () => {
      writeFile(sandbox, 'src/api.ts', [
        'import { createApi } from "@reduxjs/toolkit/query/react"',
        'export const usersApi = createApi({ reducerPath: "users", baseQuery: () => ({ data: 1 }), endpoints: () => ({}) } as any)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/api.ts', 'usersApi')?.framework_role).toBe('redux_rtk_query_api')
    })

    it('accepts createSelector from the standalone `reselect` package', () => {
      writeFile(sandbox, 'src/selectors.ts', [
        'import { createSelector } from "reselect"',
        'export const selectFoo = createSelector(() => 1, (n: number) => n + 1)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/selectors.ts', 'selectFoo')?.framework_role).toBe('redux_selector')
    })

    it('handles aliased imports (`createSlice as makeSlice`)', () => {
      writeFile(sandbox, 'src/counter.ts', [
        'import { createSlice as makeSlice } from "@reduxjs/toolkit"',
        'export const slice = makeSlice({ name: "x", initialState: 0, reducers: {} })',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/counter.ts', 'slice')?.framework_role).toBe('redux_slice')
    })
  })

  describe('negative cases', () => {
    it('does not tag when the factory is a local function in an unrelated module', () => {
      writeFile(sandbox, 'src/fake.ts', [
        'function createSlice<T>(_: T): T { return _ }',
        'export const x = createSlice({ name: "y" } as any)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/fake.ts', 'x')?.framework_role).toBeUndefined()
    })

    it('does not tag when the file imports from Redux but the variable initializer is unrelated', () => {
      writeFile(sandbox, 'src/store.ts', [
        'import { configureStore } from "@reduxjs/toolkit"',
        'export const config = { reducer: {} }',
        'export const store = configureStore(config)',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/store.ts', 'config')?.framework_role).toBeUndefined()
      expect(findSymbol(spi, 'src/store.ts', 'store')?.framework_role).toBe('redux_store')
    })

    it('does not tag property-access factory variants (api.injectEndpoints(...) etc.)', () => {
      writeFile(sandbox, 'src/api.ts', [
        'import { createApi } from "@reduxjs/toolkit/query/react"',
        'export const api = createApi({ reducerPath: "x", baseQuery: () => ({ data: 1 }), endpoints: () => ({}) } as any)',
        'export const enhanced = api.injectEndpoints({ endpoints: () => ({}) })',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/api.ts', 'api')?.framework_role).toBe('redux_rtk_query_api')
      // injectEndpoints is a derivation off `api`, not a new factory call.
      // Slice 1c-vi.a leaves it untagged; a future slice may extend.
      expect(findSymbol(spi, 'src/api.ts', 'enhanced')?.framework_role).toBeUndefined()
    })
  })

  describe('projector — framework propagation', () => {
    it('projects redux_slice → framework: redux, node_kind: slice', async () => {
      writeFile(sandbox, 'src/counter.ts', [
        'import { createSlice } from "@reduxjs/toolkit"',
        'export const counterSlice = createSlice({ name: "counter", initialState: 0, reducers: {} })',
      ].join('\n') + '\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'counterSlice')
      expect(node?.framework).toBe('redux')
      expect(node?.framework_role).toBe('redux_slice')
      expect(node?.node_kind).toBe('slice')
    })

    it('projects redux_store → framework: redux, node_kind: store', async () => {
      writeFile(sandbox, 'src/store.ts', [
        'import { configureStore } from "@reduxjs/toolkit"',
        'export const store = configureStore({ reducer: {} })',
      ].join('\n') + '\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'store')
      expect(node?.framework).toBe('redux')
      expect(node?.node_kind).toBe('store')
    })
  })
})
