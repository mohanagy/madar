export const TASK_INTENT_KINDS = [
  'explain',
  'implement',
  'review',
  'impact',
  'migrate',
  'document',
  'debug-flow',
  'pr-review-risk',
  'test-generation',
  'refactor-module',
  'dead-code',
  'security-review',
  'performance-review',
] as const

export type TaskIntentKind = (typeof TASK_INTENT_KINDS)[number]

export type TaskIntentContextKind = 'explain' | 'implement' | 'review' | 'impact'

export type TaskIntentConfidence = 'low' | 'medium' | 'high'

/**
 * Each rule must define exactly one matcher field so signal semantics stay unambiguous.
 */
export interface TaskIntentSignalRule {
  id: string
  score: number
  any_phrases?: string[]
  any_keywords?: string[]
  keyword_groups?: string[][]
}

export interface TaskIntentDefinition {
  kind: TaskIntentKind
  label: string
  description: string
  default_context_kind: TaskIntentContextKind
  priority: number
  rules: TaskIntentSignalRule[]
}

export interface TaskIntentScore {
  kind: TaskIntentKind
  score: number
}

export interface TaskIntentClassification {
  version: 1
  prompt: string
  normalized_prompt: string
  kind: TaskIntentKind
  default_context_kind: TaskIntentContextKind
  confidence: TaskIntentConfidence
  matched_rules: string[]
  matched_terms: string[]
  scores: TaskIntentScore[]
}

