# CLI and MCP reference

Madar has one retrieval path. MCP clients call `retrieve`; terminal users call `madar query`. For the same accepted graph and normalized request, both return the same byte-identical `madar.retrieve` version 2 envelope.

## Supported commands

The public command allowlist is:

```text
madar generate [path] [options]
madar query "<question>" [--graph graph.json] [--budget tokens]
madar status [graph.json]
madar doctor [graph.json]
madar install <claude|codex> [--uninstall]
madar mcp
```

Global `--help` and `--version` are also supported. Removed commands and flags are usage errors; they are not compatibility aliases.

## Generate

```bash
madar generate .
madar generate . --update
madar generate . --watch
```

Generation uses one canonical compiler-backed JavaScript/TypeScript index. `--update` performs a cold no-op when the accepted source snapshot is unchanged. `--watch` continuously invokes the same canonical reconcile after relevant changes.

Supported generation options are:

- `--update`
- `--watch`
- `--debounce <seconds>`
- `--follow-symlinks`
- `--respect-gitignore`
- `--strict-indexing`
- `--max-indexing-failed <count>`
- `--max-indexing-unsupported <count>`

There is no Neo4j route and no alternate graph, index, query, or updater engine.

## Query

```bash
madar query "how does authentication work?"
madar query "what calls enqueueInvoice?" --budget 2000
madar query "trace login" --graph out/graph.json
```

`question` is required and limited to 512 characters. `budget` is an optional positive integer; the effective result is capped at 4,000 serialized tokens, 12 files, and 25 authenticated excerpts. Planning and graph recovery remain bounded to three roots, 32 initial candidates, 512 explored nodes, 24 causal hops, and two recovery passes.

## MCP

`madar mcp` starts the stdio server for its exact working directory. It advertises only the tools capability and exactly one tool:

| Tool | Input | Result |
| --- | --- | --- |
| `retrieve` | `{ "question": string, "budget"?: positive integer }` | Complete authenticated answer dossier, or an exact non-ready state and gaps |

Extra input properties are rejected. There are no MCP resources or prompts.

Example call:

```json
{
  "name": "retrieve",
  "arguments": {
    "question": "Trace login from the route to session persistence.",
    "budget": 2000
  }
}
```

The server completes initialization and `tools/list` before it loads reconciliation code. Listing the tool starts one background reconciler for the active repository or linked worktree. The first tool call waits at most 25 seconds for an accepted graph. If the graph is still unavailable, Madar returns the normal canonical `unavailable` result; it never asks the client to retry Madar.

## Result states

`state` is one of:

- `ready` — every mandatory obligation, adjacent workflow handoff, terminal effect, claim reference, and authenticated proof is present in one non-truncated dossier
- `incomplete` — `missing` lists the exact unproven obligation or limit
- `unsupported` — the intent, subject, or required source is unsupported
- `stale` — selected source bytes or ranges no longer match the accepted graph
- `unavailable` — required local source cannot be read safely
- `corrupt` — required graph facts or provenance are malformed

A `ready` dossier carries proven obligations; roots, terminals, directed links, and ordering groups; authenticated files, excerpts, controls, entities, and proofs; and exact resource metrics. Non-ready results never expose partial evidence as answer-ready. See [MCP response shape](../mcp-response-shape.md) for every field.

## Diagnostics

```bash
madar doctor
madar status
```

Both commands compose the same diagnostic report. They inspect the accepted graph plus the supported external Claude Code and Codex registrations. They do not claim that a running client dispatched the tool.

## Claude Code and Codex installation

There are no install profiles, hooks, skills, generated instructions, or project-local MCP files.

```bash
madar install claude
madar install codex
madar install claude --uninstall
madar install codex --uninstall
```

Fresh install, idempotent reinstall, and uninstall create or modify zero repository bytes.

Claude Code receives a supported per-project local MCP registration outside the repository. It runs `madar mcp` from the exact workspace.

Codex receives one workspace-hashed managed block in `$CODEX_HOME/config.toml` or `~/.codex/config.toml`:

```toml
command = "madar"
args = ["mcp"]
cwd = "/exact/workspace"
startup_timeout_sec = 180
tool_timeout_sec = 60
```

Multiple repositories and linked worktrees coexist and uninstall independently. The installer refuses conflicting ownership and preserves unrelated configuration, formatting, comments, permissions, TOML constructs, and other MCP servers. Legacy cleanup removes only enumerated, byte-recognized Madar-owned artifacts.

Cursor, GitHub Copilot, Gemini, OpenCode, Aider, and other clients are not direct installer targets. Use the MCP Registry where supported, or manually register `madar mcp` with the repository as its working directory.

See [agent quickstarts](../tutorials/agent-quickstarts.md) and the [compatibility matrix](../integrations/compatibility.md).

## Official MCP Registry

The checked-in Registry manifest is [`docs/mcp-registry/server.json`](../mcp-registry/server.json). Validate it locally with:

```bash
npm run registry:validate
```

Checking and testing this metadata does not publish it. Thin Delivery issue #602 does not authorize Registry publication.

The public entry launches the package with exact package arguments:

```text
["mcp"]
```

The official MCP Registry hosts metadata, not Madar code or your local graph artifact. Private registry usage stays out of scope for the public Madar listing.

If you still discover older `graphify-ts` links or listings, Madar is the current project name. The canonical package is `@lubab/madar`, and the canonical repository is `https://github.com/mohanagy/madar`.

## Trust boundary

Enable local MCP servers only for repositories you trust. Madar authenticates returned excerpts against the accepted graph, constrains graph paths, and excludes known sensitive path classes during source discovery. Your client host and model provider remain separate trust boundaries.

See the [MCP security threat model](../security/mcp-threat-model.md).
