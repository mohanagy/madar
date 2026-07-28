import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  evaluationPackageBudget,
  evaluationLeakMarkers,
  evaluationToolingLayout,
  evaluationToolingMoves,
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
const typeScriptConfig = JSON.parse(
  readFileSync(resolve(repositoryRoot, "tsconfig.json"), "utf8"),
)
const evaluationBuildConfig = JSON.parse(
  readFileSync(resolve(repositoryRoot, "tsconfig.eval.json"), "utf8"),
)
const ignoreRules = readFileSync(
  resolve(repositoryRoot, ".gitignore"),
  "utf8",
)
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
const ciWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/ci.yml"),
  "utf8",
).replaceAll("\r\n", "\n")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const inventory = sourceInventory()
const toolingLayout = evaluationToolingLayout()
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
const packageScripts = packageJson.scripts ?? {}

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
  evaluationToolingMoves.length === 20,
  "evaluation tooling contract must name exactly 20 moved modules",
)
assert(
  toolingLayout.present_old_sources.length === 0,
  `old evaluation tooling remains under src:\n${toolingLayout.present_old_sources.join("\n")}`,
)
assert(
  toolingLayout.missing_moved_sources.length === 0,
  `moved evaluation tooling is missing under tools/eval/lib:\n${toolingLayout.missing_moved_sources.join("\n")}`,
)
assert(
  toolingLayout.present_production_outputs.length === 0,
  `production dist contains moved evaluation .js/.d.ts outputs:\n${toolingLayout.present_production_outputs.join("\n")}`,
)
assert(
  toolingLayout.missing_evaluation_outputs.length === 0,
  `evaluation build is missing moved .js/.d.ts outputs:\n${toolingLayout.missing_evaluation_outputs.join("\n")}`,
)
assert(
  evaluationBuildConfig.extends === "./tsconfig.json" &&
    evaluationBuildConfig.compilerOptions?.rootDir === "." &&
    evaluationBuildConfig.compilerOptions?.outDir === "dist-eval" &&
    evaluationBuildConfig.compilerOptions?.noEmitOnError === true &&
    (evaluationBuildConfig.compilerOptions?.declaration ??
      typeScriptConfig.compilerOptions?.declaration) === true,
  "tsconfig.eval.json must emit evaluator JavaScript and declarations only under dist-eval",
)
assert(
  JSON.stringify(evaluationBuildConfig.include ?? []) ===
    JSON.stringify(["tools/eval/lib/**/*.ts"]),
  "evaluation build must include only tools/eval/lib/**/*.ts as entrypoints",
)
assert(
  (evaluationBuildConfig.exclude ?? []).includes("dist") &&
    (evaluationBuildConfig.exclude ?? []).includes("dist-eval") &&
    (evaluationBuildConfig.exclude ?? []).includes("tests/**/*.ts") &&
    (evaluationBuildConfig.exclude ?? []).includes("vitest.config.ts"),
  "evaluation build must exclude production/evaluation output and test entrypoints",
)
assert(
  packageScripts["build:eval"] === "tsc -p tsconfig.eval.json",
  "package.json must expose exactly one build:eval compiler invocation",
)
assert(
  packageScripts.build === "tsc -p tsconfig.build.json",
  "production build must remain pinned to tsconfig.build.json",
)
assert(
  packageScripts.prepack === "npm run clean && npm run build" &&
    !/(?:build:eval|tsconfig\.eval|dist-eval|tools\/eval)/u.test(
      packageScripts.clean ?? "",
    ),
  "prepack and its clean/build chain must not run or touch evaluation output",
)
assert(
  ignoreRules.includes("dist-eval/") &&
    !ignoreRules.some((rule) => rule.startsWith("!dist-eval")),
  ".gitignore must exclude dist-eval without an allowlist override",
)
assert(
  ciWorkflow.includes(
    "      - name: Build evaluation tooling\n        run: npm run build:eval",
  ) &&
    ciWorkflow.indexOf("run: npm run build:eval") <
      ciWorkflow.indexOf("run: node tools/eval/core-reset/verify-isolation.mjs"),
  "CI must build evaluation tooling before verifying package isolation",
)
assert(
  [...publishedRoots].every(
    (path) =>
      !path.startsWith("tools/") &&
      !path.startsWith("docs/") &&
      !path.startsWith("dist-eval/"),
  ),
  "npm files allowlist must exclude tools, docs, and dist-eval",
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
  packageMeasurement.forbidden_evaluation_modules.length === 0,
  `npm package contains one of the exact 20 moved modules or its output:\n${packageMeasurement.forbidden_evaluation_modules.join("\n")}`,
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
  packageMeasurement.target_passed,
  `npm package exceeds the Evaluation Tooling ceilings: ${packageMeasurement.file_count}/${evaluationPackageBudget.files_max} files / ${packageMeasurement.packed_bytes}/${evaluationPackageBudget.packed_bytes_max} packed bytes / ${packageMeasurement.unpacked_bytes}/${evaluationPackageBudget.unpacked_bytes_max} unpacked bytes`,
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
    `- Evaluation tooling moves: ${evaluationToolingMoves.length} exact modules`,
    `- Old src evaluation modules present: ${toolingLayout.present_old_sources.length}/20`,
    `- Moved tools/eval/lib modules present: ${20 - toolingLayout.missing_moved_sources.length}/20`,
    `- Moved evaluation outputs absent from production dist: ${40 - toolingLayout.present_production_outputs.length}/40`,
    `- Moved evaluation outputs present in dist-eval: ${40 - toolingLayout.missing_evaluation_outputs.length}/40`,
    `- Package: ${packageMeasurement.file_count} files / ${packageMeasurement.packed_bytes} packed bytes / ${packageMeasurement.unpacked_bytes} unpacked bytes`,
    `- Exact moved modules or outputs in package: 0/${evaluationToolingMoves.length * 6} forbidden paths`,
    "- tools/** and dist-eval/** paths in package: 0",
    "- Evaluation assets in package: 0",
    "- Evaluation commands or paths in package metadata: 0",
    `- Load-bearing held-out/performance markers scanned in package contents: ${packageContentMarkers.size}`,
    "- Production imports from evaluation: 0",
    `- Exact held-out and performance leak markers: ${evaluationMarkers.size}`,
    "- Held-out evaluation markers in production: 0",
  ].join("\n") + "\n",
)
