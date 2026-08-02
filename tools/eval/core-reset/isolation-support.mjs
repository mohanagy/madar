import { spawnSync } from "node:child_process"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import { evidencePathsForPhase } from "./contract-validation.mjs"

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, "..", "..", "..")
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const gitCommand = process.platform === "win32" ? "git.exe" : "git"
const forbiddenPackagePrefixes = [
  "tools/",
  "docs/core-reset/",
  "dist-eval/",
  "dist/tools/",
  "dist/docs/",
]
const forbiddenPackageMetadataMarkers = [
  "tools/eval",
  "docs/core-reset",
  "core-reset:",
]

const evaluationToolingSources = [
  "src/infrastructure/benchmark.ts",
  "src/infrastructure/benchmark/corpus.ts",
  "src/infrastructure/benchmark/environment.ts",
  "src/infrastructure/benchmark/generate-performance.ts",
  "src/infrastructure/benchmark/quality.ts",
  "src/infrastructure/benchmark/questions.ts",
  "src/infrastructure/benchmark/runner.ts",
  "src/infrastructure/benchmark/runtime-proof.ts",
  "src/infrastructure/benchmark/suite.ts",
  "src/infrastructure/benchmark/usage.ts",
  "src/infrastructure/compare.ts",
  "src/infrastructure/prompt-runner.ts",
  "src/infrastructure/save-query-result.ts",
  "src/infrastructure/try-command.ts",
  "src/runtime/benchmark/probe-calibration.ts",
  "src/shared/graph-source-root.ts",
  "src/shared/package-metadata.ts",
  "src/shared/share-safe-artifacts.ts",
  "src/shared/shell.ts",
  "src/shared/workspace-copy.ts",
]

