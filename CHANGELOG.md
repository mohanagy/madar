# Changelog

All notable changes to the TypeScript package will be documented in this file.

## [Unreleased]

## [0.10.9] - 2026-05-02

### Added

- **Public proof and distribution assets**: added the benchmark hub and hosted benchmark pages under `docs/benchmarks/`, committed a real GoValidate Platform PR-review benchmark artifact, and added repo-side marketplace listing assets for Smithery and awesome-mcp submissions.

### Fixed

- **Benchmark artifact privacy**: `review-compare` now sanitizes path-derived identifier fields before persisting prompt artifacts, preventing workstation or username fragments from leaking into committed PR-review benchmark evidence.
- **Pages workflow hardening**: pinned the GitHub Pages workflow actions to immutable SHAs and cleaned up the benchmark page monospace font stack.

## [0.10.8] - 2026-05-02

### Changed

- **README benchmark framing**: removed the top-level benchmark cost row and softened the surrounding copy so the published package page leads with speed, fewer turns, and local/privacy value instead of a cold-start model-cost caveat.

## [0.10.6] - 2026-05-02

### Changed

- **README refresh for the published package**: repositioned the npm/GitHub landing copy around the measured production benchmark, a faster quickstart, clearer local-first/privacy guarantees, and explicit trade-off disclosure for cold-start versus multi-question sessions.

## [0.10.5] - 2026-05-01

### Changed

- **Large-graph HTML export clarity**: overview exports now generate dedicated bridge neighborhood pages, and community pages label local-only connectivity as `Local degree` instead of reusing the ambiguous global `Degree` wording.

### Fixed

- **Bridge navigation mismatch**: workspace bridge cards no longer jump into a node's home community page where the cross-community context disappears; they now open a focused bridge neighborhood view that preserves the bridge node's immediate surrounding context.
- **Community scope ambiguity**: interactive and summary community pages now explain that they only show in-community nodes, while bridge-aware nodes surface `Global degree` and `Connected communities` metadata when that broader context exists.

## [0.10.4] - 2026-05-01

### Added

- **`review-compare` real-repo benchmark command**: added a CLI flow that compares verbose versus compact `pr_impact` prompts for the current git diff, saves prompt/report artifacts under `graphify-out/review-compare/`, and can optionally execute both prompts through a user-supplied runner template.

### Changed

- **Compact review payload usefulness**: `pr_impact` compact output now carries typed `review_context` with supporting paths, likely test paths, and structural hotspots so the smaller review packet still points reviewers at the most relevant follow-up context.
- **Compact review payload size on real repos**: compact `pr_impact` now trims oversized outer arrays (`changed_files`, `changed_ranges`, `seed_nodes`, `affected_communities`, `high_impact_nodes`) instead of only shrinking the inner review bundle, which cuts real review payload size dramatically on large live diffs.

### Fixed

- **Real-workspace PR diff detection**: `pr_impact` now discovers and reads diffs from nested git repositories under the graph root, so review mode works on multi-project workspaces instead of assuming the graph root itself is a git repo.
- **Review benchmark output-dir validation**: `review-compare` now accepts nested output directories whose parents do not exist yet and correctly validates absolute external output paths against the target graph's own `graphify-out/` directory.
- **CLI/runtime validation parity**: the `review-compare` parser no longer rejects valid absolute output directories before runtime can validate them against the selected graph workspace.

## [0.10.3] - 2026-05-01

### Added

- **Diff-first PR review selection**: `pr_impact` now parses unified git diff hunks into `changed_ranges`, narrows to line-aware `seed_nodes`, falls back safely to file-level seeds when symbol line metadata is missing, and returns ranked review risks with severity/reason summaries.

### Changed

- **Compact-by-default PR review MCP output**: the MCP `pr_impact` tool now accepts `budget`, `verbose`, and `compact` flags, returns a compact default payload for review workflows, and preserves the full legacy-style result behind `verbose: true` or `compact: false`.
- **Review bundle compaction and regression benchmarking**: compact PR review bundles now preserve seed-first context while trimming supporting snippets and re-filtering relationships/community context, with focused regression tests pinning materially smaller review payloads on a mixed review fixture.

### Fixed

- **PR diff/runtime edge cases**: normalized reversed source ranges, hardened macOS realpath matching between git diff paths and graph node files, and covered pure-deletion hunks so review selection stays stable across real repositories.

