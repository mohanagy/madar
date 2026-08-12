import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createRequire } from 'node:module'

import { Ajv } from 'ajv'
import { describe, expect, it } from 'vitest'

// ajv-formats ships CommonJS whose default export is not callable under
// NodeNext type resolution. Load it the same way the CI validator does so the
// test and `npm run qualify:validate` compile the schema identically.
const addFormats = createRequire(import.meta.url)('ajv-formats') as (ajv: Ajv) => void

const ROOT = 'docs/qualification'

function readDoc(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8')
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readDoc(relativePath)) as T
}

interface Provenance {
  authored_by: string
  authored_at: string
  madar_derived_sources_used: string[]
  inspected_madar_output_before_freeze: boolean
  independent_of_production_rule_author: boolean
}

interface Task {
  id: string
  category: string
  target: string
  tiers: number[]
  prompt: { text: string; sha256: string }
  truth_ref: string
  scoring: { tier1_method: string; tier2_method: string }
  truth_provenance: Provenance
}

const corpus = readJson<{
  contract_version: string
  targets: Array<{ id: string; tier: number; kind: string; status: string; holdout_class?: string; source?: { ref: string } }>
}>(`${ROOT}/corpus.json`)

const tasks = readJson<{ contract_version: string; tasks: Task[] }>(`${ROOT}/tasks.json`)
const rubrics = readJson<{
  dimensions: Record<string, { gating: boolean; tiers: number[]; scored_by: string }>
  methods: Record<string, unknown>
  blinding: { current_status: string }
}>(`${ROOT}/rubrics.json`)
const tier1 = readJson<{
  properties: { deterministic: boolean; requires_network: boolean; requires_api_spend: boolean }
  cells: Array<{ task_id: string; target_id: string }>
  negative_trust_probes: Array<{ id: string; prompt: { text: string; sha256: string } }>
  gate: { forbidden_remedies: string[] }
  calibration_status: { state: string }
}>(`${ROOT}/tier1.json`)
const tier2 = readJson<{ status: string; dimensions: { trials_per_cell: number } }>(`${ROOT}/tier2-matrix.json`)
const receiptSchema = readJson<Record<string, unknown>>(`${ROOT}/receipt-schema.json`)
const freeze = readJson<{ contract_version: string; files: Record<string, string> }>(`${ROOT}/freeze.json`)

describe('qualification corpus manifest', () => {
  it('pins every target with an immutable revision or a frozen digest', () => {
    for (const target of corpus.targets) {
      if (target.kind === 'git') {
        expect(target.source?.ref).toMatch(/^[0-9a-f]{40}$/)
      }
      if (target.kind === 'fixture') {
        expect(target.status).toBe('frozen')
      }
    }
  })

  it('keeps Tier 2 git targets marked as having no independent truth yet', () => {
    const gitTargets = corpus.targets.filter((target) => target.kind === 'git')

    expect(gitTargets.length).toBeGreaterThan(0)
    for (const target of gitTargets) {
      expect(target.status).toBe('pinned_no_truth')
    }
  })

  it('keeps the sealed holdout slot visible and explicitly unsatisfied', () => {
    const sealed = corpus.targets.filter((target) => target.holdout_class === 'sealed')

    expect(sealed).toHaveLength(1)
    expect(sealed[0]?.status).toBe('unsatisfied')
  })
})

