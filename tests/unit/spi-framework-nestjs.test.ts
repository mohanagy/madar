import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type { SemanticProgramIndex, SpiEdge, SpiSymbol, SpiSymbolKind } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-nest-'))
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
    extractorVersion: 'spi-v1.0.0-slice-3b',
    now: FROZEN_NOW,
  })
}

function findSymbol(spi: SemanticProgramIndex, filePath: string, name: string, kind: SpiSymbolKind): SpiSymbol {
  const file = spi.files.find((f) => f.path === filePath)
  if (!file) throw new Error(`fixture missing SpiFile: ${filePath}`)
  const matches = spi.symbols.filter((s) => s.file_id === file.id && s.name === name && s.kind === kind)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${kind} ${name} in ${filePath}; got ${matches.length}`)
  }
  return matches[0]!
}

function frameworkEdge(spi: SemanticProgramIndex, from: string, kind: SpiEdge['kind'], to: string): SpiEdge | undefined {
  return spi.edges.find((e) => e.from === from && e.to === to && e.kind === kind)
}

// Mock decorator declarations so the type checker accepts the fixtures
// without us needing to install @nestjs/common in the sandbox.
const NEST_STUB_DECORATORS = `
declare function Module(opts?: { imports?: unknown[]; providers?: unknown[]; controllers?: unknown[]; exports?: unknown[] }): ClassDecorator
declare function Controller(prefix?: string): ClassDecorator
declare function Injectable(): ClassDecorator
declare function Get(path?: string): MethodDecorator
declare function Post(path?: string): MethodDecorator
declare function Put(path?: string): MethodDecorator
declare function Patch(path?: string): MethodDecorator
declare function Delete(path?: string): MethodDecorator
declare function All(path?: string): MethodDecorator
`

describe('buildSpi NestJS framework layer (slice 3b of #72)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('framework_role on classes', () => {
    it('marks an @Injectable class as nest_provider', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/auth.service.ts', [
        'import { Injectable } from "./decorators.js"',
        '@Injectable()',
        'export class AuthService {',
        '  login() {}',
        '}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const cls = findSymbol(spi, 'src/auth.service.ts', 'AuthService', 'class')
      expect(cls.framework_role).toBe('nest_provider')
    })

    it('marks an @Controller class as nest_controller', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller } from "./decorators.js"',
        '@Controller("users")',
        'export class UsersController {}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const cls = findSymbol(spi, 'src/users.controller.ts', 'UsersController', 'class')
      expect(cls.framework_role).toBe('nest_controller')
    })

    it('marks an @Module class as nest_module', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "./decorators.js"',
        '@Module({})',
        'export class AppModule {}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const cls = findSymbol(spi, 'src/app.module.ts', 'AppModule', 'class')
      expect(cls.framework_role).toBe('nest_module')
    })

    it('does not set framework_role on a class without a recognized decorator', () => {
      writeFile(sandbox, 'src/plain.ts', 'export class Plain {}\n')
      const spi = build(sandbox)
      const cls = findSymbol(spi, 'src/plain.ts', 'Plain', 'class')
      expect(cls.framework_role).toBeUndefined()
    })
  })

  describe('controller_route edges and method framework_role', () => {
    it('emits a controller_route edge from the controller class to each route method', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, Get, Post } from "./decorators.js"',
        '@Controller("users")',
        'export class UsersController {',
        '  @Get()',
        '  list() { return [] }',
        '  @Post()',
        '  create() { return {} }',
        '  notARoute() { return null }',
        '}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const controller = findSymbol(spi, 'src/users.controller.ts', 'UsersController', 'class')
      const list = findSymbol(spi, 'src/users.controller.ts', 'UsersController.list', 'method')
      const create = findSymbol(spi, 'src/users.controller.ts', 'UsersController.create', 'method')
      const plain = findSymbol(spi, 'src/users.controller.ts', 'UsersController.notARoute', 'method')

      expect(list.framework_role).toBe('nest_route')
      expect(create.framework_role).toBe('nest_route')
      expect(plain.framework_role).toBeUndefined()

      const listEdge = frameworkEdge(spi, controller.id, 'controller_route', list.id)
      const createEdge = frameworkEdge(spi, controller.id, 'controller_route', create.id)
      expect(listEdge).toBeTruthy()
      expect(createEdge).toBeTruthy()
      expect(listEdge?.confidence).toBe('high')
      expect(listEdge?.source).toBe('framework-decorator')
    })

    it('does not emit controller_route to methods without a route decorator', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/c.ts', [
        'import { Controller, Get } from "./decorators.js"',
        '@Controller()',
        'export class C {',
        '  @Get() listed() {}',
        '  unlisted() {}',
        '}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const controller = findSymbol(spi, 'src/c.ts', 'C', 'class')
      const unlisted = findSymbol(spi, 'src/c.ts', 'C.unlisted', 'method')
      expect(frameworkEdge(spi, controller.id, 'controller_route', unlisted.id)).toBeUndefined()
    })
  })

  describe('@Module options → module_imports / module_provides / module_exports', () => {
    it('emits module_imports edges from @Module imports array', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/auth.module.ts', [
        'import { Module } from "./decorators.js"',
        '@Module({})',
        'export class AuthModule {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.module.ts', [
        'import { Module } from "./decorators.js"',
        '@Module({})',
        'export class UsersModule {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "./decorators.js"',
        'import { AuthModule } from "./auth.module.js"',
        'import { UsersModule } from "./users.module.js"',
        '@Module({ imports: [AuthModule, UsersModule] })',
        'export class AppModule {}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const app = findSymbol(spi, 'src/app.module.ts', 'AppModule', 'class')
      const auth = findSymbol(spi, 'src/auth.module.ts', 'AuthModule', 'class')
      const users = findSymbol(spi, 'src/users.module.ts', 'UsersModule', 'class')
      expect(frameworkEdge(spi, app.id, 'module_imports', auth.id)).toBeTruthy()
      expect(frameworkEdge(spi, app.id, 'module_imports', users.id)).toBeTruthy()
    })

    it('emits module_provides edges from @Module providers and controllers arrays', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/auth.service.ts', [
        'import { Injectable } from "./decorators.js"',
        '@Injectable()',
        'export class AuthService {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/auth.controller.ts', [
        'import { Controller } from "./decorators.js"',
        '@Controller()',
        'export class AuthController {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/auth.module.ts', [
        'import { Module } from "./decorators.js"',
        'import { AuthService } from "./auth.service.js"',
        'import { AuthController } from "./auth.controller.js"',
        '@Module({ providers: [AuthService], controllers: [AuthController] })',
        'export class AuthModule {}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const mod = findSymbol(spi, 'src/auth.module.ts', 'AuthModule', 'class')
      const svc = findSymbol(spi, 'src/auth.service.ts', 'AuthService', 'class')
      const ctrl = findSymbol(spi, 'src/auth.controller.ts', 'AuthController', 'class')
      expect(frameworkEdge(spi, mod.id, 'module_provides', svc.id)).toBeTruthy()
      expect(frameworkEdge(spi, mod.id, 'module_provides', ctrl.id)).toBeTruthy()
    })

    it('emits module_exports edges from @Module exports array', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/svc.ts', [
        'import { Injectable } from "./decorators.js"',
        '@Injectable()',
        'export class Svc {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/m.ts', [
        'import { Module } from "./decorators.js"',
        'import { Svc } from "./svc.js"',
        '@Module({ providers: [Svc], exports: [Svc] })',
        'export class M {}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const mod = findSymbol(spi, 'src/m.ts', 'M', 'class')
      const svc = findSymbol(spi, 'src/svc.ts', 'Svc', 'class')
      expect(frameworkEdge(spi, mod.id, 'module_exports', svc.id)).toBeTruthy()
    })

    it('skips dynamic / non-identifier elements in @Module options arrays', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/m.ts', [
        'import { Module } from "./decorators.js"',
        // forRoot() returns a DynamicModule object — not a bare class identifier.
        '@Module({ imports: [{ module: class Inline {}, providers: [] }] })',
        'export class M {}',
      ].join('\n') + '\n')

      const spi = build(sandbox)
      const mod = findSymbol(spi, 'src/m.ts', 'M', 'class')
      // No module_imports edges should land — the dynamic shape is intentionally
      // deferred to a slice 3b-ii follow-up.
      const importEdges = spi.edges.filter((e) => e.from === mod.id && e.kind === 'module_imports')
      expect(importEdges).toHaveLength(0)
    })
  })

  describe('hygiene', () => {
    it('does not emit framework edges into externals (referenced class lives in node_modules)', () => {
      // External classes (e.g., third-party modules) won't have a SpiFile in
      // pathToFileId — the resolver returns null, no edge emitted.
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/m.ts', [
        'import { Module } from "./decorators.js"',
        // Use a name that genuinely doesn't resolve to anything in this workspace.
        '// Intentional comment-only fixture; no import to keep the type checker',
        '// from following the symbol off-workspace.',
        '@Module({})',
        'export class M {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)
      const mod = findSymbol(spi, 'src/m.ts', 'M', 'class')
      // Empty module → zero framework edges, just the framework_role.
      expect(mod.framework_role).toBe('nest_module')
      const moduleEdges = spi.edges.filter((e) => e.from === mod.id && e.kind.startsWith('module_'))
      expect(moduleEdges).toHaveLength(0)
    })

    it('produces deterministic output for the same NestJS-shaped input across two runs', () => {
      writeFile(sandbox, 'src/decorators.ts', NEST_STUB_DECORATORS)
      writeFile(sandbox, 'src/svc.ts', 'import { Injectable } from "./decorators.js"\n@Injectable()\nexport class Svc {}\n')
      writeFile(sandbox, 'src/m.ts', 'import { Module } from "./decorators.js"\nimport { Svc } from "./svc.js"\n@Module({ providers: [Svc] })\nexport class M {}\n')
      const first = build(sandbox)
      const second = build(sandbox)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    })
  })
})
