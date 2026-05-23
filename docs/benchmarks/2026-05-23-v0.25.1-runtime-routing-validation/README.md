# 2026-05-23 — v0.25.1 runtime-routing validation

This folder records a **mixed, repeatable validation artifact** for the runtime-routing behavior shipped in `madar v0.25.1`.

The goal is not to market a universal win. The goal is to show:

1. which prompt classes route correctly and repeatably through the current pack surface,
2. what the current `execution_slice` quality looks like on real GoValidate runtime prompts, and
3. one real `native_agent` result where **cost improved even though latency and manual answer quality did not**.

## Scope

- **Workspace:** local GoValidate workspace with a generated `out/graph.json`
- **CLI under test:** current `v0.25.1` runtime-routing surface
- **Deterministic proof:** `pack`-based routing validation plus one `pack_only` compare artifact
- **Stochastic proof:** one existing `native_agent` compare artifact from 2026-05-23

## Deterministic routing validation

Prompt expectations live in [`prompts.json`](./prompts.json), and the compact per-prompt routing records live in [`routing-validation.json`](./routing-validation.json).

The checked prompt classes all passed:

| Prompt class | Passed | Total |
| --- | ---: | ---: |
| positive backend runtime-generation | 5 | 5 |
| explicit runtime path | 1 | 1 |
| frontend display | 3 | 3 |
| ambiguous / mixed | 4 | 4 |

### What the deterministic routing data shows

- Backend runtime-generation prompts stayed on **`runtime_generation` + `backend_runtime`** and auto-selected **`slice-v1`**.
- Frontend/display prompts stayed on **`display_rendering` + `frontend_display`** and stayed on the **default** retrieval strategy rather than being forced into backend slices.
- Ambiguous/build-time prompts such as landing-page generation and Next.js page generation stayed **`unknown` / ambiguous** instead of being promoted to backend runtime.

Representative outcomes:

| Prompt id | Actual domain | Retrieval strategy | `execution_slice` | Pack tokens |
| --- | --- | --- | --- | ---: |
| `runtime-report-generated` | backend runtime | `slice-v1` | `complete` | 1033 |
| `runtime-explicit-controller-path` | backend runtime | `slice-v1` | `complete` | 914 |
| `display-generated-date-ui` | frontend display | `default` | none | 560 |
| `mixed-nextjs-page-generated` | ambiguous | `default` | none | 195 |

Important nuance:

- Two backend-runtime prompts still produced **partial** execution slices:
  - `runtime-report-queue-processed`
  - `runtime-report-saved`
- Those prompts still passed the routing judgment because they were routed into the correct backend-runtime surface; the partial slice is useful evidence about current slice quality rather than a hidden failure.

## `pack_only` compare artifact

Committed share-safe artifact:

- [`runtime-report-generated.pack-only.report.share-safe.json`](./runtime-report-generated.pack-only.report.share-safe.json)

Observed deterministic values for `How idea report is being generated`:

- baseline prompt tokens: **31,982**
- madar prompt tokens: **32,537**
- compact pack token count: **927**
- matched nodes: **21**
- relationships: **16**
- retrieval strategy: **`slice-v1`**
- `execution_slice.status`: **`complete`**
- `execution_slice.phase_coverage.observed`: `controller`, `service`, `queue`, `worker`

This is intentionally **not** framed as a token win. On this prompt, the `pack_only` compare shows that the compact pack carried the right runtime-routing and `execution_slice` surface, but the full prompt built around that pack was still slightly larger than the bounded baseline prompt.

## `native_agent` compare artifact

Committed share-safe artifact:

- [`runtime-report-generated.native-agent.report.share-safe.json`](./runtime-report-generated.native-agent.report.share-safe.json)

This is the real 2026-05-23 single-prompt run the issue refers to.

Prompt:

> `How idea report is being generated`

| Metric | Baseline | Madar | Outcome |
| --- | ---: | ---: | --- |
| Turns | 2 | 2 | same |
| Latency (ms) | 176,361 | 224,951 | madar slower |
| Total input tokens | 113,260 | 118,161 | madar used more |
| Uncached input tokens | 77,358 | 46,357 | madar used less |
| Cache creation input tokens | 60,457 | 29,524 | madar used less |
| Cache read input tokens | 35,902 | 71,804 | madar used more |
| Total cost (USD) | 1.0739 | 0.7722 | madar cheaper |

Manual answer-quality note:

- [`native-agent-quality-note.txt`](./native-agent-quality-note.txt)

This is the important interpretation point for `v0.25.1`:

- **cost improved**
- **latency got worse**
- **total provider-reported input tokens got worse**
- **manual answer quality was not judged better**

That is a useful validation result, but it is **not** a universal product-win claim.

## Published files

- `prompts.json` — prompt list plus expected routing labels
- `collect-routing-validation.mjs` — regenerates deterministic routing records from `pack`
- `routing-validation.json` — compact deterministic per-prompt routing record
- `runtime-report-generated.pack-only.report.share-safe.json` — deterministic `pack_only` example
- `runtime-report-generated.native-agent.report.share-safe.json` — stochastic `native_agent` example
- `native-agent-quality-note.txt` — manual answer-quality note for the single native-agent run

## Reproduction commands

Build the local CLI first:

```bash
npm install
npm run build
```

Regenerate the deterministic routing matrix:

```bash
node docs/benchmarks/2026-05-23-v0.25.1-runtime-routing-validation/collect-routing-validation.mjs \
  --graph /absolute/path/to/govalidate/out/graph.json
```

Regenerate the local `pack_only` compare artifact:

```bash
node dist/src/cli/bin.js compare "How idea report is being generated" \
  --graph /absolute/path/to/govalidate/out/graph.json \
  --exec 'cat {prompt_file}' \
  --yes \
  --baseline-mode pack_only
```

The `native_agent` artifact is intentionally kept separate because it depends on a live model runner. If you want to reproduce that path, use a structured runner such as:

```bash
node dist/src/cli/bin.js compare "How idea report is being generated" \
  --graph /absolute/path/to/govalidate/out/graph.json \
  --exec 'cat {prompt_file} | claude -p --output-format json' \
  --yes \
  --baseline-mode native_agent
```

## Bottom line

`v0.25.1` now has a committed routing-validation artifact showing that:

- the targeted backend-runtime prompts route into `slice-v1`,
- the display/build-time false-positive prompts stay out of backend-runtime routing,
- the compact pack can preserve a meaningful `execution_slice`,
- and a real native-agent run can still be **cheaper while being slower and not clearly better**.

That is the honest state of the current evidence.
