export interface PasswordResetPort {
  requestPasswordReset(email: string): { queued: boolean; token: string | null }
  completePasswordReset(token: string, passwordHash: string): boolean
}

export function createAccountRoutes(passwordReset: PasswordResetPort) {
  return {
    requestPasswordReset(email: string) {
      return passwordReset.requestPasswordReset(email)
    },
    completePasswordReset(token: string, passwordHash: string) {
      return passwordReset.completePasswordReset(token, passwordHash)
    },
  }
}
