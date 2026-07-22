import type { SkillInstallPlatform } from './install.js'
import {
  renderMarkdownCodexRoutingTable,
  renderMarkdownMcpRoutingTable,
} from './install-routing-guidance.js'

/** Built-in fallback used when packaged skill assets are unavailable. */
type PlatformKind = 'default' | 'gemini' | 'codex' | 'opencode' | 'aider' | 'claw' | 'droid' | 'trae' | 'windows'

const CODE_BLOCK_START = '[[[MADAR_CODE_BLOCK_START]]]'
const CODE_BLOCK_END = '[[[MADAR_CODE_BLOCK_END]]]'
const CODE_SPAN_START = '[[[MADAR_CODE_SPAN_START]]]'
const CODE_SPAN_END = '[[[MADAR_CODE_SPAN_END]]]'
const SKILL_NAME = 'madar'
const SKILL_COMMAND = '/madar'

const PLATFORM_KIND_BY_INSTALL_PLATFORM: Record<SkillInstallPlatform, PlatformKind> = {
  claude: 'default',
  gemini: 'gemini',
  aider: 'aider',
  codex: 'codex',
  copilot: 'default',
  opencode: 'opencode',
  claw: 'claw',
  droid: 'droid',
  trae: 'trae',
  'trae-cn': 'trae',
  windows: 'windows',
}

const SKILL_FRONTMATTER = `---
name: ${SKILL_NAME}
description: index JavaScript and TypeScript repositories into an evidence-bearing graph for coding agents
trigger: ${SKILL_COMMAND}
---`

function commonOverview(): string {
  return `# ${SKILL_COMMAND}

Use Madar to build and query a local JavaScript/TypeScript knowledge graph. The published artifacts are ${CODE_SPAN_START}out/graph.json${CODE_SPAN_END}, ${CODE_SPAN_START}out/GRAPH_REPORT.md${CODE_SPAN_END}, and an indexing manifest with explicit unsupported-file receipts.

## Usage

${CODE_BLOCK_START}bash
madar generate .
madar generate . --update
madar generate . --cluster-only
madar watch .
madar query "<question>"
madar path "<source>" "<target>"
madar explain "<symbol>"
madar pack "<task or question>" --task explain
${CODE_BLOCK_END}

Use Madar for local codebase understanding, change planning, review, debugging, and impact analysis. It indexes ${CODE_SPAN_START}.ts${CODE_SPAN_END}, ${CODE_SPAN_START}.tsx${CODE_SPAN_END}, ${CODE_SPAN_START}.js${CODE_SPAN_END}, and ${CODE_SPAN_START}.jsx${CODE_SPAN_END}. Other recognized formats are reported as unsupported instead of being silently indexed by another path.

Treat local MCP servers and hooks as trust boundaries. Enable them only in repositories and agent runtimes you trust.
`
}

function installStep(kind: PlatformKind): string {
  if (kind === 'windows') {
    return `## Build the graph

Verify the installed CLI and inspect the current graph from the requested workspace:

${CODE_BLOCK_START}powershell
madar --help
$TargetPath = "."
madar status
${CODE_BLOCK_END}

Reuse the graph when status reports it fresh. Only when the graph is missing, stale, or has a generation-policy mismatch, rebuild and check again:

${CODE_BLOCK_START}powershell
madar generate $TargetPath
madar status
${CODE_BLOCK_END}

If ${CODE_SPAN_START}madar${CODE_SPAN_END} is not installed but this is a Madar source checkout, build it and use ${CODE_SPAN_START}node dist/src/cli/bin.js${CODE_SPAN_END}. Otherwise stop and report that the CLI is unavailable.`
  }

  return `## Build the graph

Verify the installed CLI and inspect the current graph from the requested workspace:

${CODE_BLOCK_START}bash
command -v node >/dev/null 2>&1 || { echo "Node.js is required"; exit 1; }
madar --help
TARGET_PATH="."
madar status
${CODE_BLOCK_END}

Reuse the graph when status reports it fresh. Only when the graph is missing, stale, or has a generation-policy mismatch, rebuild and check again:

${CODE_BLOCK_START}bash
madar generate "$TARGET_PATH"
madar status
${CODE_BLOCK_END}

If ${CODE_SPAN_START}madar${CODE_SPAN_END} is not installed but this is a Madar source checkout, build it and use ${CODE_SPAN_START}node dist/src/cli/bin.js${CODE_SPAN_END}. Otherwise stop and report that the CLI is unavailable.`
}