export const evaluationToolingMoves = Object.freeze(
  evaluationToolingSources.map((source) =>
    Object.freeze({
      source,
      destination: source.replace(/^src\//u, "tools/eval/lib/"),
    }),
  ),
)

export const evaluationPackageBudget = Object.freeze({
  files_max: 102,
  packed_bytes_max: 165_000,
  unpacked_bytes_max: 640_000,
})

function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function isRegularFile(path) {
  try {
    return lstatSync(path).isFile()
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function emittedTypeScriptPaths(source, outputRoot) {
  const stem = source.slice(0, -".ts".length)
  return [`${outputRoot}/${stem}.js`, `${outputRoot}/${stem}.d.ts`]
}

export function evaluationToolingLayout(root = repositoryRoot) {
  const oldSources = evaluationToolingMoves.map(({ source }) => source)
  const movedSources = evaluationToolingMoves.map(
    ({ destination }) => destination,
  )
  const productionOutputs = evaluationToolingMoves.flatMap(({ source }) =>
    emittedTypeScriptPaths(source, "dist"),
  )
  const evaluationOutputs = evaluationToolingMoves.flatMap(
    ({ destination }) => emittedTypeScriptPaths(destination, "dist-eval"),
  )

  return {
    old_sources: oldSources,
    moved_sources: movedSources,
    production_outputs: productionOutputs,
    evaluation_outputs: evaluationOutputs,
    present_old_sources: oldSources.filter((path) =>
      pathExists(join(root, path)),
    ),
    missing_moved_sources: movedSources.filter(
      (path) => !isRegularFile(join(root, path)),
    ),
    present_production_outputs: productionOutputs.filter((path) =>
      pathExists(join(root, path)),
    ),
    missing_evaluation_outputs: evaluationOutputs.filter(
      (path) => !isRegularFile(join(root, path)),
    ),
  }
}

function controlledEnvironment() {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    const upperName = name.toUpperCase()
    if (
      upperName === "NODE_OPTIONS" ||
      upperName === "NODE_PATH" ||
      upperName.startsWith("GIT_") ||
      upperName.startsWith("MADAR_") ||
      upperName.startsWith("NPM_CONFIG_")
    ) {
      delete environment[name]
    }
  }
  return {
    ...environment,
    CI: "1",
    LANG: "C",
    LANGUAGE: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: controlledEnvironment(),
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed (${result.status}): ${command} ${args.join(" ")}`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
  return result.stdout ?? ""
}

function normalizePath(path) {
  return path.replaceAll("\\", "/")
}

export function sourceInventory(root = repositoryRoot) {
  const paths = []
  const filesystemViolations = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = normalizePath(relative(root, absolute))
      if (entry.isSymbolicLink()) {
        filesystemViolations.push(`${path}: symbolic link under src`)
      } else if (entry.isDirectory()) {
        visit(absolute)
      } else if (entry.isFile() && path.endsWith(".ts")) {
        paths.push(path)
      }
    }
  }
  visit(join(root, "src"))
  paths.sort()
  const loc = paths.reduce((total, path) => {
    const source = readFileSync(join(root, path), "utf8")
    const lineFeeds = source.match(/\n/g)?.length ?? 0
    return (
      total + lineFeeds + (source.length > 0 && !source.endsWith("\n") ? 1 : 0)
    )
  }, 0)
  return { files: paths.length, loc, paths, filesystemViolations }
}

const commandOutputRecords = (output) => output.split("\0").filter(Boolean)

export function productionSourceDelta(baselineCommit, root = repositoryRoot) {
  const lines = commandOutputRecords(
    run(
      gitCommand,
      [
        "diff",
        "--ignore-cr-at-eol",
        "--no-ext-diff",
        "--no-renames",
        "--numstat",
        "-z",
        baselineCommit,
        "--",
        "src",
      ],
      { cwd: root },
    ),
  )
  let added = 0
  let removed = 0
  for (const line of lines) {
    const [rawAdded = "0", rawRemoved = "0"] = line.split("\t")
    added += rawAdded === "-" ? 0 : Number(rawAdded)
    removed += rawRemoved === "-" ? 0 : Number(rawRemoved)
  }
  const trackedPaths = new Set(
    commandOutputRecords(
      run(gitCommand, ["ls-files", "--cached", "-z", "--", "src"], {
        cwd: root,
      }),
    ).map(normalizePath),
  )
  for (const path of sourceInventory(root).paths.filter(
    (candidate) => !trackedPaths.has(candidate),
  )) {
    const source = readFileSync(join(root, path), "utf8")
    const lineFeeds = source.match(/\n/g)?.length ?? 0
    added += lineFeeds + (source.length > 0 && !source.endsWith("\n") ? 1 : 0)
  }
  return { added, removed, net: added - removed }
}

function importedSpecifiers(source) {
  const sourceFile = ts.createSourceFile(
    "production-source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const specifiers = []
  const staticText = (node) =>
    ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : null
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      const specifier = staticText(node.moduleSpecifier)
      if (specifier !== null) specifiers.push(specifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      const specifier = staticText(node.moduleReference.expression)
      if (specifier !== null) specifiers.push(specifier)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require"
      const isRequireResolve =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "require" &&
        node.expression.name.text === "resolve"
      if (isDynamicImport || isRequire || isRequireResolve) {
        const specifier = staticText(node.arguments[0])
        if (specifier !== null) specifiers.push(specifier)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

export function productionImportViolations(paths) {
  const violations = []
  for (const path of paths) {
    const source = readFileSync(join(repositoryRoot, path), "utf8")
    for (const specifier of importedSpecifiers(source)) {
      if (
        specifier.includes("tools/eval") ||
        specifier.includes("docs/core-reset/evidence")
      ) {
        violations.push(`${path}: ${specifier}`)
      }
    }
  }
  return violations
}

export function evaluationLeakMarkers(contract, extraMarkers = []) {
  return new Set([
    ...forbiddenPackageMetadataMarkers,
    ...contract.repositories.flatMap((repository) => [
      repository.id,
      repository.url,
    ]),
    ...contract.human_rubric.dimensions,
    ...loadBearingEvaluationMarkers(contract, extraMarkers),
  ])
}

export function loadBearingEvaluationMarkers(contract, extraMarkers = []) {
  return new Set([
    ...extraMarkers,
    contract.contract_id,
    ...contract.repositories.flatMap((repository) => [
      repository.commit,
      repository.tree_paths_sha256,
      ...repository.verified_evidence_paths,
    ]),
    ...(contract.owner_fixtures ?? []).flatMap((fixture) => [
      fixture.id,
      fixture.source_file,
      fixture.source_sha256,
      fixture.declaration_sha256,
    ]),
    ...contract.questions.flatMap((question) => [
      question.id,
      question.prompt,
      ...question.required_phases.flatMap((phase) => [
        phase.id,
        phase.label,
        ...evidencePathsForPhase(phase, contract),
      ]),
      ...(question.required_handoffs ?? []).map(
        (handoff) =>
          `${handoff.from_owner_id}=>${handoff.to_owner_id}:${handoff.expectation}`,
      ),
    ]),
  ])
}

export function productionEvaluationLeaks(paths, contract, extraMarkers = []) {
  const forbidden = evaluationLeakMarkers(contract, extraMarkers)
  const violations = []
  for (const path of paths) {
    const source = readFileSync(join(repositoryRoot, path), "utf8")
    for (const marker of forbidden) {
      if (source.includes(marker)) violations.push(`${path}: ${marker}`)
    }
  }
  return violations
}

function parseNpmPackJson(output) {
  const trimmed = output.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed[0]
    if (parsed && typeof parsed === "object") {
      if ("files" in parsed) return parsed
      return Object.values(parsed)[0]
    }
  } catch {
    const start = trimmed.indexOf("[")
    const end = trimmed.lastIndexOf("]")
    if (start >= 0 && end > start)
      return JSON.parse(trimmed.slice(start, end + 1))[0]
  }
  throw new Error("npm pack did not return a recognized JSON record")
}

export function packageContentLeaks(paths, markers, root = repositoryRoot) {
  const violations = []
  for (const path of paths) {
    const bytes = readFileSync(join(root, path))
    for (const marker of markers) {
      if (bytes.includes(Buffer.from(marker, "utf8"))) {
        violations.push(`${path}: ${marker}`)
      }
    }
  }
  return violations
}

export function inspectPackageContents(
  markers = [],
  budget = evaluationPackageBudget,
) {
  const record = parseNpmPackJson(
    run(npmCommand, [
      "pack",
      "--json",
      "--dry-run",
      "--ignore-scripts",
      "--silent",
    ]),
  )
  if (!record || !Array.isArray(record.files)) {
    throw new Error("npm pack dry-run record is missing files")
  }
  const paths = record.files.map((entry) =>
    normalizePath(String(entry.path ?? "")),
  )
  const fileCount = Number(record.entryCount ?? paths.length)
  const packedBytes = Number(record.size)
  const unpackedBytes = Number(record.unpackedSize)
  if (![fileCount, packedBytes, unpackedBytes].every(Number.isFinite)) {
    throw new Error(
      "npm pack dry-run returned non-numeric package measurements",
    )
  }
  const exactEvaluationPaths = new Set([
    ...evaluationToolingMoves.flatMap(({ source, destination }) => [
      source,
      destination,
    ]),
    ...evaluationToolingMoves.flatMap(({ source }) =>
      emittedTypeScriptPaths(source, "dist"),
    ),
    ...evaluationToolingMoves.flatMap(({ destination }) =>
      emittedTypeScriptPaths(destination, "dist-eval"),
    ),
  ])
  const packageMetadata = readFileSync(
    join(repositoryRoot, "package.json"),
    "utf8",
  )
  return {
    file_count: fileCount,
    packed_bytes: packedBytes,
    unpacked_bytes: unpackedBytes,
    target_passed:
      fileCount <= budget.files_max &&
      packedBytes <= budget.packed_bytes_max &&
      unpackedBytes <= budget.unpacked_bytes_max,
    forbidden_paths: paths.filter((path) =>
      forbiddenPackagePrefixes.some((prefix) => path.startsWith(prefix)),
    ),
    forbidden_evaluation_modules: paths.filter((path) =>
      exactEvaluationPaths.has(path),
    ),
    forbidden_metadata: forbiddenPackageMetadataMarkers.filter((marker) =>
      packageMetadata.includes(marker),
    ),
    forbidden_content: packageContentLeaks(paths, markers),
  }
}
