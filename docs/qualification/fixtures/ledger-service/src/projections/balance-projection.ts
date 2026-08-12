import type { LedgerEvent, OutboxPublisher } from '../outbox/outbox-publisher.js'

export interface AccountBalance {
  accountId: string
  currency: string
  balanceMinor: number
  lastEntryId: string | null
}

/**
 * Derived read model. It has no access to `LedgerStore`; its only input is the
 * `ledger.entry.posted` / `ledger.entry.reversed` stream from `OutboxPublisher`.
 */
export class BalanceProjection {
  private readonly balances = new Map<string, AccountBalance>()

  attach(publisher: OutboxPublisher): void {
    publisher.subscribe('ledger.entry.posted', (event) => this.applyPosted(event))
    publisher.subscribe('ledger.entry.reversed', (event) => this.applyReversed(event))
  }

  balanceFor(accountId: string): AccountBalance | undefined {
    return this.balances.get(accountId)
  }

  private applyPosted(event: LedgerEvent): void {
    const current = this.balances.get(event.accountId)
    this.balances.set(event.accountId, {
      accountId: event.accountId,
      currency: event.currency,
      balanceMinor: (current?.balanceMinor ?? 0) + event.amountMinor,
      lastEntryId: event.entryId,
    })
  }

  private applyReversed(event: LedgerEvent): void {
    const current = this.balances.get(event.accountId)
    this.balances.set(event.accountId, {
      accountId: event.accountId,
      currency: event.currency,
      balanceMinor: (current?.balanceMinor ?? 0) - event.amountMinor,
      lastEntryId: event.entryId,
    })
  }
}
