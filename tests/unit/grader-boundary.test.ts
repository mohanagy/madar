// #660-A — structural grader/runtime separation, enforced on every lane.
//
// The falsifiability injections (G1, G2, G3, G6) mutate real source files, so
// they live in `npm run verify:grader-boundary -- --self-test` and run outside
// the vitest worker pool. What runs here is everything that can be proved
// without touching the tree: the boundary itself, the shape of the allowlist,
// and the rules that stop the allowlist from being widened into uselessness.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- plain ESM helper shared with the CLI wrapper
import { analyzeGraderBoundary, analyzeGraderSequencing, GRADER_BOUNDARY_CONFIG_INVALID, GRADER_TRUTH_REACHABLE } from '../../scripts/lib/grader-boundary.mjs'

const CONFIG_PATH = resolve('docs/architecture/grader-boundary.json')
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
  grader_data_files: string[]
  normal_product_roots: string[]
  allowed_grader_ancestors: Array<{ path: string; role: string; justification: string }>
  sequencing: {
    loader_function: string
    artifact_fix_function: string
    approved_profile_consumers: string[]
  }
}

function sequencing(overrides: Record<string, unknown> = {}): {
  ok: boolean
  problems: string[]
  sites: Array<{
    file: string
    line: number
    wrappers: Array<string | null>
    artifactFixesBefore: number[]
    profileConsumers: Array<{ line: number; consumer: string | null }>
  }>
} {
  return analyzeGraderSequencing({
    cache: false,
    config: { ...config, sequencing: { ...config.sequencing, ...overrides } },
  })
}

function analyze(overrides: Record<string, unknown> = {}): {
  ok: boolean
  reason: string | null
  seeds: string[]
  ancestors: string[]
  unusedAllowances: string[]
  configProblems: string[]
  violations: Array<{ reason: string; file: string; rule: string; chain: string[] }>
  dataReferences: Array<{ file: string; line: number; dataFile: string }>
} {
  return analyzeGraderBoundary({ config: { ...config, ...overrides } })
}

