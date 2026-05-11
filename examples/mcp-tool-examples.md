# MCP Tool Examples

These examples show what your AI agent sees when it calls graphify-ts MCP tools. Think of this surface as the MCP half of the graphify-ts **context plane**: retrieval for discovery, impact for blast radius, and context-compiler tools for compact packs and provider-ready prompts. All output is real data from a production codebase.

## context_pack — Compact Context Pack

**Agent calls:**
```json
{ "name": "context_pack", "arguments": { "prompt": "how does payment processing work?", "task": "explain", "budget": 2000 } }
```

**Compressed / diagnostic variant:**
```json
{
  "name": "context_pack",
  "arguments": {
    "prompt": "trace the auth callback flow",
    "task": "explain",
    "budget": 2000,
    "resolution": "sketch",
    "verbose": true
  }
}
```

**Agent receives:**
```json
{
  "task": "explain",
  "prompt": "how does payment processing work?",
  "budget": 2000,
  "graph_path": "graphify-out/graph.json",
  "pack": {
    "question": "how does payment processing work?",
    "token_count": 1847,
    "matched_nodes": [
      {
        "label": "StripeGatewayService",
        "source_file": "backend/src/modules/billing/services/stripe-gateway.service.ts",
        "line_number": 15,
        "snippet": "export class StripeGatewayService implements PaymentGateway { ... }",
        "match_score": 3,
        "relevance_band": "direct",
        "community": 8,
        "community_label": "Backend Billing"
      },
      {
        "label": "TransactionService",
        "source_file": "backend/src/modules/billing/services/transaction.service.ts",
        "line_number": 22,
        "snippet": "export class TransactionService { ... }",
        "match_score": 2,
        "relevance_band": "related",
        "community": 12,
        "community_label": "Backend Transaction"
      }
    ],
    "relationships": [
      { "from": "StripeGatewayService", "to": "TransactionService", "relation": "calls" }
    ],
    "community_context": [
      { "id": 8, "label": "Backend Billing", "node_count": 23 },
      { "id": 12, "label": "Backend Transaction", "node_count": 12 }
    ],
    "graph_signals": {
      "god_nodes": ["User"],
      "bridge_nodes": ["StripeGatewayService"]
    },
    "shared_file_type": "code"
  },
  "claims": [
    {
      "evidence_class": "primary",
      "text": "primary evidence: StripeGatewayService",
      "node_labels": ["StripeGatewayService"]
    },
    {
      "evidence_class": "supporting",
      "text": "supporting evidence: TransactionService",
      "node_labels": ["TransactionService"]
    }
  ],
  "expandable": [
    {
      "kind": "nodes",
      "handle_id": "expand:explain:structural:9e7d4c2a11f0",
      "evidence_class": "structural",
      "count": 3,
      "preview": [
        {
          "node_id": "billing_module",
          "label": "BillingModule",
          "source_file": "backend/src/modules/billing/billing.module.ts",
          "line_range": { "start_line": 1, "end_line": 42 }
        },
        {
          "node_id": "webhook_controller",
          "label": "WebhookController",
          "source_file": "backend/src/modules/billing/controllers/webhook.controller.ts",
          "line_range": { "start_line": 10, "end_line": 86 }
        },
        {
          "node_id": "customer_ledger",
          "label": "CustomerLedger",
          "source_file": "backend/src/modules/billing/domain/customer-ledger.ts",
          "line_range": { "start_line": 5, "end_line": 33 }
        }
      ],
      "follow_up": {
        "kind": "context_pack",
        "task_kind": "explain",
        "evidence_class": "structural",
        "focus_files": [
          "backend/src/modules/billing/billing.module.ts",
          "backend/src/modules/billing/controllers/webhook.controller.ts",
          "backend/src/modules/billing/domain/customer-ledger.ts"
        ],
        "focus_ranges": [
          {
            "source_file": "backend/src/modules/billing/billing.module.ts",
            "start_line": 1,
            "end_line": 42
          },
          {
            "source_file": "backend/src/modules/billing/controllers/webhook.controller.ts",
            "start_line": 10,
            "end_line": 86
          },
          {
            "source_file": "backend/src/modules/billing/domain/customer-ledger.ts",
            "start_line": 5,
            "end_line": 33
          }
        ]
      }
    }
  ],
  "coverage": {
    "required_evidence": ["primary", "supporting", "structural"],
    "semantic_required": ["implementation", "structure"],
    "semantic_optional": ["contracts", "configuration", "tests"],
    "entries": [
      { "evidence_class": "primary", "required": true, "available_nodes": 1, "selected_nodes": 1, "status": "covered" },
      { "evidence_class": "supporting", "required": true, "available_nodes": 2, "selected_nodes": 1, "status": "covered" },
      { "evidence_class": "structural", "required": true, "available_nodes": 3, "selected_nodes": 0, "status": "missing" }
    ],
    "semantic_entries": [
      { "category": "implementation", "label": "implementation", "required": true, "available_nodes": 2, "selected_nodes": 2, "status": "covered" },
      { "category": "structure", "label": "structure", "required": true, "available_nodes": 3, "selected_nodes": 0, "status": "missing" },
      { "category": "tests", "label": "tests", "required": false, "available_nodes": 1, "selected_nodes": 0, "status": "available" }
    ],
    "missing_required": ["structural"],
    "missing_semantic": ["structure"],
    "available_relationships": 7,
    "selected_relationships": 1
  },
  "missing_context": ["structural"]
}
```

