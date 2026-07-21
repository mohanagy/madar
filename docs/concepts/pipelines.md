# Retrieval and extraction pipelines

Madar's default retrieval and extraction paths are organized around typed stages. The stages make operational behavior observable and independently testable without changing the CLI or MCP response schemas.

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

## Generation and extraction

Generation partitions the scanner-owned source set before indexing:

- In normal `auto` mode, `.ts`, `.tsx`, `.js`, and `.jsx` files enter one canonical TypeScript compiler program and write graph facts directly. They do not pass through a projector, extraction cache, framework-augmentation pass, or legacy JS/TS extractor.
- Other supported source languages use the temporary legacy companion extractor. Eligible non-code files use their separate companion extractors.
- `--legacy` routes all extractable inputs through the legacy pipeline. The compatibility `--spi` spelling selects strict canonical JS/TS indexing without the unsupported-language fallback; eligible non-code inputs remain independent.

The canonical JS/TS path has one owner for each phase:

| Stage | Input | Output | Invariant |
| --- | --- | --- | --- |
| Source selection | Explicit scanner-owned JS/TS paths | Stable canonical file set | The adapter never walks the repository or reads a second source set. |
| Program construction | Canonical file set and project references | One TypeScript compiler program | Each supported JS/TS source is indexed exactly once. |
| Semantic indexing | Program, source files, and type checker | Files, symbols, relationships, and diagnostics | Imports, calls, type relationships, and framework facts share the same symbol identities. |
| Direct graph write | Canonical index facts | Directed graph | Framework roles, metadata, relationship evidence, and provenance are written without projection or legacy augmentation. |

The companion/legacy pipeline remains separate:

| Stage | Input | Output | Invariant |
| --- | --- | --- | --- |
| Discovery outcome | Companion files, allowed targets, optional canonical context nodes | Normalized discovery plan | Input iterables are materialized once and paths are not emitted through telemetry. |
| Capability selection | One file and the capability registry | File classification and extractor capability | Selection happens before handler execution and can be tested independently. |
| Per-language extraction | File, allowed targets, selected handler | File fragment | A pipeline-result call produces one explicit outcome even for a recovered file failure. |
| Fragment merge | Per-file fragments | One extraction graph | Node/edge combination preserves the legacy companion merge contract. |
| Cross-file relationships | Merged graph, files, optional context nodes | Resolved companion graph | Language-specific links and source references run after merge. |
| Diagnostics projection | Per-file outcomes | File-owned diagnostics | A diagnostic remains attached to its file outcome and capability. |

`extract()` and `extractWithPipelineResult()` describe this companion/legacy pipeline; they are not a second supported-JS/TS pass in auto mode. `extractWithPipelineResult()` returns:

- `data`: the same extraction graph returned by `extract()`;
- `fileOutcomes`: one first-class outcome per processed file;
- `diagnostics`: parser/extractor diagnostics projected with their owning file outcome.

The pipeline-result API recovers individual extractor failures into failed file outcomes so callers can inspect completeness. `extract()` throws an extractor failure unless the existing `onFileOutcome` callback opts into per-file recovery.

## Source-safe observability

`RetrieveOptions.onStageDiagnostic` and the companion extractor's `ExtractOptions.onStageDiagnostic` receive best-effort local stage events. Observer failures cannot change pipeline behavior. Each event contains only:

- pipeline and bounded stage name;
- completed, skipped, or failed status;
- duration in milliseconds;
- input, output, and warning counts;
- diagnostic schema version.

Events never contain prompt text, paths, labels, snippets, repository names, source content, or error messages.

## Compatibility and correctness gates

CLI and MCP response schemas remain compatible: `auto`, `legacy`, and the temporary `spi` selector remain readable in generation-policy and indexing receipts. Newly indexed supported JS/TS evidence records `extraction_strategy: "canonical"`; historical SPI-named fields remain compatibility data, not a current projector/cache architecture.

Gold fixtures lock canonical language facts, framework roles and relationships, per-file ownership, deterministic ordering, and negative-file precision. Focused companion-pipeline tests retain the non-JS/TS and non-code behavior until those paths reach their separately governed replacement or deletion phase.
