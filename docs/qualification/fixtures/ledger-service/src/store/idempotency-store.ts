export interface IdempotencyRecord {
  key: string
  entryId: string
  reservedAt: string
}

/**
 * Suppresses duplicate command execution for retried requests.
 *
 * `reserve` is intended to be called *before* any state mutation so a concurrent
 * retry loses the race and replays the stored result instead of mutating again.
 */
export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>()

  find(key: string): IdempotencyRecord | undefined {
    return this.records.get(key)
  }

  reserve(key: string, entryId: string): IdempotencyRecord {
    const existing = this.records.get(key)
    if (existing) {
      return existing
    }

    const record: IdempotencyRecord = {
      key,
      entryId,
      reservedAt: new Date().toISOString(),
    }
    this.records.set(key, record)
    return record
  }
}
