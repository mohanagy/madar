import { KnowledgeGraph } from '../../src/contracts/graph.js'

interface FlowNode {
  id: string
  label: string
  source: string
  community: number
  role?: string
  metadata?: Record<string, unknown>
}

const FLOW_NODES: FlowNode[] = [
  {
    id: 'failed_check',
    label: 'FailedMonitorCheck.publishUpdate',
    source: '/apps/checker/update.go',
    community: 1,
    role: 'monitor_checker',
  },
  {
    id: 'status_route',
    label: 'POST /updateStatus',
    source: '/apps/workflows/src/checker/index.ts',
    community: 2,
    role: 'http_route',
    metadata: { route_path: '/updateStatus', http_method: 'POST' },
  },
  {
    id: 'incident_create',
    label: 'createIncidentForFailedCheck',
    source: '/apps/workflows/src/checker/alerting.ts',
    community: 2,
    role: 'incident_writer',
  },
  {
    id: 'notification_dispatch',
    label: 'triggerNotifications',
    source: '/apps/workflows/src/checker/utils.ts',
    community: 3,
    role: 'notification_dispatcher',
  },
  {
    id: 'incident_table',
    label: 'incidentTable',
    source: '/packages/db/src/schema/incidents.ts',
    community: 4,
    role: 'persistence_schema',
  },
  {
    id: 'public_status',
    label: 'statusPageRouter.get',
    source: '/packages/api/src/router/statusPage.ts',
    community: 5,
    role: 'public_status_reader',
  },
  {
    id: 'alternate_status',
    label: 'computeOverallStatus',
    source: '/apps/server/src/routes/status-page/index.ts',
    community: 6,
    role: 'alternate_status_computation',
  },
  {
    id: 'status_json',
    label: 'serializePublicStatusJson',
    source: '/apps/status-page/src/content/status-json.ts',
    community: 5,
    role: 'public_status_feed',
  },
]

const UI_DISTRACTOR_LABELS = [
  'page /monitors/[id]/incidents',
  'page /notifications',
  'statusPageAlternates()',
  'PublicStatusPageStatusCard',
] as const

const UI_DISTRACTORS: FlowNode[] = Array.from({ length: 14 }, (_, index) => ({
  id: `status_ui_${index}`,
  label: UI_DISTRACTOR_LABELS[index] ?? (
    index % 2 === 0 ? `PublicStatusPageStatusCard${index}` : `MonitorNotificationStatusBadge${index}`
  ),
  source: `/apps/web/src/components/status/status-page-widget-${index}.tsx`,
  community: 9,
  role: 'ui_component',
}))

const FLOW_EDGES: Array<[string, string, string]> = [
  ['failed_check', 'status_route', 'calls_route'],
  ['status_route', 'incident_create', 'calls'],
  ['incident_create', 'incident_table', 'writes'],
  ['incident_create', 'notification_dispatch', 'calls'],
  ['public_status', 'incident_table', 'reads'],
  ['status_json', 'public_status', 'serializes'],
  ['alternate_status', 'status_json', 'competes_with'],
]

export const CROSS_LAYER_MONITOR_FLOW_FILES = [
  'apps/checker/update.go',
  'apps/workflows/src/checker/index.ts',
  'apps/workflows/src/checker/alerting.ts',
  'apps/workflows/src/checker/utils.ts',
  'packages/db/src/schema/incidents.ts',
  'packages/api/src/router/statusPage.ts',
  'apps/server/src/routes/status-page/index.ts',
  'apps/status-page/src/content/status-json.ts',
] as const

export function buildCrossLayerMonitorFlowFixture(): KnowledgeGraph {
  const graph = new KnowledgeGraph({ directed: true })
  graph.graph.root_path = '/'
  graph.graph.community_labels = {
    1: 'Monitor check execution',
    2: 'Incident workflow update route',
    3: 'Notification delivery',
    4: 'Incident persistence schema',
    5: 'Public status page reads',
    6: 'Alternative status computation',
    9: 'Status presentation components',
  }

  for (const node of [...FLOW_NODES, ...UI_DISTRACTORS]) {
    graph.addNode(node.id, {
      label: node.label,
      source_file: node.source,
      source_location: 'L1-L8',
      file_type: 'code',
      node_kind: node.role === 'http_route' ? 'route' : 'function',
      community: node.community,
      snippet: `export function ${node.id}() { return '${node.label}' }`,
      ...(node.role ? { framework_role: node.role } : {}),
      ...(node.metadata ? { framework_metadata: node.metadata } : {}),
    })
  }
  for (const [source, target, relation] of FLOW_EDGES) {
    graph.addEdge(source, target, { relation })
  }
  graph.addEdge('status_ui_0', 'status_ui_1', { relation: 'links_to' })
  graph.addEdge('status_ui_1', 'status_ui_2', { relation: 'renders' })
  graph.addEdge('status_ui_2', 'status_ui_3', { relation: 'renders' })
  return graph
}
