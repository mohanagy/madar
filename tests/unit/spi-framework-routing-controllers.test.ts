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

const FROZEN_NOW = () => new Date('2026-05-22T01:50:00.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-routing-controllers-'))
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
    extractorVersion: 'spi-v1.0.0-routing-controllers',
    now: FROZEN_NOW,
  })
}

function fileIdFor(spi: SemanticProgramIndex, path: string): string {
  const file = spi.files.find((candidate) => candidate.path === path)
  if (!file) {
    throw new Error(`fixture missing SpiFile: ${path}`)
  }
  return file.id
}

function classSymbol(spi: SemanticProgramIndex, path: string, name: string): SpiSymbol {
  const fileId = fileIdFor(spi, path)
  const symbol = spi.symbols.find((candidate) =>
    candidate.file_id === fileId && candidate.kind === 'class' && candidate.name === name)
  if (!symbol) {
    throw new Error(`class symbol not found: ${name} in ${path}`)
  }
  return symbol
}

function methodSymbol(spi: SemanticProgramIndex, path: string, qualifiedName: string): SpiSymbol {
  const fileId = fileIdFor(spi, path)
  const symbol = spi.symbols.find((candidate) =>
    candidate.file_id === fileId && candidate.kind === 'method' && candidate.name === qualifiedName)
  if (!symbol) {
    throw new Error(`method symbol not found: ${qualifiedName} in ${path}`)
  }
  return symbol
}

function edge(spi: SemanticProgramIndex, from: string, to: string, kind: SpiEdgeKind): SpiEdge | undefined {
  return spi.edges.find((candidate) => candidate.from === from && candidate.to === to && candidate.kind === kind)
}

function writeRoutingControllersFixture(root: string): void {
  writeFile(root, 'src/dto/create-user.dto.ts', [
    'export class CreateUserDto {',
    '  constructor(public readonly email: string) {}',
    '}',
  ].join('\n') + '\n')
  writeFile(root, 'src/services/user.service.ts', [
    'import { CreateUserDto } from "../dto/create-user.dto.js"',
    '',
    'export function createUser(body: CreateUserDto): CreateUserDto {',
    '  return body',
    '}',
  ].join('\n') + '\n')
  writeFile(root, 'src/controllers/user.controller.ts', [
    'import {',
    '  Authorized,',
    '  Body,',
    '  Controller,',
    '  Delete,',
    '  Get,',
    '  JsonController,',
    '  Param,',
    '  Patch,',
    '  Post,',
    '  Put,',
    '  UseBefore,',
    '} from "routing-controllers"',
    'import { CreateUserDto } from "../dto/create-user.dto.js"',
    'import { createUser } from "../services/user.service.js"',
    '',
    'class RequestLogger {}',
    '',
    '@Controller("/admin")',
    'export class AdminController {',
    '  @Get("/health")',
    '  health(): string {',
    '    return "ok"',
    '  }',
    '}',
    '',
    '@JsonController("/users")',
    '@UseBefore(RequestLogger)',
    'export class UserController {',
    '  @Post("/")',
    '  @Authorized()',
    '  create(@Body() body: CreateUserDto): CreateUserDto {',
    '    return createUser(body)',
    '  }',
    '',
    '  @Put("/:id")',
    '  update(@Param("id") id: string, @Body() body: CreateUserDto): CreateUserDto {',
    '    void id',
    '    return body',
    '  }',
    '',
    '  @Patch("/:id")',
    '  patch(@Param("id") id: string, @Body() body: CreateUserDto): CreateUserDto {',
    '    void id',
    '    return body',
    '  }',
    '',
    '  @Delete("/:id")',
    '  remove(@Param("id") id: string): string {',
    '    return id',
    '  }',
    '}',
  ].join('\n') + '\n')
  writeFile(root, 'src/server.ts', [
    'import { createExpressServer } from "routing-controllers"',
    'import { AdminController, UserController } from "./controllers/user.controller.js"',
    '',
    'export const app = createExpressServer({',
    '  controllers: [UserController, AdminController],',
    '})',
  ].join('\n') + '\n')
  writeFile(root, 'src/server-express-use.ts', [
    'import { useExpressServer } from "routing-controllers"',
    'import { UserController } from "./controllers/user.controller.js"',
    '',
    'const app = {}',
    'useExpressServer(app, { controllers: [UserController] })',
  ].join('\n') + '\n')
  writeFile(root, 'src/server-koa-create.ts', [
    'import { createKoaServer } from "routing-controllers"',
    'import { AdminController } from "./controllers/user.controller.js"',
    '',
    'export const app = createKoaServer({ controllers: [AdminController] })',
  ].join('\n') + '\n')
  writeFile(root, 'src/server-koa-use.ts', [
    'import { useKoaServer } from "routing-controllers"',
    'import { UserController } from "./controllers/user.controller.js"',
    '',
    'const app = {}',
    'useKoaServer(app, { controllers: [UserController] })',
  ].join('\n') + '\n')
}

