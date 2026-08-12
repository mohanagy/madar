# `ledger-service` qualification fixture

A small TypeScript/Node accounting-ledger service used as a qualification target.

This workspace exists **only** as an evaluation target. It is not shipped in the npm
package, is not imported by `src/`, and must never be referenced by production
retrieval or context logic.

## Shape

```text
POST /accounts/:accountId/entries        -> postLedgerEntry
POST /entries/:entryId/reversals         -> reverseLedgerEntry

http/ledger-routes.ts
  -> auth/request-context.ts             (principal resolution)
  -> service/ledger-service.ts           (command service)
       -> store/idempotency-store.ts     (retry suppression)
       -> store/ledger-store.ts          (append-only entries)
       -> outbox/outbox-publisher.ts     (ledger.entry.posted)
       -> audit/audit-log.ts             (audit trail)
outbox/outbox-publisher.ts
  -> projections/balance-projection.ts   (ledger.entry.posted consumer)
```

## Deliberate defects

Two defects are seeded on purpose and are part of the frozen truth. Do not fix them.

| Id | Site | Nature |
| --- | --- | --- |
| `seeded-idempotency-ordering` | `src/service/ledger-service.ts` | The idempotency key is reserved **after** the ledger append, so a concurrent retry appends a duplicate entry. |
| `seeded-reversal-authorization` | `src/http/ledger-routes.ts` | The reversal route never checks the entry's account against `principal.accountIds`, so any authenticated principal can reverse another tenant's entry. |

## Authoring provenance

Authored for issue #655 on 2026-08-12 from a blank file. No Madar output, retrieval
result, context pack, or `implementationGuidance` was consulted while writing this
workspace or the truth files derived from it.
