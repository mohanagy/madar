import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EvidenceNavigator } from '../../src/runtime/evidence-navigation.js'
import { EVIDENCE_MCP_TOOLS, handleEvidenceMcpRequest } from '../../src/runtime/evidence-stdio-server.js'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'madar-evidence-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), '0123456789012345678901234567890123456789\n')
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      experimentalDecorators: true,
    },
    include: ['src/**/*.ts'],
  }))
  writeFileSync(join(root, 'src', 'decorators.ts'), [
    "export const Controller = (..._args: unknown[]) => (_target: unknown) => {}",
    "export const Get = (..._args: unknown[]) => (_target: unknown, _key: string, _desc: PropertyDescriptor) => {}",
  ].join('\n'))
  writeFileSync(join(root, 'src', 'users.controller.ts'), [
    "import { Controller, Get } from './decorators.js'",
    "@Controller('users')",
    'export class UsersController {',
    "  @Get('me')",
    '  currentUser() { return refundCredit(1) }',
    '}',
    'export function refundCredit(value: number) { return value + 1 }',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'queue.ts'), "export const QUEUE = 'section-research-queue'\n")
  writeFileSync(join(root, 'src', 'other.ts'), [
    "import { refundCredit } from './users.controller.js'",
    'export const doubled = refundCredit(2)',
  ].join('\n'))
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('interactive evidence navigation prototype', () => {
  it('resolves Nest-style static route anchors exactly without global ranking', () => {
    const navigator = new EvidenceNavigator({ rootDir: fixtureRoot() })
    const result = navigator.resolveAnchor('GET /users/me')

    expect(result.resolution).toBe('exact_resolved')
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]).toMatchObject({
      path: 'src/users.controller.ts',
      evidence_kind: 'route',
      name: 'currentUser',
      container_name: 'UsersController',
      route_method: 'GET',
      route_path: '/users/me',
    })
  })

  it('resolves exact queue literals even when they are not TypeScript symbols', () => {
    const navigator = new EvidenceNavigator({ rootDir: fixtureRoot() })
    const result = navigator.resolveAnchor('section-research-queue')

    expect(result.resolution).toBe('exact_resolved')
    expect(result.evidence[0]).toMatchObject({
      path: 'src/queue.ts',
      evidence_kind: 'literal',
      name: 'section-research-queue',
    })
  })

  it('resolves exact TypeScript symbols and returns provider references', () => {
    const navigator = new EvidenceNavigator({ rootDir: fixtureRoot() })
    const anchor = navigator.resolveAnchor('refundCredit')
    const references = navigator.references({ anchor: 'refundCredit' })

    expect(anchor.resolution).toBe('exact_resolved')
    expect(anchor.evidence[0]).toMatchObject({
      path: 'src/users.controller.ts',
      evidence_kind: 'symbol',
      name: 'refundCredit',
    })
    expect(references.evidence.some((entry) => entry.path === 'src/other.ts' && entry.evidence_kind === 'reference')).toBe(true)
    expect(references.evidence.some((entry) => entry.path === 'src/users.controller.ts' && entry.evidence_kind === 'definition')).toBe(true)
  })

  it('reports symbol ambiguity instead of selecting a rank winner', () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'src', 'duplicate.ts'), 'export function refundCredit(value: string) { return value }\n')
    const navigator = new EvidenceNavigator({ rootDir: root })
    const result = navigator.resolveAnchor('refundCredit')

    expect(result.resolution).toBe('ambiguous')
    expect(result.evidence.map((entry) => entry.path)).toEqual([
      'src/duplicate.ts',
      'src/users.controller.ts',
    ])
  })

  it('refuses traversal and never exposes an outside file as evidence', () => {
    const navigator = new EvidenceNavigator({ rootDir: fixtureRoot() })
    const result = navigator.readEvidence('../outside.txt')

    expect(result.resolution).toBe('unresolved')
    expect(result.evidence).toEqual([])
  })

  it('produces stable canonical digests for repeated fixed-input queries', () => {
    const root = fixtureRoot()
    const first = new EvidenceNavigator({ rootDir: root }).resolveAnchor('GET /users/me')
    const second = new EvidenceNavigator({ rootDir: root }).resolveAnchor('GET /users/me')

    expect(first.digest).toBe(second.digest)
    expect(first.repository_revision).toBe('0123456789012345678901234567890123456789')
    expect(first.project.config_path).toBe('tsconfig.json')
  })

  it('exposes only the five prototype tools through the isolated MCP surface', () => {
    expect(EVIDENCE_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      'resolve_anchor',
      'search_exact',
      'read_evidence',
      'definition',
      'references',
    ])

    const navigator = new EvidenceNavigator({ rootDir: fixtureRoot() })
    const response = handleEvidenceMcpRequest(navigator, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'resolve_anchor', arguments: { anchor: 'section-research-queue' } },
    })

    expect(response).toMatchObject({ jsonrpc: '2.0', id: 7 })
    const result = response?.result as { structuredContent?: { resolution?: string } } | undefined
    expect(result?.structuredContent?.resolution).toBe('exact_resolved')
  })
})
