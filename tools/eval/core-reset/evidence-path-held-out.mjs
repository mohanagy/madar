import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs"
import { arch, platform, release, tmpdir } from "node:os"
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { TextDecoder } from "node:util"

let Ajv2020
let addFormats
let countTokens
let ts

if (process.argv[2] !== "--internal-plan") {
  ;[
    { default: Ajv2020 },
    { default: addFormats },
    { countTokens },
    { default: ts },
  ] = await Promise.all([
    import("ajv/dist/2020.js"),
    import("ajv-formats"),
    import("gpt-tokenizer/encoding/cl100k_base"),
    import("typescript"),
  ])
}

const scriptPath = fileURLToPath(import.meta.url)
const scriptRoot = dirname(scriptPath)
const repositoryRoot = resolve(scriptRoot, "..", "..", "..")
const defaultContractPath = join(
  scriptRoot,
  "contracts",
  "evaluation-contract.json",
)
const defaultReceiptPath = resolve(
  repositoryRoot,
  "docs/core-reset/evidence/evidence-path-held-out.json",
)
const receiptSchemaPath = join(
  scriptRoot,
  "schemas",
  "evidence-path-held-out-receipt.schema.json",
)
const expectedContractSha256 =
  "c22819a9e24e53f7b11a69c06511a8dc0c2cba8841868d8d9bb734575290bba9"
const utf8 = new TextDecoder("utf-8", { fatal: true })
const gitBinary = "/usr/bin/git"
const tarBinary = "/usr/bin/bsdtar"
const cleanProgram =
  'import { rmSync } from "node:fs"; rmSync("dist", { recursive: true, force: true })'
const containmentPolicyId = "darwin-sandbox-exec-node-permissions-v1"
export const generateCommand = Object.freeze([
  "node",
  "dist/src/adapters/cli/bin.js",
  "generate",
  ".",
])
const gitConfiguration = Object.freeze([
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "protocol.ext.allow=never",
  "protocol.ssh.allow=never",
  "protocol.http.allow=never",
  "protocol.https.allow=never",
  "protocol.file.allow=always",
  "fetch.fsckObjects=true",
  "transfer.fsckObjects=true",
  "submodule.recurse=false",
])
const resultLimits = Object.freeze({
  selected_files_max: 12,
  snippets_max: 25,
  serialized_tokens_max: 4_000,
  reported_closure_passes_max: 1,
})
const allowedStructuralRelations = new Set(["imports_from", "contains"])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function executeGenerationBarrier({
  repositories,
  questions,
  generateRepository,
  retrieveQuestion,
}) {
  const contexts = new Map()
  for (const repository of repositories) {
    assert(
      !contexts.has(repository.id),
      `held-out repository ${repository.id} was generated twice`,
    )
    contexts.set(repository.id, generateRepository(repository))
  }
  assert(
    contexts.size === repositories.length &&
      repositories.every((repository) => contexts.has(repository.id)),
    "all held-out repositories must finish generation before retrieval",
  )
  for (const repository of repositories) {
    const context = contexts.get(repository.id)
    assert(context, `missing generated context for ${repository.id}`)
    for (const question of questions.filter(
      (candidate) => candidate.repository_id === repository.id,
    )) {
      retrieveQuestion({ repository, question, context })
    }
  }
  return contexts
}

function normalizedPath(path) {
  return path.replaceAll("\\", "/")
}

function repositoryRelative(path) {
  return normalizedPath(relative(repositoryRoot, resolve(repositoryRoot, path)))
}

function safeRelativePath(path, label) {
  assert(
    typeof path === "string" &&
      path.length > 0 &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      !path
        .split("/")
        .some((segment) => !segment || segment === "." || segment === ".."),
    `${label} must be a safe repository-relative path`,
  )
  return path
}

function graphPathToRepositoryPath(graphRoot, sourceFile) {
  return graphRoot === "." ? sourceFile : `${graphRoot}/${sourceFile}`
}

function sourceIsBeneathRoot(root, source) {
  const path = relative(root, source)
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function canonicalFactsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function positionOffset(text, position) {
  if (
    position === null ||
    typeof position !== "object" ||
    !Number.isSafeInteger(position.line) ||
    position.line < 1 ||
    !Number.isSafeInteger(position.column) ||
    position.column < 1
  ) {
    return null
  }
  const lineStarts = [0]
  const lineEnds = []
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code !== 10 && code !== 13 && code !== 0x2028 && code !== 0x2029)
      continue
    lineEnds.push(index)
    if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1
    lineStarts.push(index + 1)
  }
  lineEnds.push(text.length)
  const lineIndex = position.line - 1
  const start = lineStarts[lineIndex]
  const end = lineEnds[lineIndex]
  if (start === undefined || end === undefined) return null
  const offset = start + position.column - 1
  return offset <= end ? offset : null
}

export function exactUtf16Range(text, range) {
  if (range === null || typeof range !== "object") return null
  const start = positionOffset(text, range.start)
  const end = positionOffset(text, range.end)
  if (start === null || end === null || end < start) return null
  return text.slice(start, end)
}

function comparePositions(left, right) {
  if (left.line !== right.line) return left.line - right.line
  return left.column - right.column
}

function parseArguments(argv) {
  const options = {
    contract: defaultContractPath,
    receipt: defaultReceiptPath,
    repositories: new Map(),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--contract" || argument === "--receipt") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a path`)
      options[argument.slice(2)] = resolve(value)
      index += 1
      continue
    }
    if (argument === "--repository") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error("--repository requires id=local-path")
      }
      const separator = value.indexOf("=")
      if (separator < 1 || separator === value.length - 1) {
        throw new Error(
          `Invalid --repository ${JSON.stringify(value)}; expected id=local-path`,
        )
      }
      const id = value.slice(0, separator)
      if (options.repositories.has(id))
        throw new Error(`Repository ${id} was supplied twice`)
      options.repositories.set(id, value.slice(separator + 1))
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

function internalExecutionPlan(contractPath) {
  const contractBytes = readFileSync(resolve(contractPath))
  assert(
    sha256(contractBytes) === expectedContractSha256,
    `frozen contract hash mismatch: expected ${expectedContractSha256}, observed ${sha256(contractBytes)}`,
  )
  const contract = JSON.parse(contractBytes.toString("utf8"))
  const selectedQuestions = contract.questions.filter(
    (question) =>
      question.gate_role === "blocking" ||
      question.id === "openstatus-574-strict-one-call",
  )
  const selectedRepositoryIds = new Set(
    selectedQuestions.map((question) => question.repository_id),
  )
  return {
    schema_version: 2,
    contract_id: contract.contract_id,
    contract_sha256: sha256(contractBytes),
    repositories: contract.repositories
      .filter((repository) => selectedRepositoryIds.has(repository.id))
      .map((repository) => ({
        id: repository.id,
        commit: repository.commit,
        tree_paths_sha256: repository.tree_paths_sha256,
        graph_root: repository.graph_root,
      })),
    questions: selectedQuestions.map((question) => ({
      id: question.id,
      repository_id: question.repository_id,
      prompt: question.prompt,
    })),
  }
}

function assertCleanEvaluatorProcess() {
  assert(
    !process.env.NODE_OPTIONS && !process.env.NODE_PATH,
    "held-out evaluation forbids inherited Node preload/module paths",
  )
  assert(
    process.execArgv.length === 0,
    "held-out evaluation requires a plain Node process with no exec arguments",
  )
}

function loadExecutionPlan(contractPath) {
  const { stdout: output } = run(
    process.execPath,
    [scriptPath, "--internal-plan", contractPath],
    {
      cwd: repositoryRoot,
      maxBuffer: 4 * 1024 * 1024,
      env: controlledEnvironment(),
    },
  )
  const plan = JSON.parse(output)
  const serialized = canonicalJson(plan)
  for (const secret of [
    "owner_fixtures",
    "required_phases",
    "required_handoffs",
    "accepted_owner_ids",
    "declaration_range",
    "declaration_sha256",
    "source_sha256",
  ]) {
    assert(!serialized.includes(secret), `execution plan leaked ${secret}`)
  }
  assert(
    plan.contract_id === "core-reset-held-out-v2",
    "held-out plan is not v2",
  )
  assert(
    plan.questions.length === 3,
    "held-out execution plan must contain three questions",
  )
  assert(
    plan.repositories.length === 3,
    "held-out execution plan must contain three repositories",
  )
  return plan
}

function controlledEnvironment(overrides = {}) {
  const environment = {}
  for (const name of [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TMP",
    "TEMP",
  ]) {
    if (typeof process.env[name] === "string") {
      environment[name] = process.env[name]
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
    MADAR_TELEMETRY: "off",
    NO_UPDATE_NOTIFIER: "1",
    ...overrides,
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? controlledEnvironment(),
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
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
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function assertFrozenDarwinTool(path, label) {
  assert(platform() === "darwin", "held-out evaluation requires Darwin")
  assert(existsSync(path), `frozen Darwin ${label} is unavailable at ${path}`)
  const stat = lstatSync(path)
  assert(
    stat.isFile() && !stat.isSymbolicLink(),
    `frozen Darwin ${label} must be a regular non-symlink file`,
  )
}

function resolveNpmCli() {
  const nodeDirectory = dirname(realpathSync(process.execPath))
  const candidates = [
    resolve(
      nodeDirectory,
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    resolve(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
  ]
  const npmCli = candidates.find((path) => existsSync(path))
  assert(
    npmCli !== undefined,
    "could not resolve npm-cli.js beside the running Node installation",
  )
  return realpathSync(npmCli)
}

function npmCliArguments(npmCli, args, npmConfigs) {
  return [
    npmCli,
    ...args,
    `--userconfig=${npmConfigs.userConfig}`,
    `--globalconfig=${npmConfigs.globalConfig}`,
  ]
}

export function createNpmConfigPair(root) {
  mkdirSync(root, { recursive: true })
  const userConfig = join(root, "user.npmrc")
  const globalConfig = join(root, "global.npmrc")
  persistResponse(userConfig, "")
  persistResponse(globalConfig, "")
  const canonicalUserConfig = realpathSync(userConfig)
  const canonicalGlobalConfig = realpathSync(globalConfig)
  assert(
    canonicalUserConfig !== canonicalGlobalConfig,
    "npm user and global config files must be distinct",
  )
  return {
    userConfig: canonicalUserConfig,
    globalConfig: canonicalGlobalConfig,
  }
}

function gitArguments(args) {
  return [...gitConfiguration.flatMap((entry) => ["-c", entry]), ...args]
}

function gitOutput(cwd, ...args) {
  return run(gitBinary, gitArguments(["-C", cwd, ...args]), {
    cwd: repositoryRoot,
  }).stdout
}

function git(cwd, ...args) {
  return gitOutput(cwd, ...args).trim()
}

function treePathHash(cwd, commit) {
  const paths = gitOutput(
    cwd,
    "ls-tree",
    "-r",
    "-t",
    "--full-tree",
    "--name-only",
    commit,
  )
    .trimEnd()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
  return sha256(`${paths.join("\n")}\n`)
}

function treeEntries(root, { excludeGit = false } = {}) {
  const entries = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = normalizedPath(relative(root, absolute))
      if (excludeGit && (path === ".git" || path.startsWith(".git/"))) continue
      if (entry.isDirectory()) {
        visit(absolute)
        continue
      }
      if (entry.isSymbolicLink()) {
        entries.push({
          path,
          symlink: normalizedPath(readlinkSync(absolute)),
        })
        continue
      }
      assert(entry.isFile(), `tree contains unsupported entry ${absolute}`)
      const bytes = readFileSync(absolute)
      entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) })
    }
  }
  visit(root)
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"))
  return entries
}

