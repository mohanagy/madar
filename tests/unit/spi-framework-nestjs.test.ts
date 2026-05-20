import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import type {
  SemanticProgramIndex,
  SpiEdge,
  SpiEdgeKind,
  SpiSymbol,
} from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-nest-tests-'))
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

function fileIdFor(spi: SemanticProgramIndex, path: string): string {
  const file = spi.files.find((f) => f.path === path)
  if (!file) {
    throw new Error(`fixture missing SpiFile: ${path}\nhad: ${spi.files.map((f) => f.path).join(', ')}`)
  }
  return file.id
}

function classSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol {
  const fileId = fileIdFor(spi, path)
  const symbol = spi.symbols.find((s) => s.file_id === fileId && s.kind === 'class' && s.name === name)
  if (!symbol) {
    throw new Error(`class symbol not found: ${name} in ${path}`)
  }
  return symbol
}

function methodSymbol(spi: SemanticProgramIndex, path: string, qualifiedName: string): SpiSymbol {
  const fileId = fileIdFor(spi, path)
  const symbol = spi.symbols.find((s) => s.file_id === fileId && s.kind === 'method' && s.name === qualifiedName)
  if (!symbol) {
    throw new Error(`method symbol not found: ${qualifiedName} in ${path}`)
  }
  return symbol
}

function frameworkEdges(spi: SemanticProgramIndex, kinds: ReadonlyArray<SpiEdgeKind>): SpiEdge[] {
  return spi.edges.filter((e) => kinds.includes(e.kind))
}

