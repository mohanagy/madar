import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base"
import { describe, expect, it } from "vitest"

import { parseGenerateArgs } from "../../src/cli/parser.js"

// Development-only JavaScript is deliberately outside the production build.
// @ts-expect-error -- the evaluator is not part of the published declaration surface
import * as heldOutEvaluator from "../../tools/eval/core-reset/evidence-path-held-out.mjs"

const {
  assertMatchingRuntimeTrees,
  assertShareSafeReceipt,
  auditPersistedResult,
  createNpmConfigPair,
  directoryTreeAttestation,
  executeGenerationBarrier,
  exactUtf16Range,
  generateCommand,
  gradeQuestionEvidence,
  isolatedRetrieveChildSource,
  materializeWorkspaceConfigView,
  runContainedNode,
  workspacePatternMatches,
} = heldOutEvaluator

type JsonObject = Record<string, any>
type SyntheticEdge = {
  from: string
  to: string
  attributes: JsonObject
}

const contractPath = resolve(
  "tools/eval/core-reset/contracts/evaluation-contract.json",
)
const runnerPath = resolve("tools/eval/core-reset/evidence-path-held-out.mjs")
const schemaPath = resolve(
  "tools/eval/core-reset/schemas/evidence-path-held-out-receipt.schema.json",
)
const provenance = [{ source: "synthetic-test" }]

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function sandboxSelector(path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  return `(literal "${escaped}")`
}

function runBroadDarwinAdversarialProbe({
  root,
  entryPath,
}: {
  root: string
  entryPath: string
}): string {
  const canonicalRoot = realpathSync(root)
  const canonicalEntryPath = realpathSync(entryPath)
  const evaluatorRoot = realpathSync(resolve(dirname(runnerPath), "../../.."))
  const readableParent = dirname(evaluatorRoot)
  const profilePath = join(canonicalRoot, "adversarial.sb")
  const profile = `(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec)
(allow process-exec ${[
    process.execPath,
    "/usr/bin/git",
    "/bin/sh",
  ]
    .map((path) => sandboxSelector(realpathSync(path)))
    .join(" ")})
(deny file-read* (subpath "${evaluatorRoot}"))
(deny file-write*)
(allow file-write* (subpath "${canonicalRoot}") ${sandboxSelector("/dev/null")})
`
  writeFileSync(profilePath, profile)
  return execFileSync(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      profilePath,
      process.execPath,
      "--no-warnings",
      "--experimental-permission",
      "--allow-child-process",
      `--allow-fs-read=${canonicalRoot}`,
      `--allow-fs-read=${readableParent}`,
      `--allow-fs-write=${canonicalRoot}`,
      canonicalEntryPath,
      contractPath,
    ],
    {
      cwd: canonicalRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: canonicalRoot,
        TMPDIR: canonicalRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
}

function range(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
) {
  return {
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
  }
}

function oneLineRanges(source: string, declaration: string) {
  const line = source.split(/\r\n|\r|\n|\u2028|\u2029/, 1)[0] ?? ""
  return {
    definition_range: range(1, 1, 1, line.length + 1),
    declaration_range: range(1, 1, 1, declaration.length + 1),
  }
}

class SyntheticGraph {
  readonly nodes: Map<string, JsonObject>
  readonly edges: Map<string, SyntheticEdge>

  constructor(
    nodes: Array<[string, JsonObject]>,
    edges: Array<[string, SyntheticEdge]>,
  ) {
    this.nodes = new Map(nodes)
    this.edges = new Map(edges)
  }

  hasNode(id: string) {
    return this.nodes.has(id)
  }

  nodeAttributes(id: string) {
    const attributes = this.nodes.get(id)
    if (!attributes) throw new Error(`Missing node ${id}`)
    return attributes
  }

  nodeEntries() {
    return [...this.nodes.entries()]
  }

  edgeEntries() {
    return [...this.edges].map(([id, edge]) => [
      edge.from,
      edge.to,
      edge.attributes,
      id,
    ])
  }
}

function symbolNode(
  id: string,
  sourceFile: string,
  source: string,
  symbol: string,
  declaration: string,
): [string, JsonObject] {
  return [
    id,
    {
      label: `${symbol}()`,
      qualified_name: symbol,
      node_kind: "constant",
      source_file: sourceFile,
      source_domain: "production",
      content_hash: hash(source),
      provenance,
      ...oneLineRanges(source, declaration),
    },
  ]
}

function fileNode(
  id: string,
  sourceFile: string,
  source: string,
): [string, JsonObject] {
  return [
    id,
    {
      label: sourceFile,
      node_kind: "file",
      source_file: sourceFile,
      source_domain: "production",
      content_hash: hash(source),
      provenance,
    },
  ]
}

function evidenceNode(
  graph: SyntheticGraph,
  id: string,
  sources: Map<string, string>,
): JsonObject {
  const attributes = graph.nodeAttributes(id)
  if (attributes.node_kind === "file") {
    return {
      node_id: id,
      evidence_kind: "structural_file",
      label: attributes.label,
      node_kind: "file",
      source_file: attributes.source_file,
      source_domain: attributes.source_domain,
      content_hash: attributes.content_hash,
      provenance,
    }
  }
  const source = sources.get(attributes.source_file)
  if (!source) throw new Error(`Missing source ${attributes.source_file}`)
  const snippet = exactUtf16Range(source, attributes.declaration_range)
  if (snippet === null) throw new Error("Invalid synthetic declaration range")
  return {
    node_id: id,
    evidence_kind: "symbol_declaration",
    label: attributes.label,
    node_kind: attributes.node_kind,
    source_file: attributes.source_file,
    source_domain: attributes.source_domain,
    content_hash: attributes.content_hash,
    provenance,
    definition_range: attributes.definition_range,
    declaration_range: attributes.declaration_range,
    snippet,
  }
}

function relationship(graph: SyntheticGraph, id: string): JsonObject {
  const edge = graph.edges.get(id)
  if (!edge) {
    return {
      id,
      from_id: "symbol:a",
      to_id: "symbol:b",
      relation: "calls",
      source_file: "owner-a.ts",
      source_location: "L1",
      provenance,
    }
  }
  return {
    id,
    from_id: edge.from,
    to_id: edge.to,
    relation: edge.attributes.relation,
    source_file: edge.attributes.source_file,
    source_location: edge.attributes.source_location,
    provenance: edge.attributes.provenance,
  }
}

function finalizedResult(overrides: JsonObject = {}): JsonObject {
  const defaultMetrics: JsonObject = {
    selected_files: 0,
    snippets: 0,
    closure_passes: 1,
    serialized_tokens: 0,
    truncated: false,
  }
  const result: JsonObject = {
    schema: "madar.retrieve",
    version: 1,
    outcome: "evidence",
    matched_nodes: [],
    relationships: [],
    boundaries: [],
    metrics: defaultMetrics,
    ...overrides,
  }
  result.metrics = { ...defaultMetrics, ...overrides.metrics }
  result.metrics.selected_files = new Set([
    ...result.matched_nodes.map((node: JsonObject) => node.source_file),
    ...result.relationships
      .map((edge: JsonObject) => edge.source_file)
      .filter((value: unknown) => typeof value === "string"),
  ]).size
  result.metrics.snippets = result.matched_nodes.filter(
    (node: JsonObject) =>
      node.evidence_kind === "symbol_declaration" &&
      typeof node.snippet === "string",
  ).length
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const observed = countTokens(JSON.stringify(result))
    if (observed === result.metrics.serialized_tokens) break
    result.metrics.serialized_tokens = observed
  }
  return result
}

