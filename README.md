# madar

**Stop Claude Code, Cursor, Codex, and Copilot from wasting tokens rediscovering the same large TypeScript/Node repo.**

Madar compiles a task-aware local context pack from **the execution paths and structures relevant to this task**. That first pass is usually a much smaller execution slice or structural subset, with inline snippets and citations, so the agent can start from evidence before it starts searching the repo by hand.

Madar is deterministic local context compilation. It complements agents and IDE indexing; it is **not another generic codebase index**.

[![npm](https://img.shields.io/npm/v/%40lubab%2Fmadar)](https://www.npmjs.com/package/@lubab/madar)
[![node >=20](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](https://nodejs.org/)
[![Local first](https://img.shields.io/badge/local--first-no%20cloud%20required-0f766e)](#trust--limitations)
[![No API keys](https://img.shields.io/badge/API%20keys-none%20required-111827)](#trust--limitations)
[![license MIT](https://img.shields.io/badge/license-MIT-16a34a)](https://github.com/mohanagy/madar/blob/main/LICENSE)

---

## Who Madar is for

- Teams using AI coding agents on medium-to-large TypeScript/Node repos where broad exploration creates cost, latency, privacy, or wrong-file-edit risk.
- Explain, review, and impact workflows where a bounded first pass is more useful than a broad repo crawl.

## Who Madar is not for

- Tiny repos, throwaway scripts, or one-off prompts where full-repo search is already cheap.
- Hosted-dashboard-first buyers or teams that need broad cross-language parity before the TypeScript/Node proof deepens.

## Madar vs Repomix vs Context7

| Tool | Best first use | Where it stops |
| --- | --- | --- |
| **Madar** | Task-scoped local repo evidence for explain, review, and impact work on large TypeScript/Node repos | Not a hosted knowledge base or broad cross-language parity tool today |
| **Repomix** | Exporting or sharing a broad repo snapshot/prompt bundle | Not a task-aware local retrieval layer, PR-impact surface, or agent install flow |
| **Context7** | Pulling external library/framework docs into prompts | Not a local codebase analysis, PR-impact, or graph-backed repository context tool |

Capability/scope summary only. See the [claims-and-evidence map](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md#competitive-positioning) before turning this into a stronger claim.

---

## Quickstart

Start with the generated graph. `madar generate` creates the local graph artifact; `madar summary`, `madar pack`, `madar prompt`, and `madar handoff` can use that graph without any agent install. Run `madar <agent> install` only when you want Madar wired into an agent through MCP or local instruction files.

```bash
npm install -g @lubab/madar

cd your-project
madar generate .          # builds out/graph.json, no API key, no cloud
madar summary             # bounded repo overview before deeper retrieval
madar claude install      # wires Claude Code to use Madar via MCP
madar doctor              # checks graph freshness + agent/MCP wiring
madar status              # compact readiness summary + next commands

# Optional framework-aware metadata + disk cache:
madar generate . --spi
```

Now ask your agent something about the codebase. It can start with one bounded `retrieve` or `context_pack` call, get labeled snippets with file paths and community context, and then decide whether focused follow-up reads are still needed.

Want a tiny reproducible workspace? Start with [`examples/sample-workspace/`](https://github.com/mohanagy/madar/tree/main/examples/sample-workspace/) and the [sample workspace tutorial](https://github.com/mohanagy/madar/blob/main/docs/tutorials/sample-workspace.md).

Want the broader first-run walkthrough with install verification, one pack, and a safe compare smoke check? Use the [getting started tutorial](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md).

---

## Choose your agent

Pick one install target, then rerun `madar doctor` and `madar status` so the first result is verified before you ask a broader question:

- Claude Code: `madar claude install`
- Codex CLI: `madar codex install`
- Cursor: `madar cursor install`
- GitHub Copilot CLI: `madar copilot install`
- Gemini CLI: `madar gemini install`
- Aider: `madar aider install`
- OpenCode: `madar opencode install`

After you generate `out/graph.json`, `madar doctor` and `madar status` check the local install wiring for Claude Code, Cursor, Gemini CLI, and GitHub Copilot CLI. They also lint the AGENTS-based Madar instruction profiles for Codex CLI, OpenCode, and Aider; if a profile drifts, they mark the agent as `partial` and suggest the matching reinstall command.

Install details, generated files, profiles, and uninstall behavior live in the [CLI and MCP reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md) and [compatibility guide](https://github.com/mohanagy/madar/blob/main/docs/integrations/compatibility.md).

**Without MCP**, compile a prompt or pack directly:

```bash
madar summary
madar pack "how does auth work?" --task explain --format text
madar pack "add auth telemetry" --task implement --format json
madar handoff "add auth telemetry" --task implement --consumer copilot
madar prompt "how does auth work?" --provider claude
```

`madar prompt` stays local. `madar pack` stays the richer local/full-context surface. `madar handoff` is the share-safe remote/background-agent artifact for cloud or async workers. Note: compare and benchmark flows can spend paid model tokens when you point them at a real model CLI.

The MCP equivalents include `context_pack`, `context_prompt`, and follow-up expansion through stable session refs. For follow-ups, reuse the same `session_id` with `context_prompt` when a conversation continues; `session_diagnostics` tells you whether the turn reused, added, updated, or invalidated prior context. Expect the biggest reuse gains with a mostly stable retrieved graph context. First turns and heavily changed retrieved context naturally show little or no reuse.

Optional semantic retrieval/rerank support is local too, but requires the model package:

```bash
npm install @huggingface/transformers
```

---

## Telemetry

Telemetry is disabled unless you explicitly enable it.

```bash
madar telemetry status
madar telemetry enable
madar telemetry disable

MADAR_ENABLE_TELEMETRY=1 madar generate .
```

The current telemetry model is local-first and source-safe. It records coarse success events for `install`, `generate`, `pack`, and `compare`, plus version, OS, optional install target, and optional repo-size bucket. It does **not** record prompt text, answer text, source paths, or source content. Full controls: [`docs/telemetry.md`](https://github.com/mohanagy/madar/blob/main/docs/telemetry.md).

---

## What's New

See the [`0.27.8` changelog entry](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md#0278---2026-06-02) for the full release notes.

Recent highlights:

- `0.27.8` refactors the README into a shorter npm-facing landing page and moves long-form Pack Schema, context-pack, MCP, installer, command, and discovery-rule details into dedicated docs.
- `0.27.7` added the checked-in federation flagship proof: a reproducible frontend/backend/shared fixture plus a synthetic federation receipt.
- Roadmap docs now cover design-partner workflow loops, plugin distribution channels, and language-expansion decisions.
- The larger **What's new in 0.23.0** additions remain central: `madar summary`, the core MCP `graph_summary` tool, runtime `execution_slice` output, share-safe `report.share-safe.json` compare artifacts, and `compare --baseline-mode pack_only`.
- Public proof workflows are organized under [`docs/proof-workflows.md`](https://github.com/mohanagy/madar/blob/main/docs/proof-workflows.md), [`docs/claims-and-evidence.md`](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md), and [`docs/benchmarks/suite/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/suite/).

---

## When To Use `--spi`

`--spi` is still opt-in in `0.27.8`. Use it when your repo is framework-heavy TypeScript/JavaScript and you want extra framework-shaped metadata plus disk cache behavior.

It is usually worth it for NestJS, Next.js App Router, Prisma, tRPC, Hono, Fastify, and similar repos where users ask storage-oriented prompts, client/server boundary questions, or request-flow questions. The default pipeline is still fine for simpler repos, non-JS/TS workspaces, or first runs where you do not need the extra framework detail yet.

More detail: [context packs and task evidence](https://github.com/mohanagy/madar/blob/main/docs/concepts/context-packs.md).

---

## Core Surfaces

Madar builds a local graph once, then compiles task-specific evidence from it:

```text
your prompt
  -> workspace graph
    -> relevant nodes + edges + snippets
      -> compact context pack
        -> AI coding agent
```

The output surfaces are deliberately small:

- `madar summary`: bounded repo overview.
- `madar pack`: task-aware local context pack. JSON mode emits Pack Schema v1.
- `madar prompt`: provider-ready prompt payload.
- `madar handoff`: share-safe remote/background-agent artifact.
- `pr_impact` and `review-compare`: diff-aware review evidence.
- `execution_slice`: static runtime-path hypothesis, not a live trace. Its `phase_coverage` is also static and prompt-scoped; broad report-generation prompts can surface planner/research/report-builder/scoring/renderer/persistence phases without implying live instrumentation.

Runtime-generation prompts stay compact: pack shaping follows the strongest backend path first and suppresses sibling-route noise plus shared-hub fan-out on broad runtime-generation questions.

These seven MCP tools ship in the default core profile: `retrieve`, `pr_impact`, `impact`, `call_chain`, `community_overview`, `graph_stats`, and `graph_summary`. The full surface is 26 tools, opt-in via `MADAR_TOOL_PROFILE=full` or `--profile full`, including `context_expand` and `get_neighbors`.

Full command and MCP reference: [`docs/reference/cli-and-mcp.md`](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md).

---

## Evidence And Limits

The current headline proof is one verified GoValidate backend service cell for the prompt *"How idea report is being generated"*:

| metric | baseline | Madar | delta |
| --- | --- | --- | --- |
| total tool calls | 28 | 7 | 4x fewer |
| broad search after first Madar call | 11 | 0 | eliminated |
| input tokens | 2,366,946 | 498,688 | 4.75x less |
| wall-clock latency | 158,995 ms | 72,420 ms | 2.2x faster |
| cost | 2.6595 USD | 0.9728 USD | 2.73x cheaper |

This is one cell: one prompt, one repo, one agent runtime, one verified install path. Your results will vary by repo shape, prompt type, agent runtime, and other installed tools. Published benchmark cells run in isolation mode. Your local numbers may differ if your Claude Code config differs.

Current evidence also includes a public benchmark suite with per-repo spread, initial fixture-proxy implement/review/impact rows, and workflow-outcome receipts. There is still no single-number cross-repo headline. Mixed evidence and counterexamples are tracked openly, including [`docs/benchmarks/2026-05-25-founder-command-center-auth-flow/`](https://github.com/mohanagy/madar/tree/main/docs/benchmarks/2026-05-25-founder-command-center-auth-flow/).

Madar is a context/evidence layer for review and security workflows, not a PR reviewer or vulnerability scanner. CodeRabbit, Qodo, Codex Security, and similar tools still decide findings, policy, and remediation behavior. Madar supplies bounded local evidence through `pr_impact`, `review-compare`, `madar handoff`, and `report.share-safe.json`.

Read the public claim map before using numbers in customer-facing copy: [`docs/claims-and-evidence.md`](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md).

---

## Trust + Limitations

Everything stays local by default. No cloud upload, no API key required. Your code never crosses an HTTP boundary unless you explicitly invoke a model or remote system you configured yourself.

- Build: tree-sitter AST extraction and Louvain community detection, CPU-local.
- Query: BM25 lexical scoring, reciprocal-rank fusion, optional ONNX embeddings, and optional cross-encoder reranker.
- MCP: local stdio subprocess of your agent.
- Security boundary: local-first is not automatically safe. Treat every Madar MCP install, plugin, hook, or AGENTS profile as a local trust boundary. Only enable it for repositories and local agent runtimes you trust. Prefer `--profile strict` when you only need the lean core MCP tools. `--profile strict` keeps the lean core MCP tools but still uses one bounded `context_pack` call per task before broader exploration. Threat model: [`docs/security/mcp-threat-model.md`](https://github.com/mohanagy/madar/blob/main/docs/security/mcp-threat-model.md).

Limitations to know:

1. Cold-start sessions add a one-time MCP/tool-schema cost. Core profile is about ~3,200 bytes / ~800 tokens, down about 25% from the original surface.
2. Deep extraction is still best on JS/TS. Python has conservative cross-file import/call resolution, FastAPI router composition, and first-pass Django URL-conf route-to-view mapping. Go has conservative local-package import, receiver-call, and `net/http` / Gin / Chi route support. Python and Go are still not near JS/TS parity.
3. Static analysis cannot resolve every dynamic runtime behavior.
4. Token reduction depends on project and task.
5. Some workflows still need full file reads, tests, and review.

---

## Documentation

| Need | Link |
| --- | --- |
| First run | [Getting started](https://github.com/mohanagy/madar/blob/main/docs/tutorials/getting-started.md) |
| Small demo repo | [Sample workspace](https://github.com/mohanagy/madar/blob/main/docs/tutorials/sample-workspace.md) |
| Context packs, Pack Schema v1, adaptive renderings | [Context packs and task evidence](https://github.com/mohanagy/madar/blob/main/docs/concepts/context-packs.md) |
| CLI commands, MCP tools, agent installers | [CLI and MCP reference](https://github.com/mohanagy/madar/blob/main/docs/reference/cli-and-mcp.md) |
| Install matrix | [Compatibility guide](https://github.com/mohanagy/madar/blob/main/docs/integrations/compatibility.md) |
| Proof workflows | [Proof workflows](https://github.com/mohanagy/madar/blob/main/docs/proof-workflows.md) |
| Claims and evidence | [Claims and evidence map](https://github.com/mohanagy/madar/blob/main/docs/claims-and-evidence.md) |
| Team and enterprise offer | [Team and enterprise offer](https://github.com/mohanagy/madar/blob/main/docs/team-enterprise-offer.md) |
| Benchmark suite | [Benchmark suite](https://github.com/mohanagy/madar/blob/main/docs/benchmarks/suite/README.md) |
| Language coverage | [Language and capability matrix](https://github.com/mohanagy/madar/blob/main/docs/language-capability-matrix.md) |
| Roadmap | [Public roadmap](https://github.com/mohanagy/madar/blob/main/docs/roadmap.md) |
| Telemetry | [Telemetry guide](https://github.com/mohanagy/madar/blob/main/docs/telemetry.md) |
| MCP Registry metadata | [`docs/mcp-registry/server.json`](https://github.com/mohanagy/madar/blob/main/docs/mcp-registry/server.json) |
| Full release notes | [Changelog](https://github.com/mohanagy/madar/blob/main/CHANGELOG.md) |

---

## Contributors

Thanks to everyone shaping madar. The list below is regenerated automatically on every push to `main` by [`.github/workflows/contributors.yml`](https://github.com/mohanagy/madar/blob/main/.github/workflows/contributors.yml).

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

A specific shout-out to [@jamemackson](https://github.com/jamemackson) for [#54](https://github.com/mohanagy/madar/pull/54), adding OpenCode MCP installer support, the first community-contributed feature in madar.

---

## License

MIT. Use it, fork it, ship it.
