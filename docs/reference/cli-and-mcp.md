# CLI and MCP reference

This page keeps the command, installer, and MCP tool details out of the README while preserving the same local-first trust boundary.

## Agent installs

Madar produces local context packs that any modern coding agent can consume over MCP or by piping the compiled prompt to its CLI.

| Agent | Connection | Install command | `doctor` / `status` lint surface |
|---|---|---|---|
| Claude Code | MCP via `.mcp.json` | `madar claude <install\|uninstall> [--profile core\|full\|strict]` | `CLAUDE.md` + `.claude/settings.json` hook + `.mcp.json` |
| Cursor | MCP via `.cursor/mcp.json` | `madar cursor <install\|uninstall> [--profile core\|full\|strict]` | `.cursor/rules/madar.mdc` + `.cursor/mcp.json` |
| GitHub Copilot CLI | MCP via `.vscode/mcp.json` | `madar copilot <install\|uninstall> [--profile core\|full\|strict]` | `.vscode/mcp.json` |
| Gemini CLI | MCP server | `madar gemini <install\|uninstall> [--profile core\|full\|strict]` | `GEMINI.md` + `.gemini/settings.json` hook |
| Aider | AGENTS.md context-pack-first profile | `madar aider install` | `AGENTS.md` Aider profile |
| OpenCode | AGENTS.md + `.opencode/plugins/madar.js` + MCP via `opencode.json` / `opencode.jsonc` | `madar opencode install` | `AGENTS.md` OpenCode profile + plugin registration + MCP entry |
| Codex CLI | AGENTS.md + task-applicable `UserPromptSubmit` hook + MCP via `.codex/config.toml` | `madar codex install` | `AGENTS.md` Codex profile + `.codex/hooks.json` + `.codex/madar-user-prompt-submit.cjs` + `.codex/config.toml` |
| Windsurf / others | Pipe `madar prompt` output | `madar prompt "..." --provider claude` | n/a |

These are local installers that write project instructions and, when the platform supports it, local MCP config or plugin files that point at the Madar subprocess. No code is uploaded.

After `madar generate .`, `madar doctor` and `madar status` check the local install wiring. If one of those AGENTS profiles or an expected hook/plugin/MCP file drifts, those commands mark the agent as `partial` and suggest the matching reinstall command.

For the full install matrix, generated files, verification paths, profile behavior, and known limitations for both dedicated installers and `madar install --platform ...`, see the [compatibility guide](../integrations/compatibility.md).

For practical multi-agent workflows across Claude Code, Codex, Copilot, Cursor, and Gemini, see the [agent orchestration guide](../integrations/agent-orchestration.md).

## Strict and context-pack-first profiles

Treat every Madar MCP install, plugin, hook, or AGENTS profile as a local trust boundary. Only enable it for repositories and local agent runtimes you trust. Prefer `--profile strict` when you only need the lean core MCP tools.

For Claude, Cursor, Copilot, and Gemini, `--profile strict` keeps the lean core MCP tool surface. `--profile strict` keeps the seven core MCP tools but adds one bounded `context_pack` call per task through the generated guidance. In practice that compact flow is: call `context_pack` once for the task before broader exploration, answer after one high- or medium-confidence pack when `diagnostics.quality_score >= 0.5` and `missing_context` is empty, do not run broad `Glob` patterns, repo-wide `grep` / `find` searches, or raw file sweeps after that strong pack, prefer Madar over non-Madar MCPs for codebase questions unless Madar returns `agent_directive: explore_with_caution`, let that Madar guidance override conflicting auto-activated exploration skills, expand only when `missing_context` / `missing_semantic` or diagnostics justify it, and keep `out/GRAPH_REPORT.md` as a fallback-only read when the pack or graph tools are unavailable, stale, or insufficient.

Aider and OpenCode are intentionally context-pack-first: run `madar generate .`, install the profile, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. `madar aider install` writes an AGENTS.md profile only; remove it with `madar aider uninstall`. `madar opencode install` writes the AGENTS.md profile, `.opencode/plugins/madar.js`, and the Madar MCP entry in `opencode.json` or `opencode.jsonc`; remove only Madar-owned content with `madar opencode uninstall`.

Codex is intentionally context-pack-first too: run `madar generate .`, install with `madar codex install`, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. The install writes the Madar-owned AGENTS.md section, `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and a marker-owned `[mcp_servers.madar]` block in `.codex/config.toml`. Its `UserPromptSubmit` hook provides model-visible guidance only for local code tasks; it is guidance, not enforcement. Enable it only in a trusted repository, restart or start a new Codex session, use `/hooks` to review and trust the project hook, then verify the server through `/mcp` or `codex mcp list`. `madar doctor` and `madar status` validate on-disk install state only, not live Codex trust or activation. To remove the profile, run `madar codex uninstall`; it removes only Madar-owned AGENTS, hook, script, and marked TOML content while preserving unrelated content.

## MCP Registry metadata

The checked-in public registry manifest lives at [`docs/mcp-registry/server.json`](../mcp-registry/server.json). Validate it locally with:

```bash
npm run registry:validate
```

The official MCP Registry hosts metadata, not Madar code or your local graph artifact. Madar's registry entry points back to the public npm package and the same local-first runtime flow: run `madar generate .` to create `out/graph.json`, then start the local stdio server with `npx @lubab/madar serve --stdio out/graph.json`, or let `madar <agent> install` write that wiring for you. Generated Claude and Cursor MCP configs now call the installed `madar` command as `madar serve --stdio <absolute project graph path>` instead of writing a version-pinned `npx` launcher into the repo-local config.

If you still discover older `graphify-ts` links or listings, Madar is the current project name. Use `https://github.com/mohanagy/madar` and `@lubab/madar` as the canonical repository and package surfaces.