export const TASK_INTENT_DEFINITIONS: TaskIntentDefinition[] = [
  {
    kind: 'explain',
    label: 'Explain',
    description: 'Understand how code works, where it lives, or how pieces fit together.',
    default_context_kind: 'explain',
    priority: 0,
    rules: [
      {
        id: 'explain-explicit',
        score: 8,
        any_phrases: ['explain', 'walk me through', 'help me understand'],
      },
      {
        id: 'explain-question',
        score: 5,
        any_phrases: ['how does', 'what does', 'where is', 'how is'],
      },
    ],
  },
  {
    kind: 'implement',
    label: 'Implement',
    description: 'Build, fix, add, or wire code to change behavior.',
    default_context_kind: 'implement',
    priority: 1,
    rules: [
      {
        id: 'implement-explicit',
        score: 10,
        any_keywords: ['implement'],
      },
      {
        id: 'implement-phrases',
        score: 9,
        any_phrases: ['implement issue', 'fix issue', 'address issue', 'add support', 'wire up'],
      },
      {
        id: 'implement-keywords',
        score: 7,
        keyword_groups: [
          ['add', 'build', 'create', 'fix', 'support', 'wire'],
          ['feature', 'flow', 'behavior', 'integration', 'context', 'command', 'pipeline', 'task', 'issue'],
        ],
      },
    ],
  },
  {
    kind: 'review',
    label: 'Review',
    description: 'Inspect code or changes for quality concerns without a narrower specialty.',
    default_context_kind: 'review',
    priority: 2,
    rules: [
      {
        id: 'review-explicit',
        score: 7,
        any_keywords: ['review', 'audit'],
      },
      {
        id: 'review-phrases',
        score: 6,
        any_phrases: ['look over', 'look through'],
      },
    ],
  },
  {
    kind: 'impact',
    label: 'Impact',
    description: 'Estimate blast radius, downstream dependencies, or likely breakage.',
    default_context_kind: 'impact',
    priority: 3,
    rules: [
      {
        id: 'impact-explicit',
        score: 9,
        any_phrases: ['what breaks', 'blast radius', 'downstream impact', 'side effects'],
      },
      {
        id: 'impact-keywords',
        score: 6,
        keyword_groups: [
          ['impact', 'breaks', 'blast'],
          ['change', 'remove', 'rename', 'edit'],
        ],
      },
    ],
  },
  {
    kind: 'migrate',
    label: 'Migrate',
    description: 'Migrate names, APIs, or integration surfaces from one shape to another.',
    default_context_kind: 'implement',
    priority: 4,
    rules: [
      {
        id: 'migrate-explicit',
        score: 10,
        any_keywords: ['migrate', 'migration', 'port'],
      },
      {
        id: 'migrate-phrases',
        score: 8,
        any_phrases: ['move from', 'move to', 'rename package', 'rebrand to'],
      },
    ],
  },
  {
    kind: 'document',
    label: 'Document',
    description: 'Update README, changelog, or docs to reflect behavior and usage.',
    default_context_kind: 'implement',
    priority: 5,
    rules: [
      {
        id: 'document-explicit',
        score: 10,
        any_phrases: ['document the', 'write docs', 'write documentation', 'update the readme', 'update readme', 'update the changelog', 'document how'],
      },
      {
        id: 'document-keywords',
        score: 7,
        keyword_groups: [
          ['document', 'docs', 'readme', 'changelog', 'documentation'],
          ['write', 'update', 'refresh', 'capture'],
        ],
      },
    ],
  },
  {
    kind: 'debug-flow',
    label: 'Debug flow',
    description: 'Trace failures, identify root causes, and follow error-producing paths.',
    default_context_kind: 'impact',
    priority: 6,
    rules: [
      {
        id: 'debug-explicit',
        score: 10,
        any_phrases: ['trace why', 'root cause', 'stack trace', 'why is', 'why does', 'debug'],
      },
      {
        id: 'debug-failure',
        score: 7,
        keyword_groups: [
          ['fail', 'failing', 'failure', 'broken', 'error', 'errors', 'bug'],
          ['trace', 'debug', 'fix', 'issue', 'why'],
        ],
      },
    ],
  },
  {
    kind: 'pr-review-risk',
    label: 'PR review risk',
    description: 'Review a diff or pull request with explicit attention to merge risk.',
    default_context_kind: 'review',
    priority: 7,
    rules: [
      {
        id: 'pr-review-explicit',
        score: 11,
        any_phrases: ['review this pr', 'review the pr', 'review the diff', 'pull request review', 'pr diff'],
      },
      {
        id: 'pr-review-keywords',
        score: 8,
        keyword_groups: [
          ['review', 'audit', 'risk', 'risky', 'regression'],
          ['pr', 'diff', 'merge'],
        ],
      },
    ],
  },
  {
    kind: 'test-generation',
    label: 'Test generation',
    description: 'Create or propose regression, unit, or integration tests.',
    default_context_kind: 'implement',
    priority: 8,
    rules: [
      {
        id: 'test-generation-explicit',
        score: 10,
        any_phrases: ['write tests', 'generate tests', 'generate regression tests', 'add regression tests', 'create tests'],
      },
      {
        id: 'test-generation-keywords',
        score: 7,
        keyword_groups: [
          ['test', 'tests', 'coverage'],
          ['generate', 'write', 'add', 'regression', 'unit', 'integration'],
        ],
      },
    ],
  },
  {
    kind: 'refactor-module',
    label: 'Refactor module',
    description: 'Restructure a module or component while preserving behavior.',
    default_context_kind: 'implement',
    priority: 9,
    rules: [
      {
        id: 'refactor-explicit',
        score: 10,
        any_phrases: ['refactor the', 'refactor this', 'module cleanup'],
      },
      {
        id: 'refactor-keywords',
        score: 7,
        keyword_groups: [
          ['refactor', 'cleanup', 'rename', 'extract', 'reorganize', 'simplify'],
          ['module', 'component', 'service', 'class', 'file', 'behavior'],
        ],
      },
    ],
  },
  {
    kind: 'dead-code',
    label: 'Dead code',
    description: 'Find or remove unused, stale, or unreachable code.',
    default_context_kind: 'implement',
    priority: 10,
    rules: [
      {
        id: 'dead-code-explicit',
        score: 11,
        any_phrases: ['dead code', 'unused exports', 'unused code'],
      },
      {
        id: 'dead-code-keywords',
        score: 7,
        keyword_groups: [
          ['dead', 'unused', 'orphaned', 'stale', 'unreachable'],
          ['code', 'exports', 'files', 'paths'],
        ],
      },
    ],
  },
  {
    kind: 'security-review',
    label: 'Security review',
    description: 'Inspect attack surface, validation, and privilege boundaries.',
    default_context_kind: 'review',
    priority: 11,
    rules: [
      {
        id: 'security-explicit',
        score: 11,
        any_phrases: ['security review', 'security audit'],
      },
      {
        id: 'security-keywords',
        score: 9,
        keyword_groups: [
          ['security', 'injection', 'xss', 'csrf', 'secret', 'permission', 'bypass', 'vulnerability', 'sanitize'],
          ['review', 'audit', 'flow', 'risk', 'attack', 'issues'],
        ],
      },
    ],
  },
  {
    kind: 'performance-review',
    label: 'Performance review',
    description: 'Inspect latency, throughput, memory, or CPU behavior.',
    default_context_kind: 'impact',
    priority: 12,
    rules: [
      {
        id: 'performance-explicit',
        score: 10,
        any_phrases: ['performance review', 'performance regressions', 'latency hotspot', 'memory hotspot'],
      },
      {
        id: 'performance-keywords',
        score: 7,
        keyword_groups: [
          ['performance', 'latency', 'memory', 'cpu', 'throughput', 'hotspots', 'slow'],
          ['review', 'investigate', 'optimize', 'profile', 'regression'],
        ],
      },
    ],
  },
]
