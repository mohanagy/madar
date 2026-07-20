import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateGraph } from '../../src/infrastructure/generate.js'
import { buildGraphSummary } from '../../src/runtime/graph-summary.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'
import { loadGraph } from '../../src/runtime/serve.js'

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'routing-controllers-runtime-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function writeRoutingControllersWorkspace(root: string): void {
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
    'import { Body, JsonController, Post } from "routing-controllers"',
    'import { CreateUserDto } from "../dto/create-user.dto.js"',
    'import { createUser } from "../services/user.service.js"',
    '',
    '@JsonController("/users")',
    'export class UserController {',
    '  @Post("/")',
    '  create(@Body() body: CreateUserDto): CreateUserDto {',
    '    return createUser(body)',
    '  }',
    '}',
  ].join('\n') + '\n')
  writeFile(root, 'src/server.ts', [
    'import { createExpressServer } from "routing-controllers"',
    'import { UserController } from "./controllers/user.controller.js"',
    '',
    'export const app = createExpressServer({ controllers: [UserController] })',
  ].join('\n') + '\n')
}

describe('routing-controllers runtime surfaces', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox()
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('includes routing-controllers in graph_summary and surfaces routing entrypoints', () => {
    writeRoutingControllersWorkspace(sandbox)

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const summary = buildGraphSummary(graph)

    expect(summary.frameworks).toContain('routing-controllers')
    expect(summary.entrypoints.map((entrypoint) => entrypoint.label)).toEqual(
      expect.arrayContaining(['UserController']),
    )
  })

  it('retrieves the routing-controller route, service call, and DTO for a route question', () => {
    writeRoutingControllersWorkspace(sandbox)

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const retrieved = retrieveContext(graph, {
      question: 'Explain the user creation route in routing-controllers',
      budget: 2500,
    })

    const labels = retrieved.matched_nodes.map((node) => node.label)
    const routeMethod = retrieved.matched_nodes.find((node) => node.label === '.create()')
    expect(labels).toContain('UserController')
    expect(labels).toContain('.create()')
    expect(labels).toContain('createUser()')
    expect(labels).toContain('CreateUserDto')
    expect(routeMethod?.framework_boost ?? 0).toBeGreaterThan(0)
  })

  it('retrieves routing-controller nodes for generic HTTP verb and controller questions', () => {
    writeRoutingControllersWorkspace(sandbox)

    const result = generateGraph(sandbox, { useSpi: true })
    const graph = loadGraph(result.graphPath)
    const httpRetrieved = retrieveContext(graph, {
      question: 'Explain POST /users',
      budget: 2500,
    })
    const controllerRetrieved = retrieveContext(graph, {
      question: 'Which controller handles user creation?',
      budget: 2500,
    })

    const httpLabels = httpRetrieved.matched_nodes.map((node) => node.label)
    const httpRouteMethod = httpRetrieved.matched_nodes.find((node) => node.label === '.create()')
    const controllerLabels = controllerRetrieved.matched_nodes.map((node) => node.label)
    const controllerNode = controllerRetrieved.matched_nodes.find((node) => node.label === 'UserController')

    expect(httpLabels).toEqual(
      expect.arrayContaining(['UserController', '.create()', 'createUser()', 'CreateUserDto']),
    )
    expect(httpRouteMethod?.framework_boost ?? 0).toBeGreaterThan(0)
    expect(controllerLabels).toContain('UserController')
    expect(controllerNode?.framework_boost ?? 0).toBeGreaterThan(0)
  })
})
