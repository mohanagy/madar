/**
 * #660-A falsifiability harness for the structural grader boundary.
 *
 * A boundary check that has never been shown to fail is decorative. These
 * controls put a real grader dependency back into real production files, or a
 * real defect into the configuration, and require the guard to reject it with
 * the exact named reason, then put the bytes back and prove they went back.
 *
 * Each control declares its own PREMISE — the observable fact the injection was
 * supposed to create — and that premise is checked before the verdict is read.
 * Without it a silently no-op injection would look identical to a working
 * control. The premise differs by control type, which is the point:
 *
 *   - graph-backed controls assert a real compiler-resolved edge appeared;
 *   - the direct-read control asserts a textual data reference appeared;
 *   - computed-import controls assert the computed-site inventory changed;
 *   - configuration controls assert the guard refused the configuration itself.
 *
 * Restoration is by byte snapshot, never by `git checkout`/`reset`/`clean`: the
 * worktree may legitimately carry other uncommitted work, and a git-based
 * "restore" would destroy it. Every snapshot records content AND mode, every
 * restore is verified by digest, and a file that cannot be restored is reported
 * loudly rather than left for a later run to discover as a mysterious failure.
 *
 * Runs standalone (never inside the vitest worker pool) because it mutates
 * source files on disk.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  analyzeGraderBoundary,
  invalidateGraderBoundaryCache,
  COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED,
  GRADER_BOUNDARY_CONFIG_INVALID,
  GRADER_TRUTH_REACHABLE,
  UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
} from './grader-boundary.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

export class ByteSnapshot {
  #root
  #entries = new Map()

  constructor(root) {
    this.#root = root
  }

  /** Snapshot an existing file's bytes and mode, or record that it is absent. */
  capture(relativePath) {
    if (this.#entries.has(relativePath)) return
    const absolute = resolve(this.#root, relativePath)
    if (existsSync(absolute)) {
      this.#entries.set(relativePath, { existed: true, bytes: readFileSync(absolute), mode: statSync(absolute).mode })
    } else {
      this.#entries.set(relativePath, { existed: false, bytes: null, mode: null })
    }
  }

  write(relativePath, contents) {
    this.capture(relativePath)
    const absolute = resolve(this.#root, relativePath)
    const existing = this.#entries.get(relativePath)
    writeFileSync(absolute, contents)
    if (existing.existed && existing.mode !== null) chmodSync(absolute, existing.mode)
  }

  append(relativePath, suffix) {
    this.capture(relativePath)
    const absolute = resolve(this.#root, relativePath)
    this.write(relativePath, `${readFileSync(absolute, 'utf8')}${suffix}`)
  }

  /** Replace an exact substring once, failing loudly if it is not present. */
  replaceOnce(relativePath, find, replacement) {
    this.capture(relativePath)
    const absolute = resolve(this.#root, relativePath)
    const text = readFileSync(absolute, 'utf8')
    if (!text.includes(find)) throw new Error(`injection target not found in ${relativePath}: ${find}`)
    this.write(relativePath, text.replace(find, replacement))
  }

  /** Put every touched path back and PROVE it went back. Returns failures. */
  restore() {
    const unrestored = []
    for (const [relativePath, entry] of this.#entries) {
      const absolute = resolve(this.#root, relativePath)
      try {
        if (!entry.existed) {
          rmSync(absolute, { force: true })
          if (existsSync(absolute)) unrestored.push(`${relativePath} (injected file still present)`)
          continue
        }
        writeFileSync(absolute, entry.bytes)
        chmodSync(absolute, entry.mode)
        const after = readFileSync(absolute)
        if (digest(after) !== digest(entry.bytes)) unrestored.push(`${relativePath} (content digest mismatch)`)
        else if (statSync(absolute).mode !== entry.mode) unrestored.push(`${relativePath} (mode mismatch)`)
      } catch (error) {
        unrestored.push(`${relativePath} (${error?.message ?? String(error)})`)
      }
    }
    this.#entries.clear()
    return unrestored
  }
}

const PROBE_HELPER = 'src/shared/__grader_boundary_probe_helper.ts'
const PROBE_REEXPORT = 'src/shared/__grader_boundary_probe_reexport.ts'
const ROUTER_PROBE_HELPER = 'src/infrastructure/__grader_boundary_router_probe.ts'

const SEMANTIC = 'src/runtime/semantic.ts'
const PROMPT_COMMAND = 'src/infrastructure/context-prompt-command.ts'
const MCP_TOOLS = 'src/runtime/stdio/tools.ts'
const CLI_MAIN = 'src/cli/main.ts'

/** A module reached the grader through the compiler-resolved module graph. */
const premiseAncestor = (file) => (result) => (result.ancestors ?? []).includes(file)
/** The textual data-reference scan saw the grader data file named. */
const premiseDataReference = (file) => (result) => (result.dataReferences ?? []).some((entry) => entry.file === file)
/** The computed-site inventory grew or changed at this file. */
const premiseComputedCount = (file, count) => (result) => (
  (result.computedSpecifiers ?? []).filter((entry) => entry.path === file).length === count
)
/** A specific computed expression is present in the inventory. */
const premiseComputedExpression = (file, expression) => (result) => (
  (result.computedSpecifiers ?? []).some((entry) => entry.path === file && entry.expression === expression)
)
/** A router edge with this specifier is in the analyzed edge set. */
const premiseRouterEdge = (from, specifier) => (result) => (
  (result.routerEdges ?? []).some((edge) => edge.from === from && edge.specifier === specifier)
)
/** The guard refused the configuration itself rather than the tree. */
const premiseConfigRefused = () => (result) => (result.configProblems ?? []).length > 0

function cases() {
  return [
    {
      id: 'G1',
      title: 'direct grader import from a normal product module',
      expectFile: PROMPT_COMMAND,
      expectReason: GRADER_TRUTH_REACHABLE,
      expectRule: 'normal_product_root',
      premise: premiseAncestor(PROMPT_COMMAND),
      inject(snapshot) {
        snapshot.append(PROMPT_COMMAND, [
          '',
          '// #660-A G1 injection',
          "import { loadBenchmarkRuntimeProofProfiles } from './benchmark/runtime-proof.js'",
          'export const __g1Probe = loadBenchmarkRuntimeProofProfiles',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G2',
      title: 'transitive grader reach through a neutral helper',
      expectFile: MCP_TOOLS,
      expectReason: GRADER_TRUTH_REACHABLE,
      expectRule: 'normal_product_root',
      expectChainIncludes: PROBE_HELPER,
      premise: premiseAncestor(MCP_TOOLS),
      inject(snapshot) {
        snapshot.write(PROBE_HELPER, [
          '// #660-A G2 injection: a neutral-looking helper that reaches the grader.',
          "import { loadBenchmarkRuntimeProofProfiles } from '../infrastructure/benchmark/runtime-proof.js'",
          '',
          'export function probeHelper(): unknown {',
          '  return loadBenchmarkRuntimeProofProfiles',
          '}',
          '',
        ].join('\n'))
        snapshot.append(MCP_TOOLS, [
          '',
          '// #660-A G2 injection',
          "import { probeHelper } from '../../shared/__grader_boundary_probe_helper.js'",
          'export const __g2Probe = probeHelper',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G3',
      title: 'grader truth exposed through an intermediate re-export',
      expectFile: PROMPT_COMMAND,
      expectReason: GRADER_TRUTH_REACHABLE,
      expectRule: 'normal_product_root',
      expectChainIncludes: PROBE_REEXPORT,
      premise: premiseAncestor(PROMPT_COMMAND),
      inject(snapshot) {
        snapshot.write(PROBE_REEXPORT, [
          '// #660-A G3 injection: re-export only, no local use.',
          "export { loadBenchmarkRuntimeProofProfiles } from '../infrastructure/benchmark/runtime-proof.js'",
          '',
        ].join('\n'))
        snapshot.append(PROMPT_COMMAND, [
          '',
          '// #660-A G3 injection',
          "import { loadBenchmarkRuntimeProofProfiles } from '../shared/__grader_boundary_probe_reexport.js'",
          'export const __g3Probe = loadBenchmarkRuntimeProofProfiles',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G6',
      title: 'direct filesystem read of the grader data file from normal product code',
      expectFile: PROMPT_COMMAND,
      expectReason: GRADER_TRUTH_REACHABLE,
      expectRule: 'direct_data_read_in_normal_product',
      premise: premiseDataReference(PROMPT_COMMAND),
      inject(snapshot) {
        snapshot.append(PROMPT_COMMAND, [
          '',
          '// #660-A G6 injection: no import at all, just the path.',
          "export const __g6Probe = 'docs/benchmarks/suite/runtime-proof.json'",
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G7',
      title: 'grader import written as a backtick template specifier',
      expectFile: PROMPT_COMMAND,
      expectReason: GRADER_TRUTH_REACHABLE,
      expectRule: 'normal_product_root',
      premise: premiseAncestor(PROMPT_COMMAND),
      inject(snapshot) {
        // A NoSubstitutionTemplateLiteral is not a StringLiteral. Missing this
        // shape left a real runtime edge invisible to the graph.
        snapshot.append(PROMPT_COMMAND, [
          '',
          '// #660-A G7 injection',
          'export const __g7Probe = async (): Promise<unknown> => await import(`./benchmark/runtime-proof.js`)',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G8',
      title: 'a third computed import in an already-approved file is still refused',
      expectFile: SEMANTIC,
      expectReason: COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED,
      expectRule: 'computed_specifier_not_exactly_allowed',
      // This is the reproduced FINAL finding: the two legitimate call sites are
      // left untouched, and a third one — able to resolve to the grader loader —
      // is added to the same file. A file-keyed allowance approved it silently.
      premise: premiseComputedCount(SEMANTIC, 3),
      inject(snapshot) {
        snapshot.append(SEMANTIC, [
          '',
          '// #660-A G8 injection: a third computed site in an approved file.',
          "const __g8Target: string = ['..', 'infrastructure', 'benchmark', 'runtime-proof.js'].join('/')",
          'export const __g8Probe = async (): Promise<unknown> => await import(__g8Target)',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G9',
      title: 'changing an approved computed expression breaks its fingerprint',
      expectFile: SEMANTIC,
      expectReason: COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED,
      expectRule: 'computed_specifier_not_exactly_allowed',
      premise: premiseComputedExpression(SEMANTIC, '__g9Redirected'),
      inject(snapshot) {
        // Same file, same enclosing declaration, same count — only the
        // expression changes, which is exactly how a swapped target would look.
        snapshot.replaceOnce(
          SEMANTIC,
          'await import(OPTIONAL_TRANSFORMERS_PACKAGE)',
          'await import(__g9Redirected)',
        )
        snapshot.replaceOnce(
          SEMANTIC,
          "const OPTIONAL_TRANSFORMERS_PACKAGE = '@huggingface/transformers'",
          "const OPTIONAL_TRANSFORMERS_PACKAGE = '@huggingface/transformers'\nconst __g9Redirected: string = OPTIONAL_TRANSFORMERS_PACKAGE",
        )
      },
    },
    {
      id: 'G10',
      title: 'a surplus computed allowance with no call site is refused',
      expectFile: SEMANTIC,
      expectReason: COMPUTED_DYNAMIC_IMPORT_NOT_EXACTLY_ALLOWED,
      expectRule: 'computed_allowance_unused',
      // Configuration-level: nothing is injected into the tree, so the premise
      // is that the extra allowance is present and unmatched.
      premise: (result) => (result.unusedComputedAllowances ?? []).length === 1,
      configure(config) {
        return {
          ...config,
          allowed_computed_dynamic_imports: [
            ...config.allowed_computed_dynamic_imports,
            {
              path: SEMANTIC,
              kind: 'dynamic-import',
              enclosing_declaration: 'aFunctionThatDoesNotExist',
              expression: 'someVariableThatIsNeverImported',
              role: 'plausible-looking but unreal',
              justification: 'a standing permission for an import that does not exist anywhere in the tree',
            },
          ],
        }
      },
    },
    {
      id: 'G11',
      title: 'direct grader-loader import from the mixed CLI router is refused',
      expectFile: CLI_MAIN,
      expectReason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
      expectRule: 'router_edge_into_grader_loader',
      // Being a legitimate mixed router must not suppress this.
      premise: premiseRouterEdge(CLI_MAIN, '../infrastructure/benchmark/runtime-proof.js'),
      inject(snapshot) {
        snapshot.append(CLI_MAIN, [
          '',
          '// #660-A G11 injection',
          "import { loadBenchmarkRuntimeProofProfiles } from '../infrastructure/benchmark/runtime-proof.js'",
          'export const __g11Probe = loadBenchmarkRuntimeProofProfiles',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G12',
      title: 'a new transitive grader edge from the mixed router is refused',
      expectFile: CLI_MAIN,
      expectReason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
      expectRule: 'router_edge_not_approved',
      expectChainIncludes: ROUTER_PROBE_HELPER,
      premise: premiseRouterEdge(CLI_MAIN, '../infrastructure/__grader_boundary_router_probe.js'),
      inject(snapshot) {
        snapshot.write(ROUTER_PROBE_HELPER, [
          '// #660-A G12 injection: an intermediate that reaches the grader.',
          "import { loadBenchmarkRuntimeProofProfiles } from './benchmark/runtime-proof.js'",
          '',
          'export function routerProbe(): unknown {',
          '  return loadBenchmarkRuntimeProofProfiles',
          '}',
          '',
        ].join('\n'))
        snapshot.append(CLI_MAIN, [
          '',
          '// #660-A G12 injection',
          "import { routerProbe } from '../infrastructure/__grader_boundary_router_probe.js'",
          'export const __g12Probe = routerProbe',
          '',
        ].join('\n'))
      },
    },
    {
      id: 'G15',
      title: 'widening an approved router edge to import more bindings is refused',
      expectFile: CLI_MAIN,
      expectReason: UNAPPROVED_MIXED_ROUTER_GRADER_EDGE,
      expectRule: 'router_edge_bindings_changed',
      premise: (result) => (result.routerEdges ?? []).some((edge) => (
        edge.from === CLI_MAIN
        && edge.specifier === '../infrastructure/compare.js'
        && edge.imported_bindings.includes('buildMadarPromptPack')
      )),
      inject(snapshot) {
        // The specifier and destination are unchanged; only the surface the
        // router pulls across the boundary grows.
        snapshot.replaceOnce(
          CLI_MAIN,
          "import { BenchmarkReadinessError, NativeAgentInstallRequiredError, runCompareCommand } from '../infrastructure/compare.js'",
          "import { BenchmarkReadinessError, NativeAgentInstallRequiredError, runCompareCommand, buildMadarPromptPack } from '../infrastructure/compare.js'",
        )
      },
    },
    {
      id: 'G16',
      title: 'a direct grader data-file reference in the mixed router is refused',
      expectFile: CLI_MAIN,
      expectReason: GRADER_TRUTH_REACHABLE,
      expectRule: 'direct_data_read_in_mixed_router',
      premise: premiseDataReference(CLI_MAIN),
      inject(snapshot) {
        snapshot.append(CLI_MAIN, [
          '',
          '// #660-A G16 injection',
          "export const __g16Probe = 'docs/benchmarks/suite/runtime-proof.json'",
          '',
        ].join('\n'))
      },
    },
  ]
}

export function runGraderBoundarySelfTest({ root = process.cwd(), log = console.log } = {}) {
  const results = []

  const baseConfig = JSON.parse(readFileSync(resolve(root, 'docs/architecture/grader-boundary.json'), 'utf8'))

  // G4 and G13 read the untouched tree first, so a broken baseline is reported
  // as such rather than as a failed injection.
  invalidateGraderBoundaryCache()
  const baseline = analyzeGraderBoundary({ root, cache: false })

  results.push({
    id: 'G4',
    title: 'legitimate dedicated grader and benchmark ancestors remain accepted',
    passed: baseline.ok === true && (baseline.dedicatedAncestors ?? []).length > 0,
    detail: baseline.ok
      ? `clean; ${baseline.dedicatedAncestors.length} dedicated ancestor(s): ${baseline.dedicatedAncestors.join(', ')}`
      : `baseline is NOT clean: ${(baseline.violations ?? []).map((violation) => `${violation.file} [${violation.rule}]`).join(', ')}`,
  })

  const declaredEdges = baseConfig.allowed_mixed_router_edges ?? []
  const observedEdges = baseline.routerEdges ?? []
  const everyEdgeApproved = observedEdges.length > 0 && observedEdges.every((edge) => edge.approved)
  const oneForOne = observedEdges.length === declaredEdges.length
    && (baseline.unusedRouterAllowances ?? []).length === 0
  results.push({
    id: 'G13',
    title: 'every existing compare/benchmark/eval router edge is accepted and matched exactly once',
    passed: baseline.ok === true && everyEdgeApproved && oneForOne,
    detail: `${observedEdges.length} observed edge(s), ${declaredEdges.length} declared, `
      + `${(baseline.unusedRouterAllowances ?? []).length} unused; `
      + observedEdges.map((edge) => `${edge.from} -> ${edge.resolved}`).join(' | '),
  })

  const computedSites = baseline.computedSpecifiers ?? []
  const declaredComputed = baseConfig.allowed_computed_dynamic_imports ?? []
  results.push({
    id: 'G17',
    title: 'every computed import site is matched by exactly one call-site allowance',
    passed: baseline.ok === true
      && computedSites.length === declaredComputed.length
      && (baseline.unusedComputedAllowances ?? []).length === 0
      && declaredComputed.every((entry) => typeof entry.enclosing_declaration === 'string' && entry.enclosing_declaration.length > 0),
    detail: `${computedSites.length} site(s), ${declaredComputed.length} allowance(s), `
      + `${(baseline.unusedComputedAllowances ?? []).length} unused; `
      + computedSites.map((site) => `${site.path}::${site.enclosing_declaration}`).join(' | '),
  })

  for (const testCase of cases()) {
    const snapshot = new ByteSnapshot(root)
    let passed = false
    let detail = ''
    try {
      if (testCase.inject) testCase.inject(snapshot)
      const config = testCase.configure ? testCase.configure(baseConfig) : baseConfig

      invalidateGraderBoundaryCache()
      const injected = analyzeGraderBoundary({ root, config, cache: false })

      // The premise is the observable fact the injection was supposed to create.
      // Checking it first is what stops a silently no-op injection from looking
      // like a working control.
      const premiseHolds = testCase.premise(injected)
      const violation = (injected.violations ?? []).find((candidate) => (
        candidate.file === testCase.expectFile && candidate.rule === testCase.expectRule
      ))

      if (!premiseHolds) {
        detail = `the injected premise is absent from the analysis, so the control proves nothing`
      } else if (!violation) {
        const seen = (injected.violations ?? []).map((entry) => `${entry.file} [${entry.rule}]`).join(', ')
        detail = `guard did NOT report ${testCase.expectRule} for ${testCase.expectFile}; saw: ${seen || '(no violations)'}`
      } else if (violation.reason !== testCase.expectReason) {
        detail = `wrong reason: ${violation.reason} (expected ${testCase.expectReason})`
      } else if (testCase.expectChainIncludes && !violation.chain.includes(testCase.expectChainIncludes)) {
        detail = `chain did not name the intermediate ${testCase.expectChainIncludes}: ${violation.chain.join(' -> ')}`
      } else if (injected.ok !== false) {
        detail = 'guard reported ok despite a violation'
      } else {
        passed = true
        detail = `${violation.reason} / ${violation.rule}`
          + (violation.chain.length > 0 ? ` :: ${violation.chain.join(' -> ')}` : '')
      }
    } catch (error) {
      detail = `threw: ${error?.message ?? String(error)}`
    } finally {
      const unrestored = snapshot.restore()
      if (unrestored.length > 0) {
        passed = false
        detail = `${detail} | FAILED TO RESTORE: ${unrestored.join(', ')}`
      }
    }
    results.push({ id: testCase.id, title: testCase.title, passed, detail })
  }

  // A malformed configuration must be refused as configuration, not silently
  // treated as an empty allowlist.
  invalidateGraderBoundaryCache()
  const fileWideAttempt = analyzeGraderBoundary({
    root,
    cache: false,
    config: {
      ...baseConfig,
      allowed_computed_dynamic_imports: [{
        path: SEMANTIC,
        kind: 'dynamic-import',
        role: 'file-wide',
        justification: 'an attempt to approve a whole file rather than one exact call site',
      }],
    },
  })
  results.push({
    id: 'G18',
    title: 'a file-wide computed allowance with no call site identity is refused as configuration',
    passed: fileWideAttempt.ok === false
      && fileWideAttempt.reason === GRADER_BOUNDARY_CONFIG_INVALID
      && premiseConfigRefused()(fileWideAttempt)
      && fileWideAttempt.configProblems.some((problem) => problem.includes('file-wide computed allowance is never accepted')),
    detail: fileWideAttempt.configProblems?.join(' | ') || 'configuration was NOT refused',
  })

  invalidateGraderBoundaryCache()
  const wholeRouterAttempt = analyzeGraderBoundary({
    root,
    cache: false,
    config: {
      ...baseConfig,
      allowed_grader_ancestors: [
        ...baseConfig.allowed_grader_ancestors,
        { path: CLI_MAIN, role: 'grader', justification: 'an attempt to trust the mixed router as a whole module again' },
      ],
    },
  })
  results.push({
    id: 'G19',
    title: 'trusting a mixed router as a whole module is refused as configuration',
    passed: wholeRouterAttempt.ok === false
      && wholeRouterAttempt.reason === GRADER_BOUNDARY_CONFIG_INVALID
      && wholeRouterAttempt.configProblems.some((problem) => problem.includes('must be approved edge by edge')),
    detail: wholeRouterAttempt.configProblems?.join(' | ') || 'configuration was NOT refused',
  })

  // The tree must be exactly as it was. Verified by re-running the untouched
  // analysis rather than by trusting the restore loop.
  invalidateGraderBoundaryCache()
  const after = analyzeGraderBoundary({ root, cache: false })
  const probesGone = ![PROBE_HELPER, PROBE_REEXPORT, ROUTER_PROBE_HELPER].some((path) => existsSync(resolve(root, path)))
  results.push({
    id: 'G0',
    title: 'worktree restored: post-injection analysis matches the baseline',
    passed: after.ok === baseline.ok
      && JSON.stringify(after.ancestors) === JSON.stringify(baseline.ancestors)
      && JSON.stringify(after.routerEdges) === JSON.stringify(baseline.routerEdges)
      && JSON.stringify(after.computedSpecifiers) === JSON.stringify(baseline.computedSpecifiers)
      && probesGone,
    detail: `ok=${after.ok} ancestors=${(after.ancestors ?? []).length} routerEdges=${(after.routerEdges ?? []).length} `
      + `computedSites=${(after.computedSpecifiers ?? []).length} probes-removed=${probesGone}`,
  })

  for (const result of results) {
    log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id}  ${result.title}`)
    log(`         ${result.detail}`)
  }

  return { ok: results.every((result) => result.passed), results }
}
