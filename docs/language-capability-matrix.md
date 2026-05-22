# Language and capability matrix

This is the public support matrix for `sadeem` on the current mainline. It distinguishes between:

- **Primary extractor path** - the implementation used when the runtime has everything it needs
- **Fallback path** - what happens when a parser is unavailable at runtime
- **No extractor** - extensions with no registered capability yet

The registry lives in `src/infrastructure/capabilities.ts`. The extractor bindings live in `src/pipeline/extract.ts`. Tree-sitter WASM grammars are currently bundled for **Go, Java, Python, Ruby, and Rust**.

## Code extraction

| Coverage tier | Extensions | Primary path | Fallback / notes |
|---|---|---|---|
| TypeScript / JavaScript AST | `.ts` `.tsx` `.js` `.jsx` | TypeScript compiler API + framework-semantic pass | Best code-structure coverage in the repo today, including deep framework-aware semantics for mainstream Express, Redux Toolkit, React Router, NestJS, and Next.js patterns; MCP `retrieve`/`impact` now return compact payloads by default, with `verbose: true` as the legacy escape hatch |
| Tree-sitter + semantic resolution | `.py` | Tree-sitter WASM parser + Python cross-file import/call resolution + first-pass FastAPI route/dependency semantics | Falls back to the language-specific legacy extractor if the parser is unavailable |
| Tree-sitter primary | `.rb` | Tree-sitter WASM parser | Falls back to language-specific legacy extractor if the parser is unavailable |
| Tree-sitter primary | `.go` `.java` `.rs` | Tree-sitter WASM parser | Falls back to the generic structural extractor if the parser is unavailable |
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

## URL ingest

`sadeem add <url>` has built-in ingestors for:

- GitHub
- Reddit
- Hacker News
- X/Twitter
- arXiv
- YouTube
- direct PDF/image/audio/video URLs
- generic webpages

These ingestors fetch structured content into the local project so the normal graph build can include it. They are separate from local file extractors.

## Framework awareness

For `.ts`, `.tsx`, `.js`, and `.jsx`, the JS/TS extractor can emit framework-semantic nodes directly instead of only low-level functions and imports. Those framework-shaped nodes carry `framework_role` on the graph node when sadeem can identify a mainstream convention reliably, and the default MCP surface now uses compact MCP payloads by default.

| Framework | What sadeem extracts today | Example `framework_role` values |
|---|---|---|
| Express | apps, routers, mounted routers, route nodes, middleware ownership, handler relationships, and route params | `express_app`, `express_router`, `express_route`, `express_middleware`, `express_handler`, `express_error_handler` |
| Redux Toolkit | slices, actions, selectors, thunks, and store registration across common cross-file patterns | `redux_slice`, `redux_action`, `redux_selector`, `redux_thunk`, `redux_store` |
| React Router | object routes, JSX routes, loaders, actions, nested layouts, route components, and imported router bindings | `react_router`, `react_router_route`, `react_router_layout`, `react_router_loader`, `react_router_action`, `react_router_component` |
| NestJS | modules, controllers, route decorators, providers, constructor injection, guards, pipes, and interceptors | `nest_module`, `nest_controller`, `nest_route`, `nest_provider`, `nest_guard`, `nest_pipe`, `nest_interceptor` |
| routing-controllers | first-pass controller classes, decorator-declared route methods, combined static route paths, and bootstrap controller registration from `createExpressServer` / `useExpressServer` / Koa variants | `routing_controllers_controller`, `routing_controllers_route` |
| Next.js | App Router and Pages Router ownership, layouts/templates/loading/error states, route handlers, middleware, client/server boundaries, and server actions | `next_route`, `next_page`, `next_layout`, `next_template`, `next_loading`, `next_error`, `next_not_found`, `next_route_handler`, `next_middleware`, `next_server_action`, `next_client_component`, `next_pages_app` |

These roles are meant to be consumed as structural hints by retrieval and workflow tools. They are not guaranteed for heavily dynamic wrapper abstractions, runtime-generated routes, or custom meta-programming layers that fall back to the base AST graph.

## Runtime retrieval hints users will notice

The matrix above describes extraction coverage. The newer retrieval/runtime hints below describe what users should expect to see in answers and compact packs once a graph already exists:

| Situation | What sadeem preserves | Why users care |
|---|---|---|
| Queue-backed NestJS / BullMQ flows | `enqueues_job` semantic edges preserve the producer → worker handoff in compact runtime-generation explain packs | Backend "what happens after enqueue?" questions keep the worker path instead of pretending the controller calls the worker directly |
| Storage-oriented prompts with `--spi` | `storage_operation` metadata marks likely read/write endpoints on Prisma model operations and repository CRUD methods | "Where is this entity read or written?" questions rank persistence endpoints more accurately |
| Next.js App Router with `--spi` | `runtime_boundary` metadata plus `next_client_component` and `next_server_action` roles for visible `'use client'` / `'use server'` boundaries | Client/server/server-action questions stay aligned with the app-router boundary the user actually cares about |
| Python FastAPI workspaces | first-pass router / route / endpoint / dependency semantics on top of Python cross-file import/call resolution | FastAPI route/dependency questions return more than plain function listings, even before a deeper framework-specific pass exists |

## How to read this matrix

- **Supported** means `sadeem` has a registered capability and a live handler for that extension or URL type.
- **Tree-sitter primary** means the runtime prefers a WASM grammar, then logs a one-time warning and falls back locally if that grammar is unavailable.
- **Generic** means the extractor is intentionally heuristic. It is useful for structure discovery, but it is not the same depth as the TypeScript AST path.
- **Metadata-only** means the graph will know the asset exists and keep file metadata, but it will not derive OCR, captions, or transcripts.
- **Framework-aware JS/TS** means mainstream framework conventions are modeled directly; heavily dynamic wrappers, runtime-generated routes, and custom decorator meta-programming still fall back to the base AST graph.

If you need exact command-level proof for the benchmark, eval, compare, and federation surfaces, see [proof-workflows.md](./proof-workflows.md).