describe('#660-A grader/runtime structural boundary', () => {
  it('reports no path from normal product code to qualification grader truth', () => {
    const result = analyze()
    expect(
      result.violations.map((violation) => `${violation.file} [${violation.rule}] ${violation.chain.join(' -> ')}`),
    ).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
  })

  it('derives the grader seed from the tree rather than from a hard-coded module name', () => {
    // Whichever production module names the grader data file IS the loader. A
    // rename must move the seed, not silently empty it.
    const result = analyze()
    expect(result.seeds.length).toBeGreaterThan(0)
    for (const seed of result.seeds) {
      expect(readFileSync(resolve(seed), 'utf8')).toContain('runtime-proof.json')
    }
  })

  it('records every direct reference to the grader data file and allows none outside the grader', () => {
    const result = analyze()
    const allowed = new Set(config.allowed_grader_ancestors.map((entry) => entry.path))
    for (const reference of result.dataReferences) {
      expect(allowed.has(reference.file), `${reference.file}:${reference.line} names ${reference.dataFile}`).toBe(true)
    }
  })

  it('keeps the neutral prompt-pack owner and the normal prompt paths off the grader graph', () => {
    const result = analyze()
    for (const file of [
      'src/infrastructure/prompt-pack.ts',
      'src/infrastructure/context-prompt-command.ts',
      'src/runtime/stdio/tools.ts',
      'src/runtime/stdio-server.ts',
      'src/runtime/retrieve.ts',
      'src/runtime/context-pack.ts',
    ]) {
      expect(result.ancestors, `${file} must not reach grader truth`).not.toContain(file)
    }
  })

  it('refuses to let a normal product root be allowlisted', () => {
    // The anti-drift rule. A future violation inside product construction must
    // not be resolvable by appending to the allowlist.
    const result = analyze({
      allowed_grader_ancestors: [
        ...config.allowed_grader_ancestors,
        {
          path: 'src/runtime/stdio/tools.ts',
          role: 'grader',
          justification: 'a plausible-sounding justification that is long enough to pass the length check',
        },
      ],
    })
    expect(result.reason).toBe(GRADER_BOUNDARY_CONFIG_INVALID)
    expect(result.configProblems.join('\n')).toContain('can never be allowlisted')
  })

  it('rejects a directory-wide or glob allowance', () => {
    for (const path of ['src/runtime/', 'src/cli/**', 'src/infrastructure/*.ts']) {
      const result = analyze({
        allowed_grader_ancestors: [{ path, role: 'grader', justification: 'wide open, which is exactly what must be refused' }],
      })
      expect(result.reason, path).toBe(GRADER_BOUNDARY_CONFIG_INVALID)
    }
  })

  it('rejects an allowance with no justification, a stub justification, or a missing file', () => {
    const base = { path: 'src/infrastructure/compare.ts', role: 'grader' }
    for (const entry of [
      { ...base },
      { ...base, justification: 'because' },
      { path: 'src/infrastructure/does-not-exist.ts', role: 'grader', justification: 'long enough justification text here' },
      { path: 'src/infrastructure/compare.ts', justification: 'long enough justification text here' },
    ]) {
      const result = analyze({ allowed_grader_ancestors: [entry] })
      expect(result.reason, JSON.stringify(entry)).toBe(GRADER_BOUNDARY_CONFIG_INVALID)
    }
  })

  it('rejects a duplicate allowance and a missing grader data file', () => {
    expect(analyze({
      allowed_grader_ancestors: [...config.allowed_grader_ancestors, config.allowed_grader_ancestors[0]!],
    }).reason).toBe(GRADER_BOUNDARY_CONFIG_INVALID)

    expect(analyze({ grader_data_files: ['docs/benchmarks/suite/not-a-real-file.json'] }).reason)
      .toBe(GRADER_BOUNDARY_CONFIG_INVALID)
  })

  it('fails with the exact reason when the allowlist is emptied', () => {
    // Emptying the allowlist leaves the genuine grader ancestors unapproved,
    // which must surface as the reachability failure rather than as silence.
    const result = analyze({
      allowed_grader_ancestors: [{
        path: 'src/infrastructure/benchmark/runtime-proof.ts',
        role: 'grader',
        justification: 'the loader itself, kept so the config stays structurally valid for this control',
      }],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(GRADER_TRUTH_REACHABLE)
    expect(result.violations.map((violation) => violation.file)).toContain('src/infrastructure/compare.ts')
    for (const violation of result.violations) {
      expect(violation.reason).toBe(GRADER_TRUTH_REACHABLE)
      expect(violation.chain.length).toBeGreaterThan(1)
    }
  })

  it('refuses an unjustified computed dynamic specifier in production code', () => {
    // A computed specifier is invisible to the module graph, so an unlisted one
    // would be a silent way around the whole boundary.
    const result = analyze({ allowed_computed_dynamic_imports: [] })
    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.rule)).toContain('computed_specifier_unverifiable')
    for (const violation of result.violations.filter((entry) => entry.rule === 'computed_specifier_unverifiable')) {
      expect(violation.reason).toBe(GRADER_TRUTH_REACHABLE)
    }
  })

  it('rejects a computed-import allowance with a stub justification', () => {
    const result = analyze({
      allowed_computed_dynamic_imports: [{ path: 'src/runtime/semantic.ts', role: 'x', justification: 'because' }],
    })
    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.rule)).toContain('computed_specifier_unverifiable')
  })

  it('keeps every allowlist entry earning its place', () => {
    const result = analyze()
    expect(result.unusedAllowances).toEqual([])
  })

  it('documents the claim boundary and does not overstate what it proves', () => {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { claim_boundary: string }
    expect(raw.claim_boundary).toContain('does not prove full product generalization')
    expect(raw.claim_boundary).toContain('#660-B')
  })

  describe('grader sequencing', () => {
    it('consults expected evidence only after the graded artifact is fixed', () => {
      const result = sequencing()
      expect(result.problems).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.sites).toHaveLength(1)

      const [site] = result.sites
      // Every call that writes the answer file under grading runs before the
      // load, and the assertion is on positions in the syntax tree rather than
      // on the comment that says so.
      expect(site!.artifactFixesBefore.length).toBeGreaterThan(0)
      for (const line of site!.artifactFixesBefore) {
        expect(line).toBeLessThan(site!.line)
      }
    })

    it('lets grader truth flow only into approved grading consumers', () => {
      const [site] = sequencing().sites
      const consumers = site!.profileConsumers.map((entry) => entry.consumer)
      expect(consumers.length).toBeGreaterThan(0)
      for (const consumer of [...consumers, ...site!.wrappers]) {
        expect(config.sequencing.approved_profile_consumers).toContain(consumer)
      }
    })

    it('fails when a real consumer is removed from the approved set', () => {
      // Falsifiability: the control must be able to report the flow it observes,
      // not merely agree with whatever the config happens to list.
      const result = sequencing({ approved_profile_consumers: ['matchBenchmarkRuntimeProofProfile'] })
      expect(result.ok).toBe(false)
      expect(result.problems.join('\n')).toContain('is not an approved grader consumer')
    })

    it('fails when the artifact-fixing function no longer exists in the graded scope', () => {
      const result = sequencing({ artifact_fix_function: 'aFunctionThatDoesNotExist' })
      expect(result.ok).toBe(false)
      expect(result.problems.join('\n')).toContain('never fixes a graded artifact')
    })

    it('fails when the loader function cannot be found at all', () => {
      const result = sequencing({ loader_function: 'noSuchLoader' })
      expect(result.ok).toBe(false)
      expect(result.problems.join('\n')).toContain('cannot be verified')
    })
  })
})
