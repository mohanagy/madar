export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  resetToken?: string
}

export class UserRepository {
  private readonly users = new Map<string, UserRecord>([
    ['u-1', { id: 'u-1', email: 'sam@example.test', passwordHash: 'hash:v1' }],
    ['u-2', { id: 'u-2', email: 'lee@example.test', passwordHash: 'hash:v1' }],
  ])

  findUserByEmail(email: string): UserRecord | undefined {
    return [...this.users.values()].find((user) => user.email === email)
  }

  findUserByResetToken(token: string): UserRecord | undefined {
    return [...this.users.values()].find((user) => user.resetToken === token)
  }

  saveResetToken(userId: string, token: string): void {
    const user = this.users.get(userId)
    if (!user) {
      return
    }
    user.resetToken = token
  }

  updatePasswordHash(userId: string, passwordHash: string): void {
    const user = this.users.get(userId)
    if (!user) {
      return
    }
    user.passwordHash = passwordHash
    delete user.resetToken
  }
}

export const userRepository = new UserRepository()
