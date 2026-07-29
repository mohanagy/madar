import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

// Development-only JavaScript is deliberately outside the production TypeScript build.
// @ts-expect-error -- the isolated evaluator does not ship declarations in the npm package
import * as contractValidation from '../../tools/eval/core-reset/contract-validation.mjs'
// @ts-expect-error -- development-only isolation support is not part of the npm declaration surface
import * as isolationSupport from '../../tools/eval/core-reset/isolation-support.mjs'
const {
  evidencePathsForPhase,
  validateContractSemantics,
  validateHistoricalBaselineReceipt,
} = contractValidation
const {
  evaluationPackageBudget,
  evaluationToolingMoves,
} = isolationSupport

type JsonObject = Record<string, any>

const readJson = (path: string): JsonObject =>
  JSON.parse(readFileSync(resolve(path), 'utf8')) as JsonObject

function validator(schema: JsonObject) {
  // @ts-expect-error -- Ajv's NodeNext declaration shape differs from its runtime default export
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  // @ts-expect-error -- ajv-formats has the same NodeNext runtime/declaration mismatch
  addFormats(ajv)
  return ajv.compile(schema)
}

describe('Core Reset baseline contract', () => {
  const contractPath = 'tools/eval/core-reset/contracts/evaluation-contract.json'
  const contractSchemaPath = 'tools/eval/core-reset/schemas/evaluation-contract.schema.json'
  const receiptSchemaPath = 'tools/eval/core-reset/schemas/baseline-receipt.schema.json'
  const acceptedReceiptPath = 'docs/core-reset/evidence/baseline-v0.32.0.json'

  it('schema-validates the frozen contract and its semantic invariants', () => {
    const contract = readJson(contractPath)
    const validate = validator(readJson(contractSchemaPath))

    expect(validate(contract), JSON.stringify(validate.errors)).toBe(true)
    expect(validateContractSemantics(contract)).toBe(true)
    expect(contract.product_scope.supported_languages).toEqual(['typescript', 'javascript'])
    expect(contract.product_scope.excluded_languages).toEqual(['go'])
    expect(contract.questions
      .filter((question: JsonObject) => question.gate_role === 'scope_guard')
      .every((question: JsonObject) => question.comparison_role === 'diagnostic_only')).toBe(true)
    expect(contract.questions
      .filter((question: JsonObject) => question.gate_role === 'blocking')
      .every((question: JsonObject) => question.comparison_role === 'included')).toBe(true)
    expect(contract.questions.flatMap((question: JsonObject) => question.source_issues)).toEqual(
      expect.arrayContaining([565, 574]),
    )
  })

  it('keeps the committed v1 receipt immutable without regrading it as v2 evidence', () => {
    const contract = readJson(contractPath)
    const receipt = readJson(acceptedReceiptPath)
    const validate = validator(readJson(receiptSchemaPath))

    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true)
    expect(validateHistoricalBaselineReceipt(receipt, contract)).toBe(true)
    expect(receipt.contract_id).toBe(contract.amendment.historical_baseline_binding.contract_id)
    expect(receipt.contract_id).not.toBe(contract.contract_id)
    expect(receipt.baseline_target).toMatchObject({
      commit: contract.baseline.madar.commit,
      source_tree_matches_baseline: true,
      worktree_dirty: false,
    })
    expect(receipt.production_source.production_loc_delta).toEqual({
      added: 0,
      removed: 0,
      net: 0,
    })
    expect(receipt.one_call_retrieval.status).toBe('measured')
  })

  it('rejects duplicate ids, dangling repositories, unverified paths, and comparator drift', () => {
    const duplicate = structuredClone(readJson(contractPath))
    duplicate.questions[1].id = duplicate.questions[0].id
    expect(() => validateContractSemantics(duplicate)).toThrow(/question ids must be unique/)

    const dangling = structuredClone(readJson(contractPath))
    dangling.questions[0].repository_id = 'missing-repository'
    expect(() => validateContractSemantics(dangling)).toThrow(/unknown repository/)

    const unverified = structuredClone(readJson(contractPath))
    unverified.owner_fixtures[0].source_file = 'packages/lib/not/in/the/pinned/tree.ts'
    expect(() => validateContractSemantics(unverified)).toThrow(/not verified against the pinned repository tree/)

    const unfair = structuredClone(readJson(contractPath))
    unfair.protocols.graphify.allowed_repository_tools.push('unbounded-extra-search')
    expect(() => validateContractSemantics(unfair)).toThrow(/tool surface must match/)

    const unsafeStrictProfile = structuredClone(readJson(contractPath))
    unsafeStrictProfile.protocols.madar_strict_diagnostic.allowed_repository_tools = ['shell', 'search']
    expect(() => validateContractSemantics(unsafeStrictProfile)).toThrow(/retrieve and focused read/)

    const comparisonDrift = structuredClone(readJson(contractPath))
    comparisonDrift.questions[0].comparison_role = 'included'
    expect(() => validateContractSemantics(comparisonDrift)).toThrow(/comparison role must match/)

    const scopeDrift = structuredClone(readJson(contractPath))
    scopeDrift.product_scope.supported_languages = ['typescript', 'go']
    expect(() => validateContractSemantics(scopeDrift)).toThrow(/support TypeScript and JavaScript/)

    const graphifyStructuredDrift = structuredClone(readJson(contractPath))
    graphifyStructuredDrift.trial_design.graphify_build.directed = true
    expect(() => validateContractSemantics(graphifyStructuredDrift)).toThrow(/frozen structured comparator contract/)

    const conditionDrift = structuredClone(readJson(contractPath))
    conditionDrift.trial_design.condition_matrix.cells[2].condition = 'cold'
    expect(() => validateContractSemantics(conditionDrift)).toThrow(/trial condition cells must be unique/)

    const providerCostDrift = structuredClone(readJson(contractPath))
    providerCostDrift.measurements.index_costs.metrics = providerCostDrift.measurements.index_costs.metrics
      .filter((metric: string) => metric !== 'graph build provider total tokens')
    expect(() => validateContractSemantics(providerCostDrift)).toThrow(/graph-build and refresh provider tokens/)

    const cliInstrumentationDrift = structuredClone(readJson(contractPath))
    cliInstrumentationDrift.measurements.baseline_targets.cli_startup.measurement_command
      = cliInstrumentationDrift.measurements.baseline_targets.cli_startup.subject_command
    expect(() => validateContractSemantics(cliInstrumentationDrift)).toThrow(/disclosed RSS preload/)

    const refreshPatchDrift = structuredClone(readJson(contractPath))
    refreshPatchDrift.trial_design.refresh_measurement.repositories[0].mutation.patch_utf8 += '\n'
    expect(() => validateContractSemantics(refreshPatchDrift)).toThrow(/patch byte count must match/)

    const refreshCommandDrift = structuredClone(readJson(contractPath))
    refreshCommandDrift.trial_design.refresh_measurement.commands.graphify.refresh.argv = ['extract', '.', '--code-only']
    expect(() => validateContractSemantics(refreshCommandDrift)).toThrow(/refresh commands and artifacts/)

  })

  it('binds every owner and unsupported-boundary path to a verified pinned tree', () => {
    const contract = readJson(contractPath)
    const repositories = new Map(
      contract.repositories.map((repository: JsonObject) => [repository.id, repository]),
    )
    const fixtures = new Map(
      contract.owner_fixtures.map((fixture: JsonObject) => [fixture.id, fixture]),
    )

    for (const question of contract.questions) {
      const repository = repositories.get(question.repository_id) as JsonObject
      expect(repository.evidence_path_base).toBe('repository_root')
      for (const phase of question.required_phases) {
        const paths = evidencePathsForPhase(phase, contract)
        for (const path of paths) {
          expect(repository.verified_evidence_paths).toContain(path)
          expect(path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|\*/)
        }
        if (phase.scope === 'required') {
          expect(phase.evidence_match).toBe('exact_owner_fixture')
          for (const ownerId of phase.accepted_owner_ids) {
            const fixture = fixtures.get(ownerId) as JsonObject
            expect(fixture.repository_id).toBe(question.repository_id)
            expect(paths).toContain(fixture.source_file)
            expect(fixture.declaration_range.start.line).toBeGreaterThan(0)
            expect(fixture.declaration_range.start.column).toBeGreaterThan(0)
            expect(fixture.declaration_sha256).toMatch(/^[0-9a-f]{64}$/)
          }
        } else {
          expect(phase.boundary_kind).toBe('unsupported')
          expect(paths).toEqual(phase.boundary_subjects)
        }
      }
    }
  })

  it('keeps evaluation tooling outside the production build and package allowlist', () => {
    const build = readJson('tsconfig.build.json')
    const evalBuild = readJson('tsconfig.eval.json')
    const manifest = readJson('package.json')
    const ignoreRules = readFileSync(resolve('.gitignore'), 'utf8').split(/\r?\n/u)
    const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
      .replaceAll('\r\n', '\n')
    const expectedSources = [
      'src/infrastructure/benchmark.ts',
      'src/infrastructure/benchmark/corpus.ts',
      'src/infrastructure/benchmark/environment.ts',
      'src/infrastructure/benchmark/generate-performance.ts',
      'src/infrastructure/benchmark/quality.ts',
      'src/infrastructure/benchmark/questions.ts',
      'src/infrastructure/benchmark/runner.ts',
      'src/infrastructure/benchmark/runtime-proof.ts',
      'src/infrastructure/benchmark/suite.ts',
      'src/infrastructure/benchmark/usage.ts',
      'src/infrastructure/compare.ts',
      'src/infrastructure/prompt-runner.ts',
      'src/infrastructure/save-query-result.ts',
      'src/infrastructure/try-command.ts',
      'src/runtime/benchmark/probe-calibration.ts',
      'src/shared/graph-source-root.ts',
      'src/shared/package-metadata.ts',
      'src/shared/share-safe-artifacts.ts',
      'src/shared/shell.ts',
      'src/shared/workspace-copy.ts',
    ]

    expect(build.compilerOptions.rootDir).toBe('src')
    expect(build.compilerOptions.outDir).toBe('dist/src')
    expect(build.compilerOptions.removeComments).toBe(true)
    expect(build.compilerOptions.noEmitOnError).toBe(true)
    expect(readJson('tsconfig.json').compilerOptions).not.toHaveProperty('removeComments')
    expect(evalBuild.compilerOptions).not.toHaveProperty('removeComments')
    expect(build.include).toEqual(['src/**/*.ts'])
    expect(evalBuild).toMatchObject({
      extends: './tsconfig.json',
      compilerOptions: {
        rootDir: '.',
        outDir: 'dist-eval',
        noEmitOnError: true,
      },
      include: ['tools/eval/lib/**/*.ts'],
    })
    expect(evalBuild.exclude).toEqual(expect.arrayContaining([
      'tests/**/*.ts',
      'dist',
      'dist-eval',
      'vitest.config.ts',
    ]))
    expect(evaluationToolingMoves.map(({ source }: { source: string }) => source))
      .toEqual(expectedSources)
    expect(evaluationToolingMoves.map(({ destination }: { destination: string }) => destination))
      .toEqual(expectedSources.map((path) => path.replace(/^src\//u, 'tools/eval/lib/')))
    for (const { source, destination } of evaluationToolingMoves) {
      expect(existsSync(resolve(source)), `${source} must be deleted`).toBe(false)
      expect(existsSync(resolve(destination)), `${destination} must exist`).toBe(true)
    }
    expect(evaluationPackageBudget).toEqual({
      files_max: 102,
      packed_bytes_max: 165_000,
      unpacked_bytes_max: 640_000,
    })
    expect(manifest.files.every((path: string) =>
      !path.startsWith('tools/') &&
      !path.startsWith('docs/') &&
      !path.startsWith('dist-eval/'))).toBe(true)
    expect(manifest.scripts['build:eval']).toBe('tsc -p tsconfig.eval.json')
    expect(manifest.scripts.build).toBe('tsc -p tsconfig.build.json')
    expect(manifest.scripts.prepack).toBe('npm run clean && npm run build')
    expect(manifest.scripts.clean).not.toMatch(/(?:build:eval|tsconfig\.eval|dist-eval|tools\/eval)/u)
    expect(ignoreRules).toContain('dist-eval/')
    expect(ignoreRules.some((rule) => rule.startsWith('!dist-eval'))).toBe(false)
    expect(ciWorkflow).toContain(
      '      - name: Build evaluation tooling\n        run: npm run build:eval',
    )
    expect(Object.keys(manifest.scripts).some((name) => name.startsWith('core-reset:'))).toBe(false)
  })
})
