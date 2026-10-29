# Madar

**Retrieve specific source code for your coding agent.**

Madar builds a local repository graph for JavaScript and TypeScript function lookup by file and symbol. Agents can inspect returned source and request omitted lines.

Broad context discovery and workflow packs are experimental: they can omit necessary evidence and increase total tokens once follow-up reads are counted. Consistent whole-task accuracy and token savings have not been established. Use direct source reads when they are sufficient.

[![npm](https://img.shields.io/npm/v/%40lubab%2Fmadar)](https://www.npmjs.com/package/@lubab/madar)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#local-by-design)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/madar/blob/main/LICENSE)

## Try It in 60 Seconds

Install Madar with Node.js 20 or newer. For an experimental discovery preview, run it inside your repository:

```bash
npm install -g @lubab/madar
cd your-repository
madar try "how does authentication work?"
```

`madar try` builds or reuses the local graph, prints an experimental source preview, and shows an optional agent-install command. It does not modify your source code.

For a concrete example, Madar's included password-reset workspace contains this path:

```text
account-routes.ts
  -> PasswordResetService.requestPasswordReset()
  -> userRepository.saveResetToken()
  -> enqueueResetEmailJob()
  -> sendPasswordResetEmail()
```

This is an example of a partial starting path. The agent must verify the conditions, dependencies, and failure paths needed for its answer.

## Connect Your Agent

Choose the agent you use. For Claude Code:

```bash
madar claude install --profile strict
madar doctor
madar status
```

The compact `strict` profile exposes `context_pack` and `context_expand`; `full` also includes them, while `core` exposes graph-navigation tools. After installing, run `madar doctor` and `madar status`.

When the file and function are known, use this MCP request:

```json
{
  "prompt": "Read these functions",
  "task": "explain",
  "targets": [{"file": "lib/util.js", "symbol": "join"}],
  "budget": 1500
}
```

Replace the example file and symbol with those in your repository. Targets select function source, not a complete workflow; inspect omissions and returned continuation handles. A direct source read remains appropriate.

Without exact targets, questions such as these use experimental discovery:

```text
How does authentication work?
Why does this endpoint return 403?
Where is the report generated?
What breaks if I change this service?
Add telemetry to this flow.
```

For MCP source lookup and recovery, use `strict`. Codex and OpenCode install it automatically; Aider installs prompt guidance without an MCP server.

| Agent | Install command |
| --- | --- |
| Claude Code | `madar claude install --profile strict` |
| Codex CLI | `madar codex install` |
| Cursor | `madar cursor install --profile strict` |
| GitHub Copilot | `madar copilot install --profile strict` |
| Gemini CLI | `madar gemini install --profile strict` |
| Aider | `madar aider install` |
| OpenCode | `madar opencode install` |

Installer details are in the [CLI and MCP reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md). Step-by-step setup and smoke tests are in the [agent quickstarts](https://github.com/mohanagy/madar/blob/main/docs/tutorials/agent-quickstarts.md).

After upgrading Madar, rerun your agent's install command to refresh its managed profile. Older profiles may lack automatic refresh or Codex's longer startup window.

During automatic reconciliation, graph-backed calls return a retryable response. If continuing with Madar, retry after its suggested delay. Native source investigation remains available.

## What Changes for the Agent

`context_pack` returns source locations, excerpts, omissions, freshness, and advisory coverage. Its compact `source_evidence_v2` response has a serialized token budget, including metadata. A small packet does not establish a cheaper or more accurate investigation.

For exact lookup, use up to eight JavaScript or TypeScript `targets`, each with a workspace-relative `file` and case-sensitive `symbol`. Only explain mode is supported. Missing, ambiguous, excluded, or stale owners are refused. Targets select functions, not complete workflows; they do not infer calls.

To inspect a known call instead, add `"callee":"scan"` to its caller target. Madar checks the full current caller and returns a uniquely bound local implementation. Identifier and static dotted calls are supported; nested-closure calls and dynamic expressions are excluded. Unverified bindings are refused.

One oversized exact function request returns a budgeted first page; continuations retrieve remaining lines without repetition.

For omitted evidence:

- Follow a node's `source_expand_handle` with `context_expand` in the same MCP session. Continue with each returned handle until the remaining whole source lines are delivered. Changed or newly excluded source invalidates the handle.
- Use an `expandable` handle for related evidence. An optional exact `symbol` selects a verified function inside that handle's scope. Do not pass a symbol with a source-continuation handle.
- If a page reports `budget_insufficient`, retry with a larger budget or request fewer targets. Minimum budget: 128 tokens; expansion defaults to 1500.

A `snippet_ref` points to shared source text; use the referring node's `snippet_line_range` for its excerpt. When `line_number` is omitted, use that range's start. Response paths may be workspace-relative.

Experimental discovery can include source-resolved dependencies and static graph relationships. `source_dependencies` reports verified calls and unresolved locations; `selection_omitted` reports exact matches omitted by the lookup limit. Unresolved details may use either a flat list or grouped calls, including repeated `line_numbers`. Counts can exceed the bounded examples shown. None of these establishes runtime execution or whole-task completeness.

Regenerate older graphs to include newly supported source forms. Root/workspace `package.json` objects up to 128 KiB and JavaScript/TypeScript files under `lib/` are eligible under source policy. Exclude generated output with `.madarignore`. Other JSON configuration files are not source evidence.

## How It Works

1. Madar indexes source files, declarations, imports, calls, framework metadata, and selected documentation locally.
2. Exact targets or experimental query matching select source evidence.
3. Responses expose omissions and recovery handles. Installed MCP profiles refresh the graph after workspace changes.

The [MCP response shape](https://github.com/mohanagy/madar/blob/main/docs/mcp-response-shape.md) describes the response contract.

## Use Madar Without MCP

The CLI can generate and inspect context without installing an agent integration:

```bash
madar generate .
madar summary
madar pack "how does auth work?" --task explain --format text
```

By default, `madar generate .` combines SPI metadata with proven legacy semantics for JavaScript/TypeScript, and uses legacy fallback for other supported languages. Strict modes are in the [CLI reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md).

Legacy updates rebuild the current corpus when files change or disappear, refreshing incoming calls and imports from unchanged files. Parser caches can still be reused; unchanged graphs are reused after any required extractor-version upgrade.

Create a provider-ready prompt:

```bash
madar prompt "how does auth work?" --provider claude
```

Create a share-safe handoff for another coding tool:

```bash
madar handoff "add auth telemetry" --task implement --consumer copilot
```

See the [getting-started tutorial](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md) for a sample workspace.

## Where Madar Fits

Consider precise source lookup when you know the JavaScript or TypeScript file and function and need selected bodies with explicit omissions and continuations.

It helps less when the repository is small, one direct read is sufficient, source is stale, or the question depends on dynamic or live runtime behavior. Architecture, review, and impact discovery remain experimental.

Madar complements agents and IDE indexing. It is not a hosted knowledge base, runtime tracer, PR reviewer, or vulnerability scanner.

## Local by Design

- **Privacy:** Madar graph generation runs locally and does not require an API key. Your coding agent may still send prompts or selected file context to its own model provider, depending on that agent's configuration.
- **Sensitive files:** ordinary security source code remains indexable, while private keys, `.env*`, credential stores, and known non-source secret material are excluded. This is a path policy, not a content-level secret scanner.
- **Freshness:** installed MCP profiles use automatic refresh. Manual CLI users can regenerate with `madar generate .`; strict workflows can require `--require-fresh-context` or `--require-fresh-graph`.
- **Worktrees:** run Madar and the agent from the same linked Git worktree. Each worktree receives isolated graph artifacts outside the checkout; reconnect the MCP server after switching worktrees.
- **Telemetry:** Telemetry is disabled unless you explicitly enable it. Controls and the exact source-safe event schema are documented in [telemetry](https://github.com/mohanagy/madar/blob/main/docs/telemetry.md).

Treat every local MCP install, hook, or agent profile as part of your local trust boundary. Read the [MCP threat model](https://github.com/mohanagy/madar/blob/main/docs/security/mcp-threat-model.md).

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

Current version: `0.33.0`.

See the [0.33.0 changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0330---2026-10-29).

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

Open issues or pull requests against the maintained default branch. Before opening a PR, run:

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
