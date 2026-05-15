import { randomUUID } from 'node:crypto'

import { enqueueResetEmailJob } from '../jobs/reset-email-job.js'
import type { UserRepository } from '../persistence/user-repository.js'
import { recordAuditEvent } from '../shared/audit-log.js'

export interface PasswordResetDependencies {
  userRepository: UserRepository
  sendPasswordResetEmail: (email: string, resetLink: string) => { delivered: boolean; channel: 'email' }
}

export class PasswordResetService {
  constructor(private readonly dependencies: PasswordResetDependencies) {}

  requestPasswordReset(email: string): { queued: boolean } {
    const user = this.dependencies.userRepository.findUserByEmail(email)
    if (!user) {
      return { queued: false }
    }

    const token = randomUUID()
    this.dependencies.userRepository.saveResetToken(user.id, token)
    enqueueResetEmailJob({
      email: user.email,
      token,
      sendPasswordResetEmail: this.dependencies.sendPasswordResetEmail,
    })
    recordAuditEvent('password-reset-requested', user.id)

    return { queued: true }
  }

  completePasswordReset(token: string, passwordHash: string): boolean {
    const user = this.dependencies.userRepository.findUserByResetToken(token)
    if (!user) {
      return false
    }

    this.dependencies.userRepository.updatePasswordHash(user.id, passwordHash)
    recordAuditEvent('password-reset-completed', user.id)
    return true
  }
}

export function createPasswordResetService(dependencies: PasswordResetDependencies): PasswordResetService {
  return new PasswordResetService(dependencies)
}
