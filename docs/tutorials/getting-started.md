# End-to-end getting started tutorial

Use this walkthrough when you want a 10-minute first-run path through `madar` without a private repository or paid model calls. It uses the checked-in `examples/sample-workspace/` demo so every step stays local and reproducible.

## 1. Install madar

```bash
npm install -g @lubab/madar
```

If you are working from this repository instead of a published npm install, run `npm run build` from the repository root first so the local CLI is up to date.

## 2. Start with the one-command trial flow

```bash
madar try "how does password reset request enqueue the reset email" examples/sample-workspace
```

This builds or reuses `examples/sample-workspace/out/graph.json`, prints one human-readable local explanation, and ends with the next recommended install command without requiring Claude/Cursor/Codex/Copilot setup first.

## 3. Generate a graph for the sample workspace manually

```bash
madar generate examples/sample-workspace --no-html
```

This creates `examples/sample-workspace/out/graph.json`.

If your real repo is framework-heavy TypeScript/JavaScript and you care about richer NestJS / Next.js / Prisma / tRPC retrieval hints, rerun the same step with the still-opt-in SPI pipeline:

```bash
madar generate examples/sample-workspace --spi --no-html
```

## 4. Install one agent profile

Move into the sample workspace before installing so the generated graph, agent config, and verification commands all point at the same project:

```bash
cd examples/sample-workspace
```

Use one install target so the generated graph has an actual MCP or instruction surface attached to it. Claude is the shortest path here:

```bash
madar claude install
```

If you want a different runtime, use the same step with `madar codex install`, `madar cursor install`, `madar copilot install`, `madar gemini install`, `madar aider install`, or `madar opencode install`.

## 5. Verify the install before asking bigger questions

```bash
madar doctor out/graph.json
madar status out/graph.json
```

For Claude, Cursor, Gemini, and Copilot, `doctor` checks graph freshness plus the install wiring, and `status` gives you the compact readiness summary plus the next recommended commands. `doctor`/`status` also report Codex, Aider, and OpenCode when their AGENTS/hook/plugin/MCP signals are present; if any of those drift, the agent is marked `partial` with a reinstall suggestion.

## 6. Start with a bounded summary

```bash
madar summary out/graph.json
```

This prints the deterministic high-signal overview first: graph counts, source domains, top modules, frameworks, entrypoints, and runtime paths. It is the fastest way to decide whether you need a deeper `pack`, `prompt`, or MCP retrieval call.

## 7. Build a compact pack

```bash
madar pack "how does password reset request enqueue the reset email" \
  --graph out/graph.json \
  --task explain
```

This is the fastest way to confirm the route → service → job flow is represented in the graph. On runtime-generation questions like this one, newer reports can also preserve an `execution_slice` so you can inspect ordered steps without reading the whole raw slice. Treat it as a static runtime-path hypothesis from the graph, not a live trace. The nested `phase_coverage` is also static and prompt-scoped, so broader report-generation questions may show planner/research/report-builder/scoring/renderer/persistence phases when the graph supports them.

## 8. Compile a provider-ready prompt

```bash
madar prompt "where is reset token persisted before the email job runs" \
  --provider claude \
  --graph out/graph.json
```

`prompt` only compiles the prompt payload. It does **not** call Claude or spend paid model tokens by itself.

## 9. Run a safe compare smoke check

If you want to exercise `compare` without calling a paid model, use a local echo-style runner:

```bash
madar compare "how does password reset request enqueue the reset email" \
  --graph out/graph.json \
  --baseline-mode pack_only \
  --exec 'cat {prompt_file}' \
  --yes
```

This does **not** measure model quality. It is a safe local smoke check that proves `compare` can build both prompts, isolate one bounded raw-context baseline against one compiled madar pack rendered from the same explain-pack core as `madar pack --task explain`, and save the artifact bundle without requiring a hosted model. Real model-backed compare runs are optional, and compare or benchmark flows only spend paid model tokens once you replace the local smoke-check runner with a real CLI model command.

## Expected output

- `try` should print one human-readable local result plus a recommended install command
- `generate` should write `examples/sample-workspace/out/graph.json`
- `claude install` should register the local Madar integration for the sample workspace
- `doctor` should confirm the graph path plus install wiring for Claude, Cursor, Gemini, or Copilot
- `status` should print the next recommended commands for this sample workspace when you use one of those reported agents
- `summary` should print the bounded overview before any deeper retrieval
- `pack` should print a compact JSON payload with matched nodes from the password reset flow
- `prompt` should print a provider-ready prompt payload
- `compare` should create an artifact directory under `out/compare/` containing prompt and answer files plus both `report.json` and `report.share-safe.json`
- runtime-generation compare reports may also carry an `execution_slice` inside `report.json` when madar can preserve the ordered backend flow compactly; it is a static runtime-path hypothesis, not a live trace

## Troubleshooting

- **`madar: command not found`**: make sure the global npm install succeeded, or run from a local repo checkout after `npm run build`.
- **`graph.json` missing**: rerun `madar generate . --no-html` before `pack`, `prompt`, or `compare`.
- **`doctor` or `status` says the install is missing**: rerun your chosen `madar <agent> install` command from the sample workspace root, then rerun the verification commands for Claude, Cursor, Gemini, or Copilot.
- **Need stronger framework-aware hints?** Regenerate with `madar generate . --spi --no-html` if your real workspace relies on Next.js App Router, NestJS, Prisma, or similar framework-specific boundaries.
- **`compare` looks noisy**: the `cat {prompt_file}` runner is only a local smoke check. Use a real terminal model runner later if you want meaningful answer comparisons.
- **Need more questions?** Start with `examples/sample-workspace/prompt-examples.json`.

## Optional next steps

- Replace the local compare runner with your real CLI model command from [`docs/proof-workflows.md`](../proof-workflows.md).
- Install one of the agent profiles from the README after the sample graph is generated.
- Move from `examples/sample-workspace/` to your own workspace and rerun the same `generate` → `pack` → `prompt` flow.
