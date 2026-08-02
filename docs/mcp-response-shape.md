# MCP response shape

`retrieve` returns one deterministic `madar.retrieve` version 2 JSON envelope. A successful locate result has this shape:

```json
{
  "schema": "madar.retrieve",
  "version": 2,
  "state": "ready",
  "dossier": {
    "query": { "intent": "locate", "subject": "generate report", "terms": ["generate", "report"] },
    "obligations": [
      { "id": "o1", "kind": "subject", "statement": "generate report.", "proofs": ["s1"] }
    ],
    "flow": {
      "roots": [],
      "terminals": [],
      "links": [],
      "order": []
    },
    "evidence": {
      "digest_algorithm": "sha256-base64url",
      "files": [{ "id": "f1", "path": "src/report.ts", "digest": "..." }],
      "excerpts": [{ "id": "x1", "file": "f1", "range": [1, 1, 3, 2], "text": "..." }],
      "controls": [],
      "entities": [{ "id": "s1", "kind": "symbol", "label": "generateReport()", "file": "f1", "excerpt": "x1" }],
      "proofs": []
    }
  },
  "metrics": {
    "budget_tokens": 4000,
    "serialized_tokens": 700,
    "selected_files": 1,
    "authenticated_excerpts": 1,
    "required_obligations": 1,
    "proven_obligations": 1,
    "optional_bundles_omitted": 0,
    "root_candidates": 1,
    "initial_candidates": 1,
    "explored_nodes": 1,
    "causal_hops": 0,
    "recovery_frontier_nodes": 0,
    "alternate_seeds": 0,
    "recovery_passes": 0
  }
}
```

## `dossier`

- `query` records the normalized `locate`, `explain`, or `workflow` intent, subject, and terms.
- `obligations` contains only proven subject, entry, stage, handoff, behavior, ordering, and terminal claims. Every claim references present entity, proof, link, or order-group IDs.
- `flow` names roots and terminals, direct or channel links, and sequence, branch, loop, parallel, or cycle order groups without inventing one total order.
- `evidence` deduplicates authenticated files, exact excerpts, control ranges, symbols, channels, operations, and direct or channel proof chains. File digests use `sha256-base64url`.

`ready` is allowed only when every mandatory obligation, claim reference, and required proof is present and authenticated. When the plan requires workflow steps or a terminal effect, each adjacent direct call or producer-channel-consumer path and the terminal must also be proven. A ready response is never truncated.

## Non-ready results

- `incomplete` returns the normalized `query` plus `missing` requirements such as `adjacent_handoff_unproven`, `terminal_persistence_unproven`, or `required_token_budget`.
- `unsupported` returns `reason` (`unsupported_intent`, `missing_subject`, or `unsupported_source`) and normalized `terms`.
- `stale`, `unavailable`, and `corrupt` return `failures`, each with its state and subject.

All states include the same top-level `schema`, `version`, and `metrics`. Non-ready results do not expose a partial dossier as answer-ready evidence.

## Bounds

- at most 12 source files and 25 authenticated excerpts
- at most 4,000 serialized `cl100k_base` tokens
- at most three roots, 32 initial candidates, 512 explored nodes, and 24 causal hops
- at most two recovery passes, 64 total recovery-frontier nodes, and three alternate seeds

The optional requested budget must be a positive integer. Its effective value is clamped between 256 and 4,000 tokens.
