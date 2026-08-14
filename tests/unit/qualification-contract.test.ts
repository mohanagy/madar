import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { Ajv } from 'ajv'
import { describe, expect, it } from 'vitest'

// ajv-formats ships CommonJS whose default export is not callable under NodeNext type
// resolution. Load it the same way the CI validator does so the test and
// `npm run qualify:validate` compile the schema identically.
const addFormats = createRequire(import.meta.url)('ajv-formats') as (ajv: Ajv) => void

// The cited-path traversal is the shipped validator's own, not a copy of it. It is loaded
// through createRequire for the same reason as ajv-formats: it is CommonJS living under
// .github/, which tsconfig does not include.
const { collectCitedPaths } = createRequire(import.meta.url)(
  '../../.github/scripts/lib/collect-cited-paths.cjs',
) as { collectCitedPaths: (node: unknown) => Set<string> }

const ROOT = 'docs/qualification'

/**
 * Reads a contract document for *semantic* assertions. Line endings are
 * normalized so the assertions test content rather than checkout representation:
 * `.gitattributes` pins this tree to LF, but a test that only passes because of a
 * checkout setting is testing the setting, not the document.
 *
 * The byte-exact freeze contract is deliberately NOT read through here — it uses
 * the raw Buffer below, because that guarantee is about bytes.
 */
function readDoc(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8').replace(/\r\n/g, '\n')
}

/** Raw bytes, for the freeze digest contract only. Never normalized. */
function readBytes(relativePath: string): Buffer {
  return readFileSync(resolve(relativePath))
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readDoc(relativePath)) as T
}

interface Provenance {
  authored_by: string
  authored_at: string
  derived_from: string[]
  madar_derived_sources_used: string[]
  inspected_madar_output_before_freeze: boolean
  independent_of_production_rule_author: boolean
}

interface Target {
  id: string
  kind: string
  natural?: boolean
  status: string
  license?: string
  holdout_class?: string
  prepare?: string[]
  patch?: string
  base_target?: string
  source?: { url: string; ref: string }
  cited_blobs?: Record<string, string>
  production_coupling?: { level: string; consequence?: string }
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
  targets: Target[]
  proxy_targets: unknown[]
  forbidden_target_symbols: Record<string, unknown>
}>(`${ROOT}/corpus.json`)

const tasks = readJson<{ contract_version: string; tasks: Task[] }>(`${ROOT}/tasks.json`)
const rubrics = readJson<{
  dimensions: Record<string, { gating: boolean }>
  methods: Record<string, unknown>
  blinding: { current_status: string }
}>(`${ROOT}/rubrics.json`)
const tier1 = readJson<{
  properties: { deterministic: boolean; requires_model_provider: boolean; requires_api_spend: boolean }
  preparation: { steps: string[]; on_preparation_failure: string }
  cells: Array<{ task_id: string; target_id: string }>
  negative_trust_probes: Array<{ id: string; target_id: string; prompt: { text: string; sha256: string } }>
  gate: { forbidden_remedies: string[] }
  calibration_status: { state: string }
}>(`${ROOT}/tier1.json`)
const tier2 = readJson<{ status: string; dimensions: { trials_per_cell: number } }>(`${ROOT}/tier2-matrix.json`)
const receiptSchema = readJson<Record<string, unknown>>(`${ROOT}/receipt-schema.json`)
const freeze = readJson<{ contract_version: string; files: Record<string, string> }>(`${ROOT}/freeze.json`)

const evaluationTargets = corpus.targets.filter((target) => target.kind !== 'sealed')

