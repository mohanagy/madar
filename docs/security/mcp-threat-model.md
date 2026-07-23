# MCP security threat model

Madar is local-first, but a local MCP server still belongs to the agent's trust boundary.

## Boundary

The trusted path includes:

1. the local repository
2. the accepted `out/graph.json`
3. the Madar process serving one `retrieve` tool
4. the local agent host, hooks, plugins, and instruction files
5. any result or diagnostic artifact shared outside the machine

Only enable Madar in repositories and agent runtimes you trust.

## Primary threats

- repository prompt injection that tries to override agent behavior
- path traversal or symlink escape outside the graph workspace
- stale source presented as current evidence
- malformed graph provenance or source ranges
- overly broad tool surfaces
- accidental secrets in source, stderr, URLs, or shared artifacts
- dependency or release provenance drift

## Current mitigations

- The MCP server exposes exactly one tool: `retrieve(question, budget?)`.
- Input rejects additional properties and limits the effective output budget.
- Exact excerpts are returned only after local source bytes match the SHA-256 hash recorded by the canonical file node.
- Source paths must resolve beneath the accepted graph root.
- Missing, unsupported, stale, unavailable, corrupt, disconnected, and truncated evidence is reported explicitly.
- Retrieval is capped at 12 files, 25 snippets, one directional closure pass, and 4,000 serialized tokens.
- Known sensitive path classes such as private keys, `.env*`, and credential stores are excluded before indexing.
- MCP resources expose only the authenticated canonical graph and its matching derived report.
- Agent installers write one-retrieve guidance and remove obsolete broader Madar configurations when they own them.

Madar cannot prevent an agent host from exposing its own filesystem, shell, network, or model-provider tools. Installed hooks provide guidance, not enforcement.

## Least privilege

- Install Madar only in trusted repositories.
- Inspect generated instruction, hook, plugin, and MCP files.
- Use `madar doctor` and `madar status` to verify on-disk wiring.
- Verify live hook trust and MCP activation inside the agent host.
- Treat returned source as potentially sensitive even though it is authenticated.
- Review every artifact before sharing it outside the trusted workspace.

## Supply chain

Release work should preserve dependency inventory and provenance signals:

```bash
npm sbom --sbom-format cyclonedx > sbom.cdx.json
npm publish --access public --provenance
```

See [`docs/release.md`](../release.md) for the release checklist.
