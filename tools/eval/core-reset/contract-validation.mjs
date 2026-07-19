import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

function assert(condition, message) {
  if (!condition) throw new Error(`Evaluation contract invariant failed: ${message}`)
}

function assertUnique(values, label) {
  assert(new Set(values).size === values.length, `${label} must be unique`)
}

function isInsideGraphRoot(path, graphRoot) {
  if (graphRoot === '.') return true
  return path === graphRoot || path.startsWith(`${graphRoot}/`)
}

export function validateContractSemantics(contract) {
  const repositories = contract.repositories ?? []
  const questions = contract.questions ?? []
  const supportedLanguages = new Set(contract.product_scope?.supported_languages ?? [])
  const excludedLanguages = new Set(contract.product_scope?.excluded_languages ?? [])
  assert(supportedLanguages.has('typescript') && supportedLanguages.has('javascript'), 'product scope must support TypeScript and JavaScript')
  assert(excludedLanguages.has('go'), 'product scope must explicitly exclude Go')
  assert(
    [...supportedLanguages].every((language) => !excludedLanguages.has(language)),
    'supported and excluded language sets must not overlap',
  )
  assertUnique(repositories.map((repository) => repository.id), 'repository ids')
  assertUnique(questions.map((question) => question.id), 'question ids')
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))

  for (const repository of repositories) {
    assert(!isAbsolute(repository.graph_root), `${repository.id} graph_root must be relative`)
    assert(!repository.graph_root.split('/').includes('..'), `${repository.id} graph_root must not escape the checkout`)
    assertUnique(repository.verified_evidence_paths, `${repository.id} verified evidence paths`)
    for (const path of repository.verified_evidence_paths) {
      assert(!isAbsolute(path), `${repository.id} verified path must be repository-relative`)
      assert(!path.includes('*'), `${repository.id} verified path must not contain a wildcard`)
      assert(!path.split('/').includes('..'), `${repository.id} verified path must not escape the checkout`)
      assert(isInsideGraphRoot(path, repository.graph_root), `${repository.id} verified path is outside graph_root`)
    }
  }

  for (const question of questions) {
    const repository = repositoriesById.get(question.repository_id)
    assert(repository !== undefined, `${question.id} references unknown repository ${question.repository_id}`)
    assert(question.gate_role === repository.role, `${question.id} gate role must match repository role`)
    assert(
      question.comparison_role === contract.product_scope.comparison_question_roles[question.gate_role],
      `${question.id} comparison role must match its gate role`,
    )
    assertUnique(question.required_phases.map((phase) => phase.id), `${question.id} phase ids`)
    const unsupported = question.required_phases.filter((phase) => phase.scope === 'unsupported_language')
    if (question.gate_role === 'blocking') {
      assert(unsupported.length === 0, `${question.id} blocking question cannot require unsupported languages`)
      assert(
        repository.languages.every((language) => supportedLanguages.has(language)),
        `${question.id} blocking repository must stay inside product scope`,
      )
    } else {
      assert(unsupported.length > 0, `${question.id} scope guard must name an unsupported-language phase`)
      assert(question.required_phases.some((phase) => phase.scope === 'required'), `${question.id} scope guard must retain an in-scope phase`)
    }
    for (const phase of question.required_phases) {
      assert(phase.path_match === 'exact', `${question.id}/${phase.id} must use exact path matching`)
      assertUnique(phase.expected_evidence_paths, `${question.id}/${phase.id} expected paths`)
      assert(
        phase.minimum_path_matches <= phase.expected_evidence_paths.length,
        `${question.id}/${phase.id} minimum_path_matches exceeds its path count`,
      )
      for (const path of phase.expected_evidence_paths) {
        assert(!isAbsolute(path), `${question.id}/${phase.id} path must be repository-relative`)
        assert(!path.includes('*'), `${question.id}/${phase.id} path must not contain a wildcard`)
        assert(!path.split('/').includes('..'), `${question.id}/${phase.id} path must not escape the checkout`)
        assert(isInsideGraphRoot(path, repository.graph_root), `${question.id}/${phase.id} path is outside graph_root`)
        assert(
          repository.verified_evidence_paths.includes(path),
          `${question.id}/${phase.id} path was not verified against the pinned repository tree`,
        )
      }
    }
  }

  const issueInputs = new Set(questions.flatMap((question) => question.source_issues))
  assert(issueInputs.has(565), 'issue #565 must remain a frozen input')
  assert(issueInputs.has(574), 'issue #574 must remain a frozen input')
  const commonRawTools = [...contract.protocols.common.allowed_repository_tools].sort()
  const expectedArmTools = {
    native_agent: commonRawTools,
    graphify: [...commonRawTools, 'graphify-mcp'].sort(),
    madar: [...commonRawTools, 'madar-mcp'].sort(),
  }
  for (const [arm, expectedTools] of Object.entries(expectedArmTools)) {
    const armTools = [...contract.protocols[arm].allowed_repository_tools].sort()
    assert(JSON.stringify(armTools) === JSON.stringify(expectedTools), `${arm} tool surface must match the frozen fair protocol`)
  }
  assert(
    contract.protocols.madar_strict_diagnostic.allowed_repository_tools.length === 2,
    'strict diagnostic must remain separate and bounded',
  )
  assert(
    JSON.stringify([...contract.protocols.madar_strict_diagnostic.allowed_repository_tools].sort())
      === JSON.stringify(['focused-read', 'madar-retrieve']),
    'strict diagnostic must expose only retrieve and focused read',
  )
  assert(contract.trial_design.trials_per_temperature >= 3, 'at least three trials are required')
  assert(contract.trial_design.total_tool_call_budget > 0, 'comparative tool budget must be positive')
  const graphifyBuildStep = contract.protocols.graphify.steps.find((step) => step.startsWith('At graph_root invoke')) ?? ''
  assert(
    JSON.stringify(contract.trial_design.graphify_build) === JSON.stringify({
      executable: 'graphify',
      argv: ['extract', '.', '--code-only'],
      code_only: true,
      directed: false,
      artifact: 'graphify-out/graph.json',
      build_provider_tokens_expected_total: 0,
    }),
    'Graphify build settings must match the frozen structured comparator contract',
  )
  assert(
    graphifyBuildStep.includes('argv: ["extract",".","--code-only"]'),
    'Graphify must use its pinned supported code-only extract argv',
  )
  assert(
    graphifyBuildStep.includes('default undirected graph semantics')
      && graphifyBuildStep.includes('do not pass unsupported --directed or --no-viz flags'),
    'Graphify must remain an explicitly undirected code-only comparator',
  )
  assert(
    contract.protocols.graphify.required_capture.includes('canonical resolved Python dependency manifest and SHA-256')
      && contract.protocols.madar.required_capture.includes('canonical complete resolved npm package-lock and SHA-256'),
    'both graph arms must capture exact resolved dependency evidence',
  )
  const expectedConditionCells = [
    'native_agent:native',
    'graphify:cold',
    'graphify:warm',
    'madar:cold',
    'madar:warm',
  ]
  const conditionCells = contract.trial_design.condition_matrix.cells
  assertUnique(conditionCells.map((cell) => `${cell.arm}:${cell.condition}`), 'trial condition cells')
  assert(
    JSON.stringify(conditionCells.map((cell) => `${cell.arm}:${cell.condition}`))
      === JSON.stringify(expectedConditionCells),
    'trial condition matrix must contain the frozen native/cold/warm cells',
  )
  assert(
    conditionCells.every((cell) => cell.trials === contract.trial_design.trials_per_temperature)
      && conditionCells.reduce((total, cell) => total + cell.trials, 0) === 15,
    'trial condition matrix must schedule three trials per cell and fifteen answers per block',
  )
  const dependencyEnvironment = contract.trial_design.dependency_environment
  assert(
    dependencyEnvironment.canonicalization.includes('RFC 8785')
      && dependencyEnvironment.reuse_rule.includes('recompute')
      && dependencyEnvironment.mismatch_policy.includes('invalidates the entire comparison block'),
    'dependency manifests must be canonical, rechecked, and block-scoped',
  )
  const isolation = contract.trial_design.execution_isolation
  assert(
    isolation.filesystem_root.includes('realpath')
      && isolation.realpath_policy.includes('symlink')
      && isolation.ephemeral_configuration.includes('HOME')
      && isolation.forbidden_context.includes('evaluation contract')
      && isolation.graphify_logging.includes('GRAPHIFY_QUERY_LOG_DISABLE=1')
      && isolation.update_checks.includes('prohibit'),
    'comparative trials must enforce frozen filesystem, configuration, and logging isolation',
  )
  const conditionPolicy = contract.human_rubric.condition_policy
  assert(
    sameValues(conditionPolicy.graph_conditions, ['cold', 'warm'])
      && conditionPolicy.graph_pass_requirement.includes('both cold and warm')
      && conditionPolicy.break_even_condition.includes('warm task latency'),
    'aggregation, pass/fail, and break-even must remain condition-aware',
  )
  assert(contract.measurements.index_costs.capture_stage === 'comparative_trials', 'index-cost distributions belong to comparative trials')
  assert(contract.measurements.index_costs.baseline_receipt_requirement === 'not_required', 'baseline receipt must not fabricate cross-arm index distributions')
  assert(
    ['graph build provider input tokens', 'graph build provider output tokens', 'graph build provider total tokens']
      .every((metric) => contract.measurements.index_costs.metrics.includes(metric))
      && contract.measurements.index_costs.graph_build_provider_tokens.graphify_code_only_expected_total === 0,
    'index costs must capture graph-build provider tokens and Graphify code-only zero',
  )
  assert(
    sameValues(contract.anti_tuning.agent_inputs, ['product_scope_statement', 'frozen_prompt', 'target_repository']),
    'agent inputs must expose only scope, prompt, and target repository',
  )
  return true
}

