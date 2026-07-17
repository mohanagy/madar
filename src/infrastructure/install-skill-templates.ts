import type { SkillInstallPlatform } from './install.js'
import {
  renderMarkdownCodexRoutingTable,
  renderMarkdownMcpRoutingTable,
} from './install-routing-guidance.js'

/**
 * Built-in skill template generation for madar.
 *
 * This module programmatically generates platform-specific `SKILL.md` content so the
 * npm package stays self-contained even when `assets/skills/` is not shipped. Package
 * assets take precedence when present; these built-in templates are the fallback.
 */
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

const FRONTMATTER: Record<PlatformKind, string> = {
  default: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  codex: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  gemini: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  aider: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  opencode: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  claw: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  droid: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  trae: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
  windows: `---
name: ${SKILL_NAME}
description: any input (code, docs, papers, images, media) → knowledge graph → clustered communities → HTML + JSON + audit report
trigger: ${SKILL_COMMAND}
---`,
}

function commonOverview(): string {
  return `# ${SKILL_COMMAND}

Turn any folder of files into a navigable knowledge graph with community detection, an honest audit trail, and three outputs: interactive HTML, GraphRAG-ready JSON, and a plain-language GRAPH_REPORT.md.

## Usage

${CODE_BLOCK_START}
${SKILL_COMMAND}
${SKILL_COMMAND} <path>
${SKILL_COMMAND} <path> --mode deep
${SKILL_COMMAND} <path> --update
${SKILL_COMMAND} <path> --cluster-only
${SKILL_COMMAND} <path> --no-viz
${SKILL_COMMAND} <path> --svg
${SKILL_COMMAND} <path> --graphml
${SKILL_COMMAND} <path> --neo4j
${SKILL_COMMAND} <path> --neo4j-push bolt://localhost:7687
${SKILL_COMMAND} <path> --mcp
${SKILL_COMMAND} <path> --watch
${SKILL_COMMAND} query "<question>"
${SKILL_COMMAND} query "<question>" --dfs
${SKILL_COMMAND} query "<question>" --budget 1500
${SKILL_COMMAND} path "AuthModule" "Database"
${SKILL_COMMAND} explain "SwinTransformer"
${CODE_BLOCK_END}

## What ${SKILL_NAME} is for

${SKILL_NAME} is built around local codebase understanding: point it at a repository or workspace and get a structured knowledge graph that helps AI coding agents understand, change, review, debug, and validate code with evidence.

Three things it does that an assistant alone cannot:
1. **Persistent graph** — relationships are stored in ${CODE_SPAN_START}out/graph.json${CODE_SPAN_END} and survive across sessions.
2. **Honest audit trail** — every edge is tagged EXTRACTED, INFERRED, or AMBIGUOUS.
3. **Cross-document surprise** — community detection exposes connections across files that users often would not ask for directly.

Use it for:
- a codebase you are new to
- a monorepo with many services or packages
- reviewing a change and its blast radius
- tracing how a feature flows through code and docs

Current media scope: local audio/video files land as deterministic file nodes only. There is no transcription or segment extraction yet.

Treat every local MCP server, hook, plugin, or AGENTS profile as a trust boundary. Only enable it for repositories and local agent runtimes you trust. Prefer the smallest installed surface that still answers the task: \`--profile strict\` for supported MCP installs, or the context-pack-first AGENTS profile where that is the only supported shape.

## What You Must Do When Invoked

If no path was given, use ${CODE_SPAN_START}.${CODE_SPAN_END} (current directory). Do not ask the user for a path.

Follow these steps in order and do not skip steps.
`
}

function posixInstallStep(): string {
  return `### Step 1 - Ensure the TypeScript CLI is available

${CODE_BLOCK_START}bash
command -v node >/dev/null 2>&1 || {
  echo "[madar] Node.js is required for madar."
  exit 1
}
node dist/src/cli/bin.js --help >/dev/null 2>&1 || npx --yes madar --help >/dev/null 2>&1 || {
  echo "[madar] madar CLI is not available in this environment."
  echo "[madar] Install or build the TypeScript package before continuing."
  exit 1
}
mkdir -p out
${CODE_BLOCK_END}

Use Node.js / TypeScript tooling only. Never install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
`
}