## [0.10.2] - 2026-05-01

### Changed

- **Question-type MCP routing in installed guidance**: the generated Claude, Gemini, Cursor, and hook instructions now route agents to the matching graph tool for the task (`retrieve`, `relevant_files`, `feature_map`, `risk_map`, `implementation_checklist`, `impact`) instead of over-centralizing `retrieve` for every codebase question.

### Fixed

- **Install-guidance regression coverage**: release tests now assert that the generated Claude and Gemini instructions include the full routed tool set, including `impact`.
- **Vitest suite stability on shared machines**: capped `maxWorkers` at `4` in `vitest.config.ts` and locked that contract with a regression test so full-suite runs stop timing out from worker oversubscription.

## [0.10.1] - 2026-05-01

### Added

- **`GRAPHIFY_TOOL_PROFILE` env var**: defaults to `core` (6 tools — `retrieve`, `impact`, `call_chain`, `community_overview`, `pr_impact`, `graph_stats`); set to `full` to opt into the legacy 21-tool surface. The Claude / Cursor / VS Code Copilot install templates now write `env: { GRAPHIFY_TOOL_PROFILE: "core" }` into the generated `.mcp.json`. Reduces `cache_creation_input_tokens` per session by roughly 16–22K on a Claude Code session start, flipping a +13% cold-start cost regression to cost parity at typical session lengths.
- **`compare --baseline-mode native_agent`**: new comparison mode that runs the user's `--exec` command twice — once with `graphify-out/`, `.mcp.json`, `CLAUDE.md`, and `.claude/` snapshot-renamed out of the working directory (baseline), once with them restored (graphify) — and reports the Anthropic-billed `usage` blocks from `claude --output-format json` verbatim. Atomic rename / try-finally restore guarantees no project state is left behind even if the runner crashes.
- **Public benchmark artifact**: committed `docs/benchmarks/2026-04-30-govalidate/` with both raw `claude --output-format json` outputs (with the answer body redacted) and a `verify.sh` reproducer. The README, `examples/why-graphify.md`, and the install hook payload all cite numbers that `verify.sh` reproduces from the committed evidence.

### Changed

- **Honest benchmark numbers**: replaced the previously-published `384×` retrieve-compression headline (and the `397×` / `897×` variants used in internal-only baseline modes) in the README, in `examples/why-graphify.md`, and in the `claude install` PreToolUse hook payload with measured numbers from the 2026-04-30 native_agent comparison: **3× fewer turns**, **~2.8× faster**, **2.6× fewer total input tokens**. Documentation now also discloses the cold-start cost premium (~+13% on a single-question session, amortizing on multi-question sessions).
- **Compare summary framing**: when `--baseline-mode` is `full` or `bounded`, the human-readable summary now appends an explicit "synthetic prompt-token estimate (cl100k_base)" disclosure line so a reader cannot mistake the synthetic ratio for an Anthropic-billed measurement. Use `--baseline-mode native_agent` for Anthropic-reported numbers.

### Fixed

- **Cold-start cost regression on Claude Code session start**: shipping the lean `core` MCP tool profile by default cuts the `cache_creation_input_tokens` overhead by ~16–22K tokens per fresh session. On the 2026-04-30 govalidate measurement this is the difference between graphify costing ~13% more than the no-graphify baseline and graphify amortizing below baseline at multi-question session lengths.

## [0.10.0] - 2026-04-30

### Added

- **Local semantic retrieval**: added opt-in embedding-backed retrieval with `semantic` / `semantic_model` support on the MCP `retrieve` tool and runtime, keeping the default path unchanged while enabling local conceptual matching for harder queries
- **Local cross-encoder reranking**: added opt-in reranking with `rerank` / `rerank_model` support so semantic candidate pools can be rescored locally before prompt assembly

### Improved

- **AST-bounded snippet quality**: TypeScript extraction now persists bounded symbol snippets and line ranges into graph artifacts, and `retrieve` prefers stored snippets before falling back to file-window reads
- **Retrieval ranking and payload efficiency**: completed the remaining roadmap work for shared token accounting, graph-signal caching, snippet file caching, default-path relationship collection, BM25-style lexical scoring, reciprocal-rank fusion, and pruned graph artifact edge payloads
- **Eval visibility**: benchmark quality reports now include grounded match rate and query-bucket summaries so retrieval improvements are tracked beyond label-only recall and MRR
- **Compare low-budget prompt assembly**: compare retrieval now trims prompt context after retrieval with compare-specific ranking so low-budget prompts keep the highest-signal explainer nodes instead of leaf-only snippets

