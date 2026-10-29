import { describe, expect, it } from 'vitest'
import { classifyTaskContract } from '../../src/runtime/context-pack.js'
import { buildTaskContextPlan } from '../../src/runtime/task-context-planner.js'

function sourceContract(prompt: string) {
  return classifyTaskContract('review', { budget: 3000, prompt, task_intent: 'source-review' })
}

describe('existing-source review contract', () => {
  it.each([
    'Review sealReceipt together with isRetryable.',
    'Use only source, tests, configuration, and root README.md. Review sealReceipt.',
    'Review sealReceipt, ignore tests and configuration.',
    'Review sealReceipt in impact.ts. Do not run tests.',
  ])('requires delivered source without inventing change or supporting evidence: %s', prompt => {
    const contract = sourceContract(prompt)
    expect(contract.required_evidence).toEqual(['primary'])
    expect(contract.semantic_required).toEqual(['implementation'])
    const plan = buildTaskContextPlan({ task_kind: 'review', task_intent: 'source-review', prompt, budget: 3000 })
    expect(plan.evidence.required).toEqual(contract.required_evidence)
    expect(plan.evidence.semantic_required).toEqual(contract.semantic_required)
  })

  it.each([
    ['Review sealReceipt and its tests.', 'tests'],
    ['Review sealReceipt and its configuration.', 'configuration'],
    ['Review sealReceipt and its interface contracts.', 'contracts'],
    ['Review sealReceipt and its downstream callers.', 'impact'],
  ])('keeps explicitly requested semantic evidence: %s', (prompt, category) => {
    expect(sourceContract(prompt).semantic_required).toContain(category)
  })

  it('keeps requested dependencies and impact while leaving specialized and Git review recipes intact', () => {
    expect(sourceContract('Review sealReceipt and its dependencies.').required_evidence).toContain('supporting')
    expect(sourceContract('Review sealReceipt and its blast radius.').required_evidence).toContain('impact')
    for (const task_intent of ['review', 'pr-review-risk', 'security-review'] as const) {
      const contract = classifyTaskContract('review', { budget: 3000, task_intent, prompt: 'Review sealReceipt.' })
      expect(contract.required_evidence).toEqual(expect.arrayContaining(['change', 'impact', 'supporting']))
      expect(contract.semantic_required).toEqual(expect.arrayContaining(['changes', 'impact']))
    }
  })
})
