import { describe, expect, it } from 'vitest'

import type { ExtractionEdge, ExtractionNode } from '../../src/contracts/types.js'
import { build } from '../../src/pipeline/build.js'
import { compactRetrieveResult, retrieveContext } from '../../src/runtime/retrieve.js'

interface ExecutionSliceExpectation {
  status: 'complete' | 'partial'
  confidence?: 'high' | 'medium' | 'low'
  confidence_reasons?: string[]
  steps: Array<{
    node_id?: string
    label: string
    source_file?: string
    line_number?: number
  }>
  boundary_reason?: string
  primary_path?: {
    steps: Array<{
      node_id?: string
      label: string
      source_file?: string
      line_number?: number
    }>
    boundaries?: Array<{
      from?: string
      to?: string
      relation: string
    }>
    boundary_reason?: string
  }
  side_effects?: Array<{
    steps: Array<{
      label: string
    }>
    boundary_reason?: string
  }>
  terminal_boundaries?: Array<{
    steps: Array<{
      label: string
    }>
    boundary_reason?: string
  }>
  omitted_branches?: Array<{
    from?: string
    to?: string
    relation?: string
    reason?: string
  }>
  phase_coverage?: {
    expected: string[]
    observed: string[]
    missing: string[]
  }
}

function buildSliceGraph(
  options: {
    includeWorkerStep?: boolean
    includePersistenceStep?: boolean
    workerLabel?: string
    workerSourceFile?: string
    workerFrameworkRole?: string
  } = {},
) {
  const {
    includeWorkerStep = true,
    includePersistenceStep = true,
    workerLabel = 'AuthWorker.process',
    workerSourceFile = '/src/auth/worker.ts',
    workerFrameworkRole = 'worker',
  } = options

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
          { id: 'queue_registry', label: 'QueueRegistry.addJob', file_type: 'code', source_file: '/src/queue/registry.ts', source_location: 'L60', node_kind: 'method', community: 1 },
          { id: 'auth_worker', label: workerLabel, file_type: 'code', source_file: workerSourceFile, source_location: 'L70', node_kind: 'method', framework_role: workerFrameworkRole, community: 1 },
          { id: 'session_store', label: 'SessionStore.createSession', file_type: 'code', source_file: '/src/session/store.ts', source_location: 'L80', node_kind: 'method', community: 1 },
          { id: 'audit_publisher', label: 'AuditPublisher.publishLogin', file_type: 'code', source_file: '/src/auth/audit.ts', source_location: 'L90', node_kind: 'method', community: 2 },
          { id: 'session_notifier', label: 'SessionNotifier.sendLoginWebhook', file_type: 'code', source_file: '/src/auth/notifier.ts', source_location: 'L100', node_kind: 'method', community: 2 },
          { id: 'status_helper', label: 'AuthController.getStatusMessage', file_type: 'code', source_file: '/src/auth/controller.ts', source_location: 'L110', node_kind: 'method', community: 0 },
          { id: 'auth_logger', label: 'Logger.info', file_type: 'code', source_file: '/src/auth/logger.ts', source_location: 'L120', node_kind: 'method', community: 2 },
          { id: 'auth_env', label: 'AUTH_COOKIE_DOMAIN', file_type: 'code', source_file: '/src/config/auth.ts', source_location: 'L130', community: 3 },
          { id: 'auth_contract', label: 'LoginInput', file_type: 'code', source_file: '/src/contracts/auth.ts', source_location: 'L140', community: 0 },
          { id: 'auth_test', label: 'AuthService.login.spec', file_type: 'code', source_file: '/tests/auth.service.spec.ts', source_location: 'L150', node_kind: 'function', community: 4 },
          { id: 'billing_exporter', label: 'BillingExporter.syncSessions', file_type: 'code', source_file: '/src/billing/exporter.ts', source_location: 'L160', node_kind: 'method', community: 5 },
          { id: 'billing_metrics', label: 'BillingMetrics.flush', file_type: 'code', source_file: '/src/billing/metrics.ts', source_location: 'L170', node_kind: 'method', community: 5 },
          { id: 'api_client', label: 'ApiClient.syncBilling', file_type: 'code', source_file: '/src/api/client.ts', source_location: 'L180', node_kind: 'method', community: 5 },
          { id: 'shared_index', label: 'index.ts', file_type: 'code', source_file: '/src/shared/index.ts', source_location: 'L190', community: 6 },
          { id: 'shared_cookie', label: 'CookieService', file_type: 'code', source_file: '/src/shared/cookie.ts', source_location: 'L200', node_kind: 'class', community: 6 },
        ],
        edges: [
          { source: 'auth_route', target: 'auth_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/auth/routes.ts' },
          { source: 'auth_controller', target: 'auth_guard', relation: 'uses_guard', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'auth_controller', target: 'auth_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'auth_controller', target: 'status_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'auth_controller', target: 'auth_logger', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'auth_service', target: 'login_validator', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'auth_service', target: 'queue_registry', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          { source: 'auth_service', target: 'audit_publisher', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
          ...(includeWorkerStep
            ? [{ source: 'queue_registry', target: 'auth_worker', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/src/queue/registry.ts' } as const]
            : []),
          ...(includePersistenceStep && includeWorkerStep
            ? [{ source: 'auth_worker', target: 'session_store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/worker.ts' } as const]
            : []),
          ...(includeWorkerStep
            ? [{ source: 'auth_worker', target: 'session_notifier', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/worker.ts' } as const]
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

function buildWorkerSegmentGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'queue_registry', label: 'QueueRegistry.addJob', file_type: 'code', source_file: '/src/queue/registry.ts', source_location: 'L10', node_kind: 'method', framework_role: 'queue', community: 0 },
          { id: 'auth_worker', label: 'AuthWorker.process', file_type: 'code', source_file: '/src/auth/worker.ts', source_location: 'L20', node_kind: 'method', framework_role: 'worker', community: 1 },
          { id: 'session_store', label: 'SessionStore.createSession', file_type: 'code', source_file: '/src/session/store.ts', source_location: 'L30', node_kind: 'method', framework_role: 'repository', community: 1 },
        ],
        edges: [
          { source: 'queue_registry', target: 'auth_worker', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/src/queue/registry.ts' },
          { source: 'auth_worker', target: 'session_store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/worker.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildDirectPersistenceGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'login_route', label: 'POST /login', file_type: 'code', source_file: '/src/auth/routes.ts', source_location: 'L10', node_kind: 'route', framework_role: 'express_route', community: 0 },
          { id: 'login_controller', label: 'AuthController.login', file_type: 'code', source_file: '/src/auth/controller.ts', source_location: 'L20', node_kind: 'method', framework_role: 'nest_controller', community: 0 },
          { id: 'login_service', label: 'AuthService.login', file_type: 'code', source_file: '/src/auth/service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'nest_provider', community: 0 },
          { id: 'session_store', label: 'SessionStore.createSession', file_type: 'code', source_file: '/src/session/store.ts', source_location: 'L40', node_kind: 'method', framework_role: 'repository', community: 1 },
        ],
        edges: [
          { source: 'login_route', target: 'login_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/src/auth/routes.ts' },
          { source: 'login_controller', target: 'login_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/controller.ts' },
          { source: 'login_service', target: 'session_store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/auth/service.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildDubRuntimeProofGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'click_route', label: 'GET /:domain/:key', file_type: 'code', source_file: '/apps/web/links/route.ts', source_location: 'L10', node_kind: 'route', framework_role: 'nextjs_route', community: 0 },
          { id: 'redirect_controller', label: 'LinkRedirectController.handleClick', file_type: 'code', source_file: '/apps/web/links/controller.ts', source_location: 'L20', node_kind: 'method', framework_role: 'controller', community: 0 },
          { id: 'redirect_service', label: 'LinkRedirectService.resolveDestination', file_type: 'code', source_file: '/apps/web/links/service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'analytics_tracker', label: 'ClickAnalytics.record', file_type: 'code', source_file: '/lib/analytics/clicks.ts', source_location: 'L40', node_kind: 'method', framework_role: 'service', community: 1 },
          { id: 'destination_redirect', label: 'DestinationRedirect.send', file_type: 'code', source_file: '/apps/web/links/redirect.ts', source_location: 'L50', node_kind: 'method', framework_role: 'handler', community: 1 },
        ],
        edges: [
          { source: 'click_route', target: 'redirect_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/apps/web/links/route.ts' },
          { source: 'redirect_controller', target: 'redirect_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/links/controller.ts' },
          { source: 'redirect_service', target: 'analytics_tracker', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/links/service.ts' },
          { source: 'redirect_service', target: 'destination_redirect', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/links/service.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildDubRuntimeProofDistractorGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'click_route', label: 'GET /:domain/:key', file_type: 'code', source_file: '/apps/web/links/route.ts', source_location: 'L10', node_kind: 'route', framework_role: 'nextjs_route', community: 0 },
          { id: 'redirect_controller', label: 'LinkRedirectController.handleClick', file_type: 'code', source_file: '/apps/web/links/controller.ts', source_location: 'L20', node_kind: 'method', framework_role: 'controller', community: 0 },
          { id: 'redirect_service', label: 'LinkRedirectService.resolveDestination', file_type: 'code', source_file: '/apps/web/links/service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'analytics_tracker', label: 'ClickAnalytics.record', file_type: 'code', source_file: '/lib/analytics/clicks.ts', source_location: 'L40', node_kind: 'method', framework_role: 'service', community: 1 },
          { id: 'destination_redirect', label: 'DestinationRedirect.send', file_type: 'code', source_file: '/apps/web/links/redirect.ts', source_location: 'L50', node_kind: 'method', framework_role: 'handler', community: 1 },
          { id: 'cron_route', label: 'GET /api/cron/streams/update-workspace-clicks', file_type: 'code', source_file: '/apps/web/app/api/cron/streams/update-workspace-clicks/route.ts', source_location: 'L60', node_kind: 'route', framework_role: 'nextjs_route', community: 2 },
          { id: 'cron_controller', label: 'UpdateWorkspaceClicksController.handle', file_type: 'code', source_file: '/apps/web/app/api/cron/streams/update-workspace-clicks/controller.ts', source_location: 'L70', node_kind: 'method', framework_role: 'controller', community: 2 },
          { id: 'cron_service', label: 'UpdateWorkspaceClicksService.process', file_type: 'code', source_file: '/apps/web/app/api/cron/streams/update-workspace-clicks/service.ts', source_location: 'L80', node_kind: 'method', framework_role: 'service', community: 2 },
          { id: 'cron_store', label: 'WorkspaceClicksStore.save', file_type: 'code', source_file: '/apps/web/app/api/cron/streams/update-workspace-clicks/store.ts', source_location: 'L90', node_kind: 'method', framework_role: 'repository', community: 2 },
        ],
        edges: [
          { source: 'click_route', target: 'redirect_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/apps/web/links/route.ts' },
          { source: 'redirect_controller', target: 'redirect_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/links/controller.ts' },
          { source: 'redirect_service', target: 'analytics_tracker', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/links/service.ts' },
          { source: 'redirect_service', target: 'destination_redirect', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/links/service.ts' },
          { source: 'cron_route', target: 'cron_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/apps/web/app/api/cron/streams/update-workspace-clicks/route.ts' },
          { source: 'cron_controller', target: 'cron_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/app/api/cron/streams/update-workspace-clicks/controller.ts' },
          { source: 'cron_service', target: 'cron_store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/app/api/cron/streams/update-workspace-clicks/service.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildDubRuntimeProofSplitEntryGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'track_route_file', label: 'route.ts', file_type: 'code', source_file: '/apps/web/app/(ee)/api/track/click/route.ts', source_location: 'L1', community: 0 },
          { id: 'track_post', label: 'POST', file_type: 'code', source_file: '/apps/web/app/(ee)/api/track/click/route.ts', source_location: 'L10', node_kind: 'route', framework: 'nextjs', framework_role: 'nextjs_app_route', route_path: '/api/track/click', http_method: 'POST', community: 0 },
          { id: 'track_schema', label: 'trackClickSchema', file_type: 'code', source_file: '/apps/web/app/(ee)/api/track/click/route.ts', source_location: 'L20', community: 0 },
          { id: 'track_record_click', label: 'recordClick()', file_type: 'code', source_file: '/apps/web/lib/tinybird/record-click.ts', source_location: 'L30', node_kind: 'function', community: 1 },
          { id: 'link_middleware', label: 'LinkMiddleware()', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L40', node_kind: 'function', community: 2 },
          { id: 'redirect_effect', label: 'NextResponse.redirect', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L50', node_kind: 'method', framework_role: 'handler', community: 2 },
        ],
        edges: [
          { source: 'track_route_file', target: 'track_post', relation: 'contains', confidence: 'EXTRACTED', source_file: '/apps/web/app/(ee)/api/track/click/route.ts' },
          { source: 'track_route_file', target: 'track_schema', relation: 'contains', confidence: 'EXTRACTED', source_file: '/apps/web/app/(ee)/api/track/click/route.ts' },
          { source: 'track_post', target: 'track_record_click', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/app/(ee)/api/track/click/route.ts' },
          { source: 'link_middleware', target: 'track_record_click', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'redirect_effect', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildDubRuntimeProofDenseDistractorGraph() {
  const nodes: ExtractionNode[] = [
    { id: 'middleware_entry', label: 'middleware()', file_type: 'code', source_file: '/apps/web/middleware.ts', source_location: 'L10', node_kind: 'function', community: 0 },
    { id: 'link_middleware', label: 'LinkMiddleware()', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L20', node_kind: 'function', community: 0 },
    { id: 'track_record_click', label: 'recordClick()', file_type: 'code', source_file: '/apps/web/lib/tinybird/record-click.ts', source_location: 'L30', node_kind: 'function', community: 1 },
    { id: 'redirect_effect', label: 'NextResponse.redirect', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L40', node_kind: 'method', framework_role: 'handler', community: 1 },
  ]
  const edges: ExtractionEdge[] = [
    { source: 'middleware_entry', target: 'link_middleware', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/middleware.ts' },
    { source: 'link_middleware', target: 'track_record_click', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
    { source: 'link_middleware', target: 'redirect_effect', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
  ]

  for (let index = 0; index < 40; index += 1) {
    const routeId = `cron_route_${index}`
    const handlerId = `cron_handler_${index}`
    const sourceFile = `/apps/web/app/(ee)/api/cron/${index}/update-workspace-clicks/route.ts`
    nodes.push(
      { id: routeId, label: `GET /api/cron/${index}/update-workspace-clicks`, file_type: 'code', source_file: sourceFile, source_location: 'L10', node_kind: 'route', framework_role: 'nextjs_route', community: 2 },
      { id: handlerId, label: `handleClickBatch${index}()`, file_type: 'code', source_file: sourceFile, source_location: 'L20', node_kind: 'function', community: 2 },
    )
    edges.push(
      { source: routeId, target: handlerId, relation: 'calls', confidence: 'EXTRACTED', source_file: sourceFile },
    )
  }

  return build(
    [
      {
        schema_version: 1,
        nodes,
        edges,
      },
    ],
    { directed: true },
  )
}

function buildCalStructuralEntrypointGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'booking_route', label: 'API /api/book/event', file_type: 'code', source_file: '/apps/web/pages/api/book/event.ts', source_location: 'L1', node_kind: 'route', framework: 'nextjs', framework_role: 'next_route_handler', route_path: '/api/book/event', community: 0 },
          { id: 'booking_route_handler', label: 'handler()', file_type: 'code', source_file: '/apps/web/pages/api/book/event.ts', source_location: 'L17', node_kind: 'function', community: 0 },
          { id: 'booking_service_factory', label: 'getRegularBookingService()', file_type: 'code', source_file: '/apps/web/pages/api/book/event.ts', source_location: 'L49', node_kind: 'method', community: 0 },
          { id: 'booking_service_handler', label: 'RegularBookingService.handler()', file_type: 'code', source_file: '/packages/features/bookings/lib/service/RegularBookingService.ts', source_location: 'L486', node_kind: 'method', framework_role: 'service', community: 1 },
          { id: 'ensure_available_users', label: 'AvailabilityValidator.ensureAvailableUsers', file_type: 'code', source_file: '/packages/features/bookings/lib/handleNewBooking/ensureAvailableUsers.ts', source_location: 'L57', node_kind: 'method', community: 1 },
          { id: 'check_conflicts', label: 'AvailabilityValidator.validate', file_type: 'code', source_file: '/packages/features/bookings/lib/handleNewBooking/ensureAvailableUsers.ts', source_location: 'L243', node_kind: 'method', community: 1 },
          { id: 'save_booking', label: 'BookingStore.save', file_type: 'code', source_file: '/packages/features/bookings/lib/handleNewBooking/createBooking.ts', source_location: 'L96', node_kind: 'method', framework_role: 'repository', community: 1 },
          { id: 'send_scheduled_emails', label: 'sendScheduledEmailsAndSMS()', file_type: 'code', source_file: '/packages/features/bookings/lib/handleConfirmation.ts', source_location: 'L108', node_kind: 'method', community: 2 },
        ],
        edges: [
          { source: 'booking_route', target: 'booking_route_handler', relation: 'contains', confidence: 'EXTRACTED', source_file: '/apps/web/pages/api/book/event.ts' },
          { source: 'booking_route_handler', target: 'booking_service_factory', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/pages/api/book/event.ts' },
          { source: 'booking_service_handler', target: 'ensure_available_users', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/features/bookings/lib/service/RegularBookingService.ts' },
          { source: 'ensure_available_users', target: 'check_conflicts', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/features/bookings/lib/handleNewBooking/ensureAvailableUsers.ts' },
          { source: 'booking_service_handler', target: 'save_booking', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/features/bookings/lib/service/RegularBookingService.ts' },
          { source: 'booking_service_handler', target: 'send_scheduled_emails', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/features/bookings/lib/service/RegularBookingService.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildDubRuntimeProofCrowdedBranchGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'middleware_entry', label: 'middleware()', file_type: 'code', source_file: '/apps/web/middleware.ts', source_location: 'L10', node_kind: 'function', community: 0 },
          { id: 'link_middleware', label: 'LinkMiddleware()', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L20', node_kind: 'function', community: 0 },
          { id: 'case_sensitivity', label: 'isCaseSensitiveDomain', file_type: 'code', source_file: '/apps/web/lib/api/links/case-sensitivity.ts', source_location: 'L30', node_kind: 'function', community: 1 },
          { id: 'case_cache_key', label: '._createKey()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L40', node_kind: 'method', community: 1 },
          { id: 'case_cache_delete', label: '.delete()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L50', node_kind: 'method', community: 1 },
          { id: 'format_redis', label: 'formatRedisLink()', file_type: 'code', source_file: '/apps/web/lib/upstash/format-redis-link.ts', source_location: 'L60', node_kind: 'function', community: 1 },
          { id: 'cache_set', label: '.set()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L70', node_kind: 'method', community: 1 },
          { id: 'create_link', label: 'createLink()', file_type: 'code', source_file: '/apps/web/lib/planetscale/create-link.ts', source_location: 'L80', node_kind: 'function', community: 1 },
          { id: 'create_static_pages', label: '._createStaticPagesCacheKeys()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L90', node_kind: 'method', community: 1 },
          { id: 'track_record_click', label: 'recordClick()', file_type: 'code', source_file: '/apps/web/lib/tinybird/record-click.ts', source_location: 'L100', node_kind: 'function', community: 1 },
          { id: 'create_response', label: 'createResponseWithCookies()', file_type: 'code', source_file: '/apps/web/lib/middleware/utils/create-response-with-cookies.ts', source_location: 'L110', node_kind: 'function', community: 1 },
          { id: 'redirect_effect', label: 'NextResponse.redirect', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L120', node_kind: 'method', framework_role: 'handler', community: 1 },
          { id: 'rewrite_effect', label: 'NextResponse.rewrite', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L130', node_kind: 'method', framework_role: 'handler', community: 1 },
          { id: 'get_link_via_edge', label: 'getLinkViaEdge', file_type: 'code', source_file: '/apps/web/lib/planetscale/get-link-via-edge.ts', source_location: 'L140', node_kind: 'function', community: 1 },
          { id: 'get_partner_enrollment_info', label: 'getPartnerEnrollmentInfo', file_type: 'code', source_file: '/apps/web/lib/planetscale/get-partner-enrollment-info.ts', source_location: 'L150', node_kind: 'function', community: 1 },
        ],
        edges: [
          { source: 'middleware_entry', target: 'link_middleware', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/middleware.ts' },
          { source: 'link_middleware', target: 'case_sensitivity', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'case_sensitivity', target: 'case_cache_key', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/api/links/case-sensitivity.ts' },
          { source: 'case_cache_key', target: 'case_cache_delete', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/api/links/cache.ts' },
          { source: 'link_middleware', target: 'format_redis', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'format_redis', target: 'cache_set', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/upstash/format-redis-link.ts' },
          { source: 'cache_set', target: 'create_link', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/api/links/cache.ts' },
          { source: 'link_middleware', target: 'create_static_pages', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'track_record_click', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'create_response', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'redirect_effect', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'rewrite_effect', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'get_link_via_edge', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'get_partner_enrollment_info', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildStrictRuntimeProofConfidenceGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'middleware_entry', label: 'middleware()', file_type: 'code', source_file: '/apps/web/middleware.ts', source_location: 'L10', node_kind: 'function', community: 0 },
          { id: 'link_middleware', label: 'LinkMiddleware()', file_type: 'code', source_file: '/apps/web/lib/middleware/link.ts', source_location: 'L20', node_kind: 'function', community: 0 },
          { id: 'case_sensitivity', label: 'isCaseSensitiveDomain', file_type: 'code', source_file: '/apps/web/lib/api/links/case-sensitivity.ts', source_location: 'L30', node_kind: 'function', community: 1 },
          { id: 'case_cache_key', label: '._createKey()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L40', node_kind: 'method', community: 1 },
          { id: 'case_cache_delete', label: '.delete()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L50', node_kind: 'method', community: 1 },
          { id: 'format_redis', label: 'formatRedisLink()', file_type: 'code', source_file: '/apps/web/lib/upstash/format-redis-link.ts', source_location: 'L60', node_kind: 'function', community: 1 },
          { id: 'cache_set', label: '.set()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L70', node_kind: 'method', community: 1 },
          { id: 'create_link', label: 'createLink()', file_type: 'code', source_file: '/apps/web/lib/planetscale/create-link.ts', source_location: 'L80', node_kind: 'function', community: 1 },
          { id: 'create_static_pages', label: '._createStaticPagesCacheKeys()', file_type: 'code', source_file: '/apps/web/lib/api/links/cache.ts', source_location: 'L90', node_kind: 'method', community: 1 },
          { id: 'track_click', label: 'trackClick()', file_type: 'code', source_file: '/apps/web/lib/analytics/track.ts', source_location: 'L100', node_kind: 'function', community: 1 },
          { id: 'response_envelope', label: 'responseEnvelope()', file_type: 'code', source_file: '/apps/web/lib/middleware/utils/response-envelope.ts', source_location: 'L110', node_kind: 'function', community: 1 },
          { id: 'redirect_target', label: 'redirectTarget', file_type: 'code', source_file: '/apps/web/lib/navigation/redirect-target.ts', source_location: 'L120', node_kind: 'function', community: 1 },
          { id: 'rewrite_target', label: 'rewriteTarget', file_type: 'code', source_file: '/apps/web/lib/navigation/rewrite-target.ts', source_location: 'L130', node_kind: 'function', community: 1 },
          { id: 'get_link_via_edge', label: 'getLinkViaEdge', file_type: 'code', source_file: '/apps/web/lib/planetscale/get-link-via-edge.ts', source_location: 'L140', node_kind: 'function', community: 1 },
          { id: 'get_partner_enrollment_info', label: 'getPartnerEnrollmentInfo', file_type: 'code', source_file: '/apps/web/lib/planetscale/get-partner-enrollment-info.ts', source_location: 'L150', node_kind: 'function', community: 1 },
        ],
        edges: [
          { source: 'middleware_entry', target: 'link_middleware', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/middleware.ts' },
          { source: 'link_middleware', target: 'case_sensitivity', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'case_sensitivity', target: 'case_cache_key', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/api/links/case-sensitivity.ts' },
          { source: 'case_cache_key', target: 'case_cache_delete', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/api/links/cache.ts' },
          { source: 'link_middleware', target: 'format_redis', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'format_redis', target: 'cache_set', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/upstash/format-redis-link.ts' },
          { source: 'cache_set', target: 'create_link', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/api/links/cache.ts' },
          { source: 'link_middleware', target: 'create_static_pages', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'track_click', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'response_envelope', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'redirect_target', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'rewrite_target', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'get_link_via_edge', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
          { source: 'link_middleware', target: 'get_partner_enrollment_info', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/lib/middleware/link.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildFormbricksRuntimeProofGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'survey_route', label: 'POST /api/surveys/:surveyId/responses', file_type: 'code', source_file: '/apps/web/surveys/route.ts', source_location: 'L10', node_kind: 'route', framework_role: 'nextjs_route', community: 0 },
          { id: 'response_controller', label: 'SurveyResponseController.submit', file_type: 'code', source_file: '/apps/web/surveys/controller.ts', source_location: 'L20', node_kind: 'method', framework_role: 'controller', community: 0 },
          { id: 'response_service', label: 'SurveyResponseService.process', file_type: 'code', source_file: '/packages/responses/service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'response_store', label: 'SurveyResponseStore.persist', file_type: 'code', source_file: '/packages/responses/store.ts', source_location: 'L40', node_kind: 'method', framework_role: 'repository', community: 1 },
          { id: 'analytics_tracker', label: 'ResponseAnalytics.trackEvent', file_type: 'code', source_file: '/packages/analytics/track.ts', source_location: 'L50', node_kind: 'method', framework_role: 'service', community: 1 },
        ],
        edges: [
          { source: 'survey_route', target: 'response_controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/apps/web/surveys/route.ts' },
          { source: 'response_controller', target: 'response_service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/web/surveys/controller.ts' },
          { source: 'response_service', target: 'response_store', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/responses/service.ts' },
          { source: 'response_service', target: 'analytics_tracker', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/responses/service.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildTwentyRuntimeProofGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'mutation_route', label: 'POST /crm/records/:id', file_type: 'code', source_file: '/packages/twenty-server/src/modules/records/route.ts', source_location: 'L10', node_kind: 'route', framework_role: 'express_route', community: 0 },
          { id: 'mutation_resolver', label: 'RecordMutationResolver.updateRecord', file_type: 'code', source_file: '/packages/twenty-server/src/modules/records/resolver.ts', source_location: 'L20', node_kind: 'method', framework_role: 'resolver', community: 0 },
          { id: 'workspace_scope', label: 'WorkspaceScope.apply', file_type: 'code', source_file: '/packages/twenty-server/src/modules/workspace/workspace-scope.ts', source_location: 'L30', node_kind: 'method', framework_role: 'service', community: 1 },
          { id: 'activity_emitter', label: 'WorkspaceActivityEmitter.publish', file_type: 'code', source_file: '/packages/twenty-server/src/modules/workspace/activity.ts', source_location: 'L40', node_kind: 'method', framework_role: 'service', community: 1 },
          { id: 'record_repository', label: 'RecordRepository.save', file_type: 'code', source_file: '/packages/twenty-server/src/modules/records/repository.ts', source_location: 'L50', node_kind: 'method', framework_role: 'repository', community: 1 },
        ],
        edges: [
          { source: 'mutation_route', target: 'mutation_resolver', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/packages/twenty-server/src/modules/records/route.ts' },
          { source: 'mutation_resolver', target: 'workspace_scope', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/twenty-server/src/modules/records/resolver.ts' },
          { source: 'workspace_scope', target: 'activity_emitter', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/twenty-server/src/modules/workspace/workspace-scope.ts' },
          { source: 'workspace_scope', target: 'record_repository', relation: 'calls', confidence: 'EXTRACTED', source_file: '/packages/twenty-server/src/modules/workspace/workspace-scope.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildTwentyDisconnectedRuntimeProofGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'resolver_create', label: 'CreateOneResolverFactory.create', file_type: 'code', source_file: '/src/api/graphql/create-one-resolver.factory.ts', source_location: 'L10', node_kind: 'method', community: 0 },
          { id: 'query_runner_execute', label: 'CommonBaseQueryRunnerService.execute', file_type: 'code', source_file: '/src/api/common/common-base-query-runner.service.ts', source_location: 'L20', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'workspace_manager', label: 'WorkspaceEntityManager', file_type: 'code', source_file: '/src/orm/workspace-entity-manager.ts', source_location: 'L30', node_kind: 'class', community: 1 },
          { id: 'workspace_save', label: 'WorkspaceEntityManager.save', file_type: 'code', source_file: '/src/orm/workspace-entity-manager.ts', source_location: 'L40', node_kind: 'method', framework_role: 'repository', community: 1 },
          { id: 'workspace_query_execute', label: 'WorkspaceUpdateQueryBuilder.execute', file_type: 'code', source_file: '/src/orm/workspace-update-query-builder.ts', source_location: 'L50', node_kind: 'method', framework_role: 'repository', community: 1 },
        ],
        edges: [
          { source: 'resolver_create', target: 'query_runner_execute', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api/graphql/create-one-resolver.factory.ts' },
          { source: 'workspace_manager', target: 'workspace_save', relation: 'method', confidence: 'EXTRACTED', source_file: '/src/orm/workspace-entity-manager.ts' },
          { source: 'workspace_save', target: 'workspace_query_execute', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/orm/workspace-entity-manager.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildTwentyDisconnectedBranchChoiceGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'resolver_factory', label: 'CreateOneResolverFactory', file_type: 'code', source_file: '/src/api/graphql/create-one-resolver.factory.ts', source_location: 'L10', node_kind: 'class', framework_role: 'nest_provider', community: 0 },
          { id: 'resolver_factory_create', label: '.create()', file_type: 'code', source_file: '/src/api/graphql/create-one-resolver.factory.ts', source_location: 'L20', node_kind: 'method', community: 0 },
          { id: 'resolver_helper', label: '.processRecord()', file_type: 'code', source_file: '/src/api/graphql/object-records-to-graphql-connection.helper.ts', source_location: 'L30', node_kind: 'method', community: 0 },
          { id: 'query_runner_execute', label: 'CommonBaseQueryRunnerService.execute', file_type: 'code', source_file: '/src/api/common/common-base-query-runner.service.ts', source_location: 'L40', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'workspace_manager', label: 'WorkspaceEntityManager', file_type: 'code', source_file: '/src/orm/workspace-entity-manager.ts', source_location: 'L50', node_kind: 'class', community: 1 },
          { id: 'workspace_save', label: 'WorkspaceEntityManager.save', file_type: 'code', source_file: '/src/orm/workspace-entity-manager.ts', source_location: 'L60', node_kind: 'method', framework_role: 'repository', community: 1 },
          { id: 'workspace_query_execute', label: 'WorkspaceUpdateQueryBuilder.execute', file_type: 'code', source_file: '/src/orm/workspace-update-query-builder.ts', source_location: 'L70', node_kind: 'method', framework_role: 'repository', community: 1 },
        ],
        edges: [
          { source: 'resolver_factory', target: 'resolver_factory_create', relation: 'method', confidence: 'EXTRACTED', source_file: '/src/api/graphql/create-one-resolver.factory.ts' },
          { source: 'resolver_factory_create', target: 'resolver_helper', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api/graphql/create-one-resolver.factory.ts' },
          { source: 'resolver_factory_create', target: 'query_runner_execute', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api/graphql/create-one-resolver.factory.ts' },
          { source: 'workspace_manager', target: 'workspace_save', relation: 'method', confidence: 'EXTRACTED', source_file: '/src/orm/workspace-entity-manager.ts' },
          { source: 'workspace_save', target: 'workspace_query_execute', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/orm/workspace-entity-manager.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildTwentyPhaseRecoveryGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'resolver_factory', label: 'CreateOneResolverFactory', file_type: 'code', source_file: '/src/api/graphql/create-one-resolver.factory.ts', source_location: 'L10', node_kind: 'class', framework_role: 'nest_provider', community: 0 },
          { id: 'query_runner_execute', label: 'CommonBaseQueryRunnerService.execute', file_type: 'code', source_file: '/src/api/common/common-base-query-runner.service.ts', source_location: 'L20', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'workspace_manager', label: 'WorkspaceEntityManager', file_type: 'code', source_file: '/src/orm/workspace-entity-manager.ts', source_location: 'L30', node_kind: 'class', community: 1 },
          { id: 'workspace_save', label: 'WorkspaceEntityManager.save', file_type: 'code', source_file: '/src/orm/workspace-entity-manager.ts', source_location: 'L40', node_kind: 'method', framework_role: 'repository', community: 1 },
        ],
        edges: [
          { source: 'workspace_manager', target: 'workspace_save', relation: 'method', confidence: 'EXTRACTED', source_file: '/src/orm/workspace-entity-manager.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildTwentyOutOfScopeObligationGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'resolver_create', label: 'CreateOneResolverFactory.create', file_type: 'code', source_file: '/src/api/graphql/create-one-resolver.factory.ts', source_location: 'L10', node_kind: 'method', community: 0 },
          { id: 'query_runner_execute', label: 'CommonBaseQueryRunnerService.execute', file_type: 'code', source_file: '/src/api/common/common-base-query-runner.service.ts', source_location: 'L20', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'workspace_repository_load', label: 'WorkspaceScopedRepository.load', file_type: 'code', source_file: '/src/orm/workspace-scoped-repository.ts', source_location: 'L30', node_kind: 'method', framework_role: 'repository', community: 0 },
          { id: 'ledger_mutation_log', label: 'LedgerMutationLog.fetch', file_type: 'code', source_file: '/src/orm/ledger-mutation-log.ts', source_location: 'L40', node_kind: 'method', community: 0 },
          { id: 'ledger_flush_gateway', label: 'LedgerFlushGateway.saveAll', file_type: 'code', source_file: '/src/orm/ledger-flush-gateway.ts', source_location: 'L50', node_kind: 'method', community: 1 },
        ],
        edges: [
          { source: 'resolver_create', target: 'query_runner_execute', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api/graphql/create-one-resolver.factory.ts' },
          { source: 'query_runner_execute', target: 'workspace_repository_load', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/api/common/common-base-query-runner.service.ts' },
          { source: 'workspace_repository_load', target: 'ledger_mutation_log', relation: 'calls', confidence: 'EXTRACTED', source_file: '/src/orm/workspace-scoped-repository.ts' },
        ],
      },
    ],
    { directed: true },
  )
}

function buildRuntimeProofOnlyGapGraph() {
  return build(
    [
      {
        schema_version: 1,
        nodes: [
          { id: 'api_route', label: 'POST /events/trigger', file_type: 'code', source_file: '/apps/api/route.ts', source_location: 'L10', node_kind: 'route', framework_role: 'route', community: 0 },
          { id: 'controller', label: 'TriggerController.handle', file_type: 'code', source_file: '/apps/api/controller.ts', source_location: 'L20', node_kind: 'method', framework_role: 'controller', community: 0 },
          { id: 'service', label: 'NotificationService.process', file_type: 'code', source_file: '/apps/api/service.ts', source_location: 'L30', node_kind: 'method', framework_role: 'service', community: 0 },
          { id: 'queue', label: 'NotificationQueue.addJob', file_type: 'code', source_file: '/apps/worker/queue.ts', source_location: 'L40', node_kind: 'method', framework_role: 'queue', community: 1 },
          { id: 'worker', label: 'NotificationWorker.process', file_type: 'code', source_file: '/apps/worker/worker.ts', source_location: 'L50', node_kind: 'method', framework_role: 'worker', community: 1 },
          { id: 'delivery', label: 'Notification.sendChannel', file_type: 'code', source_file: '/apps/worker/delivery.ts', source_location: 'L60', node_kind: 'method', framework_role: 'service', community: 1 },
        ],
        edges: [
          { source: 'api_route', target: 'controller', relation: 'controller_route', confidence: 'EXTRACTED', source_file: '/apps/api/route.ts' },
          { source: 'controller', target: 'service', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/api/controller.ts' },
          { source: 'service', target: 'queue', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/api/service.ts' },
          { source: 'queue', target: 'worker', relation: 'enqueues_job', confidence: 'EXTRACTED', source_file: '/apps/worker/queue.ts' },
          { source: 'worker', target: 'delivery', relation: 'calls', confidence: 'EXTRACTED', source_file: '/apps/worker/worker.ts' },
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

function compactForWithRuntimeProof(prompt: string, graph: ReturnType<typeof build>, runtimeProofProfile: Record<string, unknown>) {
  const retrieval = retrieveContext(graph, {
    question: prompt,
    budget: 3000,
    retrievalLevel: 4,
    retrievalStrategy: 'slice-v1',
    runtimeProofProfile,
  } as never)

  return compactRetrieveResult(retrieval) as ReturnType<typeof compactRetrieveResult> & {
    execution_slice?: ExecutionSliceExpectation
    answer_contract?: {
      runtime_proof?: {
        obligations: Array<{
          id: string
          label: string
          kind: string
          evidence: Array<{
            label: string
            source_file: string
            line_number: number
          }>
        }>
        missing_obligations: string[]
      }
    }
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
    const secondaryBranchTargets = new Set([
      ...(compact.execution_slice?.omitted_branches?.map((branch) => branch.to ?? '') ?? []),
      ...(compact.execution_slice?.terminal_boundaries?.flatMap((branch) => branch.steps.map((step) => step.label)) ?? []),
    ])

    expect(compact.execution_slice).toEqual(expect.objectContaining({
      status: 'complete',
      confidence: 'high',
      confidence_reasons: expect.arrayContaining([
        'explicit_anchor',
        'runtime_handoff_evidence',
        'expected_phases_covered',
      ]),
      steps: [
        expect.objectContaining({ label: 'POST /login' }),
        expect.objectContaining({ label: 'AuthController.login' }),
        expect.objectContaining({ label: 'AuthService.login' }),
        expect.objectContaining({ label: 'QueueRegistry.addJob' }),
        expect.objectContaining({ label: 'AuthWorker.process' }),
        expect.objectContaining({ label: 'SessionStore.createSession' }),
      ],
      primary_path: expect.objectContaining({
        steps: [
          expect.objectContaining({ label: 'POST /login' }),
          expect.objectContaining({ label: 'AuthController.login' }),
          expect.objectContaining({ label: 'AuthService.login' }),
          expect.objectContaining({ label: 'QueueRegistry.addJob' }),
          expect.objectContaining({ label: 'AuthWorker.process' }),
          expect.objectContaining({ label: 'SessionStore.createSession' }),
        ],
        boundaries: expect.arrayContaining([
          expect.objectContaining({
            from: 'QueueRegistry.addJob',
            to: 'AuthWorker.process',
            relation: 'enqueues_job',
          }),
        ]),
      }),
      side_effects: expect.arrayContaining([
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ label: 'AuditPublisher.publishLogin' }),
          ]),
        }),
        expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ label: 'SessionNotifier.sendLoginWebhook' }),
          ]),
        }),
      ]),
      omitted_branches: expect.arrayContaining([
        expect.objectContaining({ to: 'LoginValidator.validate' }),
      ]),
      phase_coverage: {
        expected: ['controller', 'queue', 'worker', 'persistence'],
        observed: ['controller', 'service', 'queue', 'worker', 'persistence'],
        missing: [],
      },
    }))
    expect(
      secondaryBranchTargets.has('AuthController.getStatusMessage')
      || secondaryBranchTargets.has('Logger.info'),
    ).toBe(true)
  })

  it('surfaces runtime-proof obligation coverage for Dub-style explain-runtime prompts', () => {
    const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildDubRuntimeProofGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'click'] },
          { id: 'analytics_tracking', label: 'analytics tracking', kind: 'terminal', evidence_terms: ['analytics', 'track', 'click'] },
          { id: 'destination_redirect', label: 'destination redirect', kind: 'terminal', evidence_terms: ['redirect', 'destination', 'location'] },
        ],
      },
    )
    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'LinkRedirectController.handleClick',
      'LinkRedirectService.resolveDestination',
    ]))
    expect(compact.execution_slice?.side_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'ClickAnalytics.record' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.terminal_boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'DestinationRedirect.send' }),
        ]),
      }),
    ]))
    expect(compact.answer_contract?.runtime_proof).toEqual(expect.objectContaining({
      missing_obligations: [],
      obligations: expect.arrayContaining([
        expect.objectContaining({
          id: 'request_handling',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'LinkRedirectController.handleClick' })]),
        }),
        expect.objectContaining({
          id: 'analytics_tracking',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'ClickAnalytics.record' })]),
        }),
        expect.objectContaining({
          id: 'destination_redirect',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'DestinationRedirect.send' })]),
        }),
      ]),
    }))
  })

  it('prefers the complete Dub runtime-proof flow over a lexical cron distractor', () => {
    const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildDubRuntimeProofDistractorGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'click'] },
          { id: 'analytics_tracking', label: 'analytics tracking', kind: 'terminal', evidence_terms: ['analytics', 'track', 'click'] },
          { id: 'destination_redirect', label: 'destination redirect', kind: 'terminal', evidence_terms: ['redirect', 'destination', 'location'] },
        ],
      },
    )
    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'LinkRedirectController.handleClick',
      'LinkRedirectService.resolveDestination',
    ]))
    expect(compact.execution_slice?.terminal_boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'DestinationRedirect.send' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.steps.map((step) => step.label)).not.toEqual(expect.arrayContaining([
      'GET /api/cron/streams/update-workspace-clicks',
    ]))
    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
  })

  it('prefers the complete Dub proof path over a more lexical tracking endpoint', () => {
    const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildDubRuntimeProofSplitEntryGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'click', 'middleware'] },
          { id: 'analytics_tracking', label: 'analytics tracking', kind: 'terminal', evidence_terms: ['analytics', 'track', 'click'] },
          { id: 'destination_redirect', label: 'destination redirect', kind: 'terminal', evidence_terms: ['redirect', 'destination', 'location'] },
        ],
      },
    )

    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'LinkMiddleware()',
    ]))
    expect(compact.execution_slice?.side_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'recordClick()' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.terminal_boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'NextResponse.redirect' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.answer_contract?.runtime_proof).toEqual(expect.objectContaining({
      missing_obligations: [],
      obligations: expect.arrayContaining([
        expect.objectContaining({
          id: 'request_handling',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'LinkMiddleware()' })]),
        }),
        expect.objectContaining({
          id: 'analytics_tracking',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'recordClick()' })]),
        }),
        expect.objectContaining({
          id: 'destination_redirect',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'NextResponse.redirect' })]),
        }),
      ]),
    }))
  })

  it('keeps the complete Dub proof path anchorable even with many lexical click-route distractors', () => {
    const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildDubRuntimeProofDenseDistractorGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'click', 'middleware'] },
          { id: 'analytics_tracking', label: 'analytics tracking', kind: 'terminal', evidence_terms: ['analytics', 'track', 'click'] },
          { id: 'destination_redirect', label: 'destination redirect', kind: 'terminal', evidence_terms: ['redirect', 'destination', 'location'] },
        ],
      },
    )

    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'LinkMiddleware()',
    ]))
    expect(compact.execution_slice?.side_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'recordClick()' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.terminal_boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'NextResponse.redirect' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.steps.map((step) => step.label)).not.toEqual(expect.arrayContaining([
      'GET /api/cron/0/update-workspace-clicks',
    ]))
    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
  })

  it('prioritizes proof-critical analytics branches ahead of generic helper branches', () => {
    const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildDubRuntimeProofCrowdedBranchGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'click', 'middleware'] },
          { id: 'analytics_tracking', label: 'analytics tracking', kind: 'terminal', evidence_terms: ['analytics', 'track', 'click'] },
          { id: 'destination_redirect', label: 'destination redirect', kind: 'terminal', evidence_terms: ['redirect', 'destination', 'location'] },
        ],
      },
    )

    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'LinkMiddleware()',
    ]))
    expect(compact.execution_slice?.side_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'recordClick()' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.terminal_boundaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'NextResponse.redirect' }),
        ]),
      }),
    ]))
    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
  })

  it('keeps complete strict runtime-proof slices high confidence despite omitted helper branches', () => {
    const prompt = 'How does Dub resolve a short-link click from request handling through analytics tracking and destination redirect?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildStrictRuntimeProofConfidenceGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'click', 'middleware'] },
          { id: 'analytics_tracking', label: 'analytics tracking', kind: 'terminal', evidence_terms: ['analytics', 'track', 'click'] },
          { id: 'destination_redirect', label: 'destination redirect', kind: 'terminal', evidence_terms: ['redirect', 'destination', 'location'] },
        ],
      },
    )

    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
    expect(compact.execution_slice?.confidence).toBe('high')
    expect(compact.execution_slice?.confidence_reasons).not.toContain('multiple_omitted_branches')
  })

  it('keeps Formbricks-style complete runtime proofs covered when request, persistence, and analytics are all present', () => {
    const prompt = 'How does Formbricks process a survey response from request handling through persistence and analytics/event tracking?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildFormbricksRuntimeProofGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'request_handling', label: 'request handling', kind: 'entrypoint', evidence_terms: ['request', 'route', 'handler', 'response'] },
          { id: 'persistence', label: 'persistence', kind: 'terminal', evidence_terms: ['persist', 'save', 'store', 'database'] },
          { id: 'analytics_event_tracking', label: 'analytics/event tracking', kind: 'terminal', evidence_terms: ['analytics', 'event', 'track'] },
        ],
      },
    )

    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
    expect(compact.answer_contract?.runtime_proof?.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'persistence',
        evidence: expect.arrayContaining([expect.objectContaining({ label: 'SurveyResponseStore.persist' })]),
      }),
      expect.objectContaining({
        id: 'analytics_event_tracking',
        evidence: expect.arrayContaining([expect.objectContaining({ label: 'ResponseAnalytics.trackEvent' })]),
      }),
    ]))
  })

  it('prioritizes complete Twenty-style runtime proofs so persistence stays in the selected slice', () => {
    const prompt = 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildTwentyRuntimeProofGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'api_mutation_handling', label: 'API mutation handling', kind: 'entrypoint', evidence_terms: ['api', 'mutation', 'resolver', 'controller'] },
          { id: 'workspace_service_handoff', label: 'workspace service handoff', kind: 'handoff', evidence_terms: ['workspace', 'service', 'mutation'] },
          { id: 'persistence', label: 'persistence', kind: 'terminal', evidence_terms: ['persist', 'save', 'repository', 'database'] },
        ],
      },
    )

    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'RecordMutationResolver.updateRecord',
      'WorkspaceScope.apply',
    ]))
    expect(compact.execution_slice?.side_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'RecordRepository.save' }),
        ]),
      }),
    ]))
    expect(compact.answer_contract?.runtime_proof).toEqual(expect.objectContaining({
      missing_obligations: [],
      obligations: expect.arrayContaining([
        expect.objectContaining({
          id: 'persistence',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'RecordRepository.save' })]),
        }),
      ]),
    }))
  })

  it('recovers disconnected Twenty-style proof evidence when the graph has entrypoint and persistence evidence in separate scoped paths', () => {
    const prompt = 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildTwentyDisconnectedRuntimeProofGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'api_mutation_handling', label: 'API mutation handling', kind: 'entrypoint', evidence_terms: ['resolver', 'factory', 'mutation'] },
          { id: 'workspace_service_handoff', label: 'workspace service handoff', kind: 'handoff', evidence_terms: ['workspace', 'query runner', 'service'] },
          { id: 'persistence', label: 'persistence', kind: 'terminal', evidence_terms: ['workspace entity manager', 'query builder', 'save', 'persist'] },
        ],
      },
    )

    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'CreateOneResolverFactory.create',
      'CommonBaseQueryRunnerService.execute',
    ]))
    expect(compact.execution_slice?.side_effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ label: 'WorkspaceEntityManager.save' }),
        ]),
      }),
    ]))
    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: ['service', 'persistence'],
      observed: expect.arrayContaining(['service', 'persistence']),
      missing: [],
    }))
    expect(compact.answer_contract?.runtime_proof).toEqual(expect.objectContaining({
      missing_obligations: [],
      obligations: expect.arrayContaining([
        expect.objectContaining({
          id: 'api_mutation_handling',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'CreateOneResolverFactory.create' })]),
        }),
        expect.objectContaining({
          id: 'persistence',
          evidence: expect.arrayContaining([expect.objectContaining({ label: 'WorkspaceEntityManager.save' })]),
        }),
      ]),
    }))
  })

  it('chooses the service-carrying recovery branch for disconnected Twenty-style proofs when a lexical helper branch is also available', () => {
    const prompt = 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildTwentyDisconnectedBranchChoiceGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'api_mutation_handling', label: 'API mutation handling', kind: 'entrypoint', evidence_terms: ['update one resolver', 'create one resolver', 'resolver factory', 'direct execution'] },
          { id: 'workspace_service_handoff', label: 'workspace service handoff', kind: 'handoff', evidence_terms: ['common update one query runner', 'common create one query runner', 'common base query runner', 'workspace entity manager'] },
          { id: 'persistence', label: 'persistence', kind: 'terminal', evidence_terms: ['workspace update query builder', 'workspace scoped repository', 'workspace entity manager'] },
        ],
      },
    )

    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual(expect.arrayContaining([
      'CommonBaseQueryRunnerService.execute',
    ]))
    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: ['service', 'persistence'],
      observed: expect.arrayContaining(['service', 'persistence']),
      missing: [],
    }))
  })

  it('recovers missing proof-critical phases when runtime obligations are already complete', () => {
    const prompt = 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildTwentyPhaseRecoveryGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'api_mutation_handling', label: 'API mutation handling', kind: 'entrypoint', evidence_terms: ['update one resolver', 'create one resolver', 'resolver factory', 'direct execution'] },
          { id: 'workspace_service_handoff', label: 'workspace service handoff', kind: 'handoff', evidence_terms: ['common update one query runner', 'common create one query runner', 'common base query runner', 'workspace entity manager'] },
          { id: 'persistence', label: 'persistence', kind: 'terminal', evidence_terms: ['workspace update query builder', 'workspace scoped repository', 'workspace entity manager'] },
        ],
      },
    )

    const visibleLabels = [
      ...(compact.execution_slice?.steps.map((step) => step.label) ?? []),
      ...((compact.execution_slice?.side_effects ?? []).flatMap((branch) => branch.steps.map((step) => step.label))),
    ]

    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: ['service', 'persistence'],
      observed: expect.arrayContaining(['service', 'persistence']),
      missing: [],
    }))
    expect(visibleLabels).toEqual(expect.arrayContaining([
      'CommonBaseQueryRunnerService.execute',
    ]))
  })

  it('recovers out-of-scope obligation evidence when the proof node never entered the initial slice scope', () => {
    const prompt = 'How does Twenty process a CRM record mutation from API handling through workspace services to persistence?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildTwentyOutOfScopeObligationGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'api_mutation_handling', label: 'API mutation handling', kind: 'entrypoint', evidence_terms: ['resolver', 'factory', 'mutation'] },
          { id: 'workspace_service_handoff', label: 'workspace service handoff', kind: 'handoff', evidence_terms: ['workspace', 'query runner', 'service'] },
          { id: 'persistence', label: 'persistence', kind: 'terminal', evidence_terms: ['ledger', 'flush gateway', 'save all'] },
        ],
      },
    )

    const branchLabels = [
      ...((compact.execution_slice?.side_effects ?? []).flatMap((branch) => branch.steps.map((step) => step.label))),
      ...((compact.execution_slice?.terminal_boundaries ?? []).flatMap((branch) => branch.steps.map((step) => step.label))),
    ]

    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
    expect(compact.answer_contract?.runtime_proof?.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'persistence',
        evidence: expect.arrayContaining([expect.objectContaining({ label: 'LedgerFlushGateway.saveAll' })]),
      }),
    ]))
    expect(branchLabels).toContain('LedgerFlushGateway.saveAll')
    expect(compact.execution_slice?.status).toBe('complete')
  })

  it('recovers route-shaped booking entrypoints when downstream proof is anchored but the route edge is only structural', () => {
    const prompt = 'How does Cal.diy turn a booking request into availability validation, scheduled event persistence, and notification delivery?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildCalStructuralEntrypointGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'booking_request', label: 'booking request', kind: 'entrypoint', evidence_terms: ['API /api/book/event', 'getRegularBookingService()'] },
          { id: 'availability_validation', label: 'availability validation', kind: 'handoff', evidence_terms: ['ensureAvailableUsers', 'AvailabilityValidator.validate'] },
          { id: 'scheduled_event_persistence', label: 'scheduled event persistence', kind: 'terminal', evidence_terms: ['BookingStore.save'] },
          { id: 'notification_delivery', label: 'notification delivery', kind: 'terminal', evidence_terms: ['sendScheduledEmailsAndSMS'] },
        ],
      },
    )

    const visibleLabels = [
      ...(compact.execution_slice?.steps.map((step) => step.label) ?? []),
      ...((compact.execution_slice?.side_effects ?? []).flatMap((branch) => branch.steps.map((step) => step.label))),
      ...((compact.execution_slice?.terminal_boundaries ?? []).flatMap((branch) => branch.steps.map((step) => step.label))),
    ]

    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual([])
    expect(visibleLabels).toEqual(expect.arrayContaining([
      'API /api/book/event',
      'AvailabilityValidator.ensureAvailableUsers',
      'BookingStore.save',
      'sendScheduledEmailsAndSMS()',
    ]))
    expect(compact.answer_contract?.runtime_proof?.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'booking_request',
        evidence: expect.arrayContaining([expect.objectContaining({ label: 'API /api/book/event' })]),
      }),
    ]))
  })

  it('marks strict runtime-proof slices partial when only named obligations remain missing', () => {
    const prompt = 'How does Novu process a notification trigger from API entry through workflow orchestration to channel delivery?'
    const compact = compactForWithRuntimeProof(
      prompt,
      buildRuntimeProofOnlyGapGraph(),
      {
        prompt,
        strict_runtime_proof: true,
        expected_spi: false,
        obligations: [
          { id: 'api_entry', label: 'API entry', kind: 'entrypoint', evidence_terms: ['api', 'request', 'route', 'trigger'] },
          { id: 'workflow_orchestration', label: 'workflow orchestration', kind: 'handoff', evidence_terms: ['workflow', 'orchestrate', 'trigger'] },
          { id: 'channel_delivery', label: 'channel delivery', kind: 'terminal', evidence_terms: ['channel', 'delivery', 'send'] },
        ],
      },
    )

    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      missing: [],
      observed: expect.arrayContaining(['controller', 'service', 'queue', 'worker', 'notification_or_event']),
    }))
    expect(compact.answer_contract?.runtime_proof?.missing_obligations).toEqual(['workflow_orchestration'])
    expect(compact.execution_slice?.status).toBe('partial')
    expect(compact.execution_slice?.boundary_reason).toMatch(/workflow orchestration/i)
    expect(compact.execution_slice?.primary_path?.boundary_reason).toMatch(/workflow orchestration/i)
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

    expect((sliced as any).slice.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'POST /login' }),
      ]),
    )
    expect((sliced as any).slice.anchors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'LoginValidator.validate' }),
      ]),
    )
    expect(compact.execution_slice?.steps[0]).toEqual(
      expect.objectContaining({ label: 'POST /login' }),
    )
  })

  it('marks execution slices partial when the runtime path cannot reach a worker phase', () => {
    const compact = compactFor(
      'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      buildSliceGraph({ includeWorkerStep: false }),
    )

    expect(compact.execution_slice?.status).toBe('partial')
    expect(compact.execution_slice?.confidence).toBe('low')
    expect(compact.execution_slice?.confidence_reasons).toEqual(expect.arrayContaining([
      'no_runtime_handoff',
      'missing_phase:worker',
    ]))
    expect(compact.execution_slice?.boundary_reason).toMatch(/worker/i)
    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: expect.arrayContaining(['worker']),
      missing: expect.arrayContaining(['worker']),
    }))
  })

  it('marks execution slices partial when the runtime path misses persistence after the worker phase', () => {
    const compact = compactFor(
      'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      buildSliceGraph({ includePersistenceStep: false }),
    )

    expect(compact.execution_slice?.status).toBe('partial')
    expect(compact.execution_slice?.confidence).toBe('medium')
    expect(compact.execution_slice?.confidence_reasons).toEqual(expect.arrayContaining([
      'runtime_handoff_evidence',
      'missing_phase:persistence',
    ]))
    expect(compact.execution_slice?.boundary_reason).toMatch(/persistence/i)
    expect(compact.execution_slice?.steps.map((step) => step.label)).toEqual([
      'POST /login',
      'AuthController.login',
      'AuthService.login',
      'QueueRegistry.addJob',
      'AuthWorker.process',
    ])
    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: expect.arrayContaining(['persistence']),
      missing: expect.arrayContaining(['persistence']),
    }))
  })

  it('marks runtime paths partial when queue work only reaches a generic orchestrator.process step', () => {
    const compact = compactFor(
      'Trace how `POST /login` reaches persistence in the backend runtime pipeline',
      buildSliceGraph({
        workerLabel: 'JobOrchestrator.process',
        workerSourceFile: '/src/auth/orchestrator.ts',
        workerFrameworkRole: 'orchestrator',
      }),
    )

    expect(compact.execution_slice?.status).toBe('partial')
    expect(compact.execution_slice?.boundary_reason).toMatch(/worker/i)
    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      missing: expect.arrayContaining(['worker']),
    }))
  })

  it('does not require controller or service phases for queue-to-worker persistence questions', () => {
    const compact = compactFor(
      'Trace how `QueueRegistry.addJob` reaches persistence in the backend runtime pipeline',
      buildWorkerSegmentGraph(),
    )

    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.execution_slice?.phase_coverage).toEqual({
      expected: ['queue', 'worker', 'persistence'],
      observed: ['queue', 'worker', 'persistence'],
      missing: [],
    })
  })

  it('treats direct controller-to-store flows as complete when persistence is reached without queue work', () => {
    const compact = compactFor(
      'Trace how `POST /login` reaches persistence in the backend flow',
      buildDirectPersistenceGraph(),
    )

    expect(compact.execution_slice).toEqual(expect.objectContaining({
      status: 'complete',
      confidence: 'high',
      steps: [
        expect.objectContaining({ label: 'POST /login' }),
        expect.objectContaining({ label: 'AuthController.login' }),
        expect.objectContaining({ label: 'AuthService.login' }),
        expect.objectContaining({ label: 'SessionStore.createSession' }),
      ],
      phase_coverage: expect.objectContaining({
        expected: expect.arrayContaining(['controller', 'persistence']),
        observed: expect.arrayContaining(['controller', 'service', 'persistence']),
        missing: [],
      }),
    }))
  })

  it('does not infer controller or service phases from generic request wording on worker questions', () => {
    const compact = compactFor(
      'Why do requests fail after `QueueRegistry.addJob` in the worker runtime pipeline?',
      buildWorkerSegmentGraph(),
    )

    expect(compact.execution_slice?.status).toBe('complete')
    expect(compact.execution_slice?.phase_coverage).toEqual({
      expected: ['queue', 'worker'],
      observed: ['queue', 'worker', 'persistence'],
      missing: [],
    })
  })

  it('reports extra observed phases even when the prompt does not require them', () => {
    const compact = compactFor(
      'Trace how `QueueRegistry.addJob` runs in the backend runtime pipeline',
      buildWorkerSegmentGraph(),
    )

    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: ['queue', 'worker'],
      observed: expect.arrayContaining(['queue', 'worker', 'persistence']),
      missing: [],
    }))
  })

  it('surfaces auth_guard and validation phases when the prompt explicitly asks for them', () => {
    const compact = compactFor(
      'Trace how `POST /login` passes auth guard and validation before reaching persistence in the backend runtime pipeline',
    )

    expect(compact.execution_slice?.phase_coverage).toEqual(expect.objectContaining({
      expected: ['controller', 'auth_guard', 'validation', 'queue', 'worker', 'persistence'],
      observed: expect.arrayContaining([
        'controller',
        'auth_guard',
        'validation',
        'service',
        'queue',
        'worker',
        'persistence',
      ]),
      missing: [],
    }))
  })

  it('keeps auth guard and validation branches visible when the prompt explicitly asks for them', () => {
    const compact = compactFor(
      'Trace how `POST /login` passes auth guard and validation before reaching persistence in the backend runtime pipeline',
    )

    const sideEffectLabels = compact.execution_slice?.side_effects?.flatMap((branch) => branch.steps.map((step) => step.label)) ?? []
    const omittedTargets = compact.execution_slice?.omitted_branches?.map((branch) => branch.to ?? '') ?? []

    expect(sideEffectLabels).toEqual(expect.arrayContaining([
      'AuthGuard',
      'LoginValidator.validate',
    ]))
    expect(omittedTargets).not.toEqual(expect.arrayContaining([
      'AuthGuard',
      'LoginValidator.validate',
    ]))
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
    expect(labels).toContain('QueueRegistry.addJob')
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
