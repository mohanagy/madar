import { describe, expect, it } from 'vitest'

import type {
  ContextPackNode,
  ContextPackRelationship,
  ContextPackTaskKind,
} from '../../src/contracts/context-pack.js'
import { applyContextPackResolution } from '../../src/runtime/context-pack-resolution.js'

type TaskAwareResolutionOptions = Parameters<typeof applyContextPackResolution>[1]

function node(overrides: Partial<ContextPackNode> = {}): ContextPackNode {
  return {
    node_id: overrides.node_id ?? 'node',
    label: overrides.label ?? 'node',
    source_file: overrides.source_file ?? '/src/auth/service.ts',
    line_number: overrides.line_number ?? 1,
    snippet: overrides.snippet ?? 'export function node() {\n  return true\n}',
    match_score: overrides.match_score ?? 0.8,
    evidence_class: overrides.evidence_class ?? 'primary',
    ...overrides,
  }
}

function makeFixture(): {
  nodes: ContextPackNode[]
  relationships: ContextPackRelationship[]
} {
  const nodes = [
    node({
      node_id: 'auth_controller',
      label: 'AuthController.callback',
      source_file: '/src/auth/controller.ts',
      line_number: 12,
      snippet: [
        'export class AuthController {',
        '  async callback(input: LoginInput) {',
        '    return this.authService.login(input)',
        '  }',
        '}',
      ].join('\n'),
      evidence_class: 'structural',
    }),
    node({
      node_id: 'auth_service',
      label: 'AuthService.login',
      source_file: '/src/auth/service.ts',
      line_number: 18,
      framework_role: 'nest_provider',
      snippet: [
        'export class AuthService {',
        '  async login(input: LoginInput) {',
        '    await this.validator.validate(input)',
        '    return this.sessionStore.create(input.userId)',
        '  }',
        '}',
      ].join('\n'),
      evidence_class: 'primary',
    }),
    node({
      node_id: 'login_input',
      label: 'LoginInput',
      source_file: '/src/auth/contracts.ts',
      line_number: 1,
      node_kind: 'interface',
      snippet: [
        'export interface LoginInput {',
        '  userId: string',
        '  callbackUrl?: string',
        '}',
      ].join('\n'),
      evidence_class: 'supporting',
    }),
    node({
      node_id: 'token_service',
      label: 'TokenService.sign',
      source_file: '/src/auth/token-service.ts',
      line_number: 7,
      snippet: [
        'export function sign(userId: string) {',
        '  const token = signer.sign({ sub: userId })',
        '  return cookieService.set(token)',
        '}',
      ].join('\n'),
      evidence_class: 'change',
    }),
    node({
      node_id: 'validator',
      label: 'LoginValidator.validate',
      source_file: '/src/auth/validator.ts',
      line_number: 5,
      snippet: 'export class LoginValidator { validate() {} }',
      evidence_class: 'supporting',
    }),
    node({
      node_id: 'session_store',
      label: 'SessionStore.create',
      source_file: '/src/auth/session-store.ts',
      line_number: 9,
      snippet: 'export function create() {}',
      evidence_class: 'supporting',
    }),
    node({
      node_id: 'cookie_service',
      label: 'CookieService.set',
      source_file: '/src/http/cookies.ts',
      line_number: 4,
      snippet: 'export function set() {}',
      evidence_class: 'supporting',
    }),
    node({
      node_id: 'standalone_helper',
      label: 'normalizeToken',
      source_file: '/src/auth/normalize.ts',
      line_number: 3,
      snippet: [
        'export function normalizeToken(input: string): string {',
        '  return input.trim()',
        '}',
      ].join('\n'),
      evidence_class: 'supporting',
    }),
  ]

  const labelsById = new Map(
    nodes
      .filter((entry): entry is ContextPackNode & { node_id: string } => typeof entry.node_id === 'string')
      .map((entry) => [entry.node_id, entry.label] as const),
  )

  const relationship = (fromId: string, toId: string, relation: string): ContextPackRelationship => ({
    from_id: fromId,
    from: labelsById.get(fromId) ?? fromId,
    to_id: toId,
    to: labelsById.get(toId) ?? toId,
    relation,
  })

  return {
    nodes,
    relationships: [
      relationship('auth_controller', 'auth_service', 'calls'),
      relationship('auth_service', 'validator', 'calls'),
      relationship('auth_service', 'session_store', 'calls'),
      relationship('auth_controller', 'token_service', 'calls'),
      relationship('token_service', 'cookie_service', 'calls'),
      relationship('auth_controller', 'login_input', 'depends_on'),
    ],
  }
}

