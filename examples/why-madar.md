# Why madar?

Madar is for the moment when a structural graph already tells you what exists, but the agent still needs **what runs for this task** — the smaller execution slice or structural subset worth reading first.

## Demonstrated today

- Local graph artifacts plus task-aware packs for explain, review, impact, and implementation work.
- Static `execution_slice` output for runtime questions, explicitly labeled as a hypothesis rather than a live trace.
- Share-safe benchmark and compare artifacts that can be reviewed without exposing workstation paths.
- Deterministic install guidance that pushes supported agents toward graph-first or context-pack-first first passes.

## In progress

- A reproducible benchmark suite that reports **per-repo spread** instead of a single marketing number. See [`docs/benchmarks/suite/`](../docs/benchmarks/suite/README.md).
- Better evidence for whether strict guidance reduces exploration in practice. The current evidence is mixed; the counterexample note is in [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](../docs/benchmarks/2026-05-25-founder-command-center-auth-flow/README.md).

## Not yet measured

- Fewer wrong-file edits on real implementation tasks.
- A universal turns / latency / exploration win that holds across repos.
- A single-number cross-repo benchmark headline.

## What Madar does not do today

- It does not force the agent to stop exploring.
- It does not replace targeted file reads, tests, or review.
- It does not turn static analysis into live runtime tracing.

## How to use it

```bash
madar generate .
madar claude install   # or cursor, copilot, gemini, codex, aider, opencode
madar pack "how does auth work?" --task explain
madar prompt "how does auth work?" --provider claude
```

For broad codebase work, start with the graph-backed first pass, then expand only when the pack or graph diagnostics say evidence is missing.

## How we measure

- Public claims are mapped in [`docs/claims-and-evidence.md`](../docs/claims-and-evidence.md).
- Benchmark artifacts live under [`docs/benchmarks/`](../docs/benchmarks/).
- The benchmark-suite direction is fixed tasks, fixed repos, **per-repo spread**, and no single-number cross-repo headline.

If you want the current public claim surface in one place, start with [`docs/claims-and-evidence.md`](../docs/claims-and-evidence.md).
