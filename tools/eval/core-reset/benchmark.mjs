import { createHash } from "node:crypto"
import {
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs"
import { performance } from "node:perf_hooks"
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path"
import { fileURLToPath } from "node:url"

import { loadGraphArtifact } from "../../../dist/src/adapters/filesystem/graph-artifact.js"
import { generateIndex } from "../../../dist/src/application/generate-index.js"
import { retrieveContext } from "../../../dist/src/application/retrieve-context.js"
import { inspectQueryIndex } from "../../../dist/src/domain/query/index-status.js"
import { planQuestion } from "../../../dist/src/domain/query/plan.js"
import { selectWorkflow } from "../../../dist/src/domain/query/workflow.js"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const frozenCorpusRoot = resolve(
  repositoryRoot,
  "tests/fixtures/pack-quality/runtime-generation-explain-report-flow/workspace",
)
const graphPath = process.argv[2]
  ? resolve(process.argv[2])
  : generateIndex(frozenCorpusRoot).graphPath

const EXPECTED_CORPUS_SHA256 =
  "712dff25a9cebcfdb0eb39e8ae381ec2dd20519ca609dc02390eab9ecaf567d6"
const EXPECTED_GRAPH_SOURCE_FINGERPRINT =
  "11025a70b79251745ceab23a9fe36baa81fbdafeede6f57b95c42cb9da1e3077"
const EXPECTED_QUESTIONS_SHA256 =
  "2a1f5498f2aab8ededd9c506a7e2471e7d420a265bec6fa107f105fbffb04a22"
const EXPECTED_FLOW_SHA256 =
  "6cca04d52e590ccccd48e6728ec0744fa7606334034ffbca0002e578a6dcca67"
const EXPECTED_EVIDENCE_SHA256 =
  "154efca16be4a163b24cb3812f85cf113c73696805d2de83734c252f8ce656f3"

const expectedChannelOrder = [
  "orchestration-queue",
  "section-research-queue",
  "assembly-queue",
  "db-sync-queue",
]
const requiredQueues = [...expectedChannelOrder].sort()
const expectedCorridor = [
  [".generateFromProblem()", "src/modules/ideas/interface/http/idea-generation.controller.ts"],
  [".process()", "src/modules/pipeline/workers/orchestrator.worker.ts"],
  [".plan()", "src/modules/planning/planner.service.ts"],
  [".process()", "src/modules/research/workers/section-research.worker.ts"],
  [".researchSection()", "src/modules/research/research-agent.service.ts"],
  [".process()", "src/modules/pipeline/assembly/assembly.worker.ts"],
  [".assembleReport()", "src/modules/reports/assembly.service.ts"],
  [".process()", "src/modules/pipeline/workers/db-sync.worker.ts"],
  ["saveStructuredReport()", "src/modules/pipeline/workers/db-sync.worker.ts"],
]
const expectedObligationKinds = [
  "subject",
  "entry",
  "stage",
  "handoff",
  "behavior",
  "ordering",
  "terminal",
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function uniqueMap(rows, label) {
  const mapped = new Map()
  for (const row of rows) {
    assert(!mapped.has(row.id), `duplicate ${label} id ${row.id}`)
    mapped.set(row.id, row)
  }
  return mapped
}

function walkCorpus(path, rows = []) {
  for (const entry of readdirSync(path).sort()) {
    if (entry === "out") continue
    const absolute = join(path, entry)
    const stat = lstatSync(absolute)
    assert(!stat.isSymbolicLink(), `frozen corpus symlink ${absolute}`)
    if (stat.isDirectory()) walkCorpus(absolute, rows)
    else {
      assert(stat.isFile(), `frozen corpus non-file ${absolute}`)
      rows.push({
        path: relative(frozenCorpusRoot, absolute).split("\\").join("/"),
        hash: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
      })
    }
  }
  return rows
}

function assertCorpusAttestation(artifact) {
  const corpusRows = walkCorpus(frozenCorpusRoot)
  assert(corpusRows.length === 18, `frozen corpus file count ${corpusRows.length}`)
  assert(hash(corpusRows) === EXPECTED_CORPUS_SHA256, "frozen corpus attestation drift")

  const metadata = artifact?.metadata
  const build = metadata?.index_build
  const sources = build?.sources
  const sourceRoot = build?.source_root
  assert(metadata?.schema_version === 4, "graph schema version drift")
  assert(build?.engine_id === "madar-typescript-index-v4-execution-1", "graph engine drift")
  assert(/^[0-9a-f]{64}$/.test(build?.build_id ?? ""), "graph build attestation is missing")
  assert(
    sources?.fingerprint === EXPECTED_GRAPH_SOURCE_FINGERPRINT,
    "graph source fingerprint drift",
  )
  assert(
    resolve(sourceRoot?.root_path ?? "") === frozenCorpusRoot,
    "graph was not generated from the committed #630 corpus",
  )
  assert(
    sourceRoot?.kind === "primary_worktree" || sourceRoot?.kind === "linked_worktree",
    "graph source is not a repository worktree",
  )
  assert(
    resolve(sourceRoot?.worktree_root ?? "") === repositoryRoot,
    "graph source worktree drift",
  )
  assert(
    sourceRoot?.scope
      === "tests/fixtures/pack-quality/runtime-generation-explain-report-flow/workspace",
    "graph source scope drift",
  )
  assert(build?.completeness?.summary?.state === "complete", "graph is incomplete")
  assert(build?.completeness?.summary?.counts?.indexed === 17, "graph indexed count drift")
  assert(build?.completeness?.summary?.counts?.failed === 0, "graph has failed sources")
  assert(build?.corpus?.supported_files === 17, "graph supported-file count drift")
  assert(build?.corpus?.unsupported_files === 0, "graph has unsupported sources")
  assert(metadata?.discovery_safety?.summary?.total === 0, "graph has safety exclusions")

  const graphRows = [
    ...(sources?.controls ?? []),
    ...(sources?.supported ?? []),
  ].map(({ path, hash }) => ({ path, hash })).sort((left, right) =>
    left.path.localeCompare(right.path))
  assert(
    JSON.stringify(graphRows) === JSON.stringify(corpusRows),
    "graph source inventory does not match the committed #630 corpus",
  )
  assert((sources?.unsupported ?? []).length === 0, "graph source inventory is partial")
  return { corpusRows, sourceFingerprint: sources.fingerprint, buildId: build.build_id }
}

const queryFixture = JSON.parse(readFileSync(resolve(
  repositoryRoot,
  "tests/fixtures/issue-625-evidence-skeleton/fixture.json",
), "utf8")).queries
const questions = [
  queryFixture.beta_3_broad,
  ...queryFixture.punctuation_variants,
  ...queryFixture.clause_order_variants,
  ...queryFixture.distant_paraphrases,
  ...queryFixture.field_incident_variants,
]
assert(questions.length === 14, `expected 14 prompts, received ${questions.length}`)
assert(new Set(questions).size === 14, "the 14 frozen prompts must be unique")
assert(hash(questions) === EXPECTED_QUESTIONS_SHA256, "frozen prompt attestation drift")

function mandatoryPlan(question) {
  const planned = planQuestion({ question, budget: 4_000 })
  assert(planned.status === "supported", `${question}: unsupported plan`)
  assert(planned.plan.intent === "workflow", `${question}: non-workflow plan`)
  const mandatory = planned.plan.obligations.filter(({ mandatory }) => mandatory)
  assert(
    JSON.stringify(mandatory.map(({ kind }) => kind))
      === JSON.stringify(expectedObligationKinds),
    `${question}: mandatory obligation plan drift`,
  )
  assert(
    mandatory.length === planned.plan.obligations.length,
    `${question}: unexpected optional obligation`,
  )
  return { plan: planned.plan, mandatory }
}

function assertReferencesAndCorridor(result, plan, mandatory, question) {
  const dossier = result.dossier
  const files = uniqueMap(dossier.evidence.files, "file")
  const excerpts = uniqueMap(dossier.evidence.excerpts, "excerpt")
  const controls = uniqueMap(dossier.evidence.controls, "control")
  const entities = uniqueMap(dossier.evidence.entities, "entity")
  const proofs = uniqueMap(dossier.evidence.proofs, "proof")
  const links = uniqueMap(dossier.flow.links, "link")
  uniqueMap(dossier.flow.order, "order")
  uniqueMap(dossier.obligations, "obligation")

  assert(
    JSON.stringify(dossier.query) === JSON.stringify({
      intent: plan.intent,
      subject: plan.subject,
      terms: plan.terms,
    }),
    `${question}: dossier query does not match its plan`,
  )
  assert(result.metrics.required_obligations === mandatory.length, `${question}: required count`)
  assert(result.metrics.proven_obligations === mandatory.length, `${question}: proven count`)
  assert(
    JSON.stringify(dossier.obligations.map(({ id, kind }) => ({ id, kind })))
      === JSON.stringify(mandatory.map(({ id, kind }) => ({ id, kind }))),
    `${question}: planned mandatory obligations are not a dossier bijection`,
  )

  for (const excerpt of excerpts.values()) {
    assert(files.has(excerpt.file), `${question}: excerpt ${excerpt.id} has unknown file`)
    assert(excerpt.text.length > 0, `${question}: excerpt ${excerpt.id} is empty`)
  }
  for (const control of controls.values()) {
    assert(files.has(control.file), `${question}: control ${control.id} has unknown file`)
    assert(control.ranges.length > 0, `${question}: control ${control.id} has no ranges`)
  }
  for (const entity of entities.values()) {
    if (entity.kind === "symbol") {
      assert(files.has(entity.file), `${question}: symbol ${entity.id} has unknown file`)
      if (entity.excerpt) {
        assert(excerpts.has(entity.excerpt), `${question}: symbol ${entity.id} has unknown excerpt`)
      }
    } else if (entity.kind === "operation") {
      assert(entities.has(entity.owner), `${question}: operation ${entity.id} has unknown owner`)
      assert(excerpts.has(entity.excerpt), `${question}: operation ${entity.id} has unknown excerpt`)
    } else if (entity.parent) {
      const parent = entities.get(entity.parent)
      assert(parent?.kind === "channel", `${question}: channel ${entity.id} has unknown parent`)
    }
  }
  for (const proof of proofs.values()) {
    assert(entities.has(proof.from), `${question}: proof ${proof.id} has unknown from`)
    assert(entities.has(proof.to), `${question}: proof ${proof.id} has unknown to`)
    if ("excerpt" in proof) {
      assert(excerpts.has(proof.excerpt), `${question}: proof ${proof.id} has unknown excerpt`)
    } else {
      assert(files.has(proof.file), `${question}: proof ${proof.id} has unknown file`)
    }
  }
  for (const link of links.values()) {
    assert(entities.has(link.from), `${question}: link ${link.id} has unknown from`)
    assert(entities.has(link.to), `${question}: link ${link.id} has unknown to`)
    assert(link.proofs.length > 0, `${question}: link ${link.id} is unproven`)
    for (const proof of link.proofs) {
      assert(proofs.has(proof), `${question}: link ${link.id} has unknown proof ${proof}`)
    }
  }
  for (const group of dossier.flow.order) {
    for (const member of group.members) {
      assert(
        entities.has(member) || proofs.has(member),
        `${question}: order ${group.id} has unknown member ${member}`,
      )
    }
    if (group.controller) {
      const [control, ordinal] = group.controller.split(":")
      assert(controls.has(control), `${question}: order ${group.id} has unknown controller`)
      assert(Number.isSafeInteger(Number(ordinal)), `${question}: invalid controller ordinal`)
    }
    for (const proof of group.proofs ?? []) {
      assert(proofs.has(proof), `${question}: order ${group.id} has unknown proof ${proof}`)
    }
  }

  const claimReferences = new Set([...entities.keys(), ...proofs.keys(), ...links.keys()])
  for (const obligation of dossier.obligations) {
    assert(obligation.proofs.length > 0, `${question}: obligation ${obligation.id} is unproven`)
    for (const proof of obligation.proofs) {
      assert(
        claimReferences.has(proof),
        `${question}: obligation ${obligation.id} has unknown proof ${proof}`,
      )
    }
  }

  assert(dossier.flow.roots.length === 1, `${question}: expected one request root`)
  assert(dossier.flow.terminals.length === 1, `${question}: expected one terminal`)
  assert(dossier.flow.links.length === 8, `${question}: corridor link count drift`)
  let current = dossier.flow.roots[0]
  const corridor = [current]
  for (const link of dossier.flow.links) {
    assert(link.from === current, `${question}: corridor is not ordered at ${link.id}`)
    current = link.to
    corridor.push(current)
  }
  assert(current === dossier.flow.terminals[0], `${question}: corridor misses terminal`)
  assert(new Set(corridor).size === corridor.length, `${question}: corridor repeats an entity`)

  const observedCorridor = corridor.map((id) => {
    const entity = entities.get(id)
    assert(entity?.kind === "symbol", `${question}: corridor entity ${id} is not a symbol`)
    return [entity.label, files.get(entity.file)?.path]
  })
  assert(
    JSON.stringify(observedCorridor) === JSON.stringify(expectedCorridor),
    `${question}: request/planning/research/assembly/DB-sync corridor drift`,
  )
  assert(
    JSON.stringify(dossier.flow.links.map(({ kind }) => kind))
      === JSON.stringify(["channel", "direct", "channel", "direct", "channel", "direct", "channel", "direct"]),
    `${question}: direct/channel ordering drift`,
  )

  const channelLinks = dossier.flow.links.filter(({ kind }) => kind === "channel")
  assert(channelLinks.length === 4, `${question}: expected four channel handoffs`)
  const observedQueues = channelLinks.map((link) => {
    const chain = link.proofs.map((id) => proofs.get(id))
    const calls = chain.filter(({ relation }) => relation === "calls")
    const publishes = chain.filter(({ relation }) => relation === "publishes_to")
    const routes = chain.filter(({ relation }) => relation === "routes_through")
    const consumes = chain.filter(({ relation }) => relation === "consumed_by")
    assert(chain.length === 4, `${question}: ${link.id} proof-chain cardinality drift`)
    assert(calls.length === 1, `${question}: ${link.id} producer-call proof drift`)
    assert(publishes.length === 1, `${question}: ${link.id} publish proof drift`)
    assert(routes.length === 1, `${question}: ${link.id} route proof drift`)
    assert(consumes.length === 1, `${question}: ${link.id} consume proof drift`)
    assert(calls[0].from === link.from, `${question}: ${link.id} producer mismatch`)
    assert(calls[0].to === publishes[0].from, `${question}: ${link.id} publisher mismatch`)
    assert(publishes[0].to === routes[0].from, `${question}: ${link.id} job mismatch`)
    assert(routes[0].to === consumes[0].from, `${question}: ${link.id} queue mismatch`)
    assert(consumes[0].to === link.to, `${question}: ${link.id} consumer mismatch`)
    const job = entities.get(publishes[0].to)
    const queue = entities.get(routes[0].to)
    assert(job?.kind === "channel" && job.channel_kind === "job", `${question}: ${link.id} lacks job channel`)
    assert(queue?.kind === "channel" && queue.channel_kind === "queue", `${question}: ${link.id} lacks queue channel`)
    assert(job.parent === queue.id, `${question}: ${link.id} job/queue parent mismatch`)
    assert(job.transport === "bullmq" && queue.transport === "bullmq", `${question}: ${link.id} transport drift`)
    return queue.key
  })
  assert(new Set(observedQueues).size === 4, `${question}: channel handoffs are not distinct`)
  assert(
    JSON.stringify(observedQueues) === JSON.stringify(expectedChannelOrder),
    `${question}: channel handoff order drift`,
  )

  const terminal = dossier.flow.terminals[0]
  const persistence = [...entities.values()].filter((entity) =>
    entity.kind === "operation"
    && entity.operation_kind === "persistence"
    && entity.owner === terminal)
  assert(persistence.length === 1, `${question}: terminal persistence is not exact`)
  assert(persistence[0].detail?.operation === "update", `${question}: terminal persistence operation drift`)
  assert(
    persistence[0].detail?.receiver_type === "MongoRepository<StoredReport>",
    `${question}: terminal persistence receiver drift`,
  )
  const terminalObligation = dossier.obligations.find(({ kind }) => kind === "terminal")
  assert(
    terminalObligation?.proofs.includes(persistence[0].id),
    `${question}: terminal obligation does not bind persistence evidence`,
  )
}

function assertSelectionBijection(index, plan, mandatory, question) {
  const selected = selectWorkflow(index, plan)
  assert(selected.complete, `${question}: selected workflow is incomplete`)
  const selectedMandatory = selected.obligations.filter(({ mandatory }) => mandatory)
  assert(
    JSON.stringify(selectedMandatory.map(({ id, kind, target }) => ({ id, kind, target })))
      === JSON.stringify(mandatory.map(({ id, kind, target }) => ({ id, kind, target }))),
    `${question}: selected obligations do not bijectively match the mandatory plan`,
  )
  assert(
    selectedMandatory.every(({ proven }) => proven),
    `${question}: selected mandatory obligation is unproven`,
  )
}

function retrieve(index, question) {
  const { plan, mandatory } = mandatoryPlan(question)
  const result = retrieveContext(index, { question, budget: 4_000 })
  assert(result.state === "ready", `${question}: ${JSON.stringify(result)}`)
  assert(result.schema === "madar.retrieve" && result.version === 2, `${question}: result contract drift`)
  assert(result.metrics.serialized_tokens <= 4_000, `${question}: token ceiling`)
  assert(result.metrics.selected_files <= 12, `${question}: file ceiling`)
  assert(result.metrics.authenticated_excerpts <= 25, `${question}: excerpt ceiling`)
  assert(result.metrics.root_candidates <= 3, `${question}: root ceiling`)
  assert(result.metrics.initial_candidates <= 32, `${question}: candidate ceiling`)
  assert(result.metrics.explored_nodes <= 512, `${question}: explored-node ceiling`)
  assert(result.metrics.causal_hops <= 24, `${question}: causal-hop ceiling`)
  assert(result.metrics.recovery_passes <= 2, `${question}: recovery-pass ceiling`)
  assert(result.metrics.recovery_frontier_nodes <= 64, `${question}: recovery ceiling`)
  assert(result.metrics.alternate_seeds <= 3, `${question}: alternate-seed ceiling`)
  assert(result.metrics.optional_bundles_omitted === 0, `${question}: ready dossier was truncated`)
  assertSelectionBijection(index, plan, mandatory, question)
  assertReferencesAndCorridor(result, plan, mandatory, question)
  const queues = [...new Set(
    result.dossier.evidence.entities
      .filter((entity) => entity.kind === "channel" && entity.channel_kind === "queue")
      .map(({ key }) => key),
  )].sort()
  assert(
    JSON.stringify(queues) === JSON.stringify(requiredQueues),
    `${question}: required queues ${JSON.stringify(queues)}`,
  )
  const flowSha256 = hash(result.dossier.flow)
  const evidenceSha256 = hash(result.dossier.evidence)
  assert(flowSha256 === EXPECTED_FLOW_SHA256, `${question}: flow attestation drift`)
  assert(evidenceSha256 === EXPECTED_EVIDENCE_SHA256, `${question}: evidence attestation drift`)
  return result
}

function expectRejection(label, callback) {
  try {
    callback()
  } catch {
    return label
  }
  throw new Error(`negative mutation was accepted: ${label}`)
}

const rawArtifact = JSON.parse(readFileSync(graphPath, "utf8"))
const corpusAttestation = assertCorpusAttestation(rawArtifact)
const index = inspectQueryIndex(loadGraphArtifact(graphPath))
assert(index.state === "ready", `graph state: ${index.state}`)
const results = questions.map((question) => retrieve(index, question))
const rows = results.map((result, index) => ({
  question: questions[index],
  serialized_tokens: result.metrics.serialized_tokens,
  flow_sha256: hash(result.dossier.flow),
  evidence_sha256: hash(result.dossier.evidence),
}))
assert(new Set(rows.map(({ flow_sha256 }) => flow_sha256)).size === 1, "flow drift")
assert(
  new Set(rows.map(({ evidence_sha256 }) => evidence_sha256)).size === 1,
  "evidence drift",
)

const negativeMutations = []
const wrongCorpus = structuredClone(rawArtifact)
wrongCorpus.metadata.index_build.sources.supported[0].hash = "0".repeat(64)
negativeMutations.push(expectRejection("wrong_corpus_attestation", () =>
  assertCorpusAttestation(wrongCorpus)))

const { plan: firstPlan, mandatory: firstMandatory } = mandatoryPlan(questions[0])
const brokenProofReference = structuredClone(results[0])
brokenProofReference.dossier.flow.links[0].proofs[0] = "p999"
negativeMutations.push(expectRejection("unknown_proof_reference", () =>
  assertReferencesAndCorridor(
    brokenProofReference,
    firstPlan,
    firstMandatory,
    questions[0],
  )))

const missingPersistence = structuredClone(results[0])
const removedPersistenceIds = new Set(missingPersistence.dossier.evidence.entities
  .filter(({ kind, operation_kind }) =>
    kind === "operation" && operation_kind === "persistence")
  .map(({ id }) => id))
missingPersistence.dossier.evidence.entities = missingPersistence.dossier.evidence.entities
  .filter(({ id }) => !removedPersistenceIds.has(id))
for (const obligation of missingPersistence.dossier.obligations) {
  obligation.proofs = obligation.proofs.filter((id) => !removedPersistenceIds.has(id))
}
for (const group of missingPersistence.dossier.flow.order) {
  group.members = group.members.filter((id) => !removedPersistenceIds.has(id))
}
negativeMutations.push(expectRejection("missing_terminal_persistence", () =>
  assertReferencesAndCorridor(
    missingPersistence,
    firstPlan,
    firstMandatory,
    questions[0],
  )))

const warmIndex = inspectQueryIndex(loadGraphArtifact(graphPath))
for (let pass = 0; pass < 3; pass += 1) {
  retrieve(warmIndex, queryFixture.beta_3_broad)
}
const samples = Array.from({ length: 100 }, () => {
  const started = performance.now()
  retrieve(warmIndex, queryFixture.beta_3_broad)
  return performance.now() - started
}).sort((left, right) => left - right)
const nearestRank = (percentile) => samples[Math.ceil(samples.length * percentile) - 1]
const p95 = nearestRank(0.95)
assert(p95 < 500, `warm retrieval p95 ${p95}ms is not below 500ms`)

process.stdout.write(`${JSON.stringify({
  graph: "generated:frozen-issue-630-corpus",
  corpus: {
    path: relative(repositoryRoot, frozenCorpusRoot).split("\\").join("/"),
    files: corpusAttestation.corpusRows.length,
    sha256: EXPECTED_CORPUS_SHA256,
    source_fingerprint: corpusAttestation.sourceFingerprint,
    graph_build_id: corpusAttestation.buildId,
  },
  prompts: rows.length,
  unique_prompts: new Set(rows.map(({ question }) => question)).size,
  ready: rows.length,
  mandatory_obligations_per_prompt: expectedObligationKinds.length,
  corridor: expectedCorridor,
  channel_handoffs: expectedChannelOrder,
  terminal_persistence: "MongoRepository<StoredReport>.update",
  flow_sha256: rows[0].flow_sha256,
  evidence_sha256: rows[0].evidence_sha256,
  serialized_tokens: rows.map(({ serialized_tokens }) => serialized_tokens),
  negative_mutations_rejected: negativeMutations,
  warm: {
    samples: samples.length,
    median_ms: nearestRank(0.5),
    p95_ms: p95,
    max_ms: samples.at(-1),
  },
}, null, 2)}\n`)