function windowsInstallStep(): string {
  return `### Step 1 - Ensure the TypeScript CLI is available

${CODE_BLOCK_START}powershell
npx --yes madar --help *> $null
if ($LASTEXITCODE -ne 0) {
  node dist/src/cli/bin.js --help *> $null
}
if ($LASTEXITCODE -ne 0) {
  Write-Error "madar CLI is not available in this environment. Install or build the TypeScript package before continuing."
  exit 1
}
mkdir -p out
${CODE_BLOCK_END}

Use Node.js / TypeScript tooling only. Never install or invoke Python, pip, a legacy Python package, or a deleted reference checkout.
`
}

function detectStep(codeFence: 'bash' | 'powershell'): string {
  const targetPathDeclaration = codeFence === 'bash' ? 'TARGET_PATH="."' : '$TargetPath = "."'
  const availabilityCheck =
    codeFence === 'bash'
      ? 'node dist/src/cli/bin.js --help >/dev/null 2>&1 || npx --yes madar --help >/dev/null 2>&1'
      : 'npx --yes madar --help *> $null; if ($LASTEXITCODE -ne 0) { node dist/src/cli/bin.js --help *> $null }'

  return `### Step 2 - Detect files with the TypeScript implementation

${CODE_BLOCK_START}${codeFence}
${targetPathDeclaration}
# If the user supplied a path, set the shell variable above before running this command.
${availabilityCheck}
${CODE_BLOCK_END}

If this installation does not yet expose a top-level TypeScript detect/build command, stop and explain that limitation clearly.
Never fall back to Python.
Do not print the JSON directly; present a concise summary instead:

- Corpus: X files · ~Y words
- code/docs/papers/images/audio/video counts

If ${CODE_SPAN_START}total_files${CODE_SPAN_END} is 0, stop.
If the corpus is very large, warn and ask which subfolder to run on.
Otherwise continue directly.
`
}

function semanticDispatchSection(kind: PlatformKind): string {
  if (kind === 'codex') {
    return `**Step B2 - Dispatch with Codex workers**

Use ${CODE_SPAN_START}spawn_agent${CODE_SPAN_END} only after the context pack identifies the files and risks worth parallelizing. Launch all workers in the same response so they run in parallel. Collect results with ${CODE_SPAN_START}wait(handle)${CODE_SPAN_END} and then ${CODE_SPAN_START}close_agent(handle)${CODE_SPAN_END}.
`
  }

  if (kind === 'aider') {
    return `**Step B2 - Sequential extraction (Aider)**

Multi-agent support is still limited on Aider, so extraction runs sequentially there. Read each uncached file yourself, extract nodes/edges/hyperedges, and accumulate the results carefully instead of pretending parallel workers exist.
`
  }

  if (kind === 'opencode') {
    return `**Step B2 - Dispatch with OpenCode mentions**

Use one ${CODE_SPAN_START}@mention${CODE_SPAN_END} per chunk and send all mentions in a single message so they run in parallel.
`
  }

  if (kind === 'claw') {
    return `**Step B2 - Sequential extraction (OpenClaw)**

OpenClaw support is still early, so extraction runs sequentially. Read each uncached file yourself, extract nodes/edges/hyperedges, and accumulate the results. Mention clearly that this platform is sequential.
`
  }

  if (kind === 'droid') {
    return `**Step B2 - Dispatch with Factory Droid tasks**

Use the ${CODE_SPAN_START}Task${CODE_SPAN_END} tool once per chunk. Launch every task in the same response so the workers execute in parallel and return structured JSON.
`
  }

  if (kind === 'trae') {
    return `**Step B2 - Dispatch with the Agent (Task) tool**

Use the Agent/Task tool once per chunk. Launch all agents in parallel, collect structured JSON from each worker, and merge the results. Trae does not support PreToolUse hooks, so AGENTS.md is the always-on integration mechanism.
`
  }

  return `**Step B2 - Dispatch all extraction subagents in parallel**

Use the Agent tool once per chunk and launch every worker in the same response. Each worker must return only valid JSON containing nodes, edges, hyperedges, and token counts.
`
}

