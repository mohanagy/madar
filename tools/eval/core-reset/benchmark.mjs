import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { loadGraphArtifact } from "../../../dist/src/adapters/filesystem/graph-artifact.js"
import { retrieveContext } from "../../../dist/src/application/retrieve-context.js"
import { inspectQueryIndex } from "../../../dist/src/domain/query/index-status.js"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const graphPath = process.argv[2]
if (!graphPath) {
  throw new Error("usage: node tools/eval/core-reset/benchmark.mjs <graph.json>")
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
const requiredQueues = [
  "assembly-queue",
  "db-sync-queue",
  "orchestration-queue",
  "section-research-queue",
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function retrieve(index, question) {
  const result = retrieveContext(index, { question, budget: 4_000 })
  assert(result.state === "ready", `${question}: ${JSON.stringify(result)}`)
  assert(result.metrics.serialized_tokens <= 4_000, `${question}: token ceiling`)
  assert(result.metrics.selected_files <= 12, `${question}: file ceiling`)
  assert(result.metrics.authenticated_excerpts <= 25, `${question}: excerpt ceiling`)
  assert(result.metrics.root_candidates <= 3, `${question}: root ceiling`)
  assert(result.metrics.initial_candidates <= 32, `${question}: candidate ceiling`)
  assert(result.metrics.explored_nodes <= 512, `${question}: explored-node ceiling`)
  assert(result.metrics.causal_hops <= 24, `${question}: causal-hop ceiling`)
  assert(result.metrics.recovery_passes <= 2, `${question}: recovery-pass ceiling`)
  assert(result.metrics.recovery_frontier_nodes <= 64, `${question}: recovery ceiling`)
  const queues = [...new Set(
    JSON.stringify(result.dossier).match(/[a-z]+(?:-[a-z]+)*-queue/g) ?? [],
  )].sort()
  assert(
    JSON.stringify(queues) === JSON.stringify(requiredQueues),
    `${question}: required queues ${JSON.stringify(queues)}`,
  )
  assert(
    result.dossier.obligations.every((obligation) => obligation.proofs.length > 0),
    `${question}: unproven obligation`,
  )
  return result
}

const index = inspectQueryIndex(loadGraphArtifact(resolve(graphPath)))
assert(index.state === "ready", `graph state: ${index.state}`)
const rows = questions.map((question) => {
  const result = retrieve(index, question)
  return {
    question,
    serialized_tokens: result.metrics.serialized_tokens,
    flow_sha256: hash(result.dossier.flow),
    evidence_sha256: hash(result.dossier.evidence),
  }
})
assert(new Set(rows.map(({ flow_sha256 }) => flow_sha256)).size === 1, "flow drift")
assert(
  new Set(rows.map(({ evidence_sha256 }) => evidence_sha256)).size === 1,
  "evidence drift",
)

const warmIndex = inspectQueryIndex(loadGraphArtifact(resolve(graphPath)))
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
  graph: resolve(graphPath),
  prompts: rows.length,
  ready: rows.length,
  flow_sha256: rows[0].flow_sha256,
  evidence_sha256: rows[0].evidence_sha256,
  serialized_tokens: rows.map(({ serialized_tokens }) => serialized_tokens),
  required_queues: requiredQueues,
  warm: {
    samples: samples.length,
    median_ms: nearestRank(0.5),
    p95_ms: p95,
    max_ms: samples.at(-1),
  },
}, null, 2)}\n`)