function treeAttestation(root, options = {}) {
  const entries = treeEntries(root, options)
  assert(entries.length > 0, "attested tree contains no files")
  return { files: entries.length, tree_sha256: sha256(canonicalJson(entries)) }
}

function parseJsonObject(path, label) {
  const value = JSON.parse(utf8.decode(readFileSync(path)))
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must contain a JSON object`,
  )
  return value
}

function workspacePatternSegments(pattern) {
  assert(
    typeof pattern === "string" &&
      pattern.length > 0 &&
      !isAbsolute(pattern) &&
      !pattern.includes("\\"),
    "workspace patterns must be non-empty relative POSIX paths",
  )
  const segments = pattern.split("/")
  assert(
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        (segment === "*" ||
          segment === "**" ||
          !/[*?[\]{}()!+|]/u.test(segment)),
    ),
    `unsupported workspace pattern: ${pattern}`,
  )
  return segments
}

export function workspacePatternMatches(pattern, directory) {
  const patternSegments = workspacePatternSegments(pattern)
  const directorySegments = safeRelativePath(
    directory,
    "workspace package directory",
  ).split("/")
  const memo = new Map()
  const match = (patternIndex, directoryIndex) => {
    const key = `${patternIndex}:${directoryIndex}`
    if (memo.has(key)) return memo.get(key)
    let result
    if (patternIndex === patternSegments.length) {
      result = directoryIndex === directorySegments.length
    } else if (patternSegments[patternIndex] === "**") {
      result =
        match(patternIndex + 1, directoryIndex) ||
        (directoryIndex < directorySegments.length &&
          match(patternIndex, directoryIndex + 1))
    } else {
      result =
        directoryIndex < directorySegments.length &&
        (patternSegments[patternIndex] === "*" ||
          patternSegments[patternIndex] ===
            directorySegments[directoryIndex]) &&
        match(patternIndex + 1, directoryIndex + 1)
    }
    memo.set(key, result)
    return result
  }
  return match(0, 0)
}

function packageNameSegments(name) {
  assert(
    typeof name === "string" && name.length > 0 && !name.includes("\\"),
    "workspace package names must be non-empty POSIX package names",
  )
  const segments = name.split("/")
  const packageSegment = /^[a-z0-9][a-z0-9._-]*$/u
  const unscoped =
    segments.length === 1 && packageSegment.test(segments[0])
  const scoped =
    segments.length === 2 &&
    segments[0].startsWith("@") &&
    packageSegment.test(segments[0].slice(1)) &&
    packageSegment.test(segments[1])
  assert(
    unscoped || scoped,
    `unsupported workspace package name: ${name}`,
  )
  return segments
}

function packageNameFromConfigSpecifier(specifier) {
  assert(
    typeof specifier === "string" && !specifier.includes("\\"),
    "TypeScript config extends entries must be POSIX strings",
  )
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  ) {
    return null
  }
  const segments = specifier.split("/")
  if (specifier.startsWith("@")) {
    if (segments.length < 2) return null
    return `${segments[0]}/${segments[1]}`
  }
  return segments[0] ?? null
}

function configPackageNames(root, { allJsonConfigs = false } = {}) {
  const names = new Set()
  for (const entry of treeEntries(root)) {
    const isConfig = allJsonConfigs
      ? entry.path.endsWith(".json") &&
        entry.path !== "package.json" &&
        !entry.path.endsWith("/package.json")
      : /(^|\/)(?:ts|js)config(?:\.[^/]+)?\.json$/u.test(entry.path)
    if (!isConfig) continue
    assert(
      !("symlink" in entry),
      `compiler config cannot be a symlink: ${entry.path}`,
    )
    const path = resolve(root, entry.path)
    const parsed = ts.parseConfigFileTextToJson(
      path,
      utf8.decode(readFileSync(path)),
    )
    assert(!parsed.error, `invalid compiler config: ${entry.path}`)
    const config = parsed.config
    assert(
      config !== null && typeof config === "object" && !Array.isArray(config),
      `compiler config must be an object: ${entry.path}`,
    )
    const extended = config.extends
    const specifiers =
      extended === undefined
        ? []
        : typeof extended === "string"
          ? [extended]
          : Array.isArray(extended) &&
              extended.every((value) => typeof value === "string")
            ? extended
            : null
    assert(specifiers !== null, `invalid extends field: ${entry.path}`)
    for (const specifier of specifiers) {
      const name = packageNameFromConfigSpecifier(specifier)
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

function workspacePackageMap(generationCheckout) {
  const rootManifest = parseJsonObject(
    join(generationCheckout, "package.json"),
    "root package.json",
  )
  if (rootManifest.workspaces === undefined) return new Map()
  assert(
    Array.isArray(rootManifest.workspaces) &&
      rootManifest.workspaces.length > 0 &&
      rootManifest.workspaces.every((pattern) => typeof pattern === "string"),
    "root package.json workspaces must be a non-empty string array",
  )
  const patterns = rootManifest.workspaces.map((pattern) => {
    workspacePatternSegments(pattern)
    return pattern
  })
  const packages = new Map()
  for (const entry of treeEntries(generationCheckout)) {
    if (
      entry.path === "package.json" ||
      !entry.path.endsWith("/package.json")
    ) {
      continue
    }
    const directory = entry.path.slice(0, -"/package.json".length)
    if (
      !patterns.some((pattern) =>
        workspacePatternMatches(pattern, directory),
      )
    ) {
      continue
    }
    assert(
      !("symlink" in entry),
      `workspace package manifest cannot be a symlink: ${entry.path}`,
    )
    const manifest = parseJsonObject(
      resolve(generationCheckout, entry.path),
      entry.path,
    )
    assert(
      typeof manifest.name === "string",
      `workspace package manifest requires a valid name: ${entry.path}`,
    )
    const segments = packageNameSegments(manifest.name)
    assert(
      !packages.has(manifest.name),
      `duplicate workspace package name: ${manifest.name}`,
    )
    packages.set(manifest.name, {
      name: manifest.name,
      segments,
      source: resolve(generationCheckout, directory),
      source_path: directory,
    })
  }
  return packages
}

function copyAuthenticatedTree(source, target) {
  const sourceEntries = treeEntries(source)
  assert(sourceEntries.length > 0, `workspace package is empty: ${source}`)
  assert(!existsSync(target), `workspace config target already exists: ${target}`)
  for (const entry of sourceEntries) {
    assert(
      !("symlink" in entry) &&
        entry.path !== "node_modules" &&
        !entry.path.startsWith("node_modules/"),
      `workspace config package contains an unsupported path: ${entry.path}`,
    )
    const destination = resolve(target, entry.path)
    assert(
      sourceIsBeneathRoot(target, destination),
      `workspace config path escaped target: ${entry.path}`,
    )
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(resolve(source, entry.path), destination)
  }
  const sourceAttestation = treeAttestation(source)
  const targetAttestation = treeAttestation(target)
  assert(
    canonicalFactsEqual(sourceAttestation, targetAttestation),
    "materialized workspace config bytes differ from tracked source",
  )
  return sourceAttestation
}

export function materializeWorkspaceConfigView(
  generationCheckout,
  generationGraphRoot,
) {
  const nodeModulesRoot = resolve(generationGraphRoot, "node_modules")
  assert(
    lstatSync(nodeModulesRoot, { throwIfNoEntry: false }) === undefined,
    "generation graph root must not contain node_modules",
  )
  const workspacePackages = workspacePackageMap(generationCheckout)
  const selected = new Set()
  const queue = configPackageNames(generationGraphRoot)
  while (queue.length > 0) {
    const name = queue.shift()
    if (selected.has(name)) continue
    const workspacePackage = workspacePackages.get(name)
    if (!workspacePackage) continue
    selected.add(name)
    for (const dependency of configPackageNames(workspacePackage.source, {
      allJsonConfigs: true,
    })) {
      if (!selected.has(dependency)) queue.push(dependency)
    }
  }

  const mappings = [...selected].sort().map((name) => {
    const workspacePackage = workspacePackages.get(name)
    assert(workspacePackage, `missing selected workspace package: ${name}`)
    const target = resolve(
      nodeModulesRoot,
      ...workspacePackage.segments,
    )
    assert(
      sourceIsBeneathRoot(nodeModulesRoot, target) &&
        target !== nodeModulesRoot,
      `workspace config target escaped graph root: ${name}`,
    )
    const attestation = copyAuthenticatedTree(workspacePackage.source, target)
    return {
      name,
      source_path: workspacePackage.source_path,
      target_path: normalizedPath(relative(generationGraphRoot, target)),
      files: attestation.files,
      tree_sha256: attestation.tree_sha256,
    }
  })
  return {
    packages: mappings.length,
    mapping_sha256: sha256(canonicalJson(mappings)),
  }
}

export function directoryTreeAttestation(root) {
  const attestation = treeAttestation(root)
  return {
    dist_files: attestation.files,
    dist_tree_sha256: attestation.tree_sha256,
  }
}

export function assertMatchingRuntimeTrees(expected, observed) {
  assert(
    expected.dist_files === observed.dist_files &&
      expected.dist_tree_sha256 === observed.dist_tree_sha256,
    "packed candidate runtime does not match the clean-built dist tree",
  )
}

function prepareCandidateRuntime(harnessRoot) {
  const headCommit = git(repositoryRoot, "rev-parse", "HEAD")
  const headTreeOid = git(repositoryRoot, "rev-parse", "HEAD^{tree}")
  assert(
    git(
      repositoryRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ) === "",
    "candidate worktree must be clean before the held-out runtime build",
  )
  const buildSource = join(harnessRoot, "candidate-source")
  run(
    gitBinary,
    gitArguments([
      "clone",
      "--no-local",
      "--no-checkout",
      "--no-tags",
      repositoryRoot,
      buildSource,
    ]),
    { timeout: 600_000 },
  )
  git(buildSource, "checkout", "--detach", headCommit)
  if (git(buildSource, "remote").split(/\r?\n/).includes("origin")) {
    git(buildSource, "remote", "remove", "origin")
  }
  assert(
    git(buildSource, "rev-parse", "HEAD") === headCommit &&
      git(buildSource, "rev-parse", "HEAD^{tree}") === headTreeOid,
    "candidate build clone is not the exact subject HEAD/tree",
  )
  const lockBytes = readFileSync(join(buildSource, "package-lock.json"))
  const npmCli = resolveNpmCli()
  const npmCache = realpathSync(
    process.env.NPM_CONFIG_CACHE ??
      process.env.npm_config_cache ??
      join(process.env.HOME ?? tmpdir(), ".npm"),
  )
  const npmConfigs = createNpmConfigPair(join(harnessRoot, "npm-config"))
  const buildEnvironment = controlledEnvironment({
    HOME: join(harnessRoot, "build-home"),
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: npmConfigs.userConfig,
    NPM_CONFIG_GLOBALCONFIG: npmConfigs.globalConfig,
  })
  mkdirSync(buildEnvironment.HOME, { recursive: true })
  run(
    process.execPath,
    npmCliArguments(
      npmCli,
      ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      npmConfigs,
    ),
    {
      cwd: buildSource,
      env: buildEnvironment,
      timeout: 600_000,
    },
  )
  const buildDependencies = directoryTreeAttestation(
    join(buildSource, "node_modules"),
  )
  run(process.execPath, ["--eval", cleanProgram], {
    cwd: buildSource,
    env: buildEnvironment,
    timeout: 600_000,
  })
  const typescriptCli = realpathSync(
    join(buildSource, "node_modules", "typescript", "bin", "tsc"),
  )
  run(
    process.execPath,
    [typescriptCli, "-p", "tsconfig.build.json"],
    {
      cwd: buildSource,
      env: buildEnvironment,
      timeout: 600_000,
    },
  )
  const distRoot = realpathSync(join(buildSource, "dist"))
  const dist = directoryTreeAttestation(distRoot)
  const packRoot = join(harnessRoot, "candidate-package")
  mkdirSync(packRoot, { recursive: true })
  const pack = run(
    process.execPath,
    npmCliArguments(
      npmCli,
      ["pack", "--ignore-scripts", "--json", "--pack-destination", packRoot],
      npmConfigs,
    ),
    {
      cwd: buildSource,
      env: buildEnvironment,
      timeout: 600_000,
    },
  )
  const packResult = JSON.parse(pack.stdout)
  assert(
    Array.isArray(packResult) &&
      packResult.length === 1 &&
      typeof packResult[0]?.filename === "string",
    "npm pack did not produce exactly one candidate package",
  )
  const packagePath = realpathSync(join(packRoot, packResult[0].filename))
  const packageBytes = readFileSync(packagePath)
  const extractionRoot = join(harnessRoot, "candidate-runtime")
  mkdirSync(extractionRoot, { recursive: true })
  run(tarBinary, ["-xzf", packagePath, "-C", extractionRoot], {
    cwd: harnessRoot,
    timeout: 600_000,
  })
  const runtimeRoot = realpathSync(join(extractionRoot, "package"))
  for (const excluded of ["tools", "docs"]) {
    assert(
      !existsSync(join(runtimeRoot, excluded)),
      `packed candidate unexpectedly exposes evaluator ${excluded}`,
    )
  }
  const packedDist = directoryTreeAttestation(join(runtimeRoot, "dist"))
  assertMatchingRuntimeTrees(dist, packedDist)
  copyFileSync(
    join(buildSource, "package-lock.json"),
    join(runtimeRoot, "package-lock.json"),
  )
  const runtimeHome = join(harnessRoot, "runtime-home")
  mkdirSync(runtimeHome, { recursive: true })
  run(
    process.execPath,
    npmCliArguments(
      npmCli,
      [
        "ci",
        "--offline",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      npmConfigs,
    ),
    {
      cwd: runtimeRoot,
      env: controlledEnvironment({
        HOME: runtimeHome,
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_CACHE: npmCache,
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        NPM_CONFIG_USERCONFIG: npmConfigs.userConfig,
        NPM_CONFIG_GLOBALCONFIG: npmConfigs.globalConfig,
      }),
      timeout: 600_000,
    },
  )
  const installedLockBytes = readFileSync(
    join(runtimeRoot, "package-lock.json"),
  )
  assert(
    sha256(installedLockBytes) === sha256(lockBytes),
    "offline production dependency install changed package-lock.json",
  )
  assert(
    sha256(readFileSync(join(buildSource, "package-lock.json"))) ===
      sha256(lockBytes),
    "candidate build changed package-lock.json",
  )
  const dependencies = directoryTreeAttestation(
    join(runtimeRoot, "node_modules"),
  )
  const cleanAfter =
    git(
      repositoryRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ) === ""
  assert(cleanAfter, "candidate runtime build changed the worktree")
  assert(
    git(repositoryRoot, "rev-parse", "HEAD") === headCommit &&
      git(repositoryRoot, "rev-parse", "HEAD^{tree}") === headTreeOid,
    "candidate HEAD changed during the held-out runtime build",
  )
  return {
    commands: [
      [
        "node",
        "<resolved-npm-cli>",
        "ci",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--userconfig=<isolated-empty-user-config>",
        "--globalconfig=<isolated-empty-global-config>",
      ],
      ["node", "--eval", cleanProgram],
      ["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
      [
        "node",
        "<resolved-npm-cli>",
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        "<isolated>",
        "--userconfig=<isolated-empty-user-config>",
        "--globalconfig=<isolated-empty-global-config>",
      ],
      [
        "node",
        "<resolved-npm-cli>",
        "ci",
        "--offline",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--userconfig=<isolated-empty-user-config>",
        "--globalconfig=<isolated-empty-global-config>",
      ],
    ],
    performed_before_runtime_load: true,
    build_source: "detached_standalone_exact_head_clone",
    node_executable_sha256: sha256(readFileSync(process.execPath)),
    npm_cli_sha256: sha256(readFileSync(npmCli)),
    typescript_cli_sha256: sha256(readFileSync(typescriptCli)),
    git_executable: gitBinary,
    git_executable_sha256: sha256(readFileSync(gitBinary)),
    tar_executable: tarBinary,
    tar_executable_sha256: sha256(readFileSync(tarBinary)),
    git_configuration: [...gitConfiguration],
    head_commit: headCommit,
    head_tree_oid: headTreeOid,
    head_tree_paths_sha256: treePathHash(buildSource, headCommit),
    worktree_clean_before: true,
    worktree_clean_after: cleanAfter,
    build_dependency_files: buildDependencies.dist_files,
    build_dependency_tree_sha256: buildDependencies.dist_tree_sha256,
    package_sha256: sha256(packageBytes),
    package_bytes: packageBytes.length,
    package_lock_sha256: sha256(lockBytes),
    dependency_files: dependencies.dist_files,
    dependency_tree_sha256: dependencies.dist_tree_sha256,
    ...dist,
    runtime_root: runtimeRoot,
  }
}

function clonePinnedRepository(repository, source, destination) {
  const suppliedPath = resolve(source)
  assert(
    existsSync(suppliedPath),
    `${repository.id} requires a prepared local Git checkout`,
  )
  const localSource = realpathSync(suppliedPath)
  assert(
    git(localSource, "rev-parse", "--is-inside-work-tree") === "true",
    `${repository.id} source is not a Git worktree`,
  )
  run(
    gitBinary,
    gitArguments([
      "clone",
      "--no-local",
      "--no-checkout",
      "--no-tags",
      localSource,
      destination,
    ]),
    { timeout: 600_000 },
  )
  try {
    git(destination, "cat-file", "-e", `${repository.commit}^{commit}`)
  } catch {
    throw new Error(
      `${repository.id} prepared checkout does not contain ${repository.commit}`,
    )
  }
  git(destination, "checkout", "--detach", repository.commit)
  const head = git(destination, "rev-parse", "HEAD")
  assert(
    head === repository.commit,
    `${repository.id} checkout resolved to ${head}`,
  )
  assert(
    git(destination, "status", "--porcelain=v1", "--untracked-files=all") ===
      "",
    `${repository.id} checkout is dirty`,
  )
  const gitCommonDir = realpathSync(
    resolve(destination, git(destination, "rev-parse", "--git-common-dir")),
  )
  const cloneGitDir = realpathSync(join(destination, ".git"))
  assert(
    gitCommonDir === cloneGitDir,
    `${repository.id} is not a standalone clone`,
  )
  const observedTreeHash = treePathHash(destination, repository.commit)
  assert(
    observedTreeHash === repository.tree_paths_sha256,
    `${repository.id} tree-path hash mismatch: ${observedTreeHash}`,
  )
  if (git(destination, "remote").split(/\r?\n/).includes("origin")) {
    git(destination, "remote", "remove", "origin")
  }
  return {
    checkout: realpathSync(destination),
  }
}

class HeldOutArtifactGraph {
  constructor(artifact) {
    this.metadata = artifact.metadata
    this.nodes = new Map(
      artifact.nodes.map((node) => [node.id, node.attributes]),
    )
    this.edges = artifact.edges.map((edge) => [
      edge.source,
      edge.target,
      edge.attributes,
      edge.id,
    ])
  }

  hasNode(id) {
    return this.nodes.has(id)
  }

  nodeAttributes(id) {
    const attributes = this.nodes.get(id)
    assert(attributes, `generated graph is missing node ${id}`)
    return attributes
  }

  nodeEntries() {
    return [...this.nodes.entries()]
  }

  edgeEntries() {
    return this.edges
  }

  numberOfNodes() {
    return this.nodes.size
  }

  numberOfEdges() {
    return this.edges.length
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function loadHeldOutGraph(graphBytes) {
  const artifact = JSON.parse(graphBytes.toString("utf8"))
  assert(
    isRecord(artifact) &&
      artifact.schema === "madar.graph" &&
      artifact.version === 2 &&
      artifact.directed === true &&
      isRecord(artifact.metadata) &&
      Array.isArray(artifact.nodes) &&
      Array.isArray(artifact.edges),
    "candidate generated an unsupported graph artifact",
  )
  const nodeIds = new Set()
  for (const node of artifact.nodes) {
    assert(
      isRecord(node) &&
        typeof node.id === "string" &&
        isRecord(node.attributes) &&
        !nodeIds.has(node.id),
      "candidate generated an invalid or duplicate graph node",
    )
    nodeIds.add(node.id)
  }
  const edgeIds = new Set()
  for (const edge of artifact.edges) {
    assert(
      isRecord(edge) &&
        typeof edge.id === "string" &&
        typeof edge.source === "string" &&
        typeof edge.target === "string" &&
        isRecord(edge.attributes) &&
        nodeIds.has(edge.source) &&
        nodeIds.has(edge.target) &&
        !edgeIds.has(edge.id),
      "candidate generated an invalid or duplicate graph edge",
    )
    edgeIds.add(edge.id)
  }
  return new HeldOutArtifactGraph(artifact)
}

export function isolatedRetrieveChildSource() {
  return `import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const [runtimeRoot, graphPath, requestPath] = process.argv.slice(2)
const probeKey = Symbol.for("madar.held-out.process-state")
globalThis[probeKey] = (globalThis[probeKey] ?? 0) + 1
const moduleUrl = (path) => pathToFileURL(\`\${runtimeRoot}/\${path}\`).href
const [artifactRuntime, indexRuntime, retrieveRuntime] = await Promise.all([
  import(moduleUrl("dist/src/domain/graph/artifact.js")),
  import(moduleUrl("dist/src/domain/query/index-status.js")),
  import(moduleUrl("dist/src/application/retrieve-context.js")),
])
const graph = artifactRuntime.deserializeGraphArtifact(readFileSync(graphPath, "utf8"))
const index = indexRuntime.inspectQueryIndex(graph)
if (index.state !== "ready") throw new Error(\`candidate query index is \${index.state}\`)
const request = JSON.parse(readFileSync(requestPath, "utf8"))
let retrieveInvocations = 0
retrieveInvocations += 1
const result = retrieveRuntime.retrieveContext(index, {
  question: request.question,
  budget: request.budget,
})
const serialized = retrieveRuntime.serializeRetrieveContextResult(result)
process.stdout.write(JSON.stringify({
  schema: "madar.held-out-child",
  version: 1,
  pid: process.pid,
  process_state_probe: globalThis[probeKey],
  retrieve_invocations: retrieveInvocations,
  serialized,
}))
`
}

function sandboxPathSelector(path) {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  return existsSync(path) && lstatSync(path).isDirectory()
    ? `(subpath "${escaped}")`
    : `(literal "${escaped}")`
}

function darwinSandboxProfile(writePaths) {
  const writes = [...new Set(["/dev/null", ...writePaths])]
    .map(sandboxPathSelector)
    .join(" ")
  const evaluatorRoot = sandboxPathSelector(repositoryRoot)
  return `(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec)
(allow process-exec ${sandboxPathSelector(process.execPath)})
(deny file-read* ${evaluatorRoot})
(deny file-write*)
(allow file-write* ${writes})
`
}

export function runContainedNode({
  entryPath,
  args = [],
  pathArgIndexes = [],
  cwd,
  env,
  readPaths,
  writePaths = [],
  profilePath,
  timeout = 300_000,
}) {
  assert(
    platform() === "darwin",
    "held-out execution requires Darwin sandbox-exec containment",
  )
  const canonicalPath = (path) => {
    if (existsSync(path)) return realpathSync(path)
    return join(
      realpathSync(dirname(path)),
      path.slice(dirname(path).length + 1),
    )
  }
  const canonicalEntryPath = canonicalPath(entryPath)
  const canonicalReadPaths = [...new Set(readPaths.map(canonicalPath))]
  const canonicalWritePaths = [...new Set(writePaths.map(canonicalPath))]
  const canonicalArgIndexes = new Set(pathArgIndexes)
  const canonicalArgs = args.map((argument, index) =>
    canonicalArgIndexes.has(index) ? canonicalPath(argument) : argument,
  )
  const nodeArguments = [
    "--no-warnings",
    "--experimental-permission",
    ...canonicalReadPaths.map((path) => `--allow-fs-read=${path}`),
    ...canonicalWritePaths.map((path) => `--allow-fs-write=${path}`),
    canonicalEntryPath,
    ...canonicalArgs,
  ]
  const sandboxBinary = "/usr/bin/sandbox-exec"
  assert(
    existsSync(sandboxBinary),
    "Darwin sandbox-exec is unavailable for held-out containment",
  )
  persistResponse(
    profilePath,
    darwinSandboxProfile(canonicalWritePaths),
  )
  const canonicalProfilePath = realpathSync(profilePath)
  return run(
    sandboxBinary,
    ["-f", canonicalProfilePath, process.execPath, ...nodeArguments],
    { cwd: canonicalPath(cwd), env, timeout },
  )
}

export function runIsolatedRetrieveChild({
  entryPath,
  runtimeRoot,
  graphPath,
  requestPath,
  sourceRoot,
}) {
  const stateRoot = dirname(requestPath)
  const runtimeReadPaths = candidateRuntimeReadPaths(runtimeRoot)
  const readablePaths = [
    entryPath,
    ...runtimeReadPaths,
    graphPath,
    requestPath,
    sourceRoot,
    stateRoot,
  ]
  const child = runContainedNode({
    entryPath,
    args: [runtimeRoot, graphPath, requestPath],
    pathArgIndexes: [0, 1, 2],
    cwd: stateRoot,
    env: controlledEnvironment({
      HOME: stateRoot,
      TMPDIR: stateRoot,
    }),
    readPaths: readablePaths,
    writePaths: [stateRoot],
    profilePath: join(stateRoot, "retrieve.sb"),
    timeout: 300_000,
  })
  const envelope = JSON.parse(child.stdout)
  assert(
    isRecord(envelope) &&
      envelope.schema === "madar.held-out-child" &&
      envelope.version === 1 &&
      Number.isSafeInteger(envelope.pid) &&
      envelope.pid > 0 &&
      envelope.process_state_probe === 1 &&
      envelope.retrieve_invocations === 1 &&
      typeof envelope.serialized === "string",
    "isolated retrieve child returned an invalid proof envelope",
  )
  return envelope
}

function candidateRuntimeReadPaths(runtimeRoot) {
  const paths = [
    join(runtimeRoot, "dist"),
    join(runtimeRoot, "node_modules"),
    join(runtimeRoot, "package.json"),
  ]
  for (const path of paths) {
    assert(existsSync(path), `candidate runtime path is missing: ${path}`)
  }
  return paths.map((path) => realpathSync(path))
}

function buildGraph(
  repository,
  checkout,
  harnessRoot,
  candidateRuntimeRoot,
) {
  const graphRoot =
    repository.graph_root === "."
      ? checkout
      : resolve(
          checkout,
          safeRelativePath(
            repository.graph_root,
            `${repository.id} graph_root`,
          ),
        )
  const realCheckout = realpathSync(checkout)
  const realGraphRoot = realpathSync(graphRoot)
  assert(
    sourceIsBeneathRoot(realCheckout, realGraphRoot) ||
      realGraphRoot === realCheckout,
    `${repository.id} graph_root escaped checkout`,
  )
  const generationArchive = join(
    harnessRoot,
    "generation-sources",
    `${repository.id}.tar`,
  )
  const generationCheckout = join(
    harnessRoot,
    "generation-sources",
    repository.id,
  )
  mkdirSync(dirname(generationArchive), { recursive: true })
  mkdirSync(generationCheckout, { recursive: true })
  run(
    gitBinary,
    gitArguments([
      "-C",
      checkout,
      "archive",
      "--format=tar",
      "--output",
      generationArchive,
      repository.commit,
    ]),
    { timeout: 600_000 },
  )
  run(tarBinary, ["-xf", generationArchive, "-C", generationCheckout], {
    cwd: harnessRoot,
    timeout: 600_000,
  })
  rmSync(generationArchive, { force: true })
  const checkoutTree = treeAttestation(realCheckout, { excludeGit: true })
  const generationTree = treeAttestation(generationCheckout, {
    excludeGit: true,
  })
  assert(
    canonicalFactsEqual(checkoutTree, generationTree),
    `${repository.id} archived generation source differs from the pinned checkout`,
  )
  const generationGraphRoot =
    repository.graph_root === "."
      ? realpathSync(generationCheckout)
      : realpathSync(resolve(generationCheckout, repository.graph_root))
  assert(
    !existsSync(join(generationCheckout, ".git")),
    `${repository.id} generation snapshot exposed VCS metadata`,
  )
  const workspaceConfigView = materializeWorkspaceConfigView(
    generationCheckout,
    generationGraphRoot,
  )
  const workspaceConfigRoot = join(generationGraphRoot, "node_modules")
  const stateRoot = join(harnessRoot, "build-state", repository.id)
  const environment = controlledEnvironment({
    HOME: join(stateRoot, "home"),
    XDG_CONFIG_HOME: join(stateRoot, "xdg-config"),
    XDG_CACHE_HOME: join(stateRoot, "xdg-cache"),
    XDG_DATA_HOME: join(stateRoot, "xdg-data"),
    TMPDIR: join(stateRoot, "tmp"),
  })
  for (const path of [
    environment.HOME,
    environment.XDG_CONFIG_HOME,
    environment.XDG_CACHE_HOME,
    environment.XDG_DATA_HOME,
    environment.TMPDIR,
  ]) {
    mkdirSync(path, { recursive: true })
  }
  assert(
    git(checkout, "status", "--porcelain=v1", "--untracked-files=all") === "",
    `${repository.id} checkout changed before graph generation`,
  )
  const cliPath = resolve(candidateRuntimeRoot, "dist/src/adapters/cli/bin.js")
  const outputRoot = join(generationGraphRoot, "out")
  mkdirSync(outputRoot, { recursive: true })
  const started = performance.now()
  try {
    runContainedNode({
      entryPath: cliPath,
      args: generateCommand.slice(2),
      cwd: generationGraphRoot,
      env: environment,
      readPaths: [
        ...candidateRuntimeReadPaths(candidateRuntimeRoot),
        generationGraphRoot,
        stateRoot,
      ],
      writePaths: [outputRoot, stateRoot],
      profilePath: join(harnessRoot, "sandbox", `${repository.id}-generate.sb`),
      timeout: 600_000,
    })
  } finally {
    rmSync(workspaceConfigRoot, {
      recursive: true,
      force: true,
    })
  }
  assert(
    lstatSync(workspaceConfigRoot, { throwIfNoEntry: false }) === undefined,
    `${repository.id} temporary workspace config view survived generation`,
  )
  const elapsedMs = Number((performance.now() - started).toFixed(3))
  const generatedGraph = join(generationGraphRoot, "out", "graph.json")
  assert(
    existsSync(generatedGraph),
    `${repository.id} generate did not create out/graph.json`,
  )
  const generatedStat = lstatSync(generatedGraph)
  assert(
    generatedStat.isFile() && !generatedStat.isSymbolicLink(),
    `${repository.id} graph artifact is not a regular file`,
  )
  const artifactDir = join(harnessRoot, "artifacts", repository.id)
  mkdirSync(artifactDir, { recursive: true })
  const externalGraph = join(artifactDir, "graph.json")
  renameSync(generatedGraph, externalGraph)
  rmSync(join(generationGraphRoot, "out"), { recursive: true, force: true })
  assert(
    git(checkout, "status", "--porcelain=v1", "--untracked-files=all") === "",
    `${repository.id} generation left repository output`,
  )
  const graphBytes = readFileSync(externalGraph)
  const graph = loadHeldOutGraph(graphBytes)
  assert(
    typeof graph.metadata.root_path === "string" &&
      realpathSync(graph.metadata.root_path) === generationGraphRoot,
    `${repository.id} graph artifact source root does not match the generation snapshot`,
  )
  const edgeById = new Map(
    graph
      .edgeEntries()
      .map(([from, to, attributes, id]) => [id, { from, to, attributes }]),
  )
  return {
    graphRoot: generationGraphRoot,
    graph,
    edgeById,
    graphArtifactPath: realpathSync(externalGraph),
    build: {
      source_snapshot_files: generationTree.files,
      source_snapshot_tree_sha256: generationTree.tree_sha256,
      workspace_config_packages: workspaceConfigView.packages,
      workspace_config_mapping_sha256: workspaceConfigView.mapping_sha256,
      elapsed_ms: elapsedMs,
      artifact_sha256: sha256(graphBytes),
      artifact_bytes: graphBytes.length,
      nodes: graph.numberOfNodes(),
      directed_edges: graph.numberOfEdges(),
      generated_output_absent_before_retrieve: !existsSync(
        join(generationGraphRoot, "out"),
      ),
    },
  }
}

function persistResponse(path, serialized) {
  mkdirSync(dirname(path), { recursive: true })
  const handle = openSync(path, "w", 0o600)
  try {
    writeSync(handle, serialized, null, "utf8")
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  const bytes = readFileSync(path)
  assert(
    bytes.toString("utf8") === serialized,
    `persisted response changed at ${path}`,
  )
  return { bytes: bytes.length, sha256: sha256(bytes) }
}

export function assertShareSafeReceipt(receipt, privateRoots) {
  const serialized = canonicalJson(receipt)
  for (const root of privateRoots) {
    const paths = new Set([resolve(root)])
    if (existsSync(root)) paths.add(realpathSync(root))
    for (const path of paths) {
      const aliases = path.startsWith("/private/var/")
        ? [path, path.slice("/private".length)]
        : path.startsWith("/var/")
          ? [path, `/private${path}`]
          : [path]
      const serializedAliases = aliases.flatMap((candidate) => [
        candidate,
        JSON.stringify(candidate).slice(1, -1),
      ])
      assert(
        serializedAliases.every((candidate) => !serialized.includes(candidate)),
        "share-safe receipt contains a private absolute path",
      )
    }
  }
}

function canonicalFileFacts(graph) {
  const byPath = new Map()
  for (const [nodeId, attributes] of graph.nodeEntries()) {
    if (
      attributes.node_kind !== "file" ||
      typeof attributes.source_file !== "string"
    )
      continue
    const entries = byPath.get(attributes.source_file) ?? []
    entries.push({ node_id: nodeId, content_hash: attributes.content_hash })
    byPath.set(attributes.source_file, entries)
  }
  return byPath
}

function rangeIsValid(range) {
  return (
    range !== null &&
    typeof range === "object" &&
    Number.isSafeInteger(range.start?.line) &&
    range.start.line > 0 &&
    Number.isSafeInteger(range.start?.column) &&
    range.start.column > 0 &&
    Number.isSafeInteger(range.end?.line) &&
    range.end.line > 0 &&
    Number.isSafeInteger(range.end?.column) &&
    range.end.column > 0
  )
}

function selectedFilePaths(result, repository) {
  const paths = []
  for (const node of result.matched_nodes) {
    if (typeof node.source_file !== "string") continue
    try {
      safeRelativePath(node.source_file, `node ${node.node_id} source_file`)
      paths.push(
        graphPathToRepositoryPath(repository.graph_root, node.source_file),
      )
    } catch {}
  }
  for (const relationship of result.relationships) {
    if (typeof relationship.source_file !== "string") continue
    try {
      safeRelativePath(
        relationship.source_file,
        `relationship ${relationship.id} source_file`,
      )
      paths.push(
        graphPathToRepositoryPath(
          repository.graph_root,
          relationship.source_file,
        ),
      )
    } catch {}
  }
  return [...new Set(paths)].sort()
}

/**
 * Authenticate a persisted result against the generated graph and pinned
 * checkout. This function deliberately knows nothing about hidden owner
 * fixtures; fixture matching happens only after the response is durable.
 */
export function auditPersistedResult(
  result,
  repository,
  context,
  serializedResult,
) {
  assert(
    result?.schema === "madar.retrieve" && result?.version === 1,
    "persisted retrieve result must use madar.retrieve version 1",
  )
  const nodeIds = new Set()
  const nodePathById = new Map()
  const evidenceKindById = new Map()
  const acceptedNodeIds = new Set()
  const structuralNodeIds = new Set()
  const authenticatedSymbols = []
  const structuralPaths = new Set()
  const invalidNodeFacts = []
  const filesByPath = canonicalFileFacts(context.graph)

  for (const [selectionIndex, node] of result.matched_nodes.entries()) {
    const reasons = []
    let repositoryPath = null
    let sourceText = null
    let sourceHash = null
    if (nodeIds.has(node.node_id)) reasons.push("duplicate_node_id")
    nodeIds.add(node.node_id)
    evidenceKindById.set(node.node_id, node.evidence_kind)
    try {
      safeRelativePath(node.source_file, `node ${node.node_id} source_file`)
      repositoryPath = graphPathToRepositoryPath(
        repository.graph_root,
        node.source_file,
      )
      nodePathById.set(node.node_id, repositoryPath)
      if (!context.graph.hasNode(node.node_id)) {
        reasons.push("node_absent_from_graph")
      } else {
        const attributes = context.graph.nodeAttributes(node.node_id)
        for (const key of ["label", "node_kind", "source_file"]) {
          if (node[key] !== attributes[key])
            reasons.push(`graph_${key}_mismatch`)
        }
        if (
          node.source_domain !== undefined &&
          node.source_domain !== attributes.source_domain
        ) {
          reasons.push("graph_source_domain_mismatch")
        }
        if (!canonicalFactsEqual(node.provenance, attributes.provenance)) {
          reasons.push("graph_provenance_mismatch")
        }
      }
      const canonicalFiles = filesByPath.get(node.source_file) ?? []
      const canonicalFile =
        canonicalFiles.length === 1 ? canonicalFiles[0] : null
      if (!canonicalFile) {
        reasons.push(
          canonicalFiles.length === 0
            ? "canonical_file_node_missing"
            : "canonical_file_node_ambiguous",
        )
      } else if (typeof canonicalFile.content_hash !== "string") {
        reasons.push("canonical_file_content_hash_invalid")
      } else {
        if (node.content_hash !== canonicalFile.content_hash) {
          reasons.push("result_content_hash_mismatch")
        }
      }
      const candidate = realpathSync(
        resolve(context.graphRoot, node.source_file),
      )
      if (!sourceIsBeneathRoot(context.graphRoot, candidate)) {
        reasons.push("source_escaped_graph_root")
      }
      const bytes = readFileSync(candidate)
      sourceHash = sha256(bytes)
      sourceText = utf8.decode(bytes)
      if (canonicalFile && sourceHash !== canonicalFile.content_hash) {
        reasons.push("source_content_hash_mismatch")
      }
      const attributes = context.graph.hasNode(node.node_id)
        ? context.graph.nodeAttributes(node.node_id)
        : null
      if (node.evidence_kind === "structural_file") {
        structuralNodeIds.add(node.node_id)
        if (node.node_kind !== "file")
          reasons.push("structural_node_kind_not_file")
        for (const key of [
          "source_location",
          "line_number",
          "end_line_number",
          "definition_range",
          "declaration_range",
          "snippet",
        ]) {
          if (Object.hasOwn(node, key))
            reasons.push(`structural_${key}_forbidden`)
        }
      } else if (node.evidence_kind === "symbol_declaration") {
        if (node.node_kind === "file")
          reasons.push("symbol_declaration_is_file")
        if (!rangeIsValid(node.definition_range))
          reasons.push("definition_range_invalid")
        if (!rangeIsValid(node.declaration_range))
          reasons.push("declaration_range_invalid")
        if (!attributes) {
          reasons.push("symbol_graph_attributes_missing")
        } else {
          if (
            !canonicalFactsEqual(
              node.definition_range,
              attributes.definition_range,
            )
          ) {
            reasons.push("graph_definition_range_mismatch")
          }
          if (
            !canonicalFactsEqual(
              node.declaration_range,
              attributes.declaration_range,
            )
          ) {
            reasons.push("graph_declaration_range_mismatch")
          }
        }
        const excerpt = exactUtf16Range(sourceText, node.declaration_range)
        const definition = exactUtf16Range(sourceText, node.definition_range)
        if (definition === null) reasons.push("definition_range_out_of_bounds")
        if (excerpt === null) reasons.push("declaration_range_out_of_bounds")
        if (
          rangeIsValid(node.definition_range) &&
          rangeIsValid(node.declaration_range) &&
          (comparePositions(
            node.declaration_range.start,
            node.definition_range.start,
          ) < 0 ||
            comparePositions(
              node.declaration_range.end,
              node.definition_range.end,
            ) > 0)
        ) {
          reasons.push("declaration_range_outside_definition")
        }
        if (typeof node.snippet !== "string" || node.snippet !== excerpt) {
          reasons.push("declaration_excerpt_mismatch")
        }
      } else {
        reasons.push("evidence_kind_invalid")
      }
    } catch {
      reasons.push("node_authentication_error")
    }
    const uniqueReasons = [...new Set(reasons)].sort()
    if (uniqueReasons.length > 0) {
      invalidNodeFacts.push({
        node_id: node.node_id,
        repository_path: repositoryPath,
        reasons: uniqueReasons,
      })
      continue
    }
    acceptedNodeIds.add(node.node_id)
    if (node.evidence_kind === "structural_file") {
      structuralPaths.add(repositoryPath)
    } else {
      const attributes = context.graph.nodeAttributes(node.node_id)
      authenticatedSymbols.push({
        node_id: node.node_id,
        repository_path: repositoryPath,
        symbol: attributes.qualified_name ?? attributes.symbol ?? node.label,
        node_kind: node.node_kind,
        source_sha256: sourceHash,
        definition_range: node.definition_range,
        declaration_range: node.declaration_range,
        declaration_sha256: sha256(node.snippet),
        selection_index: selectionIndex,
      })
    }
  }

  const relationshipIds = new Set()
  const relationshipTuples = new Set()
  const invalidRelationshipFacts = []
  const acceptedRelationships = []
  const structuralRelationships = new Map(
    [...structuralNodeIds].map((nodeId) => [nodeId, 0]),
  )
  for (const relationship of result.relationships) {
    const reasons = []
    if (relationshipIds.has(relationship.id))
      reasons.push("duplicate_relationship_id")
    relationshipIds.add(relationship.id)
    const tuple = canonicalJson({
      from_id: relationship.from_id,
      relation: relationship.relation,
      to_id: relationship.to_id,
    })
    if (relationshipTuples.has(tuple)) {
      reasons.push("duplicate_directed_typed_relationship")
    }
    relationshipTuples.add(tuple)
    const edge = context.edgeById.get(relationship.id)
    if (!edge) {
      reasons.push("relationship_absent_from_graph")
    } else {
      if (edge.from !== relationship.from_id) reasons.push("from_id_mismatch")
      if (edge.to !== relationship.to_id) reasons.push("to_id_mismatch")
      if (edge.attributes.relation !== relationship.relation)
        reasons.push("relation_mismatch")
      if (edge.attributes.source_file !== relationship.source_file) {
        reasons.push("source_file_mismatch")
      }
      if (edge.attributes.source_location !== relationship.source_location) {
        reasons.push("source_location_mismatch")
      }
      if (
        !canonicalFactsEqual(
          edge.attributes.provenance,
          relationship.provenance,
        )
      ) {
        reasons.push("provenance_mismatch")
      }
    }
    if (
      !acceptedNodeIds.has(relationship.from_id) ||
      !acceptedNodeIds.has(relationship.to_id)
    ) {
      reasons.push("relationship_endpoint_not_authenticated")
    }
    const structuralEndpoints = [
      relationship.from_id,
      relationship.to_id,
    ].filter((id) => structuralNodeIds.has(id))
    if (
      structuralEndpoints.length > 0 &&
      !allowedStructuralRelations.has(relationship.relation)
    ) {
      reasons.push("structural_relationship_not_allowed")
    }
    if (
      relationship.relation === "imports_from" &&
      (evidenceKindById.get(relationship.from_id) !== "structural_file" ||
        evidenceKindById.get(relationship.to_id) !== "structural_file")
    ) {
      reasons.push("imports_from_endpoint_kind_invalid")
    }
    if (
      relationship.relation === "contains" &&
      (evidenceKindById.get(relationship.from_id) !== "structural_file" ||
        evidenceKindById.get(relationship.to_id) !== "symbol_declaration")
    ) {
      reasons.push("contains_endpoint_kind_invalid")
    }
    if (
      relationship.relation === "contains" &&
      nodePathById.get(relationship.from_id) !==
        nodePathById.get(relationship.to_id)
    ) {
      reasons.push("contains_cross_file_invalid")
    }
    if (reasons.length === 0) {
      acceptedRelationships.push({
        id: relationship.id,
        from_id: relationship.from_id,
        to_id: relationship.to_id,
        relation: relationship.relation,
      })
      for (const nodeId of structuralEndpoints) {
        structuralRelationships.set(
          nodeId,
          (structuralRelationships.get(nodeId) ?? 0) + 1,
        )
      }
    } else {
      invalidRelationshipFacts.push({
        relationship_id: relationship.id,
        from_path: nodePathById.get(relationship.from_id) ?? null,
        to_path: nodePathById.get(relationship.to_id) ?? null,
        reasons: [...new Set(reasons)].sort(),
      })
    }
  }
  for (const [nodeId, count] of structuralRelationships) {
    if (count > 0 || !acceptedNodeIds.has(nodeId)) continue
    invalidNodeFacts.push({
      node_id: nodeId,
      repository_path: nodePathById.get(nodeId) ?? null,
      reasons: ["structural_file_without_allowed_relationship"],
    })
    acceptedNodeIds.delete(nodeId)
    structuralPaths.delete(nodePathById.get(nodeId))
  }

  const boundaryFacts = result.boundaries.map((boundary) => ({
    ...boundary,
    subject:
      boundary.kind === "unsupported" && boundary.subject.includes("/")
        ? graphPathToRepositoryPath(repository.graph_root, boundary.subject)
        : boundary.subject,
  }))
  const boundaryIdentities = boundaryFacts.map(canonicalJson)
  const duplicateBoundaries =
    boundaryIdentities.length - new Set(boundaryIdentities).size
  const selectedPaths = selectedFilePaths(result, repository)
  const snippets = result.matched_nodes.filter(
    (node) =>
      node.evidence_kind === "symbol_declaration" &&
      typeof node.snippet === "string",
  ).length
  assert(
    typeof serializedResult === "string" &&
      canonicalFactsEqual(JSON.parse(serializedResult), result),
    "persisted retrieve bytes do not match the parsed result",
  )
  const serializedTokens = countTokens(serializedResult)
  const reportedClosurePasses = result.metrics.closure_passes
  const independentMetricFailures = [
    ...(result.metrics.selected_files !== selectedPaths.length
      ? ["selected_files_metric_mismatch"]
      : []),
    ...(result.metrics.snippets !== snippets
      ? ["snippets_metric_mismatch"]
      : []),
    ...(result.metrics.serialized_tokens !== serializedTokens
      ? ["serialized_tokens_metric_mismatch"]
      : []),
    ...(!Number.isSafeInteger(reportedClosurePasses) ||
    reportedClosurePasses < 0
      ? ["reported_closure_passes_invalid"]
      : []),
  ]
  const authoritativeGraphRelationships = context.graph
    .edgeEntries()
    .map(([fromId, toId, attributes, id]) => ({
      id,
      from_id: fromId,
      to_id: toId,
      relation: attributes.relation,
    }))

  return {
    authenticated_symbols: authenticatedSymbols,
    structural_paths: [...structuralPaths].sort(),
    selected_paths: selectedPaths,
    boundary_facts: boundaryFacts,
    accepted_relationships: acceptedRelationships,
    authoritative_graph_relationships: authoritativeGraphRelationships,
    node_path_by_id: nodePathById,
    evidence_kind_by_id: evidenceKindById,
    structural_node_ids: new Set(
      [...structuralNodeIds].filter((nodeId) => acceptedNodeIds.has(nodeId)),
    ),
    invalid_node_facts: invalidNodeFacts,
    invalid_relationship_facts: invalidRelationshipFacts,
    duplicate_boundaries: duplicateBoundaries,
    independent_metrics: {
      authenticated_symbol_declarations: authenticatedSymbols.length,
      structural_files: structuralPaths.size,
      result_selected_files: result.metrics.selected_files,
      snippets,
      reported_closure_passes: reportedClosurePasses,
      serialized_tokens: serializedTokens,
      truncated: result.metrics.truncated,
    },
    independent_metric_failures: independentMetricFailures,
  }
}

function fixtureIdentity(fixture) {
  return {
    repository_path: fixture.source_file,
    symbol: fixture.symbol,
    node_kind: fixture.node_kind,
    source_sha256: fixture.source_sha256,
    declaration_range: fixture.declaration_range,
    declaration_sha256: fixture.declaration_sha256,
  }
}

function authenticatedOwnerMatches(authenticated, fixture) {
  return canonicalFactsEqual(
    {
      repository_path: authenticated.repository_path,
      symbol: authenticated.symbol,
      node_kind: authenticated.node_kind,
      source_sha256: authenticated.source_sha256,
      declaration_range: authenticated.declaration_range,
      declaration_sha256: authenticated.declaration_sha256,
    },
    fixtureIdentity(fixture),
  )
}

function findDirectedPath(relationships, fromId, toId) {
  const outgoing = new Map()
  for (const relationship of relationships) {
    const edges = outgoing.get(relationship.from_id) ?? []
    edges.push(relationship)
    outgoing.set(relationship.from_id, edges)
  }
  const queue = [fromId]
  const seen = new Set([fromId])
  const predecessor = new Map()
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    for (const edge of outgoing.get(current) ?? []) {
      if (seen.has(edge.to_id)) continue
      seen.add(edge.to_id)
      predecessor.set(edge.to_id, { nodeId: current, edge })
      if (edge.to_id === toId) {
        const path = []
        let nodeId = toId
        while (nodeId !== fromId) {
          const step = predecessor.get(nodeId)
          if (!step) return null
          path.push(step.edge)
          nodeId = step.nodeId
        }
        return path.reverse()
      }
      queue.push(edge.to_id)
    }
  }
  return null
}

function ownerOrderIsValid(phases, ownerEvidenceById) {
  let previousPhaseIndex = -1
  for (const phase of phases.filter(
    (candidate) => candidate.scope === "required",
  )) {
    const selected = phase.authenticated_owner_ids
      .map((id) => ({ id, index: ownerEvidenceById.get(id)?.selection_index }))
      .filter((entry) => entry.index !== undefined)
    const fixtureOrder = new Map(
      phase.accepted_owner_ids.map((id, index) => [id, index]),
    )
    for (let index = 1; index < selected.length; index += 1) {
      if (
        fixtureOrder.get(selected[index - 1].id) >
        fixtureOrder.get(selected[index].id)
      ) {
        return false
      }
      if (selected[index - 1].index >= selected[index].index) return false
    }
    if (selected.length > 0) {
      const first = Math.min(...selected.map((entry) => entry.index))
      if (first <= previousPhaseIndex) return false
      previousPhaseIndex = Math.max(...selected.map((entry) => entry.index))
    }
  }
  return true
}

export function gradeQuestionEvidence({
  question,
  ownerFixtures,
  result,
  audit,
  machineGates,
  limits = resultLimits,
}) {
  const ownerById = new Map(
    ownerFixtures.map((fixture) => [fixture.id, fixture]),
  )
  const acceptedOwnerIds = new Set(
    question.required_phases
      .filter((phase) => phase.scope === "required")
      .flatMap((phase) => phase.accepted_owner_ids),
  )
  const ownerEvidenceById = new Map()
  for (const ownerId of acceptedOwnerIds) {
    const fixture = ownerById.get(ownerId)
    if (!fixture) continue
    const matches = audit.authenticated_symbols.filter((symbol) =>
      authenticatedOwnerMatches(symbol, fixture),
    )
    if (matches.length === 1) ownerEvidenceById.set(ownerId, matches[0])
  }
  const unsupportedBoundaries = new Set(
    audit.boundary_facts
      .filter((boundary) => boundary.kind === "unsupported")
      .map((boundary) => boundary.subject),
  )
  const phases = question.required_phases.map((phase) => {
    if (phase.scope === "unsupported_language") {
      const matched = phase.boundary_subjects.filter((path) =>
        unsupportedBoundaries.has(path),
      )
      return {
        id: phase.id,
        scope: phase.scope,
        boundary_subjects: phase.boundary_subjects,
        minimum_boundary_matches: phase.minimum_boundary_matches,
        unsupported_boundary_subjects: matched,
        covered: matched.length >= phase.minimum_boundary_matches,
      }
    }
    const matched = phase.accepted_owner_ids.filter((id) =>
      ownerEvidenceById.has(id),
    )
    return {
      id: phase.id,
      scope: phase.scope,
      accepted_owner_ids: phase.accepted_owner_ids,
      minimum_owner_matches: phase.minimum_owner_matches,
      authenticated_owner_ids: matched,
      covered: matched.length >= phase.minimum_owner_matches,
    }
  })
  const requiredPhases = phases.filter((phase) => phase.scope === "required")
  const coveredRequired = requiredPhases.filter((phase) => phase.covered).length
  const requiredCoverage =
    requiredPhases.length === 0 ? 1 : coveredRequired / requiredPhases.length
  const unsupportedReported = phases
    .filter((phase) => phase.scope === "unsupported_language")
    .every((phase) => phase.covered)
  const ownerOrder = ownerOrderIsValid(phases, ownerEvidenceById)
  const handoffs = question.required_handoffs.map((handoff) => {
    const from = ownerEvidenceById.get(handoff.from_owner_id)
    const to = ownerEvidenceById.get(handoff.to_owner_id)
    const expectedSubject =
      from && to ? `${from.node_id} -> ${to.node_id}` : null
    const reversedSubject =
      from && to ? `${to.node_id} -> ${from.node_id}` : null
    const disconnectedBoundary =
      expectedSubject !== null &&
      audit.boundary_facts.some(
        (boundary) =>
          boundary.kind === "disconnected" &&
          boundary.subject === expectedSubject,
      )
    const reversedBoundary =
      reversedSubject !== null &&
      audit.boundary_facts.some(
        (boundary) =>
          boundary.kind === "disconnected" &&
          boundary.subject === reversedSubject,
      )
    const selectedForwardPath =
      from && to
        ? findDirectedPath(
            audit.accepted_relationships,
            from.node_id,
            to.node_id,
          )
        : null
    const selectedReversePath =
      from && to
        ? findDirectedPath(
            audit.accepted_relationships,
            to.node_id,
            from.node_id,
          )
        : null
    const authoritativeForwardPath =
      from && to
        ? findDirectedPath(
            audit.authoritative_graph_relationships,
            from.node_id,
            to.node_id,
          )
        : null
    const authoritativeReversePath =
      from && to
        ? findDirectedPath(
            audit.authoritative_graph_relationships,
            to.node_id,
            from.node_id,
          )
        : null
    let structuralSupportPath = null
    if (handoff.expectation === "connected" && from && to) {
      const structuralRelationships = audit.accepted_relationships.filter(
        (relationship) => relationship.relation === "imports_from",
      )
      const fromFiles = [...audit.structural_node_ids].filter(
        (nodeId) => audit.node_path_by_id.get(nodeId) === from.repository_path,
      )
      const toFiles = [...audit.structural_node_ids].filter(
        (nodeId) => audit.node_path_by_id.get(nodeId) === to.repository_path,
      )
      for (const fromFile of fromFiles) {
        for (const toFile of toFiles) {
          structuralSupportPath = findDirectedPath(
            structuralRelationships,
            fromFile,
            toFile,
          )
          if (structuralSupportPath) break
        }
        if (structuralSupportPath) break
      }
    }
    const violations = [
      ...(!from ? ["from_owner_missing"] : []),
      ...(!to ? ["to_owner_missing"] : []),
      ...(handoff.expectation === "disconnected" && !disconnectedBoundary
        ? ["required_disconnected_boundary_missing"]
        : []),
      ...(handoff.expectation === "disconnected" && reversedBoundary
        ? ["reversed_disconnected_boundary"]
        : []),
      ...(handoff.expectation === "disconnected" && authoritativeForwardPath
        ? ["authoritative_forward_path_contradicts_disconnected"]
        : []),
      ...(handoff.expectation === "disconnected" && authoritativeReversePath
        ? ["authoritative_reverse_path_contradicts_directional_handoff"]
        : []),
      ...(handoff.expectation === "connected" && !selectedForwardPath
        ? ["selected_forward_path_missing"]
        : []),
      ...(handoff.expectation === "connected" &&
      !selectedForwardPath &&
      selectedReversePath
        ? ["selected_reverse_only_path"]
        : []),
      ...(handoff.expectation === "connected" && disconnectedBoundary
        ? ["connected_handoff_reported_disconnected"]
        : []),
    ]
    return {
      from_owner_id: handoff.from_owner_id,
      to_owner_id: handoff.to_owner_id,
      expectation: handoff.expectation,
      expected_subject: expectedSubject,
      authoritative_forward_path_relationship_ids:
        authoritativeForwardPath?.map((edge) => edge.id) ?? [],
      authoritative_reverse_path_relationship_ids:
        authoritativeReversePath?.map((edge) => edge.id) ?? [],
      selected_forward_path_relationship_ids:
        selectedForwardPath?.map((edge) => edge.id) ?? [],
      selected_reverse_path_relationship_ids:
        selectedReversePath?.map((edge) => edge.id) ?? [],
      selected_structural_support_path_relationship_ids:
        structuralSupportPath?.map((edge) => edge.id) ?? [],
      matched: violations.length === 0,
      violations,
      selected_path: selectedForwardPath ?? [],
      structural_support_path: structuralSupportPath ?? [],
    }
  })
  const handoffsCovered = handoffs.every((handoff) => handoff.matched)

  const relevantPaths = new Set(
    [...acceptedOwnerIds]
      .map((id) => ownerById.get(id)?.source_file)
      .filter((path) => typeof path === "string"),
  )
  for (const handoff of handoffs) {
    if (handoff.expectation !== "connected" || !handoff.matched) continue
    for (const edge of [
      ...handoff.selected_path,
      ...handoff.structural_support_path,
    ]) {
      for (const nodeId of [edge.from_id, edge.to_id]) {
        if (!audit.structural_node_ids.has(nodeId)) continue
        const path = audit.node_path_by_id.get(nodeId)
        if (path) relevantPaths.add(path)
      }
    }
  }
  const selectedPaths = [...audit.selected_paths].sort()
  const relevantSelectedPaths = selectedPaths.filter((path) =>
    relevantPaths.has(path),
  )
  const unrelatedPaths = selectedPaths.filter(
    (path) => !relevantPaths.has(path),
  )
  const precision =
    selectedPaths.length === 0
      ? 0
      : relevantSelectedPaths.length / selectedPaths.length
  const gates = {
    outcome_evidence: result.outcome === "evidence",
    required_phase_coverage:
      requiredCoverage >= machineGates.required_in_scope_phase_coverage,
    unsupported_phases_reported: unsupportedReported,
    authenticated_owner_sets: requiredPhases.every((phase) => phase.covered),
    owner_order: ownerOrder,
    required_handoffs: handoffsCovered,
    selected_file_precision:
      precision >= machineGates.selected_file_precision_min,
    unrelated_files: unrelatedPaths.length <= machineGates.unrelated_files_max,
    selected_files:
      audit.independent_metrics.result_selected_files <=
      limits.selected_files_max,
    snippets: audit.independent_metrics.snippets <= limits.snippets_max,
    serialized_tokens:
      audit.independent_metrics.serialized_tokens <=
      limits.serialized_tokens_max,
    reported_closure_passes:
      audit.independent_metrics.reported_closure_passes <=
      limits.reported_closure_passes_max,
    not_truncated: audit.independent_metrics.truncated === false,
    graph_fact_integrity:
      audit.invalid_node_facts.length === 0 &&
      audit.invalid_relationship_facts.length === 0 &&
      audit.duplicate_boundaries === 0 &&
      audit.independent_metric_failures.length === 0,
  }
  return {
    phases,
    handoffs: handoffs.map(
      ({
        selected_path: _selectedPath,
        structural_support_path: _support,
        ...handoff
      }) => handoff,
    ),
    authenticated_owner_ids: [...ownerEvidenceById.keys()],
    owner_order_valid: ownerOrder,
    required_phase_coverage: Number(requiredCoverage.toFixed(6)),
    unsupported_phases_reported: unsupportedReported,
    selected_files: selectedPaths,
    relevant_selected_files: relevantSelectedPaths,
    unrelated_files: unrelatedPaths,
    selected_file_precision: Number(precision.toFixed(6)),
    independent_metric_failures: audit.independent_metric_failures,
    metrics: audit.independent_metrics,
    gates,
    passed: Object.values(gates).every(Boolean),
  }
}

function validateOwnerFixtures(contract, contexts) {
  for (const fixture of contract.owner_fixtures) {
    const context = contexts.get(fixture.repository_id)
    if (!context) continue
    safeRelativePath(fixture.source_file, `${fixture.id} source_file`)
    const candidate = realpathSync(
      resolve(context.checkout, fixture.source_file),
    )
    assert(
      sourceIsBeneathRoot(context.checkout, candidate),
      `${fixture.id} escaped checkout`,
    )
    const stat = lstatSync(candidate)
    assert(
      stat.isFile() && !stat.isSymbolicLink(),
      `${fixture.id} is not a regular file`,
    )
    const bytes = readFileSync(candidate)
    assert(
      sha256(bytes) === fixture.source_sha256,
      `${fixture.id} source hash mismatch`,
    )
    const excerpt = exactUtf16Range(
      utf8.decode(bytes),
      fixture.declaration_range,
    )
    assert(excerpt !== null, `${fixture.id} declaration range is invalid`)
    assert(
      sha256(excerpt) === fixture.declaration_sha256,
      `${fixture.id} declaration hash mismatch`,
    )
  }
}

function runtimeSubject() {
  return {
    head_commit: git(repositoryRoot, "rev-parse", "HEAD"),
    head_tree_oid: git(repositoryRoot, "rev-parse", "HEAD^{tree}"),
    worktree_dirty:
      git(
        repositoryRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ).length > 0,
  }
}

function validateReceipt(receipt) {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const schema = JSON.parse(readFileSync(receiptSchemaPath, "utf8"))
  const validate = ajv.compile(schema)
  if (!validate(receipt)) {
    throw new Error(
      `held-out receipt schema validation failed:\n${ajv.errorsText(
        validate.errors,
        { separator: "\n" },
      )}`,
    )
  }
  const { receipt_sha256: recorded, ...body } = receipt
  assert(
    recorded === sha256(canonicalJson(body)),
    "held-out receipt self-hash mismatch",
  )
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  const handle = openSync(path, "w", 0o644)
  try {
    writeSync(handle, serialized, null, "utf8")
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

async function runHeldOut(options) {
  assertCleanEvaluatorProcess()
  assertFrozenDarwinTool(gitBinary, "Git")
  assertFrozenDarwinTool(tarBinary, "tar")
  const executionPlan = loadExecutionPlan(options.contract)
  for (const id of options.repositories.keys()) {
    assert(
      executionPlan.repositories.some((repository) => repository.id === id),
      `Unknown held-out repository override: ${id}`,
    )
  }
  assert(
    options.repositories.size === executionPlan.repositories.length &&
      executionPlan.repositories.every((repository) =>
        options.repositories.has(repository.id),
      ),
    "held-out evaluation requires one prepared local --repository id=path for openstatus, documenso, and formbricks",
  )
  const harnessRoot = mkdtempSync(join(tmpdir(), "madar-held-out-v2-"))
  const responseRecords = []
  let sequence = 0

  try {
    const { runtime_root: candidateRuntimeRoot, ...candidateBuild } =
      prepareCandidateRuntime(harnessRoot)
    const childEntryPath = join(harnessRoot, "child", "retrieve.mjs")
    persistResponse(childEntryPath, isolatedRetrieveChildSource())

    const contexts = executeGenerationBarrier({
      repositories: executionPlan.repositories,
      questions: executionPlan.questions,
      generateRepository(repository) {
        const clonePath = join(harnessRoot, "clones", repository.id)
        mkdirSync(dirname(clonePath), { recursive: true })
        const source = options.repositories.get(repository.id)
        assert(source, `missing prepared repository ${repository.id}`)
        const clone = clonePinnedRepository(repository, source, clonePath)
        const graphContext = buildGraph(
          repository,
          clone.checkout,
          harnessRoot,
          candidateRuntimeRoot,
        )
        return { ...clone, ...graphContext, repository }
      },
      retrieveQuestion({ repository, question, context }) {
        const requestPath = join(
          harnessRoot,
          "requests",
          question.id,
          "request.json",
        )
        writeJson(requestPath, {
          question: question.prompt,
          budget: resultLimits.serialized_tokens_max,
        })
        const child = runIsolatedRetrieveChild({
          entryPath: childEntryPath,
          runtimeRoot: candidateRuntimeRoot,
          graphPath: context.graphArtifactPath,
          requestPath,
          sourceRoot: context.graphRoot,
        })
        const serialized = child.serialized
        const responsePath = join(
          harnessRoot,
          "responses",
          `${question.id}.json`,
        )
        const persistence = persistResponse(responsePath, serialized)
        sequence += 1
        responseRecords.push({
          question_id: question.id,
          repository_id: repository.id,
          physical_path: responsePath,
          child_pid: child.pid,
          process_state_probe: child.process_state_probe,
          retrieve_invocations: child.retrieve_invocations,
          persisted_sequence: sequence,
          ...persistence,
        })
      },
    })

    assert(
      responseRecords.length === executionPlan.questions.length,
      "not every held-out response was persisted",
    )
    assert(
      responseRecords.every((record) => record.retrieve_invocations === 1),
      "a question did not receive exactly one retrieve invocation",
    )
    assert(
      new Set(responseRecords.map((record) => record.child_pid)).size ===
        responseRecords.length &&
        responseRecords.every((record) => record.process_state_probe === 1),
      "held-out questions did not execute in fresh contained child processes",
    )

    const gradingContractLoadedSequence = ++sequence
    const gradingContractLoadedAt = new Date().toISOString()
    const gradingContractBytes = readFileSync(options.contract)
    const contractSha256 = sha256(gradingContractBytes)
    const contract = JSON.parse(gradingContractBytes.toString("utf8"))
    assert(
      contract.contract_id === executionPlan.contract_id,
      "contract ID changed",
    )
    assert(contract.schema_version === 2, "grading contract is not v2")
    assert(
      contractSha256 === executionPlan.contract_sha256,
      "grading contract bytes changed after isolated plan extraction",
    )
    validateOwnerFixtures(contract, contexts)

    const selectedQuestionIds = new Set(
      executionPlan.questions.map((question) => question.id),
    )
    const questions = []
    for (const question of contract.questions.filter((candidate) =>
      selectedQuestionIds.has(candidate.id),
    )) {
      const record = responseRecords.find(
        (candidate) => candidate.question_id === question.id,
      )
      assert(record, `missing persisted response for ${question.id}`)
      assert(
        record.persisted_sequence < gradingContractLoadedSequence,
        `${question.id} was not persisted before grading`,
      )
      const bytes = readFileSync(record.physical_path)
      assert(
        bytes.length === record.bytes && sha256(bytes) === record.sha256,
        `${question.id} persisted response changed`,
      )
      const result = JSON.parse(bytes.toString("utf8"))
      const context = contexts.get(question.repository_id)
      const repository = contract.repositories.find(
        (candidate) => candidate.id === question.repository_id,
      )
      assert(
        context && repository,
        `missing context for ${question.repository_id}`,
      )
      const audit = auditPersistedResult(
        result,
        repository,
        context,
        bytes.toString("utf8"),
      )
      const grading = gradeQuestionEvidence({
        question,
        ownerFixtures: contract.owner_fixtures.filter(
          (fixture) => fixture.repository_id === question.repository_id,
        ),
        result,
        audit,
        machineGates: contract.measurements.machine_gates,
      })
      questions.push({
        question_id: question.id,
        repository_id: question.repository_id,
        gate_role: question.gate_role,
        comparison_role: question.comparison_role,
        response: {
          sha256: record.sha256,
          bytes: record.bytes,
          child_pid: record.child_pid,
          process_state_probe: record.process_state_probe,
          retrieve_invocations: record.retrieve_invocations,
          persisted_sequence: record.persisted_sequence,
          persisted_before_grading:
            record.persisted_sequence < gradingContractLoadedSequence,
          persisted_bytes_verified: true,
        },
        ...grading,
      })
    }

    const repositories = executionPlan.repositories.map((repository) => {
      const context = contexts.get(repository.id)
      assert(context, `missing repository context for ${repository.id}`)
      return {
        repository_id: repository.id,
        commit: repository.commit,
        tree_paths_sha256: repository.tree_paths_sha256,
        graph_root: repository.graph_root,
        checkout_clean:
          git(
            context.checkout,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ) === "",
        build: context.build,
      }
    })
    const blockingQuestions = questions.filter(
      (question) => question.gate_role === "blocking",
    )
    const diagnosticQuestions = questions.filter(
      (question) => question.gate_role !== "blocking",
    )
    const blockingGatePassed =
      blockingQuestions.length === 2 &&
      blockingQuestions.every((question) => question.passed)
    const diagnosticPass =
      diagnosticQuestions.length === 1 &&
      diagnosticQuestions.every((question) => question.passed)
    const subject = runtimeSubject()
    const gates = {
      contract_identity:
        contract.contract_id === "core-reset-held-out-v2" &&
        contract.schema_version === 2 &&
        contractSha256 === executionPlan.contract_sha256,
      candidate_runtime_built_from_subject:
        candidateBuild.performed_before_runtime_load &&
        candidateBuild.head_commit === subject.head_commit &&
        candidateBuild.head_tree_oid === subject.head_tree_oid &&
        candidateBuild.worktree_clean_before &&
        candidateBuild.worktree_clean_after,
      candidate_process_isolation_and_containment:
        platform() === "darwin" &&
        new Set(questions.map((question) => question.response.child_pid))
          .size === questions.length &&
        questions.every(
          (question) => question.response.process_state_probe === 1,
        ),
      immutable_response_handoff: questions.every(
        (question) =>
          question.response.persisted_before_grading &&
          question.response.persisted_bytes_verified,
      ),
      grading_order: responseRecords.every(
        (record) => record.persisted_sequence < gradingContractLoadedSequence,
      ),
      standalone_pinned_repositories: repositories.every(
        (repository) => repository.checkout_clean,
      ),
      one_retrieve_per_question: questions.every(
        (question) => question.response.retrieve_invocations === 1,
      ),
      blocking_questions: blockingGatePassed,
    }
    const benchmarkPassed = Object.values(gates).every(Boolean)
    const body = {
      schema_version: 2,
      receipt_kind: "core-reset-evidence-path-held-out",
      generated_at: new Date().toISOString(),
      share_safe: true,
      issue: 596,
      benchmark_passed: benchmarkPassed,
      eligible_for_acceptance:
        benchmarkPassed && subject.worktree_dirty === false,
      contract: {
        path: repositoryRelative(options.contract),
        contract_id: contract.contract_id,
        sha256: contractSha256,
      },
      evaluator: {
        path: repositoryRelative(scriptPath),
        sha256: sha256(readFileSync(scriptPath)),
        schema_path: repositoryRelative(receiptSchemaPath),
        schema_sha256: sha256(readFileSync(receiptSchemaPath)),
      },
      candidate_build: candidateBuild,
      subject,
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        node_options: "absent",
        node_path: "absent",
        process_exec_argv: [],
      },
      protocol: {
        candidate_generate_command: generateCommand,
        candidate_runtime_source: "exact_head_npm_packed_artifact",
        candidate_dependency_install: "exact_lock_offline_production_only",
        workspace_config_source:
          "exact_tracked_local_workspace_packages_no_package_manager",
        containment_policy_id: containmentPolicyId,
        response_handoff:
          "fsync_sha256_before_hidden_grading",
        isolated_plan_process_loaded_contract_before_retrieval: true,
        hidden_fixtures_loaded_in_evaluator_after_response_persistence: true,
        execution_plan_isolated_from_hidden_fixtures: true,
        grading_contract_loaded_sequence: gradingContractLoadedSequence,
        grading_contract_loaded_at: gradingContractLoadedAt,
        selected_questions: executionPlan.questions.map(
          (question) => question.id,
        ),
        excluded_diagnostic_questions: contract.questions
          .filter(
            (question) =>
              question.comparison_role === "diagnostic_only" &&
              !selectedQuestionIds.has(question.id),
          )
          .map((question) => question.id),
      },
      thresholds: {
        required_in_scope_phase_coverage:
          contract.measurements.machine_gates.required_in_scope_phase_coverage,
        selected_file_precision_min:
          contract.measurements.machine_gates.selected_file_precision_min,
        unrelated_files_max:
          contract.measurements.machine_gates.unrelated_files_max,
        selected_files_max: resultLimits.selected_files_max,
        snippets_max: resultLimits.snippets_max,
        serialized_tokens_max: resultLimits.serialized_tokens_max,
        reported_closure_passes_max: resultLimits.reported_closure_passes_max,
      },
      repositories,
      questions,
      diagnostic: {
        affects_blocking_gate: false,
        passed: diagnosticPass,
        question_ids: diagnosticQuestions.map(
          (question) => question.question_id,
        ),
      },
      gates,
      failures: Object.entries(gates)
        .filter(([, passed]) => !passed)
        .map(([name]) => name),
    }
    const receipt = { ...body, receipt_sha256: sha256(canonicalJson(body)) }
    assertShareSafeReceipt(receipt, [
      repositoryRoot,
      harnessRoot,
      tmpdir(),
      ...options.repositories.values(),
    ])
    validateReceipt(receipt)
    writeJson(options.receipt, receipt)
    process.stdout.write(
      `${JSON.stringify(
        {
          receipt: repositoryRelative(options.receipt),
          benchmark_passed: receipt.benchmark_passed,
          eligible_for_acceptance: receipt.eligible_for_acceptance,
          blocking: blockingQuestions.map((question) => ({
            id: question.question_id,
            passed: question.passed,
            phase_coverage: question.required_phase_coverage,
            precision: question.selected_file_precision,
            unrelated_files: question.unrelated_files.length,
            handoffs: question.handoffs,
          })),
          diagnostic: diagnosticQuestions.map((question) => ({
            id: question.question_id,
            passed: question.passed,
            phase_coverage: question.required_phase_coverage,
            unsupported_phases_reported: question.unsupported_phases_reported,
          })),
          failures: receipt.failures,
        },
        null,
        2,
      )}\n`,
    )
    if (!receipt.benchmark_passed) process.exitCode = 1
  } finally {
    rmSync(harnessRoot, { recursive: true, force: true })
  }
}

if (process.argv[2] === "--internal-plan") {
  try {
    assertCleanEvaluatorProcess()
    process.stdout.write(canonicalJson(internalExecutionPlan(process.argv[3])))
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    )
    process.exitCode = 1
  }
} else if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(scriptPath)
) {
  runHeldOut(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    )
    process.exitCode = 1
  })
}
