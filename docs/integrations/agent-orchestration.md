# Agent orchestration

Madar should narrow discovery once, not become another layer that every worker repeats.

## Recommended flow

1. Build or refresh one graph with `madar generate .`.
2. Let one lead agent call `retrieve` once with the user's question unchanged.
3. When `state` is `ready`, use the dossier's obligations, flow, and authenticated evidence to define the work.
4. Otherwise, give worker agents only the exact missing requirement or failure and the focused verification goal.
5. Regenerate after structural changes before asking a new repository question.

This is guidance, not a host-level enforcement mechanism.

## MCP and CLI

Use MCP when the lead agent supports it:

```bash
madar generate .
madar install claude
```

Use the equivalent CLI call when MCP is unavailable:

```bash
madar query "Trace authentication from the route to session persistence."
```

Do not run several discovery products for the same question. Madar has one query path; changing from MCP `retrieve` to CLI `query` changes transport, not evidence selection.

MCP exposes exactly that one tool and no resources or prompts. Hosts without a supported Claude Code or Codex installer should use the public Registry entry or manually register `madar mcp` with the exact workspace as `cwd`.

## Explain, review, impact, and implementation

Write the task in the question itself:

```text
Explain how checkout reaches payment capture. Cite exact files and symbols.
```

```text
Review the current authentication change. Which graph-backed callers and tests are affected?
```

```text
What can break if AuthService.login changes? Preserve directed causal order.
```

```text
To implement password-reset audit logging, identify the current route-to-job path and its exact validation files.
```

`retrieve` does not switch tools for these questions. The same deterministic obligation planning, workflow selection, authentication, and atomic packing rules apply.

## Parallel agents

A good split is:

- lead agent: run the one retrieval and identify the ready dossier or exact non-ready state
- implementation workers: edit only assigned areas
- reviewer: verify the diff and tests against the same task, making a new retrieval only if the user asks a genuinely new repository question

Do not treat every continuation message as a new retrieval task. A clarification about already-returned evidence can remain in the current agent context.

## Non-ready states

When Madar reports `incomplete`, `unsupported`, `stale`, `unavailable`, or `corrupt`:

- do not treat it as partial answer evidence
- state the exact missing requirement, reason, or failure
- verify only that load-bearing target
- never manufacture a complete causal path

Historical benchmark workflows may contain older command names. They are receipts for those recorded versions, not current orchestration guidance.
