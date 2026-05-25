export function createSession(email: string) {
  return { sessionId: `session:${email}` }
}
