# CLI and MCP reference

This page keeps the command, installer, and MCP tool details out of the README while preserving the same local-first trust boundary.

## Agent installs

Madar produces local context packs that any modern coding agent can consume over MCP or by piping the compiled prompt to its CLI.

| Agent | Connection | Install command | `doctor` / `status` lint surface |
|---|---|---|---|
| Claude Code | MCP via `.mcp.json` | `madar claude <install\|uninstall> [--profile core\|full\|strict]` | `CLAUDE.md` + `.claude/settings.json` hook + `.mcp.json` |
| Cursor | MCP via `.cursor/mcp.json` | `madar cursor <install\|uninstall> [--profile core\|full\|strict]` | `.cursor/rules/madar.mdc` + `.cursor/mcp.json` |
| GitHub Copilot CLI | MCP via `.vscode/mcp.json` | `madar copilot <install\|uninstall> [--profile core\|full\|strict]` | `.vscode/mcp.json` |
| Gemini CLI | MCP via `.gemini/settings.json` | `madar gemini <install\|uninstall> [--profile core\|full\|strict]` | `GEMINI.md` + `.gemini/settings.json` hook + MCP entry |
| Aider | AGENTS.md context-pack-first profile | `madar aider install` | `AGENTS.md` Aider profile |
| OpenCode | AGENTS.md + `.opencode/plugins/madar.js` + MCP via `opencode.json` / `opencode.jsonc` | `madar opencode install` | `AGENTS.md` OpenCode profile + plugin registration + MCP entry |
| Codex CLI | AGENTS.md + task-applicable `UserPromptSubmit` hook + workspace-scoped MCP via `~/.codex/config.toml` | `madar codex install` | `AGENTS.md` Codex profile + `.codex/hooks.json` + `.codex/madar-user-prompt-submit.cjs` + this workspace's marker-owned user-config MCP block |
| Windsurf / others | Pipe `madar prompt` output | `madar prompt "..." --provider claude` | n/a |

These are local installers that write project instructions and, when the platform supports it, local MCP config or plugin files that point at the Madar subprocess. No code is uploaded.

After `madar generate .`, `madar doctor` and `madar status` check the local install wiring. If one of those AGENTS profiles or an expected hook/plugin/MCP file drifts, those commands mark the agent as `partial` and suggest the matching reinstall command.

For the full install matrix, generated files, verification paths, profile behavior, and known limitations for both dedicated installers and `madar install --platform ...`, see the [compatibility guide](../integrations/compatibility.md).

For practical multi-agent workflows across Claude Code, Codex, Copilot, Cursor, and Gemini, see the [agent orchestration guide](../integrations/agent-orchestration.md).

## Strict and context-pack-first profiles

Treat every Madar MCP install, plugin, hook, or AGENTS profile as a local trust boundary. Only enable it for repositories and local agent runtimes you trust. Prefer `--profile strict` when you want the compact context-pack-first MCP workflow.

For Claude, Cursor, Copilot, and Gemini, `--profile strict` writes `MADAR_TOOL_PROFILE=strict`. That runtime surface exposes only `context_pack` and `context_expand`, exactly matching the generated guidance. In practice the compact flow is: call `context_pack` exactly once for the user task, copy the entire request byte-for-byte into `prompt` (including read-only, no-change, scope, and formatting constraints), then follow `evidence.answerability.state`. `ready` answers from the pack, `ready_with_caveat` answers from the pack with `evidence.answerability.caveats`, and `verify_targets` can use one listed expansion handle; the result of that one expansion is terminal and never advertises another callable target. A ready pack exposes no post-pack graph-navigation tool. Madar already performs up to two bounded cumulative recovery passes; only `insufficient` with `broad_search_fallback: allowed` permits one directory-scoped raw search. Keep `out/GRAPH_REPORT.md` as a fallback-only read when the pack or graph tools are unavailable, stale, or insufficient. `pack_confidence` remains compatibility-only. The strict server restricts Madar's own methods; it cannot identify a host's user-turn boundary or block the host agent's native file/shell tools, so the exactly-once rule is guidance verified by the recorded agent trial rather than a claim of universal enforcement.

