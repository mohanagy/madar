import { UserRepository } from './repository.js'

export class UserService {
  constructor(private readonly repository = new UserRepository()) {}

  async loadProfile(input: { accountId: string; userId: string }) {
    return this.repository.findOwnedUser(input)
  }
}
