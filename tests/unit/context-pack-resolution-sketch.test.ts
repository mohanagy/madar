import { describe, expect, it } from 'vitest'

import type { ContextPackNode, ContextPackRelationship } from '../../src/contracts/context-pack.js'
import { applyContextPackResolution } from '../../src/runtime/context-pack-resolution.js'

type TaskAwareResolutionOptions = Parameters<typeof applyContextPackResolution>[1]

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

  it('surfaces env/config reads in sketch mode when deterministic evidence exists', () => {
    const result = applyContextPackResolution(
      [
        node({
          node_id: 'auth_controller',
          label: 'AuthController.callback',
          framework_role: 'nest_controller',
          snippet: [
            'export class AuthController {',
            '  callback() {',
            '    return this.sessionService.create(process.env.AUTH_COOKIE_DOMAIN)',
            '  }',
            '}',
          ].join('\n'),
        }),
        node({ node_id: 'session_service', label: 'SessionService.create', snippet: 'export function create() {}' }),
        node({ node_id: 'auth_env', label: 'AUTH_COOKIE_DOMAIN', source_file: '/src/config/auth.ts', snippet: 'export const AUTH_COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN' }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('auth_controller', 'session_service', 'calls'),
          relationship('auth_controller', 'auth_env', 'reads_env'),
          relationship('auth_controller', 'auth_env', 'uses_config'),
        ],
      },
    )

    const authController = result.nodes.find((entry) => entry.node_id === 'auth_controller')

    expect(authController?.representation_type).toBe('behavior_sketch')
    expect(authController?.snippet).toContain('reads env: AUTH_COOKIE_DOMAIN')
    expect(authController?.snippet).toContain('config: AUTH_COOKIE_DOMAIN')
  })

  it('surfaces deterministic side-effect hints for http, llm, and db writes', () => {
    const result = applyContextPackResolution(
      [
        node({
          node_id: 'report_service',
          label: 'ReportGenerationService.generate',
          framework_role: 'nest_provider',
          snippet: [
            'export class ReportGenerationService {',
            '  async generate() {',
            '    await fetch("https://example.com")',
            '    await this.anthropic.messages.create({})',
            '    return prisma.report.create({ data: {} })',
            '  }',
            '}',
          ].join('\n'),
        }),
        node({ node_id: 'http_client', label: 'fetch', snippet: 'export async function fetch() {}' }),
        node({ node_id: 'llm_client', label: 'Anthropic.messages.create', snippet: 'export async function create() {}' }),
        node({ node_id: 'report_repo', label: 'prisma.report.create', snippet: 'export async function create() {}' }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('report_service', 'http_client', 'calls'),
          relationship('report_service', 'llm_client', 'calls'),
          relationship('report_service', 'report_repo', 'calls'),
        ],
      },
    )

    const reportService = result.nodes.find((entry) => entry.node_id === 'report_service')

    expect(reportService?.representation_type).toBe('behavior_sketch')
    expect(reportService?.snippet).toContain('side effects: external_http, llm_call, db_write')
    expect(reportService?.snippet).toContain('latency-sensitive: external_http, llm_call')
  })

  it('keeps framework route/procedure context in sketches', () => {
    const result = applyContextPackResolution(
      [
        node({
          node_id: 'cancel_order',
          label: 'appRouter.cancelOrder()',
          framework_role: 'trpc_procedure_mutation',
          snippet: 'export const cancelOrder = protectedProcedure.mutation(() => prisma.order.update({}))',
        }),
        node({ node_id: 'order_repo', label: 'prisma.order.update', snippet: 'export async function update() {}' }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('cancel_order', 'order_repo', 'calls'),
        ],
      },
    )

    const cancelOrder = result.nodes.find((entry) => entry.node_id === 'cancel_order')

    expect(cancelOrder?.representation_type).toBe('behavior_sketch')
    expect(cancelOrder?.snippet).toContain('framework: trpc_procedure_mutation')
    expect(cancelOrder?.snippet).toContain('side effects: db_write')
  })

  it('does not infer side effects from structural contains edges alone', () => {
    const result = applyContextPackResolution(
      [
        node({
          node_id: 'worker_module',
          label: 'WorkerModule',
          framework_role: 'nest_module',
          snippet: 'export class WorkerModule {}',
        }),
        node({
          node_id: 'queue_publisher',
          label: 'QueueClient.publish',
          snippet: 'export async function publish() {}',
        }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('worker_module', 'queue_publisher', 'contains'),
        ],
      },
    )

    const workerModule = result.nodes.find((entry) => entry.node_id === 'worker_module')

    expect(workerModule?.representation_type).toBe('behavior_sketch')
    expect(workerModule?.snippet).not.toContain('side effects:')
    expect(workerModule?.snippet).toContain('framework: nest_module')
  })

  it('renders structural explain nodes as call chains when selected call edges exist', () => {
    const result = applyContextPackResolution(
      [
        node({
          node_id: 'auth_controller',
          label: 'AuthController.callback',
          framework_role: 'nest_controller',
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
          framework_role: 'nest_provider',
          snippet: [
            'export class AuthService {',
            '  async login(input: LoginInput) {',
            '    return this.sessionStore.create(input.userId)',
            '  }',
            '}',
          ].join('\n'),
          evidence_class: 'primary',
        }),
        node({
          node_id: 'session_store',
          label: 'SessionStore.create',
          snippet: 'export function create() {}',
          evidence_class: 'supporting',
        }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('auth_controller', 'auth_service', 'calls'),
          relationship('auth_service', 'session_store', 'calls'),
        ],
        task_kind: 'explain',
      } as TaskAwareResolutionOptions,
    )

    const authController = result.nodes.find((entry) => entry.node_id === 'auth_controller')

    expect(authController?.representation_type).toBe('call_chain')
    expect(authController?.snippet).toContain('AuthController.callback')
    expect(authController?.snippet).toContain('AuthService.login')
    expect(authController?.snippet).toContain('SessionStore.create')
  })

  it('renders contract and changed review nodes with review-oriented representations', () => {
    const result = applyContextPackResolution(
      [
        node({
          node_id: 'login_input',
          label: 'LoginInput',
          source_file: '/src/auth/contracts.ts',
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
          snippet: [
            'export function sign(userId: string) {',
            '  const token = signer.sign({ sub: userId })',
            '  return cookieService.set(token)',
            '}',
          ].join('\n'),
          evidence_class: 'change',
        }),
        node({
          node_id: 'cookie_service',
          label: 'CookieService.set',
          snippet: 'export function set() {}',
          evidence_class: 'supporting',
        }),
      ],
      {
        resolution: 'sketch',
        relationships: [
          relationship('token_service', 'cookie_service', 'calls'),
        ],
        task_kind: 'review',
      } as TaskAwareResolutionOptions,
    )

    const loginInput = result.nodes.find((entry) => entry.node_id === 'login_input')
    const tokenService = result.nodes.find((entry) => entry.node_id === 'token_service')

    expect(loginInput?.representation_type).toBe('contract_view')
    expect(loginInput?.snippet).toContain('interface LoginInput')
    expect(tokenService?.representation_type).toBe('implementation_excerpt')
    expect(tokenService?.snippet).toContain('const token = signer.sign({ sub: userId })')
  })
})
