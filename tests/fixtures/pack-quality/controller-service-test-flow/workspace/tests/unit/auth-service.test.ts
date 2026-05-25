import { describe, expect, it } from 'vitest'

import { AuthService } from '../../src/services/auth-service.js'

describe('AuthService.login', () => {
  it('creates a session for the login flow', async () => {
    const service = new AuthService()

    await expect(service.login({ email: 'sam@example.test' })).resolves.toEqual({
      sessionId: 'session:sam@example.test',
    })
  })
})
