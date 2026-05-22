// v0.14 finisher tests — route_path / slice metadata across all four
// framework substrates (Express, Next.js, React Router, Redux Toolkit).
// One file so the cross-framework normalization rules (dynamic segments,
// route-group stripping, trailing-slash collapse, child-path joining)
// can be compared side-by-side.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function build(root: string): SemanticProgramIndex {
  return buildSpi({
    root,
    madarVersion: 'test-0.0.0',
    extractorVersion: 'spi-v1.0.0-v0.14-finishers',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('Next.js route_path derivation (slice 1c-iv.b)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-nextjs-route-path-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('derives /users from app/users/page.tsx', () => {
    writeFile(sandbox, 'app/users/page.tsx', [
      'export default function UsersPage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'app/users/page.tsx', 'UsersPage')
    expect(page?.framework_role).toBe('nextjs_app_page')
    expect(page?.framework_metadata?.route_path).toBe('/users')
  })

  it('collapses /index to / for the app router root', () => {
    writeFile(sandbox, 'app/page.tsx', [
      'export default function HomePage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'app/page.tsx', 'HomePage')
    expect(page?.framework_metadata?.route_path).toBe('/')
  })

  it('normalizes [id] dynamic segments to :id', () => {
    writeFile(sandbox, 'app/users/[id]/page.tsx', [
      'export default function UserPage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'app/users/[id]/page.tsx', 'UserPage')
    expect(page?.framework_metadata?.route_path).toBe('/users/:id')
  })

  it('normalizes catch-all [...slug] to *', () => {
    writeFile(sandbox, 'app/blog/[...slug]/page.tsx', [
      'export default function BlogPage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'app/blog/[...slug]/page.tsx', 'BlogPage')
    expect(page?.framework_metadata?.route_path).toBe('/blog/*')
  })

  it('normalizes optional catch-all [[...slug]] to *?', () => {
    writeFile(sandbox, 'app/blog/[[...slug]]/page.tsx', [
      'export default function BlogPage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'app/blog/[[...slug]]/page.tsx', 'BlogPage')
    expect(page?.framework_metadata?.route_path).toBe('/blog/*?')
  })

  it('strips route groups (auth) from the URL path', () => {
    writeFile(sandbox, 'app/(auth)/login/page.tsx', [
      'export default function LoginPage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'app/(auth)/login/page.tsx', 'LoginPage')
    expect(page?.framework_metadata?.route_path).toBe('/login')
  })

  it('tags route.ts HTTP method exports with route_path + http_method', () => {
    writeFile(sandbox, 'app/api/users/route.ts', [
      'export function GET(): Response { return new Response() }',
      'export function POST(): Response { return new Response() }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const get = findSymbol(spi, 'app/api/users/route.ts', 'GET')
    expect(get?.framework_role).toBe('nextjs_app_route')
    expect(get?.framework_metadata?.route_path).toBe('/api/users')
    expect(get?.framework_metadata?.http_method).toBe('GET')
    const post = findSymbol(spi, 'app/api/users/route.ts', 'POST')
    expect(post?.framework_metadata?.http_method).toBe('POST')
  })

  it('derives /users/:id from pages/users/[id].tsx', () => {
    writeFile(sandbox, 'pages/users/[id].tsx', [
      'export default function UserPage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'pages/users/[id].tsx', 'UserPage')
    expect(page?.framework_metadata?.route_path).toBe('/users/:id')
  })

  it('preserves the api/ prefix for pages/api routes', () => {
    writeFile(sandbox, 'pages/api/users/[id].ts', [
      'export default function handler(): void {}',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const handler = findSymbol(spi, 'pages/api/users/[id].ts', 'handler')
    expect(handler?.framework_role).toBe('nextjs_pages_api')
    expect(handler?.framework_metadata?.route_path).toBe('/api/users/:id')
  })

  it('tags middleware.ts with route_path /*', () => {
    writeFile(sandbox, 'middleware.ts', [
      'export default function middleware(): void {}',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const mw = findSymbol(spi, 'middleware.ts', 'middleware')
    expect(mw?.framework_role).toBe('nextjs_middleware')
    expect(mw?.framework_metadata?.route_path).toBe('/*')
  })

  it('strips intercepting-route prefixes (.) (..) (...) from folder names (CodeRabbit fix)', () => {
    // Next.js intercepting routes: `(.)photo`, `(..)photo`, `(...)photo`
    // are file-system markers for intercept behavior but the URL segment
    // is still the bare folder name. Without the strip the unstripped
    // marker would leak into route_path (e.g. `/feed/(.)photo`).
    writeFile(sandbox, 'app/feed/(.)photo/[id]/page.tsx', [
      'export default function InterceptedPhotoPage(): null { return null }',
    ].join('\n') + '\n')
    writeFile(sandbox, 'app/feed/(..)comments/page.tsx', [
      'export default function InterceptedCommentsPage(): null { return null }',
    ].join('\n') + '\n')
    writeFile(sandbox, 'app/feed/(...)admin/page.tsx', [
      'export default function InterceptedAdminPage(): null { return null }',
    ].join('\n') + '\n')

    const spi = build(sandbox)

    const photo = findSymbol(spi, 'app/feed/(.)photo/[id]/page.tsx', 'InterceptedPhotoPage')
    expect(photo?.framework_metadata?.route_path).toBe('/feed/photo/:id')

    const comments = findSymbol(spi, 'app/feed/(..)comments/page.tsx', 'InterceptedCommentsPage')
    expect(comments?.framework_metadata?.route_path).toBe('/feed/comments')

    const admin = findSymbol(spi, 'app/feed/(...)admin/page.tsx', 'InterceptedAdminPage')
    expect(admin?.framework_metadata?.route_path).toBe('/feed/admin')
  })

  it('strips a leading src/ directory', () => {
    writeFile(sandbox, 'src/app/users/page.tsx', [
      'export default function UsersPage(): null { return null }',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const page = findSymbol(spi, 'src/app/users/page.tsx', 'UsersPage')
    expect(page?.framework_metadata?.route_path).toBe('/users')
  })
})

describe('React Router route_path extraction (slice 1c-v.b)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-rr-route-path-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('tags createBrowserRouter result with route_path from the config', () => {
    writeFile(sandbox, 'src/routes.tsx', [
      'import { createBrowserRouter } from "react-router-dom"',
      'export const router = createBrowserRouter([',
      '  { path: "/", element: null }',
      '])',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const router = findSymbol(spi, 'src/routes.tsx', 'router')
    expect(router?.framework_role).toBe('react_router_router')
    expect(router?.framework_metadata?.route_path).toBe('/')
  })

  it('tags in-config loader with the route_path it serves', () => {
    writeFile(sandbox, 'src/routes.tsx', [
      'import { createBrowserRouter } from "react-router-dom"',
      'export function usersLoader(): unknown { return null }',
      'export const router = createBrowserRouter([',
      '  { path: "/users", element: null, loader: usersLoader }',
      '])',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const loader = findSymbol(spi, 'src/routes.tsx', 'usersLoader')
    expect(loader?.framework_role).toBe('react_router_loader')
    expect(loader?.framework_metadata?.route_path).toBe('/users')
  })

  it('joins nested children paths with the parent', () => {
    writeFile(sandbox, 'src/routes.tsx', [
      'import { createBrowserRouter } from "react-router-dom"',
      'export function userLoader(): unknown { return null }',
      'export const router = createBrowserRouter([',
      '  { path: "/users", children: [',
      '    { path: ":id", loader: userLoader }',
      '  ]}',
      '])',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const loader = findSymbol(spi, 'src/routes.tsx', 'userLoader')
    expect(loader?.framework_role).toBe('react_router_loader')
    expect(loader?.framework_metadata?.route_path).toBe('/users/:id')
  })

  it('reuses the parent path for index routes', () => {
    writeFile(sandbox, 'src/routes.tsx', [
      'import { createBrowserRouter } from "react-router-dom"',
      'export function listLoader(): unknown { return null }',
      'export const router = createBrowserRouter([',
      '  { path: "/users", children: [',
      '    { index: true, loader: listLoader }',
      '  ]}',
      '])',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const loader = findSymbol(spi, 'src/routes.tsx', 'listLoader')
    expect(loader?.framework_metadata?.route_path).toBe('/users')
  })

  it('resolves hoisted route-config arrays declared in the same file (CodeRabbit fix)', () => {
    // Idiomatic React Router pattern: declare the route array as a const
    // and pass it to the factory. Pre-fix only the inline-literal form
    // was handled, so hoisted configs were silently skipped.
    writeFile(sandbox, 'src/routes.tsx', [
      'import { createBrowserRouter } from "react-router-dom"',
      'export function dashboardLoader(): unknown { return null }',
      'const routes = [',
      '  { path: "/dashboard", loader: dashboardLoader }',
      ']',
      'export const router = createBrowserRouter(routes)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const loader = findSymbol(spi, 'src/routes.tsx', 'dashboardLoader')
    expect(loader?.framework_role).toBe('react_router_loader')
    expect(loader?.framework_metadata?.route_path).toBe('/dashboard')
    const router = findSymbol(spi, 'src/routes.tsx', 'router')
    expect(router?.framework_role).toBe('react_router_router')
    expect(router?.framework_metadata?.route_path).toBe('/dashboard')
  })

  it('tags action with route_path too', () => {
    writeFile(sandbox, 'src/routes.tsx', [
      'import { createBrowserRouter } from "react-router-dom"',
      'export function createUserAction(): unknown { return null }',
      'export const router = createBrowserRouter([',
      '  { path: "/users", action: createUserAction }',
      '])',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const action = findSymbol(spi, 'src/routes.tsx', 'createUserAction')
    expect(action?.framework_role).toBe('react_router_action')
    expect(action?.framework_metadata?.route_path).toBe('/users')
  })
})

describe('Redux Toolkit metadata (slice 1c-vi.b)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-redux-meta-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('extracts slice_name and reducer_keys from createSlice', () => {
    writeFile(sandbox, 'src/counterSlice.ts', [
      'import { createSlice } from "@reduxjs/toolkit"',
      'export const counterSlice = createSlice({',
      '  name: "counter",',
      '  initialState: 0,',
      '  reducers: {',
      '    increment(state: number): number { return state + 1 },',
      '    decrement(state: number): number { return state - 1 },',
      '    reset(): number { return 0 },',
      '  },',
      '})',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const slice = findSymbol(spi, 'src/counterSlice.ts', 'counterSlice')
    expect(slice?.framework_role).toBe('redux_slice')
    expect(slice?.framework_metadata?.slice_name).toBe('counter')
    expect(slice?.framework_metadata?.reducer_keys).toEqual(['increment', 'decrement', 'reset'])
    expect(slice?.framework_metadata?.action_creators).toEqual(['increment', 'decrement', 'reset'])
  })

  it('extracts reducer_keys from configureStore with combined reducer object', () => {
    writeFile(sandbox, 'src/store.ts', [
      'import { configureStore } from "@reduxjs/toolkit"',
      'declare const auth: unknown',
      'declare const posts: unknown',
      'export const store = configureStore({',
      '  reducer: { auth, posts },',
      '})',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const store = findSymbol(spi, 'src/store.ts', 'store')
    expect(store?.framework_role).toBe('redux_store')
    expect(store?.framework_metadata?.reducer_keys).toEqual(['auth', 'posts'])
  })

  it('extracts type_prefix from createAsyncThunk', () => {
    writeFile(sandbox, 'src/thunks.ts', [
      'import { createAsyncThunk } from "@reduxjs/toolkit"',
      'export const fetchUser = createAsyncThunk("user/fetch", async () => null)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const thunk = findSymbol(spi, 'src/thunks.ts', 'fetchUser')
    expect(thunk?.framework_role).toBe('redux_async_thunk')
    expect(thunk?.framework_metadata?.type_prefix).toBe('user/fetch')
  })

  it('extracts endpoint_names from createApi (RTK Query)', () => {
    writeFile(sandbox, 'src/api.ts', [
      'import { createApi } from "@reduxjs/toolkit/query/react"',
      'declare const fetchBaseQuery: (opts: { baseUrl: string }) => unknown',
      'export const api = createApi({',
      '  reducerPath: "api",',
      '  baseQuery: fetchBaseQuery({ baseUrl: "/" }) as any,',
      '  endpoints: (build) => ({',
      '    getUser: build.query<unknown, string>({ query: (id: string) => `/users/${id}` }),',
      '    updateUser: build.mutation<unknown, unknown>({ query: () => "/users" }),',
      '  }),',
      '})',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const api = findSymbol(spi, 'src/api.ts', 'api')
    expect(api?.framework_role).toBe('redux_rtk_query_api')
    expect(api?.framework_metadata?.endpoint_names).toEqual(['getUser', 'updateUser'])
  })

  it('leaves createSelector untouched (no metadata)', () => {
    writeFile(sandbox, 'src/selectors.ts', [
      'import { createSelector } from "reselect"',
      'declare const a: (s: unknown) => unknown',
      'declare const b: (s: unknown) => unknown',
      'export const selectFoo = createSelector([a, b], (x: unknown, y: unknown) => x)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const sel = findSymbol(spi, 'src/selectors.ts', 'selectFoo')
    expect(sel?.framework_role).toBe('redux_selector')
    expect(sel?.framework_metadata).toBeUndefined()
  })
})

describe('Express trailing-slash normalization (slice 1c-ii.i)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-express-normalize-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('collapses router-root / so the mount prefix appears without a trailing slash', () => {
    // Pre-fix: '/api/users' + '/' → '/api/users/'. Post-fix: '/api/users'.
    // This is the byte-equivalence finisher mentioned in the PR for #118.
    writeFile(sandbox, 'src/server.ts', [
      'import express, { Router } from "express"',
      'export const app = express()',
      'export const usersRouter = Router()',
      'export function listUsers(): void {}',
      'usersRouter.get("/", listUsers)',
      'app.use("/api/users", usersRouter)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const handler = findSymbol(spi, 'src/server.ts', 'listUsers')
    expect(handler?.framework_metadata?.route_path).toBe('/api/users')
  })

  it('still preserves the non-root path verbatim', () => {
    writeFile(sandbox, 'src/server.ts', [
      'import express, { Router } from "express"',
      'export const app = express()',
      'export const usersRouter = Router()',
      'export function getUser(): void {}',
      'usersRouter.get("/:id", getUser)',
      'app.use("/api/users", usersRouter)',
    ].join('\n') + '\n')
    const spi = build(sandbox)
    const handler = findSymbol(spi, 'src/server.ts', 'getUser')
    expect(handler?.framework_metadata?.route_path).toBe('/api/users/:id')
  })
})

describe('Multi-framework parity bundle (v0.14 finisher)', () => {
  let sandbox: string
  beforeEach(() => { sandbox = mkSandbox('spi-v014-parity-') })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  it('a workspace with all four frameworks emits route_path / slice metadata on every framework symbol', () => {
    // One workspace combining all four framework substrates so we can
    // observe in a single SPI build that:
    //   - Express: route_path (mounted)
    //   - Next.js: route_path (file-convention)
    //   - React Router: route_path (config-array)
    //   - Redux: slice_name + reducer_keys (createSlice)
    writeFile(sandbox, 'src/server.ts', [
      'import express, { Router } from "express"',
      'export const app = express()',
      'export const apiRouter = Router()',
      'export function ping(): void {}',
      'apiRouter.get("/ping", ping)',
      'app.use("/api", apiRouter)',
    ].join('\n') + '\n')
    writeFile(sandbox, 'app/users/[id]/page.tsx', [
      'export default function UserPage(): null { return null }',
    ].join('\n') + '\n')
    writeFile(sandbox, 'src/routes.tsx', [
      'import { createBrowserRouter } from "react-router-dom"',
      'export function rootLoader(): unknown { return null }',
      'export const router = createBrowserRouter([',
      '  { path: "/dashboard", loader: rootLoader }',
      '])',
    ].join('\n') + '\n')
    writeFile(sandbox, 'src/counterSlice.ts', [
      'import { createSlice } from "@reduxjs/toolkit"',
      'export const counterSlice = createSlice({',
      '  name: "counter",',
      '  initialState: 0,',
      '  reducers: { increment(s: number): number { return s + 1 } },',
      '})',
    ].join('\n') + '\n')

    const spi = build(sandbox)

    const expressPing = findSymbol(spi, 'src/server.ts', 'ping')
    expect(expressPing?.framework_role).toBe('express_route')
    expect(expressPing?.framework_metadata?.route_path).toBe('/api/ping')

    const nextjsPage = findSymbol(spi, 'app/users/[id]/page.tsx', 'UserPage')
    expect(nextjsPage?.framework_role).toBe('nextjs_app_page')
    expect(nextjsPage?.framework_metadata?.route_path).toBe('/users/:id')

    const rrLoader = findSymbol(spi, 'src/routes.tsx', 'rootLoader')
    expect(rrLoader?.framework_role).toBe('react_router_loader')
    expect(rrLoader?.framework_metadata?.route_path).toBe('/dashboard')

    const slice = findSymbol(spi, 'src/counterSlice.ts', 'counterSlice')
    expect(slice?.framework_role).toBe('redux_slice')
    expect(slice?.framework_metadata?.slice_name).toBe('counter')
    expect(slice?.framework_metadata?.reducer_keys).toEqual(['increment'])
  })
})