**What the agent does with this:** Uses the compact pack as a coverage contract and answers now with the selected evidence. Then it inspects `semantic_entries` to see whether implementation, structure, and tests are sufficiently covered. Only when coverage is still missing does it call `context_expand` with the stable `handle_id`.

---

## context_expand — Reopen Omitted Context

**Agent calls:**
```json
{ "name": "context_expand", "arguments": { "handle_id": "expand:explain:structural:9e7d4c2a11f0", "budget": 900 } }
```

**Agent receives:**
```json
{
  "handle_id": "expand:explain:structural:9e7d4c2a11f0",
  "task": "explain",
  "task_intent": "explain",
  "prompt": "how does payment processing work?",
  "budget": 900,
  "pack": {
    "question": "how does payment processing work?",
    "token_count": 612,
    "matched_nodes": [
      {
        "label": "BillingModule",
        "source_file": "backend/src/modules/billing/billing.module.ts",
        "line_number": 1,
        "snippet": null,
        "match_score": 0,
        "relevance_band": "related",
        "community": 8,
        "community_label": "Backend Billing",
        "evidence_class": "structural"
      }
    ],
    "relationships": [],
    "community_context": [
      { "id": 8, "label": "Backend Billing", "node_count": 23 }
    ]
  },
  "claims": [
    {
      "evidence_class": "structural",
      "text": "structural evidence: BillingModule",
      "node_labels": ["BillingModule"]
    }
  ],
  "missing_context": []
}
```

**What the agent does with this:** Expands only the omitted slice that mattered, without regenerating the whole pack or losing the original task/session context.

---

## context_prompt — Provider-Aware Prompt Compilation

**Agent calls:**
```json
{ "name": "context_prompt", "arguments": { "prompt": "how does payment processing work?", "provider": "claude", "session_id": "billing-thread" } }
```

**Agent receives:**
```json
{
  "provider": "claude",
  "task": "explain",
  "prompt": "how does payment processing work?",
  "graph_path": "graphify-out/graph.json",
  "compiled": {
    "provider": "claude",
    "format": "session_payload",
    "prompt": "Session delta:\n{\n  \"previous_revision\": 6,\n  \"next_revision\": 7,\n  \"added\": [\"billing:transaction-service\"],\n  \"updated\": [\"billing:stripe-gateway\"],\n  \"invalidated\": []\n}\n\nUser question:\nhow does payment processing work?",
    "token_count": 1420,
    "effective_token_count": 914,
    "reused_context_tokens": 506,
    "session_state": {
      "version": 1,
      "revision": 7,
      "refs": {
        "billing:stripe-gateway": { "hash": "8f7b", "token_count": 210 },
        "billing:transaction-service": { "hash": "f1a2", "token_count": 184 }
      }
    },
    "session_id": "billing-thread"
  },
  "claims": [],
  "expandable": [],
  "coverage": {
    "required_evidence": [],
    "entries": [],
    "missing_required": [],
    "available_relationships": 0,
    "selected_relationships": 0
  },
  "missing_context": []
}
```

