# Madar MCP examples

Madar exposes exactly one MCP tool, `retrieve`, and only the tools capability. It exposes no MCP resources or prompts.

## Basic question

Request:

```json
{
  "name": "retrieve",
  "arguments": {
    "question": "Where is capturePayment defined?"
  }
}
```

The server returns a text content item containing canonical JSON. The envelope below is pretty-printed for readability; JSON key order is not semantically significant:

```json
{
  "schema": "madar.retrieve",
  "version": 2,
  "state": "ready",
  "dossier": {
    "query": { "intent": "locate", "subject": "capture payment", "terms": ["capture", "payment"] },
    "obligations": [
      { "id": "o1", "kind": "subject", "statement": "capture payment.", "proofs": ["s1"] }
    ],
    "flow": { "roots": [], "terminals": [], "links": [], "order": [] },
    "evidence": {
      "digest_algorithm": "sha256-base64url",
      "files": [{ "id": "f1", "path": "src/payments/capture-payment.ts", "digest": "..." }],
      "excerpts": [{ "id": "x1", "file": "f1", "range": [18, 1, 46, 2], "text": "export async function capturePayment(...) { ... }" }],
      "controls": [],
      "entities": [{ "id": "s1", "kind": "symbol", "label": "capturePayment()", "file": "f1", "excerpt": "x1" }],
      "proofs": []
    }
  },
  "metrics": {
    "budget_tokens": 4000,
    "serialized_tokens": 350,
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

Use the exact returned dossier as evidence. Do not treat the illustrative IDs, digest, or source text above as real repository facts.

## Bounded request

```json
{
  "name": "retrieve",
  "arguments": {
    "question": "Trace a failed invoice from the route through retry scheduling.",
    "budget": 2000
  }
}
```

The requested budget is optional and must be a positive integer. The effective serialized result is always capped at 4,000 tokens.

## Non-ready result

If the load-bearing worker is outside the JavaScript/TypeScript index, Madar does not return partial answer evidence. The following shows the relevant response fields; it is abridged, and the canonical response also contains the complete bounded `metrics` object:

```json
{
  "schema": "madar.retrieve",
  "version": 2,
  "state": "unsupported",
  "reason": "unsupported_source",
  "terms": ["settlement", "worker"]
}
```

State the exact reason and verify only the missing load-bearing phase.

## Stale graph

This is likewise an abridged view of the relevant response fields; the canonical response also contains the complete bounded `metrics` object:

```json
{
  "schema": "madar.retrieve",
  "version": 2,
  "state": "stale",
  "failures": [
    { "state": "stale", "subject": "src/payments/capture-payment.ts" }
  ]
}
```

Run `madar generate . --update`, then retry the same question.

## CLI equivalent

```bash
madar query "Where is capturePayment defined?"
madar query "Trace invoice retry scheduling." --budget 2000
```

The CLI and MCP calls use the same retrieval implementation and response schema.