describe('buildSpi routing-controllers framework detector', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox()
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('tags controller classes and route methods with routing-controllers metadata', () => {
    writeRoutingControllersFixture(sandbox)
    const spi = build(sandbox)

    const adminController = classSymbol(spi, 'src/controllers/user.controller.ts', 'AdminController')
    const userController = classSymbol(spi, 'src/controllers/user.controller.ts', 'UserController')
    const createMethod = methodSymbol(spi, 'src/controllers/user.controller.ts', 'UserController.create')
    const updateMethod = methodSymbol(spi, 'src/controllers/user.controller.ts', 'UserController.update')

    expect(adminController.framework_role).toBe('routing_controllers_controller')
    expect(userController.framework_role).toBe('routing_controllers_controller')

    expect(createMethod.framework_role).toBe('routing_controllers_route')
    expect(createMethod.framework_metadata?.http_method).toBe('POST')
    expect(createMethod.framework_metadata?.route_path).toBe('/users')

    expect(updateMethod.framework_role).toBe('routing_controllers_route')
    expect(updateMethod.framework_metadata?.http_method).toBe('PUT')
    expect(updateMethod.framework_metadata?.route_path).toBe('/users/:id')
  })

  it('emits controller_route edges from the controller class to each decorated route method', () => {
    writeRoutingControllersFixture(sandbox)
    const spi = build(sandbox)

    const controllerId = classSymbol(spi, 'src/controllers/user.controller.ts', 'UserController').id
    const createId = methodSymbol(spi, 'src/controllers/user.controller.ts', 'UserController.create').id
    const updateId = methodSymbol(spi, 'src/controllers/user.controller.ts', 'UserController.update').id

    expect(edge(spi, controllerId, createId, 'controller_route')).toBeTruthy()
    expect(edge(spi, controllerId, updateId, 'controller_route')).toBeTruthy()
  })

  it('represents bootstrap registration from createExpressServer controllers arrays', () => {
    writeRoutingControllersFixture(sandbox)
    const spi = build(sandbox)

    const serverFileId = fileIdFor(spi, 'src/server.ts')
    const userControllerId = classSymbol(spi, 'src/controllers/user.controller.ts', 'UserController').id
    const adminControllerId = classSymbol(spi, 'src/controllers/user.controller.ts', 'AdminController').id

    expect(edge(spi, serverFileId, userControllerId, 'registers_controller')).toBeTruthy()
    expect(edge(spi, serverFileId, adminControllerId, 'registers_controller')).toBeTruthy()
  })

  it('covers additional HTTP decorators and bootstrap helpers', () => {
    writeRoutingControllersFixture(sandbox)
    const spi = build(sandbox)

    const healthMethod = methodSymbol(spi, 'src/controllers/user.controller.ts', 'AdminController.health')
    const patchMethod = methodSymbol(spi, 'src/controllers/user.controller.ts', 'UserController.patch')
    const removeMethod = methodSymbol(spi, 'src/controllers/user.controller.ts', 'UserController.remove')
    const adminControllerId = classSymbol(spi, 'src/controllers/user.controller.ts', 'AdminController').id
    const userControllerId = classSymbol(spi, 'src/controllers/user.controller.ts', 'UserController').id

    expect(healthMethod.framework_metadata?.http_method).toBe('GET')
    expect(healthMethod.framework_metadata?.route_path).toBe('/admin/health')
    expect(patchMethod.framework_metadata?.http_method).toBe('PATCH')
    expect(patchMethod.framework_metadata?.route_path).toBe('/users/:id')
    expect(removeMethod.framework_metadata?.http_method).toBe('DELETE')
    expect(removeMethod.framework_metadata?.route_path).toBe('/users/:id')

    expect(edge(spi, adminControllerId, healthMethod.id, 'controller_route')).toBeTruthy()
    expect(edge(spi, userControllerId, patchMethod.id, 'controller_route')).toBeTruthy()
    expect(edge(spi, userControllerId, removeMethod.id, 'controller_route')).toBeTruthy()

    expect(edge(spi, fileIdFor(spi, 'src/server-express-use.ts'), userControllerId, 'registers_controller')).toBeTruthy()
    expect(edge(spi, fileIdFor(spi, 'src/server-koa-create.ts'), adminControllerId, 'registers_controller')).toBeTruthy()
    expect(edge(spi, fileIdFor(spi, 'src/server-koa-use.ts'), userControllerId, 'registers_controller')).toBeTruthy()
  })
})