**What the agent does with this:** Sends the compiled prompt directly to Claude and tracks **effective_token_count** / `reused_context_tokens` as the real effective-cost signal for follow-up turns. For `provider: "gemini"`, the same tool returns `format: "prompt"` with plain prompt text.

---

## context_session_reset — Reset Claude Prompt Cache State

**Agent calls:**
```json
{ "name": "context_session_reset", "arguments": { "session_id": "billing-thread" } }
```

**Agent receives:**
```json
{
  "session_id": "billing-thread",
  "cleared": true
}
```

**What the agent does with this:** Clears the stored Claude prompt session before switching topics so the next `context_prompt` call resends the full stable context instead of a delta.

---

## retrieve — Context Retrieval

**Agent calls:**
```json
{ "name": "retrieve", "arguments": { "question": "how does payment processing work?", "budget": 2000 } }
```

**Agent receives:**
```json
{
  "question": "how does payment processing work?",
  "token_count": 1847,
  "matched_nodes": [
    {
      "label": "StripeGatewayService",
      "source_file": "backend/src/modules/billing/services/stripe-gateway.service.ts",
      "line_number": 15,
      "snippet": "export class StripeGatewayService implements PaymentGateway {\n  constructor(private config: ConfigService) {}\n  async createCheckout(params: CheckoutParams) {...}",
      "match_score": 3,
      "community_label": "Backend Billing"
    },
    {
      "label": "TransactionService",
      "source_file": "backend/src/modules/billing/services/transaction.service.ts",
      "match_score": 2,
      "community_label": "Backend Transaction"
    }
  ],
  "relationships": [
    { "from": "StripeGatewayService", "to": "TransactionService", "relation": "calls" },
    { "from": "TransactionService", "to": "User", "relation": "uses" }
  ],
  "community_context": [
    { "id": 8, "label": "Backend Billing", "node_count": 23 },
    { "id": 12, "label": "Backend Transaction", "node_count": 12 }
  ],
  "graph_signals": {
    "god_nodes": ["User"],
    "bridge_nodes": ["StripeGatewayService"]
  }
}
```

**What the agent does with this:** Answers the question using code evidence, citing specific services and their relationships. No file reading needed.

---

## impact — Blast Radius Analysis

**Agent calls:**
```json
{ "name": "impact", "arguments": { "label": "User", "depth": 2 } }
```

**Agent receives:**
```json
{
  "target": "User",
  "target_file": "backend/src/entities/User.ts",
  "total_affected": 656,
  "direct_dependents": [
    { "label": "AuthGuard", "distance": 1, "relation": "imports_from", "community_label": "Backend Admin Guard" },
    { "label": "UsersService", "distance": 1, "relation": "imports_from", "community_label": "Backend Users Service" }
  ],
  "affected_files": ["admin.guard.ts", "auth.module.ts", "...318 files"],
  "affected_communities": [
    { "id": 0, "label": "Backend Invite", "node_count": 11 },
    { "id": 1, "label": "Backend Admin Guard", "node_count": 8 }
  ]
}
```

**What the agent does with this:** "Refactoring User touches 656 nodes across 318 files and 42 modules. The highest-impact areas are Invite (11 files), Admin Guard (8 files), and Users core (4 files). I recommend an incremental approach."

---

## call_chain — Execution Path Tracing

**Agent calls:**
```json
{ "name": "call_chain", "arguments": { "source": "IdeasController", "target": "PdfGeneratorService" } }
```

