# Core Reset baseline and held-out contract

This directory is the development-only evidence boundary for Core Reset issue
[#580](https://github.com/mohanagy/madar/issues/580). It is intentionally not a
new benchmark product and is not part of the Madar runtime.

## What is frozen

- `contracts/evaluation-contract.json` is the active
  `core-reset-held-out-v2` contract. It pins the repositories, operation-specific
  questions, independently reviewed owner declarations, required disconnected
  boundaries, comparator protocols, measurements, human rubric, and anti-tuning
  rules.
- `contracts/evidence-path-performance-v2.json` pins the synthetic
  evidence-query topology, five queries, measurement order, result caps, and
  reference environment. V2 forbids ranges and full-file snippets on structural
  file nodes. Its frozen SHA-256 is
  `4ddba368f5ef17dc059bd8d41c0549e38d6a5ded42e9448ae31aefd0e35506e4`.
- `schemas/` validates the active contract and the immutable historical receipt
  shape in CI.
- `docs/core-reset/evidence/baseline-v0.32.0.json` is immutable historical
  `core-reset-held-out-v1` characterization evidence. It is bound by hash in v2
  but is not a v2 held-out result and is never silently regraded.
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
these repository identifiers, owner fixtures, paths, phase labels, or scoring terms
may enter production source or query output.

Held-out v2 grades a phase only when the result contains an authenticated
`symbol_declaration` matching a hidden accepted graph identity, source path,
kind, full-file SHA-256, canonical declaration range, and declaration hash. A
`structural_file` node has no range or snippet, counts toward file/precision
limits, may support only exact directed `imports_from` and `contains` traversal,
and can never cover a phase. A tiny unrelated symbol in the expected file also
cannot cover a phase. Where the canonical graph lacks a real runtime, user, or
asynchronous transition, the result must report the required `disconnected`
boundary rather than invent, reverse, or project an edge.

The performance descriptor deterministically generates 150 components of 100
nodes: exactly 15,000 nodes and 30,000 directed edges. Each structural file node has
two valid file-to-file `imports_from` edges: one to `(local + 1) % 100` and one
to `(local + 37) % 100`; IDs, labels, paths, five queries, order, and RFC
8785 serialization are fixed. Four positive queries pin exact node and directed,
typed relationship sets; the fifth pins one explicit `missing` boundary with no
graph evidence. CI validates the descriptor bytes, hash, expectations, and
derived graph counts without importing it from production.

The accepted reference environment is Node `v22.9.0`, Darwin `25.3.0` arm64,
Apple M3 Max, and 51,539,607,552 bytes RAM. Before loading the candidate, the
performance runner rejects inherited Node preload paths, verifies every `src`
path and byte against `HEAD`, creates a detached standalone clone of that exact
commit and tree, restores the exact lockfile dependencies there, and runs a
clean build outside the timer. It never replaces the developer checkout's
`node_modules` or build output. The runner then serializes and deserializes the
graph, inspects it through the shipping canonical query-index boundary, and
performs three warm-ups and at least 20 measured queries with that ready query
index already loaded. One untimed invocation per query must satisfy its exact
expectation before warmup, and every warmup and measured result must keep
satisfying it; empty positive results fail. Warm p95 must be below 500 ms,
closure-pass count at most one, and every sample within the 12-file and
4,000-token caps while the structural fixture returns exactly zero snippets.
Measurements from another environment are diagnostic only.

The accepted receipt path is
`docs/core-reset/evidence/evidence-path-performance.json`. The runner and its
receipt are implementation evidence: activation does not create the receipt or
claim that the timing gate passed. This is a public, fixed workload—not an
independent adversarial correctness proof. A performance-eligible receipt cannot
qualify the phase unless the separately contained held-out-v2 correctness gate
also passes, the exact-literal leak scan is clean, and independent adversarial
review passes. This descriptor and
every Core Reset receipt remain development-only and excluded from `dist` and
npm.

The canonical default SPI fixture covers exactly `.js`, `.jsx`, `.ts`, and
`.tsx`. The extensions `.mjs`, `.cjs`, `.mts`, and `.cts` are not part of this
frozen canonical SPI set; supporting them through another extraction path must
not be reported as canonical SPI coverage in this baseline.

## Run the held-out evaluator

Run the evaluator with all three pinned checkouts:

```text
node tools/eval/core-reset/evidence-path-held-out.mjs --repository openstatus=/path/to/openstatus --repository documenso=/path/to/documenso --repository formbricks=/path/to/formbricks
```

An acceptance-eligible held-out run is Darwin-reference-only because it requires
the frozen `/usr/bin/sandbox-exec` boundary. Other platforms cannot emit an
eligible receipt. The accepted receipt path is
`docs/core-reset/evidence/evidence-path-held-out.json`.

The runner clean-builds and packs exact `HEAD`, installs its exact production
lock offline, and keeps evaluation files outside that runtime. Graph generation
uses the packed CLI against a VCS-free pinned Git archive. When a tracked
compiler config extends another tracked local workspace package, the runner
copies only that exact package into a temporary `node_modules` view, attests
the copied bytes, records the sorted mapping count and SHA-256, and removes the
view immediately after generation. It never runs a package manager, resolves
an external dependency, uses the network, or applies repository-specific
rules. Canonical indexing disables automatic external ambient type discovery
and neutralizes composite/incremental build-output behavior; explicit imports
and scanner-owned declarations remain indexed. Darwin sandboxing denies
network, process forks, non-runtime executable access, and reads from the
evaluator checkout; Node's permission model denies child-process use and
enforces the explicit filesystem allowlist. Each question runs in a fresh
contained candidate process with only its packed runtime, one graph, one source
root, and one sanitized request readable. The evaluator durably writes, fsyncs,
and hashes every raw response before its parent process loads the hidden owner
fixtures, declaration hashes, phase rubric, or handoff expectations. The
receipt records the candidate-reported closure count explicitly; selected
files, snippets, serialized tokens, graph facts, owner declarations, and
handoffs are independently recomputed from the frozen graph and source bytes.
Acceptance additionally requires a clean exact-literal leak scan over
production and packed content plus independent adversarial review. The scan is
a leak detector, not a proof that repository-specific tuning is absent.

## Historical V1 evidence

The v0.32.0 receipt is retained only as immutable characterization evidence.
There is no active V1 recorder or V1 semantic-validation path. CI validates the
receipt's historical schema, exact byte hash, ordered-contract hash, and the
explicit v2 amendment binding; it never promotes or regrades that receipt as v2
held-out evidence.

Current evidence is produced only by the v2 held-out and performance evaluators
described above. Cross-arm clean-index time, incremental-refresh time, peak RSS,
and artifact-size distributions belong to the later comparative trial runner;
they are not inferred from the historical receipt.

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
CI scans production source and packed bytes for exact load-bearing evaluation
markers. That scan is a leak detector, not a complete anti-tuning proof;
independent adversarial review remains mandatory. Active v2 receipts are
validated with JSON Schema and independently recomputed derived invariants. The
historical v1 receipt is authenticated by its immutable byte/hash binding only.
