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

import {
  analyzeGraderBoundary,
  analyzeGraderSequencing,
  COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED,
  GRADER_BOUNDARY_CONFIG_INVALID,
  GRADER_TRUTH_REACHABLE,
  UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
} from '../../scripts/lib/grader-boundary.mjs'

const CONFIG_PATH = resolve('docs/architecture/grader-boundary.json')
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
  grader_data_files: string[]
  normal_product_roots: string[]
  allowed_grader_ancestors: Array<{ path: string; role: string; justification: string }>
  mixed_routers: string[]
  allowed_mixed_router_edges: Array<{
    from: string; kind: string; specifier: string; resolved: string
    imported_bindings: string[]; role: string; justification: string
  }>
  allowed_computed_dynamic_imports: Array<{
    path: string; kind: string; enclosing_declaration: string; expression: string
    role: string; justification: string
  }>
  sequencing: {
    loader_function: string
    artifact_fix_function: string
    approved_profile_consumers: string[]
  }
}

function sequencing(overrides: Record<string, unknown> = {}) {
  return analyzeGraderSequencing({
    cache: false,
    config: { ...config, sequencing: { ...config.sequencing, ...overrides } },
  })
}

function analyze(overrides: Record<string, unknown> = {}) {
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

  it('approves the mixed CLI routers edge by edge and never as whole modules', () => {
    const result = analyze()
    expect(result.mixedRouters).toEqual(['src/cli/bin.ts', 'src/cli/main.ts'])
    // The routers reach the grader, but they are absent from the dedicated
    // whole-module ancestor set: every one of their edges is approved singly.
    for (const router of result.mixedRouters) {
      expect(result.ancestors).toContain(router)
      expect(result.dedicatedAncestors).not.toContain(router)
    }
    expect(result.routerEdges.length).toBe(config.allowed_mixed_router_edges.length)
    for (const edge of result.routerEdges) expect(edge.approved).toBe(true)
    expect(result.unusedRouterAllowances).toEqual([])
  })

  it('pins every router edge to its destination and imported bindings', () => {
    const result = analyze()
    for (const edge of result.routerEdges) {
      const declared = config.allowed_mixed_router_edges.find((entry) => (
        entry.from === edge.from && entry.kind === edge.kind && entry.specifier === edge.specifier
      ))
      expect(declared, `${edge.from} -> ${edge.specifier}`).toBeDefined()
      expect(declared!.resolved).toBe(edge.resolved)
      expect([...declared!.imported_bindings].sort()).toEqual([...edge.imported_bindings].sort())
    }
  })

  it('approves every computed import at one exact call site, never file-wide', () => {
    const result = analyze()
    expect(result.computedSpecifiers.length).toBe(config.allowed_computed_dynamic_imports.length)
    expect(result.unusedComputedAllowances).toEqual([])
    for (const site of result.computedSpecifiers) {
      const declared = config.allowed_computed_dynamic_imports.find((entry) => (
        entry.path === site.path
        && entry.kind === site.kind
        && entry.enclosing_declaration === site.enclosing_declaration
        && entry.expression === site.expression
      ))
      expect(declared, `${site.path}:${site.line} ${site.enclosing_declaration}`).toBeDefined()
    }
  })

  it('refuses a surplus computed allowance that matches no call site', () => {
    const result = analyze({
      allowed_computed_dynamic_imports: [
        ...config.allowed_computed_dynamic_imports,
        {
          path: 'src/runtime/semantic.ts',
          kind: 'dynamic-import',
          enclosing_declaration: 'noSuchFunction',
          expression: 'noSuchExpression',
          role: 'surplus',
          justification: 'a standing permission for an import that exists nowhere in the tree',
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED)
    expect(result.violations.map((violation) => violation.rule)).toContain('computed_allowance_unused')
  })

  it('refuses a surplus router allowance that matches no edge', () => {
    const result = analyze({
      allowed_mixed_router_edges: [
        ...config.allowed_mixed_router_edges,
        {
          from: 'src/cli/main.ts',
          kind: 'import',
          specifier: '../infrastructure/not-a-real-module.js',
          resolved: 'src/infrastructure/compare.ts',
          imported_bindings: [],
          role: 'surplus',
          justification: 'a standing permission for an edge that exists nowhere in the tree',
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.violations.map((violation) => violation.rule)).toContain('router_allowance_unused')
  })

  it('refuses every router edge when the router allowances are removed', () => {
    const result = analyze({ allowed_mixed_router_edges: [] })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(UNAPPROVED_MIXED_ROUTER_GRADER_EDGE)
    expect(result.violations.filter((violation) => violation.rule === 'router_edge_not_approved').length)
      .toBe(config.allowed_mixed_router_edges.length)
  })

  it('refuses a whole-module allowance for a mixed router', () => {
    const result = analyze({
      allowed_grader_ancestors: [
        ...config.allowed_grader_ancestors,
        { path: 'src/cli/main.ts', role: 'grader', justification: 'an attempt to trust the router as a whole module again' },
      ],
    })
    expect(result.reason).toBe(GRADER_BOUNDARY_CONFIG_INVALID)
    expect(result.configProblems.join('\n')).toContain('must be approved edge by edge')
  })

  it('refuses a computed allowance that omits its call-site identity', () => {
    for (const entry of [
      { path: 'src/runtime/semantic.ts', kind: 'dynamic-import', expression: 'X', role: 'r', justification: 'long enough justification text here' },
      { path: 'src/runtime/semantic.ts', kind: 'dynamic-import', enclosing_declaration: 'f', role: 'r', justification: 'long enough justification text here' },
    ]) {
      const result = analyze({ allowed_computed_dynamic_imports: [entry] })
      expect(result.reason, JSON.stringify(entry)).toBe(GRADER_BOUNDARY_CONFIG_INVALID)
    }
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

  it('refuses every computed dynamic specifier when the call-site allowances are removed', () => {
    // A computed specifier is invisible to the module graph, so an unlisted one
    // would be a silent way around the whole boundary.
    const result = analyze({ allowed_computed_dynamic_imports: [] })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe(COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED)
    const refused = result.violations.filter((entry) => entry.rule === 'computed_specifier_not_exactly_allowed')
    expect(refused.length).toBe(config.allowed_computed_dynamic_imports.length)
    for (const violation of refused) expect(violation.reason).toBe(COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED)
  })

  it('rejects a computed-import allowance with a stub justification', () => {
    const result = analyze({
      allowed_computed_dynamic_imports: [{
        path: 'src/runtime/semantic.ts',
        kind: 'dynamic-import',
        enclosing_declaration: 'importTransformersModule',
        expression: 'OPTIONAL_TRANSFORMERS_PACKAGE',
        role: 'x',
        justification: 'because',
      }],
    })
    expect(result.reason).toBe(GRADER_BOUNDARY_CONFIG_INVALID)
    expect(result.configProblems.join('\n')).toContain('substantive "justification"')
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
