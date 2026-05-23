import { join } from 'node:path'

import { extract } from '../../src/pipeline/extract.js'
import { normalizeAssertionPath } from './helpers/platform.js'

const FIXTURE_ROOT = join(process.cwd(), 'tests', 'fixtures', 'go-semantic-workspace')
const NORMALIZED_FIXTURE_ROOT = normalizeAssertionPath(FIXTURE_ROOT)
const FIXTURE_FILES = [
  join(FIXTURE_ROOT, 'cmd', 'api', 'main.go'),
  join(FIXTURE_ROOT, 'cmd', 'chi', 'main.go'),
  join(FIXTURE_ROOT, 'internal', 'handlers', 'user_handler_multiline.go'),
  join(FIXTURE_ROOT, 'internal', 'handlers', 'user_handler.go'),
  join(FIXTURE_ROOT, 'internal', 'service', 'user_service.go'),
  join(FIXTURE_ROOT, 'internal', 'service', 'user_service_validation.go'),
  join(FIXTURE_ROOT, 'internal', 'repository', 'user_repository.go'),
]

describe('Go semantic extraction', () => {
  it('extracts routes, receiver handlers, and cross-package calls for local Go packages', () => {
    const result = extract(FIXTURE_FILES)

    const netHttpRoute = result.nodes.find((node) => node.label === 'ALL /users')
    const ginRoute = result.nodes.find((node) => node.label === 'POST /api/users')
    const chiMountedRoute = result.nodes.find((node) => node.label === 'POST /chi/users')
    const chiRoutedRoute = result.nodes.find((node) => node.label === 'GET /admin/users')
    const chiRouter = result.nodes.find((node) => node.framework_role === 'chi_router' && node.route_path === '/chi')
    const listUsers = result.nodes.find((node) => node.label === '.ListUsers()')
    const createUser = result.nodes.find((node) => node.label === '.CreateUser()')
    const createUserMultiline = result.nodes.find((node) => node.label === '.CreateUserMultiline()')
    const listService = result.nodes.find(
      (node) => node.label === '.List()' && normalizeAssertionPath(node.source_file) === `${NORMALIZED_FIXTURE_ROOT}/internal/service/user_service.go`,
    )
    const createService = result.nodes.find(
      (node) => node.label === '.Create()' && normalizeAssertionPath(node.source_file) === `${NORMALIZED_FIXTURE_ROOT}/internal/service/user_service.go`,
    )
    const validateService = result.nodes.find(
      (node) => node.label === '.validate()' && normalizeAssertionPath(node.source_file) === `${NORMALIZED_FIXTURE_ROOT}/internal/service/user_service_validation.go`,
    )
    const insertRepository = result.nodes.find(
      (node) => node.label === '.Insert()' && normalizeAssertionPath(node.source_file) === `${NORMALIZED_FIXTURE_ROOT}/internal/repository/user_repository.go`,
    )

    expect(netHttpRoute).toEqual(
      expect.objectContaining({
        framework: 'net/http',
        framework_role: 'net_http_route',
        node_kind: 'route',
        route_path: '/users',
        http_method: 'ALL',
      }),
    )
    expect(ginRoute).toEqual(
      expect.objectContaining({
        framework: 'gin',
        framework_role: 'gin_route',
        node_kind: 'route',
        route_path: '/api/users',
        http_method: 'POST',
      }),
    )
    expect(chiMountedRoute).toEqual(
      expect.objectContaining({
        framework: 'chi',
        framework_role: 'chi_route',
        node_kind: 'route',
        route_path: '/chi/users',
        http_method: 'POST',
      }),
    )
    expect(chiRoutedRoute).toEqual(
      expect.objectContaining({
        framework: 'chi',
        framework_role: 'chi_route',
        node_kind: 'route',
        route_path: '/admin/users',
        http_method: 'GET',
      }),
    )
    expect(chiRouter).toEqual(
      expect.objectContaining({
        framework: 'chi',
        framework_role: 'chi_router',
        node_kind: 'router',
        route_path: '/chi',
      }),
    )
    expect(listUsers).toEqual(
      expect.objectContaining({
        framework_role: expect.stringMatching(/^(net_http|chi)_handler$/),
        node_kind: 'method',
      }),
    )
    expect(createUser).toEqual(
      expect.objectContaining({
        framework_role: expect.stringMatching(/^(gin|chi)_handler$/),
        node_kind: 'method',
      }),
    )
    expect(createUserMultiline).toEqual(
      expect.objectContaining({
        node_kind: 'method',
      }),
    )

    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: netHttpRoute?.id, target: listUsers?.id, relation: 'depends_on' }),
        expect.objectContaining({ source: listUsers?.id, target: netHttpRoute?.id, relation: 'handles_route' }),
        expect.objectContaining({ source: ginRoute?.id, target: createUser?.id, relation: 'depends_on' }),
        expect.objectContaining({ source: createUser?.id, target: ginRoute?.id, relation: 'handles_route' }),
        expect.objectContaining({ source: chiMountedRoute?.id, target: createUser?.id, relation: 'depends_on' }),
        expect.objectContaining({ source: createUser?.id, target: chiMountedRoute?.id, relation: 'handles_route' }),
        expect.objectContaining({ source: chiRoutedRoute?.id, target: listUsers?.id, relation: 'depends_on' }),
        expect.objectContaining({ source: listUsers?.id, target: chiRoutedRoute?.id, relation: 'handles_route' }),
        expect.objectContaining({ source: listUsers?.id, target: listService?.id, relation: 'calls' }),
        expect.objectContaining({ source: createUser?.id, target: createService?.id, relation: 'calls' }),
        expect.objectContaining({ source: createUserMultiline?.id, target: createService?.id, relation: 'calls' }),
        expect.objectContaining({ source: createService?.id, target: validateService?.id, relation: 'calls' }),
        expect.objectContaining({ source: createService?.id, target: insertRepository?.id, relation: 'calls' }),
      ]),
    )
  })
})
