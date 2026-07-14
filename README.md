# Madar

**Give coding agents the repo context they need before they start searching.**

Madar builds a local graph of your TypeScript/Node repo, then gives agents like Claude Code, Cursor, Codex, Copilot, Gemini, Aider, and OpenCode a task-aware context pack for the question you are asking.

It helps agents spend less time rediscovering the same files, routes, imports, and flows.

In the latest public TypeScript benchmark receipts, Madar produced proof-backed `full_win` outcomes on 6/6 `explain-runtime` legacy rows with strict runtime-proof gates enabled.

[![npm](https://img.shields.io/npm/v/%40lubab%2Fmadar)](https://www.npmjs.com/package/@lubab/madar)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#privacy)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/madar/blob/main/LICENSE)

## Why

On large repos, coding agents often burn context before they can answer:

- broad searches across unrelated folders
- repeated file discovery every session
- wrong-file edits because the first context was too shallow

Madar gives the agent a smaller, repo-grounded starting point.

It does not replace the agent. It helps the agent start from better evidence.

## What Agents Get

For each task, Madar can surface:

- the likely entry files, symbols, routes, and handlers
- direct snippets and file paths for the current question
- relationships such as imports, calls, framework roles, and runtime handoffs
- freshness metadata tied to git state
- share-safe benchmark and handoff artifacts for review

The goal is not to make the agent blind to the repo. The goal is to make the first pass smaller, more relevant, and easier to verify.

## Install

```bash
npm install -g @lubab/madar
```

Madar requires Node.js 20 or newer.

## Quick Start

Run this inside your repo:

```bash
madar try "how does auth work?"
```

That command builds or reuses the local graph, prints a first context-pack result, and suggests the next install command.

For the manual flow:

```bash
madar generate .
madar summary
madar doctor
madar status
```

Generated code graphs preserve source → target edge direction by default. If you have an undirected graph from an older Madar release, `madar generate . --update` migrates it before impact, call-chain, or directional retrieval is used.

Then connect an agent:

```bash
madar claude install
```

Now ask your agent normal repo questions:

```text
How does auth work?
Where is the report generated?
Add telemetry to this flow.
Why does this endpoint return 403?
```

The agent can ask Madar for relevant files, symbols, snippets, and relationships before doing raw repo search.

## Supported Agents

```bash
madar claude install
madar codex install
madar cursor install
madar copilot install
madar gemini install
madar aider install
madar opencode install
```

After installing a profile, run `madar doctor` and `madar status`. Installer details are in the [CLI and MCP reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md).

If you upgrade to `0.30.0` from an earlier version, run your profile's install command again (for example, `madar claude install` or `madar codex install`) to update its managed MCP entry with automatic refresh.

## Use Without MCP

You can also generate context directly from the CLI:

```bash
madar pack "how does auth work?" --task explain --format text
```

Create an agent-ready prompt:

```bash
madar prompt "how does auth work?" --provider claude
```

Create a share-safe handoff for another coding tool:

```bash
madar handoff "add auth telemetry" --task implement --consumer copilot
```

## What It Builds

Madar analyzes your local repo and creates a graph of files, imports, exports, symbols, routes, handlers, call relationships, dependency relationships, framework metadata, and task-relevant snippets.

The graph is stored locally in your project output folder.

## Fit

Madar is most useful when:

- your repo is medium or large
- the project is TypeScript or Node.js
- agents keep opening too many files
- you ask architecture, flow, review, or impact questions
- you want more task-aware context before edits
- token usage, latency, or local repo privacy matter

It helps less when:

- the repo is small
- the task is obvious from one file
- the question needs live runtime behavior
- the code relies heavily on dynamic patterns static analysis cannot see
- you use a standalone graph without regenerating it after large repo changes

For standalone CLI workflows, regenerate after substantial repo changes:

```bash
madar generate .
```

## Freshness

Madar records graph freshness so agents can tell whether context still matches the repo. On git workspaces, freshness is tied to the graph build commit plus the working-tree diff, so unrelated changes do not have to block a focused task by default.

Installed MCP profiles in `0.30.0` start `madar serve --stdio --auto-refresh`. Madar reconciles the graph when that server starts, then watches the active workspace and refreshes the graph after source or relevant configuration changes. You do not need to run `madar generate` after every agent edit or session; manual generation remains available for standalone CLI workflows.

```bash
madar pack "how does auth work?" --require-fresh-context
madar pack "how does auth work?" --require-fresh-graph
```

Use `--require-fresh-context` when the selected files must be fresh. Use `--require-fresh-graph` when the whole graph must match the current repo.

## Git Worktrees

Run Madar and your coding agent from the same linked Git worktree. Madar keeps the default graph and related artifacts outside that checkout, under the repository's shared Git data directory, and gives each worktree its own isolated artifact directory. That keeps branches from sharing graph state and avoids generated `out/` artifacts inside linked worktrees.

An MCP server selects its workspace when it starts. If an agent later creates or switches to another worktree, start or reconnect the agent/MCP server from that new worktree; a running server cannot follow a later directory change.

## Evidence

Madar now has proof-backed public TypeScript `explain-runtime` legacy benchmark receipts across six open-source repos. Each row below has `benchmark_outcome = "full_win"`, `benchmark_readiness = "ready"`, `answer_quality.madar.passed = true`, and `answer_contract.runtime_proof.missing_obligations = []`.

| Repo | Input tokens | Fresh tokens | Tool calls | Turns | Latency | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `documenso` | 174,504 -> 76,721 (2.27x) | 31,754 -> 16,001 (1.98x) | 7 -> 2 | 8 -> 3 | 58.2s -> 35.3s (1.65x) | $0.3498 -> $0.1634 (2.14x) |
| `formbricks` | 163,482 -> 74,395 (2.20x) | 19,471 -> 14,663 (1.33x) | 37 -> 2 | 6 -> 3 | 157.6s -> 22.6s (6.99x) | $0.4973 -> $0.1350 (3.68x) |
| `dub` | 233,038 -> 76,538 (3.04x) | 33,088 -> 15,847 (2.09x) | 9 -> 2 | 10 -> 3 | 69.4s -> 30.2s (2.29x) | $0.3928 -> $0.1570 (2.50x) |
| `twenty` | 694,972 -> 103,125 (6.74x) | 48,000 -> 22,355 (2.15x) | 21 -> 3 | 22 -> 4 | 128.5s -> 58.7s (2.19x) | $0.8000 -> $0.2069 (3.87x) |
| `cal-diy` | 1,588,241 -> 101,820 (15.60x) | 61,669 -> 21,688 (2.84x) | 37 -> 3 | 38 -> 4 | 252.0s -> 38.7s (6.51x) | $1.4263 -> $0.1946 (7.33x) |
| `novu` | 1,055,389 -> 75,772 (13.93x) | 63,542 -> 15,491 (4.10x) | 23 -> 2 | 24 -> 3 | 220.3s -> 31.1s (7.09x) | $1.1316 -> $0.1620 (6.98x) |

This is not a universal benchmark claim. These are repo/task-specific, single-trial, legacy-row receipts for public TypeScript `explain-runtime` prompts. SPI arms are tracked separately and are not folded into this 6/6 claim.

The public evidence map tracks what is proven, what is mixed, and what should not be claimed yet: [claims and evidence](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md).

## Privacy

Madar runs locally. Generating a graph does not require an API key or a cloud service. Your code does not leave your machine through Madar graph generation.

Discovery uses a source-aware secret policy. Security-related source names such as `token.ts`, `password-reset-service.ts`, `password-policy.ts`, and `secret-manager.ts` are normal code and are indexed, including code below a directory named `secrets/` or `credentials/`. Madar does not read private-key material, `.env*` files, known credential stores such as `.netrc` / `.npmrc` / `.pgpass`, or non-source secret configs such as `credentials.json` and files below explicit secret directories.

Every safety exclusion has a reason. `madar generate`, `madar doctor`, and `madar status` show local counts and escaped paths; the full local list is stored in `graph.json` under `discovery_safety.exclusions`. Answer confidence is reduced when an excluded or unreadable path is relevant to a question. Share-safe handoffs expose only counts and reason buckets, never those local paths.

This path policy is not a content-level secret scanner. Madar reads indexed source, so remove hard-coded credentials or exclude their files with `.madarignore` before generation.

Your coding agent may still send prompts or selected file context to its own model provider, depending on how that agent is configured.

Treat every local MCP install, hook, or agent profile as part of your local trust boundary. The threat model is documented here: [MCP threat model](https://github.com/mohanagy/madar/blob/main/docs/security/mcp-threat-model.md).

## Telemetry

Telemetry is disabled unless you explicitly enable it.

```bash
madar telemetry status
madar telemetry enable
madar telemetry disable
madar telemetry clear
madar telemetry report

MADAR_ENABLE_TELEMETRY=1 madar generate .
```

It does not record prompt text, answer text, source paths, source content, or repository names. Full controls: [docs/telemetry.md](https://github.com/mohanagy/madar/blob/main/docs/telemetry.md).

## What's New

Current version: `0.30.0`.

`0.30.0` makes installed MCP integrations self-refreshing: they reconcile the graph at startup and watch the active workspace through an agent session. It also gives each linked Git worktree isolated external graph and artifact storage. Start or reconnect MCP from the worktree the agent is using; a running server stays scoped to the worktree where it started.

`0.29.0` adds full project-local Codex CLI wiring: `madar codex install` now owns a task-applicable `UserPromptSubmit` hook, its local script, and a marker-owned Madar MCP entry alongside the AGENTS profile. The hook provides guidance for local code tasks, not enforcement; review and trust it in Codex before relying on it.

`0.28.0` promoted the public benchmark work to a proof-backed stable release: six public TypeScript `explain-runtime` legacy rows now have checked-in `full_win` receipts, strict runtime-proof gates, direct-evidence answer checks, scoped benchmark roots, and share-safe reports. It also includes retrieval and extraction improvements for runtime handoffs, source-visible framework flows, and benchmark reproducibility.

Read the full notes in the [0.30.0 changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0300---2026-07-14).

## Docs

| Need | Link |
| --- | --- |
| First run | [Getting started](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md) |
| Agent setup | [Agent quickstarts](https://github.com/mohanagy/madar/blob/main/docs/tutorials/agent-quickstarts.md) |
| CLI and MCP tools | [CLI and MCP reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md) |
| Context-pack model | [Context packs](https://github.com/mohanagy/madar/blob/main/docs/concepts/context-packs.md) |
| Claims and limits | [Claims and evidence](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md) |
| Benchmarks | [Benchmark suite](https://github.com/mohanagy/madar/blob/main/docs/benchmarks/suite/README.md) |
| Roadmap | [Roadmap](https://github.com/mohanagy/madar/blob/main/docs/roadmap.md) |
| Changelog | [Changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md) |

## Contributing

The most useful contributions right now are:

- testing Madar on real TypeScript and Node.js repos
- reporting cases where the context pack misses important files
- improving Windows, WSL, and MCP setup reliability
- adding framework detection for common repo patterns
- improving docs with real setup examples

For active development, open issues or PRs against the `next` branch.

Before opening a PR, run:

```bash
npm test
npm run build
npm run release:verify
```

See the full contributor graph on [GitHub contributors](https://github.com/mohanagy/madar/graphs/contributors).

## Contributors

Thanks to everyone shaping Madar. The list below is regenerated automatically on every push to `main`.

<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center">
                <a href="https://github.com/mohanagy">
                    <img src="https://avatars.githubusercontent.com/u/11216054?v=4" width="80;" alt="mohanagy"/>
                    <br />
                    <sub><b>mohanagy</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/Gunselheli">
                    <img src="https://avatars.githubusercontent.com/u/125200242?v=4" width="80;" alt="Gunselheli"/>
                    <br />
                    <sub><b>Gunselheli</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/qorexdevs">
                    <img src="https://avatars.githubusercontent.com/u/277760369?v=4" width="80;" alt="qorexdevs"/>
                    <br />
                    <sub><b>qorexdevs</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/zhengjynicolas">
                    <img src="https://avatars.githubusercontent.com/u/32067765?v=4" width="80;" alt="zhengjynicolas"/>
                    <br />
                    <sub><b>zhengjynicolas</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/jamemackson">
                    <img src="https://avatars.githubusercontent.com/u/7982720?v=4" width="80;" alt="jamemackson"/>
                    <br />
                    <sub><b>jamemackson</b></sub>
                </a>
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

Special thanks to [@jamemackson](https://github.com/jamemackson) for [#54](https://github.com/mohanagy/madar/pull/54), the first community-contributed feature in Madar.

## License

MIT. Use it, fork it, ship it.
