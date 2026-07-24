import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base"

const scriptPath = fileURLToPath(import.meta.url)
const scriptRoot = dirname(scriptPath)
const repositoryRoot = resolve(scriptRoot, "..", "..", "..")
const receiptSchemaPath = join(
  scriptRoot,
  "schemas",
  "evidence-path-performance-receipt.schema.json",
)
const expectedContractSha256 =
  "4ddba368f5ef17dc059bd8d41c0549e38d6a5ded42e9448ae31aefd0e35506e4"
const buildControlPaths = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
]
const installCommand =
  "node <resolved-npm-cli> ci --offline --ignore-scripts --no-audit --no-fund --userconfig=<isolated-empty-user-config> --globalconfig=<isolated-empty-global-config>"
const cleanProgram =
  'import { rmSync } from "node:fs"; rmSync("dist", { recursive: true, force: true })'
const cleanCommand = `node --eval '${cleanProgram}'`
const buildCommand =
  "node node_modules/typescript/bin/tsc -p tsconfig.build.json"

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

function roundedMilliseconds(value) {
  return Number(value.toFixed(3))
}

export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("nearest-rank percentile requires at least one sample")
  }
  if (!(percentile > 0 && percentile <= 100)) {
    throw new Error("nearest-rank percentile must be in (0, 100]")
  }
  const sorted = values.map(Number).sort((left, right) => left - right)
  return roundedMilliseconds(
    sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)],
  )
}

function zeroPad(value, width) {
  return String(value).padStart(width, "0")
}

export function fixtureNodeDefinition(contract, componentIndex, localIndex) {
  const component = zeroPad(componentIndex, 3)
  const local = zeroPad(localIndex, 2)
  const globalIndex =
    componentIndex * contract.generator.nodes_per_component + localIndex
  const phase =
    contract.generator.phases[localIndex % contract.generator.phases.length]
  const label = `flow${component}${phase}${local}`
  const sourceFile = `src/fixture/flow-${component}/node-${local}.ts`
  const source = `export {}; // authenticated synthetic source ${component}:${phase}:${local}\n`
  return {
    id: `n${zeroPad(globalIndex, 5)}`,
    component,
    local,
    phase,
    label,
    sourceFile,
    source,
    contentHash: sha256(Buffer.from(source, "utf8")),
  }
}

