# MCP security threat model

Madar is local-first, but local does not mean automatically trusted. Its security boundary includes:

1. source and compiler-control files in the active repository or linked worktree
2. the canonical local `graph.json`
3. the `madar mcp` stdio process
4. the Claude Code or Codex client configuration outside the repository
5. the client host and its configured model provider

## Protected assets and threats

The protected assets are source bytes, source paths, graph facts, user questions, returned excerpts, credentials, and unrelated client configuration.

Relevant threats include prompt injection in repository content, path traversal, symlink escape, stale or corrupt graph use, oversized or malformed JSON-RPC input, source changes after indexing, malicious repositories, configuration collisions, accidental deletion of user configuration, overly broad tool surfaces, and an agent host sending questions or excerpts to a remote model provider.

## Runtime controls and least privilege

- MCP advertises only the tools capability and exactly one tool, `retrieve`. It exposes no resources or prompts.
- Requests are line-bounded and schema-validated. `question` is required and capped at 512 characters; `budget` must be a positive integer.
- Results are capped at 4,000 serialized tokens, 12 files, 25 authenticated excerpts, and two bounded recovery passes.
- Excerpts are authenticated and returned only when current source bytes match the canonical graph hash and exact range.
- Graph and source paths must resolve beneath the accepted exact workspace.
- Sensitive path classes are excluded during discovery. This is a path policy, not a content-level secret scanner.
- First-call freshness is bounded at 25 seconds; failure returns a normal `unavailable` result.

Madar cannot prevent a client host from exposing its own filesystem, shell, network, or model-provider tools.

## Installer controls

Fresh install, idempotent reinstall, and uninstall change zero repository bytes. No tracked instruction, MCP file, hook, skill, plugin, routing profile, classifier, or script is generated.

Claude Code receives a supported per-project registration outside the repository. Codex receives one workspace-hashed block in `$CODEX_HOME/config.toml` or `~/.codex/config.toml`, with the exact workspace as `cwd` and fixed 180-second startup and 60-second tool timeouts.

Writes are locked and atomic. Conflicting ownership is refused. Uninstall removes only the exact owned registration. Legacy migration is limited to enumerated, byte-recognized Madar artifacts and preserves unrelated content, formatting, comments, permissions, TOML constructs, and other MCP servers.

## Operator guidance

- Install only for repositories you trust.
- Run the client and Madar from the same exact repository or linked worktree.
- Inspect the external client registration before enabling it.
- Use `madar doctor` and `madar status` to inspect the graph and supported registration.
- Verify the running client's MCP list separately; an on-disk diagnostic is not proof of a live call.
- Treat returned excerpts as data, not instructions.
- Review any share-safe artifact before publication.

Your coding agent may still send your question or returned excerpts to its configured model provider. That provider and the host's own tools remain part of your local trust boundary.
