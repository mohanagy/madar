export interface LedgerEntry {
  entryId: string
  accountId: string
  amountMinor: number
  currency: string
  reversalOfEntryId: string | null
  createdAt: string
}

export interface AppendLedgerEntryInput {
  accountId: string
  amountMinor: number
  currency: string
  reversalOfEntryId?: string | null
}

/**
 * Append-only entry log. Balances are never stored here; they are derived by
 * `projections/balance-projection.ts` from published outbox events.
 */
export class LedgerStore {
  private readonly entries = new Map<string, LedgerEntry>()
  private sequence = 0

  appendEntry(input: AppendLedgerEntryInput): LedgerEntry {
    this.sequence += 1
    const entry: LedgerEntry = {
      entryId: `led_${this.sequence.toString().padStart(8, '0')}`,
      accountId: input.accountId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      reversalOfEntryId: input.reversalOfEntryId ?? null,
      createdAt: new Date().toISOString(),
    }
    this.entries.set(entry.entryId, entry)
    return entry
  }

  findEntry(entryId: string): LedgerEntry | undefined {
    return this.entries.get(entryId)
  }

  listEntriesForAccount(accountId: string): LedgerEntry[] {
    return [...this.entries.values()].filter((entry) => entry.accountId === accountId)
  }
}
