# GoValidate shared benchmark suite

This directory holds the public GoValidate benchmark suite inputs plus the shared pack-quality and answer-quality gates for committed benchmark artifacts.

## Files

- `questions.json` - public multi-prompt suite with stable prompt `id` values, human-readable descriptions, and realistic questions contributors can run locally
- `quality-gates.json` — named gate definitions plus the prompt text they apply to
- `verify-pack-quality.js` — deterministic verifier for persisted `graphify-ts compare` reports
- `verify-answer-quality.js` — deterministic verifier for saved `*-answer.txt` artifacts

## Public suite usage

`questions.json` is the conservative public prompt set for multi-prompt GoValidate runs. It is intentionally public-only:

- do not commit private GoValidate source labels or snippets to this file
- do not invent benchmark numbers in this directory
- keep the current dated single-prompt benchmark artifact separate from this suite

The suite is meant to widen prompt coverage across realistic tasks, not to claim universal token reduction or universal answer quality.

Example compare command:

```bash
graphify-ts compare \
  --questions docs/benchmarks/govalidate-suite/questions.json \
  --exec "cat {prompt_file} | claude -p --output-format json" \
  --yes \
  --baseline-mode native_agent
```

Run the suite locally against your own checked-out GoValidate workspace and review the saved reports before making any public claims.

## Usage

By gate name:

```bash
node docs/benchmarks/govalidate-suite/verify-pack-quality.js \
  --report path/to/report.json \
  --gate docs-artifact
```

By prompt text:

```bash
node docs/benchmarks/govalidate-suite/verify-pack-quality.js \
  --report path/to/report.json \
  --prompt "Explain how idea report is getting generated"
```

The verifier reads `report.pack`, checks normalized matched-node labels against the required/forbidden lists, enforces the numeric ceilings, prints a deterministic pass/fail summary, and exits non-zero on malformed input or any gate failure. Label matching lowercases and strips non-alphanumeric characters, so gate labels must still contain at least one alphanumeric character after normalization.

## Answer quality usage

By gate name:

```bash
node docs/benchmarks/govalidate-suite/verify-answer-quality.js \
  --answer path/to/graphify-answer.txt \
  --gate docs-artifact
```

By prompt text:

```bash
node docs/benchmarks/govalidate-suite/verify-answer-quality.js \
  --answer path/to/graphify-answer.txt \
  --prompt "Explain how idea report is getting generated"
```

The answer-quality verifier applies deterministic answer-term checks from `quality-gates.json`: required answer terms must appear, forbidden answer terms must stay absent, and the script exits non-zero on malformed input or failed term checks. `required_concepts`, `answer_quality_notes`, and `manual_review_notes` are printed as manual-review guidance so the rubric stays deterministic without pretending substring matching can fully grade answer quality.

CLI shape: `--answer <answer.txt>` plus exactly one of `--gate <name>` or `--prompt <text>`.

## Compare report metadata

`graphify-ts compare` reports may also include a `graphify_trace` object when the graphify-side runner emits structured Claude-style tool-use messages. The field is intentionally compact and safe: it stores only aggregate counts, tool names, and per-turn tool summaries for the graphify run. It does **not** persist raw tool inputs, prompts, or full trace payloads. Terminal compare summaries surface the same data as one short `Graphify trace:` line instead of dumping the trace body.