### Fixed

- **Vitest toolchain compatibility**: pinned `vite` to the compatible 6.x line so the test/runtime toolchain avoids the Vite 8 / rolldown native-binding failure on the current Node environment
- **Semantic dependency security**: replaced the deprecated `@xenova/transformers` package with the maintained `@huggingface/transformers` successor so the local semantic retrieval path no longer ships the vulnerable `protobufjs` dependency chain by default
- **Demo benchmark ranking stability**: non file-oriented retrieve queries now keep semantic symbols ahead of same-file path artifacts, restoring the eval benchmark's MRR regression floor without reducing recall

## [0.9.2] - 2026-04-30

### Added

- **Developer workflow MCP tools**: added `relevant_files`, `feature_map`, `risk_map`, and `implementation_checklist` so agents can move from file triage to edit planning without leaving the graph surface

### Improved

- **Eval hardening**: `eval` now reports snippet coverage alongside recall and MRR, and CI enforces the stronger regression gate on the demo graph path
- **Compact MCP defaults**: `retrieve` and `impact` now default to compact payloads, with `verbose: true` preserving the legacy fuller response shape during the transition
- **Payload hygiene**: retrieval and impact responses now emit project-root-relative paths when possible and omit empty `node_kind` noise from raw and compact payloads
- **Framework support clarity**: updated README, proof docs, and the language capability matrix to document the framework-aware JS/TS surface and `framework_role` behavior explicitly

## [0.9.1] - 2026-04-30

### Added

- **Framework-aware JS/TS expansion**: added deep semantic extraction and retrieval/impact ranking support for NestJS and Next.js, extending the existing Express, Redux Toolkit, and React Router coverage to all five planned mainstream JS/TS frameworks

### Improved

- **Framework benchmark guardrails**: benchmark-quality tests now lock representative Express, Redux Toolkit, React Router, NestJS, and Next.js questions to top-hit accuracy plus measured returned-label and token ceilings on a mixed framework graph
- **Framework support docs**: updated the README, capability matrix, and product-positioning example to describe the five-framework coverage honestly, including the boundary between mainstream conventions and dynamic fallback behavior

## [0.9.0] - 2026-04-30

### Added

- **Framework-aware JS/TS extraction**: added deep semantic extraction for Express, Redux Toolkit, and React Router so the graph now emits higher-signal route, middleware, handler, slice, selector, store, loader, action, and route-component relationships

### Improved

- **Compact MCP retrieval and impact**: `retrieve` and `impact` now support an explicit `compact: true` mode for smaller framework-aware payloads while the default MCP response shape stays backward-compatible
- **JS/TS support docs**: updated the README, capability matrix, and product-positioning docs to describe the new framework-aware extraction depth and compact MCP mode

## [0.8.9] - 2026-04-28

### Improved

- **Runner-backed proof docs**: updated README, proof-workflow docs, demo docs, and quick-benchmark examples so `benchmark`/`eval` show the required `--exec` + `--yes` flow and no longer describe those commands as offline-only

## [0.8.8] - 2026-04-28

### Improved

- **Retrieval quality**: improved retrieval ranking with relation-aware expansion so connected evidence surfaces more effectively, and strengthened recall/MRR eval guardrails to prevent misleading benchmark results
- **Gemini compare docs**: documented the stdin-safe Gemini JSON runner (`cat {prompt_file} | gemini -p "" --output-format json`) and clarified that `compare` uses reported Gemini/Claude usage when structured JSON includes it, falling back to labeled local estimates otherwise

## [0.8.7] - 2026-04-27

### Changed

- **Project license**: switched the package, repository license file, README license badge/text, and contribution terms from AGPL to MIT
- **License metadata guardrail**: package metadata tests now enforce that the manifest, README, and contributing guide stay aligned on the MIT license

## [0.8.6] - 2026-04-27

### Fixed

