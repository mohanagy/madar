# Agent quickstarts

Use this page when you already know which agent you want to wire and you want one verified install path plus one copy/paste Smoke test.

Before any agent-specific install, start with the [getting started tutorial](https://github.com/mohanagy/madar/blob/next/docs/tutorials/getting-started.md) and its one-command trial flow so the repo has a graph and you know Madar itself is behaving locally:

```bash
madar try "how does auth work?"
madar generate . --no-html
```

That trial flow is the shared baseline for every quickstart below.

## Claude Code

- Install: `madar claude install [--profile core\|full\|strict]`
- Expected files/config: `CLAUDE.md`, `.claude/settings.json`, `.mcp.json`
- Verify: `madar doctor` / `madar status`

```bash
madar claude install
madar doctor
madar status
madar pack "how does password reset request enqueue the reset email" --task explain
```

Known limitation: The `UserPromptSubmit` hook only injects guidance for local code tasks.

Common failure modes:

- If `madar doctor` says the MCP wiring is missing, rerun the install command from the repo root.
- If the agent ignores Madar guidance, inspect `CLAUDE.md` and `.claude/settings.json` before reinstalling.

## Cursor

- Install: `madar cursor install [--profile core\|full\|strict]`
- Expected files/config: `.cursor/rules/madar.mdc`, `.cursor/mcp.json`
- Verify: `madar doctor` / `madar status`

```bash
madar cursor install
madar doctor
madar status
madar pack "how does password reset request enqueue the reset email" --task explain
```

Known limitation: Cursor has no separate prompt hook; the rule file plus MCP config are the managed surface.

Common failure modes:

- If Cursor does not show the MCP server, confirm `.cursor/mcp.json` exists and rerun the install from the project root.
- If the rule file drifted, compare `.cursor/rules/madar.mdc` against the generated version and reinstall.

## GitHub Copilot CLI

- Install: `madar copilot install [--profile core\|full\|strict]`
- Expected files/config: `~/.copilot/skills/madar/SKILL.md`, `.vscode/mcp.json`
- Verify: `madar doctor` / `madar status` for `.vscode/mcp.json`, then inspect the installed home skill for slash-command availability.

```bash
madar copilot install
madar doctor
madar status
madar pack "how does password reset request enqueue the reset email" --task explain
```

Known limitation: The repo-local verifier checks the MCP wiring; the home skill is a separate install surface.

Common failure modes:

- If the repo-local MCP verifier passes but slash commands are missing, inspect `~/.copilot/skills/madar/SKILL.md`.
- If `.vscode/mcp.json` is missing, rerun the install inside the repo instead of relying on `madar install --platform copilot`.

## Gemini CLI

- Install: `madar gemini install [--profile core\|full\|strict]`
- Expected files/config: `~/.gemini/skills/madar/SKILL.md`, `GEMINI.md`, `.gemini/settings.json` hook and MCP entry
- Verify: `madar doctor` / `madar status` for `.gemini/settings.json`, then inspect the installed home skill for slash-command availability.

```bash
madar gemini install
madar doctor
madar status
madar pack "how does password reset request enqueue the reset email" --task explain
```

Known limitation: Use `madar prompt --provider gemini` when you need a one-shot export instead of live MCP.

Common failure modes:

- If `GEMINI.md` exists but slash-command support is missing, inspect `~/.gemini/skills/madar/SKILL.md`.
- If `.gemini/settings.json` drifted, rerun the install command from the repo root.

## Codex CLI

- Install: `madar codex install`
- Expected files/config: `AGENTS.md`, `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, `.codex/config.toml`
- Verify: `madar doctor` / `madar status` for on-disk wiring, then `/hooks` and `/mcp` or `codex mcp list` after a restart/new session

```bash
madar codex install
madar doctor
madar status
madar pack "how does password reset request enqueue the reset email" --task explain
```

This installs the Madar-owned AGENTS.md section, a task-applicable `UserPromptSubmit` hook, and a marker-owned `[mcp_servers.madar]` block in `.codex/config.toml`. The hook gives model-visible context-pack-first guidance only for local code tasks; it is guidance, not enforcement. Enable it only in a trusted repository. Restart or open a new Codex session, use `/hooks` to review and trust the project hook, then use `/mcp` or `codex mcp list` to verify the local MCP server. Known limitation: `madar doctor` / `madar status` validate on-disk wiring, not Codex live hook trust or MCP activation.

Common failure modes:

- If `madar status` marks Codex as partial, inspect `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and `.codex/config.toml`, then rerun the install.
- If Codex ignores the guidance, confirm `AGENTS.md` still contains the Madar-owned rules and that the project hook is trusted in `/hooks`.
- `madar codex uninstall` removes only the Madar-owned AGENTS section, hook, script, and marked TOML block; unrelated hooks and TOML configuration remain.

## Aider

- Install: `madar aider install`
- Expected files/config: `AGENTS.md`
- Verify: `madar doctor` / `madar status`

```bash
madar aider install
madar doctor
madar status
madar pack "how does password reset request enqueue the reset email" --task explain
```

This is an instruction-only quickstart. Known limitation: Aider has no PreToolUse-style hook equivalent.

Common failure modes:

- If `madar status` reports partial guidance, inspect `AGENTS.md` and rerun the install.
- If you need portable context outside the AGENTS profile, switch to `madar pack` or `madar prompt`.

## OpenCode

- Install: `madar opencode install`
- Expected files/config: `AGENTS.md`, `.opencode/plugins/madar.js`, `opencode.json` or `opencode.jsonc`
- Verify: `madar doctor` / `madar status`

```bash
madar opencode install
madar doctor
madar status
madar pack "how does password reset request enqueue the reset email" --task explain
```

Known limitation: Verification expects the Madar-owned plugin and `mcp.madar` entry to stay intact.

Common failure modes:

- If verification fails, inspect `.opencode/plugins/madar.js` plus the `mcp.madar` entry in `opencode.json` or `opencode.jsonc`.
- If the plugin exists but the MCP entry was replaced, rerun the install to restore the Madar-owned wiring.

## Not currently supported as verified quickstarts

- VS Code + GitHub Copilot extension is not a supported quickstart today. Use the GitHub Copilot CLI path above instead.
- Claw, Factory Droid, Trae, and Trae CN stay outside the verified quickstart set because they are skill-only or instruction-only paths without the same repo-local doctor/status proof.
