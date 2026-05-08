import { describe, expect, it } from 'vitest'

import { buildContextSession } from '../../src/runtime/context-session.js'

describe('context session', () => {
  it('sums reused token counts from stored per-ref token counts', () => {
    const initial = buildContextSession([
      { ref: 'alpha', content: 'AuthService', token_count: 101 },
      { ref: 'beta', content: 'SessionManager', token_count: 202 },
    ], undefined)

    const followUp = buildContextSession([
      { ref: 'beta', content: 'SessionManager', token_count: 202 },
      { ref: 'alpha', content: 'AuthService', token_count: 101 },
    ], initial.session_state)

    expect(followUp.session_delta.reused_refs).toEqual(['alpha', 'beta'])
    expect(followUp.session_delta.reused_token_count).toBe(303)
  })

  it('keeps reused token counts anchored to the previous session state', () => {
    const initial = buildContextSession([
      { ref: 'alpha', content: 'AuthService', token_count: 101 },
    ], undefined)

    const followUp = buildContextSession([
      { ref: 'alpha', content: 'AuthService', token_count: 999 },
    ], initial.session_state)

    expect(followUp.session_delta.reused_refs).toEqual(['alpha'])
    expect(followUp.session_delta.reused_token_count).toBe(101)
  })
})
