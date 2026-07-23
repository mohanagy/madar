import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  evaluationLeakMarkers,
  inspectPackageContents,
  loadBearingEvaluationMarkers,
  productionEvaluationLeaks,
  productionImportViolations,
  sourceInventory,
} from "./isolation-support.mjs"
import { validateContractSemantics } from "./contract-validation.mjs"

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, "..", "..", "..")
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
)
const contract = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "tools/eval/core-reset/contracts/evaluation-contract.json",
    ),
    "utf8",
  ),
)
const performanceDescriptor = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "tools/eval/core-reset/contracts/evidence-path-performance-v2.json",
    ),
    "utf8",
  ),
)
const buildConfig = JSON.parse(
  readFileSync(resolve(repositoryRoot, "tsconfig.build.json"), "utf8"),
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const inventory = sourceInventory()
validateContractSemantics(contract)
const importViolations = productionImportViolations(inventory.paths)
const performanceMarkers = [
  performanceDescriptor.fixture_id,
  performanceDescriptor.generator.algorithm,
  performanceDescriptor.generator.seed,
  performanceDescriptor.generator.source_file,
  performanceDescriptor.generator.source_text_rule,
  ...performanceDescriptor.queries,
  ...performanceDescriptor.query_expectations
    .filter((expectation) => expectation.outcome === "missing")
    .flatMap((expectation) =>
      expectation.boundaries.map((boundary) => boundary.subject),
    ),
]
const evaluationLeaks = productionEvaluationLeaks(
  inventory.paths,
  contract,
  performanceMarkers,
)
const evaluationMarkers = evaluationLeakMarkers(contract, performanceMarkers)
const packageContentMarkers = loadBearingEvaluationMarkers(
  contract,
  performanceMarkers,
)
const packageMeasurement = inspectPackageContents(packageContentMarkers)
const publishedRoots = new Set(packageJson.files ?? [])

assert(
  buildConfig.compilerOptions?.rootDir === "src",
  "tsconfig.build.json must keep rootDir at src",
)
assert(
  buildConfig.compilerOptions?.outDir === "dist/src",
  "tsconfig.build.json must keep outDir at dist/src",
)
assert(
  buildConfig.compilerOptions?.noEmitOnError === true,
  "tsconfig.build.json must not emit after type errors",
)
assert(
  (buildConfig.include ?? []).length === 1 &&
    buildConfig.include[0] === "src/**/*.ts",
  "production build must include only src/**/*.ts",
)
assert(
  !publishedRoots.has("tools/") && !publishedRoots.has("docs/"),
  "npm files allowlist must exclude tools and docs",
)
assert(
  importViolations.length === 0,
  `production imports evaluation evidence:\n${importViolations.join("\n")}`,
)
assert(
  contract.owner_fixtures.every(
    (fixture) =>
      evaluationMarkers.has(fixture.id) &&
      evaluationMarkers.has(fixture.source_file) &&
      evaluationMarkers.has(fixture.source_sha256) &&
      evaluationMarkers.has(fixture.declaration_sha256),
  ),
  "isolation markers must cover every exact owner-fixture identity and authenticated source",
)
assert(
  contract.questions.every((question) =>
    question.required_handoffs.every((handoff) =>
      evaluationMarkers.has(
        `${handoff.from_owner_id}=>${handoff.to_owner_id}:${handoff.expectation}`,
      ),
    ),
  ),
  "isolation markers must cover every exact disconnected-handoff identity",
)
assert(
  contract.owner_fixtures.every(
    (fixture) => !evaluationMarkers.has(fixture.symbol),
  ),
  "isolation must not ban unqualified symbol names such as run, GET, or Client",
)
assert(
  performanceMarkers.every((marker) => evaluationMarkers.has(marker)),
  "isolation markers must cover the performance fixture, generator, queries, source templates, and missing subject",
)
assert(
  evaluationLeaks.length === 0,
  `production embeds held-out evaluation data:\n${evaluationLeaks.join("\n")}`,
)
assert(
  packageMeasurement.forbidden_paths.length === 0,
  `npm package contains evaluation evidence:\n${packageMeasurement.forbidden_paths.join("\n")}`,
)
assert(
  packageMeasurement.forbidden_metadata.length === 0,
  `npm package metadata contains evaluation evidence:\n${packageMeasurement.forbidden_metadata.join("\n")}`,
)
assert(
  packageMeasurement.forbidden_content.length === 0,
  `npm package contents embed load-bearing evaluation evidence:\n${packageMeasurement.forbidden_content.join("\n")}`,
)
assert(
  !existsSync(resolve(repositoryRoot, "dist", "tools")),
  "build emitted dist/tools",
)
assert(
  !existsSync(resolve(repositoryRoot, "dist", "docs")),
  "build emitted dist/docs",
)

process.stdout.write(
  [
    "Core Reset isolation verified.",
    `- Production: ${inventory.files} TypeScript files / ${inventory.loc} LOC`,
    `- Package: ${packageMeasurement.file_count} files / ${packageMeasurement.unpacked_bytes} unpacked bytes`,
    "- Evaluation assets in package: 0",
    "- Evaluation commands or paths in package metadata: 0",
    `- Load-bearing held-out/performance markers scanned in package contents: ${packageContentMarkers.size}`,
    "- Production imports from evaluation: 0",
    `- Exact held-out and performance leak markers: ${evaluationMarkers.size}`,
    "- Held-out evaluation markers in production: 0",
  ].join("\n") + "\n",
)
