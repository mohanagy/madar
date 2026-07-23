import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { describe, expect, it } from "vitest"

// Development-only JavaScript is deliberately outside the production build.
// @ts-expect-error -- the evaluator is not part of the published declaration surface
import * as performanceEvaluator from "../../tools/eval/core-reset/evidence-path-performance.mjs"
const {
  buildPerformanceReceipt,
  canonicalJson,
  controlledBuildEnvironment,
  createNpmConfigPair,
  exactHeadSourceAttestation,
  fixtureNodeDefinition,
  nearestRank,
  validateFrozenContract,
  validatePerformanceReceiptSemantics,
} = performanceEvaluator

type JsonObject = Record<string, any>

const contractPath = resolve(
  "tools/eval/core-reset/contracts/evidence-path-performance-v2.json",
)
const schemaPath = resolve(
  "tools/eval/core-reset/schemas/evidence-path-performance-receipt.schema.json",
)
const evaluatorPath = resolve(
  "tools/eval/core-reset/evidence-path-performance.mjs",
)
const contractBytes = readFileSync(contractPath)
const evaluatorSource = readFileSync(evaluatorPath, "utf8")
const contract = JSON.parse(contractBytes.toString("utf8")) as JsonObject
// @ts-expect-error -- Ajv's NodeNext declaration shape differs from its runtime default
const receiptAjv = new Ajv2020({ allErrors: true, strict: true })
// @ts-expect-error -- ajv-formats has the same NodeNext runtime/declaration mismatch
addFormats(receiptAjv)
const validateReceiptSchema = receiptAjv.compile(
  JSON.parse(readFileSync(schemaPath, "utf8")) as JsonObject,
)
const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex")
const sha = "a".repeat(64)

function resultCheck(queryIndex: number): JsonObject {
  const missing = queryIndex === 4
  return {
    query_index: queryIndex,
    outcome: missing ? "missing" : "evidence",
    nodes: missing ? 0 : 2,
    relationships: missing ? 0 : 1,
    boundaries: missing ? 1 : 0,
    selected_files: missing ? 0 : 2,
    snippets: 0,
    closure_passes: missing ? 0 : 1,
    serialized_tokens: missing ? 81 : 300,
    passed: true,
  }
}

function receiptInput(): JsonObject {
  const samples = Array.from({ length: 20 }, (_, invocation) => ({
    invocation,
    elapsed_ms: invocation + 1,
    ...resultCheck(invocation % 5),
  }))
  return {
    generated_at: "2026-07-23T00:00:00.000Z",
    contract,
    contract_path:
      "tools/eval/core-reset/contracts/evidence-path-performance-v2.json",
    contract_sha256: digest(contractBytes),
    evaluator: {
      path: "tools/eval/core-reset/evidence-path-performance.mjs",
      sha256: sha,
      schema_path:
        "tools/eval/core-reset/schemas/evidence-path-performance-receipt.schema.json",
      schema_sha256: sha,
    },
    subject: {
      head_commit: "b".repeat(40),
      head_tree_oid: "c".repeat(40),
      worktree_dirty: false,
      build_source: "detached_standalone_exact_head_clone",
      install_command:
        "node <resolved-npm-cli> ci --offline --ignore-scripts --no-audit --no-fund --userconfig=<isolated-empty-user-config> --globalconfig=<isolated-empty-global-config>",
      clean_command:
        'node --eval \'import { rmSync } from "node:fs"; rmSync("dist", { recursive: true, force: true })\'',
      build_command:
        "node node_modules/typescript/bin/tsc -p tsconfig.build.json",
      build_completed_before_graph_load: true,
      source_files: 130,
      source_tree_sha256: sha,
      build_control_files: [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "tsconfig.build.json",
      ],
      build_controls_sha256: sha,
      dist_sha256: sha,
    },
    environment: {
      ...contract.reference_environment,
      reference: contract.reference_environment,
      reference_match: true,
    },
    fixture: {
      algorithm: contract.generator.algorithm,
      seed: contract.generator.seed,
      component_count: 150,
      nodes_per_component: 100,
      node_count: 15_000,
      edge_count: 30_000,
      authenticated_source_files: 15_000,
      structural_file_nodes: 15_000,
      ranged_file_nodes: 0,
      file_node_snippets: 0,
      graph_serialization: contract.generator.serialization,
      graph_sha256: sha,
      graph_root_normalization: "<fixture-root>",
      source_manifest_sha256: sha,
      source_manifest_encoding: "sorted path NUL sha256 NUL byte-length LF",
    },
    correctness: {
      preflight: Array.from({ length: 5 }, (_, queryIndex) =>
        resultCheck(queryIndex),
      ),
      warmups: Array.from({ length: 3 }, (_, invocation) => ({
        invocation,
        ...resultCheck(invocation),
      })),
    },
    measurements: {
      samples,
      target_ms: 500,
      percentile_method: "nearest-rank",
    },
  }
}

