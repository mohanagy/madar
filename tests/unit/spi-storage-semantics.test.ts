import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExtractionData } from '../../src/contracts/types.js'
import { buildSpi } from '../../src/pipeline/spi/build.js'
import { projectSpiToExtraction } from '../../src/pipeline/spi/projector.js'
import type { SemanticProgramIndex, SpiSymbol, SpiSymbolKind } from '../../src/pipeline/spi/types.js'

const FROZEN_NOW = () => new Date('2026-05-14T00:00:00.000Z')

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
    extractorVersion: 'spi-v1.0.0-storage-semantics',
    now: FROZEN_NOW,
  })
}

function buildExtraction(root: string): ExtractionData {
  return projectSpiToExtraction(build(root), { root })
}

type StorageTaggedEntity = {
  framework_role?: string | undefined
  framework_metadata?: Record<string, unknown> | undefined
}

function findSymbol(
  spi: SemanticProgramIndex,
  path: string,
  name: string,
  kind: SpiSymbolKind,
): SpiSymbol | undefined {
  const file = spi.files.find((entry) => entry.path === path)
  if (!file) return undefined
  return spi.symbols.find((entry) => entry.file_id === file.id && entry.name === name && entry.kind === kind)
}

function hasDirectPrismaOperationLabel(label: string, operation: string): boolean {
  return label === operation
    || label === `${operation}()`
    || label === `.${operation}()`
    || label.endsWith(`.${operation}`)
    || label.endsWith(`.${operation}()`)
}

function asFrameworkMetadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function findPrismaOperationNode(
  extraction: ExtractionData,
  path: string,
  operation: string,
): StorageTaggedEntity | undefined {
  const entry = extraction.nodes.find((candidate) => {
    const metadata = asFrameworkMetadata(candidate.framework_metadata)
    return candidate.source_file.replaceAll('\\', '/').endsWith(path)
      && (
        candidate.framework_role === 'prisma_model_reader'
        || candidate.framework_role === 'prisma_model_writer'
      )
      && metadata?.storage_operation === operation
      && hasDirectPrismaOperationLabel(candidate.label, operation)
  })
  if (!entry) return undefined

  return {
    framework_role: typeof entry.framework_role === 'string' ? entry.framework_role : undefined,
    framework_metadata: asFrameworkMetadata(entry.framework_metadata),
  }
}

function expectStorageOperation(
  symbol: StorageTaggedEntity | Pick<SpiSymbol, 'framework_role' | 'framework_metadata'> | undefined,
  expected: {
    role?: string | RegExp
    operation: string
  },
): void {
  expect(symbol).toBeDefined()
  if (expected.role instanceof RegExp) {
    expect(String(symbol?.framework_role ?? '')).toMatch(expected.role)
  } else if (typeof expected.role === 'string') {
    expect(symbol?.framework_role).toBe(expected.role)
  } else {
    expect(symbol?.framework_role).toBeDefined()
  }
  expect(symbol?.framework_metadata?.storage_operation).toBe(expected.operation)
}

const REPOSITORY_PERSISTENCE_READER_ROLE = /^repository_(?:reader|read)$/
const REPOSITORY_PERSISTENCE_WRITER_ROLE = /^repository_(?:writer|write)$/

function expectRepositoryPersistenceOperation(
  symbol: StorageTaggedEntity | Pick<SpiSymbol, 'framework_role' | 'framework_metadata'> | undefined,
  expected: {
    operation: string
    role: RegExp
  },
): void {
  expectStorageOperation(symbol, expected)
  expect(symbol?.framework_role).not.toMatch(/^prisma_model_/)
}

