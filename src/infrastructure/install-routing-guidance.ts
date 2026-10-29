import { SOURCE_RETRIEVAL_DISCOVERY } from '../shared/source-retrieval-guidance.js'

interface RoutingRow {
  promptType: string
  markdownTarget: string
  plainPromptType?: string
  plainTarget: string
}

const MCP_ROUTING_ROWS: RoutingRow[] = [
  {
    promptType: '"how does X work" / explain runtime / flow',
    markdownTarget: '`retrieve`',
    plainPromptType: '"how does X work?" / explain runtime / flow',
    plainTarget: 'retrieve',
  },
  {
    promptType: '"what breaks if I change X" / impact analysis',
    markdownTarget: '`impact`',
    plainPromptType: '"what breaks if I change X?" / impact analysis',
    plainTarget: 'impact',
  },
  {
    promptType: '"which files should I open first"',
    markdownTarget: '`retrieve`',
    plainPromptType: '"which files should I open first?"',
    plainTarget: 'retrieve',
  },
  {
    promptType: '"give me a repo overview"',
    markdownTarget: '`graph_summary`',
    plainPromptType: '"give me a repo overview?"',
    plainTarget: 'graph_summary',
  },
  {
    promptType: '"what parts are involved in feature X"',
    markdownTarget: '`retrieve`',
    plainTarget: 'retrieve',
  },
  {
    promptType: '"what\'s risky to edit in X"',
    markdownTarget: '`impact`',
    plainTarget: 'impact',
  },
  {
    promptType: '"give me a build/edit checklist"',
    markdownTarget: '`retrieve`',
    plainTarget: 'retrieve',
  },
  {
    promptType: 'general retrieval / list of nodes',
    markdownTarget: '`retrieve`',
    plainTarget: 'retrieve',
  },
]

const CODEX_ROUTING_ROWS: RoutingRow[] = [
  {
    promptType: '"how does X work" / explain runtime / flow',
    markdownTarget: '`madar pack "<task or question>" --task explain`',
    plainPromptType: '"how does X work?" / explain runtime / flow',
    plainTarget: 'madar pack "<task or question>" --task explain',
  },
  {
    promptType: '"what breaks if I change X" / impact analysis',
    markdownTarget: '`madar pack "<task or question>" --task impact`',
    plainPromptType: '"what breaks if I change X?" / impact analysis',
    plainTarget: 'madar pack "<task or question>" --task impact',
  },
  {
    promptType: '"which files should I open first"',
    markdownTarget: '`retrieve` when MCP graph tools are available; otherwise `madar pack "<task or question>" --task explain`',
    plainPromptType: '"which files should I open first?"',
    plainTarget: 'retrieve when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain',
  },
  {
    promptType: '"give me a repo overview"',
    markdownTarget: '`graph_summary` when MCP graph tools are available; otherwise `madar pack "<task or question>" --task explain`',
    plainPromptType: '"give me a repo overview?"',
    plainTarget: 'graph_summary when MCP graph tools are available; otherwise madar pack "<task or question>" --task explain',
  },
]

function renderMarkdownTable(lead: string, rows: RoutingRow[], discoveryGuidance: string): string {
  const lines = [
    lead,
    '',
    '| Prompt type | Optional tool or command |',
    '| --- | --- |',
    ...rows.map((row) => `| ${row.promptType} | ${row.markdownTarget} |`),
    '',
    'Broad discovery is experimental and may add tokens. Treat `evidence.answerability` as advisory retrieval coverage; verify claims against source.',
    'Use listed targets as starting points. Refine the query or inspect other source when evidence is missing; respect explicit source-access policy blocks.',
    ...(discoveryGuidance ? [discoveryGuidance] : []),
  ]
  return lines.join('\n')
}

function renderPlainGuide(
  lead: string,
  rows: RoutingRow[],
  discoveryGuidance: string,
): string {
  const rules = rows.map((row) => `${row.plainTarget} for ${row.plainPromptType ?? row.promptType}`).join('; ')
  return `${lead}: ${rules}. Broad discovery is experimental and may add tokens. Treat evidence.answerability as advisory retrieval coverage; verify claims against source. Use listed targets as starting points. Refine the query or inspect other source when evidence is missing; respect explicit source-access policy blocks. ${discoveryGuidance}`
}

export function renderMarkdownMcpRoutingTable(): string {
  return renderMarkdownTable(
    'When using Madar, choose the focused MCP tool below:',
    MCP_ROUTING_ROWS,
    SOURCE_RETRIEVAL_DISCOVERY,
  )
}

export function renderPlainMcpRoutingGuide(): string {
  return renderPlainGuide(
    'When using Madar, choose the matching MCP tool',
    MCP_ROUTING_ROWS,
    SOURCE_RETRIEVAL_DISCOVERY,
  )
}

export function renderMarkdownCodexRoutingTable(includeDiscovery = true): string {
  return renderMarkdownTable(
    'When using Madar, choose the focused command below:',
    CODEX_ROUTING_ROWS,
    includeDiscovery ? SOURCE_RETRIEVAL_DISCOVERY : '',
  )
}

export function renderPlainCodexRoutingGuide(): string {
  return renderPlainGuide(
    'When using Madar, choose the focused command below',
    CODEX_ROUTING_ROWS,
    SOURCE_RETRIEVAL_DISCOVERY,
  )
}
