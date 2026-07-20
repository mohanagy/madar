import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildGraphFromExtraction } from '../../src/application/build-graph.js'
import { buildSpi } from '../../src/pipeline/spi/build.js'
import { projectSpiToExtraction } from '../../src/pipeline/spi/projector.js'
import type { SemanticProgramIndex, SpiSymbol, SpiSymbolKind } from '../../src/pipeline/spi/types.js'
import type { ExtractionData, ExtractionNode } from '../../src/contracts/types.js'

const FROZEN_NOW = () => new Date('2026-06-09T09:00:00.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-scoped-root-tsconfig-'))
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = join(root, relPath)
  mkdirSync(join(absPath, '..'), { recursive: true })
  writeFileSync(absPath, content, 'utf8')
}

function findSymbol(
  spi: SemanticProgramIndex,
  filePath: string,
  name: string,
  kind: SpiSymbolKind,
): SpiSymbol {
  const file = spi.files.find((entry) => entry.path === filePath)
  if (!file) {
    throw new Error(`fixture missing SpiFile: ${filePath}`)
  }

  const symbol = spi.symbols.find(
    (entry) => entry.file_id === file.id && entry.kind === kind && entry.name === name,
  )
  if (!symbol) {
    throw new Error(`fixture missing ${kind} ${name} in ${filePath}`)
  }

  return symbol
}

function findProjectedNode(
  extraction: ExtractionData,
  fileSuffix: string,
  label: string,
): ExtractionNode {
  const node = extraction.nodes.find(
    (entry) => entry.label === label && entry.source_file.replaceAll('\\', '/').endsWith(fileSuffix),
  )
  if (!node) {
    throw new Error(`expected projected node not found: ${label} in ${fileSuffix}`)
  }
  return node
}

describe('SPI scoped roots reuse ancestor tsconfig project context', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox()
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('keeps alias-based Nest inject and call edges when the graph root is a nested engine directory', () => {
    writeFile(
      sandbox,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            'src/*': ['packages/twenty-server/src/*'],
          },
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2020',
          experimentalDecorators: true,
        },
      }, null, 2) + '\n',
    )

    writeFile(
      sandbox,
      'packages/twenty-server/src/engine/api/common/common-create-one-query-runner.service.ts',
      [
        'import { Injectable } from "@nestjs/common"',
        '',
        '@Injectable()',
        'export class CommonCreateOneQueryRunnerService {',
        '  execute() {',
        '    return true',
        '  }',
        '}',
      ].join('\n') + '\n',
    )

    writeFile(
      sandbox,
      'packages/twenty-server/src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts',
      [
        'import { Injectable } from "@nestjs/common"',
        'import { CommonCreateOneQueryRunnerService } from "src/engine/api/common/common-create-one-query-runner.service"',
        '',
        '@Injectable()',
        'export class CreateOneResolverFactory {',
        '  constructor(private readonly commonCreateOneQueryRunnerService: CommonCreateOneQueryRunnerService) {}',
        '',
        '  create() {',
        '    return async () => {',
        '      return this.commonCreateOneQueryRunnerService.execute()',
        '    }',
        '  }',
        '}',
      ].join('\n') + '\n',
    )

    writeFile(
      sandbox,
      'packages/twenty-server/src/engine/api/graphql/direct-execution/direct-execution.service.ts',
      [
        'import { Injectable } from "@nestjs/common"',
        'import { CreateOneResolverFactory } from "src/engine/api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory"',
        '',
        '@Injectable()',
        'export class DirectExecutionService {',
        '  constructor(private readonly createOneResolverFactory: CreateOneResolverFactory) {}',
        '',
        '  async executeField() {',
        '    const resolver = this.createOneResolverFactory.create()',
        '    return resolver()',
        '  }',
        '}',
      ].join('\n') + '\n',
    )

    const engineRoot = resolve(sandbox, 'packages/twenty-server/src/engine')
    const spi = buildSpi({
      root: engineRoot,
      madarVersion: 'test-0.0.0',
      extractorVersion: 'spi-v1.0.0-scoped-root-tsconfig',
      now: FROZEN_NOW,
    })

    const directExecutionService = findSymbol(
      spi,
      'api/graphql/direct-execution/direct-execution.service.ts',
      'DirectExecutionService',
      'class',
    )
    const createOneResolverFactory = findSymbol(
      spi,
      'api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts',
      'CreateOneResolverFactory',
      'class',
    )
    const executeField = findSymbol(
      spi,
      'api/graphql/direct-execution/direct-execution.service.ts',
      'DirectExecutionService.executeField',
      'method',
    )
    const create = findSymbol(
      spi,
      'api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts',
      'CreateOneResolverFactory.create',
      'method',
    )
    const queryRunnerExecute = findSymbol(
      spi,
      'api/common/common-create-one-query-runner.service.ts',
      'CommonCreateOneQueryRunnerService.execute',
      'method',
    )

    expect(spi.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'injects',
        from: directExecutionService.id,
        to: createOneResolverFactory.id,
      }),
      expect.objectContaining({
        kind: 'calls',
        from: executeField.id,
        to: create.id,
      }),
      expect.objectContaining({
        kind: 'calls',
        from: create.id,
        to: queryRunnerExecute.id,
      }),
    ]))

    const extraction = projectSpiToExtraction(spi, { root: engineRoot })
    const projectedExecuteField = findProjectedNode(
      extraction,
      'api/graphql/direct-execution/direct-execution.service.ts',
      '.executeField()',
    )
    const projectedDirectExecutionService = findProjectedNode(
      extraction,
      'api/graphql/direct-execution/direct-execution.service.ts',
      'DirectExecutionService',
    )
    const projectedCreateOneResolverFactory = findProjectedNode(
      extraction,
      'api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts',
      'CreateOneResolverFactory',
    )
    const projectedCreate = findProjectedNode(
      extraction,
      'api/graphql/workspace-resolver-builder/factories/create-one-resolver.factory.ts',
      '.create()',
    )
    const projectedQueryRunnerExecute = findProjectedNode(
      extraction,
      'api/common/common-create-one-query-runner.service.ts',
      '.execute()',
    )

    expect(extraction.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: projectedDirectExecutionService.id,
        target: projectedCreateOneResolverFactory.id,
        relation: 'injects',
      }),
      expect.objectContaining({
        source: projectedExecuteField.id,
        target: projectedCreate.id,
        relation: 'calls',
      }),
      expect.objectContaining({
        source: projectedCreate.id,
        target: projectedQueryRunnerExecute.id,
        relation: 'calls',
      }),
    ]))

    const graph = buildGraphFromExtraction({ ...extraction, root_path: engineRoot })

    expect(graph.uniqueEdgeBetween(projectedDirectExecutionService.id, projectedCreateOneResolverFactory.id).attributes.relation).toBe('injects')
    expect(graph.uniqueEdgeBetween(projectedExecuteField.id, projectedCreate.id).attributes.relation).toBe('calls')
    expect(graph.uniqueEdgeBetween(projectedCreate.id, projectedQueryRunnerExecute.id).attributes.relation).toBe('calls')
  })
})
