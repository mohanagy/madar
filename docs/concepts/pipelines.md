# Indexing and retrieval pipelines

Madar has one generation pipeline and one retrieval pipeline.

## Generation

```text
source scan
  -> canonical TypeScript compiler program
  -> symbols, relationships, framework facts, and provenance
  -> authenticated directed graph
  -> optional diagnostics
```

`.js`, `.jsx`, `.ts`, and `.tsx` files enter one compiler-backed index. Other languages and non-code formats add no graph facts. `graph.json` is the authoritative atomic artifact; reports and manifests are derived diagnostics.

`madar generate . --update`, `madar watch`, and MCP auto-refresh use the same canonical reconcile.

## Retrieval

```text
question
  -> lexical graph anchors
  -> one bounded directional closure
  -> source hash and range authentication
  -> deterministic bounded slice
  -> evidence or explicit boundary
```

The retrieval pipeline has no profile, planner, recovery engine, semantic reranker, session state, or task-specific product wrapper.

Its hard output limits are 12 files, 25 snippets, one closure pass, and 4,000 serialized tokens.

## Correctness boundary

An excerpt is evidence only when:

- its node has complete source location and provenance facts
- its source path resolves beneath the accepted graph root
- current file bytes match the canonical SHA-256 hash
- the graph line range exists exactly in those bytes

Failures become missing, unsupported, stale, unavailable, corrupt, disconnected, or truncated boundaries. They are never converted into confidence scores.
