export interface AuditRecord {
  action: string
  requestId: string
  principalId: string
  accountId: string
  entryId: string
  recordedAt: string
}

export class AuditLog {
  private readonly records: AuditRecord[] = []

  record(record: Omit<AuditRecord, 'recordedAt'>): AuditRecord {
    const stored: AuditRecord = { ...record, recordedAt: new Date().toISOString() }
    this.records.push(stored)
    return stored
  }

  listForAccount(accountId: string): AuditRecord[] {
    return this.records.filter((record) => record.accountId === accountId)
  }
}
