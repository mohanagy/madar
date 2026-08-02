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

`madar generate . --update`, `madar generate . --watch`, and `madar mcp` use the same canonical reconcile. There is no standalone updater, incremental index, or fallback generation engine.

## Retrieval

```text
question
  -> locate, explain, or workflow obligation plan
  -> bounded graph-coherent corridor selection
  -> at most two structural/evidence recovery passes
  -> source hash and range authentication
  -> atomic required-claim and proof packing
  -> ready dossier or exact non-ready state
```

The retrieval pipeline has one deterministic planner, workflow builder, and evidence hydrator. It has no profile, LLM reranker, fallback search, second retrieval engine, session state, or task-specific product wrapper.

Its hard output limits are 12 files, 25 authenticated excerpts, three roots, 32 initial candidates, 512 explored nodes, 24 causal hops, two recovery passes, and 4,000 serialized tokens.

CLI `query`, direct application use, and MCP `retrieve` serialize byte-identical results for the same accepted graph and normalized request. MCP advertises only the tools capability, exactly one tool, and no resources or prompts.

## Correctness boundary

An excerpt is evidence only when:

- its node has complete source location and provenance facts
- its source path resolves beneath the accepted graph root
- current file bytes match the canonical SHA-256 hash
- the graph line range exists exactly in those bytes

Missing proof or a selection/budget limit becomes `incomplete`; unsupported intent/source, stale bytes, unavailable source, and corrupt facts retain their exact states. A non-ready response never exposes a partial dossier as answer-ready evidence or converts a gap into a confidence score.
