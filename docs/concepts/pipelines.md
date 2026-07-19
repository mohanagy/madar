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

## Extraction

| Stage | Input | Output | Invariant |
| --- | --- | --- | --- |
| Discovery outcome | Discovered files, allowed targets, optional context nodes | Normalized discovery plan | Input iterables are materialized once and paths are not emitted through telemetry. |
| Capability selection | One file and the capability registry | File classification and extractor capability | Selection happens before handler execution and can be tested independently. |
| Per-language extraction | File, allowed targets, selected handler | File fragment | A pipeline-result call produces one explicit outcome even for a recovered file failure. |
| Framework augmentation | A staged language fragment | Framework-enriched fragment | Augmentation is separate for JavaScript/TypeScript and explicitly skipped for other or cached capabilities. |
| Fragment merge | Per-file fragments | One extraction graph | Node/edge combination preserves the existing merge contract. |
| Cross-file relationships | Merged graph, files, optional context nodes | Resolved corpus graph | Imports, framework semantics, Go links, JSX proxies, and source references run after merge. |
| Diagnostics projection | Per-file outcomes | File-owned diagnostics | A diagnostic remains attached to its file outcome and capability. |

`extract()` keeps its existing return type. `extractWithPipelineResult()` is an additive TypeScript API that returns:

- `data`: the same extraction graph returned by `extract()`;
- `fileOutcomes`: one first-class outcome per processed file;
- `diagnostics`: parser/extractor diagnostics projected with their owning file outcome.

The new pipeline-result API recovers individual extractor failures into failed file outcomes so callers can inspect completeness. Legacy `extract()` keeps its prior behavior: it throws an extractor failure unless the existing `onFileOutcome` callback opts into per-file recovery.

## Source-safe observability

`RetrieveOptions.onStageDiagnostic` and `ExtractOptions.onStageDiagnostic` receive best-effort local stage events. Observer failures cannot change pipeline behavior. Each event contains only:

- pipeline and bounded stage name;
- completed, skipped, or failed status;
- duration in milliseconds;
- input, output, and warning counts;
- diagnostic schema version.

Events never contain prompt text, paths, labels, snippets, repository names, source content, or error messages.

## Compatibility and correctness gates

This refactor is internal to the TypeScript runtime. Existing CLI commands, MCP tool inputs, MCP result schemas, and `extract()` output remain unchanged. The new observer callbacks and `extractWithPipelineResult()` are additive.

Characterization fixtures lock retrieval selection, relationships, extraction symbols, framework output, and per-file outcome semantics before stage movement. Focused stage tests cover each boundary; the normal CLI/runtime and extraction suites remain the final correctness gate.
