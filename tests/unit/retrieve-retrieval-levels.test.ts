import { describe, expect, it } from 'vitest'

import { createTestGraph } from '../helpers/knowledge-graph.js'
import { retrieveContext } from '../../src/runtime/retrieve.js'

function buildRetrievalLevelGraph() {
  return createTestGraph({
    metadata: { root_path: '/' },
    nodes: [
        ['auth_service', {
                label: 'AuthService', file_type: 'code', source_file: '/src/auth/service.ts', source_location: 'L10', node_kind: 'class', community: 0
            }],
        ['login_validator', {
                label: 'LoginValidator', file_type: 'code', source_file: '/src/auth/login-validator.ts', source_location: 'L20', node_kind: 'class', community: 0
            }],
        ['session_store', {
                label: 'SessionStore', file_type: 'code', source_file: '/src/session/store.ts', source_location: 'L30', node_kind: 'class', community: 1
            }],
        ['auth_controller', {
                label: 'AuthController', file_type: 'code', source_file: '/src/auth/controller.ts', source_location: 'L40', node_kind: 'class', framework: 'nestjs', framework_role: 'nest_controller', community: 0
            }],
        ['auth_route', {
                label: 'POST /login', file_type: 'code', source_file: '/src/auth/routes.ts', source_location: 'L50', node_kind: 'route', framework: 'express', framework_role: 'express_route', community: 0
            }],
        ['auth_config', {
                label: 'AUTH_SECRET', file_type: 'code', source_file: '/src/config/auth.ts', source_location: 'L60', node_kind: 'function', community: 2
            }],
        ['auth_test', {
                label: 'AuthServiceSpec', file_type: 'code', source_file: '/tests/auth.service.test.ts', source_location: 'L70', node_kind: 'function', community: 3
            }],
        ['billing_exporter', {
                label: 'BillingExporter', file_type: 'code', source_file: '/src/billing/exporter.ts', source_location: 'L80', node_kind: 'class', community: 4
            }],
        ['api_client', {
                label: 'ApiClient', file_type: 'code', source_file: '/src/api/client.ts', source_location: 'L90', node_kind: 'class', community: 4
            }],
        ['shared_index', {
                label: 'index.ts', file_type: 'code', source_file: '/src/shared/index.ts', source_location: 'L100', node_kind: 'function', community: 5
            }],
        ['shared_util', {
                label: 'SharedUtil', file_type: 'code', source_file: '/src/shared/util.ts', source_location: 'L110', node_kind: 'function', community: 5
            }],
        ['shared_logger', {
                label: 'SharedLogger', file_type: 'code', source_file: '/src/shared/logger.ts', source_location: 'L120', node_kind: 'class', community: 5
            }]
    ],
    edges: [
        ['auth_controller', 'auth_service', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts'
            }],
        ['auth_service', 'login_validator', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }],
        ['auth_service', 'session_store', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }],
        ['auth_route', 'auth_controller', {
                relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/auth/routes.ts'
            }],
        ['auth_service', 'auth_config', {
                relation: 'uses_config', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }],
        ['auth_service', 'auth_test', {
                relation: 'covered_by', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }],
        ['billing_exporter', 'auth_service', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/billing/exporter.ts'
            }],
        ['api_client', 'billing_exporter', {
                relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api/client.ts'
            }],
        ['auth_service', 'shared_index', {
                relation: 'imports_from', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts'
            }],
        ['shared_index', 'shared_util', {
                relation: 'exports', confidence: 'EXTRACTED', source_file: '/src/shared/index.ts'
            }],
        ['shared_index', 'shared_logger', {
                relation: 'exports', confidence: 'EXTRACTED', source_file: '/src/shared/index.ts'
            }]
    ]
})
}

function labelsFor(level: 1 | 2 | 3 | 4): string[] {
  return retrieveContext(buildRetrievalLevelGraph(), {
    question: 'Explain `AuthService`',
    budget: 3000,
    retrievalLevel: level,
  }).matched_nodes.map((node) => node.label)
}

describe('retrieveContext operational retrieval levels', () => {
  it('level 1 stays local to seed nodes and avoids hub expansion', () => {
    const labels = labelsFor(1)

    expect(labels).toContain('AuthService')
    expect(labels).not.toContain('SessionStore')
    expect(labels).not.toContain('AuthServiceSpec')
    expect(labels).not.toContain('AUTH_SECRET')
    expect(labels).not.toContain('BillingExporter')
    expect(labels).not.toContain('index.ts')
  })

  it('level 2 adds direct dependency expansion only', () => {
    const labels = labelsFor(2)

    expect(labels).toContain('AuthService')
    expect(labels).toContain('LoginValidator')
    expect(labels).toContain('SessionStore')
    expect(labels).not.toContain('AuthServiceSpec')
    expect(labels).not.toContain('AUTH_SECRET')
    expect(labels).not.toContain('BillingExporter')
  })

  it('level 3 adds behavior-slice signals like tests, config, and framework links', () => {
    const labels = labelsFor(3)

    expect(labels).toContain('AuthService')
    expect(labels).toContain('AuthServiceSpec')
    expect(labels).toContain('AUTH_SECRET')
    expect(labels).not.toContain('BillingExporter')
    expect(labels).not.toContain('ApiClient')
  })

  it('level 4 expands to cross-module callers and broader impact context', () => {
    const labels = labelsFor(4)

    expect(labels).toContain('AuthService')
    expect(labels).toContain('AuthServiceSpec')
    expect(labels).toContain('AUTH_SECRET')
    expect(labels).toContain('BillingExporter')
    expect(labels).toContain('ApiClient')
  })

  it('same prompt yields meaningfully broader context at level 4 than level 1', () => {
    const level1 = new Set(labelsFor(1))
    const level4 = new Set(labelsFor(4))

    expect(level4.size).toBeGreaterThan(level1.size)
    expect(level1.has('BillingExporter')).toBe(false)
    expect(level4.has('BillingExporter')).toBe(true)
    expect(level1.has('AuthServiceSpec')).toBe(false)
    expect(level4.has('AuthServiceSpec')).toBe(true)
  })
})
