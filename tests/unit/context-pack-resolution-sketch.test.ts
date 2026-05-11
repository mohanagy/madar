import { describe, expect, it } from 'vitest'

import type { ContextPackNode, ContextPackRelationship } from '../../src/contracts/context-pack.js'
import { applyContextPackResolution } from '../../src/runtime/context-pack-resolution.js'

function node(overrides: Partial<ContextPackNode> = {}): ContextPackNode {
  return {
    node_id: overrides.node_id ?? 'auth_service',
    label: overrides.label ?? 'AuthService',
    source_file: overrides.source_file ?? '/src/auth/service.ts',
    line_number: overrides.line_number ?? 10,
    snippet: overrides.snippet ?? [
      'export class AuthService {',
      '  async login(input: LoginInput) {',
      '    await this.validator.validate(input)',
      '    return this.sessionStore.create(input.userId)',
      '  }',
      '}',
    ].join('\n'),
    match_score: overrides.match_score ?? 0.9,
    framework_role: overrides.framework_role,
    ...overrides,
  }
}

function relationship(from: string, to: string, relation: string): ContextPackRelationship {
  return { from_id: from, from, to_id: to, to, relation }
}

describe('applyContextPackResolution sketch mode', () => {
  it('renders a graph-derived behavior sketch for behavior-heavy nodes', () => {
    const result = applyContextPackResolution(
      [
        node({ node_id: 'auth_service', label: 'AuthService.login', framework_role: 'nest_provider' }),
        node({ node_id: 'validator', label: 'LoginValidator', snippet: 'export class LoginValidator {}' }),
        node({ node_id: 'session_store', label: 'SessionStore.create', snippet: 'export function create() {}' }),
        node({ node_id: 'auth_test', label: 'AuthServiceSpec', source_file: '/tests/auth.service.test.ts', snippet: 'describe("AuthService", () => {})' }),
        node({ node_id: 'auth_config', label: 'AUTH_SECRET', source_file: '/src/config/auth.ts', snippet: 'export const AUTH_SECRET = process.env.AUTH_SECRET' }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('auth_service', 'validator', 'calls'),
          relationship('auth_service', 'session_store', 'calls'),
          relationship('auth_service', 'auth_test', 'covered_by'),
          relationship('auth_service', 'auth_config', 'uses_config'),
        ],
      },
    )

    const authService = result.nodes.find((entry) => entry.node_id === 'auth_service')
    expect(authService?.representation_type).toBe('behavior_sketch')
    expect(authService?.representation_reason).toBe('graph-derived behavior sketch')
    expect(authService?.snippet).toContain('AuthService.login')
    expect(authService?.snippet).toContain('-> LoginValidator')
    expect(authService?.snippet).toContain('-> SessionStore.create')
    expect(authService?.snippet).toContain('tests: AuthServiceSpec')
    expect(authService?.snippet).toContain('config: AUTH_SECRET')
    expect(result.bytes_saved).toBeGreaterThan(0)
    expect(result.resolution_map).toContainEqual({
      node_id: 'auth_service',
      resolution: 'behavior_sketch',
    })
  })

  it('renders a dependency record for dependency-oriented nodes', () => {
    const result = applyContextPackResolution(
      [
        node({ node_id: 'token_service', label: 'TokenService.sign', snippet: 'export function sign(): string { return "token" }' }),
        node({ node_id: 'auth_controller', label: 'AuthController.handleCallback', snippet: 'export async function handleCallback() {}', framework_role: 'nest_controller' }),
        node({ node_id: 'cookie_service', label: 'CookieService.set', snippet: 'export function set() {}' }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('token_service', 'cookie_service', 'calls'),
          relationship('auth_controller', 'token_service', 'calls'),
        ],
      },
    )

    const tokenService = result.nodes.find((entry) => entry.node_id === 'token_service')
    expect(tokenService?.representation_type).toBe('dependency_record')
    expect(tokenService?.representation_reason).toBe('graph-derived dependency record')
    expect(tokenService?.snippet).toContain('TokenService.sign')
    expect(tokenService?.snippet).toContain('calls: CookieService.set')
    expect(tokenService?.snippet).toContain('called by: AuthController.handleCallback')
    expect(result.resolution_map).toContainEqual({
      node_id: 'token_service',
      resolution: 'dependency_record',
    })
  })

  it('falls back to signature when graph links are unavailable', () => {
    const result = applyContextPackResolution(
      [node({ node_id: 'standalone', label: 'standalone', snippet: 'export function standalone(input: string): string {\n  return input\n}' })],
      { resolution: 'sketch', relationships: [] },
    )

    expect(result.nodes[0]?.representation_type).toBe('signature')
    expect(result.nodes[0]?.representation_reason).toBe('fallback signature')
    expect(result.nodes[0]?.snippet).toBe('export function standalone(input: string): string {')
    expect(result.resolution_map).toEqual([{ node_id: 'standalone', resolution: 'signature' }])
  })

  it('does not conflate distinct nodes that share the same label when ids are available', () => {
    const result = applyContextPackResolution(
      [
        node({ node_id: 'controller_auth', label: 'AuthService', snippet: 'export class AuthService {}' }),
        node({ node_id: 'controller_dep', label: 'CookieService.set', snippet: 'export function set() {}' }),
        node({ node_id: 'worker_auth', label: 'AuthService', snippet: 'export class AuthService {}' }),
        node({ node_id: 'worker_dep', label: 'QueueClient.publish', snippet: 'export function publish() {}' }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('controller_auth', 'controller_dep', 'calls'),
          relationship('worker_auth', 'worker_dep', 'calls'),
        ],
      },
    )

    const controllerAuth = result.nodes.find((entry) => entry.node_id === 'controller_auth')
    const workerAuth = result.nodes.find((entry) => entry.node_id === 'worker_auth')

    expect(controllerAuth?.snippet).toContain('calls: CookieService.set')
    expect(controllerAuth?.snippet).not.toContain('QueueClient.publish')
    expect(workerAuth?.snippet).toContain('calls: QueueClient.publish')
    expect(workerAuth?.snippet).not.toContain('CookieService.set')
  })

  it('canonicalizes unique label-only relationships onto node ids', () => {
    const result = applyContextPackResolution(
      [
        node({ node_id: 'session_service', label: 'SessionService.createSession', snippet: 'export function createSession() {}' }),
        node({ node_id: 'token_service', label: 'TokenService.sign', snippet: 'export function sign() {}' }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          {
            from: 'SessionService.createSession',
            to: 'TokenService.sign',
            relation: 'calls',
          },
        ],
      },
    )

    const sessionService = result.nodes.find((entry) => entry.node_id === 'session_service')

    expect(sessionService?.representation_type).toBe('dependency_record')
    expect(sessionService?.snippet).toContain('calls: TokenService.sign')
  })
})
