# Language and capability matrix

This is the public support matrix for `madar` on the current mainline. It distinguishes between:

- **Primary extractor path** - the implementation used when the runtime has everything it needs
- **Fallback path** - what happens when a parser is unavailable at runtime
- **No extractor** - extensions with no registered capability yet

The registry lives in `src/infrastructure/capabilities.ts`. Canonical TypeScript/JavaScript extractor bindings live under `src/adapters/typescript/**`; `src/pipeline/extract.ts` is the isolated legacy companion for unsupported source languages and non-code inputs. Tree-sitter WASM grammars are currently bundled for **Go, Java, Python, Ruby, and Rust**.

**TypeScript/Node remains the near-term depth priority.** **Python and Go are useful first-pass support**, but **broader parity is parked** until the evidence gates in [`docs/language-expansion-decision.md`](./language-expansion-decision.md) are met. Java and Rust should be read as extractor coverage, not a public parity claim.

## Code extraction

| Coverage tier | Extensions | Primary path | Fallback / notes |
|---|---|---|---|
| TypeScript / JavaScript AST | `.ts` `.tsx` `.js` `.jsx` | One canonical TypeScript compiler program + direct graph writer | Best code-structure coverage in the repo today, including framework-aware semantics for Express, NestJS, Next.js, React Router, Fastify, Hono, tRPC, and Prisma. Default auto generation uses this one path exactly once for JS/TS and retains the legacy fallback only for unsupported source languages. `--spi` is temporarily the compatibility spelling for strict canonical JS/TS indexing; `--legacy` explicitly opts out. |
| Tree-sitter + semantic resolution | `.py` | Tree-sitter WASM parser + Python cross-file import/call resolution + conservative FastAPI router composition/route/dependency semantics + first-pass Django URL-conf route/view mapping | Falls back to the language-specific legacy extractor if the parser is unavailable |
| Tree-sitter primary | `.rb` | Tree-sitter WASM parser | Falls back to language-specific legacy extractor if the parser is unavailable |
| Tree-sitter + first-pass semantic resolution | `.go` | Tree-sitter WASM parser + local-package import resolution + receiver/call resolution + statically visible `net/http` / Gin / Chi route semantics | Conservative first pass only: local source-visible packages and obvious router/group patterns, not full Go type-checking or framework parity |
| Tree-sitter primary | `.java` `.rs` | Tree-sitter WASM parser | Falls back to the generic structural extractor if the parser is unavailable |
| Generic structural extractor | `.c` `.cc` `.cpp` `.cxx` `.h` `.hpp` `.kt` `.kts` `.cs` `.scala` `.php` `.swift` `.zig` | Generic extractor | Heuristic structure, import, inheritance, and call extraction |
| Lightweight language-specific scanners | `.lua` `.ex` `.exs` `.jl` `.ps1` `.m` `.mm` `.toc` | Purpose-built scanners | Useful coverage, but less semantic depth than AST-backed paths |
| Unsupported | everything else | none | No extractor capability is registered, so the file is skipped |

## Documents and binary assets

| Coverage tier | Extensions | Primary path | Notes |
|---|---|---|---|
| Structured text | `.md` | Heading/link/citation extractor | Routed as `document` or `paper` depending on file classification |
| Structured text | `.txt` `.rst` | Heading/link/citation extractor | Routed as `document` or `paper` depending on file classification |
| Paper extractor | `.pdf` | PDF text + section/citation extractor | Best-effort extraction from local PDF content |
| OOXML document extractor | `.docx` | DOCX text + metadata extractor | Parses `word/document.xml` and core metadata safely |
| OOXML spreadsheet extractor | `.xlsx` | XLSX sheet-name + shared-string extractor | Captures workbook structure plus text cells |
| Metadata-only binary assets | `.gif` `.jpeg` `.jpg` `.png` `.svg` `.webp` | Image metadata node | No OCR; graph stores asset metadata only |
| Metadata-only binary assets | `.aac` `.flac` `.m4a` `.mp3` `.ogg` `.opus` `.wav` | Audio metadata node | No speech-to-text transcription |
| Metadata-only binary assets | `.avi` `.m4v` `.mkv` `.mov` `.mp4` `.webm` | Video metadata node | No video transcript or frame analysis |

## Remote content boundary

Remote URL ingest is no longer part of `madar`. The product stays focused on local codebase understanding for AI coding agents, so supported extraction starts from files already present in the workspace rather than fetching web, social, or media URLs on demand.

## Framework awareness

For `.ts`, `.tsx`, `.js`, and `.jsx`, the JS/TS extractor can emit framework-semantic nodes directly instead of only low-level functions and imports. Those framework-shaped nodes carry `framework_role` on the graph node when madar can identify a mainstream convention reliably, and the default MCP surface now uses compact MCP payloads by default.