**Agent receives:**
```json
{
  "source": "IdeasController",
  "target": "PdfGeneratorService",
  "chains": [
    ["IdeasController", "IdeasService", "GenerationJobsService", "AssemblyService", "PdfGeneratorService"],
    ["IdeasController", "IdeasService", "LangchainOrchestratorService", "AssemblyService", "PdfGeneratorService"]
  ],
  "total": 2
}
```

**What the agent does with this:** "There are 2 execution paths from idea submission to PDF generation. The primary path goes through IdeasService → GenerationJobsService → AssemblyService → PdfGeneratorService. An alternative path uses the LangchainOrchestratorService."

---

## pr_impact — PR Risk Analysis

**Agent calls:**
```json
{ "name": "pr_impact", "arguments": {} }
```

**Agent receives:**
```json
{
  "base_branch": "main",
  "changed_files": ["src/entities/User.ts", "src/modules/auth/auth.service.ts"],
  "changed_ranges": [
    { "source_file": "src/entities/User.ts", "line_ranges": [{ "start": 42, "end": 48 }] },
    { "source_file": "src/modules/auth/auth.service.ts", "line_ranges": [{ "start": 10, "end": 18 }] }
  ],
  "seed_nodes": [
    { "node_id": "user_entity", "label": "User", "community_label": "Backend User", "match_kind": "line" },
    { "node_id": "auth_service", "label": "AuthService", "community_label": "Backend Auth", "match_kind": "line" }
  ],
  "review_context": {
    "supporting_paths": ["src/modules/users/user.repository.ts"],
    "test_paths": ["tests/auth/auth.service.test.ts"],
    "hotspots": [{ "label": "User", "type": "bridge", "why": "User connects multiple communities in the changed review area." }]
  },
  "review_bundle": {
    "budget": 2000,
    "token_count": 512,
    "shared_file_type": "code",
    "nodes": [
      { "node_id": "user_entity", "label": "User", "source_file": "src/entities/User.ts", "line_number": 42, "snippet": "export class User {}", "match_score": 9, "relevance_band": "direct", "community": 7 },
      { "label": "UserRepository", "source_file": "src/modules/users/user.repository.ts", "line_number": 15, "snippet": null, "relevance_band": "related", "community": 8 }
    ],
    "relationships": [
      { "from": "UserRepository", "to": "User", "relation": "uses" }
    ],
    "community_context": [
      { "id": 7, "label": "Backend User", "node_count": 24 }
    ]
  },
  "per_node_impact": [
    { "node": "User", "total_dependents": 656, "affected_communities": 42 },
    { "node": "AuthService", "total_dependents": 57, "affected_communities": 8 }
  ],
  "total_blast_radius": 634,
  "affected_communities": [
    { "id": 7, "label": "Backend User", "node_count": 24 },
    { "id": 8, "label": "Backend Auth", "node_count": 18 }
  ],
  "risk_summary": {
    "high_impact_nodes": ["User", "AuthService"],
    "cross_community_changes": 2,
    "top_risks": [
      { "label": "User", "severity": "high", "reason": "High blast radius across 42 communities." }
    ]
  }
}
```

**What the agent does with this:** "This PR changes 2 line-matched high-impact nodes. The compact review bundle already points at the key supporting file and likely auth test, and `User` is flagged as a bridge hotspot with the largest blast radius. I'd review the user repository path first, then run the auth service tests before merging."

---

## community_details — Module Intelligence

**Agent calls (micro zoom — 50 tokens):**
```json
{ "name": "community_overview", "arguments": {} }
```

**Agent receives:** All 2,244 communities with names, sizes, and top 3 nodes each.

**Agent calls (mid zoom — 200 tokens):**
```json
{ "name": "community_details", "arguments": { "community_id": 8, "zoom": "mid" } }
```

**Agent receives:** Entry points, exit points, bridge nodes, key functions, and dominant file for the Billing community.

**Agent calls (macro zoom — 500 tokens):**
```json
{ "name": "community_details", "arguments": { "community_id": 8, "zoom": "macro" } }
```

**Agent receives:** All nodes, all internal edges, all cross-community edges, and file distribution.

The agent picks the right zoom level based on how much context budget it has left.