function syntheticHarness() {
  const root = mkdtempSync(join(tmpdir(), "madar-held-out-v2-test-"))
  const sourceA =
    "export const ownerA = (value: string) => { return value }\nexport const tiny = 1\n"
  const sourceB = "export const ownerB = (value: string) => { return value }\n"
  const wrongSource =
    "export const ownerA = (value: number) => { return value }\n"
  const declarationA = "export const ownerA = (value: string) => "
  const declarationB = "export const ownerB = (value: string) => "
  const wrongDeclaration = "export const ownerA = (value: number) => "
  const tinyDeclaration = "export const tiny = 1"
  const sources = new Map([
    ["owner-a.ts", sourceA],
    ["owner-b.ts", sourceB],
    ["wrong.ts", wrongSource],
  ])
  for (const [path, source] of sources) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  const tinyRange = range(2, 1, 2, tinyDeclaration.length + 1)
  const graph = new SyntheticGraph(
    [
      fileNode("file:a", "owner-a.ts", sourceA),
      fileNode("file:b", "owner-b.ts", sourceB),
      fileNode("file:wrong", "wrong.ts", wrongSource),
      symbolNode("symbol:a", "owner-a.ts", sourceA, "ownerA", declarationA),
      symbolNode("symbol:b", "owner-b.ts", sourceB, "ownerB", declarationB),
      symbolNode(
        "symbol:wrong-file",
        "wrong.ts",
        wrongSource,
        "ownerA",
        wrongDeclaration,
      ),
      [
        "symbol:tiny",
        {
          label: "tiny",
          qualified_name: "tiny",
          node_kind: "constant",
          source_file: "owner-a.ts",
          source_domain: "production",
          content_hash: hash(sourceA),
          provenance,
          definition_range: tinyRange,
          declaration_range: tinyRange,
        },
      ],
    ],
    [
      [
        "edge:contains-a",
        {
          from: "file:a",
          to: "symbol:a",
          attributes: {
            relation: "contains",
            source_file: "owner-a.ts",
            source_location: "L1",
            provenance,
          },
        },
      ],
      [
        "edge:imports",
        {
          from: "file:a",
          to: "file:b",
          attributes: {
            relation: "imports_from",
            source_file: "owner-a.ts",
            source_location: "L1",
            provenance,
          },
        },
      ],
    ],
  )
  const context = {
    graph,
    graphRoot: realpathSync(root),
    edgeById: graph.edges,
  }
  const fixtures = [
    {
      id: "owner.a",
      repository_id: "synthetic",
      source_file: "owner-a.ts",
      source_sha256: hash(sourceA),
      symbol: "ownerA",
      node_kind: "constant",
      declaration_range: oneLineRanges(sourceA, declarationA).declaration_range,
      declaration_sha256: hash(declarationA),
    },
    {
      id: "owner.b",
      repository_id: "synthetic",
      source_file: "owner-b.ts",
      source_sha256: hash(sourceB),
      symbol: "ownerB",
      node_kind: "constant",
      declaration_range: oneLineRanges(sourceB, declarationB).declaration_range,
      declaration_sha256: hash(declarationB),
    },
  ]
  const question = {
    required_phases: [
      {
        id: "first",
        scope: "required",
        accepted_owner_ids: ["owner.a"],
        minimum_owner_matches: 1,
      },
      {
        id: "second",
        scope: "required",
        accepted_owner_ids: ["owner.b"],
        minimum_owner_matches: 1,
      },
    ],
    required_handoffs: [
      {
        from_owner_id: "owner.a",
        to_owner_id: "owner.b",
        expectation: "disconnected",
      },
    ],
  }
  return {
    root,
    graph,
    sources,
    context,
    fixtures,
    question,
    repository: { graph_root: "." },
  }
}

function addGraphEdge(
  harness: ReturnType<typeof syntheticHarness>,
  id: string,
  from: string,
  to: string,
  relationName = "calls",
  sourceFile = "owner-a.ts",
) {
  harness.graph.edges.set(id, {
    from,
    to,
    attributes: {
      relation: relationName,
      source_file: sourceFile,
      source_location: "L1",
      provenance,
    },
  })
}