Aider and OpenCode are intentionally context-pack-first: run `madar generate .`, install the profile, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. `madar aider install` writes an AGENTS.md profile only; remove it with `madar aider uninstall`. `madar opencode install` writes the AGENTS.md profile, `.opencode/plugins/madar.js`, and a strict-profile Madar MCP entry in `opencode.json` or `opencode.jsonc`; remove only Madar-owned content with `madar opencode uninstall`.

Codex is intentionally context-pack-first too: run `madar generate .`, install with `madar codex install`, and start broad codebase work with `madar pack "<task>" --task explain` before raw file search. Codex CLI loads MCP entries from `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`), so the install writes the Madar-owned AGENTS.md section, `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and a workspace-scoped marker-owned strict-profile MCP block there. The block has a unique server name, pins `cwd` to the installed workspace (including linked worktrees), and includes `startup_timeout_sec = 180` plus `tool_timeout_sec = 60`. Re-run the install after upgrading to migrate an obsolete project-local Madar block; user-managed declarations and other workspace registrations remain untouched. Its `UserPromptSubmit` hook provides model-visible guidance only for local code tasks; it is guidance, not enforcement. Enable it only in a trusted repository, restart or start a new Codex session, use `/hooks` to review and trust the project hook, then verify the server through `/mcp` or `codex mcp list`. `madar doctor` and `madar status` validate on-disk wiring only, not live Codex trust or activation. To remove the profile, run `madar codex uninstall`; it removes only Madar-owned AGENTS, hook, script, and this workspace's marked user-config block while preserving unrelated content.

## MCP Registry metadata and publication

The checked-in registry manifest lives at [`docs/mcp-registry/server.json`](../mcp-registry/server.json). Validate it locally with:

```bash
npm run registry:validate
```

The official MCP Registry hosts metadata, not Madar code or your local graph artifact. Once the release-gated workflow has published this manifest, its entry will ask the MCP host to run `npx @lubab/madar serve --stdio --auto-refresh`. The MCP host chooses the working directory; when it launches Madar from a workspace, Madar creates that workspace's graph when needed and refreshes it after local changes. Do not add a fixed `out/graph.json` argument to that registry command, because it would become stale and would not follow a linked Git worktree's isolated artifact directory. Start or reconnect the MCP server from each worktree the agent enters. Generated agent MCP configs use the installed `madar` command with the same `serve --stdio --auto-refresh` flow rather than a version-pinned `npx` launcher or an absolute graph path.

Publishing is intentionally a post-npm, release-tag action: after the matching `@lubab/madar` version is public, run **Publish MCP Registry metadata** from GitHub Actions with its `vX.Y.Z` tag. The workflow verifies the checked-out tag, the published npm package's `mcpName`, and this manifest; it then authenticates with GitHub OIDC, publishes `io.github.mohanagy/madar`, and checks the Registry API. This prevents a registry entry from pointing at an npm version that has not been published yet.

An already-published npm tarball cannot be retrofitted with `mcpName`. If a release predates that field, publish the next version first, update this manifest to the same version, and then dispatch the workflow. The workflow pins and SHA-256-verifies the official `mcp-publisher` binary before it requests its OIDC credential.

If you still discover older `graphify-ts` links or listings, Madar is the current project name. Use `https://github.com/mohanagy/madar` and `@lubab/madar` as the canonical repository and package surfaces.

Private registry usage stays out of scope for the public Madar listing because the official MCP Registry only accepts public package sources. Keep private or self-hosted registry workflows separate from this metadata file.

## MCP tools

These seven MCP tools handle the most common agent workflows in the default core profile. Start with `graph_summary` for a bounded deterministic first-turn overview, then use `retrieve` when you need task-specific evidence.

| Tool | When the agent uses it |
|---|---|
| `retrieve` | "How does X work?" - ranked nodes + code snippets + community context |
| `pr_impact` | "Is this PR safe to merge?" - diff-aware blast radius + ranked review risks |
| `impact` | "What breaks if I refactor X?" - directed dependents + affected communities |
| `call_chain` | "How does request flow from X to Y?" - shortest execution paths |
| `community_overview` | "Show me the architecture" - communities + sizes + bridges |
| `graph_stats` | "How big is this graph?" - node/edge counts, density, file-type mix |
| `graph_summary` | "Give me the repo at a glance" - bounded deterministic overview of counts, domains, top modules, entrypoints, frameworks, and runtime paths |

