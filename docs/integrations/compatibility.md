# Agent compatibility

All MCP-capable integrations expose one tool: `retrieve(question, budget?)`. There are no tool profiles.

## Project-local installers

| Agent | Command | Managed files | Live MCP | Verification |
| --- | --- | --- | --- | --- |
| Claude Code | `madar claude install` | `CLAUDE.md`, `.claude/settings.json`, `.claude/madar-user-prompt-submit.cjs`, `.mcp.json` | Yes | `madar doctor`, then `/mcp` |
| Cursor | `madar cursor install` | `.cursor/rules/madar.mdc`, `.cursor/mcp.json` | Yes | `madar doctor`, then inspect MCP settings |
| GitHub Copilot CLI | `madar copilot install` | home skill, `.vscode/mcp.json` | Yes | `madar doctor`, then inspect MCP settings |
| Gemini CLI | `madar gemini install` | home skill, `GEMINI.md`, `.gemini/settings.json` | Yes | `madar doctor`, then inspect MCP settings |
| Codex CLI | `madar codex install` | `AGENTS.md`, `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, marked block in `~/.codex/config.toml` | Yes | `madar status`, `/hooks`, `/mcp` or `codex mcp list` |
| OpenCode | `madar opencode install` | `AGENTS.md`, `.opencode/plugins/madar.js`, `opencode.json` or `opencode.jsonc` | Yes | `madar doctor`, then inspect MCP settings |
| Aider | `madar aider install` | `AGENTS.md` | No | inspect `AGENTS.md`; use `madar query` |
| Claw | `madar claw install` | `AGENTS.md` | No | inspect `AGENTS.md`; use `madar query` |
| Factory Droid | `madar droid install` | `AGENTS.md` | No | inspect `AGENTS.md`; use `madar query` |
| Trae | `madar trae install` | `AGENTS.md` | No | inspect `AGENTS.md`; use `madar query` |
| Trae CN | `madar trae-cn install` | `AGENTS.md` | No | inspect `AGENTS.md`; use `madar query` |

Prompt hooks and instruction files provide guidance, not enforcement. `doctor` and `status` inspect on-disk state; they cannot prove that a running host trusted a hook or activated a server.

## Home-skill aliases

`madar install --platform <name>` installs a bundled home skill for supported platforms. It does not replace the project-local installer above. Use the dedicated project command when you want repository instructions, hooks, or MCP wiring.

## Worktrees

Run the installer from the linked worktree where the agent will operate. Madar resolves that worktree's graph through the MCP process working directory and keeps generated artifacts isolated from sibling worktrees.

For Codex, the installer owns only the marked workspace block in `~/.codex/config.toml` or `$CODEX_HOME/config.toml`. Reinstalling or uninstalling preserves other workspace registrations and user-managed configuration.
