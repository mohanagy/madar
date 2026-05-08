import { describe, expect, it } from 'vitest'

import { buildContextPrompt } from '../../src/infrastructure/context-prompt.js'

describe('context prompt', () => {
  it('orders stable prefix refs deterministically and keeps task text in the dynamic suffix', () => {
    const prompt = buildContextPrompt({
      instructions: [
        'Answer using only the provided context.',
        'If the context does not contain the answer, say so.',
      ],
      stable_sections: [
        {
          ref: 'relationships',
          title: 'Relationships',
          body: '- authenticateUser -[calls]-> SessionManager',
        },
        {
          ref: 'matched_nodes',
          title: 'Matched nodes',
          body: '- authenticateUser\n- SessionManager',
        },
      ],
      dynamic_sections: [
        {
          title: 'Question',
          body: 'how does login create a session',
        },
        {
          body: 'Answer:',
        },
      ],
    })

    expect(prompt.ordered_stable_refs).toEqual(['matched_nodes', 'relationships'])
    expect(prompt.prompt.indexOf('Matched nodes:')).toBeLessThan(prompt.prompt.indexOf('Relationships:'))
    expect(prompt.prompt.indexOf('Question:\nhow does login create a session')).toBeGreaterThan(
      prompt.prompt.indexOf('Relationships:'),
    )
  })

  it('emits delta-only session payloads after a previous prompt pack', () => {
    const initial = buildContextPrompt({
      instructions: ['Answer using only the provided context.'],
      stable_sections: [
        { ref: 'alpha', title: 'Alpha', body: 'AuthService' },
        { ref: 'beta', title: 'Beta', body: 'SessionStore' },
        { ref: 'gamma', title: 'Gamma', body: 'SessionManager' },
      ],
      dynamic_sections: [
        { title: 'Question', body: 'first question' },
        { body: 'Answer:' },
      ],
    })

    const followUp = buildContextPrompt({
      instructions: ['Answer using only the provided context.'],
      stable_sections: [
        { ref: 'alpha', title: 'Alpha', body: 'AuthService v2' },
        { ref: 'gamma', title: 'Gamma', body: 'SessionManager' },
        { ref: 'delta', title: 'Delta', body: 'AuditLogger' },
      ],
      dynamic_sections: [
        { title: 'Question', body: 'second question' },
        { body: 'Answer:' },
      ],
      session: initial.session_state,
    })

    expect(followUp.session_delta.added.map((entry) => entry.ref)).toEqual(['delta'])
    expect(followUp.session_delta.updated.map((entry) => entry.ref)).toEqual(['alpha'])
    expect(followUp.session_delta.invalidated).toEqual(['beta'])
    expect(followUp.session_delta.reused_refs).toEqual(['__stable_prefix:instructions', 'gamma'])
    expect(followUp.session_payload).not.toContain('Gamma:\nSessionManager')
    expect(followUp.session_payload).toContain('"invalidated": [\n    "beta"\n  ]')
    expect(followUp.metrics.reused_context_tokens).toBeGreaterThan(0)
    expect(followUp.metrics.effective_prompt_tokens).toBeLessThan(followUp.metrics.raw_prompt_tokens)
  })

  it('counts the full stable prefix as reused when only the dynamic suffix changes', () => {
    const initial = buildContextPrompt({
      instructions: ['Answer using only the provided context.', 'Be concise.'],
      stable_prefix_title: 'Retrieved graph context',
      stable_sections: [{ ref: 'alpha', title: 'Alpha', body: 'AuthService' }],
      dynamic_sections: [
        { title: 'Question', body: 'first question' },
        { body: 'Answer:' },
      ],
    })

    const followUp = buildContextPrompt({
      instructions: ['Answer using only the provided context.', 'Be concise.'],
      stable_prefix_title: 'Retrieved graph context',
      stable_sections: [{ ref: 'alpha', title: 'Alpha', body: 'AuthService' }],
      dynamic_sections: [
        { title: 'Question', body: 'second question' },
        { body: 'Answer:' },
      ],
      session: initial.session_state,
    })

    expect(followUp.metrics.reused_context_tokens).toBe(followUp.metrics.stable_prefix_tokens)
    expect(followUp.session_payload).toContain('Question:\nsecond question')
    expect(followUp.session_payload).not.toContain('Retrieved graph context:')
  })

  it('emits instruction and stable-prefix title updates in follow-up session payloads', () => {
    const initial = buildContextPrompt({
      instructions: ['Answer using only the provided context.'],
      stable_prefix_title: 'Retrieved graph context',
      stable_sections: [{ ref: 'alpha', title: 'Alpha', body: 'AuthService' }],
      dynamic_sections: [
        { title: 'Question', body: 'first question' },
        { body: 'Answer:' },
      ],
    })

    const followUp = buildContextPrompt({
      instructions: ['Answer using only the provided context.', 'Use one sentence.'],
      stable_prefix_title: 'Updated graph context',
      stable_sections: [{ ref: 'alpha', title: 'Alpha', body: 'AuthService' }],
      dynamic_sections: [
        { title: 'Question', body: 'second question' },
        { body: 'Answer:' },
      ],
      session: initial.session_state,
    })

    expect(followUp.session_payload).toContain('Use one sentence.')
    expect(followUp.session_payload).toContain('Updated graph context')
    expect(followUp.session_payload).not.toContain('Alpha:\nAuthService')
  })
})