function codexProfileSection(kind: PlatformKind): string {
  if (kind !== 'codex') return ''

  return `## Codex CLI routing

Use Madar only when the task needs local repository source context. Start with the narrow command that matches the task:

${renderMarkdownCodexRoutingTable()}

For ${CODE_SPAN_START}pack${CODE_SPAN_END}, pass the user's complete codebase request without weakening scope or read-only constraints. Follow ${CODE_SPAN_START}evidence.answerability${CODE_SPAN_END}:

- ${CODE_SPAN_START}ready${CODE_SPAN_END}: answer from the returned evidence.
- ${CODE_SPAN_START}ready_with_caveat${CODE_SPAN_END}: answer and state the caveat.
- ${CODE_SPAN_START}verify_targets${CODE_SPAN_END}: inspect only the listed targets or use the provided expansion handle.
- ${CODE_SPAN_START}insufficient${CODE_SPAN_END}: follow the returned search policy and state what is missing.

Do not restart broad discovery when the pack is answerable. For implementation work, use the pack to choose files, then verify edits with normal tests and review.
`
}

function mcpRoutingProfileSection(kind: PlatformKind): string {
  if (kind !== 'default') return ''

  return `## MCP routing

When Madar MCP is installed, start codebase questions with the matching tool:

${renderMarkdownMcpRoutingTable()}
`
}

function workflowSection(): string {
  return `## Workflow

1. Run ${CODE_SPAN_START}madar status${CODE_SPAN_END}. Reuse a fresh graph; run ${CODE_SPAN_START}madar generate <path>${CODE_SPAN_END} only when the graph is missing, stale, policy-mismatched, or the user explicitly requests a rebuild.
2. When generation runs, read its summary. Surface indexing failures and unsupported-file receipts; do not describe unsupported scope as indexed.
3. Use the smallest graph query or context-pack command that answers the task.
4. Cite returned files, symbols, relationships, and snippets. State any remaining uncertainty.
5. For code changes, run targeted tests after editing. A graph is evidence for navigation and impact; it is not a substitute for runtime verification.

Do not create a second graph manually, dispatch workers to re-index files, merge assistant-authored JSON, or invent relationships outside Madar's canonical output.
`
}

function subcommandSection(kind: PlatformKind): string {
  const localConfigTarget =
    kind === 'trae'
      ? 'AGENTS.md (Trae)'
      : kind === 'gemini'
        ? 'GEMINI.md (Gemini CLI)'
        : kind === 'codex'
          ? 'AGENTS.md (Codex)'
          : kind === 'default'
            ? 'CLAUDE.md / AGENTS.md'
            : 'AGENTS.md'

  return `## Command semantics

- ${CODE_SPAN_START}madar generate <path>${CODE_SPAN_END} builds the canonical graph.
- ${CODE_SPAN_START}madar generate <path> --update${CODE_SPAN_END} performs a full rebuild from the current source tree.
- ${CODE_SPAN_START}madar generate <path> --cluster-only${CODE_SPAN_END} reuses the existing graph and recomputes clustering, analysis, and exports without re-indexing source.
- ${CODE_SPAN_START}madar watch <path>${CODE_SPAN_END} rebuilds after JavaScript/TypeScript changes, refreshes receipts after recognized unsupported-file changes, and records a refresh flag when an automatic rebuild fails.
- ${CODE_SPAN_START}madar doctor${CODE_SPAN_END} and ${CODE_SPAN_START}madar status${CODE_SPAN_END} report freshness, watcher state, policy mismatch, safety exclusions, and indexing completeness.
- The platform installer writes workspace guidance to ${localConfigTarget}.
`
}

function honestyRules(): string {
  return `## Honesty rules

- Never invent a node, relationship, path, or confidence claim.
- Never hide unsupported or failed indexing outcomes.
- Do not claim whole-repository coverage when the indexing manifest is partial.
- Do not present benchmark estimates as measured provider usage.
- Keep user scope and read-only constraints intact when routing through Madar.
`
}

function renderMarkdownWithCodeFences(markdown: string): string {
  const rendered = markdown
    .replaceAll(CODE_BLOCK_START, '```')
    .replaceAll(CODE_BLOCK_END, '```')
    .replaceAll(CODE_SPAN_START, '`')
    .replaceAll(CODE_SPAN_END, '`')

  if (
    rendered.includes(CODE_BLOCK_START)
    || rendered.includes(CODE_BLOCK_END)
    || rendered.includes(CODE_SPAN_START)
    || rendered.includes(CODE_SPAN_END)
  ) {
    throw new Error('error: built-in skill template rendering left unresolved code markers')
  }

  return rendered
}

function buildSkillDocument(kind: PlatformKind): string {
  return renderMarkdownWithCodeFences([
    SKILL_FRONTMATTER,
    commonOverview(),
    codexProfileSection(kind),
    mcpRoutingProfileSection(kind),
    installStep(kind),
    workflowSection(),
    subcommandSection(kind),
    honestyRules(),
  ].filter(Boolean).join('\n\n').trimEnd() + '\n')
}

/** Generate a complete built-in `SKILL.md` document for an install platform. */
export function getBuiltInSkillContent(platform: SkillInstallPlatform): string {
  const content = buildSkillDocument(PLATFORM_KIND_BY_INSTALL_PLATFORM[platform])
  if (content.trim().length === 0) {
    throw new Error(`error: built-in template for ${platform} generated empty content`)
  }
  return content
}
