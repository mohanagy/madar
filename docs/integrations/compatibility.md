# Agent compatibility

All MCP-capable integrations receive the same surface: exactly one `retrieve(question, budget?)` tool, the tools capability, and no MCP resources or prompts.

## Supported installers

| Client | Command | Managed surface | Verification |
| --- | --- | --- | --- |
| Claude Code | `madar install claude` | Supported per-project local MCP registration outside the repository | `madar doctor`, then inspect the client's MCP list |
| Codex CLI | `madar install codex` | Workspace-hashed block in `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `madar status`, then `/mcp` or `codex mcp list` |

Fresh install, idempotent reinstall, and uninstall change zero repository bytes. No installer creates a tracked prompt, instruction, hook, skill, plugin, routing profile, classifier, or project-local MCP configuration.

Uninstall with:

```bash
madar install claude --uninstall
madar install codex --uninstall
```

The Codex block contains exact `command = "madar"`, `args = ["mcp"]`, workspace `cwd`, `startup_timeout_sec = 180`, and `tool_timeout_sec = 60`. Its server name is derived from the workspace path, so repositories and linked worktrees coexist and uninstall independently.

## Registry or manual clients

Cursor, GitHub Copilot, Gemini, OpenCode, Aider, and other clients are not direct installer targets. Where the host supports the public MCP Registry, use the `@lubab/madar` entry. Otherwise register:

```text
command: madar
arguments: ["mcp"]
working directory: exact repository or linked worktree
transport: stdio
```

`doctor` and `status` inspect only Claude Code and Codex registrations. They report on-disk state; they do not prove that a running client initialized, listed, or called the tool.

## Worktrees and legacy migration

Run the installer from the exact linked worktree where the client will operate. Madar resolves that worktree's graph through the MCP process working directory and keeps it isolated from sibling worktrees.

Legacy cleanup is deliberately narrow. It may remove only enumerated, byte-recognized Madar-owned content while preserving unrelated user content, comments, formatting, permissions, TOML constructs, and other MCP servers.