Private registry usage stays out of scope for the public Madar listing because the official MCP Registry only accepts public package sources. Keep private or self-hosted registry workflows separate from this metadata file.

## MCP tools

These seven MCP tools handle the most common agent workflows in the default core profile. Start with `graph_summary` for a bounded deterministic first-turn overview, then use `retrieve` or `context_pack` when you need task-specific evidence.

| Tool | When the agent uses it |
|---|---|
| `retrieve` | "How does X work?" - ranked nodes + code snippets + community context |
| `pr_impact` | "Is this PR safe to merge?" - diff-aware blast radius + ranked review risks |
| `impact` | "What breaks if I refactor X?" - directed dependents + affected communities |
| `call_chain` | "How does request flow from X to Y?" - shortest execution paths |
| `community_overview` | "Show me the architecture" - communities + sizes + bridges |
| `graph_stats` | "How big is this graph?" - node/edge counts, density, file-type mix |
| `graph_summary` | "Give me the repo at a glance" - bounded deterministic overview of counts, domains, top modules, entrypoints, frameworks, and runtime paths |

`--profile strict` keeps those seven core tools but adds one bounded `context_pack` call per task before broader exploration. The full surface is 26 tools, opt-in via `MADAR_TOOL_PROFILE=full` or `--profile full` on install. Full-profile additions beyond that strict one-pack flow: `context_pack`, `context_expand`, `context_prompt`, `context_session_reset`, `risk_map`, `implementation_checklist`, `relevant_files`, `feature_map`, `time_travel_compare`, `community_details`, `query_graph`, `get_node`, `get_neighbors`, `explain_node`, `shortest_path`, `graph_diff`, `god_nodes`, `semantic_anomalies`, `get_community`.

Full request/response examples live in [`examples/mcp-tool-examples.md`](../../examples/mcp-tool-examples.md).

Within one MCP stdio session, identical `context_pack` requests for `task=explain` are reused automatically when the graph version and relevant prompt/options match. The cache is memory-only, skips delta-session packs, and invalidates itself when `graph.json` changes.

## Graph freshness contract

`madar pack`, `madar prompt`, and `madar handoff` all surface graph freshness so local callers can distinguish whole-repo drift from selected-context drift. On git workspaces, Madar compares the graph's recorded build commit plus dirty-file snapshot against the current HEAD and working-tree diff; on non-git workspaces it falls back to stored file fingerprints. The overall status can be `fresh`, `partially_stale`, `possibly_stale`, `stale`, or `missing`, and the receipt also reports selected context freshness so unrelated indexed changes do not block by default. `madar doctor` and `madar status` report the same statuses and recommend regeneration when the graph is not fresh.

Use `--require-fresh-context` on `madar pack`, `madar prompt`, or `madar handoff` to refuse selected context drift instead of only warning. Use `--require-fresh-graph` when any repo drift should block. The MCP equivalents are `require_fresh_context` and `require_fresh_graph` on `context_pack` and `context_prompt`. For machine-readable consumers, packs expose the receipt under `governance.graph_freshness` and prompts expose it under `graph_freshness`. The governance receipt remains source-safe and does not include the local `graph_path`.

Cached `context_pack` explain responses still refresh the current freshness receipt before reuse, so a cache hit does not hide newly changed or missing indexed source files.

## Common commands

```bash
madar generate .                          # build the graph
madar generate . --spi                    # framework metadata + disk cache
madar watch .                             # rebuild on file change
madar summary                             # bounded JSON overview
madar pack "how does auth work?" --task explain --format text
madar pack "add auth telemetry" --task implement --format json
madar pack "why does auth fail?" --task explain --retrieval-strategy slice-v1
madar pack "how does auth work?" --task explain --require-fresh-context
madar pack "how does auth work?" --task explain --require-fresh-graph
madar prompt "how does auth work?" --provider claude
madar handoff "add auth telemetry" --task implement --consumer copilot
madar review-compare out/graph.json --exec '...' --yes
madar compare "How does auth work?" --exec '...' --yes
madar compare "How does auth work?" --baseline-mode pack_only --exec '...' --yes
madar telemetry enable
madar telemetry status
madar telemetry clear
madar telemetry report
madar time-travel main HEAD --view risk
madar federate frontend/graph.json backend/graph.json
madar --help
```

On Windows, `compare`, `review-compare`, and benchmark `--exec` templates run under `cmd.exe`, so prefer `type {prompt_file} | claude ...` over PowerShell-specific piping or quoting.

## Default discovery rules

`madar generate` hard-ignores nested VCS/worktree copies and generated/build output by default: `.worktrees/`, `worktrees/`, `.git/`, `out/`, `node_modules/`, `dist/`, `build/`, `coverage/`, cache folders, source maps, lock/build artifacts, and temp/log files.

Tests, benchmarks, fixtures, mocks, and config files are not hard-ignored. They still get indexed so retrieval can use them when you ask for them, but production/runtime prompts soft-penalize them and honor prompt exclusions like "exclude tests, benchmarks, fixtures".

`.madarignore` adds extra ignore rules, and negated entries such as `!vendor/**` or `!lib/**` can re-include a default hard-ignore when you intentionally want it indexed.
