# Agent orchestration guide

`madar` works best when it is the shared context layer for your local agents, not another agent doing its own independent repo discovery.

This guide is intentionally conservative:

- use one graph as the shared source of truth
- prefer one agent to discover context and other agents to execute against that narrowed scope
- avoid expanding the same task through MCP, `pack`, and `prompt` at the same time unless you are explicitly comparing them
- do not treat benchmark wins as guaranteed on every repo or every session

## Choose the right surface first

| Surface | Use it when | Avoid it when |
|---|---|---|
| Installed agent rules (`madar <agent> install`) | You want the agent to keep checking the graph automatically during normal work | You only need a one-off exported prompt |
| MCP tools | The agent supports MCP and can ask follow-up questions inside the same session | You need a static handoff to another CLI or a saved prompt artifact |
| `madar pack` | You want a compact task-specific context bundle before broad search or before dispatching workers | You need provider-specific prompt formatting |
| `madar prompt` | You need a provider-ready compiled prompt for a non-MCP CLI or proof workflow | The agent already has a live MCP connection and session state |

## Recommended workflow by agent

### Claude Code

Use `madar claude install` when Claude is your primary interactive coding agent. Claude works best as an MCP-first agent:

1. `madar generate .`
2. `madar claude install`
3. Ask the codebase question normally and let Claude use MCP tools like `retrieve`, `impact`, `relevant_files`, or `implementation_checklist`.

Use `pack` only when you want to hand the narrowed context to another agent or when you want a deterministic snapshot before parallel work.

### Codex CLI

Use `madar codex install` when Codex is participating in broad repo work. Codex should stay context-pack-first:

1. `madar generate .`
2. `madar codex install`
3. In a trusted repository, restart or start a new Codex session, use `/hooks` to review and trust the project `UserPromptSubmit` hook, then use `/mcp` or `codex mcp list` to verify the local Madar MCP server.
4. `madar pack "<task>" --task explain` or use the focused graph tool for the question.
5. Open only the files or risks identified by the pack before broad shell search or worker dispatch.

The `UserPromptSubmit` hook supplies model-visible guidance only for local code tasks; it is guidance, not enforcement. `madar doctor` and `madar status` verify on-disk wiring, not live Codex trust or activation. Use `prompt` only if you need a one-shot provider-formatted prompt instead of Codex's installed rules.

### GitHub Copilot CLI

Use `madar copilot install` when Copilot CLI is your shell-facing agent. Prefer the MCP path for explain, review, and impact questions so Copilot can query the graph directly instead of repeatedly reading files.

Use `pack` when you want to freeze the current scope before handing the task to another tool or another agent.

### Cursor

Use `madar cursor install` when Cursor is the editing surface and you want graph-backed navigation inside the IDE. Cursor works well as the implementation/editor agent while another agent handles broader discovery.

If you already know the scope from Claude or Codex, hand Cursor the narrowed file list or `pack` output instead of making Cursor rediscover the repo from scratch.

### Gemini

Use `madar gemini install` if you want Gemini CLI to query the graph through MCP. Use `madar prompt ... --provider gemini` when you want a provider-ready prompt for one-shot runs, proof workflows, or environments where MCP is not available.

For Gemini, `prompt` is the better fit when you care more about a stable exported prompt than live tool use.

## Avoid repeated context expansion

The most common waste pattern is making several agents rediscover the same task independently. Prefer this order:

1. Build or refresh the graph once: `madar generate .`
2. Pick one discovery surface:
   - MCP for interactive graph-backed sessions
   - `pack` for compact task handoff
   - `prompt` for provider-ready export
3. Reuse that narrowed scope across agents instead of starting from raw search again

Practical rules:

- Do not run `pack`, then ask an MCP-connected agent to rediscover the same task from scratch unless the pack is clearly insufficient.
- Do not use `compare` or `review-compare` as routine task entrypoints; they are proof workflows.
- Refresh the graph after structural code changes before sending the same task to another agent.
- Let one agent own broad discovery. Other agents should receive file lists, task framing, or compact graph context.
- If the graph tools are unavailable or stale, read `out/GRAPH_REPORT.md` before falling back to raw file exploration.

## Task examples

### Explain

**Best default:** Claude Code, Copilot CLI, Cursor, or Gemini over MCP

```bash
madar generate .
madar claude install
```

Then ask: “How does auth work?”

**Codex variant**

```bash
madar generate .
madar pack "How does auth work?" --task explain
madar codex install
```

Use the pack to decide what Codex should open first.

### Review

Use graph-backed review surfaces first:

```bash
madar generate .
madar review-compare out/graph.json --exec 'cat {prompt_file} | claude -p' --yes
```

For live review work, prefer `pr_impact` / review-oriented MCP tools when the agent supports MCP. If a second agent needs the same review scope, hand it the compact review context instead of re-running diff discovery.

### Impact

Use the graph directly for blast radius:

```bash
madar generate .
madar pack "What breaks if I change AuthService.login?" --task impact
```

For MCP-capable agents, ask the impact question normally and let the agent use `impact` or `risk_map`. For non-MCP handoffs, use the impact pack as the shared artifact.

### Implementation

Use a lead-agent / worker-agent split:

1. Lead agent compiles scope with MCP or `pack`
2. Lead agent identifies files, risks, and validation steps
3. Worker agents edit only within that narrowed scope

Example:

```bash
madar generate .
madar pack "Implement password-reset audit logging" --task explain
```

Good follow-up flow:

- Claude or Copilot: identify files and tests
- Codex: parallelize only after the pack identifies likely edit surfaces
- Cursor: perform the edits in the narrowed files

## Conservative claims

Safe guidance:

- madar can reduce repeated repo discovery across multiple local agents
- MCP is best for live interactive workflows
- `pack` is best for compact task handoff
- `prompt` is best for provider-ready export

Unsafe guidance:

- claiming universal token savings for every agent or repo
- telling every user to always prefer `prompt` over MCP
- encouraging several agents to rediscover the same broad task independently