describe('SPI storage operation semantics regressions (#185)', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkSandbox('spi-storage-semantics-')
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('tags actual Prisma model operations with storage-oriented Prisma metadata', () => {
    writeFile(sandbox, 'src/db.ts', [
      'import { PrismaClient } from "@prisma/client"',
      'export const prisma = new PrismaClient()',
      'export async function findUserById(id: string) {',
      '  return prisma.user.findUnique({ where: { id } })',
      '}',
      'export async function listUsers() {',
      '  return prisma.user.findMany()',
      '}',
      'export async function createUser(email: string) {',
      '  return prisma.user.create({ data: { email } })',
      '}',
      'export async function updateUser(id: string, email: string) {',
      '  return prisma.user.update({ where: { id }, data: { email } })',
      '}',
      'export async function upsertUser(id: string, email: string) {',
      '  return prisma.user.upsert({',
      '    where: { id },',
      '    update: { email },',
      '    create: { id, email },',
      '  })',
      '}',
      'export async function persistUsersInTransaction(email: string) {',
      '  return prisma.$transaction([',
      '    prisma.user.create({ data: { email } }),',
      '    prisma.user.findMany(),',
      '  ])',
      '}',
    ].join('\n') + '\n')

    const spi = build(sandbox)
    const extraction = buildExtraction(sandbox)

    for (const wrapperName of [
      'findUserById',
      'listUsers',
      'createUser',
      'updateUser',
      'upsertUser',
      'persistUsersInTransaction',
    ] as const) {
      expect(findSymbol(spi, 'src/db.ts', wrapperName, 'function')).toBeDefined()
    }

    expectStorageOperation(
      findPrismaOperationNode(extraction, 'src/db.ts', 'findUnique'),
      { role: 'prisma_model_reader', operation: 'findUnique' },
    )
    expectStorageOperation(
      findPrismaOperationNode(extraction, 'src/db.ts', 'findMany'),
      { role: 'prisma_model_reader', operation: 'findMany' },
    )
    expectStorageOperation(
      findPrismaOperationNode(extraction, 'src/db.ts', 'create'),
      { role: 'prisma_model_writer', operation: 'create' },
    )
    expectStorageOperation(
      findPrismaOperationNode(extraction, 'src/db.ts', 'update'),
      { role: 'prisma_model_writer', operation: 'update' },
    )
    expectStorageOperation(
      findPrismaOperationNode(extraction, 'src/db.ts', 'upsert'),
      { role: 'prisma_model_writer', operation: 'upsert' },
    )
    expectStorageOperation(
      findPrismaOperationNode(extraction, 'src/db.ts', '$transaction'),
      { role: 'prisma_model_writer', operation: '$transaction' },
    )
  })

  it('classifies repository-style CRUD methods as persistence endpoints', () => {
    writeFile(sandbox, 'src/report.repository.ts', [
      'export class ReportRepository {',
      '  async save(): Promise<void> {}',
      '  async create(): Promise<void> {}',
      '  async update(): Promise<void> {}',
      '  async upsert(): Promise<void> {}',
      '  async findUnique(): Promise<void> {}',
      '  async findMany(): Promise<void> {}',
      '}',
    ].join('\n') + '\n')

    const spi = build(sandbox)

    expectRepositoryPersistenceOperation(
      findSymbol(spi, 'src/report.repository.ts', 'ReportRepository.save', 'method'),
      { role: REPOSITORY_PERSISTENCE_WRITER_ROLE, operation: 'save' },
    )
    expectRepositoryPersistenceOperation(
      findSymbol(spi, 'src/report.repository.ts', 'ReportRepository.create', 'method'),
      { role: REPOSITORY_PERSISTENCE_WRITER_ROLE, operation: 'create' },
    )
    expectRepositoryPersistenceOperation(
      findSymbol(spi, 'src/report.repository.ts', 'ReportRepository.update', 'method'),
      { role: REPOSITORY_PERSISTENCE_WRITER_ROLE, operation: 'update' },
    )
    expectRepositoryPersistenceOperation(
      findSymbol(spi, 'src/report.repository.ts', 'ReportRepository.upsert', 'method'),
      { role: REPOSITORY_PERSISTENCE_WRITER_ROLE, operation: 'upsert' },
    )
    expectRepositoryPersistenceOperation(
      findSymbol(spi, 'src/report.repository.ts', 'ReportRepository.findUnique', 'method'),
      { role: REPOSITORY_PERSISTENCE_READER_ROLE, operation: 'findUnique' },
    )
    expectRepositoryPersistenceOperation(
      findSymbol(spi, 'src/report.repository.ts', 'ReportRepository.findMany', 'method'),
      { role: REPOSITORY_PERSISTENCE_READER_ROLE, operation: 'findMany' },
    )
  })

  it('does not tag generic helper names outside repository or ORM contexts', () => {
    writeFile(sandbox, 'src/helpers.ts', [
      'export function save(value: string): string {',
      '  return value.trim()',
      '}',
      'export class DraftBuffer {',
      '  save(value: string): string {',
      '    return value',
      '  }',
      '}',
      'export class ReportFormatter {',
      '  create(value: string): string {',
      '    return value.toUpperCase()',
      '  }',
      '  update(value: string): string {',
      '    return value.toLowerCase()',
      '  }',
      '  upsert(value: string): string {',
      '    return value',
      '  }',
      '  findUnique(values: string[]): string | undefined {',
      '    return values[0]',
      '  }',
      '  findMany(values: string[]): string[] {',
      '    return values',
      '  }',
      '}',
    ].join('\n') + '\n')

    const spi = build(sandbox)

    const genericSymbols = [
      findSymbol(spi, 'src/helpers.ts', 'save', 'function'),
      findSymbol(spi, 'src/helpers.ts', 'DraftBuffer.save', 'method'),
      findSymbol(spi, 'src/helpers.ts', 'ReportFormatter.create', 'method'),
      findSymbol(spi, 'src/helpers.ts', 'ReportFormatter.update', 'method'),
      findSymbol(spi, 'src/helpers.ts', 'ReportFormatter.upsert', 'method'),
      findSymbol(spi, 'src/helpers.ts', 'ReportFormatter.findUnique', 'method'),
      findSymbol(spi, 'src/helpers.ts', 'ReportFormatter.findMany', 'method'),
    ]

    for (const symbol of genericSymbols) {
      expect(symbol).toBeDefined()
      expect(symbol?.framework_role).toBeUndefined()
      expect(symbol?.framework_metadata?.storage_operation).toBeUndefined()
    }
  })
})
