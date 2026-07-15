# MCP security threat model

This document records the current Madar threat model for local MCP/server execution, installed hooks/plugins/profiles, and share-safe artifacts. It is intentionally practical: the goal is to state what we trust, what we do not trust, and which mitigations/tests currently exist in the repository.

## Trust boundary

Madar is local-first, but local-first is not automatically safe.

The relevant trust boundary is:

1. the local repository and generated `out/` artifacts
2. the local agent runtime that calls Madar over MCP/stdin or consumes installed AGENTS/hook/plugin guidance
3. any share-safe artifact that leaves the machine

An MCP install, plugin, hook, or AGENTS profile can still influence what the agent reads, which tools it calls, and what local paths or prompts it sees. Only enable Madar for repositories and local agent runtimes you trust.

## Primary threats

Primary threats include prompt injection, path traversal, tool poisoning, share-safe artifact leakage, and accidental secret exposure.

- **Prompt injection** from repository content, copied docs, benchmark prompts, or external text that tries to override Madar guidance or widen agent behavior.
- **Path traversal / local-file boundary escape** when user-supplied graph or output paths attempt to read or write outside the allowed `out/` subtree.
- **Tool poisoning / dangerous defaults** when installed MCP/hook/profile guidance encourages unnecessarily broad exploration or broader-than-needed tool surfaces.
- **Share-safe artifact leakage** when compare/review receipts preserve secrets, workstation paths, or tokenized URLs that should be redacted before sharing.
- **Accidental secret exposure** when local corpus content, stderr, prompt payloads, or URLs include bearer tokens, API keys, passwords, signed URLs, or other credentials.
- **Supply-chain drift** when maintainers publish new versions without preserving an SBOM/provenance trail for the shipped package.

## Current mitigations

- `src/shared/security.ts` enforces local-file boundaries for graph input/output paths and blocks unsafe URL fetch targets such as `file://`, localhost, and cloud metadata hosts.
- `src/shared/share-safe-artifacts.ts` rewrites workstation paths to `<project-root>` / `<artifact-root>` and redacts credential-like environment values, bearer/basic auth headers, URL userinfo, and secret-bearing query parameters before share-safe receipts are written.
- Source discovery uses an artifact-aware secret policy: private keys, environment files, credential stores, and non-source secret configs are excluded before extraction, while normal security-related source code remains indexable. Local `graph.json` records each safety exclusion and its reason; generate/doctor/status show the escaped local paths. Share-safe evidence exposes only counts and reason buckets. Relevant exclusions or unreadable paths lower answer confidence so missing evidence is not presented as complete.
- Install guidance pushes least-privilege behavior instead of broad exploration. For supported MCP installers, prefer `--profile strict` for the nine-tool surface: core plus `context_pack` and `context_expand`. Codex and OpenCode install the same strict MCP surface; Aider remains CLI context-pack-first because its installer does not add an MCP server.
- Public docs keep `out/GRAPH_REPORT.md` as a fallback-only read when pack/graph tools are unavailable, stale, or insufficient.

## Least privilege guidance

This section captures the least privilege guidance for day-to-day installs and sharing decisions.

- Prefer `--profile strict` over broader MCP surfaces unless the task genuinely needs the additional tools.
- Only install Madar into repos you trust enough to let a local agent inspect via MCP, hook, plugin, or AGENTS profile.
- Re-run `madar doctor` / `madar status` after install so the local wiring is explicit before broader prompts.
- Treat share-safe artifacts as best-effort redacted receipts. Review them before sharing outside the trusted workspace.

## Supply-chain expectations

Release work should preserve both dependency inventory and provenance signals:

- generate an SBOM during release with `npm sbom --sbom-format cyclonedx > sbom.cdx.json`
- publish with `npm publish --access public --provenance` when the release environment supports npm provenance attestations

These steps are part of the release checklist in [`docs/release.md`](../release.md).