describe('buildSpi NestJS framework layer (slice 3b base of #72)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('framework_role tagging', () => {
    it('tags @Module classes with framework_role nest_module', () => {
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        '@Module({})',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const symbol = classSymbol(spi, 'src/app.module.ts', 'AppModule')
      expect(symbol.framework_role).toBe('nest_module')
    })

    it('tags @Controller classes with framework_role nest_controller', () => {
      writeFile(sandbox, 'src/app.controller.ts', [
        'import { Controller } from "@nestjs/common"',
        '@Controller("app")',
        'export class AppController {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const symbol = classSymbol(spi, 'src/app.controller.ts', 'AppController')
      expect(symbol.framework_role).toBe('nest_controller')
    })

    it('tags @Injectable classes with framework_role nest_provider', () => {
      writeFile(sandbox, 'src/app.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class AppService {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const symbol = classSymbol(spi, 'src/app.service.ts', 'AppService')
      expect(symbol.framework_role).toBe('nest_provider')
    })

    it('honors aliased import bindings (e.g. import { Module as NestModule })', () => {
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module as NestModule } from "@nestjs/common"',
        '@NestModule({})',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const symbol = classSymbol(spi, 'src/app.module.ts', 'AppModule')
      expect(symbol.framework_role).toBe('nest_module')
    })

    it('does not tag plain classes with no Nest decorators', () => {
      writeFile(sandbox, 'src/plain.ts', 'export class Plain {}\n')
      const spi = build(sandbox)

      const symbol = classSymbol(spi, 'src/plain.ts', 'Plain')
      expect(symbol.framework_role).toBeUndefined()
    })
  })

  describe('module_* edges', () => {
    it('emits module_imports edges to other module classes', () => {
      writeFile(sandbox, 'src/users/users.module.ts', [
        'import { Module } from "@nestjs/common"',
        '@Module({})',
        'export class UsersModule {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { UsersModule } from "./users/users.module.js"',
        '@Module({ imports: [UsersModule] })',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/app.module.ts', 'AppModule').id
      const toId = classSymbol(spi, 'src/users/users.module.ts', 'UsersModule').id
      const edge = spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === 'module_imports')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
      expect(edge?.source).toBe('framework-decorator')
      expect(edge?.evidence).toBeDefined()
    })

    it('emits module_provides edges for both providers and controllers lists', () => {
      writeFile(sandbox, 'src/app.controller.ts', [
        'import { Controller } from "@nestjs/common"',
        '@Controller()',
        'export class AppController {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/app.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class AppService {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { AppController } from "./app.controller.js"',
        'import { AppService } from "./app.service.js"',
        '@Module({ controllers: [AppController], providers: [AppService] })',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const moduleId = classSymbol(spi, 'src/app.module.ts', 'AppModule').id
      const controllerId = classSymbol(spi, 'src/app.controller.ts', 'AppController').id
      const serviceId = classSymbol(spi, 'src/app.service.ts', 'AppService').id

      const provides = spi.edges.filter((e) => e.from === moduleId && e.kind === 'module_provides')
      const targets = new Set(provides.map((e) => e.to))
      expect(targets.has(controllerId)).toBe(true)
      expect(targets.has(serviceId)).toBe(true)
      // Both providers and controllers are framework-decorator sourced + high.
      for (const edge of provides) {
        expect(edge.source).toBe('framework-decorator')
        expect(edge.confidence).toBe('high')
      }
    })

    it('emits module_exports edges for re-exported providers', () => {
      writeFile(sandbox, 'src/app.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class AppService {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { AppService } from "./app.service.js"',
        '@Module({ providers: [AppService], exports: [AppService] })',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const moduleId = classSymbol(spi, 'src/app.module.ts', 'AppModule').id
      const serviceId = classSymbol(spi, 'src/app.service.ts', 'AppService').id
      const exports_ = spi.edges.filter((e) => e.from === moduleId && e.to === serviceId && e.kind === 'module_exports')
      expect(exports_).toHaveLength(1)
      expect(exports_[0]?.confidence).toBe('high')
    })

    it('emits a low-confidence edge + diagnostic for dynamic Module.forRoot() entries (3b-ii)', () => {
      writeFile(sandbox, 'src/typeorm.module.ts', [
        'import { Module } from "@nestjs/common"',
        '@Module({})',
        'export class TypeOrmModule {',
        '  static forRoot(): unknown { return null }',
        '}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { TypeOrmModule } from "./typeorm.module.js"',
        '@Module({ imports: [TypeOrmModule.forRoot()] })',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const moduleId = classSymbol(spi, 'src/app.module.ts', 'AppModule').id
      const typeormId = classSymbol(spi, 'src/typeorm.module.ts', 'TypeOrmModule').id
      const importEdges = spi.edges.filter(
        (e) => e.from === moduleId && e.to === typeormId && e.kind === 'module_imports',
      )
      expect(importEdges).toHaveLength(1)
      expect(importEdges[0]?.confidence).toBe('low')
      expect(importEdges[0]?.source).toBe('framework-decorator')

      const dynamicDiag = spi.diagnostics.find((d) =>
        d.id.startsWith('spi.nest.module-metadata.dynamic') && d.message.includes('forRoot'),
      )
      expect(dynamicDiag).toBeTruthy()
    })

    it('emits a low-confidence edge + diagnostic for Module.forRootAsync() entries (3b-ii)', () => {
      writeFile(sandbox, 'src/config.module.ts', [
        'import { Module } from "@nestjs/common"',
        '@Module({})',
        'export class ConfigModule {',
        '  static forRootAsync(): unknown { return null }',
        '}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { ConfigModule } from "./config.module.js"',
        '@Module({ imports: [ConfigModule.forRootAsync()] })',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const moduleId = classSymbol(spi, 'src/app.module.ts', 'AppModule').id
      const configId = classSymbol(spi, 'src/config.module.ts', 'ConfigModule').id
      const edge = spi.edges.find(
        (e) => e.from === moduleId && e.to === configId && e.kind === 'module_imports',
      )
      expect(edge?.confidence).toBe('low')
      const diag = spi.diagnostics.find((d) =>
        d.id.startsWith('spi.nest.module-metadata.dynamic') && d.message.includes('forRootAsync'),
      )
      expect(diag).toBeTruthy()
    })

    it('emits a diagnostic for spread metadata entries', () => {
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        'const SHARED = [] as const',
        '@Module({ providers: [...SHARED] })',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const diag = spi.diagnostics.find((d) =>
        d.id.startsWith('spi.nest.module-metadata.unresolved') && d.message.includes('module_provides'),
      )
      expect(diag).toBeTruthy()
    })
  })

  describe('controller_route edges', () => {
    it('emits a controller_route edge from controller class to each route method', () => {
      writeFile(sandbox, 'src/app.controller.ts', [
        'import { Controller, Get, Post } from "@nestjs/common"',
        '@Controller("app")',
        'export class AppController {',
        '  @Get()',
        '  list(): string { return "" }',
        '  @Post()',
        '  create(): void {}',
        '  helper(): void {} // not a route',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const controllerId = classSymbol(spi, 'src/app.controller.ts', 'AppController').id
      const listId = methodSymbol(spi, 'src/app.controller.ts', 'AppController.list').id
      const createId = methodSymbol(spi, 'src/app.controller.ts', 'AppController.create').id

      const routeEdges = spi.edges.filter((e) => e.from === controllerId && e.kind === 'controller_route')
      const targets = new Set(routeEdges.map((e) => e.to))
      expect(targets.has(listId)).toBe(true)
      expect(targets.has(createId)).toBe(true)
      // helper() has no decorator → no edge
      expect(routeEdges).toHaveLength(2)
      for (const edge of routeEdges) {
        expect(edge.source).toBe('framework-decorator')
        expect(edge.confidence).toBe('high')
        expect(edge.evidence).toBeDefined()
      }
    })

    it('tags route methods with framework_role nest_route', () => {
      writeFile(sandbox, 'src/app.controller.ts', [
        'import { Controller, Get } from "@nestjs/common"',
        '@Controller()',
        'export class AppController {',
        '  @Get()',
        '  list(): string { return "" }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const list = methodSymbol(spi, 'src/app.controller.ts', 'AppController.list')
      expect(list.framework_role).toBe('nest_route')
    })

    it('recognizes every standard HTTP route decorator', () => {
      writeFile(sandbox, 'src/app.controller.ts', [
        'import { Controller, Get, Post, Put, Patch, Delete, Options, Head, All } from "@nestjs/common"',
        '@Controller()',
        'export class AppController {',
        '  @Get()    a(): void {}',
        '  @Post()   b(): void {}',
        '  @Put()    c(): void {}',
        '  @Patch()  d(): void {}',
        '  @Delete() e(): void {}',
        '  @Options() f(): void {}',
        '  @Head()   g(): void {}',
        '  @All()    h(): void {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const controllerId = classSymbol(spi, 'src/app.controller.ts', 'AppController').id
      const routeEdges = spi.edges.filter((e) => e.from === controllerId && e.kind === 'controller_route')
      expect(routeEdges).toHaveLength(8)
    })

    it('aligns the route edge with the symbol-layer overload index when a method is overloaded', () => {
      // A method with overload signatures + implementation produces three
      // SpiSymbol entries (`foo`, `foo#1`, `foo#2`); the route decorator
      // sits on the implementation, so the controller_route edge must
      // target `foo#2` — proving the overload counter is incremented for
      // every method declaration, not just routes.
      writeFile(sandbox, 'src/app.controller.ts', [
        'import { Controller, Get } from "@nestjs/common"',
        '@Controller()',
        'export class AppController {',
        '  list(name: string): string',
        '  list(id: number): string',
        '  @Get() list(arg: string | number): string { return String(arg) }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const controllerId = classSymbol(spi, 'src/app.controller.ts', 'AppController').id
      const routeEdges = spi.edges.filter((e) => e.from === controllerId && e.kind === 'controller_route')
      expect(routeEdges).toHaveLength(1)

      const fileId = fileIdFor(spi, 'src/app.controller.ts')
      const overloadIds = spi.symbols
        .filter((s) => s.file_id === fileId && s.kind === 'method' && s.name === 'AppController.list')
        .map((s) => s.id)
        .sort()
      // Expect exactly three method symbols for the three declarations.
      expect(overloadIds).toHaveLength(3)
      // The route edge must target the last (third) declaration's id, which
      // carries the `#2` overload suffix.
      const expectedTarget = overloadIds.find((id) => id.endsWith('#2'))
      expect(routeEdges[0]?.to).toBe(expectedTarget)
    })

    it('does not emit controller_route for plain classes that happen to use @Get from somewhere else', () => {
      // If @Get is not imported from @nestjs/common, the binding map is empty
      // and we don't emit a route edge.
      writeFile(sandbox, 'src/app.controller.ts', [
        'function Get(): MethodDecorator { return () => {} }',
        'function Controller(): ClassDecorator { return () => {} }',
        '@Controller()',
        'export class AppController {',
        '  @Get()',
        '  list(): string { return "" }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const controllerId = classSymbol(spi, 'src/app.controller.ts', 'AppController').id
      const routeEdges = spi.edges.filter((e) => e.from === controllerId && e.kind === 'controller_route')
      expect(routeEdges).toHaveLength(0)
      const controller = classSymbol(spi, 'src/app.controller.ts', 'AppController')
      expect(controller.framework_role).toBeUndefined()
    })
  })

  describe('edge invariants', () => {
    it('every framework edge carries source=framework-decorator and a defined confidence', () => {
      writeFile(sandbox, 'src/users.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class UsersService {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, Get } from "@nestjs/common"',
        '@Controller("users")',
        'export class UsersController {',
        '  @Get() list(): void {}',
        '}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { UsersController } from "./users.controller.js"',
        'import { UsersService } from "./users.service.js"',
        '@Module({ controllers: [UsersController], providers: [UsersService], exports: [UsersService] })',
        'export class UsersModule {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const FRAMEWORK_KINDS: ReadonlyArray<SpiEdgeKind> = [
        'module_imports',
        'module_provides',
        'module_exports',
        'controller_route',
      ]
      const edges = frameworkEdges(spi, FRAMEWORK_KINDS)
      expect(edges.length).toBeGreaterThan(0)
      for (const edge of edges) {
        expect(edge.source).toBe('framework-decorator')
        expect(['high', 'medium', 'low']).toContain(edge.confidence)
      }
    })

    it('coexists with calls and type edges from earlier slices', () => {
      writeFile(sandbox, 'src/users.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class UsersService {',
        '  list(): string[] { return [] }',
        '}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, Get } from "@nestjs/common"',
        'import { UsersService } from "./users.service.js"',
        '@Controller("users")',
        'export class UsersController {',
        '  constructor(private readonly users: UsersService) {}',
        '  @Get() list(): string[] { return this.users.list() }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      // calls edge from list() to UsersService.list — slice 2a coverage
      // continues to work alongside the framework layer.
      const callEdges = spi.edges.filter((e) => e.kind === 'calls')
      expect(callEdges.length).toBeGreaterThan(0)
      // controller_route edge — slice 3b base.
      const routeEdges = spi.edges.filter((e) => e.kind === 'controller_route')
      expect(routeEdges.length).toBeGreaterThan(0)
    })
  })

  describe('against the checked-in demo repo', () => {
    it('does not crash and emits no NestJS edges (demo-repo has no Nest files)', () => {
      const root = join(__dirname, '../../examples/demo-repo')
      const spi = buildSpi({ root, graphifyVersion: 'test-0.0.0', now: FROZEN_NOW })
      const FRAMEWORK_KINDS: ReadonlyArray<SpiEdgeKind> = [
        'module_imports',
        'module_provides',
        'module_exports',
        'controller_route',
        'guards',
        'pipes',
        'intercepts',
        'injects',
      ]
      const nestEdges = frameworkEdges(spi, FRAMEWORK_KINDS)
      expect(nestEdges).toHaveLength(0)
      const nestRoles = spi.symbols.filter((s) => s.framework_role !== undefined)
      expect(nestRoles).toHaveLength(0)
    })
  })
})

describe('buildSpi NestJS framework layer (slice 3b-ii of #72)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('injects edges from constructor types', () => {
    it('emits a high-confidence injects edge for a constructor parameter typed as a class', () => {
      writeFile(sandbox, 'src/users.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class UsersService {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller } from "@nestjs/common"',
        'import { UsersService } from "./users.service.js"',
        '@Controller()',
        'export class UsersController {',
        '  constructor(private readonly users: UsersService) {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/users.controller.ts', 'UsersController').id
      const toId = classSymbol(spi, 'src/users.service.ts', 'UsersService').id
      const edge = spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === 'injects')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
      expect(edge?.source).toBe('framework-decorator')
      expect(edge?.evidence).toBeDefined()
    })

    it('emits injects edges from provider classes too (not just controllers)', () => {
      writeFile(sandbox, 'src/logger.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class LoggerService {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.service.ts', [
        'import { Injectable } from "@nestjs/common"',
        'import { LoggerService } from "./logger.service.js"',
        '@Injectable()',
        'export class UsersService {',
        '  constructor(private readonly logger: LoggerService) {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/users.service.ts', 'UsersService').id
      const toId = classSymbol(spi, 'src/logger.service.ts', 'LoggerService').id
      const edge = spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === 'injects')
      expect(edge?.confidence).toBe('high')
    })

    it('dedupes when the same dependency appears as multiple constructor parameters', () => {
      writeFile(sandbox, 'src/dep.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class Dep {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/svc.ts', [
        'import { Injectable } from "@nestjs/common"',
        'import { Dep } from "./dep.js"',
        '@Injectable()',
        'export class Svc {',
        '  constructor(a: Dep, b: Dep) { void a; void b }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/svc.ts', 'Svc').id
      const toId = classSymbol(spi, 'src/dep.ts', 'Dep').id
      const edges = spi.edges.filter((e) => e.from === fromId && e.to === toId && e.kind === 'injects')
      expect(edges).toHaveLength(1)
    })

    it('does not emit injects when constructor parameter has no type annotation', () => {
      writeFile(sandbox, 'src/svc.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class Svc {',
        '  constructor(private readonly opts: unknown) {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/svc.ts', 'Svc').id
      const edges = spi.edges.filter((e) => e.from === fromId && e.kind === 'injects')
      expect(edges).toHaveLength(0)
    })
  })

  describe('injects edges from @Inject(\'TOKEN\') string-token resolution', () => {
    it('resolves @Inject(\'TOKEN\') against a useClass binding (medium confidence)', () => {
      writeFile(sandbox, 'src/redis-cache.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class RedisCache {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/cache.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { RedisCache } from "./redis-cache.js"',
        '@Module({ providers: [{ provide: "CACHE_TOKEN", useClass: RedisCache }], exports: ["CACHE_TOKEN"] })',
        'export class CacheModule {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.service.ts', [
        'import { Injectable, Inject } from "@nestjs/common"',
        '@Injectable()',
        'export class UsersService {',
        '  constructor(@Inject("CACHE_TOKEN") private readonly cache: unknown) {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/users.service.ts', 'UsersService').id
      const toId = classSymbol(spi, 'src/redis-cache.ts', 'RedisCache').id
      const edge = spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === 'injects')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('medium')
      expect(edge?.source).toBe('framework-decorator')
    })

    it('resolves @Inject(\'TOKEN\') against a useExisting binding (medium confidence)', () => {
      writeFile(sandbox, 'src/cache-impl.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class CacheImpl {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/cache.module.ts', [
        'import { Module } from "@nestjs/common"',
        'import { CacheImpl } from "./cache-impl.js"',
        '@Module({ providers: [CacheImpl, { provide: "CACHE_ALIAS", useExisting: CacheImpl }] })',
        'export class CacheModule {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/foo.service.ts', [
        'import { Injectable, Inject } from "@nestjs/common"',
        '@Injectable()',
        'export class FooService {',
        '  constructor(@Inject("CACHE_ALIAS") private readonly c: unknown) {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/foo.service.ts', 'FooService').id
      const toId = classSymbol(spi, 'src/cache-impl.ts', 'CacheImpl').id
      const edge = spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === 'injects')
      expect(edge?.confidence).toBe('medium')
    })

    it('emits a diagnostic when @Inject(\'TOKEN\') has no matching useClass / useExisting binding', () => {
      writeFile(sandbox, 'src/foo.service.ts', [
        'import { Injectable, Inject } from "@nestjs/common"',
        '@Injectable()',
        'export class FooService {',
        '  constructor(@Inject("UNBOUND_TOKEN") private readonly x: unknown) {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/foo.service.ts', 'FooService').id
      const injectEdges = spi.edges.filter((e) => e.from === fromId && e.kind === 'injects')
      expect(injectEdges).toHaveLength(0)
      const diag = spi.diagnostics.find(
        (d) => d.id.startsWith('spi.nest.inject-token.unresolved') && d.message.includes('UNBOUND_TOKEN'),
      )
      expect(diag).toBeTruthy()
    })

    it('does not consult the token map for @Inject when no useValue/useFactory entry was registered', () => {
      // useValue is intentionally absent from the token map (no class to
      // point at). Verify @Inject for a useValue token cleanly fails over
      // to a diagnostic rather than producing a spurious edge.
      writeFile(sandbox, 'src/cache.module.ts', [
        'import { Module } from "@nestjs/common"',
        '@Module({ providers: [{ provide: "DB_URL", useValue: "postgres://x" }] })',
        'export class CacheModule {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/foo.service.ts', [
        'import { Injectable, Inject } from "@nestjs/common"',
        '@Injectable()',
        'export class FooService {',
        '  constructor(@Inject("DB_URL") private readonly url: unknown) {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/foo.service.ts', 'FooService').id
      const injectEdges = spi.edges.filter((e) => e.from === fromId && e.kind === 'injects')
      expect(injectEdges).toHaveLength(0)
      const diag = spi.diagnostics.find((d) => d.message.includes('DB_URL'))
      expect(diag).toBeTruthy()
    })
  })

  describe('guards / intercepts / pipes edges', () => {
    it('emits a class-level guards edge from controller class to guard class', () => {
      writeFile(sandbox, 'src/auth.guard.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class AuthGuard {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, UseGuards, Get } from "@nestjs/common"',
        'import { AuthGuard } from "./auth.guard.js"',
        '@Controller("users")',
        '@UseGuards(AuthGuard)',
        'export class UsersController {',
        '  @Get() list(): void {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/users.controller.ts', 'UsersController').id
      const toId = classSymbol(spi, 'src/auth.guard.ts', 'AuthGuard').id
      const edge = spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === 'guards')
      expect(edge).toBeTruthy()
      expect(edge?.confidence).toBe('high')
      expect(edge?.source).toBe('framework-decorator')
    })

    it('emits a method-level guards edge from route method to guard class', () => {
      writeFile(sandbox, 'src/auth.guard.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class AuthGuard {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, UseGuards, Get } from "@nestjs/common"',
        'import { AuthGuard } from "./auth.guard.js"',
        '@Controller()',
        'export class UsersController {',
        '  @UseGuards(AuthGuard)',
        '  @Get() list(): void {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromMethod = methodSymbol(spi, 'src/users.controller.ts', 'UsersController.list').id
      const toId = classSymbol(spi, 'src/auth.guard.ts', 'AuthGuard').id
      const edge = spi.edges.find((e) => e.from === fromMethod && e.to === toId && e.kind === 'guards')
      expect(edge).toBeTruthy()
    })

    it('handles multiple guards passed positionally and as an array', () => {
      writeFile(sandbox, 'src/g1.ts', 'import { Injectable } from "@nestjs/common"\n@Injectable()\nexport class G1 {}\n')
      writeFile(sandbox, 'src/g2.ts', 'import { Injectable } from "@nestjs/common"\n@Injectable()\nexport class G2 {}\n')
      writeFile(sandbox, 'src/g3.ts', 'import { Injectable } from "@nestjs/common"\n@Injectable()\nexport class G3 {}\n')
      writeFile(sandbox, 'src/positional.controller.ts', [
        'import { Controller, UseGuards } from "@nestjs/common"',
        'import { G1 } from "./g1.js"',
        'import { G2 } from "./g2.js"',
        '@Controller()',
        '@UseGuards(G1, G2)',
        'export class PositionalController {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/array.controller.ts', [
        'import { Controller, UseGuards } from "@nestjs/common"',
        'import { G1 } from "./g1.js"',
        'import { G3 } from "./g3.js"',
        '@Controller()',
        '@UseGuards([G1, G3])',
        'export class ArrayController {}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const positionalId = classSymbol(spi, 'src/positional.controller.ts', 'PositionalController').id
      const positionalGuards = spi.edges.filter((e) => e.from === positionalId && e.kind === 'guards')
      expect(positionalGuards).toHaveLength(2)

      const arrayId = classSymbol(spi, 'src/array.controller.ts', 'ArrayController').id
      const arrayGuards = spi.edges.filter((e) => e.from === arrayId && e.kind === 'guards')
      expect(arrayGuards).toHaveLength(2)
    })

    it('emits intercepts edges from @UseInterceptors', () => {
      writeFile(sandbox, 'src/log.interceptor.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class LogInterceptor {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, UseInterceptors, Get } from "@nestjs/common"',
        'import { LogInterceptor } from "./log.interceptor.js"',
        '@Controller()',
        '@UseInterceptors(LogInterceptor)',
        'export class UsersController {',
        '  @Get() list(): void {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/users.controller.ts', 'UsersController').id
      const toId = classSymbol(spi, 'src/log.interceptor.ts', 'LogInterceptor').id
      const edge = spi.edges.find((e) => e.from === fromId && e.to === toId && e.kind === 'intercepts')
      expect(edge).toBeTruthy()
    })

    it('emits pipes edges from @UsePipes', () => {
      writeFile(sandbox, 'src/validate.pipe.ts', [
        'import { Injectable } from "@nestjs/common"',
        '@Injectable()',
        'export class ValidatePipe {}',
      ].join('\n') + '\n')
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, UsePipes, Post } from "@nestjs/common"',
        'import { ValidatePipe } from "./validate.pipe.js"',
        '@Controller()',
        'export class UsersController {',
        '  @UsePipes(ValidatePipe)',
        '  @Post() create(): void {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromMethod = methodSymbol(spi, 'src/users.controller.ts', 'UsersController.create').id
      const toId = classSymbol(spi, 'src/validate.pipe.ts', 'ValidatePipe').id
      const edge = spi.edges.find((e) => e.from === fromMethod && e.to === toId && e.kind === 'pipes')
      expect(edge).toBeTruthy()
    })

    it('emits a diagnostic for unresolvable @UseGuards targets (e.g. instance literal)', () => {
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, UseGuards, Get } from "@nestjs/common"',
        'class FakeGuard { constructor(_: number) {} }', // not @Injectable, not exported
        '@Controller()',
        '@UseGuards(new FakeGuard(1))',
        'export class UsersController {',
        '  @Get() list(): void {}',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const fromId = classSymbol(spi, 'src/users.controller.ts', 'UsersController').id
      const guards = spi.edges.filter((e) => e.from === fromId && e.kind === 'guards')
      expect(guards).toHaveLength(0)
      const diag = spi.diagnostics.find((d) => d.id.startsWith('spi.nest.use-decorator.unresolved'))
      expect(diag).toBeTruthy()
    })
  })

  describe('queue/job semantic edges', () => {
    it('emits enqueues_job edges for WorkerHost-style processors without @Process decorators', () => {
      writeFile(sandbox, 'src/pipeline.ts', [
        'import { Injectable } from "@nestjs/common"',
        '',
        'function Processor(_queueName: string): ClassDecorator {',
        '  return () => undefined',
        '}',
        '',
        'type PipelineJobPayload = {',
        '  problem: string',
        '  ideaId: string',
        '}',
        '',
        'type BullJob<T> = {',
        '  name: string',
        '  data: T',
        '}',
        '',
        'abstract class WorkerHost {',
        '  abstract process(job: BullJob<PipelineJobPayload>): Promise<string>',
        '}',
        '',
        'class PipelineQueue {',
        '  async add(jobName: string, input: PipelineJobPayload) {',
        '    return { id: `${input.ideaId}:${jobName}` }',
        '  }',
        '}',
        '',
        '@Injectable()',
        'export class QueueRegistryService {',
        '  private readonly pipelineQueue = new PipelineQueue()',
        '',
        '  async addJob(input: PipelineJobPayload) {',
        '    return this.pipelineQueue.add("legacy.pipeline.bridge.process", input)',
        '  }',
        '}',
        '',
        '@Processor("legacy.pipeline.bridge")',
        'export class OrchestratorWorker extends WorkerHost {',
        '  async process(job: BullJob<PipelineJobPayload>) {',
        '    return job.data.ideaId',
        '  }',
        '}',
      ].join('\n') + '\n')
      const spi = build(sandbox)

      const addJob = methodSymbol(spi, 'src/pipeline.ts', 'QueueRegistryService.addJob')
      const process = methodSymbol(spi, 'src/pipeline.ts', 'OrchestratorWorker.process')
      const edge = spi.edges.find((entry) => entry.from === addJob.id && entry.to === process.id && entry.kind === 'enqueues_job')

      expect(edge).toEqual(
        expect.objectContaining({
          kind: 'enqueues_job',
        }),
      )
      expect(spi.edges.find((entry) => entry.from === addJob.id && entry.to === process.id && entry.kind === 'calls')).toBeUndefined()
    })
  })
})
