import type { AuditLog } from '../audit/audit-log.js'
import type { RequestContext } from '../auth/request-context.js'
import type { OutboxPublisher } from '../outbox/outbox-publisher.js'
import type { IdempotencyStore } from '../store/idempotency-store.js'
import type { LedgerEntry, LedgerStore } from '../store/ledger-store.js'

export interface PostEntryCommand {
  accountId: string
  amountMinor: number
  currency: string
  idempotencyKey: string
}

export interface ReverseEntryCommand {
  entryId: string
  idempotencyKey: string
}

export class UnknownEntryError extends Error {
  constructor(entryId: string) {
    super(`ledger entry ${entryId} does not exist`)
    this.name = 'UnknownEntryError'
  }
}

export interface LedgerServiceDependencies {
  ledgerStore: LedgerStore
  idempotencyStore: IdempotencyStore
  outboxPublisher: OutboxPublisher
  auditLog: AuditLog
}

export class LedgerService {
  constructor(private readonly deps: LedgerServiceDependencies) {}

  postEntry(context: RequestContext, command: PostEntryCommand): LedgerEntry {
    const replay = this.deps.idempotencyStore.find(command.idempotencyKey)
    if (replay) {
      const existing = this.deps.ledgerStore.findEntry(replay.entryId)
      if (existing) {
        return existing
      }
    }

    const entry = this.deps.ledgerStore.appendEntry({
      accountId: command.accountId,
      amountMinor: command.amountMinor,
      currency: command.currency,
    })

    // seeded-idempotency-ordering: the reservation is written only after the
    // append succeeds, so a retry that arrives between the read above and this
    // line appends a second entry for the same idempotency key.
    this.deps.idempotencyStore.reserve(command.idempotencyKey, entry.entryId)

    this.deps.outboxPublisher.publish({
      name: 'ledger.entry.posted',
      entryId: entry.entryId,
      accountId: entry.accountId,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
    })

    this.deps.auditLog.record({
      action: 'ledger.entry.posted',
      requestId: context.requestId,
      principalId: context.principal.principalId,
      accountId: entry.accountId,
      entryId: entry.entryId,
    })

    return entry
  }

  reverseEntry(context: RequestContext, command: ReverseEntryCommand): LedgerEntry {
    const original = this.deps.ledgerStore.findEntry(command.entryId)
    if (!original) {
      throw new UnknownEntryError(command.entryId)
    }

    const replay = this.deps.idempotencyStore.find(command.idempotencyKey)
    if (replay) {
      const existing = this.deps.ledgerStore.findEntry(replay.entryId)
      if (existing) {
        return existing
      }
    }

    const reversal = this.deps.ledgerStore.appendEntry({
      accountId: original.accountId,
      amountMinor: -original.amountMinor,
      currency: original.currency,
      reversalOfEntryId: original.entryId,
    })

    this.deps.idempotencyStore.reserve(command.idempotencyKey, reversal.entryId)

    this.deps.outboxPublisher.publish({
      name: 'ledger.entry.reversed',
      entryId: reversal.entryId,
      accountId: reversal.accountId,
      amountMinor: original.amountMinor,
      currency: reversal.currency,
    })

    this.deps.auditLog.record({
      action: 'ledger.entry.reversed',
      requestId: context.requestId,
      principalId: context.principal.principalId,
      accountId: reversal.accountId,
      entryId: reversal.entryId,
    })

    return reversal
  }

  findEntryForAuthorization(entryId: string): LedgerEntry | undefined {
    return this.deps.ledgerStore.findEntry(entryId)
  }
}
