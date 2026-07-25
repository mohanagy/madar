# Getting started

This walkthrough builds one local JavaScript/TypeScript graph, runs one retrieval, and registers the same one-tool MCP surface.

## 1. Install and generate

Madar requires Node.js 20 or newer:

```bash
npm install -g @lubab/madar
cd /path/to/madar
madar generate examples/sample-workspace
```

Expected output identifies the workspace, indexed JavaScript/TypeScript files, graph node and edge counts, and `out/graph.json`.

`graph.json` is the authoritative local artifact. Source in other languages and non-code files contributes no graph facts.

## 2. Inspect a retrieval

```bash
cd examples/sample-workspace
madar query "how does password reset request enqueue the reset email?"
```

The result contains authenticated `matched_nodes`, directed `relationships`, explicit `boundaries`, and bounded `metrics`. It uses the same query application as MCP.

Madar returns at most 12 files, 25 snippets, and 4,000 serialized tokens. A smaller positive budget is optional:

```bash
madar query "how does password reset request enqueue the reset email?" --budget 2000
```

## 3. Connect Claude Code or Codex

Run the installer from the exact repository or linked worktree where the client will operate:

```bash
madar install claude
madar doctor
madar status
```

For Codex:

```bash
madar install codex
madar doctor
madar status
```

Claude Code receives a supported per-project local registration outside the repository. Codex receives a workspace-hashed block in `$CODEX_HOME/config.toml` or `~/.codex/config.toml` with exact `cwd`, `startup_timeout_sec = 180`, and `tool_timeout_sec = 60`.

Fresh install, idempotent reinstall, and uninstall create zero repository bytes. There are no generated prompts, instructions, hooks, skills, plugins, or project-local MCP files.

Restart the client, confirm that it lists the Madar server, and ask:

```text
How does password reset request enqueue the reset email? Cite exact files and symbols, and state any missing evidence.
```

For a transport check, ask the client to call `retrieve` exactly once. A forced call proves only that the client initialized, listed, and dispatched the tool; it does not prove natural tool preference.

Other MCP clients are Registry or manual targets. Register command `madar`, arguments `["mcp"]`, stdio transport, and the exact repository as the working directory.

## Expected result behavior

- `outcome: "evidence"` means authenticated graph evidence survived selection.
- `outcome: "missing"` means the graph has no support for the question.
- `outcome: "unsupported"` means required source is outside the JavaScript/TypeScript index.
- `outcome: "stale"` means source bytes or ranges no longer match the graph.
- `outcome: "unavailable"` means required local source cannot be read safely.
- `outcome: "corrupt"` means required graph facts are malformed.
- `boundaries` may additionally report disconnected or truncated evidence.

Do not treat a partial path as complete. Use the returned evidence first, report its boundary, and make only the focused source read needed to verify what is missing.

## Refresh after changes

For a one-off reconcile:

```bash
madar generate . --update
```

For continued local development:

```bash
madar generate . --watch
```

`madar mcp` starts stdio before loading reconciliation code and keeps the exact working-directory graph current. The first tool call waits no more than 25 seconds; if a graph is not accepted, it returns the canonical `unavailable` result.

## Troubleshooting

- **`out/graph.json` is missing:** run `madar generate .`.
- **The result is stale:** reconcile after source changes and repeat the same question.
- **The MCP server is absent:** rerun `madar install claude` or `madar install codex`, restart the client, and inspect its MCP list.
- **The installer reports a conflict:** preserve the existing user-owned registration and resolve ownership explicitly; Madar will not overwrite it.
- **The result is unsupported:** confirm the load-bearing code is JavaScript or TypeScript.
- **The result is truncated:** ask a narrower question; budgets above 4,000 do not increase the effective cap.

## Optional next steps

- Read the [CLI and MCP reference](../reference/cli-and-mcp.md).
- Follow an [agent quickstart](./agent-quickstarts.md).
- Review the [design-partner test format](../design-partners.md) before sharing results from a private repository.
