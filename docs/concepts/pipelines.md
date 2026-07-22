# Retrieval and indexing pipelines

Madar's retrieval and canonical indexing paths are organized around typed stages. The stages make operational behavior observable and independently testable without changing the CLI or MCP response schemas.

## Retrieval

| Stage | Input | Output | Invariant |
| --- | --- | --- | --- |
| Query/task interpretation | Question, budget, task hint, optional retrieval-level override | Tokens, gate decision, effective level, task contract | Stop words are removed once; a manual level is authoritative. |
| Seed generation | Graph nodes plus the interpreted query contract | Ranked seed pool | Only candidates with positive lexical, anchor, framework, or bounded conceptual evidence enter the pool. |
| Structural expansion | Seed pool and level policy | Related graph candidates | Direction and relation policy constrain every hop. |
| Candidate ranking | Expanded candidates and structural signals | Final inclusion order | Ranking affects candidate order only; it does not directly determine answerability. |
| Budgeted packing | Ordered candidates and task budget | Compiled context pack | The production path always uses the shipped `value-per-token` compiler policy and enforces the requested budget. |
| Evidence planning | Selected nodes, relationships, coverage, expansion handles, and runtime slice | `RetrievalEvidencePlan` | The plan contains evidence facts and exact verification targets, never rank scores or boosts. |
| Recovery/answerability | Initial result plus the explicit evidence plan | Cumulative recovered result and final answerability | Recovery is bounded, retains prior evidence, and accepts only measurable improvement. |

`assessMadarResponseEvidence()` treats a supplied `RetrievalEvidencePlan` as authoritative. Its legacy individual arguments remain supported and are normalized into the same plan at the boundary.

Benchmark expectations do not enter `RetrieveOptions` or any production retrieval stage. Historical packing-strategy comparisons and deterministic expected-evidence gates belong to benchmark fixtures or focused context-compiler tests. Production retrieval has one default packing policy.

## Generation and indexing

Generation has one scanner-to-index path. The scanner identifies `.ts`, `.tsx`, `.js`, and `.jsx` files for one canonical TypeScript compiler program. Recognized files outside that scope contribute no graph facts and are reported as unsupported in the indexing-completeness receipt.

The canonical JS/TS path has one owner for each phase:

| Stage | Input | Output | Invariant |
| --- | --- | --- | --- |
| Source selection | Explicit scanner-owned JS/TS paths | Stable canonical file set | The adapter never walks the repository or reads a second source set. |
| Program construction | Canonical file set and project references | One TypeScript compiler program | Each supported JS/TS source is indexed exactly once. |
| Semantic indexing | Program, source files, and type checker | Files, symbols, relationships, and diagnostics | Imports, calls, type relationships, and framework facts share the same symbol identities. |
| Direct graph write | Canonical index facts | Directed graph | Framework roles, metadata, relationship evidence, and provenance are written without projection or legacy augmentation. |

`madar generate . --update` performs the same full canonical build against current source. It is not a per-file incremental extraction mode. `--cluster-only` is the separate graph-reuse operation: it skips source indexing and recomputes clustering, analysis, and export from the existing graph.

## Source-safe observability

`RetrieveOptions.onStageDiagnostic` receives best-effort local retrieval-stage events. Observer failures cannot change pipeline behavior. Each event contains only:

- pipeline and bounded stage name;
- completed, skipped, or failed status;
- duration in milliseconds;
- input, output, and warning counts;
- diagnostic schema version.

Events never contain prompt text, paths, labels, snippets, repository names, source content, or error messages.

## Artifact and correctness gates

New indexing manifests use schema v2 with `summary`, `outcomes`, and mode-free `index_diagnostics`. Graph metadata keeps only aggregate `indexing_completeness`; it does not store requested modes, extraction strategies, or fallback receipts. Predecessor mixed-mode artifacts fail closed with a regeneration instruction instead of loading through a compatibility adapter.

Gold fixtures lock canonical language facts, framework roles and relationships, file ownership, deterministic ordering, and negative-file precision. Unsupported-language and non-code fixtures verify that those files produce no graph nodes or edges while their coverage limitation remains explicit.