- **Dependency security and release hygiene**: upgraded `vitest` to `4.1.5` and `@types/node` to `25.6.0` from merged Dependabot updates
- **Coupled test-tooling updates**: Dependabot now groups `vitest` and `@vitest/coverage-v8` together, and package metadata tests enforce both the group rule and version alignment to prevent another release-time dependency skew

## [0.8.5] - 2026-04-27

### Fixed

- **Release install compatibility**: aligned `@vitest/coverage-v8` with the repo's Vitest version and added a regression test so `npm ci` succeeds on the Node 20 / npm 10 CI and release runners

## [0.8.4] - 2026-04-27

### Added

- **Graph time travel CLI**: added `graphify-ts time-travel <from> <to>` to compare two git refs through local on-demand graph snapshots with `summary`, `risk`, `drift`, and `timeline` views; the default terminal output is the `summary` view
- **Graph time travel MCP tool**: added `time_travel_compare` so MCP clients can run the same ref-to-ref comparison with `from_ref`, `to_ref`, optional `view`, `refresh`, and `limit` parameters

### Improved

- **Time travel snapshot docs**: documented that time-travel snapshots are built on demand, stored under `graphify-out/time-travel/snapshots/`, reused from cache when compatible, and rebuilt only when `--refresh` is requested

## [0.8.3] - 2026-04-26

### Added

- **Public capability matrix**: added `docs/language-capability-matrix.md` to document which languages and file types use AST-backed, tree-sitter, heuristic, document, or metadata-only extraction paths
- **Proof workflow docs**: added `docs/proof-workflows.md` to separate reproducible local proof (`benchmark`/`eval`), same-model A/B proof (`compare`), and federated multi-repo proof

### Improved

- **Impact evidence**: `impact` now follows directed dependents and reports `top_paths_per_community` so blast-radius results include path evidence instead of just aggregate counts
- **Retrieve output quality**: `retrieve` now tags matched nodes with a `relevance_band` and avoids over-expanding community-only matches, which keeps graph-guided context tighter
- **Claude install pinning**: generated `.mcp.json` entries now pin `@mohammednagy/graphify-ts` to the installed package version so project MCP setups do not silently float
- **Release and proof docs**: README and `examples/why-graphify.md` now explain the public capability matrix, reproducible proof ladder, federated proof workflow, and pinned project-local MCP setup

### Fixed

- **License metadata drift**: README and contributing docs now consistently describe the package as GNU AGPL v3.0-only
- **Extractor and stdio maintainability**: refactored the major extractor and stdio hotspots into smaller modules without changing the command surface, making the release safer to maintain

## [0.8.2] - 2026-04-25

### Improved

- **Compare evidence reports**: prompt-token counts now use a local `cl100k_base` tokenizer estimate, persist explicit estimated-token fields, and classify prompt-size failures as `context_overflow` instead of generic failures

## [0.8.1] - 2026-04-25

### Fixed

- **Compare exec templates**: `graphify-ts compare` now rejects shell command substitution around `{prompt_file}` so full-repo prompts do not get expanded into argv and fail with OS argument-length limits
- **Compare docs and examples**: README and `examples/why-graphify.md` now use stdin-safe runner patterns like `cat {prompt_file} | claude -p` and explicitly warn against command-substitution forms

## [0.8.0] - 2026-04-25

### Added

- **`graphify-ts compare` command**: runs a real baseline-vs-graphify A/B prompt comparison through a user-supplied terminal LLM command and saves prompt/answer proof bundles under `graphify-out/compare/`
- **Compare proof artifacts**: each run now saves prompt files, answer files, and a structured `report.json` with prompt-token counts, statuses, timings, and output paths

### Improved

- **Compare runner safety**: added confirmation before paid prompt runs, clean `--yes` support for non-interactive usage, safer shell execution, and redacted failure reporting in persisted compare artifacts
- **Compare docs**: README and `examples/why-graphify.md` now explain when to use `benchmark`, `eval`, and `compare`, including runner placeholders and saved proof outputs

## [0.7.3] - 2026-04-24

### Improved

- **Retrieve quality — community-label scoring**: nodes in communities whose label matches query tokens get a mild boost, bridging conceptual queries ("pipeline") to implementation nodes in that community
- **Retrieve deduplication**: removed redundant community/label computation calls for faster retrieval

### Fixed

- **Gold-standard questions aligned**: eval questions now use terms that match actual node labels, restoring 95% recall with measurable 28.8x compression

