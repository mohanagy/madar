import { AuthService } from '../services/auth-service.js'

export class AuthController {
  constructor(private readonly authService = new AuthService()) {}

  async login(input: { email: string }) {
    return this.authService.login(input)
  }
}