function extractionRules(): string {
  return `### Step 3 - Extract entities and relationships

Before starting, note whether ${CODE_SPAN_START}--mode deep${CODE_SPAN_END} was given. Pass that state through every semantic worker.

This step has two parts: structural extraction (deterministic, free) and semantic extraction (LLM, costs tokens).

Run Part A (AST) and Part B (semantic) in parallel whenever possible.

#### Part A - Structural extraction for code files

Use the deterministic extractor for code files and write the result to ${CODE_SPAN_START}.madar_ast.json${CODE_SPAN_END}.

#### Part B - Semantic extraction

Fast path: if the corpus is code-only, skip semantic extraction.

Before dispatching subagents:
- check the semantic cache
- split uncached files into chunks of roughly 20-25 files
- keep related files together when possible

Required extraction rules:
- EXTRACTED = explicit in source
- INFERRED = reasonable inference
- AMBIGUOUS = uncertain but still worth flagging
- include rationale nodes and ${CODE_SPAN_START}rationale_for${CODE_SPAN_END} edges when the corpus explains why a decision was made
- add ${CODE_SPAN_START}semantically_similar_to${CODE_SPAN_END} sparingly for genuinely cross-cutting similarities
- confidence_score is required on every edge
- EXTRACTED confidence_score = 1.0

Worker output schema:
${CODE_BLOCK_START}json
{"schema_version":2,"nodes":[{"id":"filestem_entityname","label":"Human Readable Name","file_type":"code|document|paper|image|audio|video|rationale","source_file":"relative/path","source_location":"L1","layer":"base|semantic|media","provenance":[{"capability_id":"builtin:extract:markdown","stage":"extract","source_file":"relative/path","source_location":"L1"}],"source_url":null,"captured_at":null,"author":null,"contributor":null}],"edges":[{"source":"node_id","target":"node_id","relation":"calls|implements|references|cites|conceptually_related_to|shares_data_with|semantically_similar_to|rationale_for","confidence":"EXTRACTED|INFERRED|AMBIGUOUS","confidence_score":1.0,"source_file":"relative/path","source_location":"L1","layer":"base|semantic|media","provenance":[{"capability_id":"builtin:extract:markdown","stage":"extract","source_file":"relative/path","source_location":"L1"}],"weight":1.0}],"hyperedges":[{"id":"snake_case_id","label":"Human Readable Label","nodes":["node_id1","node_id2","node_id3"],"relation":"participate_in|implement|form","confidence":"EXTRACTED|INFERRED","confidence_score":0.75,"source_file":"relative/path","layer":"base|semantic|media","provenance":[{"capability_id":"builtin:extract:markdown","stage":"extract","source_file":"relative/path","source_location":"L1"}]}],"input_tokens":0,"output_tokens":0}
${CODE_BLOCK_END}
`
}

