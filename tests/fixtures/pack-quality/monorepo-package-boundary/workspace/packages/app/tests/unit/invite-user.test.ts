import { describe, expect, it } from 'vitest'

import { inviteUser } from '../../src/commands/invite-user.js'

describe('inviteUser', () => {
  it('creates an invite across package boundaries', () => {
    expect(inviteUser('sam@example.test')).toEqual({
      email: 'sam@example.test',
      expiresInMinutes: 30,
    })
  })
})
