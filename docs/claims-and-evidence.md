# Claims and evidence

This page separates historical receipts, current product guarantees, and unmeasured claims.

## Demonstrated today

| Claim | Evidence |
| --- | --- |
| Madar generates one canonical JavaScript/TypeScript graph locally. | Canonical index tests, indexing manifest, and [`docs/language-capability-matrix.md`](./language-capability-matrix.md) |
| `retrieve` returns exact graph-backed excerpts only after source-hash authentication. | Core Reset unit tests and [`docs/mcp-response-shape.md`](./mcp-response-shape.md) |
| The public MCP server exposes one retrieval tool with bounded output. | MCP schema/server tests and [`docs/reference/cli-and-mcp.md`](./reference/cli-and-mcp.md) |
| Core Reset deletion, package, held-out, and performance claims are gated by machine-readable receipts. | [`docs/core-reset/scorecard.md`](./core-reset/scorecard.md) and [`docs/core-reset/evidence/`](./core-reset/evidence/) |
| Historical benchmark reports are share-safe, reproducible receipts for the versions and conditions they name. | [`docs/benchmarks/`](./benchmarks/) |

## Historical measurements

Earlier releases used broader tool surfaces and task-specific workflows. Their checked-in reports remain real measurements of those recorded versions.

Six controlled June v0.30 TypeScript trials recorded lower tool-call, provider-input, latency, and cost counters under the proof profiles used at the time. July packed-artifact reruns then found no eligible production performance comparison: several agents did not invoke Madar, while other rows failed strict prompt or answer gates.

Those experiments answer different questions. Neither is a universal claim about the current one-query implementation.

## Beta boundary

The completed Core Reset product path, package gates, and bounded #618 repair support a prerelease for JavaScript/TypeScript repositories. Capability Validation and the Native-vs-Graphify comparator were cancelled before any campaign, provider request, paid spend, or result. `0.40.0-beta.2` therefore makes no comparative correctness, token, latency, cost, activation, retention, or external-user claim.

The historical evaluation contracts remain development records. A future comparison or stable-release claim requires a new issue, fresh owner authorization, and new reproducible evidence.

## Not yet measured

Madar does not currently claim:

- universal token, latency, cost, or tool-call savings
- better implementation outcomes across repositories
- better security or PR review than dedicated tools
- complete evidence for load-bearing non-JavaScript/TypeScript code
- that every connected agent will obey installed guidance
- that one static graph result replaces live runtime tracing

## Competitive scope

This is a scope summary, not a benchmark verdict:

| Tool | Best first use |
| --- | --- |
| Madar | Authenticated local evidence paths for JavaScript/TypeScript repository questions |
| Repomix | Broad repository snapshot or prompt bundle |
| Context7 | External library and framework documentation |

Any stronger comparative statement needs a dated, reproducible receipt.

## Public-copy rule

New claims must link to a dated artifact or a frozen Core Reset receipt, state the repository/task conditions, and keep counterexamples visible. Historical command names in benchmark artifacts describe those runs; they are not current product guidance.
