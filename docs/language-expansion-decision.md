# Language expansion decision

**Decision: defer.** Madar currently indexes JavaScript and TypeScript only through one compiler-backed canonical path. Other languages are explicit unsupported outcomes and contribute no graph nodes or edges.

The previous first-pass Python, Go, Ruby, Rust, Java, generic-language, and lightweight-scanner paths were removed during the Core Reset. Reintroducing any of them would be a new product and architecture decision, not a parser toggle or compatibility restoration.

## Evidence gates for reconsideration

Do not add another language to the roadmap until all of these gates are met:

1. the JavaScript/TypeScript product passes its correctness, token, latency, activation, and retention gates;
2. repeated target users bring concrete tasks blocked by the same language gap;
3. a labelled fixture and held-out benchmark define semantic accuracy, precision, package cost, and maintenance cost for that language;
4. the new index can write the canonical graph directly without a generic fallback, parallel fact model, or projection adapter; and
5. the added runtime and package cost is explicitly accepted.

## Current public boundary

- Say **JavaScript/TypeScript only**.
- Report other source-like files as unsupported coverage.
- Do not describe removed parsers as partial support or an optional mode.
- Do not imply broad language parity because a parser library exists.
- Verify unsupported-language evidence directly with the coding agent when a task crosses that boundary.

The decision can be amended only through the accepted Core Reset governance process and new external-user evidence.