## [0.7.0] - 2026-04-24

### Added

- **`graphify-ts eval` command**: measures retrieval quality with recall, MRR, and compression ratio against a gold-standard question set
- **Progress output during generate**: step-by-step feedback (detect → extract → build → cluster → analyze → export) so users know the tool isn't hanging
- **Next-steps guidance after generate**: prints platform install commands (`claude install`, `cursor install`, etc.) after graph generation completes
- **Pre-install validation**: warns if `graphify-out/graph.json` doesn't exist when running `claude install`, `cursor install`, `gemini install`, or `copilot install`

### Improved

- **Retrieve quality — multi-hop expansion**: expanded from 1-hop to 2-hop neighbor traversal with distance-decaying scores (hop1: 0.5x, hop2: 0.25x), improving recall from 90% to 95% on the built-in benchmark
- **Retrieve quality — structural signal boosting**: bridge nodes get +0.3 score boost, god nodes get -0.2 penalty, same-community nodes get +0.1 boost
- **Retrieve quality — TF-IDF token weighting**: rare query tokens now score higher than common ones, with a 0.1 floor to prevent exact matches from being erased

### Fixed

- **pr_impact missed uncommitted changes**: `gitDiffFiles` now checks unstaged and staged changes against HEAD in addition to branch-to-branch diffs
- **pr_impact skipped all nodes**: the file-node filter used `node_kind !== ''` which excluded every node since `node_kind` is undefined in extracted graphs; replaced with a filename-pattern heuristic

## [0.6.4] - 2026-04-24

### Fixed

- **Retrieve-first enforcement**: AI agents were bypassing the `retrieve` MCP tool by dispatching Explore subagents or using Bash/find instead — strengthen CLAUDE.md, AGENTS.md, GEMINI.md, and Cursor rules with blocking "MUST call retrieve FIRST" language
- **Hook matcher too narrow**: widened from `Glob|Grep` to `Glob|Grep|Bash|Agent|Read` so the PreToolUse hook fires on all codebase exploration tools
- **Cross-platform hooks**: replaced POSIX `[ -f ... ]` with `node -e` + base64 payloads — hooks now work on macOS, Linux, and Windows (PowerShell/CMD)
- **Hook idempotency**: fixed hook detection to match on `graphify-out` marker instead of hardcoded old matcher string, preventing duplicate hooks on re-install

## [0.6.2] - 2026-04-24

### Added

- **MCP server config for Cursor and Copilot**: `cursor install` writes `.cursor/mcp.json`, `copilot install` writes `.vscode/mcp.json` with correct VS Code schema (`servers` + `type: "stdio"`)
- **Examples and benchmarks**: `examples/why-graphify.md` with real production numbers (384x compression, 656-node blast radius), `examples/mcp-tool-examples.md` with real MCP tool input/output, and `examples/quick-benchmark.sh` for quick evaluation
- **README benchmarks section**: real numbers from a production NestJS + Next.js SaaS

### Fixed

- **VS Code MCP schema**: copilot install uses `servers` key with `type: "stdio"` instead of `mcpServers` which VS Code rejects

### Added

- **MCP server config for Cursor and Copilot**: `cursor install` now writes to `.cursor/mcp.json`, `copilot install` writes to `.vscode/mcp.json` — MCP tools work across all three platforms

## [0.6.1] - 2026-04-24

### Fixed

- **MCP server config location**: `claude install` now writes MCP server config to `.mcp.json` (project root) instead of `.claude/settings.json`, which is the correct location for Claude Code project-level MCP servers; existing legacy entries are cleaned up automatically
- **Hook update**: `claude install` now updates stale hook commands instead of skipping with "already registered"

## [0.6.0] - 2026-04-24

### Added

- **Blast radius analysis**: new `impact` MCP tool — analyzes what breaks if you change a node, with direct/transitive dependents, affected files, and affected communities
- **Call chain tracing**: new `call_chain` MCP tool — finds all execution paths between two nodes filtered by edge type (calls, imports_from)
- **PR impact analysis**: new `pr_impact` MCP tool — parses git diff, maps changed files to graph nodes, computes aggregate blast radius across all changes
- **Hierarchical community data**: new `community_details` MCP tool with micro/mid/macro zoom levels for token-efficient codebase exploration
- **Community overview**: new `community_overview` MCP tool for quick overview of all communities
- **Multi-repo federation**: new `graphify-ts federate` command merges graphs from multiple repos into a single queryable super-graph with cross-repo edge inference
- **Auto-generated docs**: new `--docs` flag generates per-community markdown documentation in `graphify-out/docs/` with key components, entry/exit points, bridges, and code snippets
- **Related nodes panel**: selecting a node in the HTML community explorer now shows its neighbors with edge types
- **README rewrite**: comprehensive documentation of all MCP tools, federation, and AI agent integration