function renderForTask(taskKind: ContextPackTaskKind) {
  const { nodes, relationships } = makeFixture()
  return applyContextPackResolution(
    nodes,
    {
      resolution: 'sketch',
      relationships,
      task_kind: taskKind,
    } as TaskAwareResolutionOptions,
  )
}

describe('adaptive context representation modes (#176)', () => {
  it('keeps the same selected nodes while task-aware rendering changes representations', () => {
    const { nodes } = makeFixture()
    const explain = renderForTask('explain')
    const review = renderForTask('review')
    const impact = renderForTask('impact')

    const expectedNodeIds = nodes.map((entry) => entry.node_id)
    expect(explain.nodes.map((entry) => entry.node_id)).toEqual(expectedNodeIds)
    expect(review.nodes.map((entry) => entry.node_id)).toEqual(expectedNodeIds)
    expect(impact.nodes.map((entry) => entry.node_id)).toEqual(expectedNodeIds)
  })

  it('renders implementation-heavy explain nodes as behavior sketches', () => {
    const explain = renderForTask('explain')
    const authService = explain.nodes.find((entry) => entry.node_id === 'auth_service')

    expect(authService?.representation_type).toBe('behavior_sketch')
    expect(authService?.snippet).toContain('AuthService.login')
    expect(authService?.snippet).toContain('-> LoginValidator.validate')
    expect(authService?.snippet).toContain('-> SessionStore.create')
  })

  it('renders structural explain nodes as call chains', () => {
    const explain = renderForTask('explain')
    const authController = explain.nodes.find((entry) => entry.node_id === 'auth_controller')

    expect(authController?.representation_type).toBe('call_chain')
    expect(authController?.snippet).toContain('AuthController.callback')
    expect(authController?.snippet).toContain('AuthService.login')
    expect(authController?.snippet).toContain('SessionStore.create')
  })

  it('renders contract-like review nodes as contract views', () => {
    const review = renderForTask('review')
    const loginInput = review.nodes.find((entry) => entry.node_id === 'login_input')

    expect(loginInput?.representation_type).toBe('contract_view')
    expect(loginInput?.snippet).toContain('interface LoginInput')
    expect(loginInput?.snippet).toContain('userId: string')
  })

  it('renders changed review nodes as implementation excerpts', () => {
    const review = renderForTask('review')
    const tokenService = review.nodes.find((entry) => entry.node_id === 'token_service')

    expect(tokenService?.representation_type).toBe('implementation_excerpt')
    expect(tokenService?.snippet).toContain('const token = signer.sign({ sub: userId })')
    expect(tokenService?.snippet).toContain('return cookieService.set(token)')
  })

  it('renders dependency-heavy impact nodes as dependency records', () => {
    const impact = renderForTask('impact')
    const tokenService = impact.nodes.find((entry) => entry.node_id === 'token_service')

    expect(tokenService?.representation_type).toBe('dependency_record')
    expect(tokenService?.snippet).toContain('calls: CookieService.set')
    expect(tokenService?.snippet).toContain('called by: AuthController.callback')
  })

  it('falls back to signature when no deterministic structure exists', () => {
    const review = renderForTask('review')
    const standaloneHelper = review.nodes.find((entry) => entry.node_id === 'standalone_helper')

    expect(standaloneHelper?.representation_type).toBe('signature')
    expect(standaloneHelper?.representation_reason).toBe('fallback signature')
    expect(standaloneHelper?.snippet).toBe('export function normalizeToken(input: string): string {')
  })
})
