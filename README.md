# Madar

**Give your coding agent the repo context it needs before it starts searching.**

Madar builds a local graph of your TypeScript or Node.js repository and turns the current question into a small, task-aware context pack. Claude Code, Codex, Cursor, Copilot, Gemini, Aider, and OpenCode can start from relevant files, symbols, snippets, and relationships instead of rediscovering the repository from scratch.

- **Start smaller:** give the agent likely entrypoints and runtime paths before broad search.
- **Stay local:** graph generation does not upload your source code or require a cloud service.
- **Stay current:** installed MCP profiles refresh the graph as the active workspace changes.

[![npm](https://img.shields.io/npm/v/%40lubab%2Fmadar)](https://www.npmjs.com/package/@lubab/madar)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#local-by-design)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/madar/blob/main/LICENSE)

## Try It in 60 Seconds

Install Madar with Node.js 20 or newer, then run it inside your repository:

```bash
npm install -g @lubab/madar
cd your-repository
madar try "how does authentication work?"
```

`madar try` builds or reuses the local graph, prints a human-readable first result, and recommends the next agent-install command. It does not modify your source code.

For a concrete example, Madar's included password-reset workspace contains this path:

```text
account-routes.ts
  -> PasswordResetService.requestPasswordReset()
  -> userRepository.saveResetToken()
  -> enqueueResetEmailJob()
  -> sendPasswordResetEmail()
```

That is the kind of focused starting path Madar gives an agent before it decides whether any additional file inspection is necessary.

## Connect Your Agent

Choose the agent you use. For Claude Code:

```bash
madar claude install
madar doctor
madar status
```

After installing a profile, run `madar doctor` and `madar status`. The agent can then ask Madar for context when you use normal prompts such as:

```text
How does authentication work?
Why does this endpoint return 403?
Where is the report generated?
What breaks if I change this service?
Add telemetry to this flow.
```

Madar supports these project-local installers:

| Agent | Install command |
| --- | --- |
| Claude Code | `madar claude install` |
| Codex CLI | `madar codex install` |
| Cursor | `madar cursor install` |
| GitHub Copilot | `madar copilot install` |
| Gemini CLI | `madar gemini install` |
| Aider | `madar aider install` |
| OpenCode | `madar opencode install` |

Installer details are in the [CLI and MCP reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md). Step-by-step setup and smoke tests are in the [agent quickstarts](https://github.com/mohanagy/madar/blob/main/docs/tutorials/agent-quickstarts.md).

After upgrading Madar, rerun your agent's install command so its managed profile receives current runtime settings. Older profiles may lack automatic refresh; older Codex profiles may also lack the extended MCP startup window needed by large or synchronized workspaces.

Starting with this release, Codex installs create a workspace-scoped MCP block in `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`) with `startup_timeout_sec = 180` and `tool_timeout_sec = 60`. Madar makes the MCP transport available while the initial graph reconciliation runs in a background worker. Graph-backed calls resume only after startup completes, watcher health is non-blocking with complete coverage, and the idle watcher's policy matches the published graph and manifest; `idle` alone is not a readiness guarantee.

Starting with `0.31.3`, a graph-backed call made while Madar is `starting`, `pending`, or `reconciling` returns a structured retryable response. The agent should retry the same Madar request after the suggested delay instead of bypassing Madar or running generation manually. A dead refresh owner is recovered automatically; only failed, incomplete, or policy-mismatched graph states ask for repair.

## What Changes for the Agent

Without Madar, a coding agent often begins with broad filename searches, repeated reads, and guesses about which route, service, or handler owns the task.

With Madar, the first pass can include:

- likely files, exported symbols, routes, and handlers
- direct snippets relevant to the question
- imports, calls, framework roles, and runtime handoffs
- a static runtime-path hypothesis when the graph supports one, not a live execution trace
- graph freshness and indexing-completeness signals
- explicit guidance to answer, answer with a caveat, or verify a focused target

Madar does not replace your agent or prevent it from reading code. It gives the agent a smaller, repo-grounded place to start.

## How It Works

```text
Your repository
      |
      v
Local Madar graph
      |
      v
Context for the current question
      |
      v
Claude, Codex, Cursor, or another coding agent
```

1. Madar indexes source files, symbols, imports, calls, routes, handlers, framework metadata, and selected documentation.
2. A question selects a bounded context pack rather than dumping the whole repository into the prompt.
3. The response reports evidence strength, coverage, freshness, and whether focused verification is still needed.
4. Installed MCP profiles watch the active workspace and refresh graph-backed context after relevant changes.

The full response contract, including bounded recovery and answerability states, is documented in [MCP response shape](https://github.com/mohanagy/madar/blob/main/docs/mcp-response-shape.md).

## Use Madar Without MCP

The CLI can generate and inspect context without installing an agent integration:

```bash
madar generate .
madar summary
madar pack "how does auth work?" --task explain --format text
```

Create a provider-ready prompt:

```bash
madar prompt "how does auth work?" --provider claude
```

Create a share-safe handoff for another coding tool:

```bash
madar handoff "add auth telemetry" --task implement --consumer copilot
```

Generated graphs and indexing manifests stay in the project output location. See the [getting-started tutorial](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md) for a reproducible sample workspace and expected output.

## Where Madar Fits

Madar is most useful when:

- your repository is medium or large
- the project is primarily TypeScript or Node.js
- agents keep reopening the same files or searching unrelated folders
- you ask architecture, runtime-flow, review, or impact questions
- token usage, latency, or local repo privacy matter

It helps less when:

- the repository is small or the task is obvious from one file
- the question depends on live runtime behavior that static analysis cannot observe
- the code relies heavily on dynamic patterns that are absent from the graph
- the graph is stale or relevant source files could not be indexed

Madar complements agents and IDE indexing. It is not a hosted knowledge base, runtime tracer, PR reviewer, or vulnerability scanner.

## Local by Design

- **Privacy:** Madar graph generation runs locally and does not require an API key. Your coding agent may still send prompts or selected file context to its own model provider, depending on that agent's configuration.
- **Sensitive files:** ordinary security source code remains indexable, while private keys, `.env*`, credential stores, and known non-source secret material are excluded. This is a path policy, not a content-level secret scanner.
- **Freshness:** installed MCP profiles use automatic refresh. Manual CLI users can regenerate with `madar generate .`; strict workflows can require `--require-fresh-context` or `--require-fresh-graph`.
- **Worktrees:** run Madar and the agent from the same linked Git worktree. Each worktree receives isolated graph artifacts outside the checkout; reconnect the MCP server after switching worktrees.
- **Telemetry:** Telemetry is disabled unless you explicitly enable it. Controls and the exact source-safe event schema are documented in [telemetry](https://github.com/mohanagy/madar/blob/main/docs/telemetry.md).

Treat every local MCP install, hook, or agent profile as part of your local trust boundary. The [MCP threat model](https://github.com/mohanagy/madar/blob/main/docs/security/mcp-threat-model.md) documents the boundary in detail.

## Evidence and Limits

Madar publishes the prompts, answers, traces, and share-safe reports behind its benchmark statements. Two public experiment types answer different questions and should not be compared as if they were the same test.

### Controlled v0.30 evidence

Six June TypeScript runtime-flow trials used a source checkout with task-specific proof profiles. In those controlled runs, Madar was invoked once per row and the recorded results showed:

- `3.5x` to `18.5x` fewer tool calls
- `2.2x` to `15.6x` less provider-reported input
- `1.65x` to `7.09x` lower latency

Those receipts are real measurements of profile-assisted Madar. They demonstrate what the workflow can achieve when the correct task evidence is available. They are not evidence that an untuned npm installation will reproduce the same result for arbitrary questions, because the old prompts and checkout retrieval contained benchmark-specific obligations unavailable to normal package users.

### v0.31 production-artifact validation

The July reruns removed that assistance and used the same isolated, unpacked `@lubab/madar@0.31.0` package artifact. Four of six repositories recorded an agent-adoption failure: no attributable Madar MCP call occurred. The other two invoked Madar but failed strict prompt or answer gates. The correct result is **zero valid performance comparisons**, not six product losses. These reruns expose adoption and answer-completeness work; they neither confirm nor refute the earlier controlled efficiency measurements.

Read the [benchmark suite and all dated receipts](https://github.com/mohanagy/madar/blob/main/docs/benchmarks/suite/README.md) or the shorter [claims and evidence map](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md).

## Current Release

Current version: `0.31.4`.

`0.31.4` keeps receipts tied to visible context and hardens Claude/Codex hook handling.

`0.31.3` recovers dead refresh owners, waits through live refresh contention, and returns a retry signal during temporary reconciliation instead of pushing agents to bypass Madar.

`0.31.2` keeps the Codex MCP connection responsive while its initial automatic graph refresh runs, adds an explicit 180-second Codex startup window, and keeps graph-backed answers unavailable until the refreshed graph is ready.

`0.31.1` rebuilt the public onboarding path and clarified what each benchmark experiment proves. Runtime behavior was unchanged from `0.31.0`.

`0.31.0` made code graphs directed by default, separated evidence strength from answer readiness, added bounded context recovery, made indexing completeness explicit, preserved generation policy during automatic refresh, isolated linked-worktree artifacts, and removed benchmark expectations from production retrieval.

Read the full notes in the [0.31.4 changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0314---2026-07-18).

## Documentation

| Need | Start here |
| --- | --- |
| First run | [Getting started](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md) |
| Agent setup | [Agent quickstarts](https://github.com/mohanagy/madar/blob/main/docs/tutorials/agent-quickstarts.md) |
| CLI and MCP tools | [CLI and MCP reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md) |
| Context packs | [Context-pack concepts](https://github.com/mohanagy/madar/blob/main/docs/concepts/context-packs.md) |
| Freshness and automatic refresh | [Auto-refresh policy](https://github.com/mohanagy/madar/blob/main/docs/auto-refresh.md) |
| Indexing coverage | [Indexing completeness](https://github.com/mohanagy/madar/blob/main/docs/indexing-completeness.md) |
| Privacy and MCP trust | [Threat model](https://github.com/mohanagy/madar/blob/main/docs/security/mcp-threat-model.md) |
| Evidence and benchmarks | [Claims and evidence](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md) |
| Roadmap | [Public roadmap](https://github.com/mohanagy/madar/blob/main/docs/roadmap.md) |
| Release history | [Changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md) |

## Contributing

The most useful contributions right now are tests on real TypeScript and Node.js repositories, missed-context reports, Windows/WSL/MCP reliability improvements, framework detection, and clearer setup examples.

Open issues or pull requests against the `next` branch. Before opening a PR, run:

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