function codexProfileSection(kind: PlatformKind): string {
  if (kind !== 'codex') {
    return ''
  }

  return `## Codex CLI profile

Only use madar when the task needs local repository source-code context. Skip it for GitHub Projects board reviews, external URL/WebFetch-only tasks, ${CODE_SPAN_START}gh auth${CODE_SPAN_END} / ${CODE_SPAN_START}gh project${CODE_SPAN_END} setup, package-registry/security pages, and Product Hunt or marketing copy work.

Use madar as a context-pack-first layer for Codex CLI. Before broad shell search, raw file reads, or ${CODE_SPAN_START}spawn_agent${CODE_SPAN_END} worker dispatch, generate or refresh the graph and compile the narrow task context:

${CODE_BLOCK_START}bash
madar generate .
madar pack "<task or question>" --task explain
# Use --task review, --task debug, or --task impact when that better matches the work.
${CODE_BLOCK_END}

For each codebase question, start with the specific Madar command below first:

${renderMarkdownCodexRoutingTable()}

Pass the entire user's codebase request byte-for-byte as the pack question, including read-only, no-change, scope, and formatting constraints. Do not rewrite, omit, expand, enumerate, or split it into follow-up pack calls.

If MCP graph tools are available after the pack, use the focused tool that matches the next question:
- ${CODE_SPAN_START}retrieve${CODE_SPAN_END} for direct codebase questions
- ${CODE_SPAN_START}relevant_files${CODE_SPAN_END} for where to open first
- ${CODE_SPAN_START}feature_map${CODE_SPAN_END} for involved areas and entry points
- ${CODE_SPAN_START}risk_map${CODE_SPAN_END} before editing
- ${CODE_SPAN_START}implementation_checklist${CODE_SPAN_END} for edit order and validation checkpoints
- ${CODE_SPAN_START}impact${CODE_SPAN_END} for blast radius
- ${CODE_SPAN_START}graph_summary${CODE_SPAN_END} for repo overview

After calling Madar, treat \`evidence.answerability.state\` as authoritative; \`evidence.pack_confidence\` is compatibility-only:
- \`ready\` means answer from the pack without broad raw search.
- \`ready_with_caveat\` means answer from the pack and state \`evidence.answerability.caveats\`.
- \`verify_targets\` means use one listed \`context_expand\` handle. In strict MCP mode, treat that expansion result as terminal rather than following a new handle or opening a raw file.
- \`insufficient\` means follow \`evidence.answerability.broad_search_fallback\`; \`blocked\` forbids source probing and only \`allowed\` permits one directory-scoped search.
For read-only \`explain\` tasks, \`ready\` and \`ready_with_caveat\` are terminal: cite \`source_file\`, \`label\`, \`line_number\` / \`snippet_line_number\`, and the included snippets directly. Do not run repository \`Read\`, \`Grep\`, \`Glob\`, or \`Bash\` merely to verify the pack, obtain exact lines, or reopen selected files.
Do not run broad \`Glob\` patterns, repo-wide \`grep\` / \`find\` searches, or raw file sweeps for \`ready\`, \`ready_with_caveat\`, or \`verify_targets\`.
For codebase questions, use Madar tools only. Do not call another MCP or restart broad exploration unless \`evidence.answerability.broad_search_fallback\` is \`allowed\`.
Madar already ran bounded cumulative recovery. For \`verify_targets\`, use one listed handle instead of restarting discovery; in strict MCP mode, the expansion result is terminal.
If an auto-activated skill recommends broader exploration, defer to Madar's answerability and exact verification targets.
Do not open ${CODE_SPAN_START}out/GRAPH_REPORT.md${CODE_SPAN_END} unless the context pack or graph tools are unavailable, stale, or insufficient.

Install or remove the workspace-scoped Codex profile with:

${CODE_BLOCK_START}bash
madar codex install
madar codex uninstall
${CODE_BLOCK_END}

Manual verification:
1. Run ${CODE_SPAN_START}madar generate .${CODE_SPAN_END}.
2. Run ${CODE_SPAN_START}madar codex install${CODE_SPAN_END}.
3. Confirm ${CODE_SPAN_START}AGENTS.md${CODE_SPAN_END}, ${CODE_SPAN_START}.codex/hooks.json${CODE_SPAN_END}, ${CODE_SPAN_START}.codex/madar-user-prompt-submit.cjs${CODE_SPAN_END}, and the marker-owned workspace block in ${CODE_SPAN_START}~/.codex/config.toml${CODE_SPAN_END} (or ${CODE_SPAN_START}$CODEX_HOME/config.toml${CODE_SPAN_END}) exist. The block has a unique server name, pins ${CODE_SPAN_START}cwd${CODE_SPAN_END} to this workspace, and sets both startup and tool-call timeouts.
4. Only in a repository you trust, restart Codex, use ${CODE_SPAN_START}/hooks${CODE_SPAN_END} to review and trust the project ${CODE_SPAN_START}UserPromptSubmit${CODE_SPAN_END} hook, then use ${CODE_SPAN_START}/mcp${CODE_SPAN_END} or ${CODE_SPAN_START}codex mcp list${CODE_SPAN_END} to verify this workspace's Madar MCP server.
5. Run ${CODE_SPAN_START}madar doctor${CODE_SPAN_END} / ${CODE_SPAN_START}madar status${CODE_SPAN_END} to validate installed wiring, then run ${CODE_SPAN_START}madar codex uninstall${CODE_SPAN_END} and confirm unrelated AGENTS.md, hooks, user config, and other workspace registrations remain.

Codex limitations:
- Automated tests do not require the Codex binary; they verify generated text and hook config.
- The ${CODE_SPAN_START}UserPromptSubmit${CODE_SPAN_END} hook provides model-visible guidance only for local code tasks. It is guidance, not enforcement, and Codex must trust the hook before it can run.
- ${CODE_SPAN_START}madar doctor${CODE_SPAN_END} / ${CODE_SPAN_START}madar status${CODE_SPAN_END} validate on-disk files; they do not prove live Codex hook trust or MCP activation.
- Context packs narrow first-pass discovery. They do not replace targeted reads, tests, or review for code changes.
`
}

