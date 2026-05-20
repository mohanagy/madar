import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiSymbol } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-11T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-nextjs-tests-'))
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
    extractorVersion: 'spi-v1.0.0-slice-1c-iv.a',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol | undefined {
  const file = spi.files.find((f) => f.path === path)
  if (!file) return undefined
  return spi.symbols.find((s) => s.file_id === file.id && s.name === name)
}

describe('SPI Next.js framework detector (slice 1c-iv.a)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('app router file conventions', () => {
    it('tags the default export of app/<segment>/page.tsx as nextjs_app_page', () => {
      writeFile(sandbox, 'app/users/page.tsx', [
        'export default function UsersPage(): null { return null }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'app/users/page.tsx', 'UsersPage')
      expect(sym?.framework_role).toBe('nextjs_app_page')
    })

    it('tags the default export of app/<segment>/layout.tsx as nextjs_app_layout', () => {
      writeFile(sandbox, 'app/layout.tsx', [
        'export default function RootLayout(): null { return null }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'app/layout.tsx', 'RootLayout')
      expect(sym?.framework_role).toBe('nextjs_app_layout')
    })

    it('tags loading.tsx, error.tsx, and template.tsx with their respective roles', () => {
      writeFile(sandbox, 'app/users/loading.tsx', 'export default function L(): null { return null }\n')
      writeFile(sandbox, 'app/users/error.tsx', 'export default function E(): null { return null }\n')
      writeFile(sandbox, 'app/users/template.tsx', 'export default function T(): null { return null }\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'app/users/loading.tsx', 'L')?.framework_role).toBe('nextjs_app_loading')
      expect(findSymbol(spi, 'app/users/error.tsx', 'E')?.framework_role).toBe('nextjs_app_error')
      expect(findSymbol(spi, 'app/users/template.tsx', 'T')?.framework_role).toBe('nextjs_app_template')
    })

    it('tags every HTTP-method named export of app/<segment>/route.ts as nextjs_app_route', () => {
      writeFile(sandbox, 'app/api/users/route.ts', [
        'export function GET(): Response { return new Response() }',
        'export function POST(): Response { return new Response() }',
        'export function helper(): void {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'app/api/users/route.ts', 'GET')?.framework_role).toBe('nextjs_app_route')
      expect(findSymbol(spi, 'app/api/users/route.ts', 'POST')?.framework_role).toBe('nextjs_app_route')
      // Non-HTTP-named exports stay untagged.
      expect(findSymbol(spi, 'app/api/users/route.ts', 'helper')?.framework_role).toBeUndefined()
    })

    it('recognizes all standard HTTP method names on a route.ts', () => {
      writeFile(sandbox, 'app/api/x/route.ts', [
        'export function GET(): Response { return new Response() }',
        'export function POST(): Response { return new Response() }',
        'export function PUT(): Response { return new Response() }',
        'export function PATCH(): Response { return new Response() }',
        'export function DELETE(): Response { return new Response() }',
        'export function OPTIONS(): Response { return new Response() }',
        'export function HEAD(): Response { return new Response() }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const taggedCount = spi.symbols.filter((s) => s.framework_role === 'nextjs_app_route').length
      expect(taggedCount).toBe(7)
    })

    it('records runtime_boundary metadata for visible app-router server and client boundaries', () => {
      writeFile(sandbox, 'app/server/page.tsx', 'export default function ServerPage(): null { return null }\n')
      writeFile(sandbox, 'app/client/error.tsx', [
        "'use client'",
        '',
        'export default function ClientError(): null { return null }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const serverPage = findSymbol(spi, 'app/server/page.tsx', 'ServerPage')
      const clientError = findSymbol(spi, 'app/client/error.tsx', 'ClientError')

      expect(serverPage?.framework_role).toBe('nextjs_app_page')
      expect(serverPage?.framework_metadata).toEqual(expect.objectContaining({
        route_path: '/server',
        runtime_boundary: 'server',
      }))
      expect(clientError?.framework_role).toBe('nextjs_app_error')
      expect(clientError?.framework_metadata).toEqual(expect.objectContaining({
        route_path: '/client',
        runtime_boundary: 'client',
      }))
    })
  })

  describe('pages router file conventions', () => {
    it('tags the default export of pages/<segment>.tsx as nextjs_pages_page', () => {
      writeFile(sandbox, 'pages/about.tsx', [
        'export default function About(): null { return null }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'pages/about.tsx', 'About')
      expect(sym?.framework_role).toBe('nextjs_pages_page')
    })

    it('tags the default export of pages/api/<segment>.ts as nextjs_pages_api', () => {
      writeFile(sandbox, 'pages/api/users.ts', [
        'export default function handler(): void {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'pages/api/users.ts', 'handler')
      expect(sym?.framework_role).toBe('nextjs_pages_api')
    })

    it('skips Next.js underscore-prefixed special files (_app, _document, _error)', () => {
      writeFile(sandbox, 'pages/_app.tsx', 'export default function App(): null { return null }\n')
      writeFile(sandbox, 'pages/_document.tsx', 'export default function Doc(): null { return null }\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'pages/_app.tsx', 'App')?.framework_role).toBeUndefined()
      expect(findSymbol(spi, 'pages/_document.tsx', 'Doc')?.framework_role).toBeUndefined()
    })
  })

  describe('middleware', () => {
    it('tags the default export of root middleware.ts as nextjs_middleware', () => {
      writeFile(sandbox, 'middleware.ts', [
        'export default function middleware(): void {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'middleware.ts', 'middleware')
      expect(sym?.framework_role).toBe('nextjs_middleware')
    })
  })

  describe('src/ prefix support', () => {
    it('recognizes Next.js conventions under src/app/', () => {
      writeFile(sandbox, 'src/app/users/page.tsx', [
        'export default function UsersPage(): null { return null }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/app/users/page.tsx', 'UsersPage')
      expect(sym?.framework_role).toBe('nextjs_app_page')
    })

    it('recognizes src/pages/api/ routes', () => {
      writeFile(sandbox, 'src/pages/api/users.ts', [
        'export default function handler(): void {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'src/pages/api/users.ts', 'handler')
      expect(sym?.framework_role).toBe('nextjs_pages_api')
    })
  })

  describe('export shapes', () => {
    it('handles `export default function Foo() {}` and `function Foo() {}; export default Foo`', () => {
      writeFile(sandbox, 'app/inline/page.tsx', 'export default function Inline(): null { return null }\n')
      writeFile(sandbox, 'app/separate/page.tsx', [
        'function Separate(): null { return null }',
        'export default Separate',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'app/inline/page.tsx', 'Inline')?.framework_role).toBe('nextjs_app_page')
      expect(findSymbol(spi, 'app/separate/page.tsx', 'Separate')?.framework_role).toBe('nextjs_app_page')
    })

    it('handles `export default class Foo {}`', () => {
      writeFile(sandbox, 'app/cls/page.tsx', [
        'export default class ClassPage { render(): null { return null } }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'app/cls/page.tsx', 'ClassPage')
      expect(sym?.framework_role).toBe('nextjs_app_page')
    })
  })

  describe('non-Next.js files', () => {
    it('does not tag files outside the recognized conventions', () => {
      writeFile(sandbox, 'src/lib/utils.ts', 'export function helper(): void {}\n')
      writeFile(sandbox, 'components/Button.tsx', 'export default function Button(): null { return null }\n')
      const spi = build(sandbox)
      expect(findSymbol(spi, 'src/lib/utils.ts', 'helper')?.framework_role).toBeUndefined()
      expect(findSymbol(spi, 'components/Button.tsx', 'Button')?.framework_role).toBeUndefined()
    })
  })

  describe('static client/server boundary roles', () => {
    it('tags exported app-directory callables in use client modules as nextjs_client_component', () => {
      writeFile(sandbox, 'app/users/ClientPanel.tsx', [
        "'use client'",
        '',
        'export function ClientPanel(): null { return null }',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'app/users/ClientPanel.tsx', 'ClientPanel')

      expect(sym?.framework_role).toBe('nextjs_client_component')
      expect(sym?.framework_metadata).toEqual(expect.objectContaining({
        runtime_boundary: 'client',
      }))
    })

    it('tags only exported top-level server actions when use server is statically visible', () => {
      writeFile(sandbox, 'app/users/actions.ts', [
        "'use server'",
        '',
        'function localHelper(): number { return 1 }',
        '',
        'export async function saveSettings(): Promise<number> { return 2 }',
        '',
        'export const publish = async (): Promise<number> => 3',
        '',
        "export const config = { runtime: 'nodejs' }",
      ].join('\n') + '\n')
      writeFile(sandbox, 'app/users/inline-action.ts', [
        'export async function renameUser(): Promise<number> {',
        "  'use server'",
        '  return 4',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      expect(findSymbol(spi, 'app/users/actions.ts', 'saveSettings')).toEqual(expect.objectContaining({
        framework_role: 'nextjs_server_action',
        framework_metadata: expect.objectContaining({
          runtime_boundary: 'server',
        }),
      }))
      expect(findSymbol(spi, 'app/users/actions.ts', 'publish')).toEqual(expect.objectContaining({
        framework_role: 'nextjs_server_action',
        framework_metadata: expect.objectContaining({
          runtime_boundary: 'server',
        }),
      }))
      expect(findSymbol(spi, 'app/users/inline-action.ts', 'renameUser')).toEqual(expect.objectContaining({
        framework_role: 'nextjs_server_action',
        framework_metadata: expect.objectContaining({
          runtime_boundary: 'server',
        }),
      }))
      expect(findSymbol(spi, 'app/users/actions.ts', 'localHelper')?.framework_role).toBeUndefined()
      expect(findSymbol(spi, 'app/users/actions.ts', 'config')?.framework_role).toBeUndefined()
    })

    it('prefers inline use server over file-level use client for exported actions', () => {
      writeFile(sandbox, 'app/users/client-actions.tsx', [
        "'use client'",
        '',
        'export const submitForm = async (): Promise<number> => {',
        "  'use server'",
        '  return 1',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const sym = findSymbol(spi, 'app/users/client-actions.tsx', 'submitForm')

      expect(sym?.framework_role).toBe('nextjs_server_action')
      expect(sym?.framework_metadata).toEqual(expect.objectContaining({
        runtime_boundary: 'server',
      }))
    })
  })

  describe('projector — framework propagation', () => {
    it('projects nextjs_app_page → framework: nextjs, node_kind: function', async () => {
      writeFile(sandbox, 'app/users/page.tsx', 'export default function UsersPage(): null { return null }\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'UsersPage()')
      expect(node?.framework).toBe('nextjs')
      expect(node?.framework_role).toBe('nextjs_app_page')
      expect(node?.node_kind).toBe('function')
    })

    it('projects nextjs_app_route → framework: nextjs, node_kind: route', async () => {
      writeFile(sandbox, 'app/api/users/route.ts', [
        'export function GET(): Response { return new Response() }',
      ].join('\n') + '\n')
      const { projectSpiToExtraction } = await import('../../src/pipeline/spi/projector.js')
      const spi = build(sandbox)
      const extraction = projectSpiToExtraction(spi, { root: sandbox })
      const node = extraction.nodes.find((n) => n.label === 'GET()')
      expect(node?.framework).toBe('nextjs')
      expect(node?.framework_role).toBe('nextjs_app_route')
      expect(node?.node_kind).toBe('route')
    })
  })
})
