# Contributing to madar

Thanks for helping improve `madar`.

Contributions are welcome across code, tests, fixtures, docs, release tooling, and AI-platform integrations. Good contributions are usually small, well-scoped, and easy to verify.

## Good first contributions

A few high-value ways to help:

- fix incorrect extraction edges or missing relationships
- add fixture-backed coverage for parser or extractor regressions
- improve docs, examples, and install flows
- tighten CI, release, or repository hygiene
- reduce graph noise or improve community labeling

The public roadmap lives in [`docs/roadmap.md`](docs/roadmap.md). If you want to propose a roadmap change, open or update the relevant issue first so the scope is visible before implementation. If you are unsure where to start, pick a small issue linked from the roadmap or one tagged `good first issue` / `help wanted`, and keep the pull request scoped to that issue.

## Development setup

Prerequisites:

- Node.js 20+
- npm

From the repository root:

```bash
npm install
npm run typecheck
npm run test:run
npm run build
```

For documentation-only changes, still run `npm run typecheck` and `npm run build` when practical so broken links in generated docs or TypeScript examples do not slip through. If a command is not relevant or cannot be run locally, note that in the pull request.

If you are changing packaging or install behavior, also run:

```bash
npm pack --dry-run
```

## Project workflow

Before opening a pull request:

1. Keep the change focused on one problem or improvement.
2. Add or update tests when behavior changes.
3. Update user-facing docs when commands, outputs, or setup steps change.
4. Run the verification commands locally.
5. Avoid committing secrets, private corpora, or accidental generated artifacts.

If your change affects extraction behavior, prefer adding a small fixture and a targeted test under `tests/unit/` or `tests/fixtures/`.

## Data, benchmarks, and private material

Do not include private repositories, private corpora, proprietary prompts, API keys, tokens, credentials, customer data, or raw logs that may contain sensitive data.

Benchmark and research contributions should be reproducible from committed fixtures or clearly anonymized summaries. When real-world measurements are useful, document the environment, command, and interpretation limits without requiring maintainers or contributors to run paid benchmarks.

## Documentation expectations

When a change affects how end users install, run, or interpret the tool, update:

- `README.md` for user-facing behavior

For release preparation and publish verification, follow the maintainer checklist in [`docs/release.md`](docs/release.md).

## Pull requests

Use the pull request template and include:

- what changed
- why it changed
- how you tested it
- any follow-up work or trade-offs

For larger changes, open an issue first so the approach can be discussed before implementation.

## Security issues

Please **do not** open public issues for security vulnerabilities.

Follow the process in [`SECURITY.md`](./SECURITY.md).

## Review and merge expectations

This repository includes GitHub issue forms, a pull request template, `CODEOWNERS`, and a CI workflow to support a clean open-source contribution flow.

## License

By contributing, you agree that your contributions are licensed under this project's MIT license.