## [0.5.3] - 2026-04-23

### Changed

- **Community naming disambiguation**: duplicate community names now use operation or node-based suffixes (e.g. `Pipeline Extract — Rust`, `Pipeline Extract — Python`) instead of raw community IDs (`Pipeline Extract (27)`)
- **MCP server auto-start**: `graphify-ts claude install` now registers an `mcpServers` entry in `.claude/settings.json` so the MCP server starts automatically when Claude Code opens the project — no manual `serve --stdio` needed

## [0.5.2] - 2026-04-23

### Fixed

- **Install idempotency**: `graphify-ts claude install` (and other platforms) now updates the existing rules section instead of printing "already configured" and leaving stale instructions

## [0.5.1] - 2026-04-23

### Changed

- **Louvain community detection**: replaced the bridge-edge-removal algorithm with proper Louvain modularity optimization, eliminating the mega-community problem where 79% of nodes collapsed into a single cluster; communities now have a max size of ~150 nodes with automatic hierarchical sub-clustering for oversized groups
- **Install templates updated**: `graphify-ts claude install` (and other platforms) now instructs agents to use the `retrieve` MCP tool as the primary context source, falling back to `GRAPH_REPORT.md` when the MCP server is unavailable
- **Postinstall reminder**: global installs now print a reminder to re-run platform install commands for the latest agent rules

### Fixed

- **Graph physics stabilization**: vis-network interactive graphs now freeze after layout stabilization instead of continuously bouncing; stabilization iterations increased from 100 to 300
- **Graph container sizing**: summary-mode community pages now use `80vh` height instead of fixed `600px`, filling the viewport

## [0.5.0] - 2026-04-23

### Added

- **RAG retrieval tool**: new `retrieve` MCP tool that takes a natural language question and token budget, finds relevant nodes via token-based prefix matching, expands through graph neighbors, reads code snippets from disk, and returns a structured context bundle with matched nodes, relationships, community context, and structural signals (god nodes, bridge nodes)
- **`--include-docs` flag**: document files (`.md`, `.txt`, `.rst`) are now excluded from graph generation by default to reduce noise; pass `--include-docs` to opt in

### Fixed

- **Summary-mode edge rendering**: fixed field name mismatch (`e.source`/`e.target`/`e.relation` to `e.from`/`e.to`/`e.label`) in the "Load interactive graph" button handler for oversized community pages, which caused edges to not render at all in summary mode

## [0.4.2] - 2026-04-20

### Fixed

- Moved `typescript` from `devDependencies` to `dependencies` so the TypeScript compiler API (used for JS/TS AST extraction) is available when the package is installed by end users who do not have TypeScript installed globally

## [0.4.1] - 2026-04-20

### Fixed

- Fixed `SyntaxError: Invalid or unexpected token` in community summary pages: the warning message string in the `loadInteractiveGraph` client function contained literal newlines (from the TypeScript template literal) which are invalid inside single-quoted JavaScript strings; escaped as `\n` sequences so the generated HTML is valid

## [0.4.0] - 2026-04-20

### Added

- **Detection hygiene**: corpus traversal now skips common non-semantic directories (`test`, `tests`, `__tests__`, `spec`, `specs`, `e2e`, `cypress`, `playwright`, `coverage`, `storybook-static`, `fixtures`, `__fixtures__`, `__mocks__`, `mocks`) and noise file patterns (test/spec files, stories, mocks, framework config files, setup files) so those do not pollute the knowledge graph
- **Interactive graph toggle for oversized communities**: summary-only community pages now include an opt-in "⚡ Load interactive graph" button that shows a performance warning dialog and lazy-loads vis-network from CDN on confirmation, with an error recovery handler for offline environments
- **React component classification**: uppercase JSX-returning functions in `.tsx`/`.jsx` files are now tagged `node_kind: 'component'` so they are identifiable as React components in the graph
- **JSX `renders` edges**: component functions now emit outgoing `renders` edges for every uppercase JSX tag they use (e.g. `<Button />` → edge to `Button`), enabling component-level usage graphs in React projects
- **Cross-file `renders` stitching**: `renders` proxy edges are resolved across file boundaries onto real imported component nodes so the final graph shows concrete component-to-component relationships rather than unresolved proxies

