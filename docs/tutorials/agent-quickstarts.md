# Agent quickstarts

Every MCP integration uses one contract: command `madar`, arguments `["mcp"]`, stdio transport, exact repository or linked worktree as `cwd`, and exactly one `retrieve` tool. Madar exposes no MCP resources or prompts.

## Claude Code

```bash
cd /path/to/repository
madar generate .
madar install claude
madar doctor
```

The installer creates a supported per-project local MCP registration in Claude Code configuration outside the repository. It writes no repository files.

Restart Claude Code, inspect its MCP server list, and ask:

```text
Trace how password reset reaches the email job. Cite exact files and symbols.
```

For a transport check, direct the client to call `retrieve` once. This proves transport only, not that the client will select Madar naturally.

## Codex CLI

```bash
cd /path/to/repository
madar generate .
madar install codex
madar status
```

The installer writes one workspace-hashed managed block to `$CODEX_HOME/config.toml` or `~/.codex/config.toml`. It contains:

```toml
command = "madar"
args = ["mcp"]
cwd = "/exact/workspace"
startup_timeout_sec = 180
tool_timeout_sec = 60
```

Restart Codex and use `/mcp` or `codex mcp list` to verify the server. `doctor` and `status` validate configuration on disk; they do not prove that the running client called the tool.

## Other clients

Cursor, GitHub Copilot, Gemini, OpenCode, Aider, and other clients are Registry or manual targets. Where supported, use the public `@lubab/madar` MCP Registry entry. Otherwise create a stdio registration with:

```text
command: madar
arguments: ["mcp"]
working directory: exact repository or linked worktree
```

Madar does not generate client-specific instruction files, hooks, skills, plugins, classifiers, or project-local MCP configuration for these hosts.

## Uninstall

```bash
madar install claude --uninstall
madar install codex --uninstall
```

Fresh install, idempotent reinstall, and uninstall change zero repository bytes. Multiple repositories and linked worktrees coexist and uninstall independently. Madar refuses conflicting ownership and preserves unrelated user configuration.

## Verification checklist

- `madar status` reports a fresh accepted graph.
- `madar doctor` reports the intended Claude Code or Codex registration as exact.
- the running client lists the Madar MCP server.
- the capability list contains tools only.
- the tool list contains exactly `retrieve`.
- one forced test question produces authenticated evidence or an explicit boundary.
- the client does not present missing, unsupported, stale, unavailable, corrupt, disconnected, or truncated evidence as a complete answer.