function resignReceipt(receipt: JsonObject): JsonObject {
  const { receipt_sha256: _recorded, ...body } = receipt
  receipt.receipt_sha256 = digest(canonicalJson(body))
  return receipt
}

function expectSchemaValid(receipt: JsonObject): void {
  expect(
    validateReceiptSchema(receipt),
    receiptAjv.errorsText(validateReceiptSchema.errors),
  ).toBe(true)
}

describe("evidence-path performance evaluator", () => {
  it("freezes the v2 structural-file grammar and all approved limits", () => {
    expect(validateFrozenContract(contract)).toBe(contract)
    expect(digest(contractBytes)).toBe(
      "4ddba368f5ef17dc059bd8d41c0549e38d6a5ded42e9448ae31aefd0e35506e4",
    )

    expect(contract.generator).toMatchObject({
      node_count: 15_000,
      edge_count: 30_000,
      node_kind: "file",
      source_text_use: "full-file SHA256 authentication only",
      structural_file_evidence: {
        range: "omitted",
        snippet: "omitted",
      },
    })
    expect(contract).toMatchObject({
      protocol: {
        warmup_invocations: 3,
        measured_invocations: 20,
        closure_pass_max: 1,
        selected_file_max: 12,
        serialized_token_max: 4_000,
        p95_ms_max: 500,
      },
    })
    expect(contract.queries).toHaveLength(5)
    expect(contract.query_expectations).toHaveLength(5)
  })

  it("uses the shipping canonical query-index inspection boundary", () => {
    expect(evaluatorSource).toContain(
      "const queryIndex = runtime.inspectQueryIndex(fixture.graph)",
    )
    expect(evaluatorSource).toMatch(/queryIndex\.state === ["']ready["']/)
    expect(evaluatorSource).not.toMatch(
      /const queryIndex = \{\s*state: ['"]ready['"]/,
    )
  })

  it("rejects an ignored source file that is absent from exact HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "madar-performance-source-"))
    try {
      mkdirSync(join(root, "src"), { recursive: true })
      writeFileSync(join(root, ".gitignore"), "src/injected.ts\n", "utf8")
      writeFileSync(
        join(root, "src", "base.ts"),
        "export const base = true\n",
        "utf8",
      )
      execFileSync("git", ["init", "--quiet"], { cwd: root })
      execFileSync("git", ["add", ".gitignore", "src/base.ts"], { cwd: root })
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Madar",
          "-c",
          "user.email=madar@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: root },
      )

      expect(exactHeadSourceAttestation(root)).toMatchObject({
        source_files: 1,
      })
      const trackedBlob = execFileSync(
        "git",
        ["rev-parse", "HEAD:src/base.ts"],
        {
          cwd: root,
          encoding: "utf8",
        },
      ).trim()
      const replacementBlob = execFileSync(
        "git",
        ["hash-object", "-w", "--stdin"],
        {
          cwd: root,
          encoding: "utf8",
          input: "export const replaced = true\n",
        },
      ).trim()
      execFileSync("git", ["replace", trackedBlob, replacementBlob], {
        cwd: root,
      })
      expect(exactHeadSourceAttestation(root)).toMatchObject({
        source_files: 1,
      })
      writeFileSync(
        join(root, "src", "injected.ts"),
        "export const injected = true\n",
        "utf8",
      )
      expect(() => exactHeadSourceAttestation(root)).toThrow(
        "performance source inventory differs from exact HEAD",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("scrubs preload, repository, npm, and Madar build overrides", () => {
    const environment = controlledBuildEnvironment({
      PATH: "/trusted/bin",
      NODE_OPTIONS: "--import=/tmp/injected.mjs",
      node_path: "/tmp/modules",
      GIT_CONFIG_COUNT: "1",
      MADAR_GRAPH_PATH: "/tmp/graph.json",
      npm_config_script_shell: "/tmp/shell",
      SAFE_VALUE: "kept",
    })

    expect(environment).toMatchObject({
      PATH: "/trusted/bin",
      SAFE_VALUE: "kept",
      CI: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      NPM_CONFIG_OFFLINE: "true",
    })
    expect(environment).not.toHaveProperty("NODE_OPTIONS")
    expect(environment).not.toHaveProperty("node_path")
    expect(environment).not.toHaveProperty("GIT_CONFIG_COUNT")
    expect(environment).not.toHaveProperty("MADAR_GRAPH_PATH")
    expect(environment).not.toHaveProperty("npm_config_script_shell")
  })

  it("uses distinct empty npm user and global config files", () => {
    const root = mkdtempSync(join(tmpdir(), "madar-performance-npm-config-"))
    try {
      const configs = createNpmConfigPair(root)
      expect(configs.userConfig).not.toBe(configs.globalConfig)
      expect(readFileSync(configs.userConfig, "utf8")).toBe("")
      expect(readFileSync(configs.globalConfig, "utf8")).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("never gives a synthetic structural file a range or snippet", () => {
    const first = fixtureNodeDefinition(contract, 7, 0)
    expect(first).toMatchObject({
      id: "n00700",
      label: "flow007route00",
      sourceFile: "src/fixture/flow-007/node-00.ts",
      source: "export {}; // authenticated synthetic source 007:route:00\n",
    })
    expect(first).not.toHaveProperty("sourceLocation")
    expect(first).not.toHaveProperty("lineNumber")
    expect(first).not.toHaveProperty("endLineNumber")
    expect(first).not.toHaveProperty("snippet")

    const last = fixtureNodeDefinition(contract, 128, 99)
    expect(last).toMatchObject({
      id: "n12899",
      label: "flow128storage99",
      sourceFile: "src/fixture/flow-128/node-99.ts",
    })
    expect(last).not.toHaveProperty("snippet")
  })

  it("uses nearest-rank p95 over exactly twenty samples", () => {
    expect(
      nearestRank(
        Array.from({ length: 20 }, (_, index) => index + 1),
        95,
      ),
    ).toBe(19)
  })

  it("writes schema-valid receipts with only measured p95 and environment gates", () => {
    const accepted = buildPerformanceReceipt(receiptInput())
    expectSchemaValid(accepted)
    expect(validatePerformanceReceiptSemantics(accepted)).toBe(true)
    expect(accepted).toMatchObject({
      benchmark_passed: true,
      eligible_for_acceptance: true,
      failures: [],
      gates: {
        reference_environment: { pass: true },
        warm_retrieval_p95: {
          actual_ms: 19,
          maximum_ms: 500,
          comparison: "strictly_less_than",
          pass: true,
        },
      },
      measurements: { p95_ms: 19 },
    })

    const nonReferenceInput = receiptInput()
    nonReferenceInput.environment.node = "v0.0.0"
    const diagnostic = buildPerformanceReceipt(nonReferenceInput)
    expectSchemaValid(diagnostic)
    expect(validatePerformanceReceiptSemantics(diagnostic)).toBe(true)
    expect(diagnostic).toMatchObject({
      benchmark_passed: true,
      eligible_for_acceptance: false,
      environment: { reference_match: false },
      failures: ["reference_environment"],
      gates: {
        reference_environment: { pass: false },
        warm_retrieval_p95: { pass: true },
      },
    })

    const slowInput = receiptInput()
    slowInput.measurements.samples[18].elapsed_ms = 501
    slowInput.measurements.samples[19].elapsed_ms = 600
    const slow = buildPerformanceReceipt(slowInput)
    expectSchemaValid(slow)
    expect(validatePerformanceReceiptSemantics(slow)).toBe(true)
    expect(slow).toMatchObject({
      benchmark_passed: false,
      eligible_for_acceptance: false,
      failures: ["warm_retrieval_p95"],
      measurements: { p95_ms: 501 },
      gates: {
        reference_environment: { pass: true },
        warm_retrieval_p95: { actual_ms: 501, pass: false },
      },
    })
  })

  it("rejects forged derived outcomes even with a valid schema and self-hash", () => {
    const cases: Array<[(receipt: JsonObject) => void, RegExp]> = [
      [
        (receipt) => {
          receipt.measurements.p95_ms = 0
        },
        /p95 must be derived/,
      ],
      [
        (receipt) => {
          receipt.gates.warm_retrieval_p95.pass = false
        },
        /gates must match derived/,
      ],
      [
        (receipt) => {
          receipt.benchmark_passed = false
        },
        /benchmark_passed must match/,
      ],
      [
        (receipt) => {
          receipt.eligible_for_acceptance = false
        },
        /eligibility must match/,
      ],
      [
        (receipt) => {
          receipt.failures = ["reference_environment"]
        },
        /failures must match/,
      ],
    ]

    for (const [mutate, error] of cases) {
      const forged = buildPerformanceReceipt(receiptInput())
      mutate(forged)
      resignReceipt(forged)
      expectSchemaValid(forged)
      expect(() => validatePerformanceReceiptSemantics(forged)).toThrow(error)
    }
  })
})