### Changed

- `EXTRACTOR_CACHE_VERSION` bumped to 61 to invalidate stale pre-React-classification extraction payloads

### Fixed

- Graph data embedded in community summary HTML pages is now serialized with `serializeForInlineScript` (escaping `<`, `>`, `&`, line-separator characters) to prevent premature `</script>` tag termination on adversarially-named file paths

## [0.3.0] - 2026-04-18

### Added

- Workspace-scale parity baseline harness: reproducible mixed-workspace benchmark corpus, parity scorecard, and benchmark question coverage using shared `scoreNodes`, `queryGraph`, and `estimateQueryTokens` runtime paths
- Cross-file relationship extraction covering import/export chains, type references, call graphs, and shared-module cohesion signals across multi-package workspaces
- Fragmentation signals in `GRAPH_REPORT.md`: weakly-connected-component count, singleton-component count, isolated-node rate, largest-component share, and low-cohesion community count for workspace-scale diagnostics
- Modular HTML export helpers for community summaries (`export/community-summary.ts`), overview bridge detection (`export/overview-bridges.ts`), and overview navigation links (`export/overview-navigation.ts`)
- Stdio server MCP tool/resource definitions extracted into a dedicated `src/runtime/stdio/definitions.ts` module to reduce hotspot growth

### Changed

- `GRAPH_REPORT.md` now emits entity-level structure signals using shared analysis helpers instead of file-node heuristics, improving workspace-scale diagnostic accuracy
- Benchmark prints entity-level structure signals when `source_file` provenance is available, with an explicit unavailable note otherwise
- Enhanced `analyze.ts` cohesion and bridge-detection logic to cover cross-workspace import patterns and multi-service shared modules
- Refactored `stdio-server.ts` to delegate definitions to the new dedicated module, reducing its size and isolating protocol-level changes
- `generate --update` now preserves workspace-parity provenance contracts across incremental rebuilds

## [0.2.2] - 2026-04-17

### Fixed

- Prevented overview-first HTML exports from opening browser-freezing interactive pages for oversized single communities by falling back to summary/search views with safe deep links

## [0.2.1] - 2026-04-17

### Added

- Schema-v2 extraction metadata with layered provenance contracts, immutable normalization helpers, and regression coverage for legacy payload upgrades and `generate --update` preservation
- Registry-driven ingestion for structured webpages plus exact GitHub repository/issue/pull-request/discussion/commit, Reddit thread/comment, Hacker News item, and YouTube video/playlist/channel routes
- Broader deterministic non-code and media extraction, including DOCX/XLSX metadata and citation handling, richer PDF bibliography/source URL lifting, sidecar-backed binary provenance, and bounded metadata for AAC, M4A, FLAC, Ogg Vorbis/Opus, MP4-family, AVI, and Matroska/WebM assets
- A first bounded Rust tree-sitter extraction slice covering trait signatures, `impl Trait for Type` conformance, aliased `use ... as ...` imports, nested import scoping, and WASM grammar-load isolation
- Deterministic bibliography `source_url` lifting for numbered Markdown/PDF/DOCX reference entries when plain external URLs are present without DOI/arXiv metadata

### Changed

- Refactored extraction and ingest plumbing into more modular registry-driven paths, including dedicated `extract/` helper modules and a larger `non-code` extraction module for the active document/media path
- Expanded README and maintainer-facing release documentation to better reflect the package's strongest current workflows, bounded capability matrix, and npm-safe repository links
- Improved large-corpus detection messaging to recommend smaller high-value slices without advertising nonexistent flags or provider-specific token costs

### Fixed

- Hardened bounded Matroska/WebM metadata discovery and stale-metadata clearing across direct scans, `SeekHead` rereads, and later top-level fallback paths
- Preserved correct ingest provenance and sidecar-aware incremental rebuild behavior for binary assets, including direct audio/video URLs and saved sidecar metadata

### Notes

