# Agent quickstarts

Every integration follows the same contract:

1. run `madar generate .`
2. install the agent integration
3. verify the on-disk wiring
4. ask a repository question normally
5. let the agent call `retrieve` once with the question unchanged

There are no profiles. All MCP-capable integrations expose the same single tool.

## Claude Code

```bash
madar generate .
madar claude install
madar doctor
```

Generated files: `CLAUDE.md`, `.claude/settings.json`, `.claude/madar-user-prompt-submit.cjs`, and `.mcp.json`.

Restart Claude Code, inspect `/mcp`, and ask:

```text
Trace how password reset reaches the email job. Cite exact files and symbols.
```

The `UserPromptSubmit` hook provides guidance, not enforcement. Enable it only in a trusted repository.

## Codex CLI

```bash
madar generate .
madar codex install
madar status
```

Generated or managed files: `AGENTS.md`, `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and this workspace's marked block in `~/.codex/config.toml` or `$CODEX_HOME/config.toml`.

Restart Codex, use `/hooks` to review and trust the project hook, then use `/mcp` or `codex mcp list` to verify the server. `doctor` and `status` validate on-disk wiring only, not live hook trust or MCP activation.

## Cursor

```bash
madar generate .
madar cursor install
madar doctor
```

Generated files: `.cursor/rules/madar.mdc` and `.cursor/mcp.json`.

Restart Cursor and verify the local `madar` MCP server. Cursor has no separate prompt hook; its rule file supplies the one-retrieve guidance.

## GitHub Copilot CLI

```bash
madar generate .
madar copilot install
madar doctor
```

The install writes the Madar home skill and `.vscode/mcp.json`. Verify the MCP entry in your Copilot-compatible host before asking a repository question.

## Gemini CLI

```bash
madar generate .
madar gemini install
madar doctor
```

The install writes the Madar home skill, `GEMINI.md`, and `.gemini/settings.json` hook and MCP entry. Restart Gemini CLI and verify the server.

## OpenCode

```bash
madar generate .
madar opencode install
madar doctor
```

Generated or managed files: `AGENTS.md`, `.opencode/plugins/madar.js`, and a Madar MCP entry in `opencode.json` or `opencode.jsonc`.

## Aider

```bash
madar generate .
madar aider install
madar query "how does password reset enqueue the email job?"
```

The project installer writes Madar guidance into `AGENTS.md`. It does not register an MCP server, so use `madar query` to get the same evidence envelope and provide that result to Aider.

## Other instruction-only integrations

Claw, Factory Droid, Trae, and Trae CN receive `AGENTS.md` guidance:

```bash
madar claw install
madar droid install
madar trae install
madar trae-cn install
```

Where the host has no Madar MCP connection, run `madar query "<question>"`.

## Uninstall

Use the matching project-local command:

```bash
madar claude uninstall
madar codex uninstall
madar cursor uninstall
madar copilot uninstall
madar gemini uninstall
madar aider uninstall
madar opencode uninstall
```

Uninstall removes only Madar-owned content and preserves unrelated user configuration.

## Verification checklist

- `madar status` reports a fresh accepted graph.
- `madar doctor` reports the intended integration as healthy.
- the running host lists the `madar` MCP server when that integration supports MCP.
- the tool list contains exactly `retrieve`.
- one test question produces either authenticated evidence or an explicit boundary.
- the agent does not present missing, unsupported, stale, unavailable, or corrupt evidence as a complete answer.