| Framework | What madar extracts today | Example `framework_role` values |
|---|---|---|
| Express | apps, routers, mounted routers, source-visible route handlers, middleware ownership, handler relationships, and route params | `express_app`, `express_router`, `express_route`, `express_middleware` |
| React Router | router-factory ownership plus source-visible loader/action relationships and route paths; route components remain ordinary symbols | `react_router_router`, `react_router_loader`, `react_router_action` |
| NestJS | modules, controllers, route decorators, providers, constructor injection, guards, pipes, and interceptors | `nest_module`, `nest_controller`, `nest_route`, `nest_provider`, `nest_guard`, `nest_pipe`, `nest_interceptor` |
| Next.js | App Router pages/routes/layouts/templates/loading/error states, Pages Router pages/APIs, middleware, client components, and server actions | `nextjs_app_page`, `nextjs_app_route`, `nextjs_app_layout`, `nextjs_app_loading`, `nextjs_app_error`, `nextjs_app_template`, `nextjs_pages_page`, `nextjs_pages_api`, `nextjs_middleware`, `nextjs_client_component`, `nextjs_server_action` |
| Fastify | application instances, registered plugins, source-visible route handlers, and route/mount metadata | `fastify_app`, `fastify_route`, `fastify_plugin` |
| Hono | application instances, source-visible route handlers and middleware, and route/mount metadata | `hono_app`, `hono_route`, `hono_middleware` |
| tRPC | routers and source-visible query, mutation, and subscription procedures | `trpc_router`, `trpc_procedure_query`, `trpc_procedure_mutation`, `trpc_procedure_subscription` |
| Prisma | client ownership plus synthetic source-visible model reads and writes carrying `storage_operation` metadata | `prisma_client`, `prisma_model_reader`, `prisma_model_writer` |

These roles are structural hints for retrieval and workflow tools. In default auto mode, Hono, Fastify, tRPC, and Prisma contribute conservative request-flow and storage hints through the canonical JS/TS index, including source-visible Hono/Fastify route ownership; the legacy fallback retains other supported languages and never augments supported JS/TS. Runtime-boundary hints remain narrower: today they are the visible client/server boundaries Madar can recognize reliably, such as the Next.js App Router surface called out below. Heavily dynamic wrapper abstractions, runtime-generated routes, and custom meta-programming layers remain generic AST structure rather than claimed framework parity.

## Runtime retrieval hints users will notice

The matrix above describes extraction coverage. The newer retrieval/runtime hints below describe what users should expect to see in answers and compact packs once a graph already exists:

| Situation | What madar preserves | Why users care |
|---|---|---|
| Queue-backed NestJS / BullMQ flows | `enqueues_job` semantic edges preserve the producer → worker handoff in compact runtime-generation explain packs | Backend "what happens after enqueue?" questions keep the worker path instead of pretending the controller calls the worker directly |
| JS/TS Hono / Fastify / tRPC / Prisma workspaces in auto mode | conservative request-flow and storage hints when routers, procedures, and model access stay source-visible | Answers get better hints about request entrypoints and persistence touchpoints, while runtime-boundary hints still stay on the narrower explicitly visible-boundary path |
| Storage-oriented prompts in auto mode | `storage_operation` metadata marks likely read/write endpoints on Prisma model operations and repository CRUD methods | "Where is this entity read or written?" questions rank persistence endpoints more accurately |
| Next.js App Router in auto mode | `runtime_boundary` metadata plus `nextjs_client_component` and `nextjs_server_action` roles for visible `'use client'` / `'use server'` boundaries | Client/server/server-action questions stay aligned with the app-router boundary the user actually cares about |
| Python FastAPI / Django workspaces | FastAPI router composition plus router / route / endpoint / dependency semantics on top of Python cross-file import/call resolution, plus first-pass Django URL-conf route → view mapping | Python route/dependency questions can now surface imported routers, dependencies, and static Django entry routes without claiming full framework parity |
| Go `net/http` / Gin / Chi workspaces | first-pass route nodes, route → handler edges, receiver-method calls, and local-package handler/service/repository call chains when imports and bindings stay static | Retrieval can now surface request-entry routes and downstream service/repository hops instead of only tree-sitter-level functions |

## How to read this matrix

- **Supported** means `madar` has a registered capability and a live handler for that extension or URL type.
- **Tree-sitter primary** means the runtime prefers a WASM grammar, then logs a one-time warning and falls back locally if that grammar is unavailable.
- **Generic** means the extractor is intentionally heuristic. It is useful for structure discovery, but it is not the same depth as the TypeScript AST path.
- **Metadata-only** means the graph will know the asset exists and keep file metadata, but it will not derive OCR, captions, or transcripts.
- **Framework-aware JS/TS** means mainstream framework conventions are modeled directly. In default auto mode, Hono, Fastify, tRPC, and Prisma contribute conservative request-flow and storage hints when the relevant code stays source-visible; runtime-boundary hints remain limited to explicitly visible boundaries madar can recognize reliably; heavily dynamic wrappers, runtime-generated routes, and custom decorator meta-programming still fall back to generic AST structure.

If you need exact command-level proof for the benchmark, eval, compare, and federation surfaces, see [proof-workflows.md](./proof-workflows.md).