- `v0.2.0` was tagged accidentally and was not published to npm or turned into a GitHub release. `0.2.1` is the first published package for the post-`0.1.5` change set and includes the release-documentation corrections made after that accidental tag.

## [0.1.5] - 2026-04-12

### Added

- MCP resource subscriptions for the stdio runtime via `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated`, and `notifications/resources/list_changed`
- Deeper deterministic non-code extraction for PDF metadata and `Tj`/`TJ` text recovery, DOCX core metadata, and XLSX workbook/sheet structure
- Citation and bibliography enrichment that derives deterministic external `source_url` values for DOI and arXiv references
- A dedicated `src/pipeline/extract/non-code.ts` module to own the active non-code extraction path
- Regression coverage for stdio subscriptions, mixed-corpus watch rebuilds, and richer PDF/DOCX/XLSX extraction behavior

### Changed

- Watch mode now rebuilds supported code, document, paper, image, and office-document changes automatically, including mixed supported batches
- README, roadmap notes, and bundled installer guidance now reflect the expanded MCP/runtime and office-document capabilities
- Refactored `extract.ts` to route active non-code extraction through the new dedicated module and bumped the extractor cache version

### Fixed

- Hardened non-code parsing with bounded markdown-link matching and structured-text line caps
- Added a defensive stdio resource-subscription cap to avoid unbounded session growth

## [0.1.4] - 2026-04-12

### Fixed

- Prevented semantic community naming from crashing when labels include Object prototype property names such as `constructor` or `toString`
- Added regression coverage for prototype-chain label handling in `buildCommunityLabels`

## [0.1.3] - 2026-04-12

### Added

- Automatic overview-first HTML export for large graphs, with lightweight `graph.html` landing pages and focused per-community pages under `graph-pages/`
- Deterministic semantic community naming based on dominant paths, file themes, and representative graph nodes
- `community_labels` metadata in `graph.json` for downstream tooling and report consumers

### Changed

- Improved generated reports and HTML output to show meaningful community names instead of generic `Community N` placeholders when heuristics can infer a better label
- Expanded regression coverage for semantic labels, overview-mode export behavior, and generator propagation of HTML mode choices

## [0.1.2] - 2026-04-11

### Changed

- Renamed the installed Claude skill and slash command to `graphify-ts` consistently across built-in templates, installer output, and README usage examples
- Simplified assistant installer behavior to use only the current `graphify-ts` naming for skill paths, section markers, hooks, and generated helper files
- Renamed generated OpenCode and Cursor integration helper files to `graphify-ts`-specific filenames for clearer project ownership

## [0.1.1] - 2026-04-11

### Added

- Open-source contribution scaffolding via `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue forms, a pull request template, `CODEOWNERS`, and a CI workflow
- Maintainer documentation for repository protections, branch/tag handling, and release process management
- A tag-driven GitHub release workflow for `v*` tags that validates tag format, package-version alignment, changelog coverage, and local-equivalent verification steps before creating a GitHub release

### Changed

- Clarified npm installation, package-scope, and end-user setup guidance in the README
- Added Claude integration documentation explaining the difference between global skill installation, project-local integration, and graph generation
- Expanded README contribution guidance and linked maintainer-facing repository settings documentation

### Notes

- This patch release focuses on packaging, documentation, contribution workflow, and release-management improvements rather than runtime graph-extraction changes

## [0.1.0] - 2026-04-11

### Added

- Initial npm-ready TypeScript release of `graphify-ts`
- Global CLI command support via `graphify-ts`
- `generate`, `watch`, `serve`, `query`, `path`, `explain`, `add`, `save-result`, `benchmark`, `install`, and `hook` commands
- JavaScript / TypeScript extraction via the TypeScript compiler API
- Portable tree-sitter extraction for Python, Go, and Java
- Lightweight structural extraction for additional languages including Ruby, Lua, Elixir, Julia, PowerShell, Objective-C, and several brace-style languages
- Deterministic extraction for Markdown, RST, DOCX, PDF-like paper corpora, and image assets
- Interactive HTML graph explorer, JSON export, GraphML/Cypher export, Obsidian/wiki output, and Neo4j push support
- Lightweight HTTP and stdio/MCP-style serving
- Publish-ready packaging with scoped npm metadata, a prepack build, and a constrained tarball allowlist