`--profile strict` exposes only `context_pack` and `context_expand`; the expansion is authorized only for a listed `verify_targets` handle, can be used once, and returns a terminal result with no follow-on handle. The default core profile exposes the seven common graph-navigation tools. The full surface is 27 tools, opt-in via `MADAR_TOOL_PROFILE=full` or `--profile full` on install. Full-only additions beyond core are `context_pack`, `context_expand`, `context_pack_session_reset`, `context_prompt`, `context_session_reset`, `risk_map`, `implementation_checklist`, `relevant_files`, `feature_map`, `time_travel_compare`, `community_details`, `query_graph`, `get_node`, `get_neighbors`, `explain_node`, `shortest_path`, `graph_diff`, `god_nodes`, `semantic_anomalies`, and `get_community`.

Full request/response examples live in [`examples/mcp-tool-examples.md`](../../examples/mcp-tool-examples.md).

Within one MCP stdio session, identical `context_pack` requests for `task=explain` are reused automatically when the graph version and relevant prompt/options match. The cache is memory-only, skips delta-session packs, and invalidates itself when `graph.json` changes.

## Graph freshness contract

`madar pack`, `madar prompt`, and `madar handoff` all surface graph freshness so local callers can distinguish whole-repo drift from selected-context drift. On git workspaces, Madar compares the graph's recorded build commit plus dirty-file snapshot against the current HEAD and working-tree diff; on non-git workspaces it falls back to stored file fingerprints. The overall status can be `fresh`, `partially_stale`, `possibly_stale`, `stale`, or `missing`, and the receipt also reports selected context freshness so unrelated indexed changes do not block by default. `madar doctor` and `madar status` report the same statuses and recommend regeneration when the graph is not fresh.

Use `--require-fresh-context` on `madar pack`, `madar prompt`, or `madar handoff` to refuse selected context drift instead of only warning. Use `--require-fresh-graph` when any repo drift should block. The MCP equivalents are `require_fresh_context` and `require_fresh_graph` on `context_pack` and `context_prompt`. For machine-readable consumers, packs expose the receipt under `governance.graph_freshness` and prompts expose it under `graph_freshness`. The governance receipt remains source-safe and does not include the local `graph_path`.

Cached `context_pack` explain responses still refresh the current freshness receipt before reuse, so a cache hit does not hide newly changed or missing indexed source files.

With `--auto-refresh`, filesystem events invalidate the graph immediately and adaptive authoritative reconciliations verify the full watched corpus. Graph-backed MCP requests fail closed while reconciliation is pending/failed or watcher coverage/policy is not trustworthy. Generation policy is versioned and fingerprinted in both `graph.json` and `manifest.json`, so automatic refresh reuses extraction mode (auto, legacy, or strict canonical JS/TS via the compatibility `--spi` selector), Git-ignore, symlink, document/non-code, exclusion, extractor, and indexing-threshold settings. Policy drift forces a full rebuild. `madar doctor` and `madar status` expose the local `watcher-state.json` health record. Full behavior and legacy migration are documented in [Auto-refresh and generation policy](../auto-refresh.md).

The stdio transport and MCP discovery stay responsive while initial reconciliation runs in a background worker. Until the watcher reaches `idle` with matching published policy, graph-backed calls return the structured error type `madar_graph_not_ready`. For transient `starting`, `pending`, or `reconciling` states, `retryable` is `true`, `retry_after_ms` is `1000`, and the suggested action is to retry the same request without bypassing Madar. Terminal failures, incomplete graphs, and policy mismatches set `retryable` to `false` and suggest graph repair; inspect `madar status`, then run `madar generate . --update` when required.

## Common commands