describe('qualification task definitions', () => {
  it('covers every task category named in the issue contract', () => {
    const categories = new Set(tasks.tasks.map((task) => task.category))

    expect([...categories].sort()).toEqual([
      'architecture-understanding',
      'bug-root-cause-investigation',
      'execution-flow-explanation',
      'impact-analysis',
      'implementation-planning',
      'review-security',
    ])
  })

  it('freezes each prompt against its recorded hash', () => {
    for (const task of tasks.tasks) {
      expect(createHash('sha256').update(task.prompt.text, 'utf8').digest('hex')).toBe(task.prompt.sha256)
    }
  })

  it('records a truth owner and asserts no Madar-derived source for every task', () => {
    for (const task of tasks.tasks) {
      const truth = readJson<{ provenance: Provenance }>(`${ROOT}/${task.truth_ref}`)

      for (const provenance of [task.truth_provenance, truth.provenance]) {
        expect(provenance.authored_by.length).toBeGreaterThan(0)
        expect(provenance.authored_at.length).toBeGreaterThan(0)
        expect(provenance.madar_derived_sources_used).toEqual([])
        expect(provenance.inspected_madar_output_before_freeze).toBe(false)
        expect(provenance.independent_of_production_rule_author).toBe(false)
      }
    }
  })

  it('does not use the same scoring method for every category', () => {
    const methods = new Set(tasks.tasks.map((task) => task.scoring.tier2_method))

    expect(methods.size).toBeGreaterThan(1)
    for (const task of tasks.tasks) {
      expect(rubrics.methods[task.scoring.tier2_method]).toBeTruthy()
      expect(rubrics.methods[task.scoring.tier1_method]).toBeTruthy()
    }
  })
})

describe('qualification rubrics', () => {
  it('measures adoption and fallback exploration separately from context quality', () => {
    expect(rubrics.dimensions.intended_tool_adoption?.gating).toBe(false)
    expect(rubrics.dimensions.broad_fallback_exploration?.gating).toBe(false)
    expect(rubrics.dimensions.correctness?.gating).toBe(true)
    expect(rubrics.dimensions.critical_fact_completeness?.gating).toBe(true)
  })

  it('declares blinded review unavailable rather than assuming it', () => {
    expect(rubrics.blinding.current_status).toBe('unsatisfied')
  })
})

describe('qualification receipt schema', () => {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  const validate = ajv.compile(receiptSchema)

  const validTier1 = readJson<Record<string, unknown>>(`${ROOT}/examples/receipt-tier1-valid.json`)
  const invalidTier2 = readJson<Record<string, unknown>>(`${ROOT}/examples/receipt-tier2-invalid-no-madar-call.json`)

  it('accepts the published examples', () => {
    expect(validate(validTier1)).toBe(true)
    expect(validate(invalidTier2)).toBe(true)
  })

  it('keeps every quality dimension not_measured on an invalid run', () => {
    const scores = (invalidTier2 as { scores: Record<string, { measured: boolean; value: unknown }> }).scores
    const validity = (invalidTier2 as { validity: { status: string; aggregatable: boolean } }).validity

    expect(validity.status).toBe('invalid')
    expect(validity.aggregatable).toBe(false)
    for (const score of Object.values(scores)) {
      expect(score.measured).toBe(false)
      expect(score.value).toBeNull()
    }
  })

  it('rejects an invalid run that claims to be aggregatable', () => {
    const mutated = JSON.parse(JSON.stringify(invalidTier2)) as { validity: { aggregatable: boolean } }
    mutated.validity.aggregatable = true

    expect(validate(mutated)).toBe(false)
  })

  it('rejects an unmeasured score that carries a value', () => {
    const mutated = JSON.parse(JSON.stringify(invalidTier2)) as {
      scores: { correctness: { measured: boolean; value: unknown } }
    }
    mutated.scores.correctness.value = 2

    expect(validate(mutated)).toBe(false)
  })

  it('keeps indexing, context building, and agent cost in separate accounts', () => {
    const costs = (validTier1 as { costs: Record<string, { measured: boolean }> }).costs

    expect(Object.keys(costs).sort()).toEqual(['agent', 'context_build', 'indexing'])
    expect(costs.agent?.measured).toBe(false)
  })
})

