import { describe, expect, it } from 'vitest'

import { updateProfile } from '../../src/profile/update-profile.js'

describe('updateProfile', () => {
  it('keeps source and test adjacency obvious', () => {
    expect(updateProfile({ displayName: 'Sam' })).toEqual({ displayName: 'Sam' })
  })
})
