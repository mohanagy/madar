# Getting started

This walkthrough proves the complete Madar path in about 10 minutes:

```text
generate a graph -> connect one agent -> make one retrieve call
```

It does not call a hosted model unless you choose to ask a connected coding agent.

## 1. Install Madar

Madar requires Node.js 20 or newer.

```bash
npm install -g @lubab/madar
madar --version
```

## 2. Generate the sample graph

From the Madar checkout:

```bash
madar generate examples/sample-workspace
cd examples/sample-workspace
```

You can also enter the workspace first and run `madar generate .`.

The expected output reports:

- detected and indexed file counts
- graph nodes and directed edges
- indexing outcomes
- the `out/graph.json` path

JavaScript and TypeScript use one canonical compiler-backed path. Unsupported languages and non-code formats do not add graph facts.

## 3. Check the graph directly

Before involving an agent, run the CLI equivalent of the MCP tool:

```bash
madar query "how does password reset request enqueue the reset email?"
```

The JSON result should use schema `madar.retrieve`, version `1`, and contain:

- `matched_nodes` with exact source ranges and excerpts
- directed `relationships`
- explicit `boundaries`
- bounded `metrics`

The sample flow should lead through the account route, password-reset service, persistence, queued job, and email gateway. Exact selection can vary when the sample changes; every returned excerpt must still be authenticated against the generated graph.

## 4. Connect an agent

For Claude Code:

```bash
madar claude install
madar doctor out/graph.json
madar status out/graph.json
```

Restart Claude Code, verify the `madar` MCP server, then ask:

```text
How does password reset request enqueue the reset email? Cite exact files and symbols, and state any missing evidence.
```

The installed guidance asks Claude to call `retrieve` exactly once with that question unchanged before broad search.

Use the matching command for another agent:

```bash
madar codex install
madar cursor install
madar copilot install
madar gemini install
madar aider install
madar opencode install
```

`doctor` and `status` also report Codex, Aider, and OpenCode when their instruction, hook, plugin, or MCP signals are present. They verify on-disk wiring, not whether a running host has trusted and activated it.

## 5. Try your repository

```bash
cd /path/to/your/repository
madar generate .
madar claude install
```

Ask one real codebase question with clear evidence requirements. Good examples:

```text
Trace a request from the route to persistence and background work. Cite exact files and symbols.
```

```text
Which code paths can update subscription status? Preserve causal order and state any unsupported or disconnected phase.
```

Use `madar query "<question>" --budget 2000` when you want to inspect the exact retrieval response without MCP.

## Expected result behavior

- `outcome: "evidence"` means Madar returned at least one authenticated excerpt.
- `outcome: "missing"` means the graph has no support for the question.
- `outcome: "unsupported"` means a required source is outside the JavaScript/TypeScript index.
- `outcome: "stale"` means source bytes or ranges no longer match the graph.
- `outcome: "unavailable"` means required local source cannot be read safely.
- `outcome: "corrupt"` means required graph facts are malformed.
- `boundaries` may also report disconnected or truncated evidence.

Do not treat a partial path as complete. Use the returned evidence first, report its boundary, and make only the focused source read needed to verify what is missing.

## Refresh after changes

For a one-off refresh:

```bash
madar generate . --update
```

For active local development:

```bash
madar watch .
```

MCP installs use `madar serve --stdio --auto-refresh` where supported. Re-run the install after upgrading Madar, then reconnect the MCP server.

## Troubleshooting

- **`out/graph.json` is missing:** run `madar generate .`.
- **The result is stale:** regenerate after source changes and retry the same question.
- **The MCP server is absent:** rerun the agent install, restart the host, and inspect its MCP list.
- **Codex shows partial wiring:** inspect `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and the workspace block in `~/.codex/config.toml`; use `/hooks` and `/mcp` in the running session.
- **The result is unsupported:** confirm the load-bearing code is JavaScript or TypeScript.
- **The result is truncated:** ask a narrower question or request a smaller phase; increasing `budget` above 4,000 does not increase the effective cap.

## Optional next steps

- Read the [CLI and MCP reference](../reference/cli-and-mcp.md).
- Follow an [agent-specific quickstart](./agent-quickstarts.md).
- Review the [design-partner test format](../design-partners.md) before sharing results from a private repository.
