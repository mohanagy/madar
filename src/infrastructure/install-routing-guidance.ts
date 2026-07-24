interface RoutingCopy {
  lead: string
  fallback: string
}

const ROUTING_COPY: RoutingCopy = {
  lead:
    'For a repository question, call the Madar `retrieve` tool exactly once with the user question unchanged before broad file search.',
  fallback:
    'Use authenticated evidence when it is returned; otherwise report the explicit boundary and continue with only focused verification.',
}

function plain(value: string): string {
  return value.replaceAll('`', '')
}

export function renderMarkdownMcpRoutingTable(): string {
  return `${ROUTING_COPY.lead}

| Prompt type | First tool |
| --- | --- |
| Any JavaScript or TypeScript repository question | \`retrieve\` |

${ROUTING_COPY.fallback}`
}

export function renderPlainMcpRoutingGuide(): string {
  return `${plain(ROUTING_COPY.lead)} ${ROUTING_COPY.fallback}`
}

export function renderMarkdownCodexRoutingTable(): string {
  return `${ROUTING_COPY.lead.replace(
    'call the Madar `retrieve` tool',
    'call the Madar `retrieve` MCP tool, or run `madar query "<question>"` when MCP is unavailable,',
  )}

${ROUTING_COPY.fallback}`
}

export function renderPlainCodexRoutingGuide(): string {
  return plain(renderMarkdownCodexRoutingTable())
}
