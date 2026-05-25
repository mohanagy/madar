import { describe, expect, it } from 'vitest'

import { createUserRoute } from '../../src/routes/user-routes.js'

describe('createUserRoute', () => {
  it('creates a user after schema validation', () => {
    expect(createUserRoute({ email: 'sam@example.test', displayName: 'Sam' })).toEqual({
      id: 'sam@example.test',
      displayName: 'Sam',
    })
  })
})
