import { describe, expect, it } from 'vitest'

import { build } from '../../src/pipeline/build.js'
import { compactRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'

interface ExecutionSliceExpectation {
  status: 'complete' | 'partial'
  steps: Array<{
    node_id?: string
    label: string
    source_file?: string
    line_number?: number
  }>
  boundary_reason?: string
}

function buildSliceGraph(options: { includePersistenceStep?: boolean } = {}) {
  const { includePersistenceStep = true } = options

  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'auth_route', label: 'POST /login', file_type: 'code', source_file: '/src/auth/routes.ts', source_location: 'L10', node_kind: 'route', framework: 'express', framework_role: 'express_route', community: 0 },
          { id: 'auth_controller', label: 'AuthController.login', file_type: 'code', source_file: '/src/auth/controller.ts', source_location: 'L20', node_kind: 'method', framework: 'nestjs', framework_role: 'nest_controller', community: 0 },
          { id: 'auth_guard', label: 'AuthGuard', file_type: 'code', source_file: '/src/auth/guard.ts', source_location: 'L30', node_kind: 'class', community: 0 },
          { id: 'auth_service', label: 'AuthService.login', file_type: 'code', source_file: '/src/auth/service.ts', source_location: 'L40', node_kind: 'method', community: 0 },
          { id: 'login_validator', label: 'LoginValidator.validate', file_type: 'code', source_file: '/src/auth/login-validator.ts', source_location: 'L50', node_kind: 'method', community: 0 },
          { id: 'session_store', label: 'SessionStore.createSession', file_type: 'code', source_file: '/src/session/store.ts', source_location: 'L60', node_kind: 'method', community: 1 },
          { id: 'auth_env', label: 'AUTH_COOKIE_DOMAIN', file_type: 'code', source_file: '/src/config/auth.ts', source_location: 'L70', community: 2 },
          { id: 'auth_contract', label: 'LoginInput', file_type: 'code', source_file: '/src/contracts/auth.ts', source_location: 'L80', community: 0 },
          { id: 'auth_test', label: 'AuthService.login.spec', file_type: 'code', source_file: '/tests/auth.service.spec.ts', source_location: 'L90', node_kind: 'function', community: 3 },
          { id: 'billing_exporter', label: 'BillingExporter.syncSessions', file_type: 'code', source_file: '/src/billing/exporter.ts', source_location: 'L100', node_kind: 'method', community: 4 },
          { id: 'billing_metrics', label: 'BillingMetrics.flush', file_type: 'code', source_file: '/src/billing/metrics.ts', source_location: 'L105', node_kind: 'method', community: 4 },
          { id: 'api_client', label: 'ApiClient.syncBilling', file_type: 'code', source_file: '/src/api/client.ts', source_location: 'L110', node_kind: 'method', community: 4 },
          { id: 'shared_index', label: 'index.ts', file_type: 'code', source_file: '/src/shared/index.ts', source_location: 'L120', community: 5 },
          { id: 'shared_cookie', label: 'CookieService', file_type: 'code', source_file: '/src/shared/cookie.ts', source_location: 'L130', node_kind: 'class', community: 5 },
        ],
        edges: [
          { source: 'auth_route', target: 'auth_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/auth/routes.ts' },
          { source: 'auth_controller', target: 'auth_guard', relation: 'uses_guard', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'auth_controller', target: 'auth_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'auth_service', target: 'login_validator', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          ...(includePersistenceStep
            ? [{ source: 'auth_service', target: 'session_store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' } as const]
            : []),
          { source: 'auth_service', target: 'auth_env', relation: 'reads_env', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'auth_service', target: 'auth_contract', relation: 'depends_on', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'auth_service', target: 'auth_test', relation: 'covered_by', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'billing_exporter', target: 'auth_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/billing/exporter.ts' },
          { source: 'billing_exporter', target: 'billing_metrics', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/billing/exporter.ts' },
          { source: 'api_client', target: 'billing_exporter', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api/client.ts' },
          { source: 'auth_service', target: 'shared_index', relation: 'imports_from', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'shared_index', target: 'shared_cookie', relation: 'exports', confidence: 'EXTRACTED', source_file: '/src/shared/index.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function compactFor(prompt: string, graph = buildSliceGraph()) {
  const retrieval = retrieveContext(graph, {
    question: prompt,
    budget: 3000,
    retrievalLevel: 4,
    retrievalStrategy: 'slice-v1',
  } as never)

  return compactRetrieveResult(retrieval) as ReturnType<typeof compactRetrieveResult> & {
    execution_slice?: ExecutionSliceExpectation
  }
}

function labelsFor(prompt: string, overrides: Record<string, unknown> = {}): string[] {
  return retrieveContext(buildSliceGraph(), {
    question: prompt,
    budget: 3000,
    retrievalLevel: 4,
    ...overrides,
  } as never).matched_nodes.map((node) => node.label)
}

describe('retrieveContext retrievalStrategy=slice-v1', () => {
  it('keeps explain slices bounded around the anchored symbol instead of broad impact expansion', () => {
    const defaultLabels = labelsFor('Explain `AuthService.login`')
    const sliced = retrieveContext(buildSliceGraph(), {
      question: 'Explain `AuthService.login`',
      budget: 3000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    } as never)
    const slicedLabels = sliced.matched_nodes.map((node) => node.label)

    expect(defaultLabels).toContain('ApiClient.syncBilling')
    expect(slicedLabels).toContain('AuthService.login')
    expect(slicedLabels).toContain('AuthController.login')
    expect(slicedLabels).toContain('LoginValidator.validate')
    expect(slicedLabels).toContain('AuthService.login.spec')
    expect(slicedLabels).not.toContain('ApiClient.syncBilling')
    expect(slicedLabels).not.toContain('index.ts')
    expect((sliced as any).retrieval_strategy).toBe('slice-v1')
    expect((sliced as any).slice.mode).toBe('explain')
    expect((sliced as any).slice.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'AuthService.login', reason: 'symbol mention' }),
      ]),
    )
  })

  it('captures backward and forward debug evidence without exploding through barrels', () => {
    const sliced = retrieveContext(buildSliceGraph(), {
      question: [
        'Why does `AuthService.login` fail in production?',
        '    at AuthService.login (/src/auth/service.ts:40:7)',
      ].join('\n'),
      budget: 3000,
      retrievalStrategy: 'slice-v1',
    } as never)

    const labels = sliced.matched_nodes.map((node) => node.label)

    expect(labels).toContain('AuthController.login')
    expect(labels).toContain('AuthGuard')
    expect(labels).toContain('AUTH_COOKIE_DOMAIN')
    expect(labels).toContain('SessionStore.createSession')
    expect(labels).toContain('LoginInput')
    expect(labels).toContain('AuthService.login.spec')
    expect(labels).not.toContain('BillingMetrics.flush')
    expect(labels).not.toContain('index.ts')
    expect((sliced as any).slice.mode).toBe('debug')
    expect((sliced as any).slice.directions).toEqual(['backward', 'forward'])
  })

  it('surfaces an execution slice for runtime-generation backend prompts', () => {
    const compact = compactFor('Trace how `POST /login` reaches persistence in the backend runtime pipeline')

    expect(compact.execution_slice).toEqual({
      status: 'complete',
      steps: [
        expect.objectContaining({ label: 'POST /login' }),
        expect.objectContaining({ label: 'AuthController.login' }),
        expect.objectContaining({ label: 'AuthService.login' }),
        expect.objectContaining({ label: 'SessionStore.createSession' }),
      ],
    })
  })

  it('anchors route-shaped backend runtime prompts on the route path', () => {
    const sliced = retrieveContext(buildSliceGraph(), {
      question: 'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      budget: 3000,
      retrievalLevel: 4,
      retrievalStrategy: 'slice-v1',
    } as never)
    const compact = compactRetrieveResult(sliced) as ReturnType<typeof compactRetrieveResult> & {
      execution_slice?: ExecutionSliceExpectation
    }

    expect((sliced as any).slice.anchors).toEqual([
      expect.objectContaining({ label: 'POST /login' }),
    ])
    expect((sliced as any).slice.anchors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'LoginValidator.validate' }),
      ]),
    )
    expect(compact.execution_slice?.steps[0]).toEqual(
      expect.objectContaining({ label: 'POST /login' }),
    )
  })

  it('marks execution slices partial when the route cannot reach persistence', () => {
    const compact = compactFor(
      'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      buildSliceGraph({ includePersistenceStep: false }),
    )

    expect(compact.execution_slice?.status).toBe('partial')
    expect(compact.execution_slice?.boundary_reason).toMatch(/missing|boundary|stops/i)
  })

  it('can pull direct graph neighbors into a level-1 slice even when they do not lexically match', () => {
    const sliced = retrieveContext(buildSliceGraph(), {
      question: 'Explain `AuthService.login`',
      budget: 3000,
      retrievalLevel: 1,
      retrievalStrategy: 'slice-v1',
    } as never)

    const labels = sliced.matched_nodes.map((node) => node.label)

    expect(labels).toContain('AuthService.login')
    expect(labels).toContain('SessionStore.createSession')
    expect(labels).not.toContain('index.ts')
  })

  it('uses an impact-oriented forward slice for breakage questions', () => {
    const sliced = retrieveContext(buildSliceGraph(), {
      question: 'What breaks if `AuthService.login` changes?',
      budget: 3000,
      retrievalStrategy: 'slice-v1',
    } as never)

    const labels = sliced.matched_nodes.map((node) => node.label)

    expect(labels).toContain('AuthController.login')
    expect(labels).toContain('POST /login')
    expect(labels).toContain('BillingExporter.syncSessions')
    expect(labels).toContain('ApiClient.syncBilling')
    expect(labels).toContain('AuthService.login.spec')
    expect(labels).not.toContain('index.ts')
    expect((sliced as any).slice.mode).toBe('impact')
  })
})
