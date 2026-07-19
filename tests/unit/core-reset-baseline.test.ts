import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

// Development-only JavaScript is deliberately outside the production TypeScript build.
// @ts-expect-error -- the isolated evaluator does not ship declarations in the npm package
import { validateContractSemantics, validateReceiptSemantics } from '../../tools/eval/core-reset/contract-validation.mjs'
// @ts-expect-error -- the isolated evaluator does not ship declarations in the npm package
import { controlledEnvironment, importedSpecifiers, normalizedEvidenceFile } from '../../tools/eval/core-reset/record-baseline.mjs'
// @ts-expect-error -- the isolated evaluator does not ship declarations in the npm package
import { treePathHash, verifyRepository } from '../../tools/eval/core-reset/verify-held-out-repositories.mjs'

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

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

const fixtureHash = (character: string): string => character.repeat(64)

function semanticReceipt(contract: JsonObject): JsonObject {
  const targets = contract.measurements.baseline_targets
  const strictQuestion = contract.questions.find(
    (question: JsonObject) => question.id === 'openstatus-574-strict-one-call',
  ) as JsonObject
  const repository = contract.repositories.find(
    (candidate: JsonObject) => candidate.id === strictQuestion.repository_id,
  ) as JsonObject
  const snippetFiles = [...new Set(strictQuestion.required_phases.flatMap((phase: JsonObject) =>
    phase.expected_evidence_paths.slice(0, phase.minimum_path_matches)))] as string[]
  const phaseCoverage = strictQuestion.required_phases.map((phase: JsonObject) => ({
    phase: phase.id,
    scope: phase.scope,
    matched_paths: phase.expected_evidence_paths.filter((path: string) => snippetFiles.includes(path)),
    verification_target_paths: [],
    covered: true,
    reachable_after_focused_reads: true,
  }))
  const scenario = (operation: string, character: string): JsonObject => ({
    operation,
    equal_to_clean_generation: true,
    incremental_nodes: 3,
    clean_nodes: 3,
    incremental_edges: 2,
    clean_edges: 2,
    incremental_graph_sha256: fixtureHash(character),
    clean_graph_sha256: fixtureHash(character),
    ...(operation === 'linked_worktree'
      ? { artifact_outside_worktree: true, worktree_elapsed_ms: 10, clean_elapsed_ms: 20 }
      : {
          update_elapsed_ms: 10,
          clean_elapsed_ms: 20,
        }),
  })
  const artifactFilename = 'lubab-madar-0.32.0.tgz'
  const dependencyLock = {
    name: 'core-reset-fixture',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [contract.baseline.madar.name]: `file:../${artifactFilename}` } },
      [`node_modules/${contract.baseline.madar.name}`]: { version: contract.baseline.madar.version },
    },
  }

  return {
    schema_version: 1,
    receipt_id: 'semantic-receipt-fixture',
    generated_at: '2026-07-19T00:00:00.000Z',
    share_safe: true,
    contract_id: contract.contract_id,
    contract_sha256: digest(contract),
    baseline_target: {
      package: contract.baseline.madar.name,
      version: contract.baseline.madar.version,
      commit: contract.baseline.madar.commit,
      checkout_commit: contract.baseline.madar.commit,
      source_tree_matches_baseline: true,
      worktree_dirty: false,
      commands: [['npx', 'vitest', 'run', 'tests/unit/core-reset-baseline.test.ts']],
    },
    environment: {
      platform: 'darwin',
      release: 'test',
      architecture: 'arm64',
      node: 'v22.0.0',
      npm: '11.0.0',
      git: 'git version 2.50.0',
      cpu_count: 8,
      controlled_environment: {
        policy: 'core-reset-controlled-v1',
        locale: 'C',
        timezone: 'UTC',
        npm_registry: 'https://registry.npmjs.org/',
        node_options: 'cleared',
        node_path: 'cleared',
        madar_variables: 'cleared_except_explicit_probe_flags',
        git_configuration: 'system_and_global_disabled; checkout_core.autocrlf=false; checkout_core.eol=lf',
      },
    },
    production_source: {
      files: targets.production_source.expected_files,
      loc: targets.production_source.expected_loc,
      expected_files: targets.production_source.expected_files,
      expected_loc: targets.production_source.expected_loc,
      matches_expected: true,
      filesystem_violations: [],
      production_loc_delta: { added: 0, removed: 0, net: 0 },
    },
    package: {
      status: 'measured',
      artifact_filename: artifactFilename,
      artifact_sha256: fixtureHash('a'),
      install_command: ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', `../${artifactFilename}`],
      install_elapsed_ms: 100,
      resolved_dependency_lock: dependencyLock,
      resolved_dependency_lock_sha256: digest(dependencyLock),
      resolved_dependency_count: 1,
      file_count: 100,
      packed_bytes: 500_000,
      unpacked_bytes: 1_000_000,
      targets: {
        file_count_max: targets.package.file_count_max,
        unpacked_bytes_max: targets.package.unpacked_bytes_max,
      },
      target_passed: true,
      forbidden_paths: [],
      forbidden_metadata: [],
    },
    cli_startup: {
      status: 'measured',
      command: ['node', '<packed-install>/dist/src/cli/bin.js', '--version'],
      cold_process_samples: [
        { elapsed_ms: 10, peak_rss_bytes: 1_000 },
        { elapsed_ms: 20, peak_rss_bytes: 3_000 },
        { elapsed_ms: 30, peak_rss_bytes: 2_000 },
      ],
      median_elapsed_ms: 20,
      max_peak_rss_bytes: 3_000,
      targets: {
        elapsed_ms_max: targets.cli_startup.elapsed_ms_max,
        peak_rss_bytes_max: targets.cli_startup.peak_rss_bytes_max,
      },
      target_passed: true,
      cache_caveat: 'Fresh processes; operating-system page caches are not flushed.',
    },
    mcp_startup: {
      status: 'measured',
      profile: 'core',
      command: ['node', '<packed-install>/dist/src/cli/bin.js', 'serve', '<graph.json>', '--stdio'],
      cold_process_samples: [
        { initialize_ms: 100, tools_list_ms: 200, tool_count: 2, public_tools: ['retrieve', 'status'] },
        { initialize_ms: 200, tools_list_ms: 300, tool_count: 2, public_tools: ['retrieve', 'status'] },
        { initialize_ms: 300, tools_list_ms: 400, tool_count: 2, public_tools: ['retrieve', 'status'] },
      ],
      median_initialize_ms: 200,
      median_tools_list_ms: 300,
      public_tool_count: 2,
      public_tools: ['retrieve', 'status'],
      target_tools_list_ms: targets.mcp_startup.tools_list_ms_max,
      target_tool_count_max: targets.mcp_startup.tool_count_max,
      latency_target_passed: true,
      tool_count_target_passed: true,
      target_passed: true,
    },
    graph_contract: {
      status: 'measured',
      command: ['node', 'tools/eval/core-reset/record-baseline.mjs', '<graph-contract-probe>'],
      directed: true,
      loaded_directed: true,
      node_ids_present: true,
      edge_ids_present: true,
      parallel_edge_kinds_input: ['calls', 'imports_from'],
      parallel_edge_kinds_output: ['calls', 'imports_from'],
      parallel_edges_preserved: true,
      opposite_directions_preserved: true,
      provenance_preserved_after_round_trip: true,
      serialization_round_trip_preserved: true,
      serialized_node_ids: ['source', 'target'],
      loaded_node_ids: ['source', 'target'],
      serialized_node_count: 2,
      serialized_node_id_count: 2,
      serialized_edge_id_count: 3,
      serialized_edge_tuples: [
        'source -> target [calls]',
        'source -> target [imports_from]',
        'target -> source [returns_to]',
      ],
      loaded_edge_tuples: [
        'source -> target [calls]',
        'source -> target [imports_from]',
        'target -> source [returns_to]',
      ],
      serialized_contract_sha256: fixtureHash('3'),
      loaded_contract_sha256: fixtureHash('3'),
      serialized_provenance_sha256: fixtureHash('4'),
      loaded_provenance_sha256: fixtureHash('4'),
      serialized_provenance_entry_count: 5,
      loaded_provenance_entry_count: 5,
      observed_edge_count: 3,
      expected_multigraph_edge_count: 3,
    },
    default_extraction: {
      status: 'measured',
      command: ['node', '<packed-install>/dist/src/cli/bin.js', 'generate', '<fixture>', '--no-html'],
      requested_extraction_mode: 'auto',
      extraction_strategy_buckets: { spi: 4 },
      capability_buckets: { spi_supported: 4 },
      auto_summary: 'spi=4',
      supported_fixture_extensions: [...targets.default_extraction.expected_extensions],
      fixture_symbol_evidence: [
        { extension: '.js', source_file: 'src/route.js', expected_symbol: 'postOrder', indexed: true, matched_node_ids: ['route_postorder'] },
        { extension: '.jsx', source_file: 'src/badge.jsx', expected_symbol: 'OrderBadge', indexed: true, matched_node_ids: ['badge_orderbadge'] },
        { extension: '.ts', source_file: 'src/repository.ts', expected_symbol: 'saveOrder', indexed: true, matched_node_ids: ['repository_saveorder'] },
        { extension: '.tsx', source_file: 'src/view.tsx', expected_symbol: 'OrderView', indexed: true, matched_node_ids: ['view_orderview'] },
      ],
      generated_graph_directed: true,
      loaded_graph_directed: true,
      generated_graph_direction_preserved: true,
      canonicalization_excluded_fields: ['generated_at', 'graph_build_freshness', 'root_path'],
      first_node_count: 10,
      first_valid_node_id_count: 10,
      first_unique_node_id_count: 10,
      second_node_count: 10,
      second_valid_node_id_count: 10,
      second_unique_node_id_count: 10,
      generated_node_ids_present_and_unique: true,
      first_node_ids_sha256: fixtureHash('b'),
      second_node_ids_sha256: fixtureHash('b'),
      first_graph_sha256: fixtureHash('c'),
      second_graph_sha256: fixtureHash('c'),
      stable_node_ids_across_clean_rebuilds: true,
      stable_serialized_graph_across_clean_rebuilds: true,
    },
    incremental_equivalence: {
      status: 'measured',
      command: ['node', '<packed-install>/dist/src/cli/bin.js', 'generate', '<fixture>', '--update', '--no-html'],
      canonicalization_excluded_fields: ['generated_at', 'graph_build_freshness', 'root_path'],
      scenarios: [
        scenario('add', 'd'),
        scenario('change', 'e'),
        scenario('delete', 'f'),
        scenario('rename', '1'),
        scenario('linked_worktree', '2'),
      ],
      all_equal_to_clean_generation: true,
    },
    one_call_retrieval: {
      status: 'measured',
      question_id: strictQuestion.id,
      command: ['node', 'tools/eval/core-reset/record-baseline.mjs', '--retrieval-repository', '<openstatus-checkout>'],
      repository: repository.url,
      repository_commit: repository.commit,
      source_tree_paths_sha256: repository.tree_paths_sha256,
      generator_artifact_sha256: fixtureHash('a'),
      graph_sha256: fixtureHash('d'),
      graph_build_elapsed_ms: 100,
      graph_artifact_bytes: 1_000,
      graph_freshness: { head_sha: repository.commit, dirty_file_count: 0 },
      graph_requested_extraction_mode: 'auto',
      graph_nodes: 10,
      graph_edges: 12,
      mcp_initialize_ms: 50,
      elapsed_ms: 100,
      reported_context_token_count: 1_000,
      serialized_response_bytes: 2_000,
      provider_total_input_tokens: null,
      matched_file_count: snippetFiles.length,
      matched_files: snippetFiles,
      snippet_file_count: snippetFiles.length,
      snippet_files: snippetFiles,
      verification_target_file_count: 0,
      verification_target_files: [],
      returned_file_count: snippetFiles.length,
      returned_files: snippetFiles,
      snippet_count: snippetFiles.length,
      snippets: snippetFiles.map((sourceFile) => ({
        label: sourceFile,
        source_file: sourceFile,
        line_number: 1,
        preview: 'fixture evidence',
        sha256: fixtureHash('e'),
      })),
      phase_coverage: phaseCoverage,
      in_scope_phase_coverage: 1,
      answerability: 'ready',
      coverage: 'complete',
      pack_confidence: 'high',
      focused_verification_reads: 0,
      focused_reads_note: 'No focused reads were executed by this direct MCP characterization.',
    },
    unknowns: [{
      field: 'one_call_retrieval.provider_total_input_tokens',
      reason: 'The direct MCP probe has no provider session.',
      reproduction_command: ['agent', 'run', strictQuestion.id],
    }],
    isolation: {
      build_root: 'src',
      build_output: 'dist/src',
      production_import_violations: [],
      production_evaluation_leaks: [],
      package_forbidden_paths: [],
      package_forbidden_metadata: [],
    },
  }
}

