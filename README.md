# Madar

**Give your coding agent authenticated repository evidence before it starts a broad search.**

Madar builds a local graph for a JavaScript or TypeScript repository. Its MCP server exposes one tool:

```text
retrieve(question, budget?)
```

The result is a small set of exact source excerpts and directed relationships, or an explicit boundary explaining why evidence could not be returned. There are no tool profiles or alternate retrieval modes to choose.

MCP advertises only the tools capability. It exposes no resources or prompts.

[![npm next](https://img.shields.io/npm/v/%40lubab%2Fmadar/next?label=npm%20next)](https://www.npmjs.com/package/@lubab/madar/v/0.40.0-beta.1)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#local-by-design)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/madar/blob/next/LICENSE)

## What's new

This is the Core Reset beta. Read the [0.40.0-beta.1 notes](https://github.com/mohanagy/madar/blob/next/CHANGELOG.md#0400-beta1---2026-07-28) and [migration guide](https://github.com/mohanagy/madar/blob/next/docs/migrations/0.40.0-beta.1.md). Comparative performance and external retention remain unmeasured.

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

An evidence result includes:

- `matched_nodes`: exact graph-backed files, symbols, source ranges, hashes, provenance, and excerpts
- `relationships`: directed graph edges between selected nodes
- `boundaries`: missing, disconnected, unsupported, stale, unavailable, corrupt, or truncated evidence
- `metrics`: selected files, snippets, closure passes, serialized tokens, and truncation

Madar authenticates an excerpt against the canonical file hash before returning it. It returns at most 12 files, 25 snippets, one directional closure pass, and 4,000 serialized tokens.

If `outcome` is `evidence`, start with the returned excerpts and relationships. If it is `missing`, `unsupported`, `stale`, `unavailable`, or `corrupt`, report that boundary and use only the focused verification needed to continue. Do not invent a path that Madar did not prove.

The complete envelope is documented in [MCP response shape](https://github.com/mohanagy/madar/blob/next/docs/mcp-response-shape.md).

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

Madar is most useful when:

- the repository is large enough that agents repeatedly rediscover ownership and flow
- the important path crosses several JavaScript or TypeScript files
- exact source evidence matters more than a broad generated summary
- token usage, latency, or local repository privacy matter

It helps less when:

- the task is already obvious from one file
- the answer depends on live runtime state that static analysis cannot observe
- critical code is in an unsupported language
- the graph is stale or relevant source files are unavailable

Madar complements coding agents and IDE indexing. It is not a runtime tracer, PR reviewer, vulnerability scanner, or hosted source-code service.

## Local by design

- **Local generation:** source indexing runs on your machine and requires no API key.
- **Authenticated excerpts:** returned source must match the hash recorded in the accepted graph.
- **Sensitive paths:** private keys, `.env*`, credential stores, and known non-source secret material are excluded before extraction. This is a path policy, not a content-level secret scanner.
- **Agent boundary:** your coding agent may still send your question or returned excerpts to its configured model provider.
- **Worktrees:** run Madar and the agent from the same linked worktree. Each worktree gets isolated graph artifacts.
- **No product telemetry:** the Thin Delivery runtime has no telemetry or updater route.
- **Zero repository writes from install:** fresh install, reinstall, and uninstall modify only supported external client configuration.

Treat every local MCP registration as part of your local trust boundary. See the [MCP threat model](https://github.com/mohanagy/madar/blob/next/docs/security/mcp-threat-model.md).

## Evidence and limits

Historical benchmark receipts remain published, including controlled experiments that used older task-specific workflows. They are real measurements of those recorded versions, not proof that the current untuned package wins on every repository.

Core Reset acceptance uses pinned held-out repositories, exact-source grading, an independently measured 15,000-node performance fixture, package-size gates, and deletion receipts. See the [claims and evidence map](https://github.com/mohanagy/madar/blob/next/docs/claims-and-evidence.md) and [Core Reset scorecard](https://github.com/mohanagy/madar/blob/next/docs/core-reset/scorecard.md).

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

The most useful contributions are held-out retrieval cases from real JavaScript or TypeScript repositories, incorrect or missing evidence reports, framework extraction fixes, and cross-platform MCP reliability improvements.

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
