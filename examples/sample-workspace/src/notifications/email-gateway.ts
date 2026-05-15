export function sendPasswordResetEmail(email: string, resetLink: string) {
  return {
    delivered: email.length > 0 && resetLink.length > 0,
    channel: 'email' as const,
  }
}