describe('qualification corpus manifest', () => {
  it('uses only natural externally authored targets, with no fixture proxies', () => {
    expect(evaluationTargets.length).toBeGreaterThan(0)
    expect(corpus.proxy_targets).toEqual([])

    for (const target of evaluationTargets) {
      expect(target.natural).toBe(true)
      expect(target.kind === 'git' || target.kind === 'git_patched').toBe(true)
    }
  })

  it('pins every target at an immutable commit with a license and prepare steps', () => {
    for (const target of evaluationTargets) {
      expect(target.source?.ref).toMatch(/^[0-9a-f]{40}$/)
      expect(target.source?.url).toMatch(/^https:\/\//)
      expect(target.license).toBeTruthy()
      expect(target.prepare?.length).toBeGreaterThan(0)
      expect(target.status).toBe('frozen')
    }
  })

  it('records a frozen blob digest for every path its truth may cite', () => {
    for (const target of evaluationTargets) {
      const blobs = Object.entries(target.cited_blobs ?? {})

      expect(blobs.length).toBeGreaterThan(0)
      for (const [, blob] of blobs) {
        expect(blob).toMatch(/^[0-9a-f]{40}$/)
      }
    }
  })

  it('seeds defects as patches against the pinned commit of a real repository', () => {
    const patched = corpus.targets.filter((target) => target.kind === 'git_patched')

    expect(patched.length).toBeGreaterThan(0)
    for (const target of patched) {
      const base = corpus.targets.find((candidate) => candidate.id === target.base_target)
      expect(base?.source?.ref).toBe(target.source?.ref)

      const patch = readDoc(`${ROOT}/${target.patch}`)
      expect(patch.startsWith('diff --git ')).toBe(true)

      const touched = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1])
      expect(touched.length).toBeGreaterThan(0)
      for (const path of touched) {
        expect(Object.keys(target.cited_blobs ?? {})).toContain(path)
      }
    }
  })

  it('discloses where a target overlaps a shipped framework adapter', () => {
    const hono = corpus.targets.find((target) => target.id === 'hono')
    const unstorage = corpus.targets.find((target) => target.id === 'unstorage')

    expect(hono?.production_coupling?.level).toBe('declared_framework_adapter')
    expect(hono?.production_coupling?.consequence).toContain('not evidence about frameworks that have no adapter')
    expect(unstorage?.production_coupling?.level).toBe('none_found')
  })

  it('keeps the forbidden-symbol map free of prose that would poison the guard', () => {
    // A non-array value here folds a whole documentation string into the literal list, which
    // starts failing production files the moment that string is shortened to something common.
    for (const [key, value] of Object.entries(corpus.forbidden_target_symbols)) {
      if (key.startsWith('_')) {
        expect(typeof value).toBe('string')
        continue
      }

      expect(Array.isArray(value)).toBe(true)
      expect(corpus.targets.some((target) => target.id === key)).toBe(true)
      for (const symbol of value as string[]) {
        expect(symbol).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
      }
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

  it('never names the coupled framework inside a prompt for that target', () => {
    const coupled = tasks.tasks.filter((task) => task.target.startsWith('hono'))

    expect(coupled.length).toBeGreaterThan(0)
    for (const task of coupled) {
      expect(task.prompt.text.toLowerCase()).not.toContain('hono')
    }
  })

  it('records a truth owner, a real derivation source, and no Madar-derived source', () => {
    for (const task of tasks.tasks) {
      const truth = readJson<{ provenance: Provenance }>(`${ROOT}/${task.truth_ref}`)

      for (const provenance of [task.truth_provenance, truth.provenance]) {
        expect(provenance.authored_by.length).toBeGreaterThan(0)
        expect(provenance.authored_at.length).toBeGreaterThan(0)
        expect(provenance.derived_from.length).toBeGreaterThan(0)
        expect(provenance.madar_derived_sources_used).toEqual([])
        expect(provenance.inspected_madar_output_before_freeze).toBe(false)
        // The contract requires this to be *stated*, not to hold a particular value. Pinning
        // it to false would fail the moment a second author closes the independence gap,
        // which is an improvement, not a regression.
        expect(typeof provenance.independent_of_production_rule_author).toBe('boolean')
      }
    }
  })

  it('records the current independence state, which a second author is expected to change', () => {
    for (const task of tasks.tasks) {
      const truth = readJson<{ provenance: Provenance }>(`${ROOT}/${task.truth_ref}`)
      for (const provenance of [task.truth_provenance, truth.provenance]) {
        expect(provenance.independent_of_production_rule_author).toBe(false)
      }
    }
  })

  it('cites only paths recorded in the target blob manifest', () => {
    for (const task of tasks.tasks) {
      const truth = readJson<Record<string, unknown>>(`${ROOT}/${task.truth_ref}`)
      const target = corpus.targets.find((candidate) => candidate.id === task.target)
      // Shared with the shipped validator rather than reimplemented, so the `new_path`
      // exemption cannot drift between the guard and the test that covers it.
      const cited = collectCitedPaths(truth)

      expect(cited.size).toBeGreaterThan(0)
      for (const path of cited) {
        expect(Object.keys(target?.cited_blobs ?? {})).toContain(path)
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

  it('accepts the published examples and ties them to frozen prompts', () => {
    expect(validate(validTier1)).toBe(true)
    expect(validate(invalidTier2)).toBe(true)

    for (const receipt of [validTier1, invalidTier2] as Array<{
      task_id: string
      identity: { prompts: { user_prompt_sha256: string } }
    }>) {
      const task = tasks.tasks.find((candidate) => candidate.id === receipt.task_id)
      expect(task).toBeTruthy()
      expect(receipt.identity.prompts.user_prompt_sha256).toBe(task?.prompt.sha256)
    }
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

  it('can invalidate a run whose seeded patch did not apply', () => {
    const reasons = (
      receiptSchema as {
        properties: {
          validity: { properties: { invalidation_reasons: { items: { enum: string[] } } } }
        }
      }
    ).properties.validity.properties.invalidation_reasons.items.enum

    expect(reasons).toContain('patch_application_failure')
    expect(reasons).toContain('target_revision_mismatch')
  })

  it('keeps indexing, context building, and agent cost in separate accounts', () => {
    const costs = (validTier1 as { costs: Record<string, { measured: boolean }> }).costs

    expect(Object.keys(costs).sort()).toEqual(['agent', 'context_build', 'indexing'])
    expect(costs.agent?.measured).toBe(false)
  })
})

describe('qualification Tier 1 subset', () => {
  it('is deterministic and runnable in a pull request without model spend', () => {
    expect(tier1.properties.deterministic).toBe(true)
    expect(tier1.properties.requires_model_provider).toBe(false)
    expect(tier1.properties.requires_api_spend).toBe(false)
  })

  it('fails a cell whose target could not be prepared instead of skipping it', () => {
    expect(tier1.preparation.steps.length).toBeGreaterThan(0)
    expect(tier1.preparation.on_preparation_failure).toContain('never silently skipped')
  })

  it('covers every frozen task and freezes each negative-trust probe prompt', () => {
    expect(tier1.cells.map((cell) => cell.task_id).sort()).toEqual(tasks.tasks.map((task) => task.id).sort())

    expect(tier1.negative_trust_probes.length).toBeGreaterThan(0)
    for (const probe of tier1.negative_trust_probes) {
      expect(createHash('sha256').update(probe.prompt.text, 'utf8').digest('hex')).toBe(probe.prompt.sha256)
      expect(corpus.targets.some((target) => target.id === probe.target_id)).toBe(true)
    }
  })

  it('forbids clearing a failure by editing the contract or swapping in a fixture', () => {
    const remedies = tier1.gate.forbidden_remedies.join('\n')

    expect(remedies).toContain('Adding a qualification path, symbol, prompt, or repository name to production')
    expect(remedies).toContain('Relaxing a truth file to match observed output')
    expect(remedies).toContain('Marking a failing cell not_measured')
    expect(remedies).toContain('Replacing a natural target with a self-authored fixture')
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
  it('states the no-measured-evidence limitation prominently at the top of the README', () => {
    const readme = readDoc(`${ROOT}/README.md`)
    const heading = '## Read this first — what this contract does and does not give you today'

    expect(readme).toContain(heading)
    // "Prominent" is load-bearing: the limitation must appear before the corpus is described,
    // not be inferable only by cross-referencing target entries further down.
    expect(readme.indexOf(heading)).toBeLessThan(readme.indexOf('## Why a separate corpus exists'))
    expect(readme).toContain('This contract has never been executed. It currently produces no measured evidence of')
    expect(readme).toContain('Regression only, never generalization.')
    expect(readme).toContain('Thresholds are pre-registered, not calibrated.')
    expect(readme).toContain('**Tier 1 needs network access**')
  })

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
    expect(policy).toContain('Naturalness and hiddenness are separate properties')
  })

  it('separates target naturalness from evidence class', () => {
    const categories = readDoc(`${ROOT}/evidence-categories.md`)

    expect(categories).toContain('## Target naturalness qualifies the evidence')
    expect(categories).toContain('### E1 — Product outcome evidence')
    expect(categories).toContain('**Currently held: none.**')
    expect(categories).toContain('E4 proves the reporting pipeline works. It is never agent-outcome evidence.')
    expect(categories).toContain('five are in-repo proxies')
    expect(categories).toContain('six are git-backed and\ndo pin a URL together with an immutable commit SHA')
  })

  it('records the unenforced retrieval/grader boundary in runtime-proof.json', () => {
    const categories = readDoc(`${ROOT}/evidence-categories.md`)

    expect(categories).toContain('Open enforcement gap in E3')
    expect(categories).toContain('That isolation is asserted in\nprose. No test, lint rule, or CI check enforces it')
  })

  it('defines transcript and receipt retention', () => {
    const rules = readDoc(`${ROOT}/validity-rules.md`)

    expect(rules).toContain('at least **24 months**')
    expect(rules).toContain('the raw agent transcript (Tier 2) or the context artifact (Tier 1)')
    expect(rules).toContain('`not_measured` describes a run that could not be measured')
    expect(rules).toContain('`patch_application_failure`')
  })

  it('records which receipt fields v0.32.1 does not emit yet', () => {
    const rules = readDoc(`${ROOT}/validity-rules.md`)

    expect(rules).toContain('## What today\'s emitter actually produces')
    expect(rules).toContain('There is no separate indexing or context-build cost account')
  })
})

describe('qualification freeze', () => {
  it('covers every contract file with a digest', () => {
    expect(freeze.contract_version).toBe(corpus.contract_version)

    const paths = Object.keys(freeze.files)
    expect(paths).toContain(`${ROOT}/corpus.json`)
    expect(paths).toContain(`${ROOT}/tasks.json`)
    expect(paths).toContain(`${ROOT}/rubrics.json`)
    expect(paths).toContain(`${ROOT}/receipt-schema.json`)
    expect(paths).toContain(`${ROOT}/patches/hono-compose-reentrancy-guard.patch`)
    expect(paths).toContain(`${ROOT}/patches/hono-error-message-disclosure.patch`)

    // Raw bytes on purpose. If a checkout converts line endings, this must fail
    // rather than be normalized into passing — that is the whole point of the freeze.
    for (const [path, digest] of Object.entries(freeze.files)) {
      expect(digest).toBe(createHash('sha256').update(readBytes(path)).digest('hex'))
    }
  })

  it('pins the contract tree to LF so the byte-exact freeze survives a Windows checkout', () => {
    const attributes = readDoc('.gitattributes')

    expect(attributes).toContain('docs/qualification/** text eol=lf')
    expect(attributes).toContain('docs/qualification/patches/*.patch -text')
  })

  it('holds no CRLF in any frozen file, whatever the checkout did', () => {
    for (const path of Object.keys(freeze.files)) {
      expect(readBytes(path).includes('\r\n')).toBe(false)
    }
  })

  it('is wired into an npm script so a clean checkout can verify it', () => {
    const pkg = readJson<{ scripts: Record<string, string> }>('package.json')

    expect(pkg.scripts['qualify:validate']).toBe('node .github/scripts/validate-qualification-contract.mjs')
  })
})