function mcpRoutingProfileSection(kind: PlatformKind): string {
  if (kind !== 'default') {
    return ''
  }

  return `## Installed MCP routing

When the project also installs madar MCP integration (for example via Claude Code or GitHub Copilot workspace config), use the specific Madar MCP tool below first for codebase questions:

${renderMarkdownMcpRoutingTable()}
`
}

function buildAndExploreSection(kind: PlatformKind): string {
  return `### Step 4 - Build graph, cluster, analyze, and export

After merging AST + semantic extraction:
- build the graph
- cluster communities
- score cohesion
- generate GRAPH_REPORT.md and graph.json
- stop immediately if the graph is empty

### Step 5 - Label communities

Write concise 2-5 word labels for each community and regenerate the report with those labels.

### Step 6 - HTML, optional Obsidian, and optional extra exports

Generate HTML by default unless ${CODE_SPAN_START}--no-viz${CODE_SPAN_END} was given.
Generate Obsidian only when explicitly requested.

Generated code graphs preserve source → target edge direction by default. Community detection still uses an undirected connectivity view. Use ${CODE_SPAN_START}--undirected${CODE_SPAN_END} only for legacy visualization output; impact, call-chain, and directional slicing require a directed graph.

Optional exports:
- ${CODE_SPAN_START}--neo4j${CODE_SPAN_END} → Cypher file
- ${CODE_SPAN_START}--neo4j-push${CODE_SPAN_END} → direct push
- ${CODE_SPAN_START}--svg${CODE_SPAN_END} → SVG
- ${CODE_SPAN_START}--graphml${CODE_SPAN_END} → GraphML
- ${CODE_SPAN_START}--mcp${CODE_SPAN_END} → start the TypeScript stdio runtime with a minimal MCP-compatible prompt/resource/tool surface

### Step 7 - Benchmark and cleanup

If the corpus has more than 5,000 words, run the token reduction benchmark. Save the manifest, update the cost tracker, clean up temp files, then present only these report sections:
- God Nodes
- Surprising Connections
- Suggested Questions

Then immediately offer exploration by asking for the most interesting suggested question.
`
}

