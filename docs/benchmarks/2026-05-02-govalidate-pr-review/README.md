# 2026-05-02 — GoValidate PR review benchmark

This directory contains the raw evidence for sadeem's real PR-review benchmark on the GoValidate Platform codebase. The numbers below come directly from the committed `report.json` produced by `review-compare`.

## Setup

- **Codebase under test:** `govalidate/platform`, a real production repo checked out at `/path/to/govalidate/platform`.
- **Compared base branch:** `origin/main`.
- **What `review-compare` measures:** the same live branch diff is converted into two `pr_impact` prompts:
  1. **verbose** — expanded PR-impact context
  2. **compact** — condensed PR-impact context
- **Runner:** `cat {prompt_file} | claude -p`
- **Committed artifact source:** `platform/out/review-compare/2026-05-02T09-44-12/`

## Headline numbers (copied from `report.json`)

| Metric | Verbose | Compact | Δ |
|---|---:|---:|---:|
| Prompt tokens | 63,024 | **8,690** | 7.252× smaller |
| Payload tokens | 41,969 | **6,093** | 6.888× smaller |
| Changed files in diff | 36 | 36 | same |
| Seed count | 143 | 143 | same |
| Hotspot count | 3 | 3 | same |
| Runner status | succeeded | succeeded | same |

This benchmark captures a real branch diff in `govalidate/platform` and shows the prompt-size reduction from compact `pr_impact` packaging without changing the underlying review target.

The right way to read it is as a **coverage contract** proof: verbose and compact mode keep the same changed files, seed set, and hotspot counts, so the smaller prompt is not buying its win by dropping review surface. The newer product framing calls that an **effective cost** win for the same review contract — smaller review prompts for the same diff-backed evidence.

## Output files in this directory

- `report.json` — raw `review-compare` metrics and run metadata
- `verbose-prompt.txt` — verbose `pr_impact` prompt sent to the runner
- `compact-prompt.txt` — compact `pr_impact` prompt sent to the runner
- `verbose-answer.txt` — runner output for the verbose prompt
- `compact-answer.txt` — runner output for the compact prompt
- `verify.sh` — prints the headline numbers from the committed `report.json`

## Reproducing the headline numbers from this directory

```bash
bash docs/benchmarks/2026-05-02-govalidate-pr-review/verify.sh
```

Output:

```text
verbose_prompt_tokens   : 63024
compact_prompt_tokens   : 8690
prompt_reduction_ratio  : 7.252x
verbose_payload_tokens  : 41969
compact_payload_tokens  : 6093
payload_reduction_ratio : 6.888x
changed_files           : 36
seed_count              : 143
hotspot_count           : 3
```

## Reproducing end-to-end in the benchmark repo

```bash
SADEEM_TS_CLI=/path/to/sadeem/dist/src/cli/bin.js
PLATFORM_REPO=/path/to/govalidate/platform

cd "$PLATFORM_REPO"
node "$SADEEM_TS_CLI" generate . --no-html

node "$SADEEM_TS_CLI" review-compare out/graph.json \
  --base-branch origin/main \
  --exec 'cat {prompt_file} | claude -p' \
  --yes
```

The fresh run writes a new timestamped directory under `platform/out/review-compare/` with the same file set committed here.
