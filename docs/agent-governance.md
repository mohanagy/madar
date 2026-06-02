# Agent governance receipts

Madar now emits a **source-safe governance receipt** on JSON pack surfaces:

- CLI `madar pack --format json`
- MCP `context_pack`

The receipt is meant for audit and governance review flows where teams need to verify **how** Madar prepared context for an agent without exposing the prompt, answer text, source snippets, or file paths.

## What the receipt includes

Each receipt is versioned (`version: 1`) and records:

- graph freshness (`graph_version`, freshness status, selected-context counters, and generation/build timestamps)
- request metadata (`task`, `task_intent`, `budget`, retrieval strategy, resolution when present)
- agent directive summary (`pack_confidence`, `coverage`, `agent_directive`, `missing_phases`)
- follow-up expansion summary (handle count, evidence classes, expansion task kinds, preview/focus counts)
- MCP call metadata for `context_pack` (`cache_eligible`, `cache_status`, and a hashed `delta_session_hash` when delta mode is used)

## Privacy boundary

The governance receipt is explicitly **source-safe**. It does **not** include:

- the original prompt
- generated answer text
- source snippets
- file paths or focus-file lists
- `confidence_reasons`
- `covered_workflow_owners`
- expandable preview `source_file` values

This keeps the receipt compatible with review workflows that need operational evidence without leaking repository structure or code content.

## Operational guidance

Use the receipt to answer questions like:

- Was the graph fresh when the pack was produced?
- Did the agent have enough coverage to answer from the pack?
- Was the MCP response served from cache or recomputed?
- Did the pack offer follow-up expansion handles, and roughly how much extra context was available?

For deeper source review, use the main pack payload itself. The governance receipt is a bounded audit summary, not a replacement for the full context pack.
