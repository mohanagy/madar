export function createInviteContract(email: string) {
  return { email, expiresInMinutes: 30 }
}
