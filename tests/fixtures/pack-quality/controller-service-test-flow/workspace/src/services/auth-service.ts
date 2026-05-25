import { createSession } from '../persistence/session-store.js'

export class AuthService {
  async login(input: { email: string }) {
    return createSession(input.email)
  }
}