```bash
madar generate .                          # auto: canonical JS/TS index, plus legacy fallback for other languages
madar generate . --legacy                 # force legacy extraction only
madar generate . --spi                    # compatibility spelling for strict canonical JS/TS indexing
madar generate . --respect-gitignore      # exclude files ignored by Git
madar generate . --strict-indexing        # fail on any failed/unsupported candidate
madar generate . --max-indexing-failed 1 --max-indexing-unsupported 3
madar watch .                             # rebuild on file change
madar watch . --respect-gitignore         # watch only Git-visible source changes
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

Generated code graphs are always directed and preserve parallel evidence-bearing relationships. The CLI no longer exposes direction modes. Artifacts from the predecessor schema are intentionally unsupported; regenerate them once with `madar generate . --update`.

Every generation also writes local and share-safe indexing-completeness manifests beside `graph.json`. A valid graph is not a claim of complete source coverage. `--strict-indexing` uses zero failed and zero unsupported candidates as its thresholds; either `--max-indexing-failed N` or `--max-indexing-unsupported N` enables strict mode with the supplied allowance. See [Indexing completeness](../indexing-completeness.md) for outcome meanings, path-redaction behavior, and confidence effects.

The local `indexing-manifest.json` is also the extraction receipt: `requested_extraction_mode` records `auto`, `legacy`, or the compatibility selector `spi`; each newly indexed JS/TS outcome records `extraction_strategy: "canonical"`; and auto fallback outcomes carry `fallback_reason: "canonical_unsupported_language"`. Historical manifests with SPI-named receipt values remain readable. The graph stores the same requested mode in `generation_policy`, an aggregate `extraction_receipt`, and `extraction_strategy` on its source evidence. `--cluster-only` never re-extracts source, so it cannot be combined with `--legacy` or `--spi`; use `madar generate . --update` to change modes.

On Windows, `compare`, `review-compare`, and benchmark `--exec` templates run under `cmd.exe`, so prefer `type {prompt_file} | claude ...` over PowerShell-specific piping or quoting.

## Default discovery rules

`madar generate` hard-ignores nested VCS/worktree copies and generated/build output by default: `.worktrees/`, `worktrees/`, `.git/`, `out/`, `node_modules/`, `dist/`, `build/`, `coverage/`, cache folders, source maps, lock/build artifacts, and temp/log files.

Secret handling is source-aware. Madar indexes ordinary code whose file or ancestor names describe password, token, credential, or secret behavior. That includes `token.ts`, password reset/policy services, `secret-manager.ts`, and source below `secrets/` or `credentials/`. Names alone do not make source code secret.

Madar excludes these artifacts before extraction:

- `.env*` and `.envrc` environment files;
- private-key files such as `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, and private `id_rsa` / `id_ed25519` files;
- known credential stores including `.netrc`, `.npmrc`, `.pgpass`, `.pypirc`, `.htpasswd`, and cloud credential files;
- non-source configs explicitly named for credentials, secrets, tokens, passwords, or private keys;
- non-source files below explicit secret-storage directories such as `secrets/`, `credentials/`, or private-key directories. Source-code extensions remain indexable in those directories, but arbitrary docs/data do not receive that exception.

Unreadable files/directories and every secret-policy exclusion are recorded with structured reasons in the local graph artifact. Generate, doctor, and status output show local counts and escaped paths (up to 20 inline, with the complete list at `discovery_safety.exclusions`). When an excluded or unreadable path matches the question or retrieved workflow scope, MCP/pack evidence lowers answerability and confidence. Share-safe handoffs include the `artifact_path_only` policy marker plus `total`, `relevant`, `reasons`, and `relevant_reasons` counts under `evidence.discovery_exclusions`; they never include the local path list.

This is a conservative artifact/path policy, not a content-level secret scanner. Madar reads indexed source code, so a credential hard-coded inside an otherwise normal source file can enter the local graph/snippet artifacts. Remove such credentials from source or add the path to `.madarignore`; review any artifact before sharing it.

Tests, benchmarks, fixtures, mocks, and config files are not hard-ignored. They still get indexed so retrieval can use them when you ask for them, but production/runtime prompts soft-penalize them and honor prompt exclusions like "exclude tests, benchmarks, fixtures".

`.madarignore` adds extra ignore rules, and negated entries such as `!vendor/**` or `!lib/**` can re-include a default hard-ignore when you intentionally want it indexed.

Pass `--respect-gitignore` to additionally restrict generation to Git-tracked files and untracked files that are not ignored by Git. The option applies to `generate --watch` and the standalone `watch` command too. Outside a Git repository, Madar uses its normal discovery rules.
