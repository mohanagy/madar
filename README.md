# Madar

**Give your coding agent authenticated repository evidence before it starts a broad search.**

Madar builds a local graph for a JavaScript or TypeScript repository. Its MCP server exposes one tool:

```text
retrieve(question, budget?)
```

The result is a small set of exact source excerpts and directed relationships, or an explicit boundary explaining why evidence could not be returned. There are no tool profiles or alternate retrieval modes to choose.

MCP advertises only the tools capability. It exposes no resources or prompts.

[![npm next](https://img.shields.io/npm/v/%40lubab%2Fmadar/next?label=npm%20next)](https://www.npmjs.com/package/@lubab/madar/v/0.40.0-beta.2)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#local-by-design)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/madar/blob/next/LICENSE)

## What's new

The [0.40.0-beta.2 notes](https://github.com/mohanagy/madar/blob/next/CHANGELOG.md#0400-beta2---2026-07-29) cover the bounded retrieval repair. New Core Reset users should also read the [beta.1 migration guide](https://github.com/mohanagy/madar/blob/next/docs/migrations/0.40.0-beta.1.md). Comparative performance and external retention remain unmeasured.

## Start in three steps

Install Madar with Node.js 20 or newer:

```bash
npm install -g @lubab/madar@next
cd your-repository
madar generate .
```

Connect the coding agent you use:

```bash
madar install claude
```

Then ask your normal repository question:

```text
Trace how a failed payment becomes a retry. Cite the exact files and symbols, and state what remains uncertain.
```

For a transport check, explicitly ask the client to call `retrieve` once. That proves the configured client path, not natural tool preference. Use `madar doctor` and `madar status` to check the graph and external client registration. Codex is also supported directly with `madar install codex`. Other hosts can launch the package through the MCP Registry or a manual `madar mcp` stdio registration.

See the [agent quickstarts](https://github.com/mohanagy/madar/blob/next/docs/tutorials/agent-quickstarts.md) for registration details and activation checks.

## Use it without MCP

The CLI exposes the same retrieval contract:

```bash
madar query "how does authentication work?"
madar query "what calls enqueueInvoice?" --budget 2000
```

`budget` is optional. Madar accepts a positive integer and caps the effective serialized result at 4,000 tokens.

## What the result means

Results contain authenticated nodes and excerpts, directed relationships, explicit boundaries, and size metrics. `evidence` means the returned path is usable; other outcomes name the focused verification needed instead of implying a path Madar did not prove.

Results include at most 12 files, 25 snippets, one directional closure pass, and 4,000 serialized tokens. See [MCP response shape](https://github.com/mohanagy/madar/blob/next/docs/mcp-response-shape.md) for the exact envelope.

## How it works

```text
JavaScript / TypeScript repository
              |
              v
   authenticated local graph
              |
              v
 retrieve(question, budget?)
              |
              v
 exact excerpts + directed relationships
```

`madar generate .` uses one canonical compiler-backed path for `.js`, `.jsx`, `.ts`, and `.tsx`. Other source languages and non-code formats produce no graph facts and are reported as unsupported when they matter to a question.

`graph.json` is authoritative. The indexing manifest is a derived diagnostic.

Use `madar generate . --update` for a one-off reconcile or `madar generate . --watch` for continued local reconciliation. `madar mcp` starts stdio immediately and keeps the graph for its exact working directory current.

## Where Madar fits

Madar fits larger JavaScript or TypeScript repositories where ownership or flow crosses files and exact local evidence matters. It helps less for one-file questions, unsupported languages, stale or unavailable source, and behavior visible only at runtime.

It complements coding agents and IDE indexing; it is not a runtime tracer, PR reviewer, vulnerability scanner, or hosted source-code service.

## Local by design

- **Local evidence:** indexing needs no API key, and returned excerpts must match the accepted graph hash.
- **Sensitive paths:** keys, `.env*`, credential stores, and known non-source secrets are path-excluded, not content-scanned; your coding agent may still send your question or returned excerpts to its model provider.
- **Isolated worktrees:** run Madar and the agent together; each worktree has separate graph artifacts. Install operations touch only supported external client configuration.
- **No telemetry or updater:** neither is shipped.

Treat every local MCP registration as part of your local trust boundary. See the [MCP threat model](https://github.com/mohanagy/madar/blob/next/docs/security/mcp-threat-model.md).

## Evidence and limits

Historical receipts describe their recorded versions, not a universal win. See [claims and evidence](https://github.com/mohanagy/madar/blob/next/docs/claims-and-evidence.md) and the [Core Reset scorecard](https://github.com/mohanagy/madar/blob/next/docs/core-reset/scorecard.md).

## Documentation

| Need | Start here |
| --- | --- |
| First run | [Getting started](https://github.com/mohanagy/madar/blob/next/docs/tutorials/getting-started.md) |
| Agent setup | [Agent quickstarts](https://github.com/mohanagy/madar/blob/next/docs/tutorials/agent-quickstarts.md) |
| CLI and MCP contract | [CLI and MCP reference](https://github.com/mohanagy/madar/blob/next/docs/reference/cli-and-mcp.md) |
| Response fields | [MCP response shape](https://github.com/mohanagy/madar/blob/next/docs/mcp-response-shape.md) |
| Indexing coverage | [Indexing completeness](https://github.com/mohanagy/madar/blob/next/docs/indexing-completeness.md) |
| Privacy and MCP trust | [Threat model](https://github.com/mohanagy/madar/blob/next/docs/security/mcp-threat-model.md) |
| Evidence and benchmarks | [Claims and evidence](https://github.com/mohanagy/madar/blob/next/docs/claims-and-evidence.md) |
| Product roadmap | [Roadmap](https://github.com/mohanagy/madar/blob/next/docs/roadmap.md) |
| Release history | [Changelog](https://github.com/mohanagy/madar/blob/next/CHANGELOG.md) |

## Contributing

Useful contributions include retrieval cases, incorrect evidence reports, framework fixes, and cross-platform MCP improvements.

Open issues or pull requests against the `next` branch. Before opening a PR, run:

```bash
npm test
npm run build
npm run release:verify
```

## Contributors

Thanks to everyone shaping Madar. The list below is regenerated automatically on every push to `main`.

<!-- readme: contributors -start -->
<table>
	<tbody>
		<tr>
            <td align="center"><a href="https://github.com/mohanagy"><img src="https://avatars.githubusercontent.com/u/11216054?v=4" width="80;" alt="mohanagy"/><br /><sub><b>mohanagy</b></sub></a></td>
            <td align="center"><a href="https://github.com/Gunselheli"><img src="https://avatars.githubusercontent.com/u/125200242?v=4" width="80;" alt="Gunselheli"/><br /><sub><b>Gunselheli</b></sub></a></td>
            <td align="center"><a href="https://github.com/qorexdevs"><img src="https://avatars.githubusercontent.com/u/277760369?v=4" width="80;" alt="qorexdevs"/><br /><sub><b>qorexdevs</b></sub></a></td>
            <td align="center"><a href="https://github.com/zhengjynicolas"><img src="https://avatars.githubusercontent.com/u/32067765?v=4" width="80;" alt="zhengjynicolas"/><br /><sub><b>zhengjynicolas</b></sub></a></td>
            <td align="center"><a href="https://github.com/jamemackson"><img src="https://avatars.githubusercontent.com/u/7982720?v=4" width="80;" alt="jamemackson"/><br /><sub><b>jamemackson</b></sub></a></td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

Special thanks to [@jamemackson](https://github.com/jamemackson) for [#54](https://github.com/mohanagy/madar/pull/54), the first community-contributed feature in Madar.

## License

MIT. Use it, fork it, ship it.
