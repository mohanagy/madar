import { describe, expect, it } from 'vitest'

import {
  planQuestion,
} from '../../src/domain/query/plan.js'
import type {
  NormalizedRetrieveRequest, QuestionPlanResult, QueryPlan,
} from '../../src/domain/query/types.js'

function plan(question: string, budget = 4000): QueryPlan {
  const result = planQuestion({ question, budget })
  if (result.status !== 'supported') {
    throw new Error(`Expected a supported plan, received ${result.reason}`)
  }
  return result.plan
}

function unsupported(question: string): Extract<QuestionPlanResult, { status: 'unsupported' }> {
  const result = planQuestion({ question, budget: 4000 })
  if (result.status !== 'unsupported') {
    throw new Error(`Expected an unsupported plan, received ${result.plan.intent}`)
  }
  return result
}

describe('planQuestion', () => {
  it('keeps locators subject-only', () => {
    expect(plan('Where is `pipelineState` written?')).toEqual({
      intent: 'locate',
      subject: 'pipeline state',
      terms: ['pipeline', 'state'],
      access: 'write',
      obligations: [
        { id: 'o1', kind: 'subject', target: 'pipeline state', mandatory: true },
      ],
    })
  })

  it('preserves action-shaped words inside captured identifier subjects', () => {
    expect(plan('Where is handleClick defined?').subject).toBe('handle click')
    expect(plan('Where is updateIndex defined?').subject).toBe('update index')
    expect(plan('Where is generateIdeaReport defined?').subject).toBe('generate idea report')
    expect(plan('Where is generateFromProblem defined?').subject).toBe('generate problem')
  })

  it('keeps an explicit workflow-named definition question as a locator', () => {
    expect(plan('Where is WorkflowEngine defined?')).toEqual({
      intent: 'locate',
      subject: 'workflow engine',
      terms: ['engine', 'workflow'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'workflow engine', mandatory: true },
      ],
    })
  })

  it('plans subject and behavior for explanations', () => {
    expect(plan('How does cache invalidation work?')).toEqual({
      intent: 'explain',
      subject: 'cache invalidation',
      terms: ['cache', 'invalidation'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'cache invalidation', mandatory: true },
        { id: 'o2', kind: 'behavior', target: 'cache invalidation', mandatory: true },
      ],
    })
  })

  it('does not treat a generate-prefixed subject as a workflow verb', () => {
    expect(plan('How does generateInvoice validate input?')).toEqual({
      intent: 'explain',
      subject: 'generate invoice',
      terms: ['generate', 'input', 'invoice'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'generate invoice', mandatory: true },
        { id: 'o2', kind: 'behavior', target: 'input', mandatory: true },
      ],
    })
  })

  it('treats explicit call questions as behavior of the caller', () => {
    expect(plan('How does submit order call save order?')).toEqual({
      intent: 'explain',
      subject: 'submit order',
      terms: ['order', 'save', 'submit'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'submit order', mandatory: true },
        { id: 'o2', kind: 'behavior', target: 'save', mandatory: true },
      ],
    })
    expect(plan('How does process order call persist order?')).toEqual({
      intent: 'explain',
      subject: 'process order',
      terms: ['order', 'persist', 'process'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'process order', mandatory: true },
        { id: 'o2', kind: 'behavior', target: 'persist', mandatory: true },
      ],
    })
  })

  it.each([
    [
      'Which module sends invoice receipt emails?',
      'invoice receipt email',
      ['email', 'invoice', 'receipt', 'send'],
    ],
    [
      'What runs the monthly billing close?',
      'monthly billing close',
      ['billing', 'close', 'monthly', 'run'],
    ],
  ])('plans a bounded responsibility explanation: %s', (question, subject, terms) => {
    const result = plan(question)

    expect(result.intent).toBe('explain')
    expect(result.subject).toBe(subject)
    expect(result.terms).toEqual(terms)
    expect(result.obligations.map(({ kind }) => kind))
      .toEqual(['subject', 'behavior'])
  })

  it('plans every explicit workflow obligation', () => {
    expect(plan('How is an idea report generated end-to-end?')).toEqual({
      intent: 'workflow',
      subject: 'idea report',
      terms: ['idea', 'report'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'idea report', mandatory: true },
        { id: 'o2', kind: 'entry', target: 'idea report', mandatory: true },
        { id: 'o3', kind: 'stage', target: 'idea report', mandatory: true },
        { id: 'o4', kind: 'handoff', target: 'idea report', mandatory: true },
        { id: 'o5', kind: 'behavior', target: 'idea report', mandatory: true },
        { id: 'o6', kind: 'ordering', target: 'idea report', mandatory: true },
        { id: 'o7', kind: 'terminal', target: 'idea report', mandatory: true },
      ],
    })
  })

  it('plans a trace from request to persistence as a workflow', () => {
    const result = plan('Trace the idea report from request to persistence')

    expect(result.intent).toBe('workflow')
    expect(result.subject).toBe('idea report')
    expect(result.terms).toEqual(['idea', 'persist', 'report', 'request'])
    expect(result.obligations.map(({ kind }) => kind)).toEqual([
      'subject', 'entry', 'stage', 'handoff', 'behavior', 'ordering', 'terminal',
    ])
  })

  it('keeps a camel-cased trace entrypoint separate from its from-boundary', () => {
    const result = plan('Trace generateFromProblem from request to persistence')

    expect(result.intent).toBe('workflow')
    expect(result.subject).toBe('generate problem')
    expect(result.terms).toEqual(['generate', 'persist', 'problem', 'request'])
  })

  it.each([
    [
      'Trace a failed invoice from the route through retry scheduling.',
      'failed invoice', ['failed', 'invoice', 'retry', 'route', 'scheduling'],
    ],
    [
      'Trace invoice retry scheduling.',
      'invoice retry scheduling', ['invoice', 'retry', 'scheduling'],
    ],
  ])('plans imperative trace phrasing as a workflow: %s', (question, subject, terms) => {
    const result = plan(question)

    expect(result.intent).toBe('workflow')
    expect(result.subject).toBe(subject)
    expect(result.terms).toEqual(terms)
  })

  it('keeps explicit location semantics ahead of a bare trace cue', () => {
    expect(plan('Trace where WorkflowEngine is defined')).toEqual({
      intent: 'locate',
      subject: 'workflow engine',
      terms: ['engine', 'workflow'],
      obligations: [
        { id: 'o1', kind: 'subject', target: 'workflow engine', mandatory: true },
      ],
    })
  })

  it.each([
    ['How does GoValidate generate an idea report end to end?', 'idea report'],
    ['Can you explain how GoValidate generate ideas report?', 'idea report'],
    ['How does ExampleEngine produce release artifacts end to end?', 'release artifact'],
    ['How does ExampleEngine produce release artifacts?', 'release artifact'],
  ])('extracts the object, not the actor, from active workflows: %s', (question, subject) => {
    expect(plan(question)).toEqual({
      intent: 'workflow',
      subject,
      terms: subject.split(' ').sort(),
      obligations: [
        { id: 'o1', kind: 'subject', target: subject, mandatory: true },
        { id: 'o2', kind: 'entry', target: subject, mandatory: true },
        { id: 'o3', kind: 'stage', target: subject, mandatory: true },
        { id: 'o4', kind: 'handoff', target: subject, mandatory: true },
        { id: 'o5', kind: 'behavior', target: subject, mandatory: true },
        { id: 'o6', kind: 'ordering', target: subject, mandatory: true },
        { id: 'o7', kind: 'terminal', target: subject, mandatory: true },
      ],
    })
  })

  it('keeps an explicit flow noun phrase ahead of the generic determiner fallback', () => {
    const result = plan('explain how generating the idea report flow is working')

    expect(result.intent).toBe('workflow')
    expect(result.subject).toBe('idea report')
    expect(result.terms).toEqual(['idea', 'report'])
  })

  it('maps coordinated lifecycle clauses to structural workflow bounds', () => {
    const result = plan(
      'Which runtime components accept an idea, schedule its analysis, research each section, compose the result, and write the durable read model?',
    )

    expect(result.intent).toBe('workflow')
    expect(result.subject).toBe('idea report')
    expect(result.terms).toEqual([
      'assemble', 'idea', 'report', 'research', 'schedule',
    ])
    expect(result.obligations.find(({ kind }) => kind === 'entry')?.target)
      .toBe('request idea')
    expect(result.obligations.find(({ kind }) => kind === 'stage')?.target)
      .toBe('research assemble')
    expect(result.obligations.find(({ kind }) => kind === 'handoff')?.target)
      .toBe('schedule')
    expect(result.obligations.find(({ kind }) => kind === 'terminal')?.target)
      .toBe('persistence')
  })

  it.each([
    [
      'How does password policy login create a tenant session?',
      'password policy login', ['create', 'login', 'password', 'policy', 'session', 'tenant'],
    ],
    [
      'How is the monthly revenue report built?',
      'monthly revenue report', ['build', 'monthly', 'report', 'revenue'],
    ],
  ])('keeps bounded component behavior as an explanation: %s', (
    question, subject, terms,
  ) => {
    const result = plan(question)
    expect(result.intent).toBe('explain')
    expect(result.subject).toBe(subject)
    expect(result.terms).toEqual(terms)
    expect(result.obligations.map(({ kind }) => kind))
      .toEqual(['subject', 'behavior'])
  })

  it('keeps a get-passive workflow subject ahead of boundary clauses', () => {
    const result = plan(
      'How does the idea report get generated from the initial request through to the completed report?',
    )

    expect(result.subject).toBe('idea report')
    expect(result.obligations.map(({ kind }) => kind)).toEqual([
      'subject', 'entry', 'stage', 'handoff', 'behavior', 'ordering', 'terminal',
    ])
  })

  it.each([
    'Where does the ingestion pipeline flow from request through validation to storage?',
    'Where is the end-to-end ingestion pipeline implemented?',
    'Explain how the ingestion workflow runs.',
  ])('gives workflow semantics priority over locator or explanation cues: %s', (question) => {
    expect(plan(question).intent).toBe('workflow')
  })

  it('normalizes punctuation without changing the subject or terms', () => {
    const plain = plan('How is the idea report generated end to end')
    const punctuated = plan('HOW is the idea-report generated, end-to-end?!')

    expect(punctuated).toEqual(plain)
  })

  it('keeps the canonical subject and sorted terms stable when clauses move', () => {
    const prefix = plan(
      'From request through planning to persistence, how is the idea report generated?',
    )
    const suffix = plan(
      'How is the idea report generated, from request through planning to persistence?',
    )

    expect(prefix.subject).toBe('idea report')
    expect(prefix.terms).toEqual(['idea', 'persist', 'plan', 'report', 'request'])
    expect(suffix).toEqual(prefix)
  })

  it('extracts the workflow object from event phrasing', () => {
    const result = plan('What happens when a user requests an idea report?')

    expect(result.intent).toBe('workflow')
    expect(result.subject).toBe('idea report')
  })

  it('keeps walk-through syntax separate from its structural bounds', () => {
    const result = plan(
      'Walk me through idea report generation from HTTP request via queues to database persistence',
    )

    expect(result.subject).toBe('idea report')
    expect(result.obligations.find(({ kind }) => kind === 'entry')?.target)
      .toBe('http request')
    expect(result.obligations.find(({ kind }) => kind === 'stage')?.target)
      .toBe('queue')
    expect(result.obligations.find(({ kind }) => kind === 'terminal')?.target)
      .toBe('database persist')
  })

  it('canonicalizes field-incident phrasings independently of clause order', () => {
    const suffix = plan('Which method persists retryCount on failure?')
    const prefix = plan('On failure, what persists retryCount?')

    expect(prefix).toEqual(suffix)
    expect(prefix.intent).toBe('locate')
    expect(prefix.subject).toBe('retry count')
    expect(prefix.terms).toEqual(['failure', 'retry', 'count'].sort())
    expect(prefix.access).toBe('write')
  })

  it('recognizes field reads as locators rather than explanations', () => {
    const result = plan('What reads accountStatus after authentication completes?')

    expect(result.intent).toBe('locate')
    expect(result.subject).toBe('account status')
    expect(result.access).toBe('read')
    expect(result.obligations.map(({ kind }) => kind)).toEqual(['subject'])
  })

  it('uses stable one-based obligation IDs for every supported intent', () => {
    expect(plan('Find the retry policy definition').obligations.map(({ id }) => id))
      .toEqual(['o1'])
    expect(plan('Explain how the retry policy behaves').obligations.map(({ id }) => id))
      .toEqual(['o1', 'o2'])
    expect(plan('Trace the retry policy workflow end to end').obligations.map(({ id }) => id))
      .toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'])
  })

  it('does not let budget alter semantic planning', () => {
    expect(plan('How does cache invalidation work?', 256))
      .toEqual(plan('How does cache invalidation work?', 4000))
  })

  it('does not mutate the normalized request', () => {
    const request: NormalizedRetrieveRequest = {
      question: 'How is an idea report generated end to end?',
      budget: 1024,
    }
    const snapshot = structuredClone(request)

    planQuestion(request)

    expect(request).toEqual(snapshot)
  })

  it.each([
    'Compare these approaches',
    'Write a migration for this service',
    'Summarize every file',
  ])('returns unsupported for an unplanned intent: %s', (question) => {
    expect(unsupported(question).reason).toBe('unsupported_intent')
  })

  it('returns an exact missing-subject reason instead of planning a pronoun', () => {
    const result = unsupported('Where is it?')

    expect(result.reason).toBe('missing_subject')
    expect(result.terms).toEqual([])
  })
})
