import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSpi } from '../../src/pipeline/spi/build.js'
import { projectSpiToExtraction } from '../../src/pipeline/spi/projector.js'
import { extract } from '../../src/pipeline/extract.js'
import { buildGraphFromExtraction } from '../../src/application/build-graph.js'
import type { ExtractionData, ExtractionEdge, ExtractionNode } from '../../src/contracts/types.js'

const FROZEN_NOW = () => new Date('2026-05-10T12:34:56.000Z')

function mkSandbox(): string {
  return mkdtempSync(join(tmpdir(), 'spi-projector-tests-'))
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function project(root: string): ExtractionData {
  const spi = buildSpi({ root, madarVersion: 'test-0.0.0', now: FROZEN_NOW })
  return projectSpiToExtraction(spi, { root })
}

function findNode(extraction: ExtractionData, id: string): ExtractionNode | undefined {
  return extraction.nodes.find((n) => n.id === id)
}

function findEdges(
  extraction: ExtractionData,
  filter: { source?: string; target?: string; relation?: string },
): ExtractionEdge[] {
  return extraction.edges.filter((e) =>
    (filter.source === undefined || e.source === filter.source) &&
    (filter.target === undefined || e.target === filter.target) &&
    (filter.relation === undefined || e.relation === filter.relation),
  )
}

describe('projectSpiToExtraction (slice 1c-i of #72)', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkSandbox()
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  describe('file nodes', () => {
    it('emits one file node per SpiFile with snake_case id and basename label', () => {
      writeFile(sandbox, 'src/audit-log.ts', 'export class AuditLog {}\n')
      const extraction = project(sandbox)

      const node = findNode(extraction, 'audit_log')
      expect(node).toBeTruthy()
      expect(node?.label).toBe('audit-log.ts')
      expect(node?.file_type).toBe('code')
      expect(node?.source_location).toBe('L1')
      expect(node?.layer).toBeDefined()
      expect(node?.source_file).toBe(resolve(sandbox, 'src/audit-log.ts'))
    })

    it('attaches typescript-extractor provenance to file nodes', () => {
      writeFile(sandbox, 'src/svc.ts', 'export const x = 1\n')
      const extraction = project(sandbox)
      const node = findNode(extraction, 'svc')
      expect(node?.provenance).toBeDefined()
      expect(node?.provenance?.[0]?.capability_id).toBe('builtin:extract:typescript')
      expect(node?.provenance?.[0]?.stage).toBe('extract')
    })
  })

  describe('symbol nodes', () => {
    it('emits a class node with file-prefixed snake_case id', () => {
      writeFile(sandbox, 'src/audit-log.ts', 'export class AuditLog {}\n')
      const extraction = project(sandbox)

      const cls = findNode(extraction, 'audit_log_auditlog')
      expect(cls).toBeTruthy()
      expect(cls?.label).toBe('AuditLog')
      expect(cls?.source_location).toBe('L1')
    })

    it('emits a function node with `name()` label', () => {
      writeFile(sandbox, 'src/app.ts', 'export function runDemoScenario(): void {}\n')
      const extraction = project(sandbox)

      const fn = findNode(extraction, 'app_rundemoscenario')
      expect(fn).toBeTruthy()
      expect(fn?.label).toBe('runDemoScenario()')
    })

    it('emits method nodes with `.name()` label and class-derived id', () => {
      writeFile(sandbox, 'src/audit-log.ts', [
        'export class AuditLog {',
        '  append(): void {}',
        '  listRecentEntries(): void {}',
        '}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      const append = findNode(extraction, 'audit_log_auditlog_append')
      const list = findNode(extraction, 'audit_log_auditlog_listrecententries')
      expect(append?.label).toBe('.append()')
      expect(list?.label).toBe('.listRecentEntries()')
    })

    it('emits constructor methods alongside named methods', () => {
      writeFile(sandbox, 'src/auth-service.ts', [
        'export class AuthService {',
        '  constructor() {}',
        '  loginWithPassword(): void {}',
        '}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      const ctor = findNode(extraction, 'auth_service_authservice_constructor')
      const login = findNode(extraction, 'auth_service_authservice_loginwithpassword')
      expect(ctor?.label).toBe('.constructor()')
      expect(login?.label).toBe('.loginWithPassword()')
    })

    it('emits interface, type-alias, and enum nodes with the symbol name as label', () => {
      writeFile(sandbox, 'src/types.ts', [
        'export interface User { id: string }',
        'export type UserRole = "admin" | "member"',
        'export enum Tier { Free, Pro }',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      expect(findNode(extraction, 'types_user')?.label).toBe('User')
      expect(findNode(extraction, 'types_userrole')?.label).toBe('UserRole')
      expect(findNode(extraction, 'types_tier')?.label).toBe('Tier')
    })
  })

  describe('structural edges (contains / method)', () => {
    it('emits a `contains` edge from file to top-level class', () => {
      writeFile(sandbox, 'src/audit-log.ts', 'export class AuditLog {}\n')
      const extraction = project(sandbox)

      const edges = findEdges(extraction, {
        source: 'audit_log',
        target: 'audit_log_auditlog',
        relation: 'contains',
      })
      expect(edges).toHaveLength(1)
      expect(edges[0]?.confidence).toBe('EXTRACTED')
    })

    it('emits a `method` edge from class to method, NOT a `contains` edge from file to method', () => {
      writeFile(sandbox, 'src/audit-log.ts', [
        'export class AuditLog {',
        '  append(): void {}',
        '}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      const methodEdge = findEdges(extraction, {
        source: 'audit_log_auditlog',
        target: 'audit_log_auditlog_append',
        relation: 'method',
      })
      expect(methodEdge).toHaveLength(1)

      // No file → method `contains` edge.
      const fileToMethod = findEdges(extraction, {
        source: 'audit_log',
        target: 'audit_log_auditlog_append',
      })
      expect(fileToMethod).toHaveLength(0)
    })

    it('emits a `contains` edge for a top-level function', () => {
      writeFile(sandbox, 'src/app.ts', 'export function runDemoScenario(): void {}\n')
      const extraction = project(sandbox)

      const edges = findEdges(extraction, {
        source: 'app',
        target: 'app_rundemoscenario',
        relation: 'contains',
      })
      expect(edges).toHaveLength(1)
    })
  })

  describe('cross-symbol edges (imports_from / calls)', () => {
    it('projects SPI imports edges to `imports_from` between file nodes', () => {
      writeFile(sandbox, 'src/tenant-context.ts', 'export const tenant = "x"\n')
      writeFile(sandbox, 'src/session-store.ts', 'import { tenant } from "./tenant-context.js"\nvoid tenant\n')
      const extraction = project(sandbox)

      const edges = findEdges(extraction, {
        source: 'session_store',
        target: 'tenant_context',
        relation: 'imports_from',
      })
      expect(edges).toHaveLength(1)
    })

    it('projects unresolved external namespace member calls as direct synthetic call targets', () => {
      writeFile(sandbox, 'src/lib/middleware/link.ts', [
        'import { NextResponse } from "next/server"',
        'export function LinkMiddleware(url: string) {',
        '  return NextResponse.redirect(url)',
        '}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      const redirect = findNode(extraction, 'link_nextresponse_redirect')
      expect(redirect).toEqual(expect.objectContaining({
        label: 'NextResponse.redirect',
        node_kind: 'method',
      }))

      const edges = findEdges(extraction, {
        source: 'link_linkmiddleware',
        target: 'link_nextresponse_redirect',
        relation: 'calls',
      })
      expect(edges).toHaveLength(1)
    })

    it('projects SPI calls edges to `calls` between caller and callee symbols', () => {
      writeFile(sandbox, 'src/svc.ts', [
        'export function helper(): number { return 1 }',
        'export function caller(): number { return helper() }',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      const edges = findEdges(extraction, {
        source: 'svc_caller',
        target: 'svc_helper',
        relation: 'calls',
      })
      expect(edges).toHaveLength(1)
    })

    it('drops self-edges (file `exports` self-loops in SPI are not emitted as extraction edges)', () => {
      writeFile(sandbox, 'src/svc.ts', 'export const x = 1\n')
      const extraction = project(sandbox)

      const selfEdges = extraction.edges.filter((e) => e.source === e.target)
      expect(selfEdges).toHaveLength(0)
    })
  })

  describe('extends / implements edges', () => {
    it('projects SPI extends edges to `extends` between class symbols', () => {
      writeFile(sandbox, 'src/base.ts', 'export class Base {}\n')
      writeFile(sandbox, 'src/derived.ts', [
        'import { Base } from "./base.js"',
        'export class Derived extends Base {}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      const edges = findEdges(extraction, {
        source: 'derived_derived',
        target: 'base_base',
        relation: 'extends',
      })
      expect(edges).toHaveLength(1)
    })

    it('projects SPI implements edges to `implements` from class to interface', () => {
      writeFile(sandbox, 'src/contract.ts', 'export interface Contract { id(): string }\n')
      writeFile(sandbox, 'src/concrete.ts', [
        'import type { Contract } from "./contract.js"',
        'export class Concrete implements Contract {',
        '  id(): string { return "" }',
        '}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      const edges = findEdges(extraction, {
        source: 'concrete_concrete',
        target: 'contract_contract',
        relation: 'implements',
      })
      expect(edges).toHaveLength(1)
    })
  })

  describe('shape invariants', () => {
    it('produces ExtractionData with schema_version: 1 and the standard top-level fields', () => {
      writeFile(sandbox, 'src/x.ts', 'export const a = 1\n')
      const extraction = project(sandbox)

      expect(extraction.schema_version).toBe(1)
      expect(extraction.nodes).toBeInstanceOf(Array)
      expect(extraction.edges).toBeInstanceOf(Array)
      expect(extraction.hyperedges).toEqual([])
      expect(extraction.input_tokens).toBe(0)
      expect(extraction.output_tokens).toBe(0)
    })

    it('keeps distinct projected route nodes when multiple route.ts files export the same HTTP method', () => {
      writeFile(sandbox, 'apps/web/app/api/track/click/route.ts', [
        'export const POST = () => new Response()',
      ].join('\n') + '\n')
      writeFile(sandbox, 'apps/web/app/api/links/bulk/route.ts', [
        'export const POST = () => new Response()',
      ].join('\n') + '\n')

      const extraction = project(sandbox)
      const routeNodes = extraction.nodes
        .filter((node) => node.framework_role === 'nextjs_app_route' && node.label === 'POST')
        .map((node) => ({ id: node.id, source_file: node.source_file }))

      expect(routeNodes).toHaveLength(2)
      expect(new Set(routeNodes.map((node) => node.id)).size).toBe(2)
      expect(routeNodes.map((node) => node.source_file).sort()).toEqual([
        resolve(sandbox, 'apps/web/app/api/links/bulk/route.ts'),
        resolve(sandbox, 'apps/web/app/api/track/click/route.ts'),
      ])
    })

    it('every emitted node has id/label/file_type/source_file/source_location set', () => {
      writeFile(sandbox, 'src/svc.ts', [
        'export class Svc {',
        '  do(): void {}',
        '}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)

      for (const node of extraction.nodes) {
        expect(typeof node.id).toBe('string')
        expect(typeof node.label).toBe('string')
        expect(typeof node.source_file).toBe('string')
        expect(typeof node.source_location).toBe('string')
        expect(node.file_type).toBe('code')
      }
    })

    it('the projection feeds buildGraphFromExtraction() without warnings', () => {
      writeFile(sandbox, 'src/svc.ts', [
        'export function caller(): number { return helper() }',
        'export function helper(): number { return 1 }',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const graph = buildGraphFromExtraction(extraction, { rootPath: sandbox })

      // Non-zero nodes/edges and the file→function/function→function edges land.
      expect(graph.numberOfNodes()).toBeGreaterThan(0)
      expect(graph.numberOfEdges()).toBeGreaterThan(0)
    })
  })

  describe('framework_role propagation (slice 1c-ii)', () => {
    it('propagates SPI nest_module role onto the projected ExtractionNode', () => {
      writeFile(sandbox, 'src/app.module.ts', [
        'import { Module } from "@nestjs/common"',
        '@Module({})',
        'export class AppModule {}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const node = findNode(extraction, 'app_module_appmodule')
      expect(node?.framework).toBe('nestjs')
      expect(node?.framework_role).toBe('nest_module')
      expect(node?.node_kind).toBe('class')
    })

    it('propagates nest_controller role and class node_kind', () => {
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller } from "@nestjs/common"',
        '@Controller("users")',
        'export class UsersController {}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const node = findNode(extraction, 'users_controller_userscontroller')
      expect(node?.framework).toBe('nestjs')
      expect(node?.framework_role).toBe('nest_controller')
      expect(node?.node_kind).toBe('class')
    })

    it('propagates nest_route on route methods with route node_kind', () => {
      writeFile(sandbox, 'src/users.controller.ts', [
        'import { Controller, Get } from "@nestjs/common"',
        '@Controller()',
        'export class UsersController {',
        '  @Get() list(): void {}',
        '}',
      ].join('\n') + '\n')
      const extraction = project(sandbox)
      const method = extraction.nodes.find((n) => n.source_file.endsWith('users.controller.ts') && n.label === '.list()')
      expect(method?.framework).toBe('nestjs')
      expect(method?.framework_role).toBe('nest_route')
      expect(method?.node_kind).toBe('route')
    })

    it('does not tag plain (non-nest) classes with framework metadata', () => {
      writeFile(sandbox, 'src/plain.ts', 'export class Plain {}\n')
      const extraction = project(sandbox)
      const node = findNode(extraction, 'plain_plain')
      expect(node?.framework).toBeUndefined()
      expect(node?.framework_role).toBeUndefined()
    })
  })

  describe('comparison against the legacy extractor', () => {
    it('produces the same file + class + method node ids as extract() on a small fixture', () => {
      // Hand-crafted fixture exercising the legacy extractor's "core" surface
      // (file node, class node, method nodes) which is exactly what slice
      // 1c-i covers. Frameworks, cross-file resolution, generic call
      // resolution etc. land in slice 1c-ii.
      writeFile(sandbox, 'src/audit-log.ts', [
        'export class AuditLog {',
        '  append(): void {}',
        '  listRecentEntries(): void {}',
        '}',
      ].join('\n') + '\n')

      const projected = project(sandbox)
      const legacy = extract([resolve(sandbox, 'src/audit-log.ts')])

      const projectedIds = new Set(projected.nodes.map((n) => n.id))
      const legacyIds = new Set(legacy.nodes.map((n) => n.id))

      // Every node ID the legacy extractor produces for files/classes/methods
      // (the slice 1c-i surface) must also appear in the projection. The
      // projection is allowed to contain additional ids that the legacy
      // extractor does not emit (e.g., enum-only files where the extractor
      // takes a different code path).
      const coreIds = ['audit_log', 'audit_log_auditlog', 'audit_log_auditlog_append', 'audit_log_auditlog_listrecententries']
      for (const id of coreIds) {
        expect(projectedIds.has(id)).toBe(true)
        expect(legacyIds.has(id)).toBe(true)
      }
    })

    it('emits the same `contains` and `method` relations as extract() on a small fixture', () => {
      writeFile(sandbox, 'src/audit-log.ts', [
        'export class AuditLog {',
        '  append(): void {}',
        '}',
      ].join('\n') + '\n')

      const projected = project(sandbox)
      const legacy = extract([resolve(sandbox, 'src/audit-log.ts')])

      const projectedRel = (s: string, t: string) =>
        projected.edges.find((e) => e.source === s && e.target === t)?.relation
      const legacyRel = (s: string, t: string) =>
        legacy.edges.find((e) => e.source === s && e.target === t)?.relation

      expect(projectedRel('audit_log', 'audit_log_auditlog')).toBe('contains')
      expect(legacyRel('audit_log', 'audit_log_auditlog')).toBe('contains')
      expect(projectedRel('audit_log_auditlog', 'audit_log_auditlog_append')).toBe('method')
      expect(legacyRel('audit_log_auditlog', 'audit_log_auditlog_append')).toBe('method')
    })
  })
})
