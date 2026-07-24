# CLI and MCP reference

Madar has one retrieval path. MCP clients call `retrieve`; terminal users call `madar query`. Both return the same `madar.retrieve` version 1 envelope.

## First run

```bash
madar generate .
madar claude install
madar doctor
madar status
```

Ask the connected agent a repository question normally. The installed guidance tells it to call `retrieve` once with the question unchanged before broad file search.

Without MCP:

```bash
madar query "how does authentication work?"
madar query "what calls enqueueInvoice?" --budget 2000
```

## MCP tool

The server exposes exactly one tool:

| Tool | Input | Result |
| --- | --- | --- |
| `retrieve` | `{ "question": string, "budget"?: positive integer }` | Authenticated nodes, directed relationships, explicit boundaries, and metrics |

Extra input properties are rejected. A requested budget is clamped to an effective range of 256 to 4,000 serialized tokens. The result is also capped at 12 files, 25 snippets, and one directional closure pass.

Example:

```json
{
  "name": "retrieve",
  "arguments": {
    "question": "Trace login from the route to session persistence.",
    "budget": 2000
  }
}
```

MCP also exposes authenticated `graph.json` as a read-only resource. The artifact is not an alternate query tool.

## Result outcomes

`outcome` is one of:

- `evidence` — at least one authenticated source excerpt was returned
- `missing` — the graph has no support for the question
- `unsupported` — required source is outside the JavaScript/TypeScript index
- `stale` — source bytes or ranges no longer match the accepted graph
- `unavailable` — required local source cannot be read safely
- `corrupt` — required graph facts or provenance are malformed

`boundaries` can additionally report `disconnected` and `truncated`. A result can contain useful evidence and boundaries at the same time.

See [MCP response shape](../mcp-response-shape.md) for every field.

## Agent installs

There are no install profiles. Every MCP-capable install exposes the same single `retrieve` tool.

| Agent | Command | Generated or managed surface |
| --- | --- | --- |
| Claude Code | `madar claude <install\|uninstall>` | `CLAUDE.md`, `.claude/settings.json`, `.claude/madar-user-prompt-submit.cjs`, `.mcp.json` |
| Cursor | `madar cursor <install\|uninstall>` | `.cursor/rules/madar.mdc`, `.cursor/mcp.json` |
| GitHub Copilot CLI | `madar copilot <install\|uninstall>` | home skill plus `.vscode/mcp.json` |
| Gemini CLI | `madar gemini <install\|uninstall>` | home skill, `GEMINI.md`, `.gemini/settings.json` hook and MCP entry |
| Codex CLI | `madar codex <install\|uninstall>` | `AGENTS.md`, `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, workspace block in `~/.codex/config.toml` |
| OpenCode | `madar opencode <install\|uninstall>` | `AGENTS.md`, `.opencode/plugins/madar.js`, `opencode.json` or `opencode.jsonc` MCP entry |
| Aider | `madar aider <install\|uninstall>` | `AGENTS.md` instructions; use `madar query` because this install adds no MCP server |
| Claw, Droid, Trae, Trae CN | `madar <agent> <install\|uninstall>` | `AGENTS.md` instructions; use `madar query` where MCP is unavailable |

`madar doctor` and `madar status` validate the graph plus on-disk Madar-owned instruction, hook, plugin, and MCP files. They do not prove that a running agent has trusted a hook or activated an MCP server.

For Codex, restart or open a new session, inspect and trust the project hook with `/hooks`, then verify the server with `/mcp` or `codex mcp list`. The installer owns only its marked workspace block in `~/.codex/config.toml`; unrelated configuration is preserved.

All installed prompt hooks are guidance, not enforcement. They cannot prevent the host agent from using its own filesystem or shell tools.

See [agent quickstarts](../tutorials/agent-quickstarts.md) and the [compatibility matrix](../integrations/compatibility.md).

## Graph lifecycle

```bash
madar generate [path]
madar generate [path] --update
madar generate [path] --watch
madar watch [path]
```

Generation uses one canonical compiler-backed JavaScript/TypeScript index. `--update` skips publication when the accepted graph is unchanged. `watch` and MCP auto-refresh perform the same canonical reconcile after relevant changes.

Useful diagnostics:

```bash
madar doctor [graph.json]
madar status [graph.json]
```

## MCP server

```bash
madar serve [graph.json] --stdio
madar serve --stdio --auto-refresh
```

With `--auto-refresh`, the server resolves the graph from its working directory, builds it when needed, and reconciles changes while running. During a temporary rebuild, retrieval returns an explicit unavailable boundary rather than serving unauthenticated source.

## Other maintained commands

These commands support graph maintenance and evaluation. They do not create alternate retrieval products:

```bash
madar compare [question] --exec TEMPLATE [--yes]
madar benchmark [graph.json] --exec TEMPLATE --yes
madar eval [graph.json] --exec TEMPLATE --yes
madar bench:suite ...
madar telemetry <enable|disable|status|clear|report>
madar hook <install|uninstall|status>
madar install [platform]
```

`compare`, `benchmark`, and `eval` can execute an external model runner and may spend paid model tokens. They use the same retrieval result rather than a separate query engine.

## Official MCP Registry

The checked-in Registry manifest is [`docs/mcp-registry/server.json`](../mcp-registry/server.json). Validate it locally with:

```bash
npm run registry:validate
```

The public entry launches:

```bash
npx @lubab/madar serve --stdio --auto-refresh
```

The official MCP Registry hosts metadata, not Madar code or your local graph artifact. Private registry usage stays out of scope for the public Madar listing.

If you still discover older `graphify-ts` links or listings, Madar is the current project name. The canonical package is `@lubab/madar`, and the canonical repository is `https://github.com/mohanagy/madar`.

## Trust boundary

Enable project hooks and local MCP servers only in repositories you trust. Madar authenticates returned excerpts against the accepted graph, constrains local graph paths, and excludes known sensitive path classes during source discovery. Your agent host and model provider remain separate trust boundaries.

See the [MCP security threat model](../security/mcp-threat-model.md).