describe('Core Reset baseline contract', () => {
  const contractPath = 'tools/eval/core-reset/contracts/evaluation-contract.json'
  const contractSchemaPath = 'tools/eval/core-reset/schemas/evaluation-contract.schema.json'
  const receiptSchemaPath = 'tools/eval/core-reset/schemas/baseline-receipt.schema.json'

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

  it('rejects duplicate ids, dangling repositories, unverified paths, and comparator drift', () => {
    const duplicate = structuredClone(readJson(contractPath))
    duplicate.questions[1].id = duplicate.questions[0].id
    expect(() => validateContractSemantics(duplicate)).toThrow(/question ids must be unique/)

    const dangling = structuredClone(readJson(contractPath))
    dangling.questions[0].repository_id = 'missing-repository'
    expect(() => validateContractSemantics(dangling)).toThrow(/unknown repository/)

    const unverified = structuredClone(readJson(contractPath))
    unverified.questions[0].required_phases[0].expected_evidence_paths[0] = 'not/in/the/pinned/tree.ts'
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

    const graphifyCommandDrift = structuredClone(readJson(contractPath))
    graphifyCommandDrift.protocols.graphify.steps = graphifyCommandDrift.protocols.graphify.steps.map(
      (step: string) => step.replace('["extract",".","--code-only"]', '[".","--directed"]'),
    )
    expect(() => validateContractSemantics(graphifyCommandDrift)).toThrow(/pinned supported code-only extract argv/)

    const graphifyStructuredDrift = structuredClone(readJson(contractPath))
    graphifyStructuredDrift.trial_design.graphify_build.directed = true
    expect(() => validateContractSemantics(graphifyStructuredDrift)).toThrow(/frozen structured comparator contract/)

    const conditionDrift = structuredClone(readJson(contractPath))
    conditionDrift.trial_design.condition_matrix.cells[2].condition = 'cold'
    expect(() => validateContractSemantics(conditionDrift)).toThrow(/trial condition cells must be unique/)

    const isolationDrift = structuredClone(readJson(contractPath))
    isolationDrift.trial_design.execution_isolation.realpath_policy = 'Paths are checked before each tool call.'
    expect(() => validateContractSemantics(isolationDrift)).toThrow(/filesystem, configuration, and logging isolation/)

    const providerCostDrift = structuredClone(readJson(contractPath))
    providerCostDrift.measurements.index_costs.metrics = providerCostDrift.measurements.index_costs.metrics
      .filter((metric: string) => metric !== 'graph build provider total tokens')
    expect(() => validateContractSemantics(providerCostDrift)).toThrow(/graph-build provider tokens/)
  })

  it('binds every expected path to a verified pinned-tree path in one coordinate system', () => {
    const contract = readJson(contractPath)
    const repositories = new Map(
      contract.repositories.map((repository: JsonObject) => [repository.id, repository]),
    )

    for (const question of contract.questions) {
      const repository = repositories.get(question.repository_id) as JsonObject
      expect(repository.evidence_path_base).toBe('repository_root')
      for (const phase of question.required_phases) {
        expect(phase.path_match).toBe('exact')
        for (const path of phase.expected_evidence_paths) {
          expect(repository.verified_evidence_paths).toContain(path)
          expect(path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|\*/)
        }
      }
    }
  })

  it('rejects retrieved evidence paths that escape or do not name a file', () => {
    const parent = mkdtempSync(join(tmpdir(), 'core-reset-paths-'))
    const graphRoot = join(parent, 'graph-root')
    const sourceDirectory = join(graphRoot, 'src')
    const sourceFile = join(sourceDirectory, 'service.ts')
    const outsideFile = join(parent, 'outside.ts')
    mkdirSync(sourceDirectory, { recursive: true })
    writeFileSync(sourceFile, 'export const value = true\n')
    writeFileSync(outsideFile, 'export const outside = true\n')
    try {
      expect(normalizedEvidenceFile('src/service.ts', graphRoot)).toBe('src/service.ts')
      expect(normalizedEvidenceFile(sourceFile, graphRoot)).toBe('src/service.ts')
      expect(() => normalizedEvidenceFile('../secret.ts', graphRoot)).toThrow(/safe repository-relative file/)
      expect(() => normalizedEvidenceFile('..\\secret.ts', graphRoot)).toThrow(/safe repository-relative file/)
      expect(() => normalizedEvidenceFile('src/../../secret.ts', graphRoot)).toThrow(/safe repository-relative file/)
      expect(() => normalizedEvidenceFile(outsideFile, graphRoot)).toThrow(/outside graph_root/)
      expect(() => normalizedEvidenceFile(`${graphRoot}/../secret.ts`, graphRoot)).toThrow(/outside graph_root/)
      expect(() => normalizedEvidenceFile(`${graphRoot}/src\/..\/..\/outside.ts`, graphRoot)).toThrow(/outside graph_root/)
      expect(() => normalizedEvidenceFile('src/missing.ts', graphRoot)).toThrow(/does not exist/)
      expect(() => normalizedEvidenceFile('src', graphRoot)).toThrow(/not a regular file/)
      if (process.platform !== 'win32') {
        symlinkSync(outsideFile, join(sourceDirectory, 'escaped.ts'))
        expect(() => normalizedEvidenceFile('src/escaped.ts', graphRoot)).toThrow(/symbolic link/)
        const internalDirectory = join(graphRoot, 'internal')
        mkdirSync(internalDirectory)
        writeFileSync(join(internalDirectory, 'inside.ts'), 'export const inside = true\n')
        symlinkSync(internalDirectory, join(graphRoot, 'internal-link'))
        expect(() => normalizedEvidenceFile('internal-link/inside.ts', graphRoot)).toThrow(/traverses a symbolic link/)
      }
      expect(() => normalizedEvidenceFile(graphRoot, graphRoot)).toThrow(/graph root, not a file/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('clears ambient Git execution and object-replacement controls', () => {
    const previous = {
      externalDiff: process.env.GIT_EXTERNAL_DIFF,
      indexFile: process.env.GIT_INDEX_FILE,
      objectDirectory: process.env.GIT_OBJECT_DIRECTORY,
      replaceRefs: process.env.GIT_REPLACE_REF_BASE,
    }
    Object.assign(process.env, {
      GIT_EXTERNAL_DIFF: '/tmp/untrusted-diff',
      GIT_INDEX_FILE: '/tmp/untrusted-index',
      GIT_OBJECT_DIRECTORY: '/tmp/untrusted-objects',
      GIT_REPLACE_REF_BASE: 'refs/untrusted/',
    })
    try {
      const environment = controlledEnvironment()
      expect(environment.GIT_EXTERNAL_DIFF).toBeUndefined()
      expect(environment.GIT_INDEX_FILE).toBeUndefined()
      expect(environment.GIT_OBJECT_DIRECTORY).toBeUndefined()
      expect(environment.GIT_REPLACE_REF_BASE).toBeUndefined()
      expect(environment.GIT_NO_REPLACE_OBJECTS).toBe('1')
      expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
      expect(() => controlledEnvironment({ GIT_EXTERNAL_DIFF: '/tmp/override' })).toThrow(/does not accept Git override/)
    } finally {
      for (const [name, value] of Object.entries({
        GIT_EXTERNAL_DIFF: previous.externalDiff,
        GIT_INDEX_FILE: previous.indexFile,
        GIT_OBJECT_DIRECTORY: previous.objectDirectory,
        GIT_REPLACE_REF_BASE: previous.replaceRefs,
      })) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('detects static, side-effect, dynamic, and CommonJS imports into evaluation tooling', () => {
    const source = [
      "import value from '../tools/eval/value.js'",
      "import '../tools/eval/side-effect.js'",
      'const dynamic = import(`../tools/eval/dynamic.js`)',
      "const common = require('../tools/eval/common.cjs')",
      "const resolved = require.resolve('../tools/eval/resolved.cjs')",
      "// import '../tools/eval/comment-only.js'",
    ].join('\n')
    expect(importedSpecifiers(source)).toEqual([
      '../tools/eval/value.js',
      '../tools/eval/side-effect.js',
      '../tools/eval/dynamic.js',
      '../tools/eval/common.cjs',
      '../tools/eval/resolved.cjs',
    ])
  })

  it('verifies frozen Git blobs and rejects symlink evidence entries', () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), 'core-reset-held-out-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repositoryRoot })
      execFileSync('git', ['config', 'user.email', 'core-reset@example.invalid'], { cwd: repositoryRoot })
      execFileSync('git', ['config', 'user.name', 'Core Reset'], { cwd: repositoryRoot })
      mkdirSync(join(repositoryRoot, 'src'))
      writeFileSync(join(repositoryRoot, 'src', 'service.ts'), 'export const service = true\n')
      if (process.platform !== 'win32') symlinkSync('service.ts', join(repositoryRoot, 'src', 'alias.ts'))
      execFileSync('git', ['add', '.'], { cwd: repositoryRoot })
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repositoryRoot })
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
      const repository = {
        id: 'fixture',
        commit,
        tree_paths_sha256: treePathHash(repositoryRoot, commit),
        graph_root: '.',
        verified_evidence_paths: ['src/service.ts'],
      }
      expect(verifyRepository(repository, repositoryRoot)).toMatchObject({
        id: 'fixture',
        commit,
        verified_evidence_paths: 1,
      })
      if (process.platform !== 'win32') {
        repository.verified_evidence_paths = ['src/alias.ts']
        expect(() => verifyRepository(repository, repositoryRoot)).toThrow(/symbolic link/)
      }
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('requires all load-bearing measured receipt fields', () => {
    const schema = readJson(receiptSchemaPath)
    const graphRequired = schema.$defs.graph_contract.required as string[]
    const extractionRequired = schema.$defs.default_extraction.required as string[]
    const incrementalRequired = schema.$defs.incremental_equivalence.required as string[]
    const retrievalRequired = schema.$defs.retrieval_measured.required as string[]

    expect(graphRequired).toEqual(expect.arrayContaining([
      'parallel_edges_preserved',
      'edge_ids_present',
      'serialization_round_trip_preserved',
    ]))
    expect(extractionRequired).toEqual(expect.arrayContaining([
      'requested_extraction_mode',
      'stable_node_ids_across_clean_rebuilds',
    ]))
    expect(incrementalRequired).toEqual(expect.arrayContaining([
      'scenarios',
      'all_equal_to_clean_generation',
    ]))
    expect(retrievalRequired).toEqual(expect.arrayContaining([
      'generator_artifact_sha256',
      'source_tree_paths_sha256',
      'phase_coverage',
      'serialized_response_bytes',
    ]))

    const validate = validator(schema)
    expect(validate({
      status: 'measured',
      command: ['placeholder'],
    })).toBe(false)
  })

  it('accepts only receipt statistics and thresholds derived from the frozen contract', () => {
    const contract = readJson(contractPath)
    const schemaValidate = validator(readJson(receiptSchemaPath))
    const receipt = semanticReceipt(contract)
    expect(schemaValidate(receipt), JSON.stringify(schemaValidate.errors)).toBe(true)
    expect(validateReceiptSemantics(receipt, contract)).toBe(true)

    const cliMedian = semanticReceipt(contract)
    cliMedian.cli_startup.median_elapsed_ms = 21
    expect(() => validateReceiptSemantics(cliMedian, contract)).toThrow(/CLI median must be derived/)

    const cliRss = semanticReceipt(contract)
    cliRss.cli_startup.max_peak_rss_bytes = 2_000
    expect(() => validateReceiptSemantics(cliRss, contract)).toThrow(/CLI maximum RSS must be derived/)

    const cliSamples = semanticReceipt(contract)
    cliSamples.cli_startup.cold_process_samples.pop()
    expect(() => validateReceiptSemantics(cliSamples, contract)).toThrow(/CLI sample count must match/)

    const mcpSamples = semanticReceipt(contract)
    mcpSamples.mcp_startup.cold_process_samples.pop()
    expect(() => validateReceiptSemantics(mcpSamples, contract)).toThrow(/MCP sample count must match/)

    const mcpInitialize = semanticReceipt(contract)
    mcpInitialize.mcp_startup.median_initialize_ms = 201
    expect(() => validateReceiptSemantics(mcpInitialize, contract)).toThrow(/MCP initialize median must be derived/)

    const mcpToolsList = semanticReceipt(contract)
    mcpToolsList.mcp_startup.median_tools_list_ms = 301
    expect(() => validateReceiptSemantics(mcpToolsList, contract)).toThrow(/MCP tools\/list median must be derived/)

    const mcpSampleTools = semanticReceipt(contract)
    mcpSampleTools.mcp_startup.cold_process_samples[0].tool_count = 3
    expect(() => validateReceiptSemantics(mcpSampleTools, contract)).toThrow(/every MCP sample tool list/)

    const mcpSameCountDifferentTools = semanticReceipt(contract)
    mcpSameCountDifferentTools.mcp_startup.cold_process_samples[0].public_tools = ['retrieve', 'version']
    expect(() => validateReceiptSemantics(mcpSameCountDifferentTools, contract)).toThrow(/every MCP sample tool list/)

    const packageTarget = semanticReceipt(contract)
    packageTarget.package.targets.file_count_max += 1
    expect(() => validateReceiptSemantics(packageTarget, contract)).toThrow(/package targets must match/)

    const dependencyLock = semanticReceipt(contract)
    dependencyLock.package.resolved_dependency_lock.packages.extra = { version: '9.9.9' }
    expect(() => validateReceiptSemantics(dependencyLock, contract)).toThrow(/dependency lock hash/)

    const dependencyCount = semanticReceipt(contract)
    dependencyCount.package.resolved_dependency_count = 2
    expect(() => validateReceiptSemantics(dependencyCount, contract)).toThrow(/dependency count must match/)

    const installCommand = semanticReceipt(contract)
    installCommand.package.install_command.push('--force')
    expect(() => validateReceiptSemantics(installCommand, contract)).toThrow(/install command must install only/)

    const cliTarget = semanticReceipt(contract)
    cliTarget.cli_startup.targets.elapsed_ms_max += 1
    expect(() => validateReceiptSemantics(cliTarget, contract)).toThrow(/CLI targets must match/)

    const mcpTarget = semanticReceipt(contract)
    mcpTarget.mcp_startup.target_tools_list_ms += 1
    expect(() => validateReceiptSemantics(mcpTarget, contract)).toThrow(/MCP latency target must match/)

    const extractionTarget = semanticReceipt(contract)
    extractionTarget.default_extraction.supported_fixture_extensions.pop()
    expect(() => validateReceiptSemantics(extractionTarget, contract)).toThrow(/must be derived from indexed files with matching graph symbols/)

    const extractionWithoutSymbol = semanticReceipt(contract)
    extractionWithoutSymbol.default_extraction.fixture_symbol_evidence[0].matched_node_ids = []
    expect(() => validateReceiptSemantics(extractionWithoutSymbol, contract)).toThrow(/must be derived from indexed files with matching graph symbols/)
  })

  it('rejects self-reported source, graph, extraction, and incremental claims', () => {
    const contract = readJson(contractPath)

    const sourceMismatch = semanticReceipt(contract)
    sourceMismatch.production_source.files -= 1
    sourceMismatch.production_source.matches_expected = false
    sourceMismatch.baseline_target.source_tree_matches_baseline = false
    expect(() => validateReceiptSemantics(sourceMismatch, contract)).toThrow(/production source must match the frozen baseline/)
    expect(validateReceiptSemantics(sourceMismatch, contract, { requireSourceMatch: false })).toBe(true)

    const invalidDelta = semanticReceipt(contract)
    invalidDelta.production_source.production_loc_delta = { added: 1, removed: 1, net: 1 }
    invalidDelta.production_source.matches_expected = false
    invalidDelta.baseline_target.source_tree_matches_baseline = false
    expect(() => validateReceiptSemantics(invalidDelta, contract, { requireSourceMatch: false })).toThrow(/net delta must match/)

    const sameLengthWrongRelations = semanticReceipt(contract)
    sameLengthWrongRelations.graph_contract.parallel_edge_kinds_output = ['calls', 'returns']
    expect(() => validateReceiptSemantics(sameLengthWrongRelations, contract)).toThrow(/exact observed relation multiset/)

    const redirectedRoundTrip = semanticReceipt(contract)
    redirectedRoundTrip.graph_contract.loaded_edge_tuples[0] = 'source -> source [calls]'
    expect(() => validateReceiptSemantics(redirectedRoundTrip, contract)).toThrow(/successful serialization round trip/)

    const changedSerializedAttributes = semanticReceipt(contract)
    changedSerializedAttributes.graph_contract.loaded_contract_sha256 = fixtureHash('6')
    expect(() => validateReceiptSemantics(changedSerializedAttributes, contract)).toThrow(/serialization round-trip flag/)

    const missingLoadedDirection = semanticReceipt(contract)
    missingLoadedDirection.graph_contract.loaded_edge_tuples = [
      'source -> target [calls]',
      'source -> target [imports_from]',
      'source -> target [returns_to]',
    ]
    expect(() => validateReceiptSemantics(missingLoadedDirection, contract)).toThrow(/opposite-direction flag/)

    const lostProvenance = semanticReceipt(contract)
    lostProvenance.graph_contract.loaded_provenance_sha256 = fixtureHash('5')
    expect(() => validateReceiptSemantics(lostProvenance, contract)).toThrow(/provenance round-trip flag/)

    const defaultNodeFlag = semanticReceipt(contract)
    defaultNodeFlag.default_extraction.second_node_ids_sha256 = fixtureHash('9')
    expect(() => validateReceiptSemantics(defaultNodeFlag, contract)).toThrow(/node-id stability flag/)

    const missingGeneratedIds = semanticReceipt(contract)
    missingGeneratedIds.default_extraction.first_valid_node_id_count -= 1
    expect(() => validateReceiptSemantics(missingGeneratedIds, contract)).toThrow(/node-id presence and uniqueness flag/)

    const defaultGraphFlag = semanticReceipt(contract)
    defaultGraphFlag.default_extraction.second_graph_sha256 = fixtureHash('8')
    expect(() => validateReceiptSemantics(defaultGraphFlag, contract)).toThrow(/graph stability flag/)

    const generatedDirectionFlag = semanticReceipt(contract)
    generatedDirectionFlag.default_extraction.loaded_graph_directed = false
    expect(() => validateReceiptSemantics(generatedDirectionFlag, contract)).toThrow(/generated graph direction round-trip flag/)

    const incrementalFlag = semanticReceipt(contract)
    incrementalFlag.incremental_equivalence.scenarios[0].clean_graph_sha256 = fixtureHash('7')
    expect(() => validateReceiptSemantics(incrementalFlag, contract)).toThrow(/add equality flag/)

    const incrementalCounts = semanticReceipt(contract)
    incrementalCounts.incremental_equivalence.scenarios[0].clean_nodes += 1
    expect(() => validateReceiptSemantics(incrementalCounts, contract)).toThrow(/equal graphs must have equal node and edge counts/)

    const extractionExclusions = semanticReceipt(contract)
    extractionExclusions.default_extraction.canonicalization_excluded_fields.pop()
    expect(() => validateReceiptSemantics(extractionExclusions, contract)).toThrow(/canonicalization exclusions must match/)

    const incrementalExclusions = semanticReceipt(contract)
    incrementalExclusions.incremental_equivalence.canonicalization_excluded_fields.push('nodes')
    expect(() => validateReceiptSemantics(incrementalExclusions, contract)).toThrow(/canonicalization exclusions must match/)
  })

  it('requires measured retrieval for accepted receipts but permits explicit diagnostics', () => {
    const contract = readJson(contractPath)
    const receipt = semanticReceipt(contract)
    receipt.one_call_retrieval = {
      status: 'unknown',
      question_id: 'openstatus-574-strict-one-call',
      command: ['node', 'tools/eval/core-reset/record-baseline.mjs'],
      focused_verification_reads: 0,
      reason: 'No local OpenStatus checkout was supplied.',
    }
    receipt.unknowns.push({
      field: 'one_call_retrieval',
      reason: 'No local OpenStatus checkout was supplied.',
      reproduction_command: ['node', 'tools/eval/core-reset/record-baseline.mjs', '--retrieval-repository', '<openstatus-checkout>'],
    })

    expect(() => validateReceiptSemantics(receipt, contract)).toThrow(/must include measured one-call retrieval/)
    expect(validateReceiptSemantics(receipt, contract, { requireMeasuredRetrieval: false })).toBe(true)
  })

  it('binds retrieval phase claims to snippet and verification-target evidence', () => {
    const contract = readJson(contractPath)

    const inventedMatchedPath = semanticReceipt(contract)
    inventedMatchedPath.one_call_retrieval.phase_coverage[0].matched_paths = ['invented/path.ts']
    expect(() => validateReceiptSemantics(inventedMatchedPath, contract)).toThrow(/matched paths must be exact frozen paths backed by snippets/)

    const pathOnlyMatch = semanticReceipt(contract)
    const checkerPath = pathOnlyMatch.one_call_retrieval.phase_coverage[0].matched_paths[0]
    pathOnlyMatch.one_call_retrieval.snippets = pathOnlyMatch.one_call_retrieval.snippets.filter(
      (snippet: JsonObject) => snippet.source_file !== checkerPath,
    )
    pathOnlyMatch.one_call_retrieval.snippet_files = pathOnlyMatch.one_call_retrieval.snippet_files.filter(
      (path: string) => path !== checkerPath,
    )
    pathOnlyMatch.one_call_retrieval.snippet_count -= 1
    pathOnlyMatch.one_call_retrieval.snippet_file_count -= 1
    expect(() => validateReceiptSemantics(pathOnlyMatch, contract)).toThrow(/matched paths must be exact frozen paths backed by snippets/)

    const inventedVerificationPath = semanticReceipt(contract)
    inventedVerificationPath.one_call_retrieval.phase_coverage[0].verification_target_paths = ['invented/path.ts']
    expect(() => validateReceiptSemantics(inventedVerificationPath, contract)).toThrow(/verification paths must be exact frozen paths/)

    const wrongCoverage = semanticReceipt(contract)
    wrongCoverage.one_call_retrieval.phase_coverage[0].covered = false
    expect(() => validateReceiptSemantics(wrongCoverage, contract)).toThrow(/covered flag must match snippet evidence/)

    const whitespaceSnippet = semanticReceipt(contract)
    whitespaceSnippet.one_call_retrieval.snippets[0].preview = '   '
    expect(() => validateReceiptSemantics(whitespaceSnippet, contract)).toThrow(/snippet evidence must contain non-empty content/)

    const budgetContract = structuredClone(contract)
    budgetContract.measurements.machine_gates.focused_reads_max = 1
    const budgetReceipt = semanticReceipt(budgetContract)
    const phase = budgetContract.questions
      .find((question: JsonObject) => question.id === 'openstatus-574-strict-one-call')
      .required_phases.find((candidate: JsonObject) => candidate.id === 'notification_delivery')
    const phaseResult = budgetReceipt.one_call_retrieval.phase_coverage.find(
      (candidate: JsonObject) => candidate.phase === phase.id,
    )
    for (const path of phaseResult.matched_paths) {
      budgetReceipt.one_call_retrieval.snippets = budgetReceipt.one_call_retrieval.snippets.filter(
        (snippet: JsonObject) => snippet.source_file !== path,
      )
      budgetReceipt.one_call_retrieval.snippet_files = budgetReceipt.one_call_retrieval.snippet_files.filter(
        (snippetPath: string) => snippetPath !== path,
      )
      if (!budgetReceipt.one_call_retrieval.verification_target_files.includes(path)) {
        budgetReceipt.one_call_retrieval.verification_target_files.push(path)
      }
    }
    budgetReceipt.one_call_retrieval.snippet_count = budgetReceipt.one_call_retrieval.snippets.length
    budgetReceipt.one_call_retrieval.snippet_file_count = budgetReceipt.one_call_retrieval.snippet_files.length
    budgetReceipt.one_call_retrieval.verification_target_file_count =
      budgetReceipt.one_call_retrieval.verification_target_files.length
    budgetReceipt.one_call_retrieval.returned_files = [...new Set([
      ...budgetReceipt.one_call_retrieval.matched_files,
      ...budgetReceipt.one_call_retrieval.verification_target_files,
    ])]
    budgetReceipt.one_call_retrieval.returned_file_count = budgetReceipt.one_call_retrieval.returned_files.length
    phaseResult.matched_paths = []
    phaseResult.verification_target_paths = phase.expected_evidence_paths.slice(0, phase.minimum_path_matches)
    phaseResult.covered = false
    phaseResult.reachable_after_focused_reads = false
    budgetReceipt.one_call_retrieval.in_scope_phase_coverage = 0.75
    expect(validateReceiptSemantics(budgetReceipt, budgetContract)).toBe(true)

    phaseResult.reachable_after_focused_reads = true
    expect(() => validateReceiptSemantics(budgetReceipt, budgetContract)).toThrow(/global focused-read budget/)
  })

  it('keeps evaluation tooling outside the production build and package allowlist', () => {
    const build = readJson('tsconfig.build.json')
    const manifest = readJson('package.json')
    const recorder = readFileSync(resolve('tools/eval/core-reset/record-baseline.mjs'), 'utf8')

    expect(build.compilerOptions.rootDir).toBe('src')
    expect(build.compilerOptions.outDir).toBe('dist/src')
    expect(build.compilerOptions.noEmitOnError).toBe(true)
    expect(build.include).toEqual(['src/**/*.ts'])
    expect(manifest.files).not.toEqual(expect.arrayContaining(['tools/', 'docs/']))
    expect(Object.keys(manifest.scripts).some((name) => name.startsWith('core-reset:'))).toBe(false)
    expect(recorder).toContain('createPackedArtifact')
    expect(recorder).toContain("'--retrieval-repository'")
    expect(recorder).toContain('exportModule.toJson')
    expect(recorder).toContain('serveModule.loadGraph')
    expect(recorder).not.toContain('production_loc_delta: { added: 0, removed: 0, net: 0 }')
  })
})
