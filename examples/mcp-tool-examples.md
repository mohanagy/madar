# Madar MCP examples

Madar exposes exactly one MCP tool: `retrieve`.

## Basic question

Request:

```json
{
  "name": "retrieve",
  "arguments": {
    "question": "How does payment processing work?"
  }
}
```

The server returns a text content item containing canonical JSON:

```json
{
  "schema": "madar.retrieve",
  "version": 1,
  "outcome": "evidence",
  "matched_nodes": [
    {
      "node_id": "payments_capturepayment",
      "label": "capturePayment()",
      "node_kind": "function",
      "source_file": "src/payments/capture-payment.ts",
      "source_location": "src/payments/capture-payment.ts:18-46",
      "line_number": 18,
      "end_line_number": 46,
      "source_domain": "production",
      "provenance": [{ "extractor": "typescript" }],
      "content_hash": "8f9c...",
      "snippet": "export async function capturePayment(...) { ... }"
    }
  ],
  "relationships": [],
  "boundaries": [],
  "metrics": {
    "selected_files": 1,
    "snippets": 1,
    "closure_passes": 0,
    "serialized_tokens": 318,
    "truncated": false
  }
}
```

Use the exact returned excerpts as evidence. Do not treat the illustrative ids or hashes above as real repository facts.

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

## Partial evidence

A useful result can include a boundary:

```json
{
  "schema": "madar.retrieve",
  "version": 1,
  "outcome": "evidence",
  "matched_nodes": [
    {
      "node_id": "billing_enqueueSettlement",
      "label": "enqueueSettlement()",
      "node_kind": "function",
      "source_file": "src/billing/enqueue-settlement.ts",
      "source_location": "src/billing/enqueue-settlement.ts:12-30",
      "line_number": 12,
      "end_line_number": 30,
      "source_domain": "production",
      "provenance": [{ "extractor": "typescript" }],
      "content_hash": "26a1...",
      "snippet": "export async function enqueueSettlement(...) { ... }"
    }
  ],
  "relationships": [],
  "boundaries": [
    {
      "kind": "unsupported",
      "subject": "worker/settlement.go",
      "detail": "The load-bearing worker is outside the JavaScript/TypeScript index."
    }
  ],
  "metrics": {
    "selected_files": 1,
    "snippets": 1,
    "closure_passes": 0,
    "serialized_tokens": 421,
    "truncated": false
  }
}
```

Preserve the returned evidence, state the unsupported boundary, and verify only the missing load-bearing phase.

## Stale graph

```json
{
  "schema": "madar.retrieve",
  "version": 1,
  "outcome": "stale",
  "matched_nodes": [],
  "relationships": [],
  "boundaries": [
    {
      "kind": "stale",
      "subject": "src/payments/capture-payment.ts"
    }
  ],
  "metrics": {
    "selected_files": 0,
    "snippets": 0,
    "closure_passes": 0,
    "serialized_tokens": 96,
    "truncated": false
  }
}
```

Run `madar generate . --update`, then retry the same question.

## CLI equivalent

```bash
madar query "How does payment processing work?"
madar query "Trace invoice retry scheduling." --budget 2000
```

The CLI and MCP calls use the same retrieval implementation and response schema.