function parseArguments(argv) {
  const options = { contract: null, receipt: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--contract" || argument === "--receipt") {
      const value = argv[index + 1]
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path`)
      }
      options[argument.slice(2)] = value
      index += 1
      continue
    }
    if (argument?.startsWith("--contract=")) {
      options.contract = argument.slice("--contract=".length)
      continue
    }
    if (argument?.startsWith("--receipt=")) {
      options.receipt = argument.slice("--receipt=".length)
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  if (!options.contract || !options.receipt) {
    throw new Error("Both --contract and --receipt are required")
  }
  return options
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertExactKeys(value, keys, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  )
  assert(
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"),
    `${label} has unexpected keys`,
  )
}

export function validateFrozenContract(contract) {
  assertExactKeys(
    contract,
    [
      "schema_version",
      "fixture_id",
      "generator",
      "queries",
      "query_expectations",
      "protocol",
      "reference_environment",
      "runner",
      "receipt",
    ],
    "contract",
  )
  assert(contract.schema_version === 2, "contract schema_version must be 2")
  assert(
    contract.fixture_id === "evidence-path-performance-v2",
    "unexpected fixture_id",
  )
  assert(
    contract.generator.algorithm === "component-ring-structural-imports-v3",
    "unexpected generator",
  )
  assert(
    contract.generator.seed ===
      "sha256-counter-v3:evidence-path-performance-v2",
    "unexpected seed",
  )
  assert(
    contract.generator.component_count === 150,
    "component_count must be 150",
  )
  assert(
    contract.generator.nodes_per_component === 100,
    "nodes_per_component must be 100",
  )
  assert(contract.generator.node_count === 15_000, "node_count must be 15,000")
  assert(contract.generator.edge_count === 30_000, "edge_count must be 30,000")
  assert(
    contract.generator.node_kind === "file",
    "all fixture nodes must be files",
  )
  assert(
    contract.generator.source_text_use ===
      "full-file SHA256 authentication only",
    "fixture source text must be hash-only authentication material",
  )
  assert(
    contract.generator.structural_file_evidence.range === "omitted",
    "structural file ranges must be omitted",
  )
  assert(
    contract.generator.structural_file_evidence.snippet === "omitted",
    "structural file snippets must be omitted",
  )
  assert(
    canonicalJson(
      [
        ...contract.generator.structural_file_evidence.permitted_relations,
      ].sort(),
    ) === canonicalJson(["imports_from"]),
    "performance structural file traversal must use only imports_from",
  )
  assert(
    canonicalJson(
      contract.generator.edges.map((edge) => edge.relation_rule),
    ) === canonicalJson(["imports_from", "imports_from"]),
    "unexpected structural edge sequence",
  )
  assert(
    canonicalJson(contract.generator.phases) ===
      canonicalJson(["route", "service", "queue", "worker", "storage"]),
    "unexpected phase sequence",
  )
  assert(
    Array.isArray(contract.queries) && contract.queries.length === 5,
    "contract must have five queries",
  )
  assert(
    Array.isArray(contract.query_expectations) &&
      contract.query_expectations.length === 5,
    "contract must have five expectations",
  )
  assert(
    contract.query_expectations.every(
      (entry, index) => entry.query_index === index,
    ),
    "expectations must cover query indexes 0..4 in order",
  )
  assert(
    contract.protocol.graph_loaded_before_timer === true,
    "graph must load before timing",
  )
  assert(
    contract.protocol.query_index_inspected_before_timer === true,
    "the canonical query index must be inspected before timing",
  )
  assert(
    contract.protocol.correctness.untimed_preflight_invocations_per_query === 1,
    "one preflight invocation per query is required",
  )
  assert(
    contract.protocol.correctness.structural_file_range === "must_be_omitted",
    "retrieved structural file ranges must be omitted",
  )
  assert(
    contract.protocol.correctness.structural_file_snippet === "must_be_omitted",
    "retrieved structural file snippets must be omitted",
  )
  assert(
    contract.protocol.correctness.full_file_hash ===
      "must_match_authenticated_source",
    "retrieved structural files must authenticate by full-file hash",
  )
  assert(contract.protocol.warmup_invocations === 3, "warmup count must be 3")
  assert(
    contract.protocol.measured_invocations === 20,
    "measurement count must be 20",
  )
  assert(contract.protocol.closure_pass_max === 1, "closure cap must be 1")
  assert(
    contract.protocol.selected_file_max === 12,
    "selected-file cap must be 12",
  )
  assert(
    contract.protocol.serialized_token_max === 4_000,
    "token cap must be 4,000",
  )
  assert(contract.protocol.p95_ms_max === 500, "p95 cap must be 500ms")
  return contract
}

function normalizeRepositoryPath(path, root = repositoryRoot) {
  return relative(root, resolve(root, path)).replaceAll("\\", "/")
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function resolveSystemGit() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\bin\\git.exe",
          "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        ]
      : ["/usr/bin/git", "/bin/git"]
  const gitPath = candidates.find((path) => existsSync(path))
  assert(
    gitPath !== undefined,
    "performance evaluation requires Git at an approved system path",
  )
  return realpathSync(gitPath)
}

const systemGit = resolveSystemGit()
const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null"
const gitConfiguration = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${gitNullDevice}`,
]

function controlledGitEnvironment() {
  return {
    ...controlledBuildEnvironment(),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  }
}

function git(...args) {
  return execFileSync(systemGit, [...gitConfiguration, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: controlledGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function gitBytes(root, ...args) {
  return execFileSync(systemGit, [...gitConfiguration, ...args], {
    cwd: root,
    env: controlledGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function walkFiles(root) {
  const result = []
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) result.push(path)
      else throw new Error(`Fixture contains a non-regular path: ${path}`)
    }
  }
  visit(root)
  return result
}

function framedDigest(entries) {
  const hash = createHash("sha256")
  for (const entry of entries) {
    hash.update(entry.path)
    hash.update("\0")
    hash.update(entry.hash)
    hash.update("\0")
    hash.update(String(entry.bytes))
    hash.update("\n")
  }
  return hash.digest("hex")
}

function directoryDigest(root) {
  return framedDigest(
    walkFiles(root).map((path) => {
      const bytes = readFileSync(path)
      return {
        path: relative(root, path).replaceAll("\\", "/"),
        hash: sha256(bytes),
        bytes: bytes.length,
      }
    }),
  )
}

export function exactHeadSourceAttestation(root = repositoryRoot) {
  const expectedPaths = gitBytes(
    root,
    "ls-tree",
    "-r",
    "--full-tree",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    "src",
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort()
  const actualPaths = walkFiles(resolve(root, "src"))
    .map((path) => normalizeRepositoryPath(path, root))
    .sort()
  assert(
    canonicalJson(actualPaths) === canonicalJson(expectedPaths),
    "performance source inventory differs from exact HEAD",
  )
  const entries = actualPaths.map((path) => {
    const bytes = readFileSync(resolve(root, path))
    const headBytes = gitBytes(root, "show", `HEAD:${path}`)
    assert(bytes.equals(headBytes), `${path} differs from exact HEAD bytes`)
    return { path, hash: sha256(bytes), bytes: bytes.length }
  })
  return {
    source_files: entries.length,
    source_tree_sha256: framedDigest(entries),
  }
}

function exactHeadBuildControlAttestation(root = repositoryRoot) {
  const entries = buildControlPaths.map((path) => {
    const bytes = readFileSync(resolve(root, path))
    const headBytes = gitBytes(root, "show", `HEAD:${path}`)
    assert(bytes.equals(headBytes), `${path} differs from exact HEAD bytes`)
    return { path, hash: sha256(bytes), bytes: bytes.length }
  })
  assert(
    !existsSync(resolve(root, ".npmrc")),
    "performance evaluation forbids a project .npmrc",
  )
  return {
    build_control_files: buildControlPaths,
    build_controls_sha256: framedDigest(entries),
  }
}

function sourceIsBeneathRoot(root, source) {
  const path = relative(root, source)
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function canonicalSet(values, label) {
  const serialized = values.map((value) => canonicalJson(value))
  assert(
    new Set(serialized).size === serialized.length,
    `${label} contains duplicates`,
  )
  return [...serialized].sort()
}

function sameCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function portableGraphDigest(serializedGraph) {
  const artifact = JSON.parse(serializedGraph)
  artifact.metadata.root_path = "<fixture-root>"
  if (
    artifact.metadata.index_build !== null &&
    typeof artifact.metadata.index_build === "object" &&
    artifact.metadata.index_build.source_root !== null &&
    typeof artifact.metadata.index_build.source_root === "object"
  ) {
    artifact.metadata.index_build.source_root.root_path = "<fixture-root>"
  }
  return sha256(canonicalJson(artifact))
}

async function runtimeModules(runtimeRoot) {
  const paths = {
    graph: resolve(
      runtimeRoot,
      "dist/src/domain/graph/directed-multigraph.js",
    ),
    artifact: resolve(runtimeRoot, "dist/src/domain/graph/artifact.js"),
    buildState: resolve(runtimeRoot, "dist/src/domain/index/build-state.js"),
    indexStatus: resolve(
      runtimeRoot,
      "dist/src/domain/query/index-status.js",
    ),
    retrieve: resolve(
      runtimeRoot,
      "dist/src/application/retrieve-context.js",
    ),
  }
  try {
    const [graph, artifact, buildState, indexStatus, retrieve] =
      await Promise.all([
        import(pathToFileURL(paths.graph).href),
        import(pathToFileURL(paths.artifact).href),
        import(pathToFileURL(paths.buildState).href),
        import(pathToFileURL(paths.indexStatus).href),
        import(pathToFileURL(paths.retrieve).href),
      ])
    return { ...graph, ...artifact, ...buildState, ...indexStatus, ...retrieve }
  } catch (error) {
    throw new Error(
      `The clean exact-HEAD build does not expose the required Core Reset evidence-path runtime modules. ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function materializeFixture(contract, root, runtime) {
  const graph = new runtime.KnowledgeGraph({
    directed: true,
    root_path: root,
    schema_version: runtime.CANONICAL_INDEX_FORMAT_VERSION,
    canonical_typescript_index: true,
    fixture_id: contract.fixture_id,
    generator: contract.generator.algorithm,
  })
  const provenance = [
    {
      kind: "synthetic_fixture",
      fixture_id: contract.fixture_id,
      generator: contract.generator.algorithm,
    },
  ]
  const fileHashes = new Map()
  const sourceManifest = []

  for (
    let componentIndex = 0;
    componentIndex < contract.generator.component_count;
    componentIndex += 1
  ) {
    const component = zeroPad(componentIndex, 3)
    mkdirSync(join(root, "src", "fixture", `flow-${component}`), {
      recursive: true,
    })
    for (
      let localIndex = 0;
      localIndex < contract.generator.nodes_per_component;
      localIndex += 1
    ) {
      const node = fixtureNodeDefinition(contract, componentIndex, localIndex)
      const absoluteSource = join(root, ...node.sourceFile.split("/"))
      const bytes = Buffer.from(node.source, "utf8")
      writeFileSync(absoluteSource, bytes)
      fileHashes.set(node.sourceFile, node.contentHash)
      sourceManifest.push({
        path: node.sourceFile,
        hash: node.contentHash,
        bytes: bytes.length,
      })
      graph.addNode(node.id, {
        label: node.label,
        qualified_name: node.label,
        node_kind: "file",
        source_file: node.sourceFile,
        source_domain: contract.generator.source_domain,
        content_hash: node.contentHash,
        provenance,
      })
    }
  }

  for (
    let componentIndex = 0;
    componentIndex < contract.generator.component_count;
    componentIndex += 1
  ) {
    for (
      let localIndex = 0;
      localIndex < contract.generator.nodes_per_component;
      localIndex += 1
    ) {
      const from = fixtureNodeDefinition(contract, componentIndex, localIndex)
      for (const edge of [
        {
          relation: "imports_from",
          target: (localIndex + 1) % contract.generator.nodes_per_component,
        },
        {
          relation: "imports_from",
          target: (localIndex + 37) % contract.generator.nodes_per_component,
        },
      ]) {
        const to = fixtureNodeDefinition(contract, componentIndex, edge.target)
        graph.addEdge(from.id, to.id, {
          relation: edge.relation,
          source_file: from.sourceFile,
          provenance,
        })
      }
    }
  }

  assert(
    graph.numberOfNodes() === contract.generator.node_count,
    "generated node cardinality mismatch",
  )
  assert(
    graph.numberOfEdges() === contract.generator.edge_count,
    "generated edge cardinality mismatch",
  )
  const sources = sourceManifest.map(({ path, hash }) => ({ path, hash }))
  runtime.attachBuildState(graph, {
    version: runtime.INDEX_BUILD_STATE_VERSION,
    engine_id: runtime.INDEX_ENGINE_ID,
    policy: runtime.createGenerationPolicy({
      index_format_version: runtime.CANONICAL_INDEX_FORMAT_VERSION,
      respect_gitignore: true,
      follow_symlinks: false,
      exclusion_rules_fingerprint: sha256(
        "evidence-path-performance-v2 synthetic exclusion rules",
      ),
      indexing_strict: null,
    }),
    sources: runtime.createSourceSnapshot({
      supported: sources,
      controls: [],
      unsupported: [],
      inventory: sources,
    }),
    source_root: {
      kind: "directory",
      root_path: root,
      worktree_root: null,
      scope: ".",
    },
    corpus: {
      supported_files: contract.generator.node_count,
      unsupported_files: 0,
      total_words: 0,
      warning: null,
    },
    completeness: {
      summary: {
        state: "complete",
        candidates: contract.generator.node_count,
        counts: {
          indexed: contract.generator.node_count,
          indexed_with_warnings: 0,
          skipped_by_policy: 0,
          unsupported: 0,
          failed: 0,
        },
        reason_buckets: { indexed: contract.generator.node_count },
        capability_buckets: { typescript: contract.generator.node_count },
      },
      supported_failures: [],
    },
  })
  const serializedGraph = runtime.serializeGraphArtifact(graph)
  const parsedGraph = runtime.deserializeGraphArtifact(serializedGraph)
  assert(
    runtime.serializeGraphArtifact(parsedGraph) === serializedGraph,
    "serialized graph changed after canonical deserialize/serialize round trip",
  )
  return {
    graph: parsedGraph,
    fileHashes,
    serializedGraph,
    sourceManifest,
    provenance,
  }
}

function assertStructuralFileHasNoExcerpt(value, label) {
  for (const key of [
    "source_location",
    "line_number",
    "end_line_number",
    "snippet",
  ]) {
    assert(
      !Object.hasOwn(value, key),
      `${label} structural file must omit ${key}`,
    )
  }
}

function independentlyVerifyFixture(contract, root, fixture) {
  const graph = fixture.graph
  assert(
    graph.numberOfNodes() === contract.generator.node_count,
    "parsed graph node cardinality mismatch",
  )
  assert(
    graph.numberOfEdges() === contract.generator.edge_count,
    "parsed graph edge cardinality mismatch",
  )
  assert(
    fixture.fileHashes.size === contract.generator.node_count,
    "file-hash cardinality mismatch",
  )

  const physicalFiles = walkFiles(join(root, "src", "fixture"))
  assert(
    physicalFiles.length === contract.generator.node_count,
    "physical source-file cardinality mismatch",
  )
  const observedSourceFiles = new Set()
  for (const [id, attributes] of graph.nodeEntries()) {
    const match = /^n(\d{3})(\d{2})$/.exec(id)
    assert(match !== null, `invalid fixture node ID: ${id}`)
    const expected = fixtureNodeDefinition(
      contract,
      Number(match[1]),
      Number(match[2]),
    )
    const sourceFile = attributes.source_file
    assert(
      sourceFile === expected.sourceFile,
      `node ${id} source_file mismatch`,
    )
    assert(
      !observedSourceFiles.has(sourceFile),
      `source file ${sourceFile} is owned by multiple nodes`,
    )
    observedSourceFiles.add(sourceFile)
    assert(attributes.label === expected.label, `node ${id} label mismatch`)
    assert(
      attributes.qualified_name === expected.label,
      `node ${id} qualified_name mismatch`,
    )
    assert(
      attributes.node_kind === "file",
      `node ${id} is not its canonical file node`,
    )
    assert(
      attributes.source_domain === contract.generator.source_domain,
      `node ${id} source_domain mismatch`,
    )
    assert(
      attributes.content_hash === expected.contentHash,
      `node ${id} content_hash mismatch`,
    )
    assert(
      sameCanonical(attributes.provenance, fixture.provenance),
      `node ${id} provenance mismatch`,
    )
    assertStructuralFileHasNoExcerpt(attributes, `graph node ${id}`)

    const path = resolve(root, expected.sourceFile)
    const bytes = readFileSync(path)
    assert(
      sha256(bytes) === expected.contentHash,
      `source hash mismatch for ${expected.sourceFile}`,
    )
  }
  assert(
    observedSourceFiles.size === contract.generator.node_count,
    "canonical file-node coverage mismatch",
  )

  const expectedEdges = new Set()
  for (
    let componentIndex = 0;
    componentIndex < contract.generator.component_count;
    componentIndex += 1
  ) {
    for (
      let localIndex = 0;
      localIndex < contract.generator.nodes_per_component;
      localIndex += 1
    ) {
      const from = fixtureNodeDefinition(contract, componentIndex, localIndex)
      expectedEdges.add(
        canonicalJson({
          from: from.id,
          relation: "imports_from",
          to: fixtureNodeDefinition(
            contract,
            componentIndex,
            (localIndex + 1) % contract.generator.nodes_per_component,
          ).id,
        }),
      )
      expectedEdges.add(
        canonicalJson({
          from: from.id,
          relation: "imports_from",
          to: fixtureNodeDefinition(
            contract,
            componentIndex,
            (localIndex + 37) % contract.generator.nodes_per_component,
          ).id,
        }),
      )
    }
  }
  const observedEdges = new Set()
  const edgeById = new Map()
  for (const [from, to, attributes, id] of graph.edgeEntries()) {
    const tuple = canonicalJson({
      from,
      relation: attributes.relation,
      to,
    })
    assert(!observedEdges.has(tuple), `duplicate directed typed edge: ${tuple}`)
    observedEdges.add(tuple)
    assert(expectedEdges.has(tuple), `unexpected directed typed edge: ${tuple}`)
    const source = graph.nodeAttributes(from)
    assert(
      attributes.source_file === source.source_file,
      `edge ${id} source_file mismatch`,
    )
    assert(
      !Object.hasOwn(attributes, "source_location"),
      `edge ${id} must omit source_location`,
    )
    assert(
      sameCanonical(attributes.provenance, fixture.provenance),
      `edge ${id} provenance mismatch`,
    )
    edgeById.set(id, { from, to, attributes })
  }
  assert(
    observedEdges.size === expectedEdges.size &&
      [...expectedEdges].every((edge) => observedEdges.has(edge)),
    "directed typed edge set mismatch",
  )
  return edgeById
}

function validateAuthenticatedNode(resultNode, context) {
  const { graph, root, fileHashes } = context
  assert(
    graph.hasNode(resultNode.node_id),
    `result references unknown node ${resultNode.node_id}`,
  )
  const attributes = graph.nodeAttributes(resultNode.node_id)
  for (const key of [
    "label",
    "node_kind",
    "source_file",
    "source_domain",
    "content_hash",
  ]) {
    assert(
      resultNode[key] === attributes[key],
      `node ${resultNode.node_id} ${key} mismatch`,
    )
  }
  assert(
    sameCanonical(resultNode.provenance, attributes.provenance),
    `node ${resultNode.node_id} provenance mismatch`,
  )
  assertStructuralFileHasNoExcerpt(
    resultNode,
    `retrieve node ${resultNode.node_id}`,
  )
  const sourceFile = resultNode.source_file
  assert(
    !isAbsolute(sourceFile),
    `node ${resultNode.node_id} returned an absolute source path`,
  )
  const realRoot = realpathSync(root)
  const candidate = realpathSync(resolve(realRoot, sourceFile))
  assert(
    sourceIsBeneathRoot(realRoot, candidate),
    `node ${resultNode.node_id} escaped fixture root`,
  )
  const observedHash = sha256(readFileSync(candidate))
  assert(
    observedHash === fileHashes.get(sourceFile),
    `node ${resultNode.node_id} index hash mismatch`,
  )
  assert(
    observedHash === resultNode.content_hash,
    `node ${resultNode.node_id} result hash mismatch`,
  )
}

export function validateRetrieveResult(result, expectation, context) {
  const { contract, edgeById, serializeRetrieveContextResult } = context
  assert(result.schema === "madar.retrieve", "retrieve result schema mismatch")
  assert(result.version === 1, "retrieve result version mismatch")
  assert(
    result.outcome === expectation.outcome,
    `query ${expectation.query_index} outcome mismatch`,
  )

  const nodeIds = result.matched_nodes.map((node) => node.node_id)
  assert(
    new Set(nodeIds).size === nodeIds.length,
    "retrieve result contains duplicate node IDs",
  )
  assert(
    canonicalJson([...nodeIds].sort()) ===
      canonicalJson([...expectation.node_ids].sort()),
    `query ${expectation.query_index} node set mismatch`,
  )
  if (expectation.outcome === "evidence") {
    assert(
      nodeIds.length > 0,
      `query ${expectation.query_index} returned empty positive evidence`,
    )
  }
  for (const node of result.matched_nodes) {
    validateAuthenticatedNode(node, context)
  }

  const relationshipIds = result.relationships.map(
    (relationship) => relationship.id,
  )
  assert(
    new Set(relationshipIds).size === relationshipIds.length,
    "retrieve result contains duplicate relationship IDs",
  )
  const relationshipTuples = result.relationships.map((relationship) => ({
    from_id: relationship.from_id,
    relation: relationship.relation,
    to_id: relationship.to_id,
  }))
  assert(
    canonicalJson(
      canonicalSet(relationshipTuples, "retrieve relationships"),
    ) ===
      canonicalJson(
        canonicalSet(expectation.relationships, "expected relationships"),
      ),
    `query ${expectation.query_index} relationship set mismatch`,
  )
  for (const relationship of result.relationships) {
    const edge = edgeById.get(relationship.id)
    assert(
      edge !== undefined,
      `result references unknown edge ${relationship.id}`,
    )
    assert(
      edge.from === relationship.from_id,
      `edge ${relationship.id} from_id mismatch`,
    )
    assert(
      edge.to === relationship.to_id,
      `edge ${relationship.id} to_id mismatch`,
    )
    assert(
      edge.attributes.relation === relationship.relation,
      `edge ${relationship.id} relation mismatch`,
    )
    assert(
      edge.attributes.source_file === relationship.source_file,
      `edge ${relationship.id} source_file mismatch`,
    )
    assert(
      !Object.hasOwn(relationship, "source_location"),
      `edge ${relationship.id} must omit source_location`,
    )
    assert(
      sameCanonical(edge.attributes.provenance, relationship.provenance),
      `edge ${relationship.id} provenance mismatch`,
    )
  }

  assert(
    canonicalJson(canonicalSet(result.boundaries, "retrieve boundaries")) ===
      canonicalJson(
        canonicalSet(expectation.boundaries, "expected boundaries"),
      ),
    `query ${expectation.query_index} boundary set mismatch`,
  )

  const selectedFiles = new Set(
    result.matched_nodes.map((node) => node.source_file),
  )
  for (const relationship of result.relationships) {
    if (relationship.source_file !== undefined) {
      selectedFiles.add(relationship.source_file)
    }
  }
  const snippets = result.matched_nodes.filter(
    (node) => typeof node.snippet === "string" && node.snippet.length > 0,
  ).length
  const serializedTokens = countTokens(serializeRetrieveContextResult(result))
  assert(
    result.metrics.selected_files === selectedFiles.size,
    "selected_files metric mismatch",
  )
  assert(result.metrics.snippets === snippets, "snippets metric mismatch")
  assert(snippets === 0, "structural-file fixture must return zero snippets")
  assert(
    result.metrics.serialized_tokens === serializedTokens,
    "serialized_tokens metric mismatch",
  )
  assert(
    result.metrics.closure_passes <= contract.protocol.closure_pass_max,
    "closure-pass cap exceeded",
  )
  assert(
    result.metrics.selected_files <= contract.protocol.selected_file_max,
    "selected-file cap exceeded",
  )
  assert(
    result.metrics.serialized_tokens <= contract.protocol.serialized_token_max,
    "token cap exceeded",
  )
  assert(
    result.metrics.truncated === false,
    "exact performance query was truncated",
  )
  return {
    query_index: expectation.query_index,
    outcome: result.outcome,
    nodes: result.matched_nodes.length,
    relationships: result.relationships.length,
    boundaries: result.boundaries.length,
    selected_files: result.metrics.selected_files,
    snippets: result.metrics.snippets,
    closure_passes: result.metrics.closure_passes,
    serialized_tokens: result.metrics.serialized_tokens,
    passed: true,
  }
}

function environmentMetadata(reference) {
  const actual = {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model.trim() ?? "unknown",
    memory_bytes: totalmem(),
  }
  return {
    ...actual,
    reference,
    reference_match: sameCanonical(actual, reference),
  }
}

function repositoryIdentity(root = repositoryRoot) {
  const atRoot = root === repositoryRoot ? [] : ["-C", root]
  return {
    head_commit: git(...atRoot, "rev-parse", "HEAD"),
    head_tree_oid: git(...atRoot, "rev-parse", "HEAD^{tree}"),
    worktree_dirty:
      git(
        ...atRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ).length > 0,
  }
}

export function controlledBuildEnvironment(input = process.env, npmConfigs) {
  const environment = { ...input }
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase()
    if (
      upper === "NODE_OPTIONS" ||
      upper === "NODE_PATH" ||
      upper.startsWith("GIT_") ||
      upper.startsWith("MADAR_") ||
      upper.startsWith("NPM_CONFIG_")
    ) {
      delete environment[name]
    }
  }
  const controlled = {
    ...environment,
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  }
  if (npmConfigs) {
    controlled.NPM_CONFIG_USERCONFIG = npmConfigs.userConfig
    controlled.NPM_CONFIG_GLOBALCONFIG = npmConfigs.globalConfig
  }
  return controlled
}

export function createNpmConfigPair(root) {
  mkdirSync(root, { recursive: true })
  const userConfig = join(root, "user.npmrc")
  const globalConfig = join(root, "global.npmrc")
  writeFileSync(userConfig, "", { encoding: "utf8", mode: 0o600 })
  writeFileSync(globalConfig, "", { encoding: "utf8", mode: 0o600 })
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

function prepareRuntimeSubject(harnessRoot) {
  assert(
    !process.env.NODE_OPTIONS && !process.env.NODE_PATH,
    "performance evaluation forbids inherited Node preload/module paths",
  )
  const before = repositoryIdentity(repositoryRoot)
  assert(
    before.worktree_dirty === false,
    "performance evaluation requires a clean exact-HEAD worktree",
  )
  const sourceBefore = exactHeadSourceAttestation()
  const controlsBefore = exactHeadBuildControlAttestation()
  const runtimeRoot = join(harnessRoot, "subject")
  git(
    "clone",
    "--no-local",
    "--no-checkout",
    "--no-tags",
    repositoryRoot,
    runtimeRoot,
  )
  git("-C", runtimeRoot, "checkout", "--detach", before.head_commit)
  if (git("-C", runtimeRoot, "remote").split(/\r?\n/).includes("origin")) {
    git("-C", runtimeRoot, "remote", "remove", "origin")
  }
  const cloneBefore = repositoryIdentity(runtimeRoot)
  assert(
    cloneBefore.head_commit === before.head_commit &&
      cloneBefore.head_tree_oid === before.head_tree_oid &&
      cloneBefore.worktree_dirty === false,
    "performance build clone is not the clean exact subject HEAD/tree",
  )
  const cloneSourceBefore = exactHeadSourceAttestation(runtimeRoot)
  const cloneControlsBefore = exactHeadBuildControlAttestation(runtimeRoot)
  assert(
    sameCanonical(cloneSourceBefore, sourceBefore) &&
      sameCanonical(cloneControlsBefore, controlsBefore),
    "performance build clone does not match the authenticated subject",
  )
  const npmConfigs = createNpmConfigPair(join(harnessRoot, "npm-config"))
  execFileSync(
    process.execPath,
    [
      resolveNpmCli(),
      "ci",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--userconfig=${npmConfigs.userConfig}`,
      `--globalconfig=${npmConfigs.globalConfig}`,
    ],
    {
      cwd: runtimeRoot,
      env: controlledBuildEnvironment(process.env, npmConfigs),
      stdio: ["ignore", "inherit", "inherit"],
    },
  )
  const environment = controlledBuildEnvironment()
  execFileSync(process.execPath, ["--eval", cleanProgram], {
    cwd: runtimeRoot,
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
  })
  execFileSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
    {
      cwd: runtimeRoot,
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
    },
  )
  const after = repositoryIdentity(repositoryRoot)
  const cloneAfter = repositoryIdentity(runtimeRoot)
  const sourceAfter = exactHeadSourceAttestation()
  const controlsAfter = exactHeadBuildControlAttestation()
  const cloneSourceAfter = exactHeadSourceAttestation(runtimeRoot)
  const cloneControlsAfter = exactHeadBuildControlAttestation(runtimeRoot)
  assert(
    after.head_commit === before.head_commit &&
      after.head_tree_oid === before.head_tree_oid,
    "repository HEAD changed while building the performance subject",
  )
  assert(
    after.worktree_dirty === false,
    "performance build changed tracked or untracked repository content",
  )
  assert(
    sameCanonical(sourceAfter, sourceBefore),
    "performance build changed the exact-HEAD source attestation",
  )
  assert(
    sameCanonical(controlsAfter, controlsBefore),
    "performance build changed the exact-HEAD build controls",
  )
  assert(
    cloneAfter.head_commit === before.head_commit &&
      cloneAfter.head_tree_oid === before.head_tree_oid &&
      cloneAfter.worktree_dirty === false,
    "performance build changed the detached subject clone",
  )
  assert(
    sameCanonical(cloneSourceAfter, cloneSourceBefore) &&
      sameCanonical(cloneControlsAfter, cloneControlsBefore),
    "performance build changed authenticated source or build controls",
  )
  const distRoot = resolve(runtimeRoot, "dist", "src")
  return {
    runtimeRoot,
    subject: {
      ...after,
      build_source: "detached_standalone_exact_head_clone",
      install_command: installCommand,
      clean_command: cleanCommand,
      build_command: buildCommand,
      build_completed_before_graph_load: true,
      ...sourceAfter,
      ...controlsAfter,
      dist_sha256: directoryDigest(distRoot),
    },
  }
}

export function buildPerformanceReceipt(input) {
  const derived = derivePerformanceReceiptState(input)
  const measurements = {
    ...input.measurements,
    p95_ms: derived.p95_ms,
  }
  const environment = {
    ...input.environment,
    reference_match: derived.reference_match,
  }
  const body = {
    schema_version: 2,
    receipt_kind: "core-reset-evidence-path-performance",
    generated_at: input.generated_at,
    share_safe: true,
    issue: 596,
    benchmark_passed: derived.benchmark_passed,
    eligible_for_acceptance: derived.eligible_for_acceptance,
    command: input.contract.runner,
    contract: {
      path: input.contract_path,
      fixture_id: input.contract.fixture_id,
      sha256: input.contract_sha256,
    },
    evaluator: input.evaluator,
    subject: input.subject,
    environment,
    fixture: input.fixture,
    protocol: {
      graph_loaded_before_timer: true,
      graph_serialized_before_timer: true,
      graph_deserialized_before_timer: true,
      query_index_inspected_before_timer: true,
      validation_outside_timed_window: true,
      query_schedule: input.contract.protocol.query_schedule,
      clock: input.contract.protocol.clock,
      percentile: input.contract.protocol.percentile,
      process_model: input.contract.protocol.process_model,
    },
    correctness: input.correctness,
    measurements,
    gates: derived.gates,
    failures: derived.failures,
  }
  return { ...body, receipt_sha256: sha256(canonicalJson(body)) }
}

function environmentMatchesReference(environment) {
  const actual = {
    node: environment.node,
    platform: environment.platform,
    release: environment.release,
    arch: environment.arch,
    cpu: environment.cpu,
    memory_bytes: environment.memory_bytes,
  }
  return sameCanonical(actual, environment.reference)
}

function derivePerformanceReceiptState(receipt) {
  const p95Ms = nearestRank(
    receipt.measurements.samples.map((sample) => sample.elapsed_ms),
    95,
  )
  const environmentMatch = environmentMatchesReference(receipt.environment)
  const p95Passed = p95Ms < receipt.measurements.target_ms
  const gates = {
    reference_environment: {
      pass: environmentMatch,
    },
    warm_retrieval_p95: {
      actual_ms: p95Ms,
      maximum_ms: receipt.measurements.target_ms,
      comparison: "strictly_less_than",
      pass: p95Passed,
    },
  }
  const benchmarkPassed = p95Passed
  const eligibleForAcceptance = benchmarkPassed && environmentMatch
  const failures = [
    ...(p95Passed ? [] : ["warm_retrieval_p95"]),
    ...(environmentMatch ? [] : ["reference_environment"]),
  ]
  return {
    p95_ms: p95Ms,
    reference_match: environmentMatch,
    gates,
    benchmark_passed: benchmarkPassed,
    eligible_for_acceptance: eligibleForAcceptance,
    failures,
  }
}

export function validatePerformanceReceiptSemantics(receipt) {
  const derived = derivePerformanceReceiptState(receipt)
  assert(
    receipt.measurements.p95_ms === derived.p95_ms,
    "performance receipt p95 must be derived from measured samples",
  )
  assert(
    receipt.environment.reference_match === derived.reference_match,
    "performance receipt environment match must be derived from recorded identity",
  )
  assert(
    sameCanonical(receipt.gates, derived.gates),
    "performance receipt gates must match derived p95 and environment outcomes",
  )
  assert(
    receipt.benchmark_passed === derived.benchmark_passed,
    "performance receipt benchmark_passed must match the p95 gate",
  )
  assert(
    receipt.eligible_for_acceptance === derived.eligible_for_acceptance,
    "performance receipt eligibility must match p95 and environment gates",
  )
  assert(
    sameCanonical(receipt.failures, derived.failures),
    "performance receipt failures must match derived gate failures",
  )
  const { receipt_sha256: recorded, ...body } = receipt
  assert(recorded === sha256(canonicalJson(body)), "receipt self-hash mismatch")
  return true
}

function validateReceipt(receipt) {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const validate = ajv.compile(readJson(receiptSchemaPath))
  if (!validate(receipt)) {
    throw new Error(
      `performance receipt schema validation failed:\n${ajv.errorsText(
        validate.errors,
        { separator: "\n" },
      )}`,
    )
  }
  validatePerformanceReceiptSemantics(receipt)
}

async function run(options) {
  const contractPath = resolve(repositoryRoot, options.contract)
  const receiptPath = resolve(repositoryRoot, options.receipt)
  const contractBytes = readFileSync(contractPath)
  const contractSha256 = sha256(contractBytes)
  assert(
    contractSha256 === expectedContractSha256,
    `frozen contract hash mismatch: expected ${expectedContractSha256}, observed ${contractSha256}`,
  )
  const contract = validateFrozenContract(
    JSON.parse(contractBytes.toString("utf8")),
  )
  assert(
    normalizeRepositoryPath(receiptPath) === contract.receipt,
    `receipt path must match frozen contract: ${contract.receipt}`,
  )
  const harnessRoot = mkdtempSync(join(tmpdir(), "madar-evidence-path-"))

  try {
    const prepared = prepareRuntimeSubject(harnessRoot)
    const runtime = await runtimeModules(prepared.runtimeRoot)
    const fixtureRoot = join(harnessRoot, "fixture")
    mkdirSync(fixtureRoot, { recursive: true })
    const fixture = materializeFixture(contract, fixtureRoot, runtime)
    const edgeById = independentlyVerifyFixture(contract, fixtureRoot, fixture)
    const queryIndex = runtime.inspectQueryIndex(fixture.graph)
    assert(
      queryIndex.state === "ready",
      `canonical query-index inspection returned ${queryIndex.state}`,
    )
    assert(
      queryIndex.root_path === fixtureRoot,
      "canonical query-index root does not match the fixture root",
    )
    assert(
      queryIndex.file_hashes.size === fixture.fileHashes.size,
      "canonical query-index file-hash cardinality mismatch",
    )
    const verificationContext = {
      contract,
      graph: fixture.graph,
      edgeById,
      root: queryIndex.root_path,
      fileHashes: queryIndex.file_hashes,
      serializeRetrieveContextResult: runtime.serializeRetrieveContextResult,
    }
    const invokeAndVerify = (queryPosition) => {
      const result = runtime.retrieveContext(queryIndex, {
        question: contract.queries[queryPosition],
        budget: contract.protocol.serialized_token_max,
      })
      return validateRetrieveResult(
        result,
        contract.query_expectations[queryPosition],
        verificationContext,
      )
    }

    const preflight = contract.queries.map((_, queryIndex) =>
      invokeAndVerify(queryIndex),
    )
    const warmups = []
    for (
      let invocation = 0;
      invocation < contract.protocol.warmup_invocations;
      invocation += 1
    ) {
      warmups.push({
        invocation,
        ...invokeAndVerify(invocation % contract.queries.length),
      })
    }
    const samples = []
    for (
      let invocation = 0;
      invocation < contract.protocol.measured_invocations;
      invocation += 1
    ) {
      const queryIndexValue = invocation % contract.queries.length
      const started = performance.now()
      const result = runtime.retrieveContext(queryIndex, {
        question: contract.queries[queryIndexValue],
        budget: contract.protocol.serialized_token_max,
      })
      const elapsedMs = performance.now() - started
      const correctness = validateRetrieveResult(
        result,
        contract.query_expectations[queryIndexValue],
        verificationContext,
      )
      samples.push({
        invocation,
        elapsed_ms: roundedMilliseconds(elapsedMs),
        ...correctness,
      })
    }
    const receipt = buildPerformanceReceipt({
      generated_at: new Date().toISOString(),
      contract,
      contract_path: normalizeRepositoryPath(contractPath),
      contract_sha256: contractSha256,
      evaluator: {
        path: normalizeRepositoryPath(scriptPath),
        sha256: sha256(readFileSync(scriptPath)),
        schema_path: normalizeRepositoryPath(receiptSchemaPath),
        schema_sha256: sha256(readFileSync(receiptSchemaPath)),
      },
      subject: prepared.subject,
      environment: environmentMetadata(contract.reference_environment),
      fixture: {
        algorithm: contract.generator.algorithm,
        seed: contract.generator.seed,
        component_count: contract.generator.component_count,
        nodes_per_component: contract.generator.nodes_per_component,
        node_count: fixture.graph.numberOfNodes(),
        edge_count: fixture.graph.numberOfEdges(),
        authenticated_source_files: fixture.fileHashes.size,
        structural_file_nodes: fixture.graph.numberOfNodes(),
        ranged_file_nodes: 0,
        file_node_snippets: 0,
        graph_serialization: contract.generator.serialization,
        graph_sha256: portableGraphDigest(fixture.serializedGraph),
        graph_root_normalization: "<fixture-root>",
        source_manifest_sha256: framedDigest(fixture.sourceManifest),
        source_manifest_encoding: "sorted path NUL sha256 NUL byte-length LF",
      },
      correctness: { preflight, warmups },
      measurements: {
        samples,
        target_ms: contract.protocol.p95_ms_max,
        percentile_method: "nearest-rank",
      },
    })
    validateReceipt(receipt)
    writeJson(receiptPath, receipt)
    process.stdout.write(
      `${JSON.stringify(
        {
          receipt: normalizeRepositoryPath(receiptPath),
          benchmark_passed: receipt.benchmark_passed,
          eligible_for_acceptance: receipt.eligible_for_acceptance,
          p95_ms: receipt.measurements.p95_ms,
          samples: receipt.measurements.samples.length,
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

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath === resolve(scriptPath)) {
  run(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    )
    process.exitCode = 1
  })
}