describe('qualification Tier 1 subset', () => {
  it('is deterministic and runnable in a pull request without spend', () => {
    expect(tier1.properties.deterministic).toBe(true)
    expect(tier1.properties.requires_network).toBe(false)
    expect(tier1.properties.requires_api_spend).toBe(false)
  })

  it('covers every frozen task and freezes each negative-trust probe prompt', () => {
    expect(tier1.cells.map((cell) => cell.task_id).sort()).toEqual(tasks.tasks.map((task) => task.id).sort())

    expect(tier1.negative_trust_probes.length).toBeGreaterThan(0)
    for (const probe of tier1.negative_trust_probes) {
      expect(createHash('sha256').update(probe.prompt.text, 'utf8').digest('hex')).toBe(probe.prompt.sha256)
    }
  })

  it('forbids clearing a failure by editing the contract or the production rules', () => {
    const remedies = tier1.gate.forbidden_remedies.join('\n')

    expect(remedies).toContain('Adding a qualification path, symbol, prompt, or repository name to production')
    expect(remedies).toContain('Relaxing a truth file to match observed output')
    expect(remedies).toContain('Marking a failing cell not_measured')
  })

  it('states that the thresholds are pre-registered and uncalibrated', () => {
    expect(tier1.calibration_status.state).toBe('pre_registered_uncalibrated')
  })

  it('keeps the Tier 2 matrix planned with a repeated-run count', () => {
    expect(tier2.status).toBe('planned')
    expect(tier2.dimensions.trials_per_cell).toBeGreaterThan(1)
  })
})

describe('qualification policy documents', () => {
  it('states an objective stop rule with a pre-registered non-inferiority margin', () => {
    const stopRule = readDoc(`${ROOT}/stop-rule.md`)

    for (const id of ['S1.1', 'S1.2', 'S1.3', 'S1.4', 'S1.5', 'S1.6', 'S1.7', 'S1.8']) {
      expect(stopRule).toContain(id)
    }
    expect(stopRule).toContain('non-inferiority margin **0.05**')
    expect(stopRule).toContain('Do not fix forward on the protected branch while a stop condition is tripped.')
    expect(stopRule).toContain('Marking a measured failure as `not_measured`.')
  })

  it('declares the sealed holdout unsatisfied and names the human action required', () => {
    const policy = readDoc(`${ROOT}/holdout-policy.md`)

    expect(policy).toContain('## Current status: unsatisfied')
    expect(policy).toContain('### Human action required')
    expect(policy).toContain('sealed holdout unsatisfied; results measure regression only')
  })

  it('labels synthetic and package-parity artifacts as non-outcome evidence', () => {
    const categories = readDoc(`${ROOT}/evidence-categories.md`)

    expect(categories).toContain('### E1 — Product outcome evidence')
    expect(categories).toContain('**Currently held: none.**')
    expect(categories).toContain('### E4 — Synthetic or fixture receipts')
    expect(categories).toContain('### E5 — Package and parity checks')
    expect(categories).toContain('E4 proves the reporting pipeline works. It is never agent-outcome evidence.')
  })

  it('defines transcript and receipt retention', () => {
    const rules = readDoc(`${ROOT}/validity-rules.md`)

    expect(rules).toContain('at least **24 months**')
    expect(rules).toContain('the raw agent transcript (Tier 2) or the context artifact (Tier 1)')
    expect(rules).toContain('`not_measured` describes a run that could not be measured')
  })

  it('records which receipt fields v0.32.1 does not emit yet', () => {
    const rules = readDoc(`${ROOT}/validity-rules.md`)

    expect(rules).toContain('## What today\'s emitter actually produces')
    expect(rules).toContain('There is no separate indexing or context-build cost account')
  })
})

describe('qualification freeze', () => {
  it('covers every contract and fixture file with a digest', () => {
    expect(freeze.contract_version).toBe(corpus.contract_version)

    const paths = Object.keys(freeze.files)
    expect(paths).toContain(`${ROOT}/corpus.json`)
    expect(paths).toContain(`${ROOT}/tasks.json`)
    expect(paths).toContain(`${ROOT}/rubrics.json`)
    expect(paths).toContain(`${ROOT}/receipt-schema.json`)
    expect(paths).toContain(`${ROOT}/fixtures/ledger-service/src/service/ledger-service.ts`)
    expect(paths).toContain(`${ROOT}/fixtures/plugin-host/src/host/plugin-host.ts`)

    for (const [path, digest] of Object.entries(freeze.files)) {
      expect(digest).toBe(createHash('sha256').update(readFileSync(resolve(path))).digest('hex'))
    }
  })

  it('is wired into an npm script so a clean checkout can verify it', () => {
    const pkg = readJson<{ scripts: Record<string, string> }>('package.json')

    expect(pkg.scripts['qualify:validate']).toBe('node .github/scripts/validate-qualification-contract.mjs')
  })
})
