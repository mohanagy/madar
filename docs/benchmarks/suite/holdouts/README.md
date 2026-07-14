# Blind holdout suite

These rows are intentionally separate from the public benchmark manifests and have no `runtime-proof.json`. Production retrieval never loads their repository IDs, prompts, paths, or expected symbols.

Run them through the packed-artifact isolation launcher:

```bash
./docs/benchmarks/suite/isolation/run-isolated.sh \
  --repos-manifest docs/benchmarks/suite/holdouts/repos.json \
  --tasks-manifest docs/benchmarks/suite/holdouts/tasks.json \
  --task explain-runtime \
  --mode warm \
  --trials 1 \
  --exec 'cat {prompt_file} | claude -p --output-format json --verbose --allowedTools mcp__madar__retrieve' \
  --yes
```

`quality-gates.json` contains machine-checkable receipt gates only. `human-review.json` separately records `pending`, `passed`, or `failed` review for coherence, ordering, and semantic correctness. The harness never changes that status when deterministic checks pass, so a machine pass is not by itself publishable answer-quality evidence.

For a genuinely private run, copy these manifests outside the repository, replace the rows, and pass the two alternate paths. Do not add private holdouts to production configuration or runtime tests.
