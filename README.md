# Madar

**Give coding agents the repo context they need before they start searching.**

Madar builds a local graph of your TypeScript/Node repo, then gives agents like Claude Code, Cursor, Codex, Copilot, Gemini, Aider, and OpenCode a task-aware context pack for the question you are asking.

It helps agents spend less time rediscovering the same files, routes, imports, and flows.

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
- the generated graph is stale after large repo changes

If the repo changed a lot, regenerate:

```bash
madar generate .
```

## Freshness

Madar records graph freshness so agents can tell whether context still matches the repo. On git workspaces, freshness is tied to the graph build commit plus the working-tree diff, so unrelated changes do not have to block a focused task by default.

```bash
madar pack "how does auth work?" --require-fresh-context
madar pack "how does auth work?" --require-fresh-graph
```

Use `--require-fresh-context` when the selected files must be fresh. Use `--require-fresh-graph` when the whole graph must match the current repo.

## Evidence

On one verified GoValidate backend explain task, Madar reduced:

| Metric | Without Madar | With Madar |
| --- | ---: | ---: |
| Tool calls | 28 | 7 |
| Input tokens | 2,366,946 | 498,688 |
| Wall-clock latency | 158,995 ms | 72,420 ms |
| Cost | $2.6595 | $0.9728 |

This is not a universal benchmark claim. It is one repo, one prompt, one agent runtime, and one verified install path.

The public evidence map tracks what is proven, what is mixed, and what should not be claimed yet: [claims and evidence](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md).

## Privacy

Madar runs locally. Generating a graph does not require an API key or a cloud service. Your code does not leave your machine through Madar graph generation.

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

Current version: `0.27.9`.

This release includes the stable next-track adoption bundle: the one-command `madar try` flow, opt-in telemetry, verified agent quickstarts, public benchmark-suite work, freshness improvements, and Windows Claude workflow fixes.

Read the full notes in the [0.27.9 changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0279---2026-06-04).

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
