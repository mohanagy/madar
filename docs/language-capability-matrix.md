# Language and capability matrix

Madar's current product scope is deliberately narrow: one canonical compiler-backed index for JavaScript and TypeScript repositories.

## Indexed source

| Extensions | Index path | What Madar can represent |
| --- | --- | --- |
| `.ts` `.tsx` `.js` `.jsx` | One scanner-scoped TypeScript compiler program writing directly to the directed graph | Files, symbols, imports, exports, calls, classes, interfaces, types, inheritance, implementations, evidence locations, provenance, and the framework semantics below |

Every supported source file enters this path exactly once. There is no language mode, secondary extractor, parser fallback, or generic structural pass.

## Explicitly unsupported input

Other source languages and non-code formats do not produce graph nodes or edges. This includes Python, Go, Ruby, Rust, Java, C/C++, C#, Kotlin, PHP, Swift, Markdown, text documents, PDFs, office documents, images, audio, and video.

Recognized source-like files remain visible as `unsupported` outcomes in the local indexing-completeness receipt. That is a coverage warning, not partial evidence from another parser. If a question depends on one of those files, the agent should state the limitation and inspect the relevant files directly.

Remote URL ingestion is also outside the product boundary. Madar indexes supported source already present in the local workspace; it does not fetch web, social, or media URLs.

## Framework awareness

For `.ts`, `.tsx`, `.js`, and `.jsx`, the canonical index can emit framework-semantic nodes and directed relationships when mainstream conventions are statically visible.

| Framework | What Madar extracts today | Example `framework_role` values |
| --- | --- | --- |
| Express | apps, routers, mounted routers, source-visible route handlers, middleware ownership, handler relationships, and route params | `express_app`, `express_router`, `express_route`, `express_middleware` |
| React Router | router-factory ownership plus source-visible loader/action relationships and route paths; route components remain ordinary symbols | `react_router_router`, `react_router_loader`, `react_router_action` |
| NestJS | modules, controllers, route decorators, providers, constructor injection, guards, pipes, and interceptors | `nest_module`, `nest_controller`, `nest_route`, `nest_provider`, `nest_guard`, `nest_pipe`, `nest_interceptor` |
| Next.js | App Router pages/routes/layouts/templates/loading/error states, Pages Router pages/APIs, middleware, client components, and server actions | `nextjs_app_page`, `nextjs_app_route`, `nextjs_app_layout`, `nextjs_app_loading`, `nextjs_app_error`, `nextjs_app_template`, `nextjs_pages_page`, `nextjs_pages_api`, `nextjs_middleware`, `nextjs_client_component`, `nextjs_server_action` |
| Fastify | application instances, registered plugins, source-visible route handlers, and route/mount metadata | `fastify_app`, `fastify_route`, `fastify_plugin` |
| Hono | application instances, source-visible route handlers and middleware, and route/mount metadata | `hono_app`, `hono_route`, `hono_middleware` |
| tRPC | routers and source-visible query, mutation, and subscription procedures | `trpc_router`, `trpc_procedure_query`, `trpc_procedure_mutation`, `trpc_procedure_subscription` |
| Prisma | client ownership plus synthetic source-visible model reads and writes carrying `storage_operation` metadata | `prisma_client`, `prisma_model_reader`, `prisma_model_writer` |

These are static structural hints, not runtime traces. Heavily dynamic wrappers, generated routes, and custom meta-programming may remain ordinary symbols or require focused source verification.

## Runtime retrieval hints users will notice

| Situation | What Madar preserves | Why users care |
| --- | --- | --- |
| Queue-backed NestJS / BullMQ flows | `enqueues_job` semantic edges preserve a statically visible producer-to-worker handoff | Backend questions can keep the worker path without pretending the producer directly calls the worker |
| Hono / Fastify / tRPC / Prisma workspaces | Conservative request-flow and storage hints when routers, procedures, and model access stay source-visible | Answers get stronger entrypoint and persistence candidates |
| Prisma and repository operations | `storage_operation` metadata marks likely source-visible reads and writes | Persistence questions can rank the relevant endpoints more accurately |
| Next.js App Router | `runtime_boundary` metadata plus client-component and server-action roles for visible directives | Client/server questions stay aligned with explicit source boundaries |

For outcome definitions, unsupported-file reporting, and strict thresholds, see [Indexing completeness](./indexing-completeness.md).
