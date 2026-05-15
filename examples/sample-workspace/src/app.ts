import { sendPasswordResetEmail } from './notifications/email-gateway.js'
import { userRepository } from './persistence/user-repository.js'
import { createAccountRoutes } from './routes/account-routes.js'
import { createPasswordResetService } from './services/password-reset-service.js'

const passwordResetService = createPasswordResetService({
  userRepository,
  sendPasswordResetEmail,
})

export const accountRoutes = createAccountRoutes(passwordResetService)

export function requestPasswordReset(email: string) {
  return accountRoutes.requestPasswordReset(email)
}

export function completePasswordReset(token: string, passwordHash: string) {
  return accountRoutes.completePasswordReset(token, passwordHash)
}
