# `plugin-host` qualification fixture

A small TypeScript/Node extension host used as a qualification target for
architecture-understanding and bounded implementation-planning tasks.

This workspace exists **only** as an evaluation target. It is not shipped in the npm
package, is not imported by `src/`, and must never be referenced by production
retrieval or context logic.

## Shape

```text
contracts/plugin.ts        the only stable extension surface (ExportPlugin)
host/config.ts             layered configuration resolution
host/registry.ts           name -> plugin resolution, duplicate rejection
host/lifecycle.ts          init -> run -> dispose ordering and failure isolation
host/plugin-host.ts        composition root, the only place that knows both sides
plugins/csv-export-plugin.ts     built-in plugin, no external I/O
plugins/webhook-export-plugin.ts built-in plugin, performs external delivery
```

The intended boundary is that `plugins/*` depends on `contracts/plugin.ts` only, and
never on `host/*`. `host/plugin-host.ts` is the single composition root.

## Deliberate defect

| Id | Site | Nature |
| --- | --- | --- |
| `seeded-boundary-violation` | `src/plugins/webhook-export-plugin.ts` | Imports `resolveHostConfig` from `host/config.ts`, breaking the stated plugin -> contracts-only boundary and coupling a plugin to host internals. |

## Authoring provenance

Authored for issue #655 on 2026-08-12 from a blank file. No Madar output, retrieval
result, context pack, or `implementationGuidance` was consulted while writing this
workspace or the truth files derived from it.
