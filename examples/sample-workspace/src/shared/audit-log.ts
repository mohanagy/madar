export function recordAuditEvent(eventName: string, userId: string): string {
  return `${eventName}:${userId}`
}
