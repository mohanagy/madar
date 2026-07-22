# Core Reset baseline and held-out contract

This directory is the development-only evidence boundary for Core Reset issue
[#580](https://github.com/mohanagy/madar/issues/580). It is intentionally not a
new benchmark product and is not part of the Madar runtime.

## What is frozen

- `contracts/evaluation-contract.json` pins the repositories, questions,
  expected evidence paths, comparator protocols, measurements, human rubric,
  and anti-tuning rules.
- `contracts/evidence-path-performance-v1.json` pins the synthetic
  evidence-query topology, five queries, measurement order, result caps, and
  reference environment. Its accepted SHA-256 is
  `076e655e7b8ab01cc94c4c95c32b13d70f888c02948ff4eb7c1acebb4427953c`.
- `schemas/` validates the contract and baseline receipt in CI.
- `record-baseline.mjs` records the frozen `@lubab/madar@0.32.0` baseline without changing it. Its legacy CLI arguments are part of that version-pinned receipt protocol, not commands for the current candidate build.
- The accepted receipt lives under `docs/core-reset/evidence/`; generated raw
  outputs and external repository contents are never committed.

Core V2 has one explicit product boundary: TypeScript and JavaScript are
supported; Go is excluded. Every trial receives the same scope statement before
the frozen question. The exact OpenStatus prompts from issues #565 and #574
cross a Go checker boundary, so they are frozen as diagnostic scope guards:
in-scope TypeScript phases must be evidenced and Go phases must be identified
honestly as unsupported. Scope guards do not authorize Go indexing and never
contribute to cross-arm medians or pass/fail. Documenso and Formbricks are the
blocking comparator questions.

## Evidence-path activation contract

[Core Reset issue #596](https://github.com/mohanagy/madar/issues/596) uses
Documenso and Formbricks as blocking one-call TypeScript/JavaScript gates. The
OpenStatus question remains diagnostic only: incident mutation, notification
delivery, public HTML, and JSON feeds require direct TypeScript evidence, while
the Go checker and Tinybird phases must be reported as unsupported. None of
these repository identifiers, expected paths, phase labels, or scoring terms
may enter production source or query output.

The performance descriptor deterministically generates 150 components of 100
nodes: exactly 15,000 nodes and 30,000 directed edges. Each node has one
`calls` edge to `(local + 1) % 100` and one `depends_on` edge to
`(local + 37) % 100`; IDs, labels, paths, snippets, five queries, order, and RFC
8785 serialization are fixed. Four positive queries pin exact node and directed,
typed relationship sets; the fifth pins one explicit `missing` boundary with no
graph evidence. CI validates the descriptor bytes, hash, expectations, and
derived graph counts without importing it from production.

The accepted reference environment is Node `v22.9.0`, Darwin `25.3.0` arm64,
Apple M3 Max, and 51,539,607,552 bytes RAM. A later implementation-evidence
runner will perform three warm-ups and at least 20 measured queries with the
graph already loaded. One untimed invocation per query must satisfy its exact
expectation before warmup, and every warmup and measured result must keep
satisfying it; empty positive results fail. Warm p95 must be below 500 ms,
closure-pass count at most one, and every sample within the 12-file, 25-snippet,
and 4,000-token caps.
Measurements from another environment are diagnostic only.

The accepted receipt path is
`docs/core-reset/evidence/evidence-path-performance.json`. The runner and its
receipt are implementation evidence: activation does not create the receipt or
claim that the timing gate passed. This descriptor and every Core Reset receipt
remain development-only and excluded from `dist` and npm.

The canonical default SPI fixture covers exactly `.js`, `.jsx`, `.ts`, and
`.tsx`. The extensions `.mjs`, `.cjs`, `.mts`, and `.cts` are not part of this
frozen canonical SPI set; supporting them through another extraction path must
not be reported as canonical SPI coverage in this baseline.

## Verify the held-out repositories

The expected evidence paths are bound to immutable Git objects, not trusted
because they appear in this file. Before recording or running trials, supply all
three local checkouts to the offline preflight:

```text
node tools/eval/core-reset/verify-held-out-repositories.mjs --repository openstatus=/path/to/openstatus --repository documenso=/path/to/documenso --repository formbricks=/path/to/formbricks
```

The verifier performs no fetch, pull, or clone. For every repository it checks
that the pinned commit exists locally, recomputes the SHA-256 of the sorted
`git ls-tree -r -t --full-tree --name-only` path list, verifies `graph_root`,
and resolves every `verified_evidence_paths` entry as a blob with `git cat-file`.
The working checkout may be on another commit because only the pinned local Git
objects are read.

## Reproduce

From a clean checkout of the evidence commit whose `src/**` tree matches the
pinned v0.32.0 baseline:

```text
npm ci
npm run build
node tools/eval/core-reset/record-baseline.mjs --output ./baseline.local.json --retrieval-repository /path/to/openstatus
npx vitest run tests/unit/core-reset-baseline.test.ts
```

An accepted receipt must come from a clean evidence checkout. `--allow-dirty`
is only for local diagnosis while developing the measurement tooling; a
receipt produced with it is not eligible for acceptance or CI evidence.

The OpenStatus argument may be omitted only with `--allow-dirty`, which marks
the output as diagnostic and ineligible for acceptance. An accepted receipt
requires measured retrieval from a supplied local OpenStatus checkout. When
the argument is present, the recorder verifies that the local repository contains the frozen
commit, creates a clean temporary checkout at that commit, verifies the sorted
Git tree-path SHA-256, and generates the graph with the exact packed Madar
artifact used by the MCP probe. It never uses an existing graph or silently
clones from the network.

```text
--retrieval-repository /path/to/openstatus
```

The packed artifact hash, complete resolved dependency lock and its hash, graph
hash, clean source commit, graph freshness metadata, and tree-path hash are
stored in the receipt. Dependency installation is setup cost and is recorded
separately from CLI, MCP, graph-build, and retrieval timing. Measurement child
processes clear ambient Node/Madar flags, disable system/global Git config, use
LF checkouts, fix locale/timezone, and use the public npm registry; the policy
is recorded in the receipt. Machine-specific timing is expected to differ; the
receipt always records the environment and raw samples. Unknown values are kept
as `unknown` with a reproducible reason rather than replaced by zero.

CLI startup records both the unmodified subject command and the actual measured
command. The latter preloads a tiny exit hook that writes
`process.resourceUsage().maxRSS`; elapsed time and RSS therefore include the
probe's own overhead, and the receipt carries that caveat explicitly.

The baseline receipt is characterization evidence for the frozen Madar
implementation. Cross-arm clean-index time, incremental-refresh time, peak RSS,
and artifact-size distributions belong to the later comparative trial runner;
they are deliberately not invented or inferred by the baseline recorder.

## Comparative protocol

Native, Graphify, and Madar trials share the same agent, immutable provider
model, reasoning setting, product scope statement, timeout, tool-call budget,
and exact non-graph tool names, descriptions, JSON Schemas, and behavior. The
graph tool schema is intentionally arm-specific: native has none, Graphify uses
the exact schema exposed by its pinned stdio server, and Madar uses the exact
schema exposed by its packed default stdio server. Every complete schema is
saved with the transcript; graph tools are never renamed or wrapped to create
false schema parity.

Each comparison block resolves dependencies once. Graphify records a canonical
JCS JSON manifest of Python/uv versions, the pinned requirement, and every
installed distribution (including direct-URL metadata) and its SHA-256;
machine-specific executable paths are captured separately. Madar installs its
exact packed tarball from the deterministic block-relative path
`artifacts/lubab-madar-0.32.0.tgz`, records the complete package lock plus
tarball hash, canonicalizes the lock record the same way, and records its
SHA-256. All trials in the block reuse those exact environment directories,
executable paths, and the Madar tarball. The harness recomputes the applicable
manifest hash before every schedule unit. A mismatch, reinstallation, or
re-resolution invalidates the whole block instead of mixing dependency
environments.

The frozen Graphify comparator is commit
[`edec9ea`](https://github.com/Graphify-Labs/graphify/tree/edec9eabeceeae6aa2375eddb3835efa1a32c0a3)
from the official `graphifyy` package. Setup invokes `uv`, `graphify`, and
`graphify-mcp` directly as argv without a shell or `eval`. Its supported build
invocation is the resolved `graphify` executable with direct argv
`["extract", ".", "--code-only"]`. Code-only mode skips documents, PDFs, and
images and their LLM-dependent processing. The resulting
`graphify-out/graph.json` uses Graphify's default **undirected** semantics; the
protocol does not pass `--directed` or `--no-viz`, and does not claim directed
parity with Madar. Graph-build provider input, output, and total tokens are
captured explicitly and must all be zero for this code-only Graphify run. The
MCP command is `graphify-mcp <external-pair-artifact>/graph.json` over stdio
after the harness has removed `graphify-out` from the repository namespace.

For every repository, included question, and temperature, the frozen matrix has
three native trials, three Graphify cold/warm pairs, and three Madar cold/warm
pairs: 15 answers total. The nine schedule units (three native and six graph
pairs) are seeded and randomized; each graph pair expands in place as cold then
warm. A cold trial starts without pair-local graph output or cache and builds
once in a fresh standalone clone with a new empty build `HOME`, XDG, config,
cache, and temp set. Only the exact graph artifact is moved outside
`graph_root`; every generated report, manifest, visualization, output, and cache
is removed, the original repository tree/status hashes are reverified, and raw
tools deny those paths. Its paired warm trial immediately reuses the
byte-identical external artifact in a fresh agent process, conversation, and
provider context. Artifact hashes before
and after warm use must match. Medians and gates are computed per arm and
condition, never by pooling cold and warm. Madar must pass both conditions;
Madar cold is compared with Graphify cold and native, while Madar warm is
compared with Graphify warm and the same native median. Break-even uses warm
graph task cost plus paired cold-build and frozen refresh costs; an unknown cost
stays unknown, and a non-positive cadence-adjusted saving never receives a
finite break-even.

Provider prompt caching is disabled when supported. Every call records
uncached, cache-creation, cache-read, and output token categories plus the
applicable price rates. If caching cannot be disabled, token/cost results are
qualified and latency attribution is invalid; missing cache accounting
invalidates the cell instead of silently becoming zero.

Refresh measurement in the frozen v0.32.0 contract uses three independent samples per graph arm and blocking
repository. The contract pins exact Documenso and Formbricks unified diffs,
base/patch/result hashes, Graphify `update .`, Madar
`generate . --update --no-html`, pre-state, acceptance, and failure behavior. Current candidate CI invokes `madar generate` without that retired exporter flag; changing the frozen command would invalidate the accepted receipt's contract hash.
Mutation application is outside the timer. Elapsed time uses a monotonic clock;
build/refresh RSS is the maximum sampled aggregate of the root and full child
process tree, not root-only `maxRSS`.

Every answer trial runs from a standalone disposable clone with fresh empty
`HOME` and XDG/config directories; linked Git worktrees are forbidden because
they can redirect Madar artifacts through the Git common directory.
Global rules, hooks, skills, MCP settings, prior transcripts, the Madar source
checkout, and the evaluation contract are not exposed. Repository tools enforce
realpath containment beneath the pinned `graph_root`, including symlink and
shell operands; only the graph MCP server may read its one captured artifact
path. Graphify runs with `GRAPHIFY_QUERY_LOG_DISABLE=1`, all query-log opt-in
variables unset, and no query log created. Comparator update checks and package
operations are prohibited after setup and blocked by network policy.

After setup, repository, registry, update-check, telemetry, and arbitrary
network egress are disabled. Only the recorded model-provider endpoint remains
reachable for measured agent inference. Trial order is reproducible from the
contract's byte-exact NUL-delimited seed frame, JSON temperature token, SHA-256
counter generator, rejection sampling, and Fisher-Yates steps; the framed seed
hex and final order are captured before execution.

## Isolation

`tsconfig.build.json` compiles only `src`, and the npm allowlist contains only
`dist`, examples, and top-level release documents. CI additionally asserts that
`tools/eval`, Core Reset evidence, and their compiled equivalents are absent
from the package. Production code must never import this directory.

Expected evidence is grading input only. It is loaded after an answer is saved,
never embedded in a graph, prompt, MCP response, or production ranking rule.
CI scans production source for imports and literal held-out repository markers,
and validates the accepted receipt with both JSON Schema and derived semantic
invariants.
