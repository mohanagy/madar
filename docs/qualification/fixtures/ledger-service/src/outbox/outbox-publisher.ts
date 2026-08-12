export type LedgerEventName = 'ledger.entry.posted' | 'ledger.entry.reversed'

export interface LedgerEvent {
  name: LedgerEventName
  entryId: string
  accountId: string
  amountMinor: number
  currency: string
  publishedAt: string
}

export type LedgerEventHandler = (event: LedgerEvent) => void

/**
 * The only path by which ledger state leaves the write model. Every downstream
 * read model is rebuilt from these events, so dropping a publish silently
 * desynchronizes consumers rather than raising an error.
 */
export class OutboxPublisher {
  private readonly handlers = new Map<LedgerEventName, LedgerEventHandler[]>()

  subscribe(name: LedgerEventName, handler: LedgerEventHandler): void {
    const existing = this.handlers.get(name) ?? []
    this.handlers.set(name, [...existing, handler])
  }

  publish(event: Omit<LedgerEvent, 'publishedAt'>): LedgerEvent {
    const published: LedgerEvent = { ...event, publishedAt: new Date().toISOString() }
    for (const handler of this.handlers.get(published.name) ?? []) {
      handler(published)
    }
    return published
  }
}
