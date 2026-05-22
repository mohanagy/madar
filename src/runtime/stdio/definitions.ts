export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface McpPromptDefinition {
  name: string
  title: string
  description: string
  arguments?: Array<{
    name: string
    description: string
    required?: boolean
  }>
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'query_graph',
    description: 'Traverse the graph to answer a question from graph evidence.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string' },
        mode: { type: 'string', enum: ['bfs', 'dfs'] },
        depth: { type: 'number' },
        token_budget: { type: 'number' },
        rank_by: { type: 'string', enum: ['relevance', 'degree'] },
        community_id: { type: 'number' },
        file_type: { type: 'string' },
      },
    },
  },
  {
    name: 'get_node',
    description: 'Return details for one graph node.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
      },
    },
  },
  {
    name: 'graph_diff',
    description: 'Compare the current graph to a baseline graph.json and summarize what changed.',
    inputSchema: {
      type: 'object',
      required: ['baseline_graph_path'],
      properties: {
        baseline_graph_path: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'semantic_anomalies',
    description: 'Return the highest-signal semantic anomalies in the current graph snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        top_n: { type: 'number' },
      },
    },
  },
  {
    name: 'get_neighbors',
    description: 'Return neighbors for one node, optionally filtered by relation.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        relation_filter: { type: 'string' },
      },
    },
  },
  {
    name: 'shortest_path',
    description: 'Find the shortest path between two labels in the graph.',
    inputSchema: {
      type: 'object',
      required: ['source', 'target'],
      properties: {
        source: { type: 'string' },
        target: { type: 'string' },
        max_hops: { type: 'number' },
      },
    },
  },
  {
    name: 'explain_node',
    description: 'Explain a node and summarize its neighborhood.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        relation_filter: { type: 'string' },
      },
    },
  },
  {
    name: 'graph_stats',
    description: 'Return summary graph statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'graph_summary',
    description: 'Return a compact deterministic repo summary for coding agents.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'god_nodes',
    description: 'Return the most connected non-file nodes in the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        top_n: { type: 'number' },
      },
    },
  },
  {
    name: 'get_community',
    description: 'Return the members of a community by numeric id.',
    inputSchema: {
      type: 'object',
      required: ['community_id'],
      properties: {
        community_id: { type: 'number' },
      },
    },
  },
  {
    name: 'community_details',
    description:
      'Get structured details about a community at different zoom levels. Micro: name + top 3 nodes. Mid: key nodes, entry/exit points, bridges. Macro: all nodes, edges, file distribution. Use with retrieve for token-efficient codebase exploration.',
    inputSchema: {
      type: 'object',
      required: ['community_id'],
      properties: {
        community_id: { type: 'number', description: 'Community ID to get details for' },
        zoom: { type: 'string', enum: ['micro', 'mid', 'macro'], description: 'Detail level (default: mid)' },
      },
    },
  },
  {
    name: 'community_overview',
    description: 'Overview of all communities: names, sizes, top nodes. Call first to map the codebase before zooming in.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'impact',
    description: 'Blast-radius for a node: direct + transitive dependents, affected files and communities.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string', description: 'Node label' },
        depth: { type: 'number', description: 'Max traversal depth (default 3, max 5)' },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to edge types (e.g. ["calls","imports_from"])',
        },
        verbose: { type: 'boolean', description: 'Return verbose payload (default: compact)' },
      },
    },
  },
  {
    name: 'call_chain',
    description: 'Ordered execution paths between two nodes via call/import edges.',
    inputSchema: {
      type: 'object',
      required: ['source', 'target'],
      properties: {
        source: { type: 'string', description: 'Starting node label' },
        target: { type: 'string', description: 'Target node label' },
        max_hops: { type: 'number', description: 'Max chain length (default 8)' },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to follow (default: ["calls","imports_from"])',
        },
      },
    },
  },
  {
    name: 'pr_impact',
    description: 'Blast-radius of current git changes: parses diff, finds affected nodes, computes review bundle.',
    inputSchema: {
      type: 'object',
      properties: {
        base_branch: { type: 'string', description: 'Base branch (default: auto-detect main/master)' },
        depth: { type: 'number', description: 'Blast-radius depth (default 3)' },
        budget: { type: 'number', description: 'Review bundle token budget (default 2000)' },
        verbose: { type: 'boolean', description: 'Return verbose payload (default: compact)' },
      },
    },
  },
  {
    name: 'retrieve',
    description: 'Retrieve matched nodes, snippets, relationships, and community context for a question.',
    inputSchema: {
      type: 'object',
      required: ['question', 'budget'],
      properties: {
        question: { type: 'string', description: 'Natural-language question' },
        budget: { type: 'number', description: 'Max tokens in the context bundle' },
        community: { type: 'number', description: 'Filter to one community id' },
        file_type: { type: 'string', description: 'Filter to one file type (e.g. code, document)' },
        semantic: { type: 'boolean', description: 'Enable embedding-based semantic fallback' },
        semantic_model: { type: 'string', description: 'Override semantic model or local path' },
        rerank: { type: 'boolean', description: 'Enable cross-encoder reranking' },
        rerank_model: { type: 'string', description: 'Override reranker model or local path' },
        verbose: { type: 'boolean', description: 'Return verbose payload (default: compact)' },
        retrieval_level: { type: 'number', description: 'Override retrieval-gate level 0-5 (#75)' },
        retrieval_strategy: { type: 'string', enum: ['default', 'slice-v1'], description: 'Experimental retrieval strategy.' },
      },
    },
  },
  {
    name: 'context_pack',
    description:
      'Build a compact explain/review/impact context pack with expandable refs and coverage signals.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Task prompt or question to build context for' },
        task: { type: 'string', enum: ['explain', 'review', 'impact'], description: 'Context-pack mode (default: explain)' },
        budget: { type: 'number', description: 'Optional: maximum token budget for the pack (default 3000)' },
        delta_session_id: { type: 'string', description: 'Optional (#81): delta-pack session key for per-session dedup.' },
        verbose: { type: 'boolean', description: 'Optional: include extended selection diagnostics.' },
        retrieval_strategy: { type: 'string', enum: ['default', 'slice-v1'], description: 'Experimental retrieval strategy.' },
        resolution: {
          type: 'string',
          enum: ['detail', 'summary', 'mixed', 'signature', 'sketch'],
          description: 'Node resolution.',
        },
      },
    },
  },
  {
    name: 'context_pack_session_reset',
    description: 'Reset a delta-pack session so the next context_pack ships the full pack.',
    inputSchema: {
      type: 'object',
      required: ['delta_session_id'],
      properties: {
        delta_session_id: { type: 'string', description: 'Delta session key' },
      },
    },
  },
  {
    name: 'context_expand',
    description:
      'Expand a previously returned context_pack handle_id into a focused follow-up pack. Use when a context_pack response omitted supporting nodes that now need exact expansion.',
    inputSchema: {
      type: 'object',
      required: ['handle_id'],
      properties: {
        handle_id: { type: 'string', description: 'Stable handle_id from a prior context_pack response in the same MCP session' },
        budget: { type: 'number', description: 'Optional: maximum token budget for the focused expansion (default 1500)' },
      },
    },
  },
  {
    name: 'context_prompt',
    description:
      'Compile a provider-ready context prompt. Use provider=claude with session_id for cache-aware follow-ups, or provider=gemini for a plain prompt string.',
    inputSchema: {
      type: 'object',
      required: ['prompt', 'provider'],
      properties: {
        prompt: { type: 'string', description: 'Task prompt or question to compile' },
        provider: { type: 'string', enum: ['claude', 'gemini'], description: 'Target prompt consumer' },
        budget: { type: 'number', description: 'Optional: retrieval budget used to gather graph evidence (default 3000)' },
        session_id: { type: 'string', description: 'Optional: server-managed Claude session key for cache-aware follow-ups.' },
        reset_session: { type: 'boolean', description: 'Optional: clear any stored server-side session before compiling this prompt.' },
        session_state: { type: 'object', description: 'Optional: explicit previous session_state payload to continue without using session_id.' },
      },
    },
  },
  {
    name: 'context_session_reset',
    description:
      'Reset a stored context_prompt session when switching topics or when you want the next Claude prompt to resend the full stable context.',
    inputSchema: {
      type: 'object',
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', description: 'Server-managed context_prompt session key to clear' },
      },
    },
  },
  {
    name: 'relevant_files',
    description:
      'Return the most relevant files for a feature or change question, ranked with short explanations of why each file matters.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'Natural language feature or change question' },
        budget: { type: 'number', description: 'Optional: retrieval budget used to gather evidence (default 4000)' },
        limit: { type: 'number', description: 'Optional: maximum number of files to return (default 8)' },
        community: { type: 'number', description: 'Optional: limit file ranking to one community id' },
        file_type: { type: 'string', description: 'Optional: limit ranking to one file type (e.g. code, document)' },
      },
    },
  },
  {
    name: 'feature_map',
    description:
      'Return a high-level feature map for a change question: primary communities, likely entry points, and starter files.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'Natural language feature or change question' },
        budget: { type: 'number', description: 'Optional: retrieval budget used to gather evidence (default 4000)' },
        limit: { type: 'number', description: 'Optional: maximum number of communities, entry points, and files to return (default 5)' },
        community: { type: 'number', description: 'Optional: limit the feature map to one community id' },
        file_type: { type: 'string', description: 'Optional: limit the feature map to one file type (e.g. code, document)' },
      },
    },
  },
  {
    name: 'risk_map',
    description:
      'Return a pre-change risk briefing for a feature question: likely blast radius, structural hotspots, and starter files.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'Natural language feature or change question' },
        budget: { type: 'number', description: 'Optional: retrieval budget used to gather evidence (default 4000)' },
        limit: { type: 'number', description: 'Optional: maximum number of risks and hotspots to return (default 5)' },
        community: { type: 'number', description: 'Optional: limit the risk map to one community id' },
        file_type: { type: 'string', description: 'Optional: limit the risk map to one file type (e.g. code, document)' },
      },
    },
  },
  {
    name: 'implementation_checklist',
    description:
      'Return an ordered implementation checklist for a feature question: edit steps first, then validation checkpoints for entry points and shared risks.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'Natural language feature or change question' },
        budget: { type: 'number', description: 'Optional: retrieval budget used to gather evidence (default 4000)' },
        limit: { type: 'number', description: 'Optional: maximum number of edit steps and validations to return (default 5)' },
        community: { type: 'number', description: 'Optional: limit the checklist to one community id' },
        file_type: { type: 'string', description: 'Optional: limit the checklist to one file type (e.g. code, document)' },
      },
    },
  },
  {
    name: 'time_travel_compare',
    description: 'Compare two git refs using on-demand cached graph snapshots and return summary, risk, drift, or timeline output.',
    inputSchema: {
      type: 'object',
      required: ['from_ref', 'to_ref'],
      properties: {
        from_ref: { type: 'string' },
        to_ref: { type: 'string' },
        view: { type: 'string', enum: ['summary', 'risk', 'drift', 'timeline'] },
        refresh: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
]

export type McpToolProfile = 'core' | 'full'

/**
 * The minimal set of tools shipped by default. Keeps cache_creation overhead
 * low on Claude Code session start. Opt into the full surface by setting
 * MADAR_TOOL_PROFILE=full in the MCP server env block.
 */
export const CORE_TOOL_NAMES = ['retrieve', 'impact', 'call_chain', 'community_overview', 'pr_impact', 'graph_stats', 'graph_summary'] as const

export type McpCoreToolName = (typeof CORE_TOOL_NAMES)[number]

export function activeMcpTools(profile: McpToolProfile = 'core'): McpToolDefinition[] {
  if (profile === 'full') {
    return MCP_TOOLS
  }
  const core = new Set<string>(CORE_TOOL_NAMES)
  return MCP_TOOLS.filter((tool) => core.has(tool.name))
}

export function resolveToolProfileFromEnv(env: NodeJS.ProcessEnv = process.env): McpToolProfile {
  const raw = (env.MADAR_TOOL_PROFILE ?? '').trim().toLowerCase()
  return raw === 'full' ? 'full' : 'core'
}

export function isCoreToolName(name: string, profile: McpToolProfile = 'core'): boolean {
  if (profile === 'full') {
    return true
  }
  return (CORE_TOOL_NAMES as readonly string[]).includes(name)
}

export const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: 'graph_query_prompt',
    title: 'Graph Evidence Query',
    description: 'Ask a question and answer it using graph evidence only.',
    arguments: [
      { name: 'question', description: 'The question to answer from the graph', required: true },
      { name: 'mode', description: 'Traversal mode: bfs or dfs' },
    ],
  },
  {
    name: 'graph_path_prompt',
    title: 'Graph Path Exploration',
    description: 'Explain the shortest path between two graph concepts.',
    arguments: [
      { name: 'source', description: 'Starting concept label', required: true },
      { name: 'target', description: 'Target concept label', required: true },
    ],
  },
  {
    name: 'graph_explain_prompt',
    title: 'Graph Node Explanation',
    description: 'Explain a single node and summarize its neighborhood.',
    arguments: [
      { name: 'label', description: 'Node label to explain', required: true },
      { name: 'relation', description: 'Optional neighbor relation filter' },
    ],
  },
  {
    name: 'graph_community_summary_prompt',
    title: 'Graph Community Summary',
    description: 'Summarize one community, its key nodes, and its boundaries.',
    arguments: [{ name: 'community_id', description: 'Numeric community id to summarize', required: true }],
  },
  {
    name: 'context_pack_prompt',
    title: 'Context Pack Request',
    description: 'Prepare a compact explain/review/impact context pack with expandable refs and missing-context hints.',
    arguments: [
      { name: 'prompt', description: 'Task prompt or question to gather context for', required: true },
      { name: 'task', description: 'Pack mode: explain, review, or impact' },
      { name: 'budget', description: 'Optional token budget for the pack' },
    ],
  },
  {
    name: 'context_prompt_prompt',
    title: 'Context Prompt Compilation',
    description: 'Compile a provider-ready context prompt. Reuse a Claude session_id for follow-up prompts that send only deltas.',
    arguments: [
      { name: 'prompt', description: 'Task prompt or question to compile', required: true },
      { name: 'provider', description: 'Target provider: claude or gemini', required: true },
      { name: 'session_id', description: 'Optional Claude session id to reuse stable context' },
    ],
  },
  {
    name: 'context_session_reset_prompt',
    title: 'Context Session Reset',
    description: 'Reset a stored context_prompt session before starting a fresh Claude thread or changing topics.',
    arguments: [{ name: 'session_id', description: 'Server-managed context_prompt session id to reset', required: true }],
  },
]
