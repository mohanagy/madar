import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

function assert(condition, message) {
  if (!condition) throw new Error(`Evaluation contract invariant failed: ${message}`)
}

function assertUnique(values, label) {
  assert(new Set(values).size === values.length, `${label} must be unique`)
}

function sameValues(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isInsideGraphRoot(path, graphRoot) {
  if (graphRoot === '.') return true
  return path === graphRoot || path.startsWith(`${graphRoot}/`)
}

function assertContractPath(path, label) {
  assert(
    typeof path === 'string'
      && path.length > 0
      && !isAbsolute(path)
      && !path.includes('\\')
      && !path.includes('\0')
      && !path.includes('*')
      && !path.split('/').includes('..'),
    `${label} must be a safe repository-relative path`,
  )
}

function assertOrderedRange(range, label) {
  const positions = [
    ['start', range?.start],
    ['end', range?.end],
  ]
  for (const [name, position] of positions) {
    assert(
      Number.isInteger(position?.line)
        && position.line >= 1
        && Number.isInteger(position?.column)
        && position.column >= 1,
      `${label} ${name} must be a one-based line/column position`,
    )
  }
  const startsBeforeEnd =
    range.start.line < range.end.line
    || (range.start.line === range.end.line && range.start.column < range.end.column)
  assert(startsBeforeEnd, `${label} must be ordered and non-empty`)
}

function phaseEvidencePaths(phase, ownerFixturesById) {
  if (phase.scope === 'required') {
    return [...new Set(
      phase.accepted_owner_ids
        .map((ownerId) => ownerFixturesById.get(ownerId)?.source_file)
        .filter((path) => typeof path === 'string'),
    )]
  }
  return [...new Set(phase.boundary_subjects ?? [])]
}

export function evidencePathsForPhase(phase, contract) {
  return phaseEvidencePaths(
    phase,
    new Map((contract.owner_fixtures ?? []).map((fixture) => [fixture.id, fixture])),
  )
}

function historicalBaselineBinding(receipt, contract) {
  const binding = contract.amendment?.historical_baseline_binding
  if (
    !binding
    || receipt.contract_id !== binding.contract_id
    || receipt.contract_sha256 !== binding.contract_ordered_json_sha256
  ) {
    return null
  }
  const receiptSha256 = sha256(`${JSON.stringify(receipt, null, 2)}\n`)
  assert(
    receiptSha256 === binding.receipt_sha256,
    'historical baseline receipt bytes must match the explicitly bound immutable receipt',
  )
  assert(
    binding.disposition === 'historical_baseline_only_not_v2_held_out_evidence',
    'historical baseline receipt must remain excluded from v2 held-out evidence',
  )
  return binding
}

export function validateHistoricalBaselineReceipt(receipt, contract) {
  assert(
    historicalBaselineBinding(receipt, contract) !== null,
    'receipt must match the immutable historical v1 baseline binding',
  )
  return true
}
export function validateContractSemantics(contract) {
  const repositories = contract.repositories ?? []
  const questions = contract.questions ?? []
  const ownerFixtures = contract.owner_fixtures ?? []
  const supportedLanguages = new Set(contract.product_scope?.supported_languages ?? [])
  const excludedLanguages = new Set(contract.product_scope?.excluded_languages ?? [])
  assert(contract.schema_version === 2, 'held-out governance schema_version must be 2')
  assert(contract.contract_id === 'core-reset-held-out-v2', 'held-out governance contract_id must be core-reset-held-out-v2')
  const historicalBinding = contract.amendment?.historical_baseline_binding
  assert(
    contract.amendment?.supersedes_contract_id === 'core-reset-held-out-v1',
    'v2 contract must explicitly supersede core-reset-held-out-v1',
  )
  assertContractPath(historicalBinding?.receipt, 'historical baseline receipt')
  assert(
    historicalBinding.contract_id === 'core-reset-held-out-v1'
      && /^[0-9a-f]{64}$/.test(historicalBinding.receipt_sha256)
      && /^[0-9a-f]{64}$/.test(historicalBinding.contract_ordered_json_sha256)
      && historicalBinding.disposition === 'historical_baseline_only_not_v2_held_out_evidence',
    'historical baseline binding must authenticate v1 without promoting it to v2 evidence',
  )
  assert(supportedLanguages.has('typescript') && supportedLanguages.has('javascript'), 'product scope must support TypeScript and JavaScript')
  assert(excludedLanguages.has('go'), 'product scope must explicitly exclude Go')
  assert(
    JSON.stringify(contract.evidence_semantics?.phase_grading?.required_identity)
      === JSON.stringify([
        'repository_id',
        'source_file',
        'source_sha256',
        'symbol',
        'node_kind',
        'declaration_range',
        'declaration_sha256',
      ]),
    'phase grading identity must include the authenticated full-file source hash',
  )
  assert(
    JSON.stringify(contract.evidence_semantics?.structural_file_nodes?.relationship_endpoints)
      === JSON.stringify({
        imports_from: 'file_to_file',
        contains: 'file_to_symbol',
      }),
    'structural relationship endpoint grammar must match the canonical graph ontology',
  )
  assert(
    [...supportedLanguages].every((language) => !excludedLanguages.has(language)),
    'supported and excluded language sets must not overlap',
  )
  assertUnique(repositories.map((repository) => repository.id), 'repository ids')
  assertUnique(questions.map((question) => question.id), 'question ids')
  assertUnique(ownerFixtures.map((fixture) => fixture.id), 'owner fixture ids')
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]))
  const ownerFixturesById = new Map(ownerFixtures.map((fixture) => [fixture.id, fixture]))

  for (const repository of repositories) {
    if (repository.graph_root !== '.') {
      assertContractPath(repository.graph_root, `${repository.id} graph_root`)
    }
    assertUnique(repository.verified_evidence_paths, `${repository.id} verified evidence paths`)
    for (const path of repository.verified_evidence_paths) {
      assertContractPath(path, `${repository.id} verified path`)
      assert(isInsideGraphRoot(path, repository.graph_root), `${repository.id} verified path is outside graph_root`)
    }
  }

  for (const fixture of ownerFixtures) {
    const repository = repositoriesById.get(fixture.repository_id)
    assert(repository !== undefined, `${fixture.id} references unknown repository ${fixture.repository_id}`)
    assertContractPath(fixture.source_file, `${fixture.id} source_file`)
    assert(
      isInsideGraphRoot(fixture.source_file, repository.graph_root),
      `${fixture.id} source_file is outside ${repository.id} graph_root`,
    )
    assert(
      repository.verified_evidence_paths.includes(fixture.source_file),
      `${fixture.id} source_file was not verified against the pinned repository tree`,
    )
    assert(/^[0-9a-f]{64}$/.test(fixture.source_sha256), `${fixture.id} source_sha256 must be SHA-256`)
    assert(/^[0-9a-f]{64}$/.test(fixture.declaration_sha256), `${fixture.id} declaration_sha256 must be SHA-256`)
    assert(typeof fixture.symbol === 'string' && fixture.symbol.length > 0, `${fixture.id} symbol is required`)
    assert(typeof fixture.node_kind === 'string' && fixture.node_kind.length > 0, `${fixture.id} node_kind is required`)
    assertOrderedRange(fixture.declaration_range, `${fixture.id} declaration_range`)
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
      if (phase.scope === 'required') {
        assert(
          phase.evidence_match === 'exact_owner_fixture',
          `${question.id}/${phase.id} must use exact owner-fixture matching`,
        )
        assertUnique(phase.accepted_owner_ids, `${question.id}/${phase.id} accepted owners`)
        assert(
          phase.minimum_owner_matches <= phase.accepted_owner_ids.length,
          `${question.id}/${phase.id} minimum_owner_matches exceeds its owner count`,
        )
        for (const ownerId of phase.accepted_owner_ids) {
          const fixture = ownerFixturesById.get(ownerId)
          assert(fixture !== undefined, `${question.id}/${phase.id} references unknown owner fixture ${ownerId}`)
          assert(
            fixture.repository_id === question.repository_id,
            `${question.id}/${phase.id} owner fixture ${ownerId} belongs to another repository`,
          )
        }
      } else {
        assert(
          phase.boundary_kind === 'unsupported',
          `${question.id}/${phase.id} unsupported phase must use an unsupported boundary`,
        )
        assertUnique(phase.boundary_subjects, `${question.id}/${phase.id} boundary subjects`)
        assert(
          phase.minimum_boundary_matches <= phase.boundary_subjects.length,
          `${question.id}/${phase.id} minimum_boundary_matches exceeds its subject count`,
        )
        for (const subject of phase.boundary_subjects) {
          assertContractPath(subject, `${question.id}/${phase.id} boundary subject`)
          assert(
            isInsideGraphRoot(subject, repository.graph_root),
            `${question.id}/${phase.id} boundary subject is outside graph_root`,
          )
          assert(
            repository.verified_evidence_paths.includes(subject),
            `${question.id}/${phase.id} boundary subject was not verified against the pinned tree`,
          )
        }
      }
    }
    const questionOwnerIds = new Set(
      question.required_phases
        .filter((phase) => phase.scope === 'required')
        .flatMap((phase) => phase.accepted_owner_ids),
    )
    const ownerPhaseOrder = new Map()
    for (const [phaseIndex, phase] of question.required_phases.entries()) {
      if (phase.scope !== 'required') continue
      for (const ownerId of phase.accepted_owner_ids) {
        if (!ownerPhaseOrder.has(ownerId)) ownerPhaseOrder.set(ownerId, phaseIndex)
      }
    }
    const handoffs = question.required_handoffs ?? []
    assertUnique(
      handoffs.map((handoff) => `${handoff.from_owner_id}\0${handoff.to_owner_id}`),
      `${question.id} handoffs`,
    )
    for (const handoff of handoffs) {
      assert(
        handoff.expectation === 'connected' || handoff.expectation === 'disconnected',
        `${question.id} handoff expectation must be connected or disconnected`,
      )
      assert(handoff.from_owner_id !== handoff.to_owner_id, `${question.id} handoff cannot point to itself`)
      for (const [direction, ownerId] of [
        ['from', handoff.from_owner_id],
        ['to', handoff.to_owner_id],
      ]) {
        const fixture = ownerFixturesById.get(ownerId)
        assert(fixture !== undefined, `${question.id} handoff ${direction} references unknown owner ${ownerId}`)
        assert(
          fixture.repository_id === question.repository_id,
          `${question.id} handoff ${direction} owner belongs to another repository`,
        )
        assert(
          questionOwnerIds.has(ownerId),
          `${question.id} handoff ${direction} owner is not accepted by a required phase`,
        )
      }
      assert(
        ownerPhaseOrder.get(handoff.from_owner_id) < ownerPhaseOrder.get(handoff.to_owner_id),
        `${question.id} handoff owners must follow required phase order`,
      )
    }
    if (question.gate_role === 'blocking') {
      assert(handoffs.length > 0, `${question.id} blocking workflow must declare its graph handoffs`)
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
  const cliMeasurement = contract.measurements.baseline_targets.cli_startup
  assert(
    JSON.stringify(cliMeasurement.subject_command)
      === JSON.stringify(['node', '<packed-install>/dist/src/cli/bin.js', '--version']),
    'CLI subject command must remain the packed version probe',
  )
  assert(
    JSON.stringify(cliMeasurement.measurement_command)
      === JSON.stringify(['node', '--require', '<rss-probe.cjs>', '<packed-install>/dist/src/cli/bin.js', '--version']),
    'CLI measurement command must retain the disclosed RSS preload',
  )
  assert(
    cliMeasurement.instrumentation_caveat
      === "A Node preload records process.resourceUsage().maxRSS at exit; reported elapsed time and RSS include the preload's own overhead.",
    'CLI instrumentation overhead policy must remain explicit',
  )
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
  const refresh = contract.trial_design.refresh_measurement
  const blockingRepositoryIds = repositories
    .filter((repository) => repository.role === 'blocking')
    .map((repository) => repository.id)
    .sort()
  assert(
    refresh.sample_count_per_repository_arm === 3
      && refresh.independent_samples === true
      && refresh.mutation_application_in_timed_window === false,
    'refresh measurements must use three independent samples with mutation outside the timer',
  )
  assert(
    sameValues(refresh.repositories.map((entry) => entry.repository_id), blockingRepositoryIds),
    'refresh fixtures must cover every blocking repository exactly once',
  )
  for (const entry of refresh.repositories) {
    const repository = repositoriesById.get(entry.repository_id)
    const mutation = entry.mutation
    assert(
      repository
        && entry.commit === repository.commit
        && entry.graph_root === repository.graph_root,
      `${entry.repository_id} refresh fixture must match its frozen repository`,
    )
    assertContractPath(mutation.path, `${entry.repository_id} refresh path`)
    assertContractPath(mutation.path_from_graph_root, `${entry.repository_id} graph-root refresh path`)
    assert(
      mutation.path === (entry.graph_root === '.'
        ? mutation.path_from_graph_root
        : `${entry.graph_root}/${mutation.path_from_graph_root}`),
      `${entry.repository_id} refresh paths must share one coordinate system`,
    )
    assert(
      repository.verified_evidence_paths.includes(mutation.path),
      `${entry.repository_id} refresh target must be verified against the pinned tree`,
    )
    const patchBytes = Buffer.from(mutation.patch_utf8, 'utf8')
    assert(!mutation.patch_utf8.includes('\r'), `${entry.repository_id} refresh patch must use LF`)
    assert(mutation.patch_bytes === patchBytes.length, `${entry.repository_id} refresh patch byte count must match`)
    assert(
      mutation.patch_sha256 === createHash('sha256').update(patchBytes).digest('hex'),
      `${entry.repository_id} refresh patch hash must match exact UTF-8 bytes`,
    )
    assert(
      mutation.patch_utf8.startsWith(`diff --git a/${mutation.path} b/${mutation.path}\n`)
        && mutation.patch_utf8.includes(mutation.expected_symbol)
        && mutation.base_blob_sha256 !== mutation.result_blob_sha256,
      `${entry.repository_id} refresh patch must bind its target, symbol, and changed result`,
    )
  }
  assert(
    JSON.stringify(refresh.commands.graphify.clean)
      === JSON.stringify({ executable: '<resolved-graphify-executable>', argv: ['extract', '.', '--code-only'] })
      && JSON.stringify(refresh.commands.graphify.refresh)
        === JSON.stringify({ executable: '<resolved-graphify-executable>', argv: ['update', '.'] })
      && JSON.stringify(refresh.commands.madar.clean)
        === JSON.stringify({ executable: '<resolved-packed-madar-executable>', argv: ['generate', '.', '--no-html'] })
      && JSON.stringify(refresh.commands.madar.refresh)
        === JSON.stringify({ executable: '<resolved-packed-madar-executable>', argv: ['generate', '.', '--update', '--no-html'] })
      && refresh.commands.graphify.artifact === 'graphify-out/graph.json'
      && refresh.commands.madar.artifact === 'out/graph.json',
    'refresh commands and artifacts must remain frozen',
  )
  const conditionPolicy = contract.human_rubric.condition_policy
  assert(
    sameValues(conditionPolicy.graph_conditions, ['cold', 'warm']),
    'graph aggregation must preserve cold and warm conditions',
  )
  assert(contract.measurements.index_costs.capture_stage === 'comparative_trials', 'index-cost distributions belong to comparative trials')
  assert(contract.measurements.index_costs.baseline_receipt_requirement === 'not_required', 'baseline receipt must not fabricate cross-arm index distributions')
  assert(
    ['graph build provider input tokens', 'graph build provider output tokens', 'graph build provider total tokens']
      .every((metric) => contract.measurements.index_costs.metrics.includes(metric))
      && ['refresh provider input tokens', 'refresh provider output tokens', 'refresh provider total tokens']
        .every((metric) => contract.measurements.index_costs.metrics.includes(metric))
      && contract.measurements.index_costs.graph_build_provider_tokens.graphify_code_only_expected_total === 0,
    'index costs must capture graph-build and refresh provider tokens and Graphify code-only zero',
  )
  assert(
    sameValues(contract.anti_tuning.agent_inputs, ['product_scope_statement', 'frozen_prompt', 'target_repository']),
    'agent inputs must expose only scope, prompt, and target repository',
  )
  return true
}
