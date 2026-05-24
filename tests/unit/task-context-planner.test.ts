import type { TaskContextPlan } from '../../src/contracts/task-context-plan.js'
import { buildTaskContextPlan } from '../../src/runtime/task-context-planner.js'

describe('task-context-planner', () => {
  it('builds a stable explain plan with normalized focus scope', () => {
    const expected: TaskContextPlan = {
      version: 1,
      task_kind: 'explain',
      prompt: 'Explain auth flow',
      total_budget: 1200,
      scope: {
        seed_mode: 'focused',
        focus_paths: ['src/api.ts', 'src/auth.ts', 'src/router.ts'],
        changed_paths: [],
      },
      evidence: {
        recipe_id: 'explain',
        required: ['primary', 'supporting', 'structural'],
        preferred: ['primary', 'supporting', 'structural'],
        semantic_required: ['implementation', 'structure'],
        semantic_optional: ['contracts', 'configuration', 'tests'],
      },
      steps: [
        {
          id: 'seed',
          kind: 'retrieve',
          title: 'Collect primary evidence',
          budget: 420,
          evidence: ['primary'],
          scope_mode: 'focused',
          scope_paths: ['src/api.ts', 'src/auth.ts', 'src/router.ts'],
        },
        {
          id: 'expand',
          kind: 'retrieve',
          title: 'Expand supporting context',
          budget: 480,
          evidence: ['supporting', 'structural'],
          scope_mode: 'focused',
          scope_paths: ['src/api.ts', 'src/auth.ts', 'src/router.ts'],
        },
        {
          id: 'assemble',
          kind: 'synthesize',
          title: 'Assemble final context',
          budget: 300,
          evidence: ['primary', 'supporting', 'structural'],
          scope_mode: 'focused',
          scope_paths: ['src/api.ts', 'src/auth.ts', 'src/router.ts'],
        },
      ],
    }

    const plan = buildTaskContextPlan({
      task_kind: 'explain',
      prompt: '  Explain auth flow  ',
      budget: 1200,
      focus_paths: ['src/auth.ts', '', 'src/api.ts', 'src/auth.ts', ' src/router.ts '],
    })

    expect(plan).toEqual(expected)
    expect(JSON.parse(JSON.stringify(plan))).toEqual(expected)
  })

  it('prioritizes changed files for review planning while widening later steps', () => {
    const plan = buildTaskContextPlan({
      task_kind: 'review',
      prompt: 'Review auth changes',
      budget: 95,
      focus_paths: ['tests/auth.test.ts', 'src/auth.ts', 'tests/auth.test.ts'],
      changed_paths: ['src/auth.ts', 'src/api.ts', 'src/api.ts'],
    })

    expect(plan.scope).toEqual({
      seed_mode: 'changed',
      focus_paths: ['src/auth.ts', 'tests/auth.test.ts'],
      changed_paths: ['src/api.ts', 'src/auth.ts'],
    })
    expect(plan.evidence).toEqual({
      recipe_id: 'review',
      required: ['change', 'supporting', 'impact'],
      preferred: ['change', 'supporting', 'impact', 'structural', 'primary'],
      semantic_required: ['changes', 'impact'],
      semantic_optional: ['tests', 'configuration', 'contracts'],
    })
    expect(plan.steps).toEqual([
      {
        id: 'seed',
        kind: 'retrieve',
        title: 'Collect changed evidence',
        budget: 47,
        evidence: ['change'],
        scope_mode: 'changed',
        scope_paths: ['src/api.ts', 'src/auth.ts'],
      },
      {
        id: 'expand',
        kind: 'retrieve',
        title: 'Expand review context',
        budget: 28,
        evidence: ['supporting', 'impact', 'structural'],
        scope_mode: 'focused',
        scope_paths: ['src/api.ts', 'src/auth.ts', 'tests/auth.test.ts'],
      },
      {
        id: 'assemble',
        kind: 'synthesize',
        title: 'Assemble review context',
        budget: 20,
        evidence: ['change', 'supporting', 'impact'],
        scope_mode: 'focused',
        scope_paths: ['src/api.ts', 'src/auth.ts', 'tests/auth.test.ts'],
      },
    ])
    expect(plan.steps.reduce((total, step) => total + step.budget, 0)).toBe(95)
  })

  it('falls back to primary review evidence when focus paths exist without changed paths', () => {
    const plan = buildTaskContextPlan({
      task_kind: 'review',
      prompt: 'Review auth modules',
      budget: 95,
      focus_paths: ['tests/auth.test.ts', 'src/auth.ts', 'tests/auth.test.ts'],
    })

    expect(plan.scope).toEqual({
      seed_mode: 'focused',
      focus_paths: ['src/auth.ts', 'tests/auth.test.ts'],
      changed_paths: [],
    })
    expect(plan.evidence).toEqual({
      recipe_id: 'review',
      required: ['primary', 'supporting', 'impact'],
      preferred: ['primary', 'supporting', 'impact', 'structural'],
      semantic_required: ['implementation', 'impact'],
      semantic_optional: ['tests', 'configuration', 'contracts'],
    })
    expect(plan.steps).toEqual([
      {
        id: 'seed',
        kind: 'retrieve',
        title: 'Collect primary review evidence',
        budget: 47,
        evidence: ['primary'],
        scope_mode: 'focused',
        scope_paths: ['src/auth.ts', 'tests/auth.test.ts'],
      },
      {
        id: 'expand',
        kind: 'retrieve',
        title: 'Expand review context',
        budget: 28,
        evidence: ['supporting', 'impact', 'structural'],
        scope_mode: 'focused',
        scope_paths: ['src/auth.ts', 'tests/auth.test.ts'],
      },
      {
        id: 'assemble',
        kind: 'synthesize',
        title: 'Assemble review context',
        budget: 20,
        evidence: ['primary', 'supporting', 'impact'],
        scope_mode: 'focused',
        scope_paths: ['src/auth.ts', 'tests/auth.test.ts'],
      },
    ])
  })

  it('falls back to global scope for impact planning without explicit paths', () => {
    const plan = buildTaskContextPlan({
      task_kind: 'impact',
      prompt: 'Map auth blast radius',
      budget: 40,
    })

    expect(plan.scope).toEqual({
      seed_mode: 'global',
      focus_paths: [],
      changed_paths: [],
    })
    expect(plan.steps).toEqual([
      expect.objectContaining({
        id: 'seed',
        budget: 12,
        evidence: ['primary'],
        scope_mode: 'global',
        scope_paths: [],
      }),
      expect.objectContaining({
        id: 'expand',
        budget: 18,
        evidence: ['impact', 'structural', 'supporting'],
        scope_mode: 'global',
        scope_paths: [],
      }),
      expect.objectContaining({
        id: 'assemble',
        budget: 10,
        evidence: ['primary', 'impact', 'structural'],
        scope_mode: 'global',
        scope_paths: [],
      }),
    ])
  })

  it('uses an implementation recipe for test-generation prompts', () => {
    const plan = buildTaskContextPlan({
      task_kind: 'implement',
      prompt: 'Generate regression tests for token refresh and session expiry.',
      budget: 90,
      focus_paths: ['src/auth.ts', 'tests/auth.test.ts'],
    })

    expect(plan.evidence).toEqual({
      recipe_id: 'test-generation',
      required: ['primary', 'supporting', 'structural'],
      preferred: ['primary', 'structural', 'supporting', 'change', 'impact'],
      semantic_required: ['implementation', 'tests', 'structure'],
      semantic_optional: ['contracts', 'configuration'],
    })
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'seed',
        title: 'Collect implementation anchors',
        evidence: ['primary', 'structural'],
      }),
      expect.objectContaining({
        id: 'expand',
        title: 'Expand implementation context',
        evidence: ['supporting', 'structural', 'change'],
      }),
      expect.objectContaining({
        id: 'assemble',
        title: 'Assemble implementation context',
        evidence: ['primary', 'supporting', 'structural'],
      }),
    ]))
  })

  it('uses a security-review recipe that prioritizes impact evidence during review planning', () => {
    const plan = buildTaskContextPlan({
      task_kind: 'review',
      prompt: 'Audit the password reset flow for injection and auth bypass issues.',
      budget: 90,
      changed_paths: ['src/auth.ts'],
      focus_paths: ['src/auth.ts', 'src/reset.ts'],
    })

    expect(plan.evidence).toEqual({
      recipe_id: 'security-review',
      required: ['change', 'impact', 'supporting'],
      preferred: ['change', 'impact', 'supporting', 'primary', 'structural'],
      semantic_required: ['changes', 'impact', 'configuration'],
      semantic_optional: ['tests', 'contracts'],
    })
    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'seed',
        scope_mode: 'changed',
        evidence: ['change', 'impact'],
      }),
      expect.objectContaining({
        id: 'expand',
        evidence: ['impact', 'supporting', 'primary'],
      }),
      expect.objectContaining({
        id: 'assemble',
        evidence: ['change', 'impact', 'supporting'],
      }),
    ]))
  })

  it('guarantees a non-zero budget for each planning step at the minimum supported budget', () => {
    const reviewPlan = buildTaskContextPlan({
      task_kind: 'review',
      prompt: 'Review auth changes',
      budget: 3,
    })
    const impactPlan = buildTaskContextPlan({
      task_kind: 'impact',
      prompt: 'Map auth blast radius',
      budget: 3,
    })

    expect(reviewPlan.steps.map((step) => step.budget)).toEqual([1, 1, 1])
    expect(impactPlan.steps.map((step) => step.budget)).toEqual([1, 1, 1])
  })

  it('rejects empty prompts and undersized budgets', () => {
    expect(() => buildTaskContextPlan({
      task_kind: 'impact',
      prompt: '   ',
      budget: 32,
    })).toThrow('Task context planning prompt is required')

    expect(() => buildTaskContextPlan({
      task_kind: 'impact',
      prompt: 'Map auth blast radius',
      budget: 2,
    })).toThrow('Task context planning budget must be at least 3')
  })
})