function addStructuralFile(
  harness: ReturnType<typeof syntheticHarness>,
  id: string,
  path: string,
) {
  const source = `export const ${id.replaceAll(/[^a-zA-Z0-9]/g, "_")} = true\n`
  writeFileSync(join(harness.root, path), source)
  harness.sources.set(path, source)
  harness.graph.nodes.set(id, fileNode(id, path, source)[1])
}

function machineGates() {
  return {
    required_in_scope_phase_coverage: 1,
    selected_file_precision_min: 0.7,
    unrelated_files_max: 2,
  }
}

function connectedQuestion(harness: ReturnType<typeof syntheticHarness>) {
  return {
    ...harness.question,
    required_handoffs: [
      {
        from_owner_id: "owner.a",
        to_owner_id: "owner.b",
        expectation: "connected",
      },
    ],
  }
}

function grade(
  harness: ReturnType<typeof syntheticHarness>,
  result: JsonObject,
  question: JsonObject = harness.question,
): JsonObject {
  const audit = auditPersistedResult(
    result,
    harness.repository,
    harness.context,
    JSON.stringify(result),
  )
  return gradeQuestionEvidence({
    question,
    ownerFixtures: harness.fixtures,
    result,
    audit,
    machineGates: machineGates(),
  })
}

describe("evidence-path held-out v2 evaluator", () => {
  it("finishes every repository generation before starting retrieval", () => {
    const repositories = [
      { id: "openstatus" },
      { id: "documenso" },
      { id: "formbricks" },
    ]
    const questions = repositories.map((repository) => ({
      id: `${repository.id}-question`,
      repository_id: repository.id,
    }))
    const events: string[] = []

    const contexts = executeGenerationBarrier({
      repositories,
      questions,
      generateRepository(repository: JsonObject) {
        events.push(`generate:${repository.id}`)
        return { graph: repository.id }
      },
      retrieveQuestion({
        repository,
        question,
        context,
      }: {
        repository: JsonObject
        question: JsonObject
        context: JsonObject
      }) {
        expect(context.graph).toBe(repository.id)
        events.push(`retrieve:${question.id}`)
      },
    })

    expect([...contexts.keys()]).toEqual([
      "openstatus",
      "documenso",
      "formbricks",
    ])
    expect(events).toEqual([
      "generate:openstatus",
      "generate:documenso",
      "generate:formbricks",
      "retrieve:openstatus-question",
      "retrieve:documenso-question",
      "retrieve:formbricks-question",
    ])
  })

  it("starts no retrieval when any repository generation fails", () => {
    const events: string[] = []
    expect(() =>
      executeGenerationBarrier({
        repositories: [
          { id: "openstatus" },
          { id: "documenso" },
          { id: "formbricks" },
        ],
        questions: [
          { id: "openstatus-question", repository_id: "openstatus" },
        ],
        generateRepository(repository: JsonObject) {
          events.push(`generate:${repository.id}`)
          if (repository.id === "documenso") {
            throw new Error("generation failed")
          }
          return { graph: repository.id }
        },
        retrieveQuestion() {
          events.push("retrieve")
        },
      }),
    ).toThrow("generation failed")
    expect(events).toEqual(["generate:openstatus", "generate:documenso"])
  })

  it("uses distinct empty npm user and global config files", () => {
    const root = mkdtempSync(join(tmpdir(), "madar-held-out-npm-config-"))
    try {
      const configs = createNpmConfigPair(root)
      expect(configs.userConfig).not.toBe(configs.globalConfig)
      expect(readFileSync(configs.userConfig, "utf8")).toBe("")
      expect(readFileSync(configs.globalConfig, "utf8")).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("matches only the supported workspace pattern grammar", () => {
    expect(workspacePatternMatches("apps/*", "apps/web")).toBe(true)
    expect(
      workspacePatternMatches(
        "packages/**/*",
        "packages/notifications/email",
      ),
    ).toBe(true)
    expect(workspacePatternMatches("packages/**/*", "apps/web")).toBe(false)
    expect(() =>
      workspacePatternMatches("packages/{config,ui}", "packages/config"),
    ).toThrow(/unsupported workspace pattern/)
    for (const pattern of [
      "packages/@(config|ui)",
      "packages/config]",
      "packages/config*",
    ]) {
      expect(() =>
        workspacePatternMatches(pattern, "packages/config"),
      ).toThrow(/unsupported workspace pattern/)
    }
    expect(() =>
      workspacePatternMatches("../packages/*", "packages/config"),
    ).toThrow(/workspace pattern/)
  })

  it("materializes only referenced tracked workspace config bytes deterministically", () => {
    const createFixture = () => {
      const root = mkdtempSync(join(tmpdir(), "madar-workspace-config-"))
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
      )
      const graphRoot = join(root, "apps", "web")
      mkdirSync(graphRoot, { recursive: true })
      writeFileSync(
        join(graphRoot, "package.json"),
        JSON.stringify({ name: "@fixture/web", private: true }),
      )
      writeFileSync(
        join(graphRoot, "tsconfig.json"),
        JSON.stringify({
          extends: "@fixture/tsconfig/nextjs.json",
        }),
      )
      const configRoot = join(root, "packages", "tsconfig")
      mkdirSync(configRoot, { recursive: true })
      writeFileSync(
        join(configRoot, "package.json"),
        JSON.stringify({ name: "@fixture/tsconfig", private: true }),
      )
      writeFileSync(
        join(configRoot, "nextjs.json"),
        JSON.stringify({ extends: "@fixture/base/config.json" }),
      )
      writeFileSync(
        join(configRoot, "base.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      )
      const baseRoot = join(root, "packages", "base")
      mkdirSync(baseRoot, { recursive: true })
      writeFileSync(
        join(baseRoot, "package.json"),
        JSON.stringify({ name: "@fixture/base", private: true }),
      )
      writeFileSync(
        join(baseRoot, "config.json"),
        JSON.stringify({ extends: "./strict.json" }),
      )
      writeFileSync(
        join(baseRoot, "strict.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      )
      const unrelatedRoot = join(root, "packages", "unrelated")
      mkdirSync(unrelatedRoot, { recursive: true })
      writeFileSync(
        join(unrelatedRoot, "package.json"),
        JSON.stringify({ name: "@fixture/unrelated", private: true }),
      )
      writeFileSync(join(unrelatedRoot, "index.ts"), "export const value = 1\n")
      return { root, graphRoot }
    }
    const first = createFixture()
    const second = createFixture()
    try {
      const firstResult = materializeWorkspaceConfigView(
        first.root,
        first.graphRoot,
      )
      const secondResult = materializeWorkspaceConfigView(
        second.root,
        second.graphRoot,
      )
      expect(firstResult).toEqual(secondResult)
      expect(firstResult.packages).toBe(2)
      expect(firstResult.mapping_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(
        readFileSync(
          join(
            first.graphRoot,
            "node_modules",
            "@fixture",
            "tsconfig",
            "nextjs.json",
          ),
          "utf8",
        ),
      ).toBe(JSON.stringify({ extends: "@fixture/base/config.json" }))
      expect(
        readFileSync(
          join(
            first.graphRoot,
            "node_modules",
            "@fixture",
            "base",
            "strict.json",
          ),
          "utf8",
        ),
      ).toBe(JSON.stringify({ compilerOptions: { strict: true } }))
      expect(() =>
        readFileSync(
          join(
            first.graphRoot,
            "node_modules",
            "@fixture",
            "unrelated",
            "index.ts",
          ),
        ),
      ).toThrow()
    } finally {
      rmSync(first.root, { recursive: true, force: true })
      rmSync(second.root, { recursive: true, force: true })
    }
  })

  it("fails closed on invalid package names and pre-existing dependency views", () => {
    const root = mkdtempSync(join(tmpdir(), "madar-workspace-config-invalid-"))
    const graphRoot = join(root, "apps", "web")
    const configRoot = join(root, "packages", "config")
    try {
      mkdirSync(graphRoot, { recursive: true })
      mkdirSync(configRoot, { recursive: true })
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] }),
      )
      writeFileSync(
        join(graphRoot, "package.json"),
        JSON.stringify({ name: "@fixture/web", private: true }),
      )
      writeFileSync(
        join(graphRoot, "tsconfig.json"),
        JSON.stringify({ extends: "@fixture/config/base.json" }),
      )
      writeFileSync(
        join(configRoot, "package.json"),
        JSON.stringify({ name: "@fixture/@config", private: true }),
      )
      writeFileSync(join(configRoot, "base.json"), "{}")
      expect(() =>
        materializeWorkspaceConfigView(root, graphRoot),
      ).toThrow(/unsupported workspace package name/)

      writeFileSync(
        join(configRoot, "package.json"),
        JSON.stringify({ name: "@fixture/config", private: true }),
      )
      const dependencyView = join(graphRoot, "node_modules")
      if (process.platform === "win32") {
        mkdirSync(dependencyView)
      } else {
        symlinkSync("missing-dependency-view", dependencyView)
      }
      expect(() =>
        materializeWorkspaceConfigView(root, graphRoot),
      ).toThrow(/must not contain node_modules/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("extracts UTF-16, end-exclusive ranges across supported line terminators", () => {
    for (const terminator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      const text = ["before", "A😀B", "after"].join(terminator)
      expect(exactUtf16Range(text, range(2, 2, 2, 4))).toBe("😀")
    }
  })

  it("isolates the one-call execution plan from owner, phase, and handoff fixtures", () => {
    const planText = execFileSync(
      process.execPath,
      [runnerPath, "--internal-plan", contractPath],
      { encoding: "utf8" },
    )
    const plan = JSON.parse(planText) as JsonObject
    expect(plan.contract_id).toBe("core-reset-held-out-v2")
    expect(plan.questions.map((entry: JsonObject) => entry.id)).toEqual([
      "openstatus-574-strict-one-call",
      "documenso-document-send",
      "formbricks-survey-response",
    ])
    for (const secret of [
      "owner_fixtures",
      "required_phases",
      "required_handoffs",
      "accepted_owner_ids",
      "declaration_range",
      "declaration_sha256",
      "source_sha256",
    ]) {
      expect(planText).not.toContain(secret)
    }
    expect(plan.questions).toHaveLength(3)
  })

  it("rejects any held-out contract bytes other than the frozen v2 contract", () => {
    const root = mkdtempSync(join(tmpdir(), "madar-held-out-contract-pin-"))
    try {
      const modified = join(root, "evaluation-contract.json")
      writeFileSync(modified, `${readFileSync(contractPath, "utf8")} `)
      expect(() =>
        execFileSync(
          process.execPath,
          [runnerPath, "--internal-plan", modified],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).toThrow(/frozen contract hash mismatch/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("requires all three prepared local repository inputs before runtime setup", () => {
    const invocation = () =>
      execFileSync(process.execPath, [runnerPath, "--contract", contractPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    expect(invocation).toThrow(
      process.platform === "darwin"
        ? /requires one prepared local --repository/
        : /requires Darwin/,
    )
  })

  it("rejects a packed runtime whose dist tree differs from the clean build", () => {
    const root = mkdtempSync(join(tmpdir(), "madar-held-out-stale-dist-"))
    try {
      const built = join(root, "built")
      const packed = join(root, "packed")
      mkdirSync(built)
      mkdirSync(packed)
      writeFileSync(join(built, "runtime.js"), "export const value = 1\n")
      writeFileSync(join(packed, "runtime.js"), "export const value = 2\n")
      const builtAttestation = directoryTreeAttestation(built)
      const packedAttestation = directoryTreeAttestation(packed)
      expect(() =>
        assertMatchingRuntimeTrees(builtAttestation, packedAttestation),
      ).toThrow(/does not match the clean-built dist tree/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== "darwin")(
    "runs every question probe in a fresh process with no global-state leakage",
    () => {
      const root = mkdtempSync(join(tmpdir(), "madar-held-out-fresh-child-"))
      try {
        const entryPath = join(root, "probe.mjs")
        writeFileSync(
          entryPath,
          `const key = Symbol.for("madar.held-out.test-state")
globalThis[key] = (globalThis[key] ?? 0) + 1
process.stdout.write(JSON.stringify({ pid: process.pid, probe: globalThis[key] }))
`,
        )
        const invoke = (suffix: string) => {
          const profilePath = join(root, `${suffix}.sb`)
          const output = runContainedNode({
            entryPath,
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: root,
              TMPDIR: root,
            },
            readPaths: [root],
            writePaths: [root],
            profilePath,
          })
          return JSON.parse(output.stdout) as JsonObject
        }
        const first = invoke("first")
        const second = invoke("second")
        expect(first.probe).toBe(1)
        expect(second.probe).toBe(1)
        expect(second.pid).not.toBe(first.pid)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "canonicalizes contained filesystem arguments across macOS path aliases",
    () => {
      const root = mkdtempSync(join(tmpdir(), "madar-held-out-path-alias-"))
      try {
        const entryPath = join(root, "read-path.mjs")
        const inputPath = join(root, "input.txt")
        writeFileSync(
          entryPath,
          `import { readFileSync } from "node:fs"
process.stdout.write(readFileSync(process.argv[2], "utf8"))
`,
        )
        writeFileSync(inputPath, "canonical")
        const output = runContainedNode({
          entryPath,
          args: [inputPath],
          pathArgIndexes: [0],
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
          },
          readPaths: [root],
          profilePath: join(root, "path-alias.sb"),
        })
        expect(output.stdout).toBe("canonical")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform !== "darwin")(
    "enforces the Darwin generation boundary: no evaluator read, child process, or network",
    () => {
      const root = mkdtempSync(join(tmpdir(), "madar-held-out-sandbox-"))
      try {
        const entryPath = join(root, "malicious-probe.mjs")
        writeFileSync(
          entryPath,
          `import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createConnection } from "node:net"

let readCode = "readable"
try { readFileSync(process.argv[2]) } catch (error) { readCode = error?.code ?? error?.message }
let git = { status: null, error: null, stderr: "" }
try { git = spawnSync("/usr/bin/git", ["--version"], { encoding: "utf8" }) }
catch (error) { git.error = error }
let shell = { status: null, error: null }
try { shell = spawnSync("/bin/sh", ["-c", "exit 0"], { encoding: "utf8" }) }
catch (error) { shell.error = error }
const networkCode = await new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port: 9 })
  socket.once("connect", () => { socket.destroy(); resolve("connected") })
  socket.once("error", (error) => resolve(error?.code ?? error?.message))
})
process.stdout.write(JSON.stringify({
  readCode,
  gitStatus: git.status,
  gitError: git.error?.code ?? null,
  gitStderr: git.stderr,
  shellStatus: shell.status,
  shellError: shell.error?.code ?? null,
  networkCode,
}))
`,
        )
        const proof = JSON.parse(
          runBroadDarwinAdversarialProbe({
            root,
            entryPath,
          }),
        ) as JsonObject
        expect(proof.readCode).toMatch(/ERR_ACCESS_DENIED|EPERM|EACCES/)
        expect(proof.gitStatus).toBeNull()
        expect(proof.gitError).toMatch(/ERR_ACCESS_DENIED|EPERM|EACCES/)
        expect(proof.shellStatus).toBeNull()
        expect(proof.shellError).toMatch(/ERR_ACCESS_DENIED|EPERM|EACCES/)
        expect(proof.networkCode).toMatch(/EPERM|EACCES/)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it("keeps candidate child source isolated from hidden fixtures", () => {
    const childSource = isolatedRetrieveChildSource()
    expect(childSource).not.toMatch(/contract|owner_fixtures|required_phases/)
    expect(childSource).toContain("retrieveInvocations += 1")
    expect(childSource).toContain("retrieveRuntime.retrieveContext(index")
  })

  it("rejects private roots in a share-safe receipt", () => {
    expect(() =>
      assertShareSafeReceipt(
        { share_safe: true, leaked_path: join(tmpdir(), "private-response") },
        [tmpdir()],
      ),
    ).toThrow(/private absolute path/)
    expect(() =>
      assertShareSafeReceipt(
        { share_safe: true, source_file: "apps/status-page/src/content.ts" },
        [tmpdir()],
      ),
    ).not.toThrow()
  })

  it("rejects inherited preload and parent Node execution flags", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [runnerPath, "--internal-plan", contractPath],
        {
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: "/tmp/madar-preload-path" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ).toThrow(/forbids inherited Node preload/)
    expect(() =>
      execFileSync(
        process.execPath,
        ["--no-warnings", runnerPath, "--internal-plan", contractPath],
        {
          encoding: "utf8",
          env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ).toThrow(/plain Node process with no exec arguments/)
  })

  it("passes exact owner declarations in phase order with an explicit disconnected handoff", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
      })
      expect(grade(harness, result)).toMatchObject({
        authenticated_owner_ids: ["owner.a", "owner.b"],
        owner_order_valid: true,
        required_phase_coverage: 1,
        selected_file_precision: 1,
        handoffs: [{ matched: true, violations: [] }],
        passed: true,
      })
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("requires a selected forward graph path for connected adjacent owner phases", () => {
    const harness = syntheticHarness()
    try {
      const question = connectedQuestion(harness)
      addGraphEdge(harness, "edge:forward", "symbol:a", "symbol:b")
      const nodes = [
        evidenceNode(harness.graph, "symbol:a", harness.sources),
        evidenceNode(harness.graph, "symbol:b", harness.sources),
      ]
      const missing = grade(
        harness,
        finalizedResult({ matched_nodes: nodes }),
        question,
      )
      expect(missing.handoffs[0]).toMatchObject({
        expectation: "connected",
        matched: false,
        violations: ["selected_forward_path_missing"],
      })

      const selected = grade(
        harness,
        finalizedResult({
          matched_nodes: nodes,
          relationships: [relationship(harness.graph, "edge:forward")],
        }),
        question,
      )
      expect(selected.handoffs[0]).toMatchObject({
        expectation: "connected",
        matched: true,
        selected_forward_path_relationship_ids: ["edge:forward"],
        violations: [],
      })
      expect(selected.gates.required_handoffs).toBe(true)
      expect(selected.passed).toBe(true)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("rejects a selected reverse-only path for connected owner phases", () => {
    const harness = syntheticHarness()
    try {
      const question = connectedQuestion(harness)
      addGraphEdge(
        harness,
        "edge:reverse-only",
        "symbol:b",
        "symbol:a",
        "calls",
        "owner-b.ts",
      )
      const graded = grade(
        harness,
        finalizedResult({
          matched_nodes: [
            evidenceNode(harness.graph, "symbol:a", harness.sources),
            evidenceNode(harness.graph, "symbol:b", harness.sources),
          ],
          relationships: [relationship(harness.graph, "edge:reverse-only")],
        }),
        question,
      )
      expect(graded.handoffs[0].violations).toEqual([
        "selected_forward_path_missing",
        "selected_reverse_only_path",
      ])
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("rejects a disconnected boundary for an explicitly connected handoff", () => {
    const harness = syntheticHarness()
    try {
      addGraphEdge(harness, "edge:forward", "symbol:a", "symbol:b")
      const graded = grade(
        harness,
        finalizedResult({
          matched_nodes: [
            evidenceNode(harness.graph, "symbol:a", harness.sources),
            evidenceNode(harness.graph, "symbol:b", harness.sources),
          ],
          relationships: [relationship(harness.graph, "edge:forward")],
          boundaries: [
            { kind: "disconnected", subject: "symbol:a -> symbol:b" },
          ],
        }),
        connectedQuestion(harness),
      )
      expect(graded.handoffs[0].violations).toEqual([
        "connected_handoff_reported_disconnected",
      ])
      expect(graded.gates.required_handoffs).toBe(false)
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("counts a structural file on a selected connected path as relevant", () => {
    const harness = syntheticHarness()
    try {
      const question = connectedQuestion(harness)
      addStructuralFile(harness, "file:bridge", "bridge.ts")
      addGraphEdge(harness, "edge:forward", "symbol:a", "symbol:b")
      addGraphEdge(
        harness,
        "edge:a-bridge",
        "file:a",
        "file:bridge",
        "imports_from",
      )
      addGraphEdge(
        harness,
        "edge:bridge-b",
        "file:bridge",
        "file:b",
        "imports_from",
        "bridge.ts",
      )
      const graded = grade(
        harness,
        finalizedResult({
          matched_nodes: [
            evidenceNode(harness.graph, "symbol:a", harness.sources),
            evidenceNode(harness.graph, "file:a", harness.sources),
            evidenceNode(harness.graph, "file:bridge", harness.sources),
            evidenceNode(harness.graph, "file:b", harness.sources),
            evidenceNode(harness.graph, "symbol:b", harness.sources),
          ],
          relationships: [
            relationship(harness.graph, "edge:forward"),
            relationship(harness.graph, "edge:a-bridge"),
            relationship(harness.graph, "edge:bridge-b"),
          ],
        }),
        question,
      )
      expect(
        graded.handoffs[0].selected_structural_support_path_relationship_ids,
      ).toEqual(["edge:a-bridge", "edge:bridge-b"])
      expect(graded.relevant_selected_files).toContain("bridge.ts")
      expect(graded.unrelated_files).not.toContain("bridge.ts")
      expect(graded.passed).toBe(true)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("keeps an authenticated structural file off the connected path unrelated", () => {
    const harness = syntheticHarness()
    try {
      const question = connectedQuestion(harness)
      addStructuralFile(harness, "file:bridge", "bridge.ts")
      addStructuralFile(harness, "file:unrelated", "unrelated.ts")
      addGraphEdge(harness, "edge:forward", "symbol:a", "symbol:b")
      addGraphEdge(
        harness,
        "edge:a-bridge",
        "file:a",
        "file:bridge",
        "imports_from",
      )
      addGraphEdge(
        harness,
        "edge:bridge-b",
        "file:bridge",
        "file:b",
        "imports_from",
        "bridge.ts",
      )
      addGraphEdge(
        harness,
        "edge:unrelated",
        "file:unrelated",
        "file:a",
        "imports_from",
        "unrelated.ts",
      )
      const graded = grade(
        harness,
        finalizedResult({
          matched_nodes: [
            evidenceNode(harness.graph, "symbol:a", harness.sources),
            evidenceNode(harness.graph, "file:a", harness.sources),
            evidenceNode(harness.graph, "file:bridge", harness.sources),
            evidenceNode(harness.graph, "file:b", harness.sources),
            evidenceNode(harness.graph, "symbol:b", harness.sources),
            evidenceNode(harness.graph, "file:unrelated", harness.sources),
          ],
          relationships: [
            relationship(harness.graph, "edge:forward"),
            relationship(harness.graph, "edge:a-bridge"),
            relationship(harness.graph, "edge:bridge-b"),
            relationship(harness.graph, "edge:unrelated"),
          ],
        }),
        question,
      )
      expect(graded.relevant_selected_files).toContain("bridge.ts")
      expect(graded.unrelated_files).toContain("unrelated.ts")
      expect(graded.relevant_selected_files).not.toContain("unrelated.ts")
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: "symbol-to-file imports_from",
      edgeId: "edge:invalid-import",
      from: "symbol:a",
      to: "file:b",
      relationName: "imports_from",
      sourceFile: "owner-a.ts",
      expectedReason: "imports_from_endpoint_kind_invalid",
    },
    {
      name: "cross-file contains",
      edgeId: "edge:invalid-contains",
      from: "file:a",
      to: "symbol:b",
      relationName: "contains",
      sourceFile: "owner-a.ts",
      expectedReason: "contains_cross_file_invalid",
    },
  ])(
    "rejects invalid structural endpoint ontology: $name",
    ({ edgeId, from, to, relationName, sourceFile, expectedReason }) => {
      const harness = syntheticHarness()
      try {
        addGraphEdge(harness, edgeId, from, to, relationName, sourceFile)
        const result = finalizedResult({
          matched_nodes: [
            evidenceNode(harness.graph, from, harness.sources),
            evidenceNode(harness.graph, to, harness.sources),
          ],
          relationships: [relationship(harness.graph, edgeId)],
        })
        const audit = auditPersistedResult(
          result,
          harness.repository,
          harness.context,
          JSON.stringify(result),
        )
        expect(audit.invalid_relationship_facts).toEqual([
          expect.objectContaining({
            relationship_id: edgeId,
            reasons: expect.arrayContaining([expectedReason]),
          }),
        ])
      } finally {
        rmSync(harness.root, { recursive: true, force: true })
      }
    },
  )

  it.each([
    ["schema", { schema: "madar.retrieve.changed" }],
    ["version", { version: 2 }],
  ])("rejects retrieve envelope %s drift", (_name, override) => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult(override)
      expect(() =>
        auditPersistedResult(
          result,
          harness.repository,
          harness.context,
          JSON.stringify(result),
        ),
      ).toThrow(/madar\.retrieve version 1/)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("does not let a tiny wrong symbol in a relevant-looking file cover an owner phase", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:tiny", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [
          { kind: "disconnected", subject: "symbol:tiny -> symbol:b" },
        ],
      })
      const graded = grade(harness, result)
      expect(graded.phases[0]).toMatchObject({
        authenticated_owner_ids: [],
        covered: false,
      })
      expect(graded.selected_file_precision).toBe(1)
      expect(graded.gates.authenticated_owner_sets).toBe(false)
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("does not let structural files cover owner phases", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "file:a", harness.sources),
          evidenceNode(harness.graph, "file:b", harness.sources),
        ],
        relationships: [relationship(harness.graph, "edge:imports")],
        boundaries: [{ kind: "disconnected", subject: "file:a -> file:b" }],
      })
      const graded = grade(harness, result)
      expect(graded.authenticated_owner_ids).toEqual([])
      expect(graded.required_phase_coverage).toBe(0)
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("rejects the right symbol name in the wrong file", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:wrong-file", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [
          { kind: "disconnected", subject: "symbol:wrong-file -> symbol:b" },
        ],
      })
      const graded = grade(harness, result)
      expect(graded.authenticated_owner_ids).toEqual(["owner.b"])
      expect(graded.unrelated_files).toContain("wrong.ts")
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it.each([
    [
      "range",
      (node: JsonObject) => {
        node.declaration_range = range(
          1,
          2,
          1,
          node.declaration_range.end.column,
        )
      },
    ],
    [
      "hash",
      (node: JsonObject) => {
        node.content_hash = "0".repeat(64)
      },
    ],
    [
      "excerpt",
      (node: JsonObject) => {
        node.snippet = `${node.snippet} `
      },
    ],
  ])("rejects a wrong declaration %s", (_name, mutate) => {
    const harness = syntheticHarness()
    try {
      const owner = evidenceNode(harness.graph, "symbol:a", harness.sources)
      mutate(owner)
      const result = finalizedResult({
        matched_nodes: [
          owner,
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
      })
      const graded = grade(harness, result)
      expect(graded.gates.graph_fact_integrity).toBe(false)
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("fails a missing disconnected boundary even when both owners are exact", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
      })
      const graded = grade(harness, result)
      expect(graded.handoffs[0]).toMatchObject({
        matched: false,
        violations: ["required_disconnected_boundary_missing"],
      })
      expect(graded.gates.required_handoffs).toBe(false)
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("fails an invented relationship absent from the graph", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        relationships: [relationship(harness.graph, "edge:invented")],
      })
      const graded = grade(harness, result)
      expect(graded.gates.graph_fact_integrity).toBe(false)
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("fails a reversed edge and reversed disconnected boundary", () => {
    const harness = syntheticHarness()
    try {
      addGraphEdge(
        harness,
        "edge:reversed",
        "symbol:b",
        "symbol:a",
        "calls",
        "owner-b.ts",
      )
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        relationships: [relationship(harness.graph, "edge:reversed")],
        boundaries: [{ kind: "disconnected", subject: "symbol:b -> symbol:a" }],
      })
      const graded = grade(harness, result)
      expect(graded.handoffs[0].violations).toEqual([
        "required_disconnected_boundary_missing",
        "reversed_disconnected_boundary",
        "authoritative_reverse_path_contradicts_directional_handoff",
      ])
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("rejects a hidden authoritative forward path even when the result omits it", () => {
    const harness = syntheticHarness()
    try {
      addGraphEdge(harness, "edge:hidden-forward", "symbol:a", "symbol:b")
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
      })
      const graded = grade(harness, result)
      expect(graded.handoffs[0]).toMatchObject({
        matched: false,
        violations: ["authoritative_forward_path_contradicts_disconnected"],
      })
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("rejects a hidden authoritative reverse path with the correct boundary", () => {
    const harness = syntheticHarness()
    try {
      addGraphEdge(
        harness,
        "edge:hidden-reverse",
        "symbol:b",
        "symbol:a",
        "calls",
        "owner-b.ts",
      )
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
      })
      const graded = grade(harness, result)
      expect(graded.handoffs[0]).toMatchObject({
        matched: false,
        violations: [
          "authoritative_reverse_path_contradicts_directional_handoff",
        ],
      })
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("finds an authoritative disconnected contradiction beyond eight hops", () => {
    const harness = syntheticHarness()
    try {
      let previous = "symbol:a"
      for (let index = 0; index < 9; index += 1) {
        const next = `hop:${index}`
        harness.graph.nodes.set(next, { label: next, node_kind: "constant" })
        addGraphEdge(harness, `edge:hop:${index}`, previous, next)
        previous = next
      }
      addGraphEdge(harness, "edge:hop:final", previous, "symbol:b")
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
      })
      expect(grade(harness, result).handoffs[0].violations).toContain(
        "authoritative_forward_path_contradicts_disconnected",
      )
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("finds an authoritative contradiction after more than 5,000 branches", () => {
    const harness = syntheticHarness()
    try {
      const branchCount = 5_001
      for (let index = 0; index < branchCount; index += 1) {
        const branch = `branch:${index}`
        harness.graph.nodes.set(branch, {
          label: branch,
          node_kind: "constant",
        })
        addGraphEdge(harness, `edge:branch:${index}`, "symbol:a", branch)
      }
      addGraphEdge(
        harness,
        "edge:branch:target",
        `branch:${branchCount - 1}`,
        "symbol:b",
      )
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
      })
      expect(grade(harness, result).handoffs[0].violations).toContain(
        "authoritative_forward_path_contradicts_disconnected",
      )
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("requires owner declarations to appear in contract phase order", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:b", harness.sources),
          evidenceNode(harness.graph, "symbol:a", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
      })
      const graded = grade(harness, result)
      expect(graded.owner_order_valid).toBe(false)
      expect(graded.gates.owner_order).toBe(false)
      expect(graded.passed).toBe(false)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("records an over-cap reported closure count as a valid failing metric", () => {
    const harness = syntheticHarness()
    try {
      const result = finalizedResult({
        matched_nodes: [
          evidenceNode(harness.graph, "symbol:a", harness.sources),
          evidenceNode(harness.graph, "symbol:b", harness.sources),
        ],
        boundaries: [{ kind: "disconnected", subject: "symbol:a -> symbol:b" }],
        metrics: { closure_passes: 2 },
      })
      const graded = grade(harness, result)
      expect(graded.metrics.reported_closure_passes).toBe(2)
      expect(graded.gates.reported_closure_passes).toBe(false)
      expect(graded.passed).toBe(false)

      const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonObject
      // @ts-expect-error -- Ajv's NodeNext declaration shape differs from runtime
      const ajv = new Ajv2020({ allErrors: true, strict: true })
      const validate = ajv.compile(
        schema.$defs.question_result.properties.metrics,
      )
      expect(
        validate(graded.metrics),
        JSON.stringify(validate.errors ?? []),
      ).toBe(true)
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("forbids ranges and snippets on structural file nodes", () => {
    const harness = syntheticHarness()
    try {
      const structural = evidenceNode(harness.graph, "file:a", harness.sources)
      structural.declaration_range = range(1, 1, 1, 2)
      structural.snippet = "e"
      const result = finalizedResult({
        matched_nodes: [
          structural,
          evidenceNode(harness.graph, "symbol:a", harness.sources),
        ],
        relationships: [relationship(harness.graph, "edge:contains-a")],
      })
      const audit = auditPersistedResult(
        result,
        harness.repository,
        harness.context,
        JSON.stringify(result),
      )
      expect(audit.invalid_node_facts[0].reasons).toEqual(
        expect.arrayContaining([
          "structural_declaration_range_forbidden",
          "structural_snippet_forbidden",
        ]),
      )
    } finally {
      rmSync(harness.root, { recursive: true, force: true })
    }
  })

  it("keeps the v2 receipt schema strict and compilable", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonObject
    // @ts-expect-error -- Ajv's NodeNext declaration shape differs from runtime
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    // @ts-expect-error -- ajv-formats has the same runtime/declaration mismatch
    addFormats(ajv)
    expect(() => ajv.compile(schema)).not.toThrow()
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.schema_version.const).toBe(2)
    expect(schema.properties.questions.minItems).toBe(3)
    expect(schema.properties.questions.maxItems).toBe(3)
    expect(schema.$defs.repository_result.properties.build.required).toEqual(
      expect.arrayContaining([
        "source_snapshot_files",
        "source_snapshot_tree_sha256",
        "workspace_config_packages",
        "workspace_config_mapping_sha256",
      ]),
    )
    expect(
      schema.properties.protocol.properties.workspace_config_source.const,
    ).toBe("exact_tracked_local_workspace_packages_no_package_manager")
    expect(schema.properties.protocol.required).toContain(
      "containment_policy_id",
    )
    expect(
      schema.properties.protocol.properties.candidate_generate_command.const,
    ).toEqual(generateCommand)
    expect(() => parseGenerateArgs(generateCommand.slice(3))).not.toThrow()
    expect(schema.properties.protocol.properties).not.toHaveProperty(
      "candidate_filesystem_policy",
    )
    expect(
      schema.$defs.question_result.properties.response.required,
    ).toEqual(
      expect.arrayContaining([
        "sha256",
        "bytes",
        "persisted_bytes_verified",
      ]),
    )
    expect(
      schema.$defs.question_result.properties.response.properties,
    ).not.toHaveProperty("serialized")
    expect(schema.$defs.question_result.required).not.toContain("continuity")
    expect(schema.$defs.question_gates.required).not.toContain(
      "required_continuity",
    )
  })
})
