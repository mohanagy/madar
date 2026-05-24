import { describe, expect, it } from 'vitest'

import {
  classifyTaskApplicability,
  formatTaskApplicabilityDebugMessage,
} from '../../src/runtime/task-applicability.js'

describe('task-applicability', () => {
  it('skips GitHub Projects roadmap review prompts', () => {
    const classification = classifyTaskApplicability(
      'I need you to access https://github.com/users/mohanagy/projects/9/views/3 and to review the roadmap, do not take any action for now',
    )

    expect(classification.needs_local_code_context).toBe(false)
    expect(classification.reason).toBe('github_project')
  })

  it('skips external setup and package-registry tasks', () => {
    expect(classifyTaskApplicability('Help me run gh auth login and gh project view setup').reason)
      .toBe('auth_setup')
    expect(classifyTaskApplicability('Review the Socket.dev alert for @lubab/madar').reason)
      .toBe('package_registry')
  })

  it('keeps Madar enabled for local code explain, implement, debug, test, review, and refactor tasks', () => {
    expect(classifyTaskApplicability('Explain how the context pack is assembled in this repo'))
      .toEqual(expect.objectContaining({ needs_local_code_context: true, reason: 'explain' }))
    expect(classifyTaskApplicability('Implement issue #275 by collecting implementation context for changed files'))
      .toEqual(expect.objectContaining({ needs_local_code_context: true, reason: 'implement' }))
    expect(classifyTaskApplicability('Trace why refresh token rotation started failing after the latest auth change'))
      .toEqual(expect.objectContaining({ needs_local_code_context: true, reason: 'debug' }))
    expect(classifyTaskApplicability('Write regression tests for parseConfig and session expiry'))
      .toEqual(expect.objectContaining({ needs_local_code_context: true, reason: 'test' }))
    expect(classifyTaskApplicability('Review this PR diff for risky auth regressions before merge'))
      .toEqual(expect.objectContaining({ needs_local_code_context: true, reason: 'review' }))
    expect(classifyTaskApplicability('Refactor the session cache module without changing behavior'))
      .toEqual(expect.objectContaining({ needs_local_code_context: true, reason: 'refactor' }))
  })

  it('formats a human-readable debug skip message', () => {
    const classification = classifyTaskApplicability(
      'Review the Product Hunt launch copy and marketing headline for tomorrow',
    )

    expect(formatTaskApplicabilityDebugMessage(classification))
      .toBe('Skipped Madar: task is marketing copy review, not local codebase context.')
  })
})