function subcommandSection(kind: PlatformKind): string {
  const localConfigTarget =
    kind === 'trae'
      ? 'AGENTS.md (Trae)'
      : kind === 'gemini'
        ? 'GEMINI.md (Gemini CLI)'
        : kind === 'aider'
          ? 'AGENTS.md (Aider)'
          : kind === 'claw'
            ? 'AGENTS.md (OpenClaw)'
            : kind === 'codex'
              ? 'AGENTS.md (Codex)'
              : kind === 'opencode'
                ? 'AGENTS.md (OpenCode)'
                : kind === 'droid'
                  ? 'AGENTS.md (Factory Droid)'
                  : 'CLAUDE.md / AGENTS.md'
  return `## Subcommands

- ${CODE_SPAN_START}${SKILL_COMMAND} query${CODE_SPAN_END} — choose BFS by default, DFS with ${CODE_SPAN_START}--dfs${CODE_SPAN_END}, answer only from the graph, and save the answer back with ${CODE_SPAN_START}save-result${CODE_SPAN_END}.
- ${CODE_SPAN_START}${SKILL_COMMAND} path${CODE_SPAN_END} — find the shortest path between two concepts, explain each hop, then save the explanation back.
- ${CODE_SPAN_START}${SKILL_COMMAND} explain${CODE_SPAN_END} — explain one node and its neighborhood using graph evidence only.
- ${CODE_SPAN_START}${SKILL_COMMAND} --update${CODE_SPAN_END} — incremental re-extraction; skip semantic work when all changed files are code.
- ${CODE_SPAN_START}${SKILL_COMMAND} --cluster-only${CODE_SPAN_END} — re-cluster an existing graph.
- ${CODE_SPAN_START}${SKILL_COMMAND} --watch${CODE_SPAN_END} — supported candidates trigger automatic rebuilds, and known unsupported source formats refresh indexing completeness; manual refresh is only needed for unknown future formats.
- ${CODE_SPAN_START}madar hook install|uninstall|status${CODE_SPAN_END} — manage git hooks for rebuild reminders.
- ${CODE_SPAN_START}madar claude install${CODE_SPAN_END} or the platform-specific installer — write always-on instructions to ${localConfigTarget}.
`
}

function honestyRules(): string {
  return `## Honesty Rules

- Never invent an edge. If unsure, mark it AMBIGUOUS.
- Never skip the corpus size warning.
- Always surface token cost.
- Show raw cohesion scores.
- Warn before attempting HTML visualization on graphs larger than 5,000 nodes.
- Never install or invoke Python, pip, a legacy Python package, or a deleted reference checkout as a fallback.
`
}

function windowsTroubleshooting(): string {
  return `## Troubleshooting

### PowerShell scrolling or ANSI issues

If the terminal behaves oddly after a run:
1. upgrade madar
2. prefer Windows Terminal over the legacy console
3. reopen the shell if ANSI output from graph libraries corrupted rendering
`
}

function renderMarkdownWithCodeFences(markdown: string): string {
  const rendered = markdown.replaceAll(CODE_BLOCK_START, '```').replaceAll(CODE_BLOCK_END, '```').replaceAll(CODE_SPAN_START, '`').replaceAll(CODE_SPAN_END, '`')

  if (rendered.includes(CODE_BLOCK_START) || rendered.includes(CODE_BLOCK_END) || rendered.includes(CODE_SPAN_START) || rendered.includes(CODE_SPAN_END)) {
    throw new Error('error: built-in skill template rendering left unresolved code markers')
  }

  return rendered
}

function buildSkillDocument(kind: PlatformKind): string {
  const parts = [
    FRONTMATTER[kind],
    commonOverview(),
    codexProfileSection(kind),
    mcpRoutingProfileSection(kind),
    kind === 'windows' ? windowsInstallStep() : posixInstallStep(),
    detectStep(kind === 'windows' ? 'powershell' : 'bash'),
    extractionRules(),
    semanticDispatchSection(kind),
    buildAndExploreSection(kind),
    subcommandSection(kind),
    kind === 'windows' ? windowsTroubleshooting() : '',
    honestyRules(),
  ].filter((part) => part.length > 0)

  return renderMarkdownWithCodeFences(parts.join('\n\n').trimEnd() + '\n')
}

/**
 * Generate a complete built-in `SKILL.md` document for the requested install platform.
 */
export function getBuiltInSkillContent(platform: SkillInstallPlatform): string {
  const content = buildSkillDocument(PLATFORM_KIND_BY_INSTALL_PLATFORM[platform])

  if (content.trim().length === 0) {
    throw new Error(`error: built-in template for ${platform} generated empty content`)
  }

  return content
}