function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

function roundMilliseconds(value) {
  return Number(value.toFixed(3))
}

function sameValues(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

const canonicalGraphExcludedFields = ['generated_at', 'graph_build_freshness', 'root_path']
const defaultExtractionFixtureSymbols = {
  '.js': { source_file: 'src/route.js', expected_symbol: 'postOrder' },
  '.jsx': { source_file: 'src/badge.jsx', expected_symbol: 'OrderBadge' },
  '.ts': { source_file: 'src/repository.ts', expected_symbol: 'saveOrder' },
  '.tsx': { source_file: 'src/view.tsx', expected_symbol: 'OrderView' },
}

function expectedPackedFilename(packageName, version) {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
}

export function validateReceiptSemantics(receipt, contract, options = {}) {
  const requireClean = options.requireClean !== false
  const requireSourceMatch = options.requireSourceMatch !== false
  const requireMeasuredRetrieval = options.requireMeasuredRetrieval !== false
  assert(receipt.contract_id === contract.contract_id, 'receipt contract_id must match the frozen contract')
  assert(receipt.contract_sha256 === canonicalSha256(contract), 'receipt contract hash must use canonical JSON')
  assert(receipt.baseline_target.package === contract.baseline.madar.name, 'receipt baseline package must match the contract')
  assert(receipt.baseline_target.version === contract.baseline.madar.version, 'receipt baseline version must match the contract')
  assert(receipt.baseline_target.commit === contract.baseline.madar.commit, 'receipt baseline commit must match the contract')
  if (requireClean) assert(receipt.baseline_target.worktree_dirty === false, 'accepted receipt must come from a clean evidence checkout')

  const source = receipt.production_source
  const delta = source.production_loc_delta
  const baselineTargets = contract.measurements.baseline_targets
  assert(source.expected_files === baselineTargets.production_source.expected_files, 'receipt source file target must match the contract')
  assert(source.expected_loc === baselineTargets.production_source.expected_loc, 'receipt source LOC target must match the contract')
  const sourceMatches =
    source.files === source.expected_files
    && source.loc === source.expected_loc
    && source.filesystem_violations.length === 0
    && delta.added === 0
    && delta.removed === 0
    && delta.net === 0
  assert(source.matches_expected === sourceMatches, 'production source pass flag must match measured inventory and delta')
  assert(
    receipt.baseline_target.source_tree_matches_baseline === sourceMatches,
    'baseline source-tree flag must match measured production source evidence',
  )
  assert(delta.net === delta.added - delta.removed, 'production source net delta must match added and removed LOC')
  if (requireSourceMatch) assert(source.matches_expected === true, 'accepted receipt production source must match the frozen baseline')
  assert(source.filesystem_violations.length === 0, 'accepted source tree must not contain symlinks under src')

  const packageMeasurement = receipt.package
  assert(
    packageMeasurement.artifact_filename
      === expectedPackedFilename(contract.baseline.madar.name, contract.baseline.madar.version),
    'artifact filename must match the frozen package and version',
  )
  assert(
    JSON.stringify(packageMeasurement.install_command)
      === JSON.stringify([
        'npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund',
        `../${packageMeasurement.artifact_filename}`,
      ]),
    'package install command must install only the measured tarball with frozen safety flags',
  )
  assert(
    packageMeasurement.resolved_dependency_lock_sha256 === canonicalSha256(packageMeasurement.resolved_dependency_lock),
    'resolved dependency lock hash must match the captured lock',
  )
  const resolvedPackages = packageMeasurement.resolved_dependency_lock.packages ?? {}
  const resolvedPackagePaths = Object.keys(resolvedPackages).filter((path) => path.startsWith('node_modules/'))
  assert(
    packageMeasurement.resolved_dependency_count === resolvedPackagePaths.length,
    'resolved dependency count must match the captured lock',
  )
  assert(
    resolvedPackages['']?.dependencies?.[contract.baseline.madar.name]
      === `file:../${packageMeasurement.artifact_filename}`,
    'resolved dependency lock root must reference the measured tarball',
  )
  assert(
    resolvedPackages[`node_modules/${contract.baseline.madar.name}`]?.version === contract.baseline.madar.version,
    'resolved dependency lock must contain the frozen Madar version',
  )
  assert(
    packageMeasurement.targets.file_count_max === baselineTargets.package.file_count_max
      && packageMeasurement.targets.unpacked_bytes_max === baselineTargets.package.unpacked_bytes_max,
    'receipt package targets must match the contract',
  )
  assert(
    packageMeasurement.target_passed
      === (packageMeasurement.file_count < packageMeasurement.targets.file_count_max
        && packageMeasurement.unpacked_bytes < packageMeasurement.targets.unpacked_bytes_max),
    'package pass flag must match strict targets',
  )
  assert(packageMeasurement.forbidden_paths.length === 0, 'accepted package must exclude evaluation evidence')
  assert(packageMeasurement.forbidden_metadata.length === 0, 'accepted package metadata must exclude evaluation commands and paths')

  const cli = receipt.cli_startup
  assert(cli.cold_process_samples.length === baselineTargets.cli_startup.sample_count, 'CLI sample count must match the contract')
  assert(
    cli.targets.elapsed_ms_max === baselineTargets.cli_startup.elapsed_ms_max
      && cli.targets.peak_rss_bytes_max === baselineTargets.cli_startup.peak_rss_bytes_max,
    'receipt CLI targets must match the contract',
  )
  const measuredCliMedian = roundMilliseconds(median(cli.cold_process_samples.map((sample) => sample.elapsed_ms)))
  const measuredCliMaxRss = Math.max(...cli.cold_process_samples.map((sample) => sample.peak_rss_bytes))
  assert(cli.median_elapsed_ms === measuredCliMedian, 'CLI median must be derived from raw samples')
  assert(cli.max_peak_rss_bytes === measuredCliMaxRss, 'CLI maximum RSS must be derived from raw samples')
  assert(
    cli.target_passed
      === (cli.median_elapsed_ms < cli.targets.elapsed_ms_max
        && cli.max_peak_rss_bytes < cli.targets.peak_rss_bytes_max),
    'CLI pass flag must match measured targets',
  )

  const mcp = receipt.mcp_startup
  assert(mcp.cold_process_samples.length === baselineTargets.mcp_startup.sample_count, 'MCP sample count must match the contract')
  assert(mcp.target_tools_list_ms === baselineTargets.mcp_startup.tools_list_ms_max, 'MCP latency target must match the contract')
  assert(mcp.target_tool_count_max === baselineTargets.mcp_startup.tool_count_max, 'MCP tool-count target must match the contract')
  assert(mcp.public_tool_count === mcp.public_tools.length, 'MCP tool count must match its tool list')
  assert(
    JSON.stringify(mcp.public_tools) === JSON.stringify([...mcp.public_tools].sort()),
    'MCP public tool list must use deterministic sorted order',
  )
  assert(
    mcp.cold_process_samples.every((sample) =>
      sample.tool_count === sample.public_tools.length
      && JSON.stringify(sample.public_tools) === JSON.stringify(mcp.public_tools)),
    'every MCP sample tool list must exactly match the recorded public tool list',
  )
  const measuredMcpInitializeMedian = roundMilliseconds(median(mcp.cold_process_samples.map((sample) => sample.initialize_ms)))
  const measuredMcpToolsListMedian = roundMilliseconds(median(mcp.cold_process_samples.map((sample) => sample.tools_list_ms)))
  assert(mcp.median_initialize_ms === measuredMcpInitializeMedian, 'MCP initialize median must be derived from raw samples')
  assert(mcp.median_tools_list_ms === measuredMcpToolsListMedian, 'MCP tools/list median must be derived from raw samples')
  assert(mcp.latency_target_passed === (mcp.median_tools_list_ms < mcp.target_tools_list_ms), 'MCP latency flag must match measurement')
  assert(mcp.tool_count_target_passed === (mcp.public_tool_count <= mcp.target_tool_count_max), 'MCP tool-count flag must match measurement')
  assert(mcp.target_passed === (mcp.latency_target_passed && mcp.tool_count_target_passed), 'MCP aggregate flag must match both targets')

  const graph = receipt.graph_contract
  const exactParallelRelationsPreserved = sameValues(
    graph.parallel_edge_kinds_output,
    graph.parallel_edge_kinds_input,
  )
  assert(
    graph.parallel_edges_preserved === exactParallelRelationsPreserved,
    'parallel-edge flag must match the exact observed relation multiset',
  )
  assert(graph.node_ids_present === (graph.serialized_node_id_count === graph.serialized_node_count), 'node-id flag must match serialized counts')
  assert(graph.edge_ids_present === (graph.serialized_edge_id_count === graph.observed_edge_count), 'edge-id flag must match serialized counts')
  assert(graph.serialized_node_ids.length === graph.serialized_node_id_count, 'serialized node ids must match the valid-id count')
  assert(
    graph.opposite_directions_preserved
      === (graph.loaded_edge_tuples.some((tuple) => tuple.startsWith('source -> target ['))
        && graph.loaded_edge_tuples.some((tuple) => tuple.startsWith('target -> source ['))),
    'opposite-direction flag must match loaded topology',
  )
  assert(
    graph.provenance_preserved_after_round_trip
      === (graph.serialized_provenance_entry_count > 0
        && graph.serialized_provenance_entry_count === graph.loaded_provenance_entry_count
        && graph.serialized_provenance_sha256 === graph.loaded_provenance_sha256),
    'provenance round-trip flag must match exact captured payloads',
  )
  assert(
    graph.serialization_round_trip_preserved
      === (graph.serialized_contract_sha256 === graph.loaded_contract_sha256),
    'serialization round-trip flag must match exact external graph-contract payloads',
  )
  if (graph.serialization_round_trip_preserved) {
    assert(
      graph.directed === graph.loaded_directed
        && sameValues(graph.serialized_node_ids, graph.loaded_node_ids)
        && sameValues(graph.serialized_edge_tuples, graph.loaded_edge_tuples),
      'successful serialization round trip must preserve nodes, edges, and direction',
    )
  }
  assert(
    graph.expected_multigraph_edge_count === graph.parallel_edge_kinds_input.length + 1,
    'expected graph edge count must include every parallel relation and the opposite-direction edge',
  )
  assert(
    graph.observed_edge_count === graph.serialized_edge_tuples.length,
    'observed graph edge count must match serialized topology',
  )
  assert(
    graph.observed_edge_count
      === graph.parallel_edge_kinds_output.length
        + (graph.serialized_edge_tuples.some((tuple) => tuple.startsWith('target -> source [')) ? 1 : 0),
    'observed graph edge count must match the reported relations and opposite-direction edge',
  )
  assert(graph.observed_edge_count <= graph.expected_multigraph_edge_count, 'observed edge count cannot exceed the fixture expectation')

  const incremental = receipt.incremental_equivalence
  assert(
    JSON.stringify(incremental.canonicalization_excluded_fields)
      === JSON.stringify(canonicalGraphExcludedFields),
    'incremental canonicalization exclusions must match the frozen set',
  )
  const expectedOperations = ['add', 'change', 'delete', 'linked_worktree', 'rename']
  assertUnique(incremental.scenarios.map((scenario) => scenario.operation), 'incremental scenario operations')
  assert(sameValues(incremental.scenarios.map((scenario) => scenario.operation), expectedOperations), 'all incremental operations must be measured')
  assert(
    incremental.all_equal_to_clean_generation
      === incremental.scenarios.every((scenario) => scenario.equal_to_clean_generation),
    'incremental aggregate flag must match its scenarios',
  )
  for (const scenario of incremental.scenarios) {
    assert(
      scenario.equal_to_clean_generation
        === (scenario.incremental_graph_sha256 === scenario.clean_graph_sha256),
      `${scenario.operation} equality flag must match its canonical graph hashes`,
    )
    for (const field of ['incremental_nodes', 'clean_nodes', 'incremental_edges', 'clean_edges']) {
      assert(typeof scenario[field] === 'number', `${scenario.operation} scenario must record ${field}`)
    }
    if (scenario.equal_to_clean_generation) {
      assert(
        scenario.incremental_nodes === scenario.clean_nodes
          && scenario.incremental_edges === scenario.clean_edges,
        `${scenario.operation} equal graphs must have equal node and edge counts`,
      )
    }
    if (scenario.operation === 'linked_worktree') {
      assert(typeof scenario.artifact_outside_worktree === 'boolean', 'worktree scenario must record artifact placement')
      assert(typeof scenario.worktree_elapsed_ms === 'number', 'worktree scenario must record update timing')
    } else {
      for (const field of ['update_elapsed_ms', 'clean_elapsed_ms']) {
        assert(typeof scenario[field] === 'number', `${scenario.operation} scenario must record ${field}`)
      }
    }
  }

  const extraction = receipt.default_extraction
  assert(
    JSON.stringify(extraction.canonicalization_excluded_fields)
      === JSON.stringify(canonicalGraphExcludedFields),
    'default extraction canonicalization exclusions must match the frozen set',
  )
  assert(extraction.requested_extraction_mode === 'auto', 'baseline default extraction must exercise auto mode')
  assertUnique(extraction.fixture_symbol_evidence.map((evidence) => evidence.extension), 'default extraction fixture extensions')
  assert(
    sameValues(
      extraction.fixture_symbol_evidence.map((evidence) => evidence.extension),
      baselineTargets.default_extraction.expected_extensions,
    ),
    'default extraction must record symbol evidence for every frozen extension',
  )
  for (const evidence of extraction.fixture_symbol_evidence) {
    const expected = defaultExtractionFixtureSymbols[evidence.extension]
    assert(
      expected
        && evidence.source_file === expected.source_file
        && evidence.expected_symbol === expected.expected_symbol,
      `${evidence.extension} fixture evidence must match the frozen source and symbol`,
    )
  }
  const derivedSupportedExtensions = extraction.fixture_symbol_evidence
    .filter((evidence) => evidence.indexed && evidence.matched_node_ids.length > 0)
    .map((evidence) => evidence.extension)
  assert(
    sameValues(extraction.supported_fixture_extensions, derivedSupportedExtensions),
    'supported fixture extensions must be derived from indexed files with matching graph symbols',
  )
  assert(
    sameValues(derivedSupportedExtensions, baselineTargets.default_extraction.expected_extensions),
    'baseline extraction must emit a matching graph symbol for every contract-bound JavaScript/TypeScript extension',
  )
  assert(
    extraction.generated_graph_direction_preserved
      === (extraction.generated_graph_directed === extraction.loaded_graph_directed),
    'generated graph direction round-trip flag must match serialized and loaded direction',
  )
  const generatedIdsPresentAndUnique =
    extraction.first_node_count === extraction.first_valid_node_id_count
    && extraction.first_valid_node_id_count === extraction.first_unique_node_id_count
    && extraction.second_node_count === extraction.second_valid_node_id_count
    && extraction.second_valid_node_id_count === extraction.second_unique_node_id_count
  assert(
    extraction.generated_node_ids_present_and_unique === generatedIdsPresentAndUnique,
    'generated node-id presence and uniqueness flag must match raw counts',
  )
  assert(
    extraction.stable_node_ids_across_clean_rebuilds
      === (generatedIdsPresentAndUnique
        && extraction.first_node_ids_sha256 === extraction.second_node_ids_sha256),
    'default extraction node-id stability flag must require valid unique IDs and matching hashes',
  )
  assert(
    extraction.stable_serialized_graph_across_clean_rebuilds
      === (extraction.first_graph_sha256 === extraction.second_graph_sha256),
    'default extraction graph stability flag must match its hashes',
  )

  const retrieval = receipt.one_call_retrieval
  const strictQuestion = contract.questions.find((question) => question.id === 'openstatus-574-strict-one-call')
  const openstatus = contract.repositories.find((repository) => repository.id === strictQuestion.repository_id)
  if (requireMeasuredRetrieval) {
    assert(retrieval.status === 'measured', 'accepted receipt must include measured one-call retrieval evidence')
  }
  if (retrieval.status === 'measured') {
    assert(retrieval.question_id === strictQuestion.id, 'retrieval question must be the frozen strict diagnostic')
    assert(retrieval.repository === openstatus.url, 'retrieval repository URL must match the frozen repository')
    assert(retrieval.repository_commit === openstatus.commit, 'retrieval commit must match the frozen repository')
    assert(retrieval.source_tree_paths_sha256 === openstatus.tree_paths_sha256, 'retrieval tree hash must match the frozen repository')
    assert(retrieval.generator_artifact_sha256 === packageMeasurement.artifact_sha256, 'retrieval graph and server must use the measured packed artifact')
    assert(retrieval.graph_freshness.head_sha === openstatus.commit, 'retrieval graph freshness must match the frozen commit')
    assert(retrieval.graph_freshness.dirty_file_count === 0, 'retrieval graph must come from a clean source tree')
    assert(retrieval.graph_requested_extraction_mode === 'auto', 'retrieval graph must exercise the default auto extraction mode')
    assert(retrieval.matched_file_count === retrieval.matched_files.length, 'matched-file count must match')
    assert(retrieval.snippet_file_count === retrieval.snippet_files.length, 'snippet-file count must match')
    assert(retrieval.verification_target_file_count === retrieval.verification_target_files.length, 'verification-target count must match')
    assert(retrieval.returned_file_count === retrieval.returned_files.length, 'returned-file count must match')
    assert(retrieval.snippet_count === retrieval.snippets.length, 'snippet count must match')
    assert(
      retrieval.snippets.every((snippet) => typeof snippet.preview === 'string' && snippet.preview.trim().length > 0),
      'snippet evidence must contain non-empty content',
    )
    const snippetFiles = [...new Set(retrieval.snippets.map((snippet) => snippet.source_file))]
    assert(sameValues(retrieval.snippet_files, snippetFiles), 'snippet files must be derived from snippet evidence')
    assert(
      retrieval.snippet_files.every((path) => retrieval.matched_files.includes(path)),
      'every snippet file must be present in matched files',
    )
    assert(
      sameValues(retrieval.returned_files, new Set([...retrieval.matched_files, ...retrieval.verification_target_files])),
      'returned files must be the union of matched files and verification targets',
    )
    assertUnique(retrieval.phase_coverage.map((phase) => phase.phase), 'retrieval phase ids')
    assert(sameValues(retrieval.phase_coverage.map((phase) => phase.phase), strictQuestion.required_phases.map((phase) => phase.id)), 'retrieval must grade every frozen phase')
    const focusedReadsMax = contract.measurements.machine_gates.focused_reads_max
    const frozenExpectedPaths = new Set(strictQuestion.required_phases.flatMap((phase) => phase.expected_evidence_paths))
    const sortedVerificationTargets = [...retrieval.verification_target_files].sort()
    assert(
      JSON.stringify(retrieval.verification_target_files) === JSON.stringify(sortedVerificationTargets),
      'verification targets must use deterministic sorted order',
    )
    const globallySelectedFocusedPaths = new Set(
      sortedVerificationTargets
        .filter((path) => frozenExpectedPaths.has(path))
        .slice(0, focusedReadsMax),
    )
    for (const phaseResult of retrieval.phase_coverage) {
      const phase = strictQuestion.required_phases.find((candidate) => candidate.id === phaseResult.phase)
      assert(phaseResult.scope === phase.scope, `${phase.id} scope must match the contract`)
      const expectedMatchedPaths = phase.expected_evidence_paths.filter((path) => retrieval.snippet_files.includes(path))
      const expectedVerificationPaths = phase.expected_evidence_paths.filter((path) =>
        retrieval.verification_target_files.includes(path) && !retrieval.snippet_files.includes(path))
      assert(
        sameValues(phaseResult.matched_paths, expectedMatchedPaths),
        `${phase.id} matched paths must be exact frozen paths backed by snippets`,
      )
      assert(
        sameValues(phaseResult.verification_target_paths, expectedVerificationPaths),
        `${phase.id} verification paths must be exact frozen paths returned as verification targets`,
      )
      const directlyCovered = expectedMatchedPaths.length >= phase.minimum_path_matches
      const globallySelectedPhaseTargets = expectedVerificationPaths.filter((path) => globallySelectedFocusedPaths.has(path))
      const reachableWithinGlobalBudget =
        new Set([...expectedMatchedPaths, ...globallySelectedPhaseTargets]).size >= phase.minimum_path_matches
      assert(phaseResult.covered === directlyCovered, `${phase.id} covered flag must match snippet evidence`)
      assert(
        phaseResult.reachable_after_focused_reads === reachableWithinGlobalBudget,
        `${phase.id} focused-read reachability must respect the global focused-read budget`,
      )
    }
    const inScope = retrieval.phase_coverage.filter((phase) => phase.scope === 'required')
    const expectedCoverage = inScope.filter((phase) => phase.covered).length / Math.max(1, inScope.length)
    assert(Math.abs(retrieval.in_scope_phase_coverage - expectedCoverage) < Number.EPSILON, 'retrieval coverage ratio must match phase results')
    assert(retrieval.focused_verification_reads <= focusedReadsMax, 'strict diagnostic exceeded focused-read budget')
    assert(
      receipt.unknowns.some((unknown) => unknown.field === 'one_call_retrieval.provider_total_input_tokens'),
      'missing provider token usage must have an explicit unknown reason',
    )
  } else {
    assert(receipt.unknowns.some((unknown) => unknown.field === 'one_call_retrieval'), 'unknown retrieval must have a reproducible reason')
  }

  assert(receipt.isolation.production_import_violations.length === 0, 'accepted receipt must have no production evaluation imports')
  assert(receipt.isolation.production_evaluation_leaks.length === 0, 'accepted receipt must have no production evaluation markers')
  assert(receipt.isolation.package_forbidden_paths.length === 0, 'accepted receipt must have no packaged evaluation paths')
  assert(receipt.isolation.package_forbidden_metadata.length === 0, 'accepted receipt must have no packaged evaluation metadata')
  return true
}
