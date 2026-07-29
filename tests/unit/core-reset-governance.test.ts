import { execFileSync } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import ts from 'typescript'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Development-only JavaScript is deliberately outside the production TypeScript build.
// @ts-expect-error -- the isolated evaluator does not ship declarations in the npm package
import * as isolationSupport from '../../tools/eval/core-reset/isolation-support.mjs'

const { packageContentLeaks, productionSourceDelta, sourceInventory } = isolationSupport

const read = (path: string): string => readFileSync(resolve(path), 'utf8')
const git = process.platform === 'win32' ? 'git.exe' : 'git'
const INCREMENTAL_BASE = '8886a0299ee30765ce149ca7ad5d1779496b78b5'
const INCREMENTAL_IMPLEMENTATION = '1be24dc45a5f07c352c74fc374feb95a9440df8e'
const INCREMENTAL_MERGE = 'b56966c06c0ae1b04c252f297036f332fa1b384c'
const INCREMENTAL_CI_HEAD = '3f40c5b64cdd63054c52ed67588b782034f8b935'
const INCREMENTAL_CI_RUN = 'https://github.com/mohanagy/madar/actions/runs/29942216697'
const INCREMENTAL_REVIEW_RECEIPT = 'https://github.com/mohanagy/madar/pull/594#issuecomment-5049404550'
const INCREMENTAL_MUTATION_RECEIPT = 'docs/core-reset/evidence/generation-mutation-equivalence.json'
const INCREMENTAL_MUTATION_RECEIPT_SHA256 = '831bce005c0e9cb28f768a2c490e1923e8062344fd2fd9710be5376e5603f67d'
const INCREMENTAL_FINAL_TREE = '0cead2d3488dac136affa4bec047f8b5f11418a3'
const STOPPED_INCREMENTAL_CANDIDATE = '1d3c9b6d264a5c76d212b93da7c63718cbe49b3d'
const STOPPED_INCREMENTAL_TREE = '6bd1ae5762afaa868d5cf6ce165b061aa290bfda'
const EVIDENCE_BASE = 'bce4f4fb1520a582bfedf5eab9133e9befbc79f7'
const EVIDENCE_BASE_TREE = '7ac3c1ef990ee628ca5c9a215ae6388c82dabcd3'
const EVIDENCE_IMPLEMENTATION = '29aba7ebffe14d6a70bde78df1490bf4cded64a4'
const EVIDENCE_MERGE = '596d286cdf4bb53670a6d8c27b2cec5f86137739'
const EVIDENCE_FINAL_HEAD = 'a0ef9003b9bb71a8defb3463ee131e677b32fecc'
const EVIDENCE_FINAL_TREE = '146aaaaffd94404cf3b544f3613a26472886de0c'
const EVIDENCE_CI_RUN = 'https://github.com/mohanagy/madar/actions/runs/30124465700'
const EVIDENCE_REVIEW_RECEIPT =
  'https://github.com/mohanagy/madar/pull/600#issuecomment-5074482136'
const EVIDENCE_ISSUE = 'https://github.com/mohanagy/madar/issues/596'
const EVIDENCE_OWNER_APPROVAL = `${EVIDENCE_ISSUE}#issuecomment-5050888977`
const EVIDENCE_RFC_AMENDMENT = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5050889198'
const EVIDENCE_PERFORMANCE_AMENDMENT = `${EVIDENCE_ISSUE}#issuecomment-5051857404`
const EVIDENCE_PERFORMANCE_RFC_AMENDMENT = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5051857542'
const EVIDENCE_SOURCE_AMENDMENT = `${EVIDENCE_ISSUE}#issuecomment-5052210144`
const EVIDENCE_SOURCE_RFC_AMENDMENT = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5052210334'
const EVIDENCE_SOURCE_OWNER_APPROVAL = `${EVIDENCE_ISSUE}#issuecomment-5054853667`
const EVIDENCE_SOURCE_RFC_APPROVAL = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5054853815'
const EVIDENCE_V2_PROPOSAL = `${EVIDENCE_ISSUE}#issuecomment-5056946202`
const EVIDENCE_V2_OWNER_APPROVAL = `${EVIDENCE_ISSUE}#issuecomment-5058567870`
const EVIDENCE_V2_RFC_PROPOSAL = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5056947999'
const EVIDENCE_V2_RFC_APPROVAL = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5058568992'
const EVIDENCE_GENERATION_PREREQUISITE = 'https://github.com/mohanagy/madar/issues/599'
const EVIDENCE_GENERATION_OWNER_APPROVAL =
  `${EVIDENCE_GENERATION_PREREQUISITE}#issuecomment-5060766685`
const EVIDENCE_GENERATION_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5060766863'
const EVIDENCE_FINALIZER_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/599#issuecomment-5061269139'
const EVIDENCE_FINALIZER_OWNER_APPROVAL =
  'https://github.com/mohanagy/madar/issues/599#issuecomment-5061378036'
const EVIDENCE_FINALIZER_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5061380711'
const EVIDENCE_COMBINED_PROPOSAL_599 =
  'https://github.com/mohanagy/madar/issues/599#issuecomment-5062823249'
const EVIDENCE_COMBINED_PROPOSAL_596 =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5062823215'
const EVIDENCE_COMBINED_RFC_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5062823238'
const EVIDENCE_COMBINED_APPROVAL_599 =
  'https://github.com/mohanagy/madar/issues/599#issuecomment-5062879476'
const EVIDENCE_COMBINED_APPROVAL_596 =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5062879444'
const EVIDENCE_COMBINED_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5062879430'
const EVIDENCE_OBLIGATION_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5064590915'
const EVIDENCE_OBLIGATION_RFC_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5064592884'
const EVIDENCE_OBLIGATION_OWNER_APPROVAL =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5065202635'
const EVIDENCE_OBLIGATION_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5065202781'
const EVIDENCE_DARWIN_PATH_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5066594490'
const EVIDENCE_DARWIN_PATH_RFC_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5066600460'
const EVIDENCE_DARWIN_PATH_OWNER_APPROVAL =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5066655931'
const EVIDENCE_DARWIN_PATH_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5066657672'
const EVIDENCE_PORTABILITY_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5072454599'
const EVIDENCE_PORTABILITY_RFC_PROPOSAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5072454807'
const EVIDENCE_PORTABILITY_OWNER_APPROVAL =
  'https://github.com/mohanagy/madar/issues/596#issuecomment-5072486888'
const EVIDENCE_PORTABILITY_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5072487113'
const EVIDENCE_HELDOUT_EVALUATOR = 'tools/eval/core-reset/evidence-path-held-out.mjs'
const EVIDENCE_HELDOUT_RECEIPT_SCHEMA =
  'tools/eval/core-reset/schemas/evidence-path-held-out-receipt.schema.json'
const EVIDENCE_HELDOUT_RECEIPT = 'docs/core-reset/evidence/evidence-path-held-out.json'
const EVIDENCE_PERFORMANCE_DESCRIPTOR = 'tools/eval/core-reset/contracts/evidence-path-performance-v2.json'
const EVIDENCE_PERFORMANCE_DESCRIPTOR_SHA256 = '4ddba368f5ef17dc059bd8d41c0549e38d6a5ded42e9448ae31aefd0e35506e4'
const EVIDENCE_PERFORMANCE_EVALUATOR = 'tools/eval/core-reset/evidence-path-performance.mjs'
const EVIDENCE_PERFORMANCE_EVALUATOR_SHA256 = '6029ab84baa42eeed7abd7df98a8d570f001ddbc349c7a2aee1a28f3ec96893f'
const EVIDENCE_PERFORMANCE_RECEIPT_SCHEMA =
  'tools/eval/core-reset/schemas/evidence-path-performance-receipt.schema.json'
const EVIDENCE_PERFORMANCE_RECEIPT_SCHEMA_SHA256 =
  '6c178889c9e2a7b27318145ac49645e3fdb6ea1a907990fff7215d2c32225ce6'
const EVIDENCE_PERFORMANCE_RECEIPT = 'docs/core-reset/evidence/evidence-path-performance.json'
const EVIDENCE_INVENTORY_RECEIPT = 'docs/core-reset/evidence/evidence-path-inventory.json'
const EVIDENCE_INVENTORY_RECEIPT_SHA256 =
  'c027cd1bd79cafdaa65a3f96ec6c359e57e5f567666c6eb25f28bab7014466e4'
const EVIDENCE_IMPORTER_RECEIPT = 'docs/core-reset/evidence/evidence-path-importer-closure.json'
const EVIDENCE_IMPORTER_RECEIPT_SHA256 = '466d48749f2502b5c91dab44cc62ef7a9d91c6b53226ca09ce7846b5dc5be334'
const THIN_DELIVERY_BASE = '8efe41fc665fcea7e625dda0864a72ecf27a111b'
const THIN_DELIVERY_BASE_TREE = '16a942da72c1a24ebe3f420437abec88771c1242'
const THIN_DELIVERY_IMPLEMENTATION_START = 'edcf3e45b8c8fb76a57531bc74bede2a06189aba'
const THIN_DELIVERY_IMPLEMENTATION_START_TREE = 'b980dae663b780cffbe1d989c01afc27a341c707'
const THIN_DELIVERY_MERGE = '14791cefa195f43e30ec9ec2dd611e38ad2b1b83'
const THIN_DELIVERY_FINAL_HEAD = 'ddd9761b137ef1f07eb362a91f9f2478c1d08c38'
const THIN_DELIVERY_FINAL_TREE = '02a059c66a214fe52e31d8fffa2c501a1761bf0f'
const THIN_DELIVERY_CI_RUN = 'https://github.com/mohanagy/madar/actions/runs/30154480779'
const THIN_DELIVERY_REVIEW_RECEIPT =
  'https://github.com/mohanagy/madar/pull/604#pullrequestreview-4779114409'
const THIN_DELIVERY_CODERABBIT_RECEIPT =
  'https://github.com/mohanagy/madar/pull/604#issuecomment-5078118509'
const THIN_DELIVERY_MERGE_GATE_RECEIPT =
  'https://github.com/mohanagy/madar/pull/604#issuecomment-5078171793'
const THIN_DELIVERY_HELD_OUT_RECEIPT_SHA256 =
  '6baed3cfc2b3aa963581613be6cf17ccf1aa261dd29343e27bfe87d52bdaad6c'
const THIN_DELIVERY_ISSUE = 'https://github.com/mohanagy/madar/issues/602'
const THIN_DELIVERY_ABSORBED_ISSUE = 'https://github.com/mohanagy/madar/issues/567'
const THIN_DELIVERY_OWNER_APPROVAL = `${THIN_DELIVERY_ISSUE}#issuecomment-5075969972`
const THIN_DELIVERY_RFC_APPROVAL = 'https://github.com/mohanagy/madar/issues/577#issuecomment-5075969871'
const THIN_DELIVERY_ISSUE_COMPLETION =
  'https://github.com/mohanagy/madar/issues/602#issuecomment-5078180041'
const THIN_DELIVERY_RFC_COMPLETION =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5078180116'
const THIN_DELIVERY_BIN = 'dist/src/adapters/cli/bin.js'
const THIN_DELIVERY_HISTORICAL_BIN = 'dist/src/cli/bin.js'
const THIN_DELIVERY_HISTORICAL_EVALUATOR_SHA256 =
  'b7211c7e56360921a6b8e681ac84b21a1f13963f78a925589ea8611ee25bab97'
const THIN_DELIVERY_REPINNED_EVALUATOR_SHA256 =
  '7f8934d871c27f18bcb86e26fd2462dc87645e8a2850dc3ef68856ee97675928'
const THIN_DELIVERY_HISTORICAL_RECEIPT_SCHEMA_SHA256 =
  '2f3bb3ef0061f515eadbf4bc462af8ddef15a790892630553a069d4510a87714'
const THIN_DELIVERY_DUAL_PATH_RECEIPT_SCHEMA_SHA256 =
  '1f27acfaf452c731e861435b72c4eea76cd1aec990806059fa2da2d8ae9fbcaf'
const THIN_DELIVERY_BASE_NPM_PACKED_BYTES = 231_524
const THIN_DELIVERY_CLIENT_RECEIPT =
  'docs/core-reset/evidence/thin-delivery-client-transport.json'
const THIN_DELIVERY_FINAL_CLIENT_ISSUE_RECEIPT =
  'https://github.com/mohanagy/madar/issues/602#issuecomment-5077981356'
const THIN_DELIVERY_FINAL_CLIENT_RFC_RECEIPT =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5077981401'
const THIN_DELIVERY_NEO4J_LOCK_CLOSURE = [
  'node_modules/base64-js',
  'node_modules/buffer',
  'node_modules/ieee754',
  'node_modules/neo4j-driver',
  'node_modules/neo4j-driver-bolt-connection',
  'node_modules/neo4j-driver-core',
  'node_modules/rxjs',
  'node_modules/safe-buffer',
  'node_modules/string_decoder',
] as const
const THIN_DELIVERY_PREDECESSORS = [
  'src/cli/bin.ts',
  'src/cli/main.ts',
  'src/cli/parser.ts',
  'src/runtime/stdio-server.ts',
  'src/runtime/stdio/definitions.ts',
  'src/runtime/stdio/resources.ts',
  'src/runtime/stdio/tools.ts',
  'src/infrastructure/install.ts',
  'src/shared/env.ts',
  'src/infrastructure/doctor.ts',
  'src/infrastructure/neo4j.ts',
  'src/infrastructure/hooks.ts',
  'src/infrastructure/install-routing-guidance.ts',
  'src/infrastructure/install-skill-templates.ts',
  'src/shared/telemetry.ts',
  'src/shared/update-notifier.ts',
] as const
const THIN_DELIVERY_ABSORBED_PREDECESSORS = THIN_DELIVERY_PREDECESSORS.slice(10)
const THIN_DELIVERY_REPLACEMENTS = [
  'src/adapters/cli/bin.ts',
  'src/adapters/cli/main.ts',
  'src/adapters/cli/install.ts',
  'src/adapters/cli/doctor.ts',
  'src/adapters/mcp/protocol.ts',
  'src/adapters/mcp/server.ts',
] as const
const THIN_DELIVERY_EVALUATION_TRANSFERS = [
  'src/shared/package-metadata.ts',
  'src/shared/shell.ts',
] as const
const THIN_DELIVERY_ABSORBED_HANDLES = [
  'non-core-graph-products',
  'activation-and-extra-integrations',
] as const
const EVALUATION_TOOLING_BASE = '317dda89f2ea5c75e7626a26b104ceca1bd04ce5'
const EVALUATION_TOOLING_BASE_TREE = 'd23753870a2d91d036d2b3663560ffbf260392a8'
const EVALUATION_TOOLING_SRC_TREE = 'b99217c74f6b26daef4ecab12e1cde5f8fe60122'
const EVALUATION_TOOLING_ACTIVATION_MERGE = '452ad84890c012392c5e6af613e8bfeb17de45db'
const EVALUATION_TOOLING_ACTIVATION_TREE = 'ad282a07d772ed5ac942101c55ad53ac77a0252a'
const EVALUATION_TOOLING_MERGE = '565c42bb1b34b67f7fefc7aabd0513e4e391a13b'
const EVALUATION_TOOLING_FINAL_HEAD = 'c0496413518382ca6dff74fa5c81ab72b9edd57c'
const EVALUATION_TOOLING_FINAL_TREE = '225f446ee88ecc74a3226bd17c362458c2312528'
const EVALUATION_TOOLING_CI_RUN =
  'https://github.com/mohanagy/madar/actions/runs/30162721277'
const EVALUATION_TOOLING_REVIEW_RECEIPT =
  'https://github.com/mohanagy/madar/pull/608#pullrequestreview-4779465252'
const EVALUATION_TOOLING_CODERABBIT_RECEIPT =
  'https://github.com/mohanagy/madar/pull/608#issuecomment-5078954363'
const EVALUATION_TOOLING_MERGE_GATE_RECEIPT =
  'https://github.com/mohanagy/madar/pull/608#issuecomment-5078992331'
const EVALUATION_TOOLING_ISSUE_MERGE_RECEIPT =
  'https://github.com/mohanagy/madar/issues/606#issuecomment-5078995452'
const EVALUATION_TOOLING_RFC_MERGE_RECEIPT =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5078995591'
const EVALUATION_TOOLING_ISSUE = 'https://github.com/mohanagy/madar/issues/606'
const EVALUATION_TOOLING_OWNER_APPROVAL =
  `${EVALUATION_TOOLING_ISSUE}#issuecomment-5078675449`
const EVALUATION_TOOLING_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5078676116'
const EVALUATION_TOOLING_PREDECESSORS = [
  'src/infrastructure/benchmark.ts',
  'src/infrastructure/benchmark/corpus.ts',
  'src/infrastructure/benchmark/environment.ts',
  'src/infrastructure/benchmark/generate-performance.ts',
  'src/infrastructure/benchmark/quality.ts',
  'src/infrastructure/benchmark/questions.ts',
  'src/infrastructure/benchmark/runner.ts',
  'src/infrastructure/benchmark/runtime-proof.ts',
  'src/infrastructure/benchmark/suite.ts',
  'src/infrastructure/benchmark/usage.ts',
  'src/infrastructure/compare.ts',
  'src/infrastructure/prompt-runner.ts',
  'src/infrastructure/save-query-result.ts',
  'src/infrastructure/try-command.ts',
  'src/runtime/benchmark/probe-calibration.ts',
  'src/shared/graph-source-root.ts',
  'src/shared/package-metadata.ts',
  'src/shared/share-safe-artifacts.ts',
  'src/shared/shell.ts',
  'src/shared/workspace-copy.ts',
] as const
const EVALUATION_TOOLING_TRANSFERS = [
  'src/shared/graph-source-root.ts',
  'src/shared/workspace-copy.ts',
  'src/shared/package-metadata.ts',
  'src/shared/shell.ts',
] as const
const EVALUATION_TOOLING_DEVELOPMENT_CALLERS = [
  '.github/scripts/ci-eval-regression.mjs',
  'docs/benchmarks/2026-05-11-spi-vs-legacy/probe.mjs',
  'docs/benchmarks/performance/run.mjs',
  'docs/benchmarks/suite/isolation/run-isolated.sh',
  'tools/eval/core-reset/benchmark-suite.mjs',
] as const
const EVALUATION_TOOLING_DEVELOPMENT_CALLER_TARGETS = {
  '.github/scripts/ci-eval-regression.mjs':
    'dist-eval/tools/eval/lib/infrastructure/benchmark/questions.js',
  'docs/benchmarks/2026-05-11-spi-vs-legacy/probe.mjs':
    'dist-eval/tools/eval/lib/runtime/benchmark/probe-calibration.js',
  'docs/benchmarks/performance/run.mjs':
    'dist-eval/tools/eval/lib/infrastructure/benchmark/generate-performance.js',
  'docs/benchmarks/suite/isolation/run-isolated.sh':
    'dist-eval/tools/eval/lib/infrastructure/benchmark/suite.js',
  'tools/eval/core-reset/benchmark-suite.mjs':
    'dist-eval/tools/eval/lib/infrastructure/benchmark/suite.js',
} as const
const EVALUATION_TOOLING_DIRECT_TESTS = [
  'tests/unit/benchmark-environment.test.ts',
  'tests/unit/benchmark-probe-calibration.test.ts',
  'tests/unit/benchmark-quality.test.ts',
  'tests/unit/benchmark-runtime-proof.test.ts',
  'tests/unit/benchmark-suite-isolation-docs.test.ts',
  'tests/unit/benchmark-suite.test.ts',
  'tests/unit/benchmark.test.ts',
  'tests/unit/compare.test.ts',
  'tests/unit/prompt-runner.test.ts',
  'tests/unit/save-query-result.test.ts',
  'tests/unit/share-safe-artifacts.test.ts',
  'tests/unit/shell.test.ts',
  'tests/unit/try-command.test.ts',
  'tests/unit/workspace-copy.test.ts',
] as const
const EVALUATION_TOOLING_ACTIVATION_FILES = [
  'docs/core-reset/removal-manifest.yml',
  'docs/core-reset/scorecard.md',
  'docs/designs/2026-07-19-core-reset.md',
  'docs/roadmap.md',
  'tests/unit/core-reset-governance.test.ts',
] as const
const CAPABILITY_VALIDATION_BASE = 'e7b3be547bc3f6cfdefdd514f17a1ad229afea03'
const CAPABILITY_VALIDATION_BASE_TREE = '0fb5664ab85ecb04275f6277ee65270b948f8ab3'
const CAPABILITY_VALIDATION_SRC_TREE = '1a37e3a58ee7b2a75ca034112506590f699b3918'
const CAPABILITY_VALIDATION_TOOLS_EVAL_TREE = '983df4a5462ae8e5f57cf549bcc23c06c328b596'
const CAPABILITY_VALIDATION_PROPOSAL_SHA256 =
  '27c04eca61e8c3ae65e2a9eab5c0b7e269313be933cef785b94e9bdca7292ba5'
const CAPABILITY_VALIDATION_ISSUE = 'https://github.com/mohanagy/madar/issues/610'
const CAPABILITY_VALIDATION_PROPOSAL_RECEIPT =
  `${CAPABILITY_VALIDATION_ISSUE}#issuecomment-5080113972`
const CAPABILITY_VALIDATION_RFC_PROPOSAL_RECEIPT =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5080113127'
const CAPABILITY_VALIDATION_OWNER_APPROVAL =
  `${CAPABILITY_VALIDATION_ISSUE}#issuecomment-5081132612`
const CAPABILITY_VALIDATION_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5081133199'
const CAPABILITY_VALIDATION_CONTRACT =
  'tools/eval/core-reset/contracts/capability-validation-v1.json'
const CAPABILITY_VALIDATION_CONTRACT_SCHEMA =
  'tools/eval/core-reset/schemas/capability-validation-contract.schema.json'
const CAPABILITY_VALIDATION_RECEIPT_SCHEMA =
  'tools/eval/core-reset/schemas/capability-validation-receipt.schema.json'
const CAPABILITY_VALIDATION_FROZEN_HASHES = {
  'tools/eval/core-reset/contracts/evaluation-contract.json':
    'c22819a9e24e53f7b11a69c06511a8dc0c2cba8841868d8d9bb734575290bba9',
  'tools/eval/core-reset/schemas/evaluation-contract.schema.json':
    '581acc2332cbe9015e0bd1c7da4db84e9c3d5c73cedcb21fd7427a67bf56e615',
  'tools/eval/core-reset/contract-validation.mjs':
    'd7402f8caaf838d0695060d375c1504e4a173786281730010c7a7eb5449608a0',
  'package.json': 'd464fd8e59b3d4d3f817ebdd6457fb3cfb02d9f3fad4fc8648f29c03a8a56b33',
  'package-lock.json': 'b9d179f0ee70e14d85653c5013cf2513efb22127b10fc3ee1deb5fa698993a61',
  'tsconfig.eval.json': 'b2eb8dea28aab40a794bda38f11100dcc98e8c2987b3d8fdefc62263ebe7ae17',
  '.github/workflows/ci.yml': '4dde28b814127bceabe8e076c2f5afc286153d9f8b655cf5e8a1681f754ac2f8',
} as const
const CAPABILITY_VALIDATION_ASSET_HASHES = {
  [CAPABILITY_VALIDATION_CONTRACT]: 'ae03a6b2cc8675ca66ad0ff67f06e13389cf04e6a6a8167c3404f1c8657f36f5',
  [CAPABILITY_VALIDATION_CONTRACT_SCHEMA]: '6d8679e335730180bee0c9fc62f144ae2086ea16dade800887a0301da27f23b6',
  [CAPABILITY_VALIDATION_RECEIPT_SCHEMA]: 'a33a6b3532a3e0df62bcd0f3616a9585b2be4ede1f360cf3d55f70c99c29f30e',
} as const
const CAPABILITY_VALIDATION_STOP_ISSUE_RECEIPT =
  'https://github.com/mohanagy/madar/issues/610#issuecomment-5083281270'
const CAPABILITY_VALIDATION_STOP_RFC_RECEIPT =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5083282711'
const CAPABILITY_VALIDATION_STOP_BODY_HASHES = {
  issue: '115e88cc3e1e00066c92f6ce4b3dd9ed8e0f6eabc1f8dbad918d1125c5cdaef9',
  rfc: '65ac67ca30f24eb2c9d2741ab12ee42d2f593915220ff1251adb8af97e717ed0',
} as const
const CAPABILITY_VALIDATION_V2_BASE = 'dcb52596a3efa89f9ef5d372231ce97a91ae5f9f'
const CAPABILITY_VALIDATION_V2_BASE_TREE = 'd0ca317290dbd6837295f36f36ded5b49855c0fe'
const CAPABILITY_VALIDATION_V2_ACTIVATION_HEAD = '7c0cff71c512512d534e4d5b011cd27ced5992fe'
const CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE = '5c9d1e2436932f7420169ea4ffa617c6bea4fbd0'
const CAPABILITY_VALIDATION_V2_ACTIVATION_TREE = '35b68cd733e07b9306d52e2076a287269f8919eb'
const CAPABILITY_VALIDATION_V2_SRC_TREE = '1a37e3a58ee7b2a75ca034112506590f699b3918'
const CAPABILITY_VALIDATION_V2_TOOLS_EVAL_TREE = 'b8ef02da3ce135596e87fdf6252441755061d956'
const RETRIEVAL_REGRESSION_ID = 'retrieval-regression-618'
const RETRIEVAL_REGRESSION_FILES = [
  'src/adapters/mcp/protocol.ts',
  'src/domain/query/rank.ts',
  'src/domain/query/slice.ts',
  'src/domain/query/traverse.ts',
] as const
const CAPABILITY_VALIDATION_V2_PROPOSAL_SHA256 =
  '4906405cbb806c850c0612305ef460e023e2060b5338734ae0af12303901cbd0'
const CAPABILITY_VALIDATION_V2_ISSUE = 'https://github.com/mohanagy/madar/issues/612'
const CAPABILITY_VALIDATION_V2_PROPOSAL_RECEIPT =
  `${CAPABILITY_VALIDATION_V2_ISSUE}#issuecomment-5083546156`
const CAPABILITY_VALIDATION_V2_RFC_PROPOSAL_RECEIPT =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5083547611'
const CAPABILITY_VALIDATION_V2_OWNER_APPROVAL =
  `${CAPABILITY_VALIDATION_V2_ISSUE}#issuecomment-5083661878`
const CAPABILITY_VALIDATION_V2_RFC_APPROVAL =
  'https://github.com/mohanagy/madar/issues/577#issuecomment-5083662827'
const CAPABILITY_VALIDATION_V2_CONTRACT =
  'tools/eval/core-reset/contracts/capability-validation-v2.json'
const CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA =
  'tools/eval/core-reset/schemas/capability-validation-contract-v2.schema.json'
const CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA =
  'tools/eval/core-reset/schemas/capability-validation-receipt-v2.schema.json'
const CAPABILITY_VALIDATION_V2_ACTIVATION_FILES = [
  ...EVALUATION_TOOLING_ACTIVATION_FILES,
  CAPABILITY_VALIDATION_V2_CONTRACT,
  CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA,
  CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA,
] as const
const CAPABILITY_VALIDATION_V2_ASSET_HASHES = {
  [CAPABILITY_VALIDATION_V2_CONTRACT]: '21d45642cbac36b0ae99258f6aa1d64480a33a20e0fc7334ffd166989ea0f44c',
  [CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA]:
    'ce6f2b132868d65e92ef958cdd28f39744f8169a21fcd4ef95d666a13ae0ae58',
  [CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA]: '0aa0743837bdb2fa23430807c89d3ae433ee19c64fb0aa20901d53c5306204e2',
} as const
const CAPABILITY_VALIDATION_V2_ASSET_LIMITS: Record<string, { lines: number; bytes: number }> = {
  [CAPABILITY_VALIDATION_V2_CONTRACT]: { lines: 1_400, bytes: 196_608 },
  [CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA]: { lines: 200, bytes: 262_144 },
  [CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA]: { lines: 1_600, bytes: 1_638_400 },
} as const
const CAPABILITY_VALIDATION_V2_ALLOWED_DIFFERENCE_POINTERS = [
  '/schema_version',
  '/contract_id',
  '/status',
  '/governance',
  '/anchors/protected_base_commit',
  '/anchors/base_tree',
  '/anchors/tools_eval_tree',
  '/inheritance',
  '/receipt/path',
  '/receipt/schema_path',
  '/receipt/canonical_transcript',
  '/receipt/canonical_archive',
  '/execution_boundary',
] as const
const EVALUATION_TOOLING_FROZEN_EVIDENCE = [
  'docs/core-reset/evidence/baseline-v0.32.0.json',
  'docs/core-reset/evidence/evidence-path-held-out.json',
  'docs/core-reset/evidence/evidence-path-performance.json',
  'tools/eval/core-reset/contracts/evaluation-contract.json',
  'tools/eval/core-reset/contracts/evidence-path-performance-v2.json',
  'tools/eval/core-reset/schemas/baseline-receipt.schema.json',
  'tools/eval/core-reset/schemas/evaluation-contract.schema.json',
  'tools/eval/core-reset/schemas/evidence-path-held-out-receipt.schema.json',
  'tools/eval/core-reset/schemas/evidence-path-performance-receipt.schema.json',
] as const
type EvidencePerformanceRelationship = {
  from_id: string
  relation: 'imports_from'
  to_id: string
}
type EvidencePerformanceExpectation = {
  query_index: number
  outcome: 'evidence' | 'missing'
  node_ids: string[]
  relationships: EvidencePerformanceRelationship[]
  boundaries: Array<{ kind: string; subject: string }>
}
type EvidencePerformanceDescriptor = {
  schema_version: number
  fixture_id: string
  generator: {
    component_count: number
    nodes_per_component: number
    node_count: number
    edge_count: number
    edges: Array<{
      count_per_component: number
      from: string
      to: string
      relation_rule: 'imports_from'
    }>
    [key: string]: unknown
  }
  protocol: Record<string, unknown>
  queries: string[]
  query_expectations: EvidencePerformanceExpectation[]
  runner: string
  receipt: string
}
const FROZEN_EVIDENCE_HASHES = {
  'tools/eval/core-reset/contracts/evaluation-contract.json': 'c22819a9e24e53f7b11a69c06511a8dc0c2cba8841868d8d9bb734575290bba9',
  'tools/eval/core-reset/schemas/evaluation-contract.schema.json': '581acc2332cbe9015e0bd1c7da4db84e9c3d5c73cedcb21fd7427a67bf56e615',
  'tools/eval/core-reset/evidence-path-held-out.mjs': 'b7211c7e56360921a6b8e681ac84b21a1f13963f78a925589ea8611ee25bab97',
  'tools/eval/core-reset/schemas/evidence-path-held-out-receipt.schema.json':
    '2f3bb3ef0061f515eadbf4bc462af8ddef15a790892630553a069d4510a87714',
  'docs/core-reset/evidence/evidence-path-held-out.json':
    'ebc2755d8406e4433ff5cb76792b7031ea4b95a54120d95b301ab1ac888e2390',
  'docs/core-reset/evidence/evidence-path-performance.json':
    '7adc3734ef4ad462bd36c7c0ed944de1686fdc02b540cc453f232017c0e578e7',
  'docs/core-reset/evidence/evidence-path-inventory.json':
    EVIDENCE_INVENTORY_RECEIPT_SHA256,
  'docs/core-reset/evidence/baseline-v0.32.0.json': 'c2b96e75e64934de998bb5c7087cb604b680cd8fd2aa5c6d1f74cd9f1a0c6516',
  'tools/eval/core-reset/schemas/baseline-receipt.schema.json': '04eeb47a14da18ec90c6e687bbd557d44a3fe5ac493d8d6946f4b3fc4f7f6a59',
} as const
const EVIDENCE_TRANSFERS = [
  'src/core/pipeline/stage.ts',
  'src/runtime/freshness.ts',
  'src/shared/source-discovery.ts',
  'src/runtime/semantic.ts',
  'src/runtime/http-server.ts',
  'src/infrastructure/time-travel.ts',
  'src/runtime/time-travel.ts',
  'src/infrastructure/context-pack-command.ts',
  'src/infrastructure/context-prompt-command.ts',
  'src/infrastructure/context-prompt.ts',
  'src/infrastructure/handoff-command.ts',
  'src/infrastructure/proof-report.ts',
  'src/infrastructure/review-compare.ts',
  'src/pipeline/cluster.ts',
  'src/pipeline/community-details.ts',
  'src/pipeline/community-naming.ts',
  'src/pipeline/analyze.ts',
  'src/pipeline/report.ts',
  'src/pipeline/federate.ts',
  'src/runtime/diff.ts',
  'src/runtime/graph-summary.ts',
  'src/runtime/serve.ts',
] as const
const EVIDENCE_REPLACEMENTS = [
  'src/domain/query/types.ts',
  'src/domain/query/source-domain.ts',
  'src/domain/query/rank.ts',
  'src/domain/query/traverse.ts',
  'src/domain/query/slice.ts',
  'src/domain/query/index-status.ts',
  'src/application/retrieve-context.ts',
] as const
const INCREMENTAL_PREDECESSORS = [
  'src/infrastructure/generate.ts',
  'src/contracts/generation-policy.ts',
  'src/infrastructure/generation-policy.ts',
  'src/contracts/indexing.ts',
  'src/pipeline/indexing-generation.ts',
  'src/pipeline/indexing-outcomes.ts',
  'src/infrastructure/indexing-manifest.ts',
  'src/pipeline/detect.ts',
  'src/pipeline/manifest.ts',
  'src/infrastructure/refresh-lease.ts',
  'src/contracts/watcher-state.ts',
  'src/infrastructure/watcher-state.ts',
  'src/infrastructure/watch.ts',
  'src/infrastructure/background-auto-refresh.ts',
  'src/shared/graph-build-freshness.ts',
] as const
const INCREMENTAL_TRANSFERS = {
  'src/core/pipeline/stage.ts': 'evidence-path-query',
  'src/runtime/freshness.ts': 'evidence-path-query',
  'src/shared/source-discovery.ts': 'evidence-path-query',
  'src/infrastructure/doctor.ts': 'thin-delivery',
} as const
const INCREMENTAL_REPLACEMENTS = [
  'src/application/generate-index.ts',
  'src/application/update-index.ts',
  'src/domain/index/build-state.ts',
  'src/adapters/filesystem/source-catalog.ts',
  'src/adapters/filesystem/index-store.ts',
  'src/infrastructure/watch-index.ts',
] as const
const INCREMENTAL_OWNED_REPLACEMENTS = INCREMENTAL_REPLACEMENTS.filter(
  (path) => path !== 'src/domain/index/build-state.ts',
)

function productionTypeScriptFiles(directory = 'src'): string[] {
  return readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return productionTypeScriptFiles(path)
    return entry.isFile() && path.endsWith('.ts') ? [path] : []
  })
}

const manifestGlob = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`)
}

function deletedProductionFiles(commit: string): string[] {
  const output = execFileSync(
    git,
    ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=D', '-r', `${commit}^`, commit, '--', 'src'],
    { encoding: 'utf8' },
  )
  return output.split('\n').filter((path) => path.endsWith('.ts'))
}

function productionTypeScriptFilesAtCommit(commit: string): string[] {
  const output = execFileSync(git, ['ls-tree', '-r', '--name-only', commit, '--', 'src'], { encoding: 'utf8' })
  return output.split('\n').filter((path) => path.endsWith('.ts'))
}

function logicalLocAtCommit(commit: string, paths: readonly string[]): number {
  return paths.reduce((total, path) => {
    const source = execFileSync(git, ['show', `${commit}:${path}`], { encoding: 'utf8' })
    const lineFeeds = source.match(/\n/g)?.length ?? 0
    return total + lineFeeds + (source.length > 0 && !source.endsWith('\n') ? 1 : 0)
  }, 0)
}

function productionSourceDeltaBetween(
  baselineCommit: string,
  targetCommit: string,
): { added: number; removed: number; net: number } {
  const delta = execFileSync(
    git,
    [
      'diff',
      '--ignore-cr-at-eol',
      '--no-ext-diff',
      '--no-renames',
      '--numstat',
      baselineCommit,
      targetCommit,
      '--',
      'src',
    ],
    { encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean).reduce(
    (total, line) => {
      const [added = '0', removed = '0'] = line.split('\t')
      return {
        added: total.added + Number(added),
        removed: total.removed + Number(removed),
      }
    },
    { added: 0, removed: 0 },
  )
  return { ...delta, net: delta.added - delta.removed }
}

const gitBlobSha256 = (revision: string, path: string): string =>
  createHash('sha256').update(execFileSync(git, ['show', `${revision}:${path}`])).digest('hex')

function importedRelativeTargets(
  importer: string,
  source: string,
  targets: ReadonlySet<string>,
): string[] {
  const sourceFile = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const moduleSpecifiers = new Set<string>()

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      moduleSpecifiers.add(node.moduleSpecifier.text)
    }
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      moduleSpecifiers.add(node.moduleReference.expression.text)
    }
    const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && argument
      && ts.isStringLiteralLike(argument)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      moduleSpecifiers.add(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return [...moduleSpecifiers].flatMap((specifier) => {
    if (!specifier.startsWith('.')) return []
    const unresolved = posix.normalize(posix.join(posix.dirname(importer), specifier))
    const candidates = [
      unresolved,
      unresolved.replace(/\.(?:cjs|js|jsx|mjs)$/, '.ts'),
      `${unresolved}.ts`,
      `${unresolved}/index.ts`,
    ]
    return candidates.find((candidate) => targets.has(candidate)) ?? []
  }).filter((target, index, targets) => targets.indexOf(target) === index).sort()
}

function importedProductionFilesAtCommit(
  commit: string,
  importer: string,
  productionFiles: ReadonlySet<string>,
): string[] {
  const source = execFileSync(git, ['show', `${commit}:${importer}`], { encoding: 'utf8' })
  return importedRelativeTargets(importer, source, productionFiles)
}

function deletionImportEdgesAtCommit(commit: string, deletionFiles: ReadonlySet<string>): {
  all: string[]
  internal: string[]
  surviving: string[]
} {
  const productionFiles = productionTypeScriptFilesAtCommit(commit)
  const productionFileSet = new Set(productionFiles)
  const all = productionFiles.flatMap((importer) =>
    importedProductionFilesAtCommit(commit, importer, productionFileSet)
      .filter((target) => deletionFiles.has(target))
      .map((target) => `${importer}\0${target}`),
  ).filter((edge, index, edges) => edges.indexOf(edge) === index).sort()
  return {
    all,
    internal: all.filter((edge) => deletionFiles.has(edge.slice(0, edge.indexOf('\0')))),
    surviving: all.filter((edge) => !deletionFiles.has(edge.slice(0, edge.indexOf('\0')))),
  }
}

const edgeListSha256 = (edges: readonly string[]): string =>
  createHash('sha256').update(`${edges.join('\n')}\n`).digest('hex')

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

const withoutJsonPointers = (value: unknown, pointers: readonly string[]): unknown => {
  const clone = structuredClone(value)
  for (const pointer of pointers) {
    const segments = pointer.slice(1).split('/').map((segment) =>
      segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    let parent = clone as Record<string, unknown>
    for (const segment of segments.slice(0, -1)) {
      parent = parent[segment] as Record<string, unknown>
    }
    delete parent[segments.at(-1)!]
  }
  return clone
}

const strictJson = (source: string): unknown => {
  const value = JSON.parse(source)
  parse(source) // YAML's JSON-compatible parser rejects duplicate mapping keys that JSON.parse discards.
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      for (let index = 0; index < candidate.length; index += 1) {
        const unit = candidate.charCodeAt(index)
        if (unit >= 0xd800 && unit <= 0xdbff && candidate.charCodeAt(++index) >= 0xdc00
          && candidate.charCodeAt(index) <= 0xdfff) continue
        if (unit >= 0xd800 && unit <= 0xdfff) throw new Error('lone Unicode surrogate')
      }
    } else if (Array.isArray(candidate)) candidate.forEach(visit)
    else if (candidate && typeof candidate === 'object') {
      for (const [key, child] of Object.entries(candidate)) { visit(key); visit(child) }
    }
  }
  visit(value)
  return value
}
const readStrictJson = (path: string): unknown => {
  const bytes = readFileSync(resolve(path))
  if (!isUtf8(bytes)) throw new Error(`${path}: invalid UTF-8`)
  return strictJson(bytes.toString('utf8'))
}

describe('core reset governance', () => {
  it('keeps one linked roadmap and RFC contract', () => {
    const roadmap = read('docs/roadmap.md')
    const design = read('docs/designs/2026-07-19-core-reset.md')
    const scorecard = read('docs/core-reset/scorecard.md')
    const readme = read('README.md')
    const contributing = read('CONTRIBUTING.md')

    expect(roadmap).toContain('# Public roadmap')
    expect(roadmap).toContain('issues/577')
    expect(roadmap).toContain('milestone/7')
    expect(roadmap).toContain('projects/8')
    expect(roadmap).toContain('removal-manifest.yml')
    expect(roadmap).toContain('scorecard.md')
    expect(roadmap).toContain('## Passed — directed multigraph')
    expect(roadmap).toContain('## Passed — canonical TypeScript/JavaScript index')
    expect(roadmap).toContain('## Passed — delete legacy extraction and non-code/other-language ingestion')
    expect(roadmap).toContain('## Passed — generation and reconciliation')
    expect(roadmap).toContain('## Passed — evidence-path query')
    expect(roadmap).toContain('## Passed — thin delivery')
    expect(roadmap).toContain('## Passed — evaluation tooling isolation')
    expect(roadmap).toContain('## Stopped — capability validation')
    expect(roadmap).toContain('## Passed — retrieval regression #618')
    expect(roadmap).toContain('## Ready — `0.40.0-beta.2`')
    expect(roadmap).toContain(CAPABILITY_VALIDATION_PROPOSAL_SHA256)
    expect(roadmap).toContain(CAPABILITY_VALIDATION_OWNER_APPROVAL)
    expect(roadmap).toContain(CAPABILITY_VALIDATION_RFC_APPROVAL)
    expect(roadmap).toContain(CAPABILITY_VALIDATION_BASE)
    expect(roadmap).toContain(CAPABILITY_VALIDATION_V2_PROPOSAL_SHA256)
    expect(roadmap).toContain(CAPABILITY_VALIDATION_V2_OWNER_APPROVAL)
    expect(roadmap).toContain(CAPABILITY_VALIDATION_V2_RFC_APPROVAL)
    expect(roadmap).toContain(CAPABILITY_VALIDATION_V2_BASE)
    expect(roadmap).toContain(EVALUATION_TOOLING_OWNER_APPROVAL)
    expect(roadmap).toContain(EVALUATION_TOOLING_RFC_APPROVAL)
    expect(roadmap).toContain(EVALUATION_TOOLING_BASE)
    expect(roadmap).toContain(EVALUATION_TOOLING_SRC_TREE)
    expect(roadmap).toContain(EVALUATION_TOOLING_MERGE)
    expect(roadmap).toContain(EVALUATION_TOOLING_FINAL_HEAD)
    expect(roadmap).toContain(EVALUATION_TOOLING_FINAL_TREE)
    expect(roadmap).toContain(EVALUATION_TOOLING_CI_RUN)
    expect(roadmap).toContain(EVALUATION_TOOLING_REVIEW_RECEIPT)
    expect(roadmap).toContain(EVALUATION_TOOLING_CODERABBIT_RECEIPT)
    expect(roadmap).toContain(EVALUATION_TOOLING_ISSUE_MERGE_RECEIPT)
    expect(roadmap).toContain(EVALUATION_TOOLING_RFC_MERGE_RECEIPT)
    expect(roadmap).toContain('exactly 20 production TypeScript files / 4,698 LOC')
    expect(roadmap).toContain('Capability Validation remained blocked throughout #606')
    expect(roadmap).toContain(THIN_DELIVERY_OWNER_APPROVAL)
    expect(roadmap).toContain(THIN_DELIVERY_RFC_APPROVAL)
    expect(roadmap).toContain(THIN_DELIVERY_BASE)
    expect(roadmap).toContain('exactly one MCP tool, `retrieve`')
    expect(roadmap).toContain('direct JSON-RPC is insufficient')
    expect(roadmap).toContain(EVIDENCE_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_RFC_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_PERFORMANCE_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_PERFORMANCE_RFC_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_SOURCE_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_SOURCE_RFC_AMENDMENT)
    expect(roadmap).toContain(EVIDENCE_SOURCE_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_SOURCE_RFC_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_V2_PROPOSAL)
    expect(roadmap).toContain(EVIDENCE_V2_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_V2_RFC_PROPOSAL)
    expect(roadmap).toContain(EVIDENCE_V2_RFC_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_GENERATION_PREREQUISITE)
    expect(roadmap).toContain(EVIDENCE_GENERATION_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_GENERATION_RFC_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_COMBINED_APPROVAL_599)
    expect(roadmap).toContain(EVIDENCE_COMBINED_APPROVAL_596)
    expect(roadmap).toContain(EVIDENCE_COMBINED_RFC_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_OBLIGATION_PROPOSAL)
    expect(roadmap).toContain(EVIDENCE_OBLIGATION_RFC_PROPOSAL)
    expect(roadmap).toContain(EVIDENCE_OBLIGATION_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_OBLIGATION_RFC_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_DARWIN_PATH_PROPOSAL)
    expect(roadmap).toContain(EVIDENCE_DARWIN_PATH_RFC_PROPOSAL)
    expect(roadmap).toContain(EVIDENCE_DARWIN_PATH_OWNER_APPROVAL)
    expect(roadmap).toContain(EVIDENCE_DARWIN_PATH_RFC_APPROVAL)
    expect(roadmap).toContain('A file node or unrelated tiny symbol in the correct file cannot cover a phase')
    expect(roadmap).toContain('normalized retrieve request, canonical graph bytes, and identical authenticated source snapshot')
    expect(roadmap).toContain('an empty positive result fails')
    expect(roadmap).toContain('63-file / 33,031-LOC deletion contract with 22 ownership transfers')
    expect(roadmap).toContain('passes held-out-v2')
    expect(roadmap).toContain('passes the [frozen loaded-graph performance gate]')
    expect(roadmap).toContain(EVIDENCE_MERGE)
    expect(roadmap).toContain(EVIDENCE_CI_RUN)
    expect(roadmap).toContain(EVIDENCE_REVIEW_RECEIPT)
    expect(roadmap).toContain('issues/592')
    expect(roadmap).toContain('issues/588')
    expect(roadmap).not.toContain('## Ready — generation and incremental index')
    expect(roadmap).not.toContain('## Ready — evidence-path query')
    expect(roadmap).not.toContain('## In progress — generation and incremental index')
    expect(roadmap).not.toContain('## In progress — canonical TypeScript/JavaScript index')
    expect(roadmap).not.toContain('## In progress — delete legacy extraction and non-code/other-language ingestion')
    expect(roadmap).toContain('## Later')
    expect(roadmap).toContain('accepted Core Reset')
    expect(roadmap).not.toContain('currently **proposed**')
    expect(roadmap).not.toMatch(/^##\s+v?\d+(?:\.\d+)+\b/im)
    expect(roadmap).not.toMatch(/^##\s+Features?\b/im)

    expect(design).toContain('issues/577')
    expect(design).toContain('**Status:** accepted')
    expect(design).toContain('not a permanent V1/V2 split')
    expect(design).toContain('Merging code alone is not completion')
    expect(design).toContain('issues/592')
    expect(design).toContain('No in-memory or disk session cache survives')
    expect(design).toContain('`graph.json` is the sole authoritative index artifact and atomic commit marker')
    expect(design).toContain('three warm-ups and 20 measured trials')
    expect(design).toContain('clean generation may regress by at most 10%')
    expect(design).toContain('Held-out timing was intentionally skipped')
    expect(design).toContain('The failed incremental path was deleted')
    expect(design).toContain('Only successfully indexed `.ts`, `.tsx`, `.js`, and `.jsx` inputs determine supported-index completeness')
    expect(design).toContain('There is no generation directory, persistent fact cache, versioned snapshot store')
    expect(design).toContain('## Completed amendment — generation and reconciliation')
    expect(design).toContain('## Completed amendment — generic evidence-path query')
    expect(design).toContain('## Completed amendment — thin delivery')
    expect(design).toContain('## Completed amendment — evaluation tooling isolation')
    expect(design).toContain('## Stopped amendment — capability validation v1')
    expect(design).toContain('## Historical accepted amendment — capability validation v2')
    expect(design).toContain('## Cancelled amendment — capability validation')
    expect(design).toContain('## Completed amendment — retrieval regression #618')
    expect(design).toContain('## Release amendment — `0.40.0-beta.2` ready')
    expect(design).toContain(CAPABILITY_VALIDATION_PROPOSAL_SHA256)
    expect(design).toContain(CAPABILITY_VALIDATION_OWNER_APPROVAL)
    expect(design).toContain(CAPABILITY_VALIDATION_RFC_APPROVAL)
    expect(design).toContain(CAPABILITY_VALIDATION_BASE)
    expect(design).toContain(CAPABILITY_VALIDATION_V2_PROPOSAL_SHA256)
    expect(design).toContain(CAPABILITY_VALIDATION_V2_OWNER_APPROVAL)
    expect(design).toContain(CAPABILITY_VALIDATION_V2_RFC_APPROVAL)
    expect(design).toContain(CAPABILITY_VALIDATION_V2_BASE)
    expect(design).toContain(EVALUATION_TOOLING_OWNER_APPROVAL)
    expect(design).toContain(EVALUATION_TOOLING_RFC_APPROVAL)
    expect(design).toContain(EVALUATION_TOOLING_BASE)
    expect(design).toContain(EVALUATION_TOOLING_SRC_TREE)
    expect(design).toContain(THIN_DELIVERY_OWNER_APPROVAL)
    expect(design).toContain(THIN_DELIVERY_RFC_APPROVAL)
    expect(design).toContain(THIN_DELIVERY_BASE)
    expect(design).toContain(EVIDENCE_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_RFC_AMENDMENT)
    expect(design).toContain(EVIDENCE_PERFORMANCE_AMENDMENT)
    expect(design).toContain(EVIDENCE_PERFORMANCE_RFC_AMENDMENT)
    expect(design).toContain(EVIDENCE_SOURCE_AMENDMENT)
    expect(design).toContain(EVIDENCE_SOURCE_RFC_AMENDMENT)
    expect(design).toContain(EVIDENCE_SOURCE_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_SOURCE_RFC_APPROVAL)
    expect(design).toContain(EVIDENCE_V2_PROPOSAL)
    expect(design).toContain(EVIDENCE_V2_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_V2_RFC_PROPOSAL)
    expect(design).toContain(EVIDENCE_V2_RFC_APPROVAL)
    expect(design).toContain(EVIDENCE_GENERATION_PREREQUISITE)
    expect(design).toContain(EVIDENCE_GENERATION_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_GENERATION_RFC_APPROVAL)
    expect(design).toContain(EVIDENCE_COMBINED_APPROVAL_599)
    expect(design).toContain(EVIDENCE_COMBINED_APPROVAL_596)
    expect(design).toContain(EVIDENCE_COMBINED_RFC_APPROVAL)
    expect(design).toContain(EVIDENCE_OBLIGATION_PROPOSAL)
    expect(design).toContain(EVIDENCE_OBLIGATION_RFC_PROPOSAL)
    expect(design).toContain(EVIDENCE_OBLIGATION_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_OBLIGATION_RFC_APPROVAL)
    expect(design).toContain(EVIDENCE_DARWIN_PATH_PROPOSAL)
    expect(design).toContain(EVIDENCE_DARWIN_PATH_RFC_PROPOSAL)
    expect(design).toContain(EVIDENCE_DARWIN_PATH_OWNER_APPROVAL)
    expect(design).toContain(EVIDENCE_DARWIN_PATH_RFC_APPROVAL)
    expect(design).toContain('The completed deletion-led query finishes')
    expect(design).toContain('The complete UTF-8 source must hash to the canonical file-node `content_hash`')
    expect(design).toContain('Identical normalized request plus identical canonical graph bytes plus the identical authenticated source snapshot')
    expect(design).toContain('All five expectations must pass before warmup')
    expect(design).toContain('empty positive results, missing/extra nodes or edges, reversed/wrong relationship kinds')
    expect(design).toContain('At that #608 completion checkpoint no technical phase was active')
    expect(design).toContain('43 production TypeScript files / 11,956 LOC')
    expect(design).toContain('At the #606 boundary no valid blinded Native-vs-Graphify-vs-Madar capability runner existed')
    expect(design).toContain('exactly one tool, `retrieve`')
    expect(design).toContain('frozen 25,000 ms request-wait ceiling')
    expect(design).toContain('direct JSON-RPC testing is insufficient')
    expect(design).toContain('The accepted receipt lives at')
    expect(design).toContain(EVIDENCE_MERGE)
    expect(design).toContain(EVIDENCE_CI_RUN)
    expect(design).toContain(EVIDENCE_REVIEW_RECEIPT)
    expect(design).toContain(THIN_DELIVERY_MERGE)
    expect(design).toContain(THIN_DELIVERY_FINAL_HEAD)
    expect(design).toContain(THIN_DELIVERY_FINAL_TREE)
    expect(design).toContain(THIN_DELIVERY_CI_RUN)
    expect(design).toContain(THIN_DELIVERY_REVIEW_RECEIPT)
    expect(design).toContain(THIN_DELIVERY_CODERABBIT_RECEIPT)
    expect(design).toContain(THIN_DELIVERY_HELD_OUT_RECEIPT_SHA256)
    expect(design).toContain(THIN_DELIVERY_ISSUE_COMPLETION)
    expect(design).toContain(THIN_DELIVERY_RFC_COMPLETION)
    expect(design).toContain(EVALUATION_TOOLING_MERGE)
    expect(design).toContain(EVALUATION_TOOLING_FINAL_HEAD)
    expect(design).toContain(EVALUATION_TOOLING_FINAL_TREE)
    expect(design).toContain(EVALUATION_TOOLING_CI_RUN)
    expect(design).toContain(EVALUATION_TOOLING_REVIEW_RECEIPT)
    expect(design).toContain(EVALUATION_TOOLING_CODERABBIT_RECEIPT)
    expect(design).toContain(EVALUATION_TOOLING_ISSUE_MERGE_RECEIPT)
    expect(design).toContain(EVALUATION_TOOLING_RFC_MERGE_RECEIPT)
    expect(design).not.toContain('## Active amendment — generation and incremental index')
    expect(design).not.toContain('the phase remains active')
    expect(design).not.toContain('completion evidence remains open')
    expect(design).not.toContain('Every returned node, relationship, file, range, and snippet must exist in the authoritative `graph.json`')
    expect(design).not.toContain('Identical question plus identical graph bytes must produce byte-identical output')
    expect(scorecard).toContain('**Status:** accepted')
    expect(scorecard).toContain('| Directed multigraph | **Passed**')
    expect(scorecard).toContain('| Canonical TypeScript index | **Passed**')
    expect(scorecard).toContain('| Legacy extraction plus non-code/other-language ingestion | **Passed**')
    expect(scorecard).toContain('| Generation and reconciliation | **Passed**')
    expect(scorecard).toContain('| Evidence-path query | **Passed**')
    expect(scorecard).toContain('| Delivery and package | **Passed**')
    expect(scorecard).toContain('| Evaluation tooling isolation | **Passed**')
    expect(scorecard).toContain('| Capability validation v1 | **Stopped**')
    expect(scorecard).toContain('| Capability validation v2 | **Stopped / not planned**')
    expect(scorecard).toContain('| Retrieval regression #618 | **Passed**')
    expect(scorecard).toContain('| Beta release | **Ready**')
    expect(scorecard).toContain(CAPABILITY_VALIDATION_PROPOSAL_SHA256)
    expect(scorecard).toContain(CAPABILITY_VALIDATION_OWNER_APPROVAL)
    expect(scorecard).toContain(CAPABILITY_VALIDATION_RFC_APPROVAL)
    expect(scorecard).toContain(CAPABILITY_VALIDATION_BASE)
    expect(scorecard).toContain(CAPABILITY_VALIDATION_V2_PROPOSAL_SHA256)
    expect(scorecard).toContain(CAPABILITY_VALIDATION_V2_OWNER_APPROVAL)
    expect(scorecard).toContain(CAPABILITY_VALIDATION_V2_RFC_APPROVAL)
    expect(scorecard).toContain(CAPABILITY_VALIDATION_V2_BASE)
    expect(scorecard).toContain(EVALUATION_TOOLING_OWNER_APPROVAL)
    expect(scorecard).toContain(EVALUATION_TOOLING_RFC_APPROVAL)
    expect(scorecard).toContain(EVALUATION_TOOLING_BASE)
    expect(scorecard).toContain(EVALUATION_TOOLING_SRC_TREE)
    expect(scorecard).toContain(THIN_DELIVERY_OWNER_APPROVAL)
    expect(scorecard).toContain(THIN_DELIVERY_RFC_APPROVAL)
    expect(scorecard).toContain(THIN_DELIVERY_BASE)
    expect(scorecard).toContain(EVIDENCE_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_RFC_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_PERFORMANCE_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_PERFORMANCE_RFC_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_SOURCE_AMENDMENT)
    expect(scorecard).toContain(EVIDENCE_SOURCE_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_SOURCE_RFC_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_V2_PROPOSAL)
    expect(scorecard).toContain(EVIDENCE_V2_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_V2_RFC_PROPOSAL)
    expect(scorecard).toContain(EVIDENCE_V2_RFC_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_GENERATION_PREREQUISITE)
    expect(scorecard).toContain(EVIDENCE_GENERATION_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_GENERATION_RFC_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_COMBINED_APPROVAL_599)
    expect(scorecard).toContain(EVIDENCE_COMBINED_APPROVAL_596)
    expect(scorecard).toContain(EVIDENCE_COMBINED_RFC_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_OBLIGATION_PROPOSAL)
    expect(scorecard).toContain(EVIDENCE_OBLIGATION_RFC_PROPOSAL)
    expect(scorecard).toContain(EVIDENCE_OBLIGATION_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_OBLIGATION_RFC_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_DARWIN_PATH_PROPOSAL)
    expect(scorecard).toContain(EVIDENCE_DARWIN_PATH_RFC_PROPOSAL)
    expect(scorecard).toContain(EVIDENCE_DARWIN_PATH_OWNER_APPROVAL)
    expect(scorecard).toContain(EVIDENCE_DARWIN_PATH_RFC_APPROVAL)
    expect(scorecard).toContain('only an authenticated canonical symbol declaration may provide a snippet or cover a phase')
    expect(scorecard).toContain('Identical normalized request plus identical canonical graph bytes')
    expect(scorecard).toContain('every warmup/measured result must remain correct; an empty positive result fails')
    expect(scorecard).toContain('No technical implementation phase is active')
    expect(scorecard).toContain('exactly 20 production TypeScript files / 4,698 LOC')
    expect(scorecard).toContain('completed Evaluation Tooling Isolation is 43 files / 11,956 LOC')
    expect(scorecard).toContain('- [x] Production cannot import `tools/eval`')
    expect(scorecard).toContain('Completed Evaluation Tooling Isolation: 102 files / 637,602 unpacked bytes')
    expect(scorecard).toContain('There is no valid blinded Native-vs-Graphify-vs-Madar runner')
    expect(scorecard).toContain('exactly one `retrieve` tool')
    expect(scorecard).toContain('frozen 25,000 ms request-wait ceiling')
    expect(scorecard).toContain('no lower bound')
    expect(scorecard).toContain(EVIDENCE_MERGE)
    expect(scorecard).toContain(EVIDENCE_CI_RUN)
    expect(scorecard).toContain(EVIDENCE_REVIEW_RECEIPT)
    expect(scorecard).toContain(THIN_DELIVERY_MERGE)
    expect(scorecard).toContain(THIN_DELIVERY_FINAL_HEAD)
    expect(scorecard).toContain(THIN_DELIVERY_FINAL_TREE)
    expect(scorecard).toContain(THIN_DELIVERY_CI_RUN)
    expect(scorecard).toContain(THIN_DELIVERY_REVIEW_RECEIPT)
    expect(scorecard).toContain(THIN_DELIVERY_CODERABBIT_RECEIPT)
    expect(scorecard).toContain(THIN_DELIVERY_HELD_OUT_RECEIPT_SHA256)
    expect(scorecard).toContain(EVALUATION_TOOLING_MERGE)
    expect(scorecard).toContain(EVALUATION_TOOLING_FINAL_HEAD)
    expect(scorecard).toContain(EVALUATION_TOOLING_FINAL_TREE)
    expect(scorecard).toContain(EVALUATION_TOOLING_CI_RUN)
    expect(scorecard).toContain(EVALUATION_TOOLING_REVIEW_RECEIPT)
    expect(scorecard).toContain(EVALUATION_TOOLING_CODERABBIT_RECEIPT)
    expect(scorecard).toContain(EVALUATION_TOOLING_ISSUE_MERGE_RECEIPT)
    expect(scorecard).toContain(EVALUATION_TOOLING_RFC_MERGE_RECEIPT)
    expect(scorecard).toContain('passes held-out-v2')
    expect(scorecard).toContain('clean generation stays within the accepted 10% regression limit')
    expect(scorecard).toContain('recognized unsupported files and expected policy exclusions are informational')
    expect(scorecard).toContain('The fixed 500-file experiment stopped the incremental design')
    expect(scorecard).toContain('There is no in-memory or disk session cache')
    expect(scorecard).not.toContain('single In progress phase through #592')
    expect(scorecard).not.toContain('phase stays **In progress**')
    expect(scorecard).not.toContain('phase completion awaits')
    expect(scorecard).not.toContain('Every returned node, edge, snippet, range, and direction must exist in `graph.json`')
    expect(scorecard).not.toContain('identical question plus identical graph bytes must produce byte-identical output')
    expect(scorecard).toContain('final CodeRabbit rerun was rate-limited')
    expect(scorecard).toContain('owner-approved exception')
    expect(scorecard).not.toContain('CI and review remain pending')
    expect(readme).toContain('docs/roadmap.md')
    expect(contributing).toContain('docs/roadmap.md')
    expect(contributing).toContain('The accepted Core Reset')
    expect(contributing).not.toContain('The proposed Core Reset')
  })

  it('keeps the removal manifest machine-readable and explicit', () => {
    const manifestPath = 'docs/core-reset/removal-manifest.yml'
    expect(existsSync(resolve(manifestPath))).toBe(true)

    const manifest = parse(read(manifestPath)) as {
      schema_version: number
      status: string
      rules: string[]
      current: {
        updated_at: string
        completed_phase: string
        active_phase: string | null
        ready_phase: string | null
        base_commit: string
        completed_phase_commit: string
        production_typescript_files: number
        production_typescript_loc: number
        production_loc_added: number
        production_loc_removed: number
        production_loc_net: number
        npm_files: number
        npm_packed_bytes: number
        npm_unpacked_bytes: number
        npm_shasum: string
        npm_integrity: string
        npm_artifact_sha256: string
      }
      items: Array<{
        id: string
        disposition: string
        status: string
        notes?: string
        absorbs?: string[]
        absorbed_by?: string
        transferred_sources?: string[]
        replacement_sources?: string[]
        preserve?: string[]
        production_file_budget?: { added_max: number; removed_min: number }
        production_loc_budget?: { added_max: number; removed_min: number; net_max: number }
        runtime_dependency_budget?: { added_max: number; removed_min: number }
        development_dependency_budget?: { added_max: number; removed_min: number }
        final_source_budget?: { files_max: number; loc_max: number }
        npm_package_budget?: { files_max: number; unpacked_bytes_max: number; packed_bytes_delta_max: number }
        implementation_inventory?: {
          receipt: string
          receipt_sha256: string
          subject_commit: string
          subject_tree_oid: string
          production_typescript_files: number
          production_typescript_loc: number
          production_loc_added: number
          production_loc_removed: number
          production_loc_net: number
          runtime_dependencies_added: number
          development_dependencies_added: number
          optional_peer_metadata_removed: boolean
          npm_files: number
          npm_packed_bytes: number
          npm_unpacked_bytes: number
          npm_packed_bytes_delta: number
          all_phase_budgets_pass: boolean
        }
        performance_budget?: {
          cold_noop_median_ratio_max: number
          clean_generation_regression_ratio_max: number
          measured_trials_min: number
        }
        stopped_incremental_gate?: {
          candidate_checkpoint: string
          candidate_worktree_tree: string
          fixed_fixture_supported_files: number
          warm_index_p50_ratio: number
          warm_refresh_p50_ratio: number
          warm_refresh_p95_ratio: number
          heldout: string
          failed_path: string
        }
        completeness_contract?: {
          supported_extensions: string[]
          supported_success_determines_completeness: boolean
          supported_failure: string
          recognized_unsupported: string
          expected_policy_exclusions: string
          safety_exclusions: string
        }
        equivalence_mutations?: string[]
        publication_contract?: {
          authoritative_artifact: string
          commit_marker: string
          derived_diagnostics_non_blocking: boolean
          persistent_fact_cache: string
          versioned_snapshot_store: string
        }
        activation?: {
          issue: string
          owner_approval: string
          rfc_amendment: string
          protected_base: string
        }
        implementation?: {
          commit: string
          mode: string
          in_memory_session_cache: string
          disk_session_cache: string
          failed_incremental_path: string
          evidence_receipts: string[]
        }
        runtime_dependencies_removed?: string[]
        retired_cli_flags?: string[]
        completion?: {
          issue: string
          absorbed_issue?: string
          pull_request: string
          commit: string
          implementation_commit?: string
          final_pr_head?: string
          final_pr_tree?: string
          ci_head?: string
          outcome?: string
          production_files_added?: number
          production_files_removed?: number
          production_typescript_files: number
          production_typescript_loc: number
          production_loc_added: number
          production_loc_removed: number
          production_loc_net: number
          replacement_loc?: number
          dependencies_added: number
          dependencies_removed?: number
          runtime_dependencies_added?: number
          development_dependencies_added?: number
          optional_peer_metadata_removed?: boolean
          npm_files?: number
          npm_packed_bytes?: number
          npm_unpacked_bytes?: number
          npm_shasum?: string
          npm_integrity?: string
          npm_artifact_sha256?: string
          ci_matrix_jobs_passed: number
          ci_run?: string
          test_files_passed?: number
          tests_passed?: number
          tests_skipped?: number
          coverage_statements_percent?: number
          coverage_branches_percent?: number
          coverage_functions_percent?: number
          coverage_lines_percent?: number
          coderabbit: string
          coderabbit_findings_addressed?: number
          coderabbit_findings_confirmed?: number
          coderabbit_review_body_nitpicks_addressed?: number
          independent_review?: string
          independent_reviews_passed?: number
          independent_review_receipt?: string
          unresolved_review_threads: number
        }
        sources?: string[]
        removed_sources?: string[]
        exit_gate: string
        remove_when?: string
      }>
    }

    expect(manifest.schema_version).toBe(1)
    expect(manifest.status).toBe('accepted')
    expect(manifest.current).toMatchObject({
      updated_at: '2026-07-29',
      completed_phase: RETRIEVAL_REGRESSION_ID,
      active_phase: null,
      ready_phase: 'release-beta',
      base_commit: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
      completed_phase_commit: 'eaa1a8781eda28dad5395d6da378a2cc40bf81fe',
      production_typescript_files: 43,
      production_typescript_loc: 12_008,
      production_loc_added: 69,
      production_loc_removed: 17,
      production_loc_net: 52,
      npm_files: 102,
      npm_packed_bytes: 160_319,
      npm_unpacked_bytes: 639_962,
      npm_shasum: 'b1c16839b13a4b8ff5d60795af7f375dd48dcb98',
      npm_integrity:
        'sha512-H8GnBRaGnkbCuMbdO8BSxyS/69UEesCBCoHWLfixMpur26b0uze1E1vE97EmcY0LuC5v+FNZoK98LGIupUKr8g==',
      npm_artifact_sha256: 'e90662a267fe5311453571de672844b72aadf76a47cecf79c3db3a46c06664fc',
      measurement_state: 'source_and_package_exact',
      snapshot_scope: 'release_candidate_source_and_package',
    })
    expect(manifest.rules.length).toBeGreaterThan(0)
    expect(manifest.items.length).toBeGreaterThan(10)

    const ids = manifest.items.map((item) => item.id.trim())
    expect(new Set(ids).size).toBe(ids.length)

    for (const item of manifest.items) {
      expect(item.id.trim().length).toBeGreaterThan(0)
      expect(['keep', 'rebuild', 'move', 'delete', 'defer']).toContain(item.disposition)
      expect(['proposed', 'planned', 'ready', 'in_progress', 'complete', 'stopped', 'approved_exception'])
        .toContain(item.status)
      expect(item.exit_gate.trim().length).toBeGreaterThan(0)
      for (const source of item.sources ?? []) {
        expect(source.trim()).toMatch(/^(?:\.github|docs|examples|src|tests|tools)\//)
      }
      for (const source of item.removed_sources ?? []) {
        expect(source.trim()).toMatch(/^(?:\.github|docs|examples|src|tests|tools)\//)
      }
      if (item.disposition === 'rebuild') {
        expect(item.remove_when?.trim().length).toBeGreaterThan(0)
      }
    }
    const directed = manifest.items.find((item) => item.id === 'directed-multigraph')
    expect(directed?.status).toBe('complete')
    expect(directed?.notes).toContain('#582')
    expect(directed?.completion).toEqual({
      issue: 'https://github.com/mohanagy/madar/issues/582',
      pull_request: 'https://github.com/mohanagy/madar/pull/583',
      commit: '63c59049178e82bd6bd1c928f6666ef159365bbe',
      production_typescript_files: 178,
      production_typescript_loc: 93_792,
      production_loc_added: 1_197,
      production_loc_removed: 4_171,
      production_loc_net: -2_974,
      dependencies_added: 0,
      ci_matrix_jobs_passed: 6,
      coderabbit: 'passed',
      unresolved_review_threads: 0,
    })
    const canonical = manifest.items.find((item) => item.id === 'canonical-typescript-index')
    expect(canonical?.status).toBe('complete')
    expect(canonical?.notes).toContain('#585')
    expect(canonical?.notes).toContain('explicit owner exception')
    expect(canonical?.completion).toEqual({
      issue: 'https://github.com/mohanagy/madar/issues/585',
      pull_request: 'https://github.com/mohanagy/madar/pull/586',
      commit: '4dfd48194f2fab00b2cd2271a6f7917909dde9d4',
      production_typescript_files: 170,
      production_typescript_loc: 91_539,
      production_loc_added: 5_538,
      production_loc_removed: 7_791,
      production_loc_net: -2_253,
      dependencies_added: 0,
      ci_matrix_jobs_passed: 6,
      coderabbit: 'rate_limited_owner_exception',
      coderabbit_findings_addressed: 9,
      coderabbit_findings_confirmed: 8,
      coderabbit_review_body_nitpicks_addressed: 2,
      independent_review: 'passed',
      independent_review_receipt: 'https://github.com/mohanagy/madar/pull/586#issuecomment-5036311350',
      unresolved_review_threads: 0,
    })
    const legacy = manifest.items.find((item) => item.id === 'legacy-extraction')
    const nonCode = manifest.items.find((item) => item.id === 'non-code-and-other-language-ingest')
    expect(legacy).toMatchObject({
      status: 'complete',
      absorbs: ['non-code-and-other-language-ingest'],
      production_file_budget: { added_max: 1, removed_min: 31 },
      production_loc_budget: { added_max: 900, removed_min: 20_951, net_max: -20_000 },
      runtime_dependency_budget: { added_max: 0, removed_min: 3 },
      runtime_dependencies_removed: ['@vscode/tree-sitter-wasm', 'web-tree-sitter', 'fflate'],
      retired_cli_flags: ['--legacy', '--spi', '--include-docs', '--docs', '--wiki'],
    })
    expect(legacy?.notes).toContain('CodeRabbit skipped the actual review')
    expect(legacy?.completion).toEqual({
      issue: 'https://github.com/mohanagy/madar/issues/588',
      pull_request: 'https://github.com/mohanagy/madar/pull/590',
      commit: 'd46031eed7b0cf2d8bb7b7b6267a51322d9e2490',
      production_files_added: 0,
      production_files_removed: 31,
      production_typescript_files: 139,
      production_typescript_loc: 68_954,
      production_loc_added: 815,
      production_loc_removed: 23_400,
      production_loc_net: -22_585,
      dependencies_added: 0,
      dependencies_removed: 3,
      npm_files: 314,
      npm_packed_bytes: 592_783,
      npm_unpacked_bytes: 2_794_076,
      ci_matrix_jobs_passed: 6,
      ci_run: 'https://github.com/mohanagy/madar/actions/runs/29899357806',
      coderabbit: 'skipped_base_owner_exception',
      independent_review: 'passed',
      independent_review_receipt: 'https://github.com/mohanagy/madar/pull/590#issuecomment-5043069972',
      unresolved_review_threads: 0,
    })
    expect(legacy?.transferred_sources).toEqual([
      'src/application/build-graph.ts',
      'src/core/provenance/ingest.ts',
      'src/infrastructure/cache.ts',
      'src/infrastructure/capabilities.ts',
    ])
    expect(nonCode).toMatchObject({ status: 'complete', absorbed_by: 'legacy-extraction' })
    const deletionOwners = [legacy, ...(legacy?.absorbs ?? []).map((id) => manifest.items.find((item) => item.id === id))]
    expect(deletionOwners.every(Boolean)).toBe(true)
    const legacyBase = `${legacy!.completion!.commit}^`
    const baseFiles = productionTypeScriptFilesAtCommit(legacyBase)
    const deletionFiles = baseFiles.filter((file) =>
      deletionOwners.some((item) => (item?.removed_sources ?? []).some((pattern) => manifestGlob(pattern).test(file))),
    )
    expect(new Set(deletionFiles).size).toBe(31)
    expect(logicalLocAtCommit(legacyBase, deletionFiles)).toBe(20_951)
    const generation = manifest.items.find((item) => item.id === 'generation-and-incremental')
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual([])
    const retrievalRegression = manifest.items.find((item) => item.id === RETRIEVAL_REGRESSION_ID) as any
    expect(retrievalRegression).toMatchObject({
      disposition: 'keep',
      status: 'complete',
      modified_sources: [...RETRIEVAL_REGRESSION_FILES],
      verification: [
        '.github/scripts/verify-packed-retrieval-parity.mjs',
        'tests/unit/package-metadata.test.ts',
        'tests/unit/retrieve-context.test.ts',
        'tests/unit/stdio-server.test.ts',
      ],
      production_file_budget: { added_max: 0, removed_min: 0 },
      production_loc_budget: { added_max: 100, removed_min: 0, net_max: 100 },
      runtime_dependency_budget: { added_max: 0, removed_min: 0 },
      activation: {
        issue: 'https://github.com/mohanagy/madar/issues/618',
        protected_base: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
        target_branch: 'core-reset',
      },
      constraints: {
        repository_specific_ranking: 'forbidden',
        graph_or_index_semantics_change: 'forbidden',
        compatibility_fallback: 'forbidden',
        dependency_change: 'forbidden',
        external_recovery_calls_max: 1,
      },
    })
    const changedRegressionProduction = execFileSync(
      git,
      [
        'diff',
        '--name-only',
        CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
        '--',
        'src',
      ],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort()
    expect(changedRegressionProduction).toEqual([...RETRIEVAL_REGRESSION_FILES].sort())
    expect(generation).toMatchObject({
      status: 'complete',
      sources: INCREMENTAL_OWNED_REPLACEMENTS,
      removed_sources: [...INCREMENTAL_PREDECESSORS],
      transferred_sources: Object.keys(INCREMENTAL_TRANSFERS),
      replacement_sources: [...INCREMENTAL_REPLACEMENTS],
      production_file_budget: { added_max: 6, removed_min: 15 },
      production_loc_budget: { added_max: 2_200, removed_min: 3_839, net_max: -1_500 },
      runtime_dependency_budget: { added_max: 0, removed_min: 0 },
      development_dependency_budget: { added_max: 0, removed_min: 0 },
      final_source_budget: { files_max: 130, loc_max: 67_454 },
      npm_package_budget: { files_max: 296, unpacked_bytes_max: 2_700_000, packed_bytes_delta_max: 0 },
      performance_budget: {
        cold_noop_median_ratio_max: 0.20,
        clean_generation_regression_ratio_max: 0.10,
        measured_trials_min: 20,
      },
      stopped_incremental_gate: {
        candidate_checkpoint: STOPPED_INCREMENTAL_CANDIDATE,
        candidate_worktree_tree: STOPPED_INCREMENTAL_TREE,
        fixed_fixture_supported_files: 500,
        warm_index_p50_ratio: 0.824,
        warm_refresh_p50_ratio: 1.047,
        warm_refresh_p95_ratio: 1.029,
        heldout: 'intentionally_skipped_after_fixed_gate_stop',
        failed_path: 'deleted',
      },
      completeness_contract: {
        supported_extensions: ['.ts', '.tsx', '.js', '.jsx'],
        supported_success_determines_completeness: true,
        supported_failure: 'incomplete_with_exact_file_and_reason',
        recognized_unsupported: 'informational',
        expected_policy_exclusions: 'informational',
        safety_exclusions: 'separate_and_never_indexed',
      },
      equivalence_mutations: [
        'no_op',
        'add',
        'private_leaf_change',
        'exported_signature_change',
        'delete',
        'rename',
        'compiler_control',
        'madarignore',
        'gitignore',
        'recognized_unsupported_add_delete_rename',
        'allowed_and_rejected_symlink',
        'linked_worktree',
      ],
      publication_contract: {
        authoritative_artifact: 'graph.json',
        commit_marker: 'graph.json',
        derived_diagnostics_non_blocking: true,
        persistent_fact_cache: 'forbidden',
        versioned_snapshot_store: 'forbidden',
      },
      activation: {
        issue: 'https://github.com/mohanagy/madar/issues/592',
        owner_approval: 'https://github.com/mohanagy/madar/issues/592#issuecomment-5044052506',
        rfc_amendment: 'https://github.com/mohanagy/madar/issues/577#issuecomment-5044052586',
        protected_base: INCREMENTAL_BASE,
      },
      implementation: {
        commit: INCREMENTAL_IMPLEMENTATION,
        mode: 'cold_noop_or_full_canonical_reconcile',
        in_memory_session_cache: 'absent',
        disk_session_cache: 'absent',
        failed_incremental_path: 'deleted',
        evidence_receipts: [
          'docs/core-reset/evidence/generation-incremental-protected-base-500.json',
          'docs/core-reset/evidence/generation-incremental-stop-500.json',
          'docs/core-reset/evidence/generation-full-reconcile-500.json',
          'docs/core-reset/evidence/generation-incremental-inventory.json',
          INCREMENTAL_MUTATION_RECEIPT,
        ],
      },
      completion: {
        issue: 'https://github.com/mohanagy/madar/issues/592',
        pull_request: 'https://github.com/mohanagy/madar/pull/594',
        commit: INCREMENTAL_MERGE,
        implementation_commit: INCREMENTAL_IMPLEMENTATION,
        final_pr_head: INCREMENTAL_CI_HEAD,
        ci_head: INCREMENTAL_CI_HEAD,
        outcome: 'cold_noop_or_full_canonical_reconcile_after_incremental_stop',
        production_files_added: 6,
        production_files_removed: 15,
        production_typescript_files: 130,
        production_typescript_loc: 66_418,
        production_loc_added: 2_190,
        production_loc_removed: 4_726,
        production_loc_net: -2_536,
        replacement_loc: 1_484,
        dependencies_added: 0,
        dependencies_removed: 0,
        runtime_dependencies_added: 0,
        development_dependencies_added: 0,
        npm_files: 276,
        npm_packed_bytes: 572_143,
        npm_unpacked_bytes: 2_699_851,
        ci_matrix_jobs_passed: 6,
        ci_run: INCREMENTAL_CI_RUN,
        test_files_passed: 156,
        tests_passed: 1_885,
        tests_skipped: 2,
        coverage_statements_percent: 84.44,
        coverage_branches_percent: 76.64,
        coverage_functions_percent: 89.57,
        coverage_lines_percent: 85.34,
        coderabbit: 'skipped_base_owner_exception',
        independent_review: 'passed',
        independent_reviews_passed: 3,
        independent_review_receipt: INCREMENTAL_REVIEW_RECEIPT,
        unresolved_review_threads: 0,
      },
    })
    const incrementalBaseFiles = productionTypeScriptFilesAtCommit(INCREMENTAL_BASE)
    expect(INCREMENTAL_PREDECESSORS.every((path) => incrementalBaseFiles.includes(path))).toBe(true)
    expect(INCREMENTAL_PREDECESSORS.every((path) => !existsSync(resolve(path)))).toBe(true)
    expect(INCREMENTAL_REPLACEMENTS.every((path) => existsSync(resolve(path)))).toBe(true)
    expect(logicalLocAtCommit(INCREMENTAL_BASE, INCREMENTAL_PREDECESSORS)).toBe(3_839)
    expect(manifest.items.find((item) => item.id === 'evidence-path-query')?.status).toBe('complete')
    expect(manifest.items.find((item) => item.id === 'thin-delivery')?.status).toBe('complete')
  })

  it('enforces the completed Thin Delivery implementation contract', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      review: { disposition_changes: number; amendment: string }
      targets: {
        production_typescript_files_max: number
        production_typescript_loc_min?: number
        production_typescript_loc_max: number
        npm_files_max: number
        npm_unpacked_bytes_max: number
        cli_commands_max: number
        mcp_tools_max: number
      }
      current: {
        updated_at: string
        completed_phase: string
        active_phase: string | null
        ready_phase: string | null
        base_commit: string
        completed_phase_commit: string
        production_typescript_files: number
        production_typescript_loc: number
        production_loc_added: number
        production_loc_removed: number
        production_loc_net: number
        npm_files: number
        npm_packed_bytes: number
        npm_unpacked_bytes: number
        measurement_state: string
        snapshot_scope: string
      }
      items: Array<{
        id: string
        disposition: string
        status: string
        sources?: string[]
        removed_sources?: string[]
        absorbs?: string[]
        absorbed_by?: string
        transferred_sources?: string[]
        replacement_sources?: string[]
        predecessor_contract?: Record<string, number>
        production_file_budget?: { added_max: number; removed_min: number }
        production_loc_budget?: { added_max: number; removed_min: number; net_max: number }
        runtime_dependency_budget?: { added_max: number; removed_exact?: number }
        development_dependency_budget?: { added_max: number; removed_max?: number }
        runtime_dependencies_removed?: string[]
        final_source_budget?: { files_max: number; loc_max: number }
        npm_package_budget?: {
          files_less_than: number
          unpacked_bytes_less_than: number
          packed_bytes_delta_max: number
        }
        cli_contract?: {
          entrypoints_max: number
          allowlist: string[]
          retired_commands: string[]
          retired_flags: string[]
          compatibility_aliases: string
          command_local_dynamic_imports: string
        }
        mcp_contract?: {
          tools_exact: string[]
          advertised_capabilities: string[]
          resources: string
          prompts: string
          question_chars_max: number
          budget_tokens_max: number
          selected_files_max: number
          snippets_max: number
          cli_application_mcp_result_parity: string
          query_graph_index_generation_semantic_changes: string
        }
        freshness_contract?: {
          workspace_from_process_cwd: boolean
          linked_worktree_graph_isolation: string
          initialize_and_tools_list_before_reconciler_import: boolean
          reconciliation_engine_count: number
          request_wait_ms_max: number
          first_graph_call_waits_within_tool_timeout: boolean
          timeout_boundary: string
          retry_madar_instruction: string
          second_watcher_cache_queue_session_or_retry_planner: string
        }
        installer_contract?: {
          supported_clients: string[]
          codex_startup_timeout_sec: number
          codex_tool_timeout_sec: number
          codex_workspace_hashed_global_block: string
          exact_workspace_cwd: string
          concurrent_workspace_registrations: string
          exact_owned_uninstall: string
          fresh_lifecycle_repository_byte_changes: number
          legacy_cleanup: string
          tracked_prompt_or_mcp_configuration: string
        }
        startup_contract?: {
          isolated_cold_samples_min: number
          statistics_required: string[]
          version_median_ms_less_than: number
          version_max_rss_bytes_less_than: number
          initialize_tools_list_median_ms_less_than: number
          initialize_tools_list_tools_exact: string[]
          packed_install_required: boolean
          registry_arguments: string[]
        }
        real_client_contract?: {
          normal_launch_without_configuration_override: boolean
          forced_retrieve_calls: string[]
          codex_tools_call_required_to_close_567: boolean
          direct_json_rpc_insufficient_to_close_567: boolean
          codex_cancels_before_tools_call: string
          natural_tool_choice_claimed: boolean
        }
        evaluation_repin?: {
          transport_path_only: boolean
          repositories_prompts_grading_expected_evidence_query_budgets_and_semantics_frozen: boolean
          approved_historical_evaluator_sha256: string
          current_transport_repin_evaluator_sha256: string
          current_normalized_to_historical_sha256: string
          approved_historical_receipt_schema_sha256: string
          current_dual_path_receipt_schema_sha256: string
        }
        review_contract?: {
          ci_matrix_jobs: number
          independent_exact_head_review: string
          coderabbit_non_default_base_exception_must_be_honest: boolean
          unresolved_review_threads: number
        }
        activation?: {
          issue: string
          absorbed_issue?: string
          owner_approval: string
          rfc_amendment: string
          protected_base: string
          implementation_start_commit?: string
          implementation_started?: boolean
        }
        implementation?: {
          start_commit: string
          production_files_added: number
          production_files_removed: number
          production_typescript_files: number
          production_typescript_loc: number
          production_loc_added: number
          production_loc_removed: number
          production_loc_net: number
          runtime_dependencies_added: number
          runtime_dependencies_removed: number
          development_dependencies_added: number
          npm_files: number
          npm_packed_bytes: number
          npm_unpacked_bytes: number
          npm_packed_bytes_delta: number
          npm_shasum: string
          npm_integrity: string
          npm_tarball_sha256: string
          all_phase_budgets_pass: boolean
          final_artifact_client_revalidation_passed: boolean
          final_artifact_registration: string
          final_artifact_claude_session: string
          final_artifact_codex_session: string
        }
        completion?: Record<string, unknown>
        notes?: string
      }>
    }

    expect(execFileSync(git, ['rev-parse', `${THIN_DELIVERY_BASE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(THIN_DELIVERY_BASE_TREE)
    expect(execFileSync(
      git,
      ['rev-parse', `${THIN_DELIVERY_IMPLEMENTATION_START}^{tree}`],
      { encoding: 'utf8' },
    ).trim()).toBe(THIN_DELIVERY_IMPLEMENTATION_START_TREE)
    expect(execFileSync(git, ['rev-parse', `${THIN_DELIVERY_FINAL_HEAD}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(THIN_DELIVERY_FINAL_TREE)
    expect(execFileSync(git, ['rev-parse', `${THIN_DELIVERY_MERGE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(THIN_DELIVERY_FINAL_TREE)
    expect(execFileSync(
      git,
      ['rev-list', '--parents', '-n', '1', THIN_DELIVERY_MERGE],
      { encoding: 'utf8' },
    ).trim()).toBe(`${THIN_DELIVERY_MERGE} ${THIN_DELIVERY_IMPLEMENTATION_START}`)
    expect(() => execFileSync(
      git,
      ['merge-base', '--is-ancestor', THIN_DELIVERY_BASE, THIN_DELIVERY_IMPLEMENTATION_START],
    )).not.toThrow()
    expect(() => execFileSync(
      git,
      ['merge-base', '--is-ancestor', THIN_DELIVERY_IMPLEMENTATION_START, THIN_DELIVERY_MERGE],
    )).not.toThrow()
    expect(manifest.current).toMatchObject({
      updated_at: '2026-07-29',
      completed_phase: RETRIEVAL_REGRESSION_ID,
      active_phase: null,
      ready_phase: 'release-beta',
      base_commit: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
      completed_phase_commit: 'eaa1a8781eda28dad5395d6da378a2cc40bf81fe',
      production_typescript_files: 43,
      production_typescript_loc: 12_008,
      production_loc_added: 69,
      production_loc_removed: 17,
      production_loc_net: 52,
      measurement_state: 'source_and_package_exact',
      snapshot_scope: 'release_candidate_source_and_package',
    })
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual([])
    expect(manifest.targets).toMatchObject({
      production_typescript_files_max: 80,
      production_typescript_loc_max: 35_000,
      npm_files_max: 150,
      npm_unpacked_bytes_max: 1_500_000,
      cli_commands_max: 6,
      mcp_tools_max: 1,
    })
    expect(manifest.targets).not.toHaveProperty('production_typescript_loc_min')

    const thinDelivery = manifest.items.find((item) => item.id === 'thin-delivery')
    expect(thinDelivery).toMatchObject({
      disposition: 'rebuild',
      status: 'complete',
      sources: [...THIN_DELIVERY_REPLACEMENTS],
      removed_sources: [...THIN_DELIVERY_PREDECESSORS],
      absorbs: [...THIN_DELIVERY_ABSORBED_HANDLES],
      transferred_sources: ['src/infrastructure/doctor.ts'],
      replacement_sources: [...THIN_DELIVERY_REPLACEMENTS],
      predecessor_contract: {
        files: 16,
        production_loc: 7_277,
        absorbed_handles: 2,
        evaluation_transfers: 2,
        surviving_direct_importers: 2,
      },
      production_file_budget: { added_max: 6, removed_min: 16 },
      production_loc_budget: { added_max: 2_300, removed_min: 7_277, net_max: -4_977 },
      runtime_dependency_budget: { added_max: 0, removed_exact: 1 },
      development_dependency_budget: { added_max: 0, removed_max: 0 },
      runtime_dependencies_removed: ['neo4j-driver'],
      final_source_budget: { files_max: 63, loc_max: 16_710 },
      npm_package_budget: {
        files_less_than: 150,
        unpacked_bytes_less_than: 1_500_000,
        packed_bytes_delta_max: 0,
      },
      cli_contract: {
        entrypoints_max: 6,
        allowlist: ['generate', 'query', 'status', 'doctor', 'install', 'mcp'],
        compatibility_aliases: 'forbidden',
        command_local_dynamic_imports: 'required',
      },
      mcp_contract: {
        tools_exact: ['retrieve'],
        advertised_capabilities: ['tools'],
        resources: 'forbidden',
        prompts: 'forbidden',
        question_chars_max: 512,
        budget_tokens_max: 4_000,
        selected_files_max: 12,
        snippets_max: 25,
        cli_application_mcp_result_parity: 'byte_identical',
        query_graph_index_generation_semantic_changes: 'forbidden',
      },
      freshness_contract: {
        workspace_from_process_cwd: true,
        linked_worktree_graph_isolation: 'required',
        initialize_and_tools_list_before_reconciler_import: true,
        reconciliation_engine_count: 1,
        request_wait_ms_max: 25_000,
        first_graph_call_waits_within_tool_timeout: true,
        timeout_boundary: 'unavailable',
        retry_madar_instruction: 'forbidden',
        second_watcher_cache_queue_session_or_retry_planner: 'forbidden',
      },
      installer_contract: {
        supported_clients: ['claude', 'codex'],
        codex_startup_timeout_sec: 180,
        codex_tool_timeout_sec: 60,
        codex_workspace_hashed_global_block: 'required',
        exact_workspace_cwd: 'required',
        concurrent_workspace_registrations: 'required',
        exact_owned_uninstall: 'required',
        fresh_lifecycle_repository_byte_changes: 0,
        legacy_cleanup: 'byte_recognized_madar_owned_only',
        tracked_prompt_or_mcp_configuration: 'forbidden',
      },
      startup_contract: {
        isolated_cold_samples_min: 10,
        statistics_required: ['median_ms', 'p95_ms', 'max_rss_bytes'],
        version_median_ms_less_than: 100,
        version_max_rss_bytes_less_than: 83_886_080,
        initialize_tools_list_median_ms_less_than: 1_000,
        initialize_tools_list_tools_exact: ['retrieve'],
        packed_install_required: true,
        registry_arguments: ['mcp'],
      },
      real_client_contract: {
        normal_launch_without_configuration_override: true,
        forced_retrieve_calls: ['claude', 'codex'],
        codex_tools_call_required_to_close_567: true,
        direct_json_rpc_insufficient_to_close_567: true,
        codex_cancels_before_tools_call: 'stop_and_record_external_client_blocker',
        natural_tool_choice_claimed: false,
      },
      evaluation_repin: {
        transport_path_only: true,
        repositories_prompts_grading_expected_evidence_query_budgets_and_semantics_frozen: true,
        approved_historical_evaluator_sha256: THIN_DELIVERY_HISTORICAL_EVALUATOR_SHA256,
        current_transport_repin_evaluator_sha256: THIN_DELIVERY_REPINNED_EVALUATOR_SHA256,
        current_normalized_to_historical_sha256: THIN_DELIVERY_HISTORICAL_EVALUATOR_SHA256,
        approved_historical_receipt_schema_sha256: THIN_DELIVERY_HISTORICAL_RECEIPT_SCHEMA_SHA256,
        current_dual_path_receipt_schema_sha256: THIN_DELIVERY_DUAL_PATH_RECEIPT_SCHEMA_SHA256,
      },
      review_contract: {
        ci_matrix_jobs: 6,
        independent_exact_head_review: 'required',
        coderabbit_non_default_base_exception_must_be_honest: true,
        unresolved_review_threads: 0,
      },
      activation: {
        issue: THIN_DELIVERY_ISSUE,
        absorbed_issue: THIN_DELIVERY_ABSORBED_ISSUE,
        owner_approval: THIN_DELIVERY_OWNER_APPROVAL,
        rfc_amendment: THIN_DELIVERY_RFC_APPROVAL,
        protected_base: THIN_DELIVERY_BASE,
        implementation_start_commit: THIN_DELIVERY_IMPLEMENTATION_START,
        implementation_started: true,
      },
      implementation: {
        start_commit: THIN_DELIVERY_IMPLEMENTATION_START,
        production_files_added: 6,
        production_files_removed: 16,
        production_typescript_files: 63,
        production_typescript_loc: 16_654,
        production_loc_added: 2_248,
        production_loc_removed: 7_281,
        production_loc_net: -5_033,
        runtime_dependencies_added: 0,
        runtime_dependencies_removed: 1,
        development_dependencies_added: 0,
        npm_files: 142,
        npm_packed_bytes: 200_310,
        npm_unpacked_bytes: 812_531,
        npm_packed_bytes_delta: -31_214,
        npm_shasum: '1a915fdc597463f57cd0d79ffa26a7f1c27ff2ef',
        npm_integrity: 'sha512-94PSjJbRCsgv8oUt18iPZFzysl5S/7njrB1F05fzwkK5Amk6abxGcHv2L8K4fw1qijZLJ2sxr83nIl7NZWef8A==',
        npm_tarball_sha256: '2186259073a6bc05b7268ac7115fd56584d27024b76d167db021f68f83c603b9',
        all_phase_budgets_pass: true,
        final_artifact_client_revalidation_passed: true,
        final_artifact_registration: 'madar_6b8bb2115fe0',
        final_artifact_claude_session: 'f021741f-b474-438e-a07b-a54ef35e071c',
        final_artifact_codex_session: '019f9890-e9fb-7610-a379-f3ef19a418ef',
        final_artifact_transport_pass_record: THIN_DELIVERY_FINAL_CLIENT_ISSUE_RECEIPT,
        final_artifact_rfc_transport_pass_record: THIN_DELIVERY_FINAL_CLIENT_RFC_RECEIPT,
      },
      completion: {
        issue: THIN_DELIVERY_ISSUE,
        absorbed_issue: THIN_DELIVERY_ABSORBED_ISSUE,
        pull_request: 'https://github.com/mohanagy/madar/pull/604',
        commit: THIN_DELIVERY_MERGE,
        final_pr_head: THIN_DELIVERY_FINAL_HEAD,
        final_pr_tree: THIN_DELIVERY_FINAL_TREE,
        ci_head: THIN_DELIVERY_FINAL_HEAD,
        outcome: 'lazy_one_tool_delivery',
        production_files_added: 6,
        production_files_removed: 16,
        production_typescript_files: 63,
        production_typescript_loc: 16_654,
        production_loc_added: 2_248,
        production_loc_removed: 7_281,
        production_loc_net: -5_033,
        dependencies_added: 0,
        dependencies_removed: 1,
        runtime_dependencies_added: 0,
        development_dependencies_added: 0,
        npm_files: 142,
        npm_packed_bytes: 200_310,
        npm_unpacked_bytes: 812_531,
        npm_packed_bytes_delta: -31_214,
        npm_shasum: '1a915fdc597463f57cd0d79ffa26a7f1c27ff2ef',
        npm_integrity: 'sha512-94PSjJbRCsgv8oUt18iPZFzysl5S/7njrB1F05fzwkK5Amk6abxGcHv2L8K4fw1qijZLJ2sxr83nIl7NZWef8A==',
        npm_artifact_sha256: '2186259073a6bc05b7268ac7115fd56584d27024b76d167db021f68f83c603b9',
        held_out_benchmark_passed: true,
        held_out_eligible_for_acceptance: true,
        held_out_receipt_self_sha256: THIN_DELIVERY_HELD_OUT_RECEIPT_SHA256,
        ci_matrix_jobs_passed: 6,
        ci_run: THIN_DELIVERY_CI_RUN,
        test_files_passed: 74,
        tests_passed: 619,
        coverage_statements_percent: 81.55,
        coverage_branches_percent: 72.61,
        coverage_functions_percent: 88.94,
        coverage_lines_percent: 84.44,
        coderabbit: 'skipped_base_owner_exception',
        coderabbit_receipt: THIN_DELIVERY_CODERABBIT_RECEIPT,
        independent_review: 'passed',
        independent_reviews_passed: 1,
        independent_review_receipt: THIN_DELIVERY_REVIEW_RECEIPT,
        unresolved_review_threads: 0,
        merge_gate_receipt: THIN_DELIVERY_MERGE_GATE_RECEIPT,
        issue_completion_receipt: THIN_DELIVERY_ISSUE_COMPLETION,
        rfc_completion_receipt: THIN_DELIVERY_RFC_COMPLETION,
      },
    })
    expect(thinDelivery?.cli_contract?.retired_commands).toEqual([
      'watch',
      'serve',
      'try',
      'benchmark',
      'bench:suite',
      'eval',
      'compare',
      'hook',
      'telemetry',
      'aider',
      'claude',
      'cursor',
      'gemini',
      'copilot',
      'codex',
      'opencode',
      'claw',
      'droid',
      'trae',
      'trae-cn',
    ])
    expect(thinDelivery?.cli_contract?.retired_flags).toEqual([
      'implicit_madar_dot',
      '--stdio',
      '--mcp',
      '--auto-refresh',
      '--neo4j-*',
    ])
    const evaluationTooling = manifest.items.find((item) => item.id === 'evaluation-tooling')
    expect(evaluationTooling?.sources).toEqual(expect.arrayContaining([...THIN_DELIVERY_EVALUATION_TRANSFERS]))
    expect(evaluationTooling?.transferred_sources)
      .toEqual(expect.arrayContaining([...THIN_DELIVERY_EVALUATION_TRANSFERS]))
    expect(thinDelivery?.sources).not.toEqual(expect.arrayContaining([...THIN_DELIVERY_EVALUATION_TRANSFERS]))
    expect(thinDelivery?.transferred_sources).not.toContain('src/runtime/serve.ts')

    const absorbed = THIN_DELIVERY_ABSORBED_HANDLES.map((id) =>
      manifest.items.find((item) => item.id === id))
    expect(absorbed.map((item) => ({ id: item?.id, status: item?.status, absorbed_by: item?.absorbed_by })))
      .toEqual([
        { id: 'non-core-graph-products', status: 'complete', absorbed_by: 'thin-delivery' },
        { id: 'activation-and-extra-integrations', status: 'complete', absorbed_by: 'thin-delivery' },
      ])
    expect(absorbed.flatMap((item) => item?.sources ?? []).sort())
      .toEqual([...THIN_DELIVERY_ABSORBED_PREDECESSORS].sort())

    const baseFiles = productionTypeScriptFilesAtCommit(THIN_DELIVERY_IMPLEMENTATION_START)
    const implementationFiles = productionTypeScriptFilesAtCommit(THIN_DELIVERY_MERGE)
    const inventory = {
      files: implementationFiles.length,
      loc: logicalLocAtCommit(THIN_DELIVERY_MERGE, implementationFiles),
      paths: implementationFiles,
    }
    const baseFileSet = new Set(baseFiles)
    const currentFileSet = new Set(inventory.paths)
    expect(baseFiles).toHaveLength(73)
    expect(THIN_DELIVERY_PREDECESSORS.every((path) => baseFiles.includes(path))).toBe(true)
    expect(logicalLocAtCommit(THIN_DELIVERY_IMPLEMENTATION_START, THIN_DELIVERY_PREDECESSORS))
      .toBe(7_277)
    expect(THIN_DELIVERY_REPLACEMENTS.every((path) => !baseFiles.includes(path))).toBe(true)
    expect(inventory).toMatchObject({ files: 63, loc: 16_654 })
    const removedSinceImplementationStart = baseFiles.filter((path) => !currentFileSet.has(path)).sort()
    const addedSinceImplementationStart = inventory.paths
      .filter((path: string) => !baseFileSet.has(path))
      .sort()
    expect(removedSinceImplementationStart).toEqual([...THIN_DELIVERY_PREDECESSORS].sort())
    expect(addedSinceImplementationStart).toEqual([...THIN_DELIVERY_REPLACEMENTS].sort())
    for (const predecessor of THIN_DELIVERY_PREDECESSORS) {
      expect(existsSync(resolve(predecessor)), `${predecessor} must be absent`).toBe(false)
    }
    for (const replacement of THIN_DELIVERY_REPLACEMENTS) {
      expect(existsSync(resolve(replacement)), `${replacement} must exist`).toBe(true)
    }

    const edges = deletionImportEdgesAtCommit(
      THIN_DELIVERY_BASE,
      new Set(THIN_DELIVERY_PREDECESSORS),
    )
    expect({
      all_count: edges.all.length,
      all_sha256: edgeListSha256(edges.all),
      internal_count: edges.internal.length,
      internal_sha256: edgeListSha256(edges.internal),
      surviving_count: edges.surviving.length,
      surviving_sha256: edgeListSha256(edges.surviving),
      surviving: edges.surviving,
    }).toEqual({
      all_count: 20,
      all_sha256: '082584e57d8ce3b4342aeae2d5e67e5fb0b19bb2de8a241406d525fdd7bf7012',
      internal_count: 18,
      internal_sha256: 'f5e0fcc659698b8a595bbe2ce725e235bbdf6d13e50c3fcdf8c6b197f17a856b',
      surviving_count: 2,
      surviving_sha256: 'ed9fb86c8ea60510284e1b655b160831fe29bc0bad7001ff6f0ed80fa502d26e',
      surviving: [
        'src/infrastructure/benchmark/suite.ts\0src/infrastructure/install.ts',
        'src/infrastructure/try-command.ts\0src/cli/parser.ts',
      ],
    })

    const delta = productionSourceDeltaBetween(
      THIN_DELIVERY_IMPLEMENTATION_START,
      THIN_DELIVERY_MERGE,
    )
    expect(delta).toEqual({ added: 2_248, removed: 7_281, net: -5_033 })
    expect(delta.added).toBeLessThanOrEqual(thinDelivery!.production_loc_budget!.added_max)
    expect(delta.removed).toBeGreaterThanOrEqual(thinDelivery!.production_loc_budget!.removed_min)
    expect(delta.net).toBeLessThanOrEqual(thinDelivery!.production_loc_budget!.net_max)
    expect(addedSinceImplementationStart).toHaveLength(thinDelivery!.production_file_budget!.added_max)
    expect(removedSinceImplementationStart.length)
      .toBeGreaterThanOrEqual(thinDelivery!.production_file_budget!.removed_min)
    expect(inventory.files).toBeLessThanOrEqual(thinDelivery!.final_source_budget!.files_max)
    expect(inventory.loc).toBeLessThanOrEqual(thinDelivery!.final_source_budget!.loc_max)

    const predecessorSet = new Set<string>(THIN_DELIVERY_PREDECESSORS)
    const implementationFileSet = new Set(inventory.paths)
    const survivingLegacyImporterEdges = inventory.paths.flatMap((importer: string) =>
      importedProductionFilesAtCommit(THIN_DELIVERY_MERGE, importer, implementationFileSet)
        .filter((target) => predecessorSet.has(target))
        .map((target) => `${importer}\0${target}`))
    expect(survivingLegacyImporterEdges).toEqual([])

    type PackageManifest = {
      bin?: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    type PackageLock = {
      packages: Record<string, {
        bin?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }>
    }
    const basePackage = JSON.parse(execFileSync(
      git,
      ['show', `${THIN_DELIVERY_IMPLEMENTATION_START}:package.json`],
      { encoding: 'utf8' },
    )) as PackageManifest
    const currentPackage = JSON.parse(read('package.json')) as PackageManifest
    const expectedRuntimeDependencies = { ...basePackage.dependencies }
    expect(expectedRuntimeDependencies['neo4j-driver']).toBe('^6.0.1')
    delete expectedRuntimeDependencies['neo4j-driver']
    expect(currentPackage.dependencies).toEqual(expectedRuntimeDependencies)
    expect(currentPackage.devDependencies).toEqual(basePackage.devDependencies)
    expect(currentPackage.optionalDependencies).toEqual(basePackage.optionalDependencies)
    expect(currentPackage.peerDependencies).toEqual(basePackage.peerDependencies)
    expect(currentPackage.bin).toEqual({ madar: THIN_DELIVERY_BIN })

    const baseLock = JSON.parse(execFileSync(
      git,
      ['show', `${THIN_DELIVERY_IMPLEMENTATION_START}:package-lock.json`],
      { encoding: 'utf8' },
    )) as PackageLock
    const currentLock = JSON.parse(read('package-lock.json')) as PackageLock
    const removedLockPackages = Object.keys(baseLock.packages)
      .filter((path) => !(path in currentLock.packages))
      .sort()
    const addedLockPackages = Object.keys(currentLock.packages)
      .filter((path) => !(path in baseLock.packages))
      .sort()
    expect(removedLockPackages).toEqual([...THIN_DELIVERY_NEO4J_LOCK_CLOSURE])
    expect(addedLockPackages).toEqual([])
    expect(currentLock.packages['']?.dependencies).toEqual(currentPackage.dependencies)
    expect(currentLock.packages['']?.devDependencies).toEqual(currentPackage.devDependencies)
    expect(currentLock.packages['']?.optionalDependencies).toEqual(currentPackage.optionalDependencies)
    expect(currentLock.packages['']?.peerDependencies).toEqual(currentPackage.peerDependencies)
    expect(currentLock.packages['']?.bin).toEqual({ madar: THIN_DELIVERY_BIN })
    expect(JSON.stringify(currentLock)).not.toMatch(/neo4j/i)

    const implementation = thinDelivery!.implementation!
    expect({
      npm_files: implementation.npm_files,
      npm_packed_bytes: implementation.npm_packed_bytes,
      npm_unpacked_bytes: implementation.npm_unpacked_bytes,
    }).toEqual({
      npm_files: 142,
      npm_packed_bytes: 200_310,
      npm_unpacked_bytes: 812_531,
    })
    expect(implementation.npm_files).toBeLessThan(thinDelivery!.npm_package_budget!.files_less_than)
    expect(implementation.npm_unpacked_bytes)
      .toBeLessThan(thinDelivery!.npm_package_budget!.unpacked_bytes_less_than)
    expect(implementation.npm_packed_bytes - THIN_DELIVERY_BASE_NPM_PACKED_BYTES)
      .toBeLessThanOrEqual(thinDelivery!.npm_package_budget!.packed_bytes_delta_max)

    type StartupSample = {
      elapsed_ms: number
      max_rss_bytes: number
      tools?: string[]
    }
    type StartupMeasurement = {
      isolated_cold_processes: number
      samples: StartupSample[]
      median_ms: number
      p95_ms: number
      max_rss_bytes: number
      median_gate_ms_less_than: number
      max_rss_gate_bytes_less_than?: number
      tools_exact?: string[]
      passed: boolean
    }
    type ThinDeliveryStartupReceipt = {
      implementation_start_commit: string
      candidate_state: string
      measurement_method: {
        install: string
        elapsed_clock: string
        rss_command: string
        rss_unit: string
        median: string
        p95: string
        version_elapsed_boundary: string
        mcp_elapsed_boundary: string
      }
      package: {
        name: string
        version: string
        files: number
        packed_bytes: number
        unpacked_bytes: number
        preceding_packed_bytes: number
        packed_bytes_delta: number
        shasum: string
        integrity: string
        tarball_sha256: string
      }
      version_startup: StartupMeasurement
      mcp_startup: StartupMeasurement & { protocol_version: string }
      claims: {
        packed_install_used: boolean
        startup_gates_passed: boolean
        real_client_transport_proved: boolean
        completion_claimed: boolean
      }
    }
    const startup = JSON.parse(
      read('docs/core-reset/evidence/thin-delivery-startup.json'),
    ) as ThinDeliveryStartupReceipt
    expect(startup).toMatchObject({
      implementation_start_commit: THIN_DELIVERY_IMPLEMENTATION_START,
      candidate_state: 'pre_pr_final_candidate',
      measurement_method: {
        install: 'fresh consumer install from the real packed tarball',
        elapsed_clock: 'monotonic',
        rss_command: '/usr/bin/time -l',
        rss_unit: 'bytes',
        median: 'mean of the middle pair after ascending sort',
        p95: 'nearest rank at ceil(0.95 * sample count)',
      },
      package: {
        name: '@lubab/madar',
        version: '0.32.0',
        files: implementation.npm_files,
        packed_bytes: implementation.npm_packed_bytes,
        unpacked_bytes: implementation.npm_unpacked_bytes,
        preceding_packed_bytes: THIN_DELIVERY_BASE_NPM_PACKED_BYTES,
        packed_bytes_delta: implementation.npm_packed_bytes_delta,
        shasum: implementation.npm_shasum,
        integrity: implementation.npm_integrity,
        tarball_sha256: implementation.npm_tarball_sha256,
      },
      claims: {
        packed_install_used: true,
        startup_gates_passed: true,
        real_client_transport_proved: true,
        completion_claimed: false,
      },
    })
    expect(startup.measurement_method.version_elapsed_boundary)
      .toBe('process spawn through version process exit')
    expect(startup.measurement_method.mcp_elapsed_boundary)
      .toBe('process spawn through parsed tools/list response')

    const roundMilliseconds = (value: number): number => Math.round(value * 1_000) / 1_000
    const deriveStartupStatistics = (samples: StartupSample[]) => {
      const elapsed = samples.map((sample) => sample.elapsed_ms).sort((left, right) => left - right)
      const midpoint = Math.floor(elapsed.length / 2)
      const median = elapsed.length % 2 === 0
        ? (elapsed[midpoint - 1]! + elapsed[midpoint]!) / 2
        : elapsed[midpoint]!
      return {
        median_ms: roundMilliseconds(median),
        p95_ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
        max_rss_bytes: Math.max(...samples.map((sample) => sample.max_rss_bytes)),
      }
    }
    const startupContract = thinDelivery!.startup_contract!
    expect(startupContract.statistics_required)
      .toEqual(['median_ms', 'p95_ms', 'max_rss_bytes'])
    for (const measurement of [startup.version_startup, startup.mcp_startup]) {
      expect(measurement.samples).toHaveLength(measurement.isolated_cold_processes)
      expect(measurement.samples.length)
        .toBeGreaterThanOrEqual(startupContract.isolated_cold_samples_min)
      expect(measurement.samples.every((sample) => (
        Number.isFinite(sample.elapsed_ms)
        && sample.elapsed_ms > 0
        && Number.isInteger(sample.max_rss_bytes)
        && sample.max_rss_bytes > 0
      ))).toBe(true)
      expect({
        median_ms: measurement.median_ms,
        p95_ms: measurement.p95_ms,
        max_rss_bytes: measurement.max_rss_bytes,
      }).toEqual(deriveStartupStatistics(measurement.samples))
      expect(measurement.median_ms).toBeLessThan(measurement.median_gate_ms_less_than)
      expect(measurement.passed).toBe(true)
    }
    expect(startup.version_startup.median_gate_ms_less_than)
      .toBe(startupContract.version_median_ms_less_than)
    expect(startup.version_startup.max_rss_gate_bytes_less_than)
      .toBe(startupContract.version_max_rss_bytes_less_than)
    expect(startup.version_startup.max_rss_bytes)
      .toBeLessThan(startupContract.version_max_rss_bytes_less_than)
    expect(startup.mcp_startup.median_gate_ms_less_than)
      .toBe(startupContract.initialize_tools_list_median_ms_less_than)
    expect(startup.mcp_startup.tools_exact)
      .toEqual(startupContract.initialize_tools_list_tools_exact)
    expect(startup.mcp_startup.samples.every((sample) => (
      JSON.stringify(sample.tools) === JSON.stringify(startupContract.initialize_tools_list_tools_exact)
    ))).toBe(true)

    type ClientPass = {
      normal_launch: boolean
      launch_mode: string
      configuration_override_used: boolean
      manual_tool_override_used: boolean
      dangerous_bypass_used: boolean
      question: string
      budget: number
      retrieve_call_count: number
      result_received: boolean
      matched_source: string
      provenance: string
      final_response: string
      passed: boolean
    }
    type ThinDeliveryClientReceipt = {
      implementation_start_commit: string
      artifact: {
        name: string
        version: string
        shasum: string
        integrity: string
        tarball_sha256: string
        files: number
        packed_bytes: number
        unpacked_bytes: number
        packed_install: boolean
      }
      registration: {
        name: string
        command: string
        args: string[]
        workspace_hashed: boolean
        exact_workspace_cwd: boolean
        configuration_override_used: boolean
        manual_tool_override_used: boolean
      }
      codex: { passed: boolean }
      codex_stable_retry: { passed: boolean }
      codex_interactive_retry: { passed: boolean }
      final_candidate_revalidation: {
        candidate_state: string
        passed: boolean
        artifact: {
          npm_shasum: string
          npm_integrity: string
          tarball_sha256: string
          files: number
          packed_bytes: number
          unpacked_bytes: number
          preceding_packed_bytes: number
          packed_bytes_delta: number
          packed_install: boolean
          installed_package_is_symlink: boolean
        }
        fixture: {
          head: string
          status_before: string
          status_after: string
        }
        registration: {
          name: string
          command: string
          args: string[]
          workspace_hashed: boolean
          exact_workspace_cwd: boolean
        }
        codex: ClientPass & {
          version: string
          thread_id: string
          tool_approval: string
          tool_approval_persisted: boolean
          terminal_event: string
          server: string
          tool: string
          result: string
        }
        claude: ClientPass & {
          version: string
          session_id: string
          tool: string
        }
        cleanup: {
          supported_install_used: boolean
          supported_uninstall_used: boolean
          repository_changes: string
          codex_config_restored_sha256: string
          claude_config_restored_sha256: string
          claude_home_routing_restored_sha256: string
          all_captured_configuration_restored_byte_exact: boolean
        }
        github_records: {
          issue_602: string
          rfc_577: string
        }
        claims: {
          normal_codex_tools_call_proved: boolean
          normal_claude_tools_call_proved: boolean
          client_transport_passed: boolean
          stop_condition_triggered: boolean
          implementation_pr_opened: boolean
          implementation_merge_authorized: boolean
          thin_delivery_complete: boolean
        }
      }
      stop: {
        historically_triggered: boolean
        triggered: boolean
      }
    }
    const clientReceipt = JSON.parse(read(THIN_DELIVERY_CLIENT_RECEIPT)) as ThinDeliveryClientReceipt
    expect(clientReceipt).toMatchObject({
      implementation_start_commit: THIN_DELIVERY_IMPLEMENTATION_START,
      artifact: {
        name: '@lubab/madar',
        version: '0.32.0',
        shasum: implementation.npm_shasum,
        integrity: implementation.npm_integrity,
        tarball_sha256: implementation.npm_tarball_sha256,
        files: implementation.npm_files,
        packed_bytes: implementation.npm_packed_bytes,
        unpacked_bytes: implementation.npm_unpacked_bytes,
        packed_install: true,
      },
      registration: {
        name: implementation.final_artifact_registration,
        command: 'madar',
        args: ['mcp'],
        workspace_hashed: true,
        exact_workspace_cwd: true,
        configuration_override_used: false,
        manual_tool_override_used: false,
      },
      codex: { passed: false },
      codex_stable_retry: { passed: false },
      codex_interactive_retry: { passed: true },
      stop: {
        historically_triggered: true,
        triggered: false,
      },
    })
    const finalClient = clientReceipt.final_candidate_revalidation
    expect(finalClient).toMatchObject({
      candidate_state: 'pre_pr_final_candidate',
      passed: true,
      artifact: {
        npm_shasum: implementation.npm_shasum,
        npm_integrity: implementation.npm_integrity,
        tarball_sha256: implementation.npm_tarball_sha256,
        files: implementation.npm_files,
        packed_bytes: implementation.npm_packed_bytes,
        unpacked_bytes: implementation.npm_unpacked_bytes,
        preceding_packed_bytes: THIN_DELIVERY_BASE_NPM_PACKED_BYTES,
        packed_bytes_delta: implementation.npm_packed_bytes_delta,
        packed_install: true,
        installed_package_is_symlink: false,
      },
      fixture: {
        head: '9b036583bab1dbd6fc38b6180e6bad73b4875e23',
        status_before: '?? out/',
        status_after: '?? out/',
      },
      registration: {
        name: implementation.final_artifact_registration,
        command: 'madar',
        args: ['mcp'],
        workspace_hashed: true,
        exact_workspace_cwd: true,
      },
      codex: {
        version: '0.145.0',
        thread_id: implementation.final_artifact_codex_session,
        tool_approval: 'one_call_allow',
        tool_approval_persisted: false,
        terminal_event: 'mcp_tool_call_end',
        server: implementation.final_artifact_registration,
        tool: 'retrieve',
        result: 'Ok',
      },
      claude: {
        version: '2.1.218',
        session_id: implementation.final_artifact_claude_session,
        tool: `mcp__${implementation.final_artifact_registration}__retrieve`,
      },
      cleanup: {
        supported_install_used: true,
        supported_uninstall_used: true,
        repository_changes: 'none',
        codex_config_restored_sha256:
          'fbfa000be5a6248766818b54cf2ec881dd8d88b578a3323e204c22408a414703',
        claude_config_restored_sha256:
          '9bb18a350ae4616e4a382025b366af0f15145bb209d6300af4a38736d36068fd',
        claude_home_routing_restored_sha256:
          '576e6cc125d7e1f236eb7b4ffa414d0b31a36562374a22202b646af08242cff2',
        all_captured_configuration_restored_byte_exact: true,
      },
      github_records: {
        issue_602: THIN_DELIVERY_FINAL_CLIENT_ISSUE_RECEIPT,
        rfc_577: THIN_DELIVERY_FINAL_CLIENT_RFC_RECEIPT,
      },
      claims: {
        normal_codex_tools_call_proved: true,
        normal_claude_tools_call_proved: true,
        client_transport_passed: true,
        stop_condition_triggered: false,
        implementation_pr_opened: false,
        implementation_merge_authorized: false,
        thin_delivery_complete: false,
      },
    })
    const expectedQuestion = 'Where is scheduleConstellationRetry defined and what calls it?'
    for (const client of [finalClient.codex, finalClient.claude]) {
      expect(client).toMatchObject({
        normal_launch: true,
        launch_mode: 'interactive',
        configuration_override_used: false,
        manual_tool_override_used: false,
        dangerous_bypass_used: false,
        question: expectedQuestion,
        budget: 1_000,
        retrieve_call_count: 1,
        result_received: true,
        matched_source: 'src/payment-retry.ts',
        provenance: 'src/payment-retry.ts:L1-L3',
        final_response: 'evidence — src/payment-retry.ts',
        passed: true,
      })
    }

    const evaluator = read(EVIDENCE_HELDOUT_EVALUATOR)
    const normalizedEvaluator = evaluator.replaceAll(THIN_DELIVERY_BIN, THIN_DELIVERY_HISTORICAL_BIN)
    expect(evaluator.split(THIN_DELIVERY_BIN)).toHaveLength(3)
    expect(createHash('sha256').update(evaluator).digest('hex'))
      .toBe(THIN_DELIVERY_REPINNED_EVALUATOR_SHA256)
    expect(createHash('sha256').update(normalizedEvaluator).digest('hex'))
      .toBe(THIN_DELIVERY_HISTORICAL_EVALUATOR_SHA256)
    expect(gitBlobSha256(THIN_DELIVERY_IMPLEMENTATION_START, EVIDENCE_HELDOUT_EVALUATOR))
      .toBe(THIN_DELIVERY_HISTORICAL_EVALUATOR_SHA256)

    type HeldOutReceiptSchema = {
      properties: {
        protocol: {
          properties: Record<string, unknown>
        }
      }
    }
    const historicalReceiptSchema = JSON.parse(execFileSync(
      git,
      ['show', `${THIN_DELIVERY_IMPLEMENTATION_START}:${EVIDENCE_HELDOUT_RECEIPT_SCHEMA}`],
      { encoding: 'utf8' },
    )) as HeldOutReceiptSchema
    const currentReceiptSchema = JSON.parse(read(EVIDENCE_HELDOUT_RECEIPT_SCHEMA)) as HeldOutReceiptSchema
    const historicalGenerateCommand = ['node', THIN_DELIVERY_HISTORICAL_BIN, 'generate', '.']
    const currentGenerateCommand = ['node', THIN_DELIVERY_BIN, 'generate', '.']
    expect(currentReceiptSchema.properties.protocol.properties.candidate_generate_command).toEqual({
      oneOf: [
        { const: historicalGenerateCommand },
        { const: currentGenerateCommand },
      ],
    })
    const normalizedReceiptSchema = structuredClone(currentReceiptSchema)
    normalizedReceiptSchema.properties.protocol.properties.candidate_generate_command = {
      const: historicalGenerateCommand,
    }
    expect(normalizedReceiptSchema).toEqual(historicalReceiptSchema)
    expect(gitBlobSha256(THIN_DELIVERY_IMPLEMENTATION_START, EVIDENCE_HELDOUT_RECEIPT_SCHEMA))
      .toBe(THIN_DELIVERY_HISTORICAL_RECEIPT_SCHEMA_SHA256)
    expect(createHash('sha256').update(read(EVIDENCE_HELDOUT_RECEIPT_SCHEMA)).digest('hex'))
      .toBe(THIN_DELIVERY_DUAL_PATH_RECEIPT_SCHEMA_SHA256)

    expect(manifest.review).toMatchObject({ disposition_changes: 11 })
    expect(manifest.review.amendment).toContain('exact 16-file / 7,277-LOC thin-delivery deletion contract')
  })

  it('records the exact completed Evaluation Tooling implementation and receipts', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      review: { disposition_changes: number; amendment: string }
      current: {
        completed_phase: string
        active_phase: string | null
        ready_phase: string | null
        base_commit: string
        completed_phase_commit: string
        production_typescript_files: number
        production_typescript_loc: number
        production_loc_added: number
        production_loc_removed: number
        production_loc_net: number
        npm_files: number
        npm_packed_bytes: number
        npm_unpacked_bytes: number
      }
      items: Array<Record<string, unknown> & {
        id: string
        status: string
        sources?: string[]
        transferred_sources?: string[]
      }>
    }

    expect(execFileSync(
      git,
      ['rev-parse', `${EVALUATION_TOOLING_BASE}^{tree}`],
      { encoding: 'utf8' },
    ).trim()).toBe(EVALUATION_TOOLING_BASE_TREE)
    expect(execFileSync(
      git,
      ['rev-parse', `${EVALUATION_TOOLING_BASE}:src`],
      { encoding: 'utf8' },
    ).trim()).toBe(EVALUATION_TOOLING_SRC_TREE)
    expect(execFileSync(
      git,
      ['rev-parse', `${EVALUATION_TOOLING_FINAL_HEAD}^{tree}`],
      { encoding: 'utf8' },
    ).trim()).toBe(EVALUATION_TOOLING_FINAL_TREE)
    expect(execFileSync(
      git,
      ['rev-parse', `${EVALUATION_TOOLING_MERGE}^{tree}`],
      { encoding: 'utf8' },
    ).trim()).toBe(EVALUATION_TOOLING_FINAL_TREE)
    expect(execFileSync(
      git,
      ['rev-list', '--parents', '-n', '1', EVALUATION_TOOLING_MERGE],
      { encoding: 'utf8' },
    ).trim()).toBe(`${EVALUATION_TOOLING_MERGE} ${EVALUATION_TOOLING_ACTIVATION_MERGE}`)
    expect(() => execFileSync(
      git,
      ['merge-base', '--is-ancestor', EVALUATION_TOOLING_ACTIVATION_MERGE, EVALUATION_TOOLING_MERGE],
    )).not.toThrow()
    expect(manifest.current).toMatchObject({
      completed_phase: RETRIEVAL_REGRESSION_ID,
      active_phase: null,
      ready_phase: 'release-beta',
      base_commit: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
      completed_phase_commit: 'eaa1a8781eda28dad5395d6da378a2cc40bf81fe',
      production_typescript_files: 43,
      production_typescript_loc: 12_008,
      production_loc_added: 69,
      production_loc_removed: 17,
      production_loc_net: 52,
      npm_files: 102,
      npm_packed_bytes: 160_319,
      npm_unpacked_bytes: 639_962,
    })
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual([])

    const evaluation = manifest.items.find((item) => item.id === 'evaluation-tooling')
    expect(evaluation).toMatchObject({
      disposition: 'move',
      status: 'complete',
      sources: [...EVALUATION_TOOLING_PREDECESSORS],
      transferred_sources: [...EVALUATION_TOOLING_TRANSFERS],
      destination: 'tools/eval/lib/** with tsconfig.eval.json and development-only dist-eval/** output',
      predecessor_contract: {
        files_exact: 20,
        production_loc_exact: 4_698,
        safe_workspace_transfers: 2,
        retained_thin_delivery_transfers: 2,
        audited_development_callers: 5,
      },
      audited_development_callers: [...EVALUATION_TOOLING_DEVELOPMENT_CALLERS],
      production_file_budget: { added_max: 0, removed_exact: 20 },
      production_loc_budget: {
        added_max: 0,
        removed_min: 4_698,
        removed_exact: 4_698,
        net_max: -4_698,
        net_exact: -4_698,
      },
      final_source_budget: { files_exact: 43, loc_exact: 11_956 },
      dependency_contract: { added: 0, removed: 0, upgraded: 0 },
      build_contract: {
        config: 'tsconfig.eval.json',
        package_script: 'build:eval',
        output: 'dist-eval/**',
        ignore_rule: 'dist-eval/',
        production_config: 'tsconfig.build.json',
        production_root: 'src/**',
        evaluator_output_in_dist: 'forbidden',
        evaluator_output_in_npm: 'forbidden',
        evaluator_output_in_prepack: 'forbidden',
      },
      package_isolation_contract: {
        moved_modules_rejected_exact: 20,
        dist_eval_rejected: true,
        generic_evaluation_assets_summary_insufficient: true,
        clean_production_build_and_npm_pack_required: true,
      },
      movement_contract: {
        preserve_module_grouping: true,
        delete_old_src_locations: 'required',
        surviving_production_typescript_edits: 0,
        production_typescript_files_added: 0,
        compatibility_aliases: 'forbidden',
        forwarding_modules: 'forbidden',
        fallback_imports: 'forbidden',
        duplicate_src_copies: 'forbidden',
        permitted_rewrites: [
          'relative-imports',
          'test-imports',
          'script-paths',
          'CI-paths',
          'documentation-paths',
        ],
      },
      npm_package_projection: {
        files: 102,
        packed_bytes: 159_748,
        unpacked_bytes: 637_551,
      },
      npm_package_budget: {
        files_max: 102,
        packed_bytes_max: 165_000,
        unpacked_bytes_max: 640_000,
      },
      frozen_contract: {
        production_semantics:
          'graph_index_generation_reconciliation_retrieval_ranking_traversal_slicing',
        public_surfaces: 'cli_mcp_installer_workspace',
        token_budgets_and_request_timeouts: 'frozen',
        held_out_performance_contracts_and_receipts: 'byte_identical',
        repositories_prompts_expected_evidence_grading_schemas_limits_hashes_isolation_and_timeouts:
          'frozen',
        ci_recall_percent_min: 90,
        ci_mrr_min: 0.95,
        ci_snippet_coverage_percent_min: 95,
        grounded_match_rate: 'report_only',
      },
      capability_validation: {
        blinded_runner_exists: false,
        status: 'separately_activated_under_610',
        runner_design_in_scope: false,
        graphify_integration_in_scope: false,
        historical_no_html_restoration: 'forbidden',
      },
      review_contract: {
        ci_matrix_jobs: 6,
        independent_exact_head_review: 'required',
        coderabbit_actual_disposition_must_be_honest: true,
        unresolved_review_threads: 0,
      },
      activation: {
        issue: EVALUATION_TOOLING_ISSUE,
        owner_approval: EVALUATION_TOOLING_OWNER_APPROVAL,
        rfc_amendment: EVALUATION_TOOLING_RFC_APPROVAL,
        protected_base: EVALUATION_TOOLING_BASE,
        protected_src_tree: EVALUATION_TOOLING_SRC_TREE,
        target_branch: 'core-reset',
        implementation_start_commit: EVALUATION_TOOLING_ACTIVATION_MERGE,
        implementation_started: true,
      },
      implementation: {
        candidate_state: 'merged_exact_implementation',
        implementation_start_commit: EVALUATION_TOOLING_ACTIVATION_MERGE,
        production_typescript_files: 43,
        production_typescript_loc: 11_956,
        production_files_added: 0,
        production_files_removed: 20,
        production_loc_added: 0,
        production_loc_removed: 4_698,
        production_loc_net: -4_698,
        surviving_production_typescript_edits: 0,
        moved_evaluation_typescript_files: 20,
        moved_evaluation_typescript_loc: 4_698,
        npm_files: 102,
        npm_packed_bytes: 159_759,
        npm_unpacked_bytes: 637_602,
        npm_shasum: '6eee13af22e8c76113fe578e44d76a9e6d6fd899',
        npm_integrity:
          'sha512-B/+Bjh9O2xlB0VsVtDn1xFsUnIPpd//GptyVCZa9mV3nASLg6LMDWoW0GNJx+sYG3GGDIJm5azAMfF+Hh9Yp0w==',
        dependencies_added: 0,
        dependencies_removed: 0,
        dependencies_upgraded: 0,
        package_lock_unchanged: true,
        exact_move_passed: true,
        evaluator_build_boundary_passed: true,
        audited_development_callers_rewired: 5,
        directly_importing_tests_rewired: true,
        production_build_isolation_passed: true,
        npm_package_isolation_passed: true,
        frozen_evidence_byte_identical: true,
        source_and_package_budgets_passed: true,
      },
      completion: {
        issue: EVALUATION_TOOLING_ISSUE,
        pull_request: 'https://github.com/mohanagy/madar/pull/608',
        commit: EVALUATION_TOOLING_MERGE,
        final_pr_head: EVALUATION_TOOLING_FINAL_HEAD,
        final_pr_tree: EVALUATION_TOOLING_FINAL_TREE,
        ci_head: EVALUATION_TOOLING_FINAL_HEAD,
        outcome: 'evaluation_tooling_isolated_from_production_and_npm',
        production_files_added: 0,
        production_files_removed: 20,
        production_typescript_files: 43,
        production_typescript_loc: 11_956,
        production_loc_added: 0,
        production_loc_removed: 4_698,
        production_loc_net: -4_698,
        surviving_production_typescript_edits: 0,
        moved_evaluation_typescript_files: 20,
        moved_evaluation_typescript_loc: 4_698,
        dependencies_added: 0,
        dependencies_removed: 0,
        dependencies_upgraded: 0,
        package_lock_unchanged: true,
        npm_files: 102,
        npm_packed_bytes: 159_759,
        npm_unpacked_bytes: 637_602,
        npm_shasum: '6eee13af22e8c76113fe578e44d76a9e6d6fd899',
        npm_integrity:
          'sha512-B/+Bjh9O2xlB0VsVtDn1xFsUnIPpd//GptyVCZa9mV3nASLg6LMDWoW0GNJx+sYG3GGDIJm5azAMfF+Hh9Yp0w==',
        base_to_head_diff_sha256:
          'aa75782ad9216c4b82e4279224db7bb820f72b2f8e4bb1cd4baf63cb8a286167',
        exact_move_passed: true,
        evaluator_build_boundary_passed: true,
        audited_development_callers_rewired: 5,
        directly_importing_tests_rewired: true,
        production_build_isolation_passed: true,
        npm_package_isolation_passed: true,
        frozen_evidence_byte_identical: true,
        source_and_package_budgets_passed: true,
        ci_matrix_jobs_passed: 6,
        ci_run: EVALUATION_TOOLING_CI_RUN,
        test_files_passed: 74,
        tests_total: 620,
        tests_passed: 617,
        tests_skipped: 3,
        coverage_statements_percent: 81.57,
        coverage_branches_percent: 73.05,
        coverage_functions_percent: 89.04,
        coverage_lines_percent: 85.45,
        eval_recall_percent: 100,
        eval_mrr: 1,
        eval_snippet_coverage_percent: 100,
        eval_grounded_match_percent_report_only: 100,
        coderabbit: 'skipped_non_default_base',
        coderabbit_receipt: EVALUATION_TOOLING_CODERABBIT_RECEIPT,
        independent_review: 'passed',
        independent_reviews_passed: 3,
        independent_review_receipt: EVALUATION_TOOLING_REVIEW_RECEIPT,
        unresolved_review_threads: 0,
        merge_gate_receipt: EVALUATION_TOOLING_MERGE_GATE_RECEIPT,
        issue_merge_receipt: EVALUATION_TOOLING_ISSUE_MERGE_RECEIPT,
        rfc_merge_receipt: EVALUATION_TOOLING_RFC_MERGE_RECEIPT,
      },
    })

    const safeWorkspace = manifest.items.find((item) => item.id === 'safe-workspace-primitives')
    expect(safeWorkspace?.sources).not.toEqual(expect.arrayContaining([
      'src/shared/graph-source-root.ts',
      'src/shared/workspace-copy.ts',
    ]))
    expect(manifest.review).toMatchObject({ disposition_changes: 11 })
    expect(manifest.review.amendment).toContain('Owner-approved issue #606')
    expect(manifest.review.amendment).toContain('exact 20-file / 4,698-LOC move contract')
    expect(manifest.review.amendment).toContain('First-stage owner-approved issue #610')

    const baseFiles = productionTypeScriptFilesAtCommit(EVALUATION_TOOLING_BASE)
    expect(baseFiles).toHaveLength(63)
    expect(EVALUATION_TOOLING_PREDECESSORS.every((path) => baseFiles.includes(path))).toBe(true)
    expect(logicalLocAtCommit(EVALUATION_TOOLING_BASE, EVALUATION_TOOLING_PREDECESSORS))
      .toBe(4_698)
    const edges = deletionImportEdgesAtCommit(
      EVALUATION_TOOLING_BASE,
      new Set(EVALUATION_TOOLING_PREDECESSORS),
    )
    expect(edges.all).toEqual(edges.internal)
    expect(edges.all).toHaveLength(30)
    expect(edgeListSha256(edges.all))
      .toBe('5826a96e6d88206e1a2a69dc004160b4bea94b86315e9f0dec8eb540e40b6c1f')
    expect(edges.surviving).toEqual([])
    expect(edgeListSha256(edges.surviving))
      .toBe('01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b')

    expect(execFileSync(
      git,
      ['rev-parse', `${EVALUATION_TOOLING_ACTIVATION_MERGE}^{tree}`],
      { encoding: 'utf8' },
    ).trim()).toBe(EVALUATION_TOOLING_ACTIVATION_TREE)
    const activationDiff = execFileSync(
      git,
      ['diff', '--name-only', EVALUATION_TOOLING_BASE, EVALUATION_TOOLING_ACTIVATION_MERGE, '--'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort()
    expect(activationDiff).toEqual([...EVALUATION_TOOLING_ACTIVATION_FILES].sort())
    expect(() => execFileSync(git, [
      'diff',
      '--exit-code',
      EVALUATION_TOOLING_BASE,
      EVALUATION_TOOLING_ACTIVATION_MERGE,
      '--',
      'src',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.build.json',
    ])).not.toThrow()
    expect(() => execFileSync(
      git,
      [
        'diff',
        '--exit-code',
        EVALUATION_TOOLING_BASE,
        EVALUATION_TOOLING_ACTIVATION_MERGE,
        '--',
        ...EVALUATION_TOOLING_FROZEN_EVIDENCE,
      ],
    )).not.toThrow()

    const evaluatorDestinations = EVALUATION_TOOLING_PREDECESSORS
      .map((path) => `tools/eval/lib/${path.slice('src/'.length)}`)
    const productionFiles = productionTypeScriptFilesAtCommit(EVALUATION_TOOLING_MERGE).sort()
    const evaluatorFiles = productionTypeScriptFiles('tools/eval/lib').sort()
    expect({
      files: productionFiles.length,
      loc: logicalLocAtCommit(EVALUATION_TOOLING_MERGE, productionFiles),
      filesystemViolations: sourceInventory().filesystemViolations,
    }).toMatchObject({
      files: 43,
      loc: 11_956,
      filesystemViolations: [],
    })
    expect(evaluatorFiles).toEqual([...evaluatorDestinations].sort())
    expect(evaluatorFiles.reduce((total, path) => {
      const source = read(path)
      const lineFeeds = source.match(/\n/g)?.length ?? 0
      return total + lineFeeds + (source.length > 0 && !source.endsWith('\n') ? 1 : 0)
    }, 0)).toBe(4_698)

    const changedProduction = execFileSync(
      git,
      [
        'diff',
        '--name-only',
        EVALUATION_TOOLING_ACTIVATION_MERGE,
        EVALUATION_TOOLING_MERGE,
        '--',
        'src',
      ],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort()
    expect(changedProduction).toEqual([...EVALUATION_TOOLING_PREDECESSORS].sort())
    expect(productionSourceDeltaBetween(
      EVALUATION_TOOLING_ACTIVATION_MERGE,
      EVALUATION_TOOLING_MERGE,
    ))
      .toEqual({ added: 0, removed: 4_698, net: -4_698 })
    for (const predecessor of EVALUATION_TOOLING_PREDECESSORS) {
      expect(existsSync(resolve(predecessor)), `${predecessor} must be absent`).toBe(false)
    }
    for (const destination of evaluatorDestinations) {
      expect(existsSync(resolve(destination)), `${destination} must exist`).toBe(true)
    }
    expect(productionFiles).toHaveLength(43)

    const evalConfig = JSON.parse(read('tsconfig.eval.json')) as Record<string, unknown>
    expect(evalConfig).toEqual({
      extends: './tsconfig.json',
      compilerOptions: {
        types: ['node'],
        rootDir: '.',
        outDir: 'dist-eval',
        noEmitOnError: true,
      },
      include: ['tools/eval/lib/**/*.ts'],
      exclude: ['tests/**/*.ts', 'dist', 'dist-eval', 'vitest.config.ts'],
    })
    expect(() => execFileSync(git, [
      'diff',
      '--exit-code',
      EVALUATION_TOOLING_ACTIVATION_MERGE,
      '--',
      'tsconfig.json',
      'tsconfig.build.json',
    ])).not.toThrow()
    expect(read('.gitignore').split(/\r?\n/)).toContain('dist-eval/')

    type EvaluationPackage = {
      version: string
      scripts: Record<string, string>
      files: string[]
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      optionalDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const activationPackage = JSON.parse(execFileSync(
      git,
      ['show', `${EVALUATION_TOOLING_ACTIVATION_MERGE}:package.json`],
      { encoding: 'utf8' },
    )) as EvaluationPackage
    const currentPackage = JSON.parse(read('package.json')) as EvaluationPackage
    const implementationPackage = JSON.parse(execFileSync(
      git,
      ['show', `${EVALUATION_TOOLING_MERGE}:package.json`],
      { encoding: 'utf8' },
    )) as EvaluationPackage
    expect(implementationPackage).toEqual({
      ...activationPackage,
      scripts: {
        ...activationPackage.scripts,
        'build:eval': 'tsc -p tsconfig.eval.json',
      },
    })
    expect(currentPackage).toEqual({
      ...implementationPackage,
      version: '0.40.0-beta.2',
      scripts: {
        ...implementationPackage.scripts,
        'publish:next': 'npm publish --tag next --access public --provenance',
      },
    })
    expect(currentPackage.files).not.toContain('dist-eval/')
    expect(currentPackage.scripts.prepack).not.toContain('build:eval')
    const implementationLock = JSON.parse(execFileSync(
      git,
      ['show', `${EVALUATION_TOOLING_MERGE}:package-lock.json`],
      { encoding: 'utf8' },
    )) as any
    const currentLock = JSON.parse(read('package-lock.json')) as any
    expect(currentLock).toEqual({
      ...implementationLock,
      version: '0.40.0-beta.2',
      packages: {
        ...implementationLock.packages,
        '': {
          ...implementationLock.packages[''],
          version: '0.40.0-beta.2',
        },
      },
    })

    const rewiredCallers = execFileSync(
      git,
      [
        'diff',
        '--name-only',
        EVALUATION_TOOLING_ACTIVATION_MERGE,
        EVALUATION_TOOLING_MERGE,
        '--',
        ...EVALUATION_TOOLING_DEVELOPMENT_CALLERS,
      ],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).sort()
    expect(rewiredCallers).toEqual([...EVALUATION_TOOLING_DEVELOPMENT_CALLERS].sort())
    for (const [caller, target] of Object.entries(EVALUATION_TOOLING_DEVELOPMENT_CALLER_TARGETS)) {
      expect(read(caller), `${caller} must use the isolated evaluator output`).toContain(target)
    }
    for (const testPath of EVALUATION_TOOLING_DIRECT_TESTS) {
      expect(read(testPath), `${testPath} must use the isolated evaluator source`).toContain(
        'tools/eval/lib/',
      )
    }
    expect(read('.github/workflows/ci.yml')).toContain('run: npm run build:eval')

    expect(() => execFileSync(
      git,
      [
        'diff',
        '--exit-code',
        EVALUATION_TOOLING_ACTIVATION_MERGE,
        EVALUATION_TOOLING_MERGE,
        '--',
        'docs/core-reset/evidence',
        'tools/eval/core-reset/contracts',
        'tools/eval/core-reset/schemas',
      ],
    )).not.toThrow()
    expect(() => execFileSync(
      git,
      [
        'diff',
        '--exit-code',
        EVALUATION_TOOLING_ACTIVATION_MERGE,
        EVALUATION_TOOLING_MERGE,
        '--',
        ...EVALUATION_TOOLING_FROZEN_EVIDENCE,
      ],
    )).not.toThrow()
  })

  it('freezes the stopped Capability Validation v1 contract and first-stop receipt', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      current: Record<string, unknown>
      items: Array<Record<string, unknown> & { id: string; status: string }>
    }
    const phase = manifest.items.find((item) => item.id === 'capability-validation') as
      | (Record<string, unknown> & {
        governance_assets: {
          contract: { path: string; sha256: string }
          contract_schema: { path: string; sha256: string }
          receipt_schema: { path: string; sha256: string }
        }
      })
      | undefined
    expect(manifest.current).toMatchObject({
      completed_phase: RETRIEVAL_REGRESSION_ID,
      active_phase: null,
      ready_phase: 'release-beta',
      base_commit: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
      production_typescript_files: 43,
      production_typescript_loc: 12_008,
      production_loc_added: 69,
      production_loc_removed: 17,
      production_loc_net: 52,
    })
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual([])
    expect(phase).toMatchObject({
      disposition: 'keep',
      status: 'stopped',
      production_file_budget: { added_max: 0, removed_exact: 0 },
      production_loc_budget: { added_max: 0, removed_exact: 0, net_exact: 0 },
      anchor: {
        commit: CAPABILITY_VALIDATION_BASE,
        tree: CAPABILITY_VALIDATION_BASE_TREE,
        src_tree: CAPABILITY_VALIDATION_SRC_TREE,
        tools_eval_tree: CAPABILITY_VALIDATION_TOOLS_EVAL_TREE,
      },
      activation: {
        issue: CAPABILITY_VALIDATION_ISSUE,
        proposal_receipt: CAPABILITY_VALIDATION_PROPOSAL_RECEIPT,
        rfc_proposal_receipt: CAPABILITY_VALIDATION_RFC_PROPOSAL_RECEIPT,
        owner_approval: CAPABILITY_VALIDATION_OWNER_APPROVAL,
        rfc_amendment: CAPABILITY_VALIDATION_RFC_APPROVAL,
        protected_base: CAPABILITY_VALIDATION_BASE,
        target_branch: 'core-reset',
        second_owner_hash_approval: 'passed',
        activation_head: '80e942a8a28e3895465aa9ca432c4a926054055d',
        activation_merge: CAPABILITY_VALIDATION_V2_BASE,
        activation_tree: CAPABILITY_VALIDATION_V2_BASE_TREE,
      },
      stop: {
        conditions: [7, 8, 13],
        issue_receipt: CAPABILITY_VALIDATION_STOP_ISSUE_RECEIPT,
        issue_receipt_body_sha256: CAPABILITY_VALIDATION_STOP_BODY_HASHES.issue,
        rfc_receipt: CAPABILITY_VALIDATION_STOP_RFC_RECEIPT,
        rfc_receipt_body_sha256: CAPABILITY_VALIDATION_STOP_BODY_HASHES.rfc,
        implementation_pr_opened: false,
        campaign_lock_created: false,
        provider_requests: 0,
        spend_usd: 0,
      },
    })

    expect(execFileSync(git, ['rev-parse', `${CAPABILITY_VALIDATION_BASE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(CAPABILITY_VALIDATION_BASE_TREE)
    expect(execFileSync(git, ['rev-parse', `${CAPABILITY_VALIDATION_BASE}:src`], { encoding: 'utf8' }).trim())
      .toBe(CAPABILITY_VALIDATION_SRC_TREE)
    expect(execFileSync(git, ['rev-parse', `${CAPABILITY_VALIDATION_BASE}:tools/eval`], { encoding: 'utf8' }).trim())
      .toBe(CAPABILITY_VALIDATION_TOOLS_EVAL_TREE)

    for (const [path, expected] of Object.entries(CAPABILITY_VALIDATION_FROZEN_HASHES)) {
      expect(gitBlobSha256(CAPABILITY_VALIDATION_V2_BASE, path), path).toBe(expected)
    }
    let assetLines = 0
    for (const [path, expected] of Object.entries(CAPABILITY_VALIDATION_ASSET_HASHES)) {
      expect(existsSync(resolve(path)), path).toBe(true)
      const source = read(path)
      assetLines += source.match(/\n/g)?.length ?? 0
      assetLines += source.length > 0 && !source.endsWith('\n') ? 1 : 0
      expect(createHash('sha256').update(source).digest('hex'), path).toBe(expected)
    }
    expect(assetLines).toBeLessThanOrEqual(2_300)
    expect(phase?.governance_assets).toMatchObject({
      contract: {
        path: CAPABILITY_VALIDATION_CONTRACT,
        sha256: CAPABILITY_VALIDATION_ASSET_HASHES[CAPABILITY_VALIDATION_CONTRACT],
      },
      contract_schema: {
        path: CAPABILITY_VALIDATION_CONTRACT_SCHEMA,
        sha256: CAPABILITY_VALIDATION_ASSET_HASHES[CAPABILITY_VALIDATION_CONTRACT_SCHEMA],
      },
      receipt_schema: {
        path: CAPABILITY_VALIDATION_RECEIPT_SCHEMA,
        sha256: CAPABILITY_VALIDATION_ASSET_HASHES[CAPABILITY_VALIDATION_RECEIPT_SCHEMA],
      },
    })

    const contract = JSON.parse(read(CAPABILITY_VALIDATION_CONTRACT)) as {
      contract_id: string
      governance: { proposal_body_sha256: string; target_branch: string; forbidden_branch: string }
      inheritance: { pointers: string[] }
      provider: { system: string }
      blinding: { pseudonym: { format: string }; blind_bundle_allowed_fields: string[] }
      graphify: {
        combined_jcs: { initialize: { serverInfo: { name: string } } }
        combined_bytes: number
        combined_sha256: string
        resolved_constraints: string[]
        resolved_constraints_sha256: string
      }
      raw_tools: {
        provider_order: string[]
        tool_definitions: Array<{ name: string; description: string }>
        tool_definitions_jcs_sha256: string
        result_schema: unknown
        result_schema_jcs_sha256: string
        semantics: unknown
        semantics_jcs_sha256: string
        path_policy: unknown
        path_policy_jcs_sha256: string
        error_messages: unknown
        error_messages_jcs_sha256: string
        aggregate_hashes_jcs_sha256: string
      }
      campaign: { blocking_answers: number; tool_call_budget: number; timeout_seconds: number }
    }
    const contractSchema = JSON.parse(read(CAPABILITY_VALIDATION_CONTRACT_SCHEMA))
    const receiptSchema = JSON.parse(read(CAPABILITY_VALIDATION_RECEIPT_SCHEMA)) as {
      $defs: Record<string, unknown>
    }
    // @ts-expect-error -- Ajv's NodeNext declaration shape differs from its runtime default export
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    // @ts-expect-error -- ajv-formats has the same declaration/runtime mismatch
    addFormats(ajv)
    const validate = ajv.compile(contractSchema)
    expect(validate(contract), ajv.errorsText(validate.errors)).toBe(true)
    expect(() => ajv.compile(receiptSchema)).not.toThrow()
    const mutations: Array<(candidate: typeof contract) => void> = [
      (candidate) => { candidate.inheritance.pointers.pop() },
      (candidate) => { candidate.provider.system += ' drift' },
      (candidate) => { candidate.raw_tools.tool_definitions[0]!.description += ' drift' },
      (candidate) => { candidate.graphify.combined_jcs.initialize.serverInfo.name = 'drift' },
      (candidate) => { candidate.blinding.pseudonym.format = 'drift' },
    ]
    for (const mutate of mutations) {
      const mutated = structuredClone(contract)
      mutate(mutated)
      expect(validate(mutated)).toBe(false)
    }
    expect(contract).toMatchObject({
      contract_id: 'core-reset-capability-validation-v1',
      governance: {
        proposal_body_sha256: CAPABILITY_VALIDATION_PROPOSAL_SHA256,
        target_branch: 'core-reset',
        forbidden_branch: 'main',
      },
      campaign: { blocking_answers: 60, tool_call_budget: 12, timeout_seconds: 300 },
    })
    expect(contract.raw_tools.provider_order).toEqual(['read', 'search', 'list', 'shell-read-only'])
    expect(contract.raw_tools.tool_definitions.map((tool) => tool.name))
      .toEqual(contract.raw_tools.provider_order)
    for (const [value, expected] of [
      [contract.raw_tools.tool_definitions, contract.raw_tools.tool_definitions_jcs_sha256],
      [contract.raw_tools.result_schema, contract.raw_tools.result_schema_jcs_sha256],
      [contract.raw_tools.semantics, contract.raw_tools.semantics_jcs_sha256],
      [contract.raw_tools.path_policy, contract.raw_tools.path_policy_jcs_sha256],
      [contract.raw_tools.error_messages, contract.raw_tools.error_messages_jcs_sha256],
    ] as const) {
      expect(createHash('sha256').update(canonicalJson(value)).digest('hex')).toBe(expected)
    }
    const rawToolComponentHashes = {
      tool_definitions_jcs_sha256: contract.raw_tools.tool_definitions_jcs_sha256,
      path_policy_jcs_sha256: contract.raw_tools.path_policy_jcs_sha256,
      result_schema_jcs_sha256: contract.raw_tools.result_schema_jcs_sha256,
      error_messages_jcs_sha256: contract.raw_tools.error_messages_jcs_sha256,
      semantics_jcs_sha256: contract.raw_tools.semantics_jcs_sha256,
    }
    expect(createHash('sha256').update(canonicalJson(rawToolComponentHashes)).digest('hex'))
      .toBe(contract.raw_tools.aggregate_hashes_jcs_sha256)
    for (const definition of ['campaignLock', 'campaignLockPass']) {
      const lock = receiptSchema.$defs[definition] as {
        properties: {
          raw_semantics_sha256: { const: string }
          raw_tools_aggregate_sha256: { const: string }
        }
      }
      expect(lock.properties.raw_semantics_sha256.const).toBe(contract.raw_tools.semantics_jcs_sha256)
      expect(lock.properties.raw_tools_aggregate_sha256.const)
        .toBe(contract.raw_tools.aggregate_hashes_jcs_sha256)
    }
    const graphifyJcs = canonicalJson(contract.graphify.combined_jcs)
    expect(Buffer.byteLength(graphifyJcs)).toBe(contract.graphify.combined_bytes)
    expect(createHash('sha256').update(graphifyJcs).digest('hex'))
      .toBe(contract.graphify.combined_sha256)
    const constraints = `${contract.graphify.resolved_constraints.join('\n')}\n`
    expect(contract.graphify.resolved_constraints).toHaveLength(59)
    expect(createHash('sha256').update(constraints).digest('hex'))
      .toBe(contract.graphify.resolved_constraints_sha256)
    expect(Object.keys(receiptSchema.$defs)).toEqual(expect.arrayContaining([
      'blind_bundle',
      'review_score_payload',
      'review_attestation',
      'review_receipt',
      'adjudication_score_payload',
      'adjudication_attestation',
      'adjudication_receipt',
      'reveal_map',
    ]))
    const blindBundle = receiptSchema.$defs.blind_bundle as { properties: Record<string, unknown> }
    expect([...contract.blinding.blind_bundle_allowed_fields].sort())
      .toEqual(Object.keys(blindBundle.properties).sort())
    for (const definition of [
      'comparisonBlockPass_documenso_0',
      'comparisonBlockPass_documenso_0_7',
      'comparisonBlockPass_formbricks_0',
      'comparisonBlockPass_formbricks_0_7',
    ]) {
      const block = receiptSchema.$defs[definition] as {
        properties: { status: { const: string }; trials: { $ref: string } }
      }
      expect(block).toMatchObject({
        properties: { status: { const: 'complete' }, trials: { $ref: expect.any(String) } },
      })
      const trialsDefinition = block.properties.trials.$ref.replace('#/$defs/', '')
      expect(receiptSchema.$defs[trialsDefinition]).toMatchObject({ minItems: 15, maxItems: 15 })
    }
    for (const [definition, samples] of [
      ['refreshBlockPass_documenso_graphify', 'refreshSamplesGraphifyPass'],
      ['refreshBlockPass_documenso_madar', 'refreshSamplesMadarPass'],
      ['refreshBlockPass_formbricks_graphify', 'refreshSamplesGraphifyPass'],
      ['refreshBlockPass_formbricks_madar', 'refreshSamplesMadarPass'],
    ] as const) {
      expect(receiptSchema.$defs[definition]).toMatchObject({
        properties: { status: { const: 'complete' }, samples: { $ref: `#/$defs/${samples}` } },
      })
    }
    expect(receiptSchema.$defs.trialPassZero_documenso_0_native_agent_native_1).toMatchObject({
      properties: { status: { enum: ['failed', 'timed_out', 'invalid', 'budget_terminated'] } },
    })
    expect(receiptSchema.$defs.trialPassSuccess_documenso_0_native_agent_native_1).toMatchObject({
      properties: { status: { const: 'success' } },
    })
    expect(receiptSchema.$defs.diagnosticPassDisposition).toEqual({
      oneOf: [
        { $ref: '#/$defs/diagnosticSuccessPassDisposition' },
        { $ref: '#/$defs/diagnosticFailurePassDisposition' },
      ],
    })

    expect(() => execFileSync(git, [
      'diff', '--exit-code', CAPABILITY_VALIDATION_V2_BASE, '--',
      CAPABILITY_VALIDATION_CONTRACT,
      CAPABILITY_VALIDATION_CONTRACT_SCHEMA,
      CAPABILITY_VALIDATION_RECEIPT_SCHEMA,
    ])).not.toThrow()
  })

  it('freezes the exact activated and later stopped Capability Validation v2 successor', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      current: Record<string, unknown>
      items: Array<Record<string, unknown> & { id: string; status: string }>
    }
    const phase = manifest.items.find((item) => item.id === 'capability-validation-v2') as
      | (Record<string, unknown> & {
        governance_assets: {
          contract: { path: string; sha256: string }
          contract_schema: { path: string; sha256: string }
          receipt_schema: { path: string; sha256: string }
        }
      })
      | undefined
    expect(manifest.current).toMatchObject({
      completed_phase: RETRIEVAL_REGRESSION_ID,
      active_phase: null,
      ready_phase: 'release-beta',
      base_commit: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
      production_typescript_files: 43,
      production_typescript_loc: 12_008,
      production_loc_added: 69,
      production_loc_removed: 17,
      production_loc_net: 52,
    })
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual([])
    expect(phase).toMatchObject({
      disposition: 'keep',
      status: 'stopped',
      predecessor: 'capability-validation',
      supersedes: 'development implementation allowlist and LOC ceiling only',
      production_file_budget: { added_max: 0, removed_exact: 0 },
      production_loc_budget: { added_max: 0, removed_exact: 0, net_exact: 0 },
      anchor: {
        commit: CAPABILITY_VALIDATION_V2_BASE,
        tree: CAPABILITY_VALIDATION_V2_BASE_TREE,
        src_tree: CAPABILITY_VALIDATION_V2_SRC_TREE,
        tools_eval_tree: CAPABILITY_VALIDATION_V2_TOOLS_EVAL_TREE,
      },
      predecessor_stop: {
        conditions: [7, 8, 13],
        issue_receipt: CAPABILITY_VALIDATION_STOP_ISSUE_RECEIPT,
        issue_receipt_body_sha256: CAPABILITY_VALIDATION_STOP_BODY_HASHES.issue,
        rfc_receipt: CAPABILITY_VALIDATION_STOP_RFC_RECEIPT,
        rfc_receipt_body_sha256: CAPABILITY_VALIDATION_STOP_BODY_HASHES.rfc,
      },
      implementation_budget: {
        touched_paths_exact: 53,
        added_physical_lines_max: 29_130,
        removed_physical_lines_max: 350,
        activation_plus_implementation_added_max: 32_980,
        activation_plus_implementation_removed_max: 600,
        production_files_or_loc_changed: 0,
        dependencies_changed: 0,
        compatibility_aliases: 'forbidden',
      },
      governance_closure: {
        after: 'exact_offline_implementation_merge_only',
        added_physical_lines_max: 400,
        removed_physical_lines_max: 200,
        activation_plus_implementation_plus_closure_added_max: 33_380,
        activation_plus_implementation_plus_closure_removed_max: 800,
      },
      activation: {
        issue: CAPABILITY_VALIDATION_V2_ISSUE,
        proposal_receipt: CAPABILITY_VALIDATION_V2_PROPOSAL_RECEIPT,
        rfc_proposal_receipt: CAPABILITY_VALIDATION_V2_RFC_PROPOSAL_RECEIPT,
        owner_approval: CAPABILITY_VALIDATION_V2_OWNER_APPROVAL,
        rfc_amendment: CAPABILITY_VALIDATION_V2_RFC_APPROVAL,
        protected_base: CAPABILITY_VALIDATION_V2_BASE,
        target_branch: 'core-reset',
        second_owner_hash_approval: 'passed',
        activation_head: CAPABILITY_VALIDATION_V2_ACTIVATION_HEAD,
        activation_merge: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
        activation_tree: CAPABILITY_VALIDATION_V2_ACTIVATION_TREE,
        implementation_start_commit: 'not_started_cancelled',
      },
    })

    expect(execFileSync(git, ['rev-parse', `${CAPABILITY_VALIDATION_V2_BASE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(CAPABILITY_VALIDATION_V2_BASE_TREE)
    expect(execFileSync(git, ['rev-parse', `${CAPABILITY_VALIDATION_V2_BASE}:src`], { encoding: 'utf8' }).trim())
      .toBe(CAPABILITY_VALIDATION_V2_SRC_TREE)
    expect(execFileSync(git, ['rev-parse', `${CAPABILITY_VALIDATION_V2_BASE}:tools/eval`], { encoding: 'utf8' }).trim())
      .toBe(CAPABILITY_VALIDATION_V2_TOOLS_EVAL_TREE)
    expect(execFileSync(
      git,
      ['rev-parse', `${CAPABILITY_VALIDATION_V2_ACTIVATION_HEAD}^{tree}`],
      { encoding: 'utf8' },
    ).trim()).toBe(CAPABILITY_VALIDATION_V2_ACTIVATION_TREE)
    expect(execFileSync(
      git,
      ['rev-parse', `${CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE}^{tree}`],
      { encoding: 'utf8' },
    ).trim()).toBe(CAPABILITY_VALIDATION_V2_ACTIVATION_TREE)
    for (const [path, expected] of Object.entries(CAPABILITY_VALIDATION_ASSET_HASHES)) {
      expect(createHash('sha256').update(readFileSync(resolve(path))).digest('hex'), path).toBe(expected)
    }

    let assetLines = 0
    let assetBytes = 0
    for (const [path, expected] of Object.entries(CAPABILITY_VALIDATION_V2_ASSET_HASHES)) {
      const source = read(path)
      const lines = (source.match(/\n/g)?.length ?? 0) + (source.length > 0 && !source.endsWith('\n') ? 1 : 0)
      const bytes = Buffer.byteLength(source)
      assetLines += lines
      assetBytes += bytes
      const limit = CAPABILITY_VALIDATION_V2_ASSET_LIMITS[path]!
      expect(lines, path).toBeLessThanOrEqual(limit.lines)
      expect(bytes, path).toBeLessThanOrEqual(limit.bytes)
      expect(createHash('sha256').update(source).digest('hex'), path).toBe(expected)
    }
    expect(assetLines).toBeLessThanOrEqual(3_200)
    expect(assetBytes).toBeLessThanOrEqual(2_097_152)
    expect(phase?.governance_assets).toMatchObject({
      proposal_body_sha256: CAPABILITY_VALIDATION_V2_PROPOSAL_SHA256,
      exact_added_assets: 3,
      contract: {
        path: CAPABILITY_VALIDATION_V2_CONTRACT,
        sha256: CAPABILITY_VALIDATION_V2_ASSET_HASHES[CAPABILITY_VALIDATION_V2_CONTRACT],
      },
      contract_schema: {
        path: CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA,
        sha256: CAPABILITY_VALIDATION_V2_ASSET_HASHES[CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA],
      },
      receipt_schema: {
        path: CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA,
        sha256: CAPABILITY_VALIDATION_V2_ASSET_HASHES[CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA],
      },
    })

    expect(() => strictJson('{"duplicate":1,"duplicate":2}')).toThrow()
    expect(() => strictJson('{"invalid":"\\ud800"}')).toThrow()
    const v1Contract = readStrictJson(CAPABILITY_VALIDATION_CONTRACT)
    const contract = readStrictJson(CAPABILITY_VALIDATION_V2_CONTRACT) as any
    expect(contract).toMatchObject({
      contract_id: 'core-reset-capability-validation-v2',
      governance: {
        proposal_body_sha256: CAPABILITY_VALIDATION_V2_PROPOSAL_SHA256,
        target_branch: 'core-reset',
        forbidden_branch: 'main',
        activation_merge_authorized_by_first_stage: false,
        offline_implementation_authorized_by_first_stage: false,
        campaign_lock_authorized_by_first_stage: false,
        provider_request_authorized_by_first_stage: false,
        provider_spend_authorized_by_first_stage_cents: 0,
      },
      inheritance: {
        comparison: {
          allowed_difference_pointers: [...CAPABILITY_VALIDATION_V2_ALLOWED_DIFFERENCE_POINTERS],
          deny_unlisted: true,
        },
        source_stop_receipts: {
          issue_610_body_sha256: CAPABILITY_VALIDATION_STOP_BODY_HASHES.issue,
          rfc_577_body_sha256: CAPABILITY_VALIDATION_STOP_BODY_HASHES.rfc,
          matched_stop_condition_ids: [7, 8, 13],
        },
      },
      execution_boundary: {
        authorization: {
          current_scope: expect.stringContaining('publication of the activation branch and activation PR'),
          forbidden_under_first_stage: expect.arrayContaining(['npm/package/product publication']),
        },
        closure: {
          after: 'exact offline implementation merge only',
          records_only: expect.arrayContaining(['v2 offline execution boundary passed']),
          full_activation_implementation_closure_numstat: {
            max_added_lines: 33_380,
            max_removed_lines: 800,
          },
        },
        implementation: {
          exact_path_count: 53,
          global_numstat: { max_added_lines: 29_130, max_removed_lines: 350 },
        },
        review_and_merge: {
          activation_external_approval_audit: {
            protected_base_tip_gate: expect.objectContaining({ expected_commit: CAPABILITY_VALIDATION_V2_BASE, expected_tree: CAPABILITY_VALIDATION_V2_BASE_TREE }),
            known_live_receipts: expect.arrayContaining([
              expect.objectContaining({ purpose: 'issue_610_stop' }),
              expect.objectContaining({ purpose: 'rfc_577_first_stage' }),
            ]),
            required_second_stage_receipts: expect.arrayContaining([
              expect.objectContaining({ purpose: 'issue_612_second_stage' }),
              expect.objectContaining({ purpose: 'rfc_577_second_stage' }),
            ]),
          },
        },
        stop_action: expect.stringContaining('post the durable stop record on #612'),
      },
    })
    const strippedV1 = withoutJsonPointers(v1Contract, CAPABILITY_VALIDATION_V2_ALLOWED_DIFFERENCE_POINTERS)
    const strippedV2 = withoutJsonPointers(contract, CAPABILITY_VALIDATION_V2_ALLOWED_DIFFERENCE_POINTERS)
    expect(strippedV2).toEqual(strippedV1)
    expect(canonicalJson(strippedV2)).toBe(canonicalJson(strippedV1))
    expect(new Set(contract.execution_boundary.receipt_derivation.private_artifact_kinds).size)
      .toBe(contract.execution_boundary.receipt_derivation.private_artifact_kinds.length)
    expect(contract.execution_boundary.receipt_derivation.private_artifact_kinds).toHaveLength(25)
    expect(contract.execution_boundary.receipt_derivation.private_artifact_kinds)
      .not.toContain('other_private')

    const contractSchema = JSON.parse(read(CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA))
    // @ts-expect-error -- Ajv's NodeNext declaration shape differs from its runtime default export
    const contractAjv = new Ajv2020({ allErrors: true, strict: true })
    // @ts-expect-error -- ajv-formats has the same declaration/runtime mismatch
    addFormats(contractAjv)
    const validateContract = contractAjv.compile(contractSchema)
    expect(validateContract(contract), contractAjv.errorsText(validateContract.errors)).toBe(true)
    const widened = structuredClone(contract)
    widened.governance.provider_request_authorized_by_first_stage = true
    expect(validateContract(widened)).toBe(false)

    const receiptSchema = readStrictJson(CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA) as any; const receiptRefs: string[] = []
    const collectRefs = (value: any): void => {
      if (Array.isArray(value)) value.forEach(collectRefs)
      else if (value && typeof value === 'object') {
        if (typeof value.$ref === 'string') receiptRefs.push(value.$ref)
        Object.values(value).forEach(collectRefs)
      }
    }
    collectRefs(receiptSchema); expect(receiptRefs.every((ref) => ref.startsWith('#/$defs/'))).toBe(true)
    const validatePublicReceipt = contractAjv.compile(receiptSchema)
    const privateRefs = receiptSchema.$defs.privateEvidenceEnvelope.oneOf.map(
      ({ $ref }: { $ref: string }) => $ref)
    expect(privateRefs).toHaveLength(25)
    const privateValidators = privateRefs.map((ref: string) => {
      const name = ref.slice('#/$defs/'.length)
      const definition = receiptSchema.$defs[name]
      expect(definition).toMatchObject({ type: 'object', additionalProperties: false, required:
        expect.arrayContaining(['artifact_kind']), properties: { artifact_kind: { const: expect.any(String) } } })
      const validate = contractAjv.compile({ $ref: `${receiptSchema.$id}${ref}` }); const fixture = structuredClone(definition.examples[0])
      expect(validate(fixture), contractAjv.errorsText(validate.errors)).toBe(true)
      const missing = structuredClone(fixture); delete missing.artifact_kind
      expect(validate(missing)).toBe(false)
      expect(validate({ ...fixture, unexpected: true })).toBe(false)
      expect(validatePublicReceipt(fixture)).toBe(false)
      return { fixture, kind: definition.properties.artifact_kind.const, validate }
    })
    expect(privateValidators.map(({ kind }: any) => kind)).toEqual(
      contract.execution_boundary.receipt_derivation.private_artifact_kinds)
    for (const { fixture } of privateValidators) expect(
      privateValidators.filter(({ validate }: any) => validate(fixture))).toHaveLength(1)
    for (const name of ['derivedArchiveManifest', 'privateArchiveIndex', 'derivedArchiveCopyAttestation',
      'externalArchiveVerifierAttestation']) {
      expect(receiptSchema.$defs[name]).toBeDefined()
      expect(privateRefs).not.toContain(`#/$defs/${name}`)
    }

    const nameStatus = execFileSync(git, [
      'diff', '--no-ext-diff', '--no-renames', '--name-status',
      CAPABILITY_VALIDATION_V2_BASE, CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE, '--',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    expect(nameStatus.every((line) => /^(?:A|M)\t/.test(line))).toBe(true)
    expect(nameStatus.map((line) => line.slice(line.indexOf('\t') + 1)).sort())
      .toEqual([...CAPABILITY_VALIDATION_V2_ACTIVATION_FILES].sort())
    expect(nameStatus.filter((line) => line.startsWith('A\t')).map((line) => line.slice(2)).sort())
      .toEqual([
        CAPABILITY_VALIDATION_V2_CONTRACT,
        CAPABILITY_VALIDATION_V2_CONTRACT_SCHEMA,
        CAPABILITY_VALIDATION_V2_RECEIPT_SCHEMA,
      ].sort())
    const rows = execFileSync(git, [
      'diff', '--no-ext-diff', '--no-renames', '--numstat',
      CAPABILITY_VALIDATION_V2_BASE, CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE, '--',
    ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((line) => {
      const [added = '', removed = '', path = ''] = line.split('\t')
      expect([added, removed]).not.toContain('-')
      return { added: Number(added), removed: Number(removed), path }
    })
    const governance = rows.filter((row) =>
      (EVALUATION_TOOLING_ACTIVATION_FILES as readonly string[]).includes(row.path))
    expect(governance.reduce((sum, row) => sum + row.added, 0)).toBeLessThanOrEqual(650)
    expect(governance.reduce((sum, row) => sum + row.removed, 0)).toBeLessThanOrEqual(250)
    expect(rows.reduce((sum, row) => sum + row.added, 0)).toBeLessThanOrEqual(3_850)
    expect(rows.reduce((sum, row) => sum + row.removed, 0)).toBeLessThanOrEqual(250)
  })

  it('freezes the completed combined evidence-path implementation contract and receipt', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      review: { disposition_changes: number; amendment: string }
      current: {
        completed_phase: string
        active_phase: string | null
        ready_phase: string | null
        base_commit: string
        completed_phase_commit: string
        production_typescript_files: number
        production_typescript_loc: number
        production_loc_added: number
        production_loc_removed: number
        production_loc_net: number
        npm_files: number
        npm_packed_bytes: number
        npm_unpacked_bytes: number
        measurement_state: string
        snapshot_scope: string
      }
      items: Array<{
        id: string
        disposition: string
        status: string
        sources?: string[]
        absorbs?: string[]
        absorbed_by?: string
        blocked_by?: string
        transferred_sources?: string[]
        supplemental_cleanup_sources?: string[]
        replacement_sources?: string[]
        predecessor_contract?: {
          files: number
          production_loc: number
          transferred_sources: number
          absorbed_handles: number
        }
        production_file_budget?: { added_max: number; removed_min: number }
        production_loc_budget?: { added_max: number; removed_min: number; net_max: number }
        runtime_dependency_budget?: { added_max: number }
        development_dependency_budget?: { added_max: number }
        optional_peer_metadata_to_remove?: string[]
        final_source_budget?: { files_max: number; loc_max: number }
        npm_package_budget?: {
          files_max: number
          unpacked_bytes_max: number
          packed_bytes_delta_max: number
        }
        deterministic_query_contract?: {
          graph_authoritative_for_selection_and_graph_facts: boolean
          preserve_typed_directional_relationships: boolean
          structural_file_nodes: {
            allowed: boolean
            node_kind: string
            allowed_relationships: string[]
            relationship_endpoints: {
              imports_from: string
              contains: string
            }
            range: string
            snippet: string
            phase_coverage: string
            count_toward_selected_files_and_precision: boolean
          }
          symbol_declarations: {
            definition_range: string
            declaration_range: string
            coordinates: string
            snippet: string
            full_file_sha256: string
            non_contiguous_or_synthesized_excerpt: string
          }
          disconnected_boundaries_explicit: boolean
          missing_and_unsupported_boundaries_explicit: boolean
          stale_unavailable_corrupt_and_truncated_boundaries_explicit: boolean
          duplicate_evidence_forbidden: boolean
          authenticated_source_excerpt: {
            source_layer: string
            source_root: string
            graph_fields_required: string[]
            source_path_must_remain_beneath_root: boolean
            hash_algorithm: string
            hash_must_equal: string
            excerpt: string
            unauthenticated_or_synthesized_snippet: string
            missing_unreadable_or_escape: string
            hash_mismatch_or_invalid_range: string
          }
          determinism_inputs: string[]
          closure_pass_max: number
          global_confidence_score: string
          planner_or_recursive_recovery: string
          hidden_second_query_or_model_call: string
          repository_specific_rules: string
        }
        cross_phase_amendment?: {
          purpose: string
          index_format_after_implementation: string
          graph_artifact_envelope: string
          old_index_policy: string
          authorized_existing_source_modifications: Array<{
            path: string
            owner: string
            purpose: string
          }>
          ownership: string
          replacement_source_count_change: number
          budget_accounting: string
          compatibility_engine: string
        }
        retrieve_input_contract?: {
          allowed_keys: string[]
          additional_properties: string
          question: string
          budget: string
          forbidden_legacy_controls: string[]
        }
        surviving_caller_contract?: {
          compare_legacy_response_branches: string
          installer_applicability_hook_generation: string
          heldout_and_performance_runners: string
          compatibility_types_or_engine: string
        }
        heldout_contract?: {
          id: string
          contract: string
          contract_sha256: string
          contract_schema: string
          contract_schema_sha256: string
          evaluator: string
          evaluator_sha256: string
          receipt_schema: string
          receipt_schema_sha256: string
          receipt: string
          result: {
            status: string
            receipt_file_sha256: string
            receipt_payload_sha256: string
            subject_commit: string
            subject_tree_oid: string
            eligible_for_acceptance: boolean
            blocking_questions_passed: number
            blocking_questions_total: number
            diagnostic_questions_passed: number
            diagnostic_questions_total: number
            diagnostic_is_blocking: boolean
          }
          runner: string
          execution_protocol: {
            acceptance_platform: string
            os_boundary: string
            candidate_runtime: string
            generation_source: string
            workspace_config_source: string
            graph_generation_process: string
            retrieval_process: string
            candidate_access: string
            filesystem_argv_canonicalization: string
            response_handoff: string
            anti_tuning_gate: string
          }
          generation_prerequisite: {
            issue: string
            owner_approval: string
            rfc_approval: string
            workspace_config_view: string
            workspace_config_mapping: string
            package_manager: string
            network: string
            external_dependencies: string
            repository_specific_rules: string
            compiler_normalization: {
              external_ambient_types: string
              composite: boolean
              incremental: boolean
            }
            publication_gate: string
          }
          supersedes: string
          historical_baseline: {
            receipt: string
            receipt_sha256: string
            receipt_schema: string
            receipt_schema_sha256: string
            contract_id: string
            contract_ordered_json_sha256: string
            disposition: string
          }
          evidence_semantics: {
            structural_file_nodes: string
            structural_file_phase_coverage: string
            symbol_phase_evidence: string
            right_file_wrong_symbol: string
            absent_runtime_user_or_async_handoff: string
            invented_reversed_or_projected_edge: string
          }
          blocking_repositories: Array<{
            question: string
            repository: string
            commit: string
            tree_path_sha256: string
            graph_root: string
            required_phases: string[]
            required_connected_handoffs: number
            required_disconnected_handoffs: number
          }>
          diagnostic_scope_guard: {
            question: string
            repository: string
            commit: string
            tree_path_sha256: string
            graph_root: string
            required_typescript_phases: string[]
            unsupported_phases: string[]
          }
          query_invocations_max: number
          required_phase_coverage: number
          direct_phase_evidence_requires_authenticated_excerpt: boolean
          direct_phase_evidence_requires_exact_owner_fixture: boolean
          structural_file_nodes_cover_phases: boolean
          required_handoff_coverage: number
          verification_targets_cover_blocking_phases: boolean
          selected_file_precision_min: number
          unrelated_files_max: number
          selected_files_max: number
          snippets_max: number
          serialized_tokens_max: number
          incorrect_load_bearing_paths_max: number
        }
        performance_contract?: {
          id: string
          descriptor: string
          descriptor_sha256: string
          evaluator: string
          evaluator_sha256: string
          receipt_schema: string
          receipt_schema_sha256: string
          generator: string
          nodes: number
          directed_edges: number
          candidate_runtime_source: string
          graph_loaded_before_timer: boolean
          query_index_inspected_before_timer: boolean
          positive_queries: number
          missing_queries: number
          untimed_preflight_invocations_per_query: number
          preflight_must_pass_before_warmup: boolean
          every_warmup_and_measured_result_must_match: boolean
          empty_positive_result: string
          warmups: number
          measured_queries_min: number
          warm_retrieval_p95_ms_max: number
          closure_pass_max: number
          reference_environment: {
            node: string
            platform: string
            release: string
            arch: string
            cpu: string
            memory_bytes: number
          }
          receipt: string
          runner: string
        }
        importer_closure_contract?: {
          receipt: string
          receipt_sha256: string
          subject_commit: string
          subject_tree: string
          predecessor_files: number
          predecessor_loc: number
          all_edges: number
          internal_deleted_importers: number
          internal_edges: number
          surviving_direct_importers: number
          surviving_edges: number
          transfers: number
          surface_only_callers: number
          unexpected_direct_importers: number
          activation_state: string
        }
        activation?: {
          issue: string
          owner_approval: string
          rfc_amendment: string
          performance_amendment: string
          performance_rfc_amendment: string
          authenticated_source_amendment: string
          authenticated_source_rfc_amendment: string
          authenticated_source_owner_approval: string
          authenticated_source_rfc_approval: string
          heldout_v2_proposal: string
          heldout_v2_owner_approval: string
          heldout_v2_rfc_proposal: string
          heldout_v2_rfc_approval: string
          generation_prerequisite: string
          generation_prerequisite_owner_approval: string
          generation_prerequisite_rfc_approval: string
          original_finalizer_proposal: string
          original_finalizer_owner_approval: string
          original_finalizer_rfc_approval: string
          combined_dependency_proposal_599: string
          combined_dependency_proposal_596: string
          combined_rfc_proposal: string
          combined_owner_approval_599: string
          combined_owner_approval_596: string
          combined_rfc_approval: string
          obligation_coverage_proposal: string
          obligation_coverage_rfc_proposal: string
          obligation_coverage_owner_approval: string
          obligation_coverage_rfc_approval: string
          darwin_path_proposal: string
          darwin_path_rfc_proposal: string
          darwin_path_owner_approval: string
          darwin_path_rfc_approval: string
          portability_proposal: string
          portability_rfc_proposal: string
          portability_owner_approval: string
          portability_rfc_approval: string
          protected_base: string
          implementation_started?: boolean
        }
        completion?: {
          issue: string
          absorbed_issue: string
          pull_request: string
          commit: string
          implementation_commit: string
          final_pr_head: string
          final_pr_tree: string
          ci_head: string
          outcome: string
          production_files_added: number
          production_files_removed: number
          production_typescript_files: number
          production_typescript_loc: number
          production_loc_added: number
          production_loc_removed: number
          production_loc_net: number
          replacement_loc: number
          dependencies_added: number
          dependencies_removed: number
          runtime_dependencies_added: number
          development_dependencies_added: number
          optional_peer_metadata_removed: boolean
          npm_files: number
          npm_packed_bytes: number
          npm_unpacked_bytes: number
          npm_shasum: string
          npm_integrity: string
          npm_artifact_sha256: string
          ci_matrix_jobs_passed: number
          ci_run: string
          test_files_passed: number
          tests_passed: number
          tests_skipped: number
          coverage_statements_percent: number
          coverage_branches_percent: number
          coverage_functions_percent: number
          coverage_lines_percent: number
          coderabbit: string
          independent_review: string
          independent_reviews_passed: number
          independent_review_receipt: string
          unresolved_review_threads: number
        }
      }>
    }

    expect(execFileSync(git, ['rev-parse', `${EVIDENCE_BASE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(EVIDENCE_BASE_TREE)
    expect(manifest.current).toMatchObject({
      updated_at: '2026-07-29',
      completed_phase: RETRIEVAL_REGRESSION_ID,
      active_phase: null,
      ready_phase: 'release-beta',
      base_commit: CAPABILITY_VALIDATION_V2_ACTIVATION_MERGE,
      completed_phase_commit: 'eaa1a8781eda28dad5395d6da378a2cc40bf81fe',
      production_typescript_files: 43,
      production_typescript_loc: 12_008,
      production_loc_added: 69,
      production_loc_removed: 17,
      production_loc_net: 52,
      npm_files: 102,
      npm_packed_bytes: 160_319,
      npm_unpacked_bytes: 639_962,
      measurement_state: 'source_and_package_exact',
      snapshot_scope: 'release_candidate_source_and_package',
    })
    expect(manifest.items.filter((item) => item.status === 'in_progress').map((item) => item.id))
      .toEqual([])

    const evidence = manifest.items.find((item) => item.id === 'evidence-path-query')
    expect(evidence).toMatchObject({
      disposition: 'rebuild',
      status: 'complete',
      absorbs: ['context-governance-stack', 'derived-product-wrappers'],
      transferred_sources: [...EVIDENCE_TRANSFERS],
      supplemental_cleanup_sources: ['src/runtime/stdio/prompts.ts'],
      replacement_sources: [...EVIDENCE_REPLACEMENTS],
      predecessor_contract: {
        files: 63,
        production_loc: 33_031,
        transferred_sources: 22,
        absorbed_handles: 2,
      },
      production_file_budget: { added_max: 7, removed_min: 63 },
      production_loc_budget: { added_max: 3_500, removed_min: 33_031, net_max: -25_900 },
      runtime_dependency_budget: { added_max: 0 },
      development_dependency_budget: { added_max: 0 },
      optional_peer_metadata_to_remove: ['@huggingface/transformers'],
      final_source_budget: { files_max: 83, loc_max: 40_500 },
      npm_package_budget: {
        files_max: 210,
        unpacked_bytes_max: 2_200_000,
        packed_bytes_delta_max: -1,
      },
      implementation_inventory: {
        receipt: EVIDENCE_INVENTORY_RECEIPT,
        receipt_sha256: EVIDENCE_INVENTORY_RECEIPT_SHA256,
        subject_commit: EVIDENCE_IMPLEMENTATION,
        subject_tree_oid: '277649ed917fc134e9808a995ce8c84f22258acb',
        production_typescript_files: 73,
        production_typescript_loc: 21_687,
        production_loc_added: 3_500,
        production_loc_removed: 48_231,
        production_loc_net: -44_731,
        runtime_dependencies_added: 0,
        development_dependencies_added: 0,
        optional_peer_metadata_removed: true,
        npm_files: 162,
        npm_packed_bytes: 231_524,
        npm_unpacked_bytes: 984_434,
        npm_packed_bytes_delta: -340_647,
        all_phase_budgets_pass: true,
      },
      deterministic_query_contract: {
        graph_authoritative_for_selection_and_graph_facts: true,
        preserve_typed_directional_relationships: true,
        structural_file_nodes: {
          allowed: true,
          node_kind: 'file',
          allowed_relationships: ['imports_from', 'contains'],
          relationship_endpoints: {
            imports_from: 'file_to_file',
            contains: 'file_to_symbol',
          },
          range: 'forbidden',
          snippet: 'forbidden',
          phase_coverage: 'forbidden',
          count_toward_selected_files_and_precision: true,
        },
        symbol_declarations: {
          definition_range: 'complete_ast_definition',
          declaration_range: 'canonical_signature_or_declaration_prefix',
          coordinates: 'one_based_utf16_end_exclusive',
          snippet: 'exact_authenticated_declaration_range',
          full_file_sha256: 'required',
          non_contiguous_or_synthesized_excerpt: 'forbidden',
        },
        disconnected_boundaries_explicit: true,
        missing_and_unsupported_boundaries_explicit: true,
        stale_unavailable_corrupt_and_truncated_boundaries_explicit: true,
        duplicate_evidence_forbidden: true,
        authenticated_source_excerpt: {
          source_layer: 'application',
          graph_fields_required: [
            'node',
            'source_file',
            'definition_range',
            'declaration_range',
            'provenance',
            'canonical_file_node.content_hash',
          ],
          source_root: 'graph_root',
          source_path_must_remain_beneath_root: true,
          hash_algorithm: 'sha256_complete_utf8_source',
          hash_must_equal: 'canonical_file_node.content_hash',
          excerpt: 'exact_declaration_range_text_only',
          unauthenticated_or_synthesized_snippet: 'forbidden',
          missing_unreadable_or_escape: 'unavailable_without_snippet',
          hash_mismatch_or_invalid_range: 'stale_without_snippet',
        },
        determinism_inputs: [
          'normalized_retrieve_request',
          'canonical_graph_bytes',
          'authenticated_source_snapshot',
        ],
        closure_pass_max: 1,
        global_confidence_score: 'forbidden',
        planner_or_recursive_recovery: 'forbidden',
        hidden_second_query_or_model_call: 'forbidden',
        repository_specific_rules: 'forbidden',
      },
      cross_phase_amendment: {
        purpose:
          'Add canonical declaration ranges and normalize non-graph compiler settings in the existing TypeScript index without creating a second index, compatibility format, or ownership overlap.',
        index_format_after_implementation: 'v3',
        graph_artifact_envelope: 'v2_unchanged',
        old_index_policy: 'regeneration_required_no_fallback',
        authorized_existing_source_modifications: [
          {
            path: 'src/domain/index/model.ts',
            owner: 'canonical-typescript-index',
            purpose: 'canonical definition_range and declaration_range facts',
          },
          {
            path: 'src/adapters/typescript/index.ts',
            owner: 'canonical-typescript-index',
            purpose: 'deterministic AST declaration ranges plus build/dependency-only compiler normalization',
          },
          {
            path: 'src/domain/index/build-state.ts',
            owner: 'canonical-typescript-index',
            purpose: 'bind the canonical index format and engine version',
          },
        ],
        ownership: 'remains_exclusively_canonical-typescript-index',
        replacement_source_count_change: 0,
        compatibility_engine: 'forbidden',
      },
      retrieve_input_contract: {
        allowed_keys: ['question', 'budget'],
        additional_properties: 'forbidden',
        question: 'required',
        budget: 'optional_and_part_of_normalized_request',
        forbidden_legacy_controls: ['semantic', 'rerank', 'strategy', 'session', 'mode'],
      },
      surviving_caller_contract: {
        compare_legacy_response_branches: 'delete',
        installer_applicability_hook_generation: 'delete',
        heldout_and_performance_runners: 'development_only',
        compatibility_types_or_engine: 'forbidden',
      },
      heldout_contract: {
        id: 'core-reset-held-out-v2',
        contract: 'tools/eval/core-reset/contracts/evaluation-contract.json',
        contract_sha256: FROZEN_EVIDENCE_HASHES['tools/eval/core-reset/contracts/evaluation-contract.json'],
        contract_schema: 'tools/eval/core-reset/schemas/evaluation-contract.schema.json',
        contract_schema_sha256: FROZEN_EVIDENCE_HASHES['tools/eval/core-reset/schemas/evaluation-contract.schema.json'],
        evaluator: EVIDENCE_HELDOUT_EVALUATOR,
        evaluator_sha256: FROZEN_EVIDENCE_HASHES[EVIDENCE_HELDOUT_EVALUATOR],
        receipt_schema: EVIDENCE_HELDOUT_RECEIPT_SCHEMA,
        receipt_schema_sha256: FROZEN_EVIDENCE_HASHES[EVIDENCE_HELDOUT_RECEIPT_SCHEMA],
        receipt: EVIDENCE_HELDOUT_RECEIPT,
        result: {
          status: 'passed',
          receipt_file_sha256: FROZEN_EVIDENCE_HASHES[EVIDENCE_HELDOUT_RECEIPT],
          receipt_payload_sha256: 'f07cac4200b77ed9d74a5792e72b032c471c84337ef71709b8c0e96312ae2693',
          subject_commit: '29aba7ebffe14d6a70bde78df1490bf4cded64a4',
          subject_tree_oid: '277649ed917fc134e9808a995ce8c84f22258acb',
          eligible_for_acceptance: true,
          blocking_questions_passed: 2,
          blocking_questions_total: 2,
          diagnostic_questions_passed: 0,
          diagnostic_questions_total: 1,
          diagnostic_is_blocking: false,
        },
        runner:
          'node tools/eval/core-reset/evidence-path-held-out.mjs --repository openstatus=<path> --repository documenso=<path> --repository formbricks=<path>',
        execution_protocol: {
          acceptance_platform: 'darwin_reference_only',
          os_boundary: 'sandbox_exec_network_fork_non_runtime_exec_and_evaluator_checkout_denial',
          candidate_runtime: 'detached_exact_head_clean_build_npm_pack_exact_lock_offline',
          generation_source: 'pinned_git_archive_without_vcs_metadata',
          workspace_config_source: 'exact_tracked_local_workspace_packages_no_package_manager',
          graph_generation_process: 'one_contained_process_per_repository',
          retrieval_process: 'fresh_contained_process_per_question',
          candidate_access: 'node_permission_fs_allowlist_and_child_process_denial',
          filesystem_argv_canonicalization: 'explicitly_declared_indexes_only',
          response_handoff: 'fsync_sha256_before_hidden_grading',
          anti_tuning_gate: 'literal_marker_scan_plus_independent_review_required',
        },
        generation_prerequisite: {
          issue: EVIDENCE_GENERATION_PREREQUISITE,
          owner_approval: EVIDENCE_GENERATION_OWNER_APPROVAL,
          rfc_approval: EVIDENCE_GENERATION_RFC_APPROVAL,
          workspace_config_view: 'exact_tracked_local_packages_referenced_by_compiler_extends',
          workspace_config_mapping: 'sorted_count_and_sha256',
          package_manager: 'forbidden',
          network: 'forbidden',
          external_dependencies: 'forbidden',
          repository_specific_rules: 'forbidden',
          compiler_normalization: {
            external_ambient_types: 'disabled',
            composite: false,
            incremental: false,
          },
          publication_gate: 'unchanged_fail_closed',
        },
        supersedes: 'core-reset-held-out-v1',
        historical_baseline: {
          receipt: 'docs/core-reset/evidence/baseline-v0.32.0.json',
          receipt_sha256: FROZEN_EVIDENCE_HASHES['docs/core-reset/evidence/baseline-v0.32.0.json'],
          receipt_schema: 'tools/eval/core-reset/schemas/baseline-receipt.schema.json',
          receipt_schema_sha256: FROZEN_EVIDENCE_HASHES['tools/eval/core-reset/schemas/baseline-receipt.schema.json'],
          contract_id: 'core-reset-held-out-v1',
          contract_ordered_json_sha256: '20c7f4f03a1a35182b4148a71e4293b3ef932d73be61d8d85db1f81e8fb795fc',
          disposition: 'historical_baseline_only_not_v2_held_out_evidence',
        },
        evidence_semantics: {
          structural_file_nodes: 'exact_directed_imports_from_and_contains_only',
          structural_file_phase_coverage: 'forbidden',
          symbol_phase_evidence: 'exact_owner_fixture_with_authenticated_declaration',
          right_file_wrong_symbol: 'fail',
          absent_runtime_user_or_async_handoff: 'disconnected',
          invented_reversed_or_projected_edge: 'forbidden',
        },
        blocking_repositories: [
          {
            question: 'documenso-document-send',
            repository: 'documenso',
            commit: '4ee789ea378d12c85daacf7dceda80b4dec80652',
            tree_path_sha256: '48728969cb89adeb6567f030a41fdf380e6c523473a04d3a264a4f4970b95709',
            graph_root: 'packages/lib',
            required_phases: [
              'recipient_creation',
              'document_send',
              'signing_completion',
              'seal_execution',
              'notification_delivery',
            ],
            required_connected_handoffs: 0,
            required_disconnected_handoffs: 4,
          },
          {
            question: 'formbricks-survey-response',
            repository: 'formbricks',
            commit: '415bd9828ba150f7944fe10422acdbaf3089c707',
            tree_path_sha256: 'd50418a92fd6dae8d07ad09e4aaecbefb53c5ed29c85e374d41320e0669a7572',
            graph_root: 'apps/web',
            required_phases: [
              'request_handling',
              'response_persistence',
              'event_enqueue',
              'worker_binding',
              'event_tracking',
            ],
            required_connected_handoffs: 1,
            required_disconnected_handoffs: 3,
          },
        ],
        diagnostic_scope_guard: {
          question: 'openstatus-574-strict-one-call',
          repository: 'openstatus',
          commit: '295e5a72f52c172d326aa950e81043e72a4f20c0',
          tree_path_sha256: '9ccb1f1dce50c03ea67703953c124cb6026ee978a97be4f358d7276c20e764f4',
          graph_root: '.',
          required_typescript_phases: [
            'incident_mutation',
            'notification_delivery',
            'public_html',
            'json_feeds',
          ],
          unsupported_phases: ['checker_detection', 'tinybird_persistence'],
        },
        query_invocations_max: 1,
        required_phase_coverage: 1,
        direct_phase_evidence_requires_authenticated_excerpt: true,
        direct_phase_evidence_requires_exact_owner_fixture: true,
        structural_file_nodes_cover_phases: false,
        required_handoff_coverage: 1,
        verification_targets_cover_blocking_phases: false,
        selected_file_precision_min: 0.70,
        unrelated_files_max: 2,
        selected_files_max: 12,
        snippets_max: 25,
        serialized_tokens_max: 4_000,
        incorrect_load_bearing_paths_max: 0,
      },
      performance_contract: {
        id: 'evidence-path-performance-v2',
        descriptor: EVIDENCE_PERFORMANCE_DESCRIPTOR,
        descriptor_sha256: EVIDENCE_PERFORMANCE_DESCRIPTOR_SHA256,
        evaluator: EVIDENCE_PERFORMANCE_EVALUATOR,
        evaluator_sha256: EVIDENCE_PERFORMANCE_EVALUATOR_SHA256,
        receipt_schema: EVIDENCE_PERFORMANCE_RECEIPT_SCHEMA,
        receipt_schema_sha256: EVIDENCE_PERFORMANCE_RECEIPT_SCHEMA_SHA256,
        generator: 'component-ring-structural-imports-v3',
        nodes: 15_000,
        directed_edges: 30_000,
        candidate_runtime_source: 'detached_standalone_exact_head_clone',
        graph_loaded_before_timer: true,
        query_index_inspected_before_timer: true,
        positive_queries: 4,
        missing_queries: 1,
        untimed_preflight_invocations_per_query: 1,
        preflight_must_pass_before_warmup: true,
        every_warmup_and_measured_result_must_match: true,
        empty_positive_result: 'fail',
        warmups: 3,
        measured_queries_min: 20,
        warm_retrieval_p95_ms_max: 500,
        closure_pass_max: 1,
        reference_environment: {
          node: 'v22.9.0',
          platform: 'darwin',
          release: '25.3.0',
          arch: 'arm64',
          cpu: 'Apple M3 Max',
          memory_bytes: 51_539_607_552,
        },
        receipt: EVIDENCE_PERFORMANCE_RECEIPT,
        result: {
          status: 'passed',
          receipt_file_sha256: FROZEN_EVIDENCE_HASHES[EVIDENCE_PERFORMANCE_RECEIPT],
          receipt_payload_sha256: '384df2ba175bd2df2c1cdbed855c2aefd53b16abff7fbae5ff5fad82a668e77e',
          subject_commit: '29aba7ebffe14d6a70bde78df1490bf4cded64a4',
          subject_tree_oid: '277649ed917fc134e9808a995ce8c84f22258acb',
          p95_ms: 279.28,
          eligible_for_acceptance: true,
        },
        runner: `node tools/eval/core-reset/evidence-path-performance.mjs --contract ${EVIDENCE_PERFORMANCE_DESCRIPTOR} --receipt ${EVIDENCE_PERFORMANCE_RECEIPT}`,
      },
      importer_closure_contract: {
        receipt: EVIDENCE_IMPORTER_RECEIPT,
        receipt_sha256: EVIDENCE_IMPORTER_RECEIPT_SHA256,
        subject_commit: EVIDENCE_BASE,
        subject_tree: EVIDENCE_BASE_TREE,
        predecessor_files: 63,
        predecessor_loc: 33_031,
        all_edges: 263,
        internal_deleted_importers: 51,
        internal_edges: 184,
        surviving_direct_importers: 16,
        surviving_edges: 79,
        transfers: 22,
        surface_only_callers: 1,
        unexpected_direct_importers: 0,
        supplemental_cleanup_sources: 1,
        activation_state: 'implementation_in_progress',
      },
      activation: {
        issue: EVIDENCE_ISSUE,
        owner_approval: EVIDENCE_OWNER_APPROVAL,
        rfc_amendment: EVIDENCE_RFC_AMENDMENT,
        performance_amendment: EVIDENCE_PERFORMANCE_AMENDMENT,
        performance_rfc_amendment: EVIDENCE_PERFORMANCE_RFC_AMENDMENT,
        authenticated_source_amendment: EVIDENCE_SOURCE_AMENDMENT,
        authenticated_source_rfc_amendment: EVIDENCE_SOURCE_RFC_AMENDMENT,
        authenticated_source_owner_approval: EVIDENCE_SOURCE_OWNER_APPROVAL,
        authenticated_source_rfc_approval: EVIDENCE_SOURCE_RFC_APPROVAL,
        heldout_v2_proposal: EVIDENCE_V2_PROPOSAL,
        heldout_v2_owner_approval: EVIDENCE_V2_OWNER_APPROVAL,
        heldout_v2_rfc_proposal: EVIDENCE_V2_RFC_PROPOSAL,
        heldout_v2_rfc_approval: EVIDENCE_V2_RFC_APPROVAL,
        generation_prerequisite: EVIDENCE_GENERATION_PREREQUISITE,
        generation_prerequisite_owner_approval: EVIDENCE_GENERATION_OWNER_APPROVAL,
        generation_prerequisite_rfc_approval: EVIDENCE_GENERATION_RFC_APPROVAL,
        original_finalizer_proposal: EVIDENCE_FINALIZER_PROPOSAL,
        original_finalizer_owner_approval: EVIDENCE_FINALIZER_OWNER_APPROVAL,
        original_finalizer_rfc_approval: EVIDENCE_FINALIZER_RFC_APPROVAL,
        combined_dependency_proposal_599: EVIDENCE_COMBINED_PROPOSAL_599,
        combined_dependency_proposal_596: EVIDENCE_COMBINED_PROPOSAL_596,
        combined_rfc_proposal: EVIDENCE_COMBINED_RFC_PROPOSAL,
        combined_owner_approval_599: EVIDENCE_COMBINED_APPROVAL_599,
        combined_owner_approval_596: EVIDENCE_COMBINED_APPROVAL_596,
        combined_rfc_approval: EVIDENCE_COMBINED_RFC_APPROVAL,
        obligation_coverage_proposal: EVIDENCE_OBLIGATION_PROPOSAL,
        obligation_coverage_rfc_proposal: EVIDENCE_OBLIGATION_RFC_PROPOSAL,
        obligation_coverage_owner_approval: EVIDENCE_OBLIGATION_OWNER_APPROVAL,
        obligation_coverage_rfc_approval: EVIDENCE_OBLIGATION_RFC_APPROVAL,
        darwin_path_proposal: EVIDENCE_DARWIN_PATH_PROPOSAL,
        darwin_path_rfc_proposal: EVIDENCE_DARWIN_PATH_RFC_PROPOSAL,
        darwin_path_owner_approval: EVIDENCE_DARWIN_PATH_OWNER_APPROVAL,
        darwin_path_rfc_approval: EVIDENCE_DARWIN_PATH_RFC_APPROVAL,
        portability_proposal: EVIDENCE_PORTABILITY_PROPOSAL,
        portability_rfc_proposal: EVIDENCE_PORTABILITY_RFC_PROPOSAL,
        portability_owner_approval: EVIDENCE_PORTABILITY_OWNER_APPROVAL,
        portability_rfc_approval: EVIDENCE_PORTABILITY_RFC_APPROVAL,
        protected_base: EVIDENCE_BASE,
        implementation_started: true,
      },
      completion: {
        issue: EVIDENCE_ISSUE,
        absorbed_issue: EVIDENCE_GENERATION_PREREQUISITE,
        pull_request: 'https://github.com/mohanagy/madar/pull/600',
        commit: EVIDENCE_MERGE,
        implementation_commit: EVIDENCE_IMPLEMENTATION,
        final_pr_head: EVIDENCE_FINAL_HEAD,
        final_pr_tree: EVIDENCE_FINAL_TREE,
        ci_head: EVIDENCE_FINAL_HEAD,
        outcome: 'deterministic_graph_authenticated_evidence_path',
        production_files_added: 7,
        production_files_removed: 64,
        production_typescript_files: 73,
        production_typescript_loc: 21_687,
        production_loc_added: 3_500,
        production_loc_removed: 48_231,
        production_loc_net: -44_731,
        replacement_loc: 1_812,
        dependencies_added: 0,
        dependencies_removed: 1,
        runtime_dependencies_added: 0,
        development_dependencies_added: 0,
        optional_peer_metadata_removed: true,
        npm_files: 162,
        npm_packed_bytes: 231_524,
        npm_unpacked_bytes: 984_434,
        npm_shasum: '736304da55902eb36dd414bc618794102c7fa747',
        npm_integrity:
          'sha512-bx6t7+gHxtvk2cmbkbrf/Zi4fmFPZEhhxXV40GHq2+u02NW57B2hZZxWRrYMXxN8UvZptVLibZZ/GirTbcMjXg==',
        npm_artifact_sha256: '59843af17736c5d6ff5bf4499d6509eaf69605f70b57c08be4e1716758e25528',
        ci_matrix_jobs_passed: 6,
        ci_run: EVIDENCE_CI_RUN,
        test_files_passed: 81,
        tests_passed: 740,
        tests_skipped: 3,
        coverage_statements_percent: 81.38,
        coverage_branches_percent: 71.79,
        coverage_functions_percent: 87.83,
        coverage_lines_percent: 83.56,
        coderabbit: 'skipped_base_owner_exception',
        independent_review: 'passed',
        independent_reviews_passed: 1,
        independent_review_receipt: EVIDENCE_REVIEW_RECEIPT,
        unresolved_review_threads: 0,
      },
    })
    expect(evidence?.deterministic_query_contract)
      .not.toHaveProperty('identical_question_and_graph_bytes_are_byte_deterministic')
    expect(evidence?.deterministic_query_contract)
      .not.toHaveProperty('graph_backed_evidence_only')
    expect(Object.keys(evidence?.deterministic_query_contract ?? {}).sort()).toEqual([
      'authenticated_source_excerpt',
      'closure_pass_max',
      'determinism_inputs',
      'disconnected_boundaries_explicit',
      'duplicate_evidence_forbidden',
      'global_confidence_score',
      'graph_authoritative_for_selection_and_graph_facts',
      'hidden_second_query_or_model_call',
      'missing_and_unsupported_boundaries_explicit',
      'planner_or_recursive_recovery',
      'preserve_typed_directional_relationships',
      'repository_specific_rules',
      'stale_unavailable_corrupt_and_truncated_boundaries_explicit',
      'structural_file_nodes',
      'symbol_declarations',
    ].sort())
    expect(Object.keys(evidence?.deterministic_query_contract?.authenticated_source_excerpt ?? {}).sort()).toEqual([
      'excerpt',
      'graph_fields_required',
      'hash_algorithm',
      'hash_mismatch_or_invalid_range',
      'hash_must_equal',
      'missing_unreadable_or_escape',
      'source_layer',
      'source_path_must_remain_beneath_root',
      'source_root',
      'unauthenticated_or_synthesized_snippet',
    ].sort())
    expect(Object.keys(evidence?.retrieve_input_contract ?? {}).sort()).toEqual([
      'additional_properties',
      'allowed_keys',
      'budget',
      'forbidden_legacy_controls',
      'question',
    ].sort())
    expect(Object.keys(evidence?.surviving_caller_contract ?? {}).sort()).toEqual([
      'compare_legacy_response_branches',
      'compatibility_types_or_engine',
      'heldout_and_performance_runners',
      'installer_applicability_hook_generation',
    ].sort())

    const absorbed = (evidence?.absorbs ?? []).map((id) => manifest.items.find((item) => item.id === id))
    expect(absorbed).toHaveLength(2)
    expect(absorbed.every(Boolean)).toBe(true)
    expect(absorbed.map((item) => ({ id: item?.id, status: item?.status, absorbed_by: item?.absorbed_by })))
      .toEqual([
        { id: 'context-governance-stack', status: 'complete', absorbed_by: 'evidence-path-query' },
        { id: 'derived-product-wrappers', status: 'complete', absorbed_by: 'evidence-path-query' },
      ])
    expect(manifest.items.find((item) => item.id === 'thin-delivery')).toMatchObject({
      status: 'complete',
    })
    expect(manifest.items.find((item) => item.id === 'thin-delivery')).not.toHaveProperty('blocked_by')

    const evidenceOwners = [evidence, ...absorbed].filter((item): item is NonNullable<typeof item> => item !== undefined)
    const baseFiles = productionTypeScriptFilesAtCommit(EVIDENCE_BASE)
    const predecessors = baseFiles.filter((file) => evidenceOwners.some((item) =>
      (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(file))))
    expect(predecessors).toHaveLength(63)
    expect(logicalLocAtCommit(EVIDENCE_BASE, predecessors)).toBe(33_031)
    for (const predecessor of predecessors) {
      expect(evidenceOwners.filter((item) =>
        (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(predecessor))))
        .toHaveLength(1)
    }
    expect(EVIDENCE_REPLACEMENTS.every((path) => !baseFiles.includes(path))).toBe(true)
    expect(EVIDENCE_REPLACEMENTS.every((path) => existsSync(resolve(path)))).toBe(true)
    expect(logicalLocAtCommit(EVIDENCE_IMPLEMENTATION, EVIDENCE_REPLACEMENTS)).toBe(1_812)
    expect(existsSync(resolve(EVIDENCE_PERFORMANCE_RECEIPT))).toBe(true)
    const implementationDelta = productionSourceDeltaBetween(EVIDENCE_BASE, EVIDENCE_IMPLEMENTATION)
    expect(implementationDelta.added).toBeLessThanOrEqual(3_500)
    expect(implementationDelta.removed).toBeGreaterThanOrEqual(33_031)
    expect(implementationDelta.net).toBeLessThanOrEqual(-25_900)
    expect(manifest.review).toMatchObject({ disposition_changes: 11 })
    expect(manifest.review.amendment).toContain('serve.ts changed from rebuild to delete')
    expect(manifest.review.amendment).toContain('package-metadata.ts and shell.ts from rebuild to evaluation-tooling')
  })

  it('pins the frozen held-out and performance contracts byte for byte', () => {
    const transportRepinPaths = new Set([
      EVIDENCE_HELDOUT_EVALUATOR,
      EVIDENCE_HELDOUT_RECEIPT_SCHEMA,
    ])
    for (const [path, expectedSha256] of Object.entries(FROZEN_EVIDENCE_HASHES)) {
      if (transportRepinPaths.has(path)) continue
      expect(
        createHash('sha256').update(readFileSync(resolve(path))).digest('hex'),
        `${path} must remain byte-frozen`,
      ).toBe(expectedSha256)
    }
    expect(
      createHash('sha256').update(readFileSync(resolve(EVIDENCE_PERFORMANCE_DESCRIPTOR))).digest('hex'),
    ).toBe(EVIDENCE_PERFORMANCE_DESCRIPTOR_SHA256)
    expect(
      createHash('sha256').update(readFileSync(resolve(EVIDENCE_PERFORMANCE_EVALUATOR))).digest('hex'),
    ).toBe(EVIDENCE_PERFORMANCE_EVALUATOR_SHA256)
    expect(
      createHash('sha256').update(readFileSync(resolve(EVIDENCE_PERFORMANCE_RECEIPT_SCHEMA))).digest('hex'),
    ).toBe(EVIDENCE_PERFORMANCE_RECEIPT_SCHEMA_SHA256)

    const descriptor = JSON.parse(read(EVIDENCE_PERFORMANCE_DESCRIPTOR)) as EvidencePerformanceDescriptor
    expect(descriptor).toMatchObject({
      schema_version: 2,
      fixture_id: 'evidence-path-performance-v2',
      generator: {
        algorithm: 'component-ring-structural-imports-v3',
        seed: 'sha256-counter-v3:evidence-path-performance-v2',
        component_count: 150,
        nodes_per_component: 100,
        node_count: 15_000,
        edge_count: 30_000,
        node_kind: 'file',
        source_file: 'src/fixture/flow-{component}/node-{local}.ts',
        source_domain: 'production',
        source_text_use: 'full-file SHA256 authentication only',
        structural_file_evidence: {
          range: 'omitted',
          snippet: 'omitted',
          permitted_relations: ['imports_from'],
        },
        edges: [
          {
            count_per_component: 100,
            from: 'local_index',
            to: '(local_index + 1) modulo 100',
            relation_rule: 'imports_from',
          },
          {
            count_per_component: 100,
            from: 'local_index',
            to: '(local_index + 37) modulo 100',
            relation_rule: 'imports_from',
          },
        ],
      },
      protocol: {
        graph_loaded_before_timer: true,
        correctness: {
          untimed_preflight_invocations_per_query: 1,
          preflight_must_pass_before_warmup: true,
          every_warmup_and_measured_result_must_match: true,
          outcome_match: 'exact',
          node_match: 'exact_set',
          relationship_match: 'exact_directed_typed_set',
          boundary_match: 'exact_set',
          empty_positive_result: 'fail',
          structural_file_range: 'must_be_omitted',
          structural_file_snippet: 'must_be_omitted',
          full_file_hash: 'must_match_authenticated_source',
        },
        warmup_invocations: 3,
        measured_invocations: 20,
        closure_pass_max: 1,
        selected_file_max: 12,
        serialized_token_max: 4_000,
        p95_ms_max: 500,
      },
      runner: `node tools/eval/core-reset/evidence-path-performance.mjs --contract ${EVIDENCE_PERFORMANCE_DESCRIPTOR} --receipt ${EVIDENCE_PERFORMANCE_RECEIPT}`,
      receipt: EVIDENCE_PERFORMANCE_RECEIPT,
    })
    expect(descriptor.generator).not.toHaveProperty('line_number_rule')
    expect(descriptor.generator).not.toHaveProperty('snippet_rule')
    expect(descriptor.generator.component_count * descriptor.generator.nodes_per_component)
      .toBe(descriptor.generator.node_count)
    expect(
      descriptor.generator.component_count
      * descriptor.generator.edges.reduce((total, edge) => total + edge.count_per_component, 0),
    ).toBe(descriptor.generator.edge_count)
    expect(descriptor.queries).toHaveLength(5)
    expect(descriptor.query_expectations.map((entry) => entry.query_index)).toEqual([0, 1, 2, 3, 4])
    expect(descriptor.query_expectations.filter((entry) => entry.outcome === 'evidence')).toHaveLength(4)
    expect(descriptor.query_expectations.filter((entry) => entry.outcome === 'missing')).toHaveLength(1)

    const coordinates = (nodeId: string): { component: number; local: number } => {
      const match = /^n(\d{3})(\d{2})$/.exec(nodeId)
      if (!match) throw new Error(`invalid performance fixture node id: ${nodeId}`)
      return { component: Number(match[1]), local: Number(match[2]) }
    }
    for (const expectation of descriptor.query_expectations) {
      expect(expectation.query_index).toBeLessThan(descriptor.queries.length)
      if (expectation.outcome === 'missing') {
        expect(expectation).toEqual({
          query_index: 4,
          outcome: 'missing',
          node_ids: [],
          relationships: [],
          boundaries: [{ kind: 'missing', subject: 'flow-999' }],
        })
        continue
      }

      expect(expectation.node_ids.length).toBeGreaterThan(0)
      expect(expectation.relationships.length).toBeGreaterThan(0)
      expect(expectation.boundaries).toEqual([])
      const selectedNodes = new Set(expectation.node_ids)
      for (const nodeId of selectedNodes) {
        const node = coordinates(nodeId)
        expect(node.component).toBeLessThan(descriptor.generator.component_count)
        expect(node.local).toBeLessThan(descriptor.generator.nodes_per_component)
      }
      for (const relationship of expectation.relationships) {
        expect(selectedNodes.has(relationship.from_id)).toBe(true)
        expect(selectedNodes.has(relationship.to_id)).toBe(true)
        const from = coordinates(relationship.from_id)
        const to = coordinates(relationship.to_id)
        expect(to.component).toBe(from.component)
        expect(relationship.relation).toBe('imports_from')
        const observedOffset =
          (to.local - from.local + descriptor.generator.nodes_per_component)
          % descriptor.generator.nodes_per_component
        expect([1, 37]).toContain(observedOffset)
      }
    }
    expect(existsSync(resolve(EVIDENCE_HELDOUT_RECEIPT))).toBe(true)
    const heldoutReceipt = JSON.parse(read(EVIDENCE_HELDOUT_RECEIPT)) as {
      receipt_sha256: string
      benchmark_passed: boolean
      eligible_for_acceptance: boolean
      subject: { head_commit: string; head_tree_oid: string; worktree_dirty: boolean }
      evaluator: { sha256: string }
      gates: Record<string, boolean>
      failures: unknown[]
      questions: Array<{
        question_id: string
        gate_role: string
        passed: boolean
        required_phase_coverage: number
        selected_file_precision: number
        unrelated_files: string[]
        handoffs: Array<{ matched: boolean }>
      }>
    }
    expect(heldoutReceipt).toMatchObject({
      receipt_sha256: 'f07cac4200b77ed9d74a5792e72b032c471c84337ef71709b8c0e96312ae2693',
      benchmark_passed: true,
      eligible_for_acceptance: true,
      subject: {
        head_commit: '29aba7ebffe14d6a70bde78df1490bf4cded64a4',
        head_tree_oid: '277649ed917fc134e9808a995ce8c84f22258acb',
        worktree_dirty: false,
      },
      evaluator: { sha256: FROZEN_EVIDENCE_HASHES[EVIDENCE_HELDOUT_EVALUATOR] },
      failures: [],
    })
    expect(Object.values(heldoutReceipt.gates).every(Boolean)).toBe(true)
    expect(heldoutReceipt.questions.filter((question) => question.gate_role === 'blocking').map(
      (question) => ({
        id: question.question_id,
        passed: question.passed,
        coverage: question.required_phase_coverage,
        precision: question.selected_file_precision,
        unrelated: question.unrelated_files.length,
        handoffs: question.handoffs.every((handoff) => handoff.matched),
      }),
    )).toEqual([
      {
        id: 'documenso-document-send',
        passed: true,
        coverage: 1,
        precision: 1,
        unrelated: 0,
        handoffs: true,
      },
      {
        id: 'formbricks-survey-response',
        passed: true,
        coverage: 1,
        precision: 1,
        unrelated: 0,
        handoffs: true,
      },
    ])
    expect(heldoutReceipt.questions.find(
      (question) => question.question_id === 'openstatus-574-strict-one-call',
    )?.passed).toBe(false)
    const performanceReceipt = JSON.parse(read(EVIDENCE_PERFORMANCE_RECEIPT))
    expect(performanceReceipt).toMatchObject({
      receipt_sha256: '384df2ba175bd2df2c1cdbed855c2aefd53b16abff7fbae5ff5fad82a668e77e',
      benchmark_passed: true,
      eligible_for_acceptance: true,
      subject: {
        head_commit: '29aba7ebffe14d6a70bde78df1490bf4cded64a4',
        head_tree_oid: '277649ed917fc134e9808a995ce8c84f22258acb',
        worktree_dirty: false,
      },
      measurements: { p95_ms: 279.28, target_ms: 500 },
      failures: [],
    })
    expect(JSON.parse(read(EVIDENCE_INVENTORY_RECEIPT))).toEqual({
      schema_version: 1,
      issue: EVIDENCE_ISSUE,
      protected_base: EVIDENCE_BASE,
      implementation_commit: '29aba7ebffe14d6a70bde78df1490bf4cded64a4',
      implementation_tree: '277649ed917fc134e9808a995ce8c84f22258acb',
      production: {
        typescript_files: 73,
        typescript_loc: 21_687,
        loc_added: 3_500,
        loc_removed: 48_231,
        loc_net: -44_731,
        predecessor_files_removed: 63,
        replacement_files: 7,
      },
      dependencies: {
        runtime_added: 0,
        development_added: 0,
        optional_peer_metadata_removed: ['@huggingface/transformers'],
      },
      package: {
        command: 'npm pack --dry-run --json',
        name: '@lubab/madar',
        version: '0.32.0',
        files: 162,
        packed_bytes: 231_524,
        protected_base_packed_bytes: 572_171,
        packed_bytes_delta: -340_647,
        unpacked_bytes: 984_434,
        shasum: '736304da55902eb36dd414bc618794102c7fa747',
        integrity: 'sha512-bx6t7+gHxtvk2cmbkbrf/Zi4fmFPZEhhxXV40GHq2+u02NW57B2hZZxWRrYMXxN8UvZptVLibZZ/GirTbcMjXg==',
      },
      budgets: {
        production_files_pass: true,
        production_loc_pass: true,
        production_delta_pass: true,
        replacement_surface_pass: true,
        package_files_pass: true,
        package_unpacked_bytes_pass: true,
        package_packed_bytes_pass: true,
        dependency_additions_pass: true,
        optional_peer_metadata_removed_pass: true,
      },
    })
  })

  it('detects load-bearing evaluation data hidden in published text files', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-package-leak-'))
    try {
      writeFileSync(join(root, 'README.md'), 'public docs plus hidden-owner-sha\n', 'utf8')
      writeFileSync(join(root, 'runtime.js'), 'export const value = true\n', 'utf8')

      expect(
        packageContentLeaks(
          ['README.md', 'runtime.js'],
          new Set(['hidden-owner-sha']),
          root,
        ),
      ).toEqual(['README.md: hidden-owner-sha'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds the evidence-path importer closure to protected-base Git content', () => {
    expect(
      createHash('sha256').update(readFileSync(resolve(EVIDENCE_IMPORTER_RECEIPT))).digest('hex'),
    ).toBe(EVIDENCE_IMPORTER_RECEIPT_SHA256)
    const receipt = JSON.parse(read(EVIDENCE_IMPORTER_RECEIPT)) as {
      schema_version: number
      receipt_kind: string
      issue: string
      finalizer_issue: string
      approvals: Record<string, string>
      subject: { commit: string; tree: string }
      method: { source_inventory: string; logical_loc: string; imports: string; scope: string }
      production: {
        predecessor_files: number
        predecessor_loc: number
        categories: Array<{ id: string; files: number; loc: number; paths: string[] }>
      }
      ownership: {
        absorbed_handles: string[]
        transfers: Array<{ path: string; from: string; to: string }>
        disposition_changes_from_baseline: number
        new_disposition_changes: Array<{ path: string; from: string; to: string }>
      }
      importer_closure: {
        edge_encoding: string
        all_edge_count: number
        all_edge_sha256: string
        internal_deleted_importer_count: number
        internal_edge_count: number
        internal_edge_sha256: string
        surviving_direct_importer_count: number
        surviving_edge_count: number
        surviving_edge_sha256: string
        surviving_direct_importers: Array<{ path: string; targets: string[] }>
        surface_only: Array<{ path: string; reason: string }>
        explicit_surviving_callsite_scope: Array<{ path: string; action: string }>
        unexpected_direct_importers: string[]
      }
      replacement: {
        production_files_max: number
        production_loc_added_max: number
        paths: string[]
        optional_peer_metadata_removed: string
      }
      supplemental_cleanup: Array<{
        path: string
        reason: string
        counted_in_predecessor_contract: boolean
      }>
      activation_state: string
    }

    expect(receipt).toMatchObject({
      schema_version: 1,
      receipt_kind: 'core-reset-evidence-path-importer-closure',
      issue: EVIDENCE_ISSUE,
      finalizer_issue: EVIDENCE_GENERATION_PREREQUISITE,
      approvals: {
        original_finalizer_proposal: EVIDENCE_FINALIZER_PROPOSAL,
        original_finalizer_owner_approval: EVIDENCE_FINALIZER_OWNER_APPROVAL,
        original_finalizer_rfc_approval: EVIDENCE_FINALIZER_RFC_APPROVAL,
        combined_dependency_proposal_599: EVIDENCE_COMBINED_PROPOSAL_599,
        combined_dependency_proposal_596: EVIDENCE_COMBINED_PROPOSAL_596,
        combined_rfc_proposal: EVIDENCE_COMBINED_RFC_PROPOSAL,
        combined_owner_approval_599: EVIDENCE_COMBINED_APPROVAL_599,
        combined_owner_approval_596: EVIDENCE_COMBINED_APPROVAL_596,
        combined_rfc_approval: EVIDENCE_COMBINED_RFC_APPROVAL,
      },
      subject: { commit: EVIDENCE_BASE, tree: EVIDENCE_BASE_TREE },
      method: {
        source_inventory: 'git ls-tree at the protected commit',
        logical_loc: 'LF count plus a final non-LF line',
        imports: 'TypeScript AST static import, re-export, dynamic import, import-equals, and require scan with repository-relative .js-to-.ts resolution',
      },
      production: { predecessor_files: 63, predecessor_loc: 33_031 },
      ownership: {
        absorbed_handles: ['context-governance-stack', 'derived-product-wrappers'],
        disposition_changes_from_baseline: 7,
        new_disposition_changes: [
          { path: 'src/infrastructure/proof-report.ts', from: 'move', to: 'delete' },
          { path: 'src/infrastructure/review-compare.ts', from: 'move', to: 'delete' },
          { path: 'src/runtime/serve.ts', from: 'rebuild', to: 'delete' },
        ],
      },
      importer_closure: {
        edge_encoding: 'sorted unique UTF-8 rows of importer + NUL + target + LF, including a final LF',
        all_edge_count: 263,
        all_edge_sha256: 'c842f2b2a4f05b35ff4b9eb0be44e70d2c75ba231710cea3e38d49336427213d',
        internal_deleted_importer_count: 51,
        internal_edge_count: 184,
        internal_edge_sha256: 'f1043bf1e245933cbcc45032600ba30a1cc41e7c98e90852c474b1f9c054521f',
        surviving_direct_importer_count: 16,
        surviving_edge_count: 79,
        surviving_edge_sha256: '820239c38b3036450309110681869f44932982851eaaa33e2e10ee184ade681a',
        surface_only: [{
          path: 'src/runtime/stdio/definitions.ts',
          reason: 'declares the retired MCP schemas without importing a predecessor',
        }],
        unexpected_direct_importers: [],
      },
      replacement: {
        production_files_max: 7,
        production_loc_added_max: 3_500,
        paths: [...EVIDENCE_REPLACEMENTS],
        optional_peer_metadata_removed: '@huggingface/transformers',
      },
      supplemental_cleanup: [{
        path: 'src/runtime/stdio/prompts.ts',
        reason: 'approved finalizer importer and public-surface cleanup',
        counted_in_predecessor_contract: false,
      }],
      activation_state: 'implementation_in_progress',
    })

    const categories = receipt.production.categories
    expect(categories.map(({ id, files, loc }) => ({ id, files, loc }))).toEqual([
      { id: 'query', files: 11, loc: 12_535 },
      { id: 'context-governance-stack', files: 26, loc: 6_538 },
      { id: 'derived-product-wrappers', files: 7, loc: 4_064 },
      { id: 'semantic', files: 1, loc: 368 },
      { id: 'importer-only-surfaces', files: 9, loc: 5_936 },
      { id: 'evidence-finalizers', files: 9, loc: 3_590 },
    ])
    const deletionFiles = categories.flatMap((category) => category.paths)
    expect(new Set(deletionFiles).size).toBe(63)
    expect(logicalLocAtCommit(EVIDENCE_BASE, deletionFiles)).toBe(33_031)
    for (const category of categories) {
      expect(category.paths).toHaveLength(category.files)
      expect(logicalLocAtCommit(EVIDENCE_BASE, category.paths)).toBe(category.loc)
    }

    const deletionFileSet = new Set(deletionFiles)
    const edges = deletionImportEdgesAtCommit(EVIDENCE_BASE, deletionFileSet)
    expect(edges).toMatchObject({
      all: expect.arrayContaining(['src/runtime/retrieve.ts\0src/runtime/semantic.ts']),
    })
    const scopedSurvivingEdges = receipt.importer_closure.surviving_direct_importers
      .flatMap(({ path, targets }) => targets.map((target) => `${path}\0${target}`))
      .sort()
    expect(scopedSurvivingEdges.every((edge) => edges.surviving.includes(edge))).toBe(true)
    const alreadyRewiredFinalizerEdges = edges.surviving
      .filter((edge) => !scopedSurvivingEdges.includes(edge))
    expect(alreadyRewiredFinalizerEdges).toEqual([
      'src/application/generate-index.ts\0src/pipeline/analyze.ts',
      'src/application/generate-index.ts\0src/pipeline/cluster.ts',
      'src/application/generate-index.ts\0src/pipeline/community-naming.ts',
      'src/application/generate-index.ts\0src/pipeline/report.ts',
      'src/cli/main.ts\0src/pipeline/federate.ts',
      'src/cli/main.ts\0src/runtime/diff.ts',
      'src/cli/main.ts\0src/runtime/graph-summary.ts',
      'src/infrastructure/benchmark.ts\0src/pipeline/analyze.ts',
      'src/infrastructure/benchmark.ts\0src/runtime/serve.ts',
      'src/infrastructure/benchmark/usage.ts\0src/runtime/serve.ts',
    ])
    const scopedAllEdges = [...edges.internal, ...scopedSurvivingEdges].sort()
    expect({
      all_edge_count: scopedAllEdges.length,
      all_edge_sha256: edgeListSha256(scopedAllEdges),
      internal_deleted_importer_count: new Set(edges.internal.map((edge) => edge.slice(0, edge.indexOf('\0')))).size,
      internal_edge_count: edges.internal.length,
      internal_edge_sha256: edgeListSha256(edges.internal),
      surviving_direct_importer_count: new Set(scopedSurvivingEdges.map((edge) => edge.slice(0, edge.indexOf('\0')))).size,
      surviving_edge_count: scopedSurvivingEdges.length,
      surviving_edge_sha256: edgeListSha256(scopedSurvivingEdges),
    }).toEqual({
      all_edge_count: receipt.importer_closure.all_edge_count,
      all_edge_sha256: receipt.importer_closure.all_edge_sha256,
      internal_deleted_importer_count: receipt.importer_closure.internal_deleted_importer_count,
      internal_edge_count: receipt.importer_closure.internal_edge_count,
      internal_edge_sha256: receipt.importer_closure.internal_edge_sha256,
      surviving_direct_importer_count: receipt.importer_closure.surviving_direct_importer_count,
      surviving_edge_count: receipt.importer_closure.surviving_edge_count,
      surviving_edge_sha256: receipt.importer_closure.surviving_edge_sha256,
    })

    const observedSurvivingImporters = [...new Set(scopedSurvivingEdges.map((edge) => edge.slice(0, edge.indexOf('\0'))))]
      .sort()
      .map((path) => ({
        path,
        targets: scopedSurvivingEdges
          .filter((edge) => edge.startsWith(`${path}\0`))
          .map((edge) => edge.slice(edge.indexOf('\0') + 1)),
      }))
    expect(receipt.importer_closure.surviving_direct_importers).toEqual(observedSurvivingImporters)
    expect(receipt.ownership.transfers.map((transfer) => transfer.path)).toEqual([...EVIDENCE_TRANSFERS])
    expect(receipt.ownership.transfers.every((transfer) => transfer.to === 'evidence-path-query')).toBe(true)
    expect(receipt.importer_closure.explicit_surviving_callsite_scope.map((entry) => entry.path).sort())
      .toEqual([
        ...observedSurvivingImporters.map((entry) => entry.path),
        'src/runtime/stdio/definitions.ts',
      ].sort())
    expect(EVIDENCE_REPLACEMENTS.every((path) => existsSync(resolve(path)))).toBe(true)
  })

  it('publishes an exact hermetic generation mutation receipt', () => {
    expect(gitBlobSha256('HEAD', INCREMENTAL_MUTATION_RECEIPT)).toBe(INCREMENTAL_MUTATION_RECEIPT_SHA256)
    expect(gitBlobSha256(EVIDENCE_BASE, INCREMENTAL_MUTATION_RECEIPT)).toBe(
      INCREMENTAL_MUTATION_RECEIPT_SHA256,
    )
    const receipt = JSON.parse(read(INCREMENTAL_MUTATION_RECEIPT)) as {
      schema_version: number
      receipt_kind: string
      status: string
      issue: string
      pull_request: string
      subject: {
        protected_base: string
        implementation_commit: string
        final_pr_head: string
        ci_head: string
        merge_commit: string
        final_and_merge_tree: string
        runtime_source_or_package_drift_after_implementation: boolean
      }
      verification: {
        command: string
        test_files_passed: number
        tests_passed: number
        tests_failed: number
        ci_run: string
        ci_matrix_jobs_passed: number
      }
      test_files: Array<{ path: string; sha256: string }>
      mutation_cases: string[]
      publication_and_concurrency_cases: string[]
      equivalence_contract: {
        update_equals_clean_generation: boolean
        authoritative_graph_bytes_equal: boolean
        derived_diagnostics_equal_except_generated_at: boolean
        deterministic_build_id_equal: boolean
        zero_stale_nodes_or_edges_after_delete_or_rename: boolean
        graph_commits_last: boolean
        maximum_concurrent_builders: number
      }
    }

    expect(receipt).toMatchObject({
      schema_version: 1,
      receipt_kind: 'core-reset-generation-mutation-equivalence',
      status: 'passed',
      issue: 'https://github.com/mohanagy/madar/issues/592',
      pull_request: 'https://github.com/mohanagy/madar/pull/594',
      subject: {
        protected_base: INCREMENTAL_BASE,
        implementation_commit: INCREMENTAL_IMPLEMENTATION,
        final_pr_head: INCREMENTAL_CI_HEAD,
        ci_head: INCREMENTAL_CI_HEAD,
        merge_commit: INCREMENTAL_MERGE,
        final_and_merge_tree: INCREMENTAL_FINAL_TREE,
        runtime_source_or_package_drift_after_implementation: false,
      },
      verification: {
        test_files_passed: 5,
        tests_passed: 92,
        tests_failed: 0,
        ci_run: INCREMENTAL_CI_RUN,
        ci_matrix_jobs_passed: 6,
      },
      equivalence_contract: {
        update_equals_clean_generation: true,
        authoritative_graph_bytes_equal: true,
        derived_diagnostics_equal_except_generated_at: true,
        deterministic_build_id_equal: true,
        zero_stale_nodes_or_edges_after_delete_or_rename: true,
        graph_commits_last: true,
        maximum_concurrent_builders: 1,
      },
    })
    expect(receipt.verification.command).toContain('tests/unit/update-index.test.ts')
    expect(receipt.mutation_cases).toEqual(expect.arrayContaining([
      'cold_no_op',
      'add_and_import',
      'private_leaf_change',
      'exported_signature_change',
      'delete_with_zero_stale_facts',
      'rename_with_zero_stale_facts',
      'compiler_control_change',
      'madarignore_add_change_delete',
      'gitignore_respected_and_ignored',
      'recognized_unsupported_add_delete_rename',
      'allowed_symlink_add_retarget_delete',
      'linked_worktree_isolation',
    ]))
    expect(receipt.publication_and_concurrency_cases).toEqual(expect.arrayContaining([
      'first_graph_commit_failure',
      'replacement_graph_commit_failure',
      'derived_diagnostic_failure',
      'source_edit_at_commit_boundary',
      'edit_during_build_follow_up',
      'concurrent_controller_serialization',
    ]))
    expect(receipt.test_files).toHaveLength(5)
    for (const file of receipt.test_files) {
      const recordedTest = execFileSync(git, ['show', `${receipt.subject.merge_commit}:${file.path}`])
      expect(createHash('sha256').update(recordedTest).digest('hex')).toBe(file.sha256)
    }
    expect(execFileSync(git, ['show', '-s', '--format=%T', receipt.subject.merge_commit], { encoding: 'utf8' }).trim())
      .toBe(INCREMENTAL_FINAL_TREE)
  })

  it('measures logical LOC independently from checkout line endings', () => {
    const root = mkdtempSync(join(tmpdir(), 'madar-core-reset-loc-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'tracked.ts'), 'export const one = 1\nexport const two = 2\n')
      execFileSync(git, ['init', '-b', 'main'], { cwd: root })
      execFileSync(git, ['config', 'core.autocrlf', 'false'], { cwd: root })
      execFileSync(git, ['config', 'user.email', 'madar-core-reset@example.invalid'], { cwd: root })
      execFileSync(git, ['config', 'user.name', 'Madar Core Reset'], { cwd: root })
      execFileSync(git, ['add', '.'], { cwd: root })
      execFileSync(git, ['commit', '-m', 'baseline'], { cwd: root })
      const baseline = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

      writeFileSync(join(root, 'src', 'tracked.ts'), 'export const one = 1\r\nexport const two = 3\r\n')
      writeFileSync(join(root, 'src', 'untracked.ts'), 'export const added = true\r\n')

      expect(productionSourceDelta(baseline, root)).toEqual({ added: 2, removed: 1, net: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('measures the current source inventory and phase delta from the recorded protected base', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      current: {
        completed_phase: string
        active_phase: string | null
        base_commit: string
        production_typescript_files: number
        production_typescript_loc: number
        production_loc_added: number
        production_loc_removed: number
        production_loc_net: number
        npm_files: number
        npm_packed_bytes: number
        npm_unpacked_bytes: number
      }
      items: Array<{
        id: string
        disposition: string
        status: string
        production_loc_budget?: { added_max: number; removed_min: number; net_max: number }
      }>
    }
    const { current } = manifest
    expect(execFileSync(git, ['cat-file', '-t', `${current.base_commit}^{commit}`], { encoding: 'utf8' }).trim()).toBe('commit')
    expect(() => execFileSync(git, ['merge-base', '--is-ancestor', current.base_commit, 'HEAD'])).not.toThrow()

    const inventory = sourceInventory()
    const delta = productionSourceDelta(current.base_commit)
    const phase = manifest.items.find((item) => item.id === (current.active_phase ?? current.completed_phase))
    const budget = phase?.production_loc_budget
    expect(budget).toBeDefined()
    expect(inventory.filesystemViolations).toEqual([])
    expect(delta.added).toBeLessThanOrEqual(budget!.added_max)
    const isActivationOnly = current.active_phase !== null
      && phase?.status === 'in_progress'
      && delta.added === 0
      && delta.removed === 0
      && delta.net === 0
    const meetsExitBudget = delta.removed >= budget!.removed_min
      && delta.net <= budget!.net_max
    expect(isActivationOnly || meetsExitBudget).toBe(true)
    expect({
      production_typescript_files: inventory.files,
      production_typescript_loc: inventory.loc,
      production_loc_added: delta.added,
      production_loc_removed: delta.removed,
      production_loc_net: delta.net,
    }).toEqual({
      production_typescript_files: current.production_typescript_files,
      production_typescript_loc: current.production_typescript_loc,
      production_loc_added: current.production_loc_added,
      production_loc_removed: current.production_loc_removed,
      production_loc_net: current.production_loc_net,
    })
    expect(current.npm_files).toBeGreaterThan(0)
    expect(current.npm_packed_bytes).toBeGreaterThan(0)
    expect(current.npm_unpacked_bytes).toBeGreaterThan(0)
  })

  it('records the simplified implementation without retaining the failed warm path', () => {
    expect(productionSourceDeltaBetween(INCREMENTAL_BASE, INCREMENTAL_MERGE))
      .toEqual({ added: 2_190, removed: 4_726, net: -2_536 })
    expect(execFileSync(git, ['rev-parse', `${INCREMENTAL_MERGE}^{tree}`], { encoding: 'utf8' }).trim())
      .toBe(INCREMENTAL_FINAL_TREE)
    for (const predecessor of INCREMENTAL_PREDECESSORS) {
      expect(existsSync(resolve(predecessor)), `${predecessor} must be deleted`).toBe(false)
    }
    for (const replacement of INCREMENTAL_REPLACEMENTS) {
      expect(existsSync(resolve(replacement)), `${replacement} must exist`).toBe(true)
    }

    const production = productionTypeScriptFiles().map((path) => read(path)).join('\n')
    for (const rejectedApi of [
      'warm_incremental',
      'CanonicalTypeScriptIndexSession',
      'createCanonicalTypeScriptIndexSession',
      'createUpdateIndexSession',
      'persistentWarmSession',
      'indexSession',
    ]) {
      expect(production, `${rejectedApi} must not survive in production`).not.toContain(rejectedApi)
    }

    const stop = JSON.parse(read('docs/core-reset/evidence/generation-incremental-stop-500.json')) as {
      measured_candidate_commit: string
      eligible_for_acceptance: boolean
      subject: { worktree_tree_oid: string }
      gates: {
        warm_index_p50_ratio: { actual: number; pass: boolean }
        warm_refresh_p50_ratio: { actual: number; pass: boolean }
        warm_refresh_p95_ratio: { actual: number; pass: boolean }
      }
      stop_condition: { triggered: boolean; held_out: { status: string } }
    }
    expect(stop).toMatchObject({
      measured_candidate_commit: STOPPED_INCREMENTAL_CANDIDATE,
      eligible_for_acceptance: false,
      subject: { worktree_tree_oid: STOPPED_INCREMENTAL_TREE },
      gates: {
        warm_index_p50_ratio: { actual: 0.824, pass: false },
        warm_refresh_p50_ratio: { actual: 1.047, pass: false },
        warm_refresh_p95_ratio: { actual: 1.029, pass: false },
      },
      stop_condition: { triggered: true, held_out: { status: 'intentionally_skipped' } },
    })

    const receipt = JSON.parse(read('docs/core-reset/evidence/generation-incremental-inventory.json')) as unknown
    expect(receipt).toEqual({
      schema_version: 1,
      issue: 'https://github.com/mohanagy/madar/issues/592',
      protected_base: INCREMENTAL_BASE,
      implementation_commit: INCREMENTAL_IMPLEMENTATION,
      production: {
        typescript_files: 130,
        typescript_loc: 66_418,
        loc_added: 2_190,
        loc_removed: 4_726,
        loc_net: -2_536,
        predecessor_files_removed: 15,
        predecessor_loc_removed: 3_839,
        replacement_files: 6,
        replacement_loc: 1_484,
        runtime_dependencies_added: 0,
        development_dependencies_added: 0,
      },
      package: {
        command: 'npm pack --dry-run --json',
        name: '@lubab/madar',
        version: '0.32.0',
        files: 276,
        packed_bytes: 572_143,
        unpacked_bytes: 2_699_851,
        shasum: '93b79f9d81f193af3c3d6e45159eae56fc9523a9',
        integrity: 'sha512-7BNI5MBA92VWPpY0/CzZ2feSYRc+kCUcUw5IIpLdg2rqRCtEANIMgmkBFXI0L7NufrpbVTc7xfBr6rWRtNijmg==',
      },
      budgets: {
        production_files_pass: true,
        production_loc_pass: true,
        production_delta_pass: true,
        replacement_surface_pass: true,
        package_files_pass: true,
        package_unpacked_bytes_pass: true,
        package_packed_bytes_pass: true,
        dependency_additions_pass: true,
      },
    })

    const shipping = JSON.parse(read('docs/core-reset/evidence/generation-full-reconcile-500.json')) as {
      eligible_for_acceptance: boolean
      receipt_sha256: string
      subject: { head_commit: string; dirty: boolean; head_tree_oid: string; worktree_tree_oid: string }
      environment: { node: string }
      protocol: { warmups: number; trials: number; persistent_warm_session: boolean; shipping_path: string }
      gates: {
        subject_identity: { pass: boolean }
        sample_protocol: { pass: boolean }
        corpus_eligibility: { pass: boolean }
        cold_noop_p50_ratio: { actual: number; pass: boolean }
        cold_noop_zero_parse: { pass: boolean }
        clean_generation_regression: { baseline_compatible: boolean; ratio: number; pass: boolean }
      }
    }
    expect(shipping).toMatchObject({
      eligible_for_acceptance: true,
      receipt_sha256: '4b64f83dabcab80a3e60e35ada275c4852c32e549a0586c905d6f375534836b4',
      subject: {
        head_commit: INCREMENTAL_IMPLEMENTATION,
        dirty: false,
        head_tree_oid: '3d8ad953b47a06e211e54958c8c8d194d5a2d999',
        worktree_tree_oid: '3d8ad953b47a06e211e54958c8c8d194d5a2d999',
      },
      environment: { node: 'v22.9.0' },
      protocol: {
        warmups: 3,
        trials: 20,
        persistent_warm_session: false,
        shipping_path: 'cold_noop_or_full_canonical_reconcile',
      },
      gates: {
        subject_identity: { pass: true },
        sample_protocol: { pass: true },
        corpus_eligibility: { pass: true },
        cold_noop_p50_ratio: { actual: 0.067, pass: true },
        cold_noop_zero_parse: { pass: true },
        clean_generation_regression: { baseline_compatible: true, ratio: 1.045, pass: true },
      },
    })
  })

  it('keeps retired exporter flags out of active commands without rewriting frozen v0.32 evidence', () => {
    expect(read('.github/workflows/ci.yml')).not.toContain('--no-html')
    expect(read('.github/ISSUE_TEMPLATE/design_partner_report.yml')).not.toContain('--no-html')
    expect(read('tools/eval/core-reset/contracts/evaluation-contract.json')).toContain('"--no-html"')
    expect(read('docs/core-reset/evidence/baseline-v0.32.0.json')).toContain('"--no-html"')
  })

  it('assigns every production TypeScript file to exactly one removal-manifest item', () => {
    const manifest = parse(read('docs/core-reset/removal-manifest.yml')) as {
      current: { production_typescript_files: number }
      review: {
        status: string
        production_files_reviewed: number
        files_with_one_owner: number
        unowned_files: number
        overlapping_files: number
        disposition_changes: number
        amendment: string
      }
      items: Array<{
        id: string
        disposition: string
        status: string
        absorbs?: string[]
        absorbed_by?: string
        sources?: string[]
        removed_sources?: string[]
        supplemental_cleanup_sources?: string[]
        transferred_sources?: string[]
        preserve?: string[]
        completion?: { commit: string }
      }>
    }
    const productionFiles = productionTypeScriptFiles()

    for (const file of productionFiles) {
      const owners = manifest.items.filter((item) =>
        (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(file)))
      expect(owners.map((item) => item.id), `${file} must have exactly one owner`).toHaveLength(1)
    }
    const legacy = manifest.items.find((item) => item.id === 'legacy-extraction')
    const transferred = [
      'src/application/build-graph.ts',
      'src/core/provenance/ingest.ts',
      'src/infrastructure/cache.ts',
      'src/infrastructure/capabilities.ts',
    ]
    expect(legacy?.removed_sources?.filter((source) => transferred.includes(source))).toEqual(transferred)
    for (const source of transferred) {
      expect(
        manifest.items
          .filter((item) => item.id !== 'legacy-extraction')
          .filter((item) => (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(source)))
          .map((item) => item.id),
        `${source} must transfer exclusively to legacy-extraction`,
      ).toEqual([])
    }
    const generation = manifest.items.find((item) => item.id === 'generation-and-incremental')
    expect(generation?.transferred_sources).toEqual(Object.keys(INCREMENTAL_TRANSFERS))
    for (const [source, expectedOwner] of Object.entries(INCREMENTAL_TRANSFERS)) {
      expect(generation?.sources ?? [], `${source} cannot remain owned by generation`).not.toContain(source)
      expect(
        manifest.items
          .filter((item) => [
            ...(item.sources ?? []),
            ...(item.removed_sources ?? []),
          ].some((pattern) => manifestGlob(pattern).test(source)))
          .map((item) => item.id),
        `${source} must have one transferred owner`,
      ).toEqual([expectedOwner])
    }
    const evidencePath = manifest.items.find((item) => item.id === 'evidence-path-query')
    const thinDelivery = manifest.items.find((item) => item.id === 'thin-delivery')
    expect(evidencePath?.transferred_sources).toEqual([...EVIDENCE_TRANSFERS])
    expect(evidencePath?.preserve).toEqual([
      'SourceDomain',
      'classifySourceDomain',
      'isPollutedSourcePath',
      'private helpers required only by those query-classification exports',
    ])
    const evaluationTooling = manifest.items.find((item) => item.id === 'evaluation-tooling')
    const safeWorkspace = manifest.items.find((item) => item.id === 'safe-workspace-primitives')
    expect(thinDelivery?.transferred_sources).toEqual(['src/infrastructure/doctor.ts'])
    expect(evaluationTooling?.transferred_sources).toEqual([...EVALUATION_TOOLING_TRANSFERS])
    expect(safeWorkspace?.sources).not.toEqual(expect.arrayContaining([
      'src/shared/graph-source-root.ts',
      'src/shared/workspace-copy.ts',
    ]))
    expect(evidencePath?.status).toBe('complete')
    expect(thinDelivery?.status).toBe('complete')
    expect(evaluationTooling?.status).toBe('complete')
    for (const completedId of [
      'directed-multigraph',
      'canonical-typescript-index',
      'legacy-extraction',
      'generation-and-incremental',
      'evidence-path-query',
      'thin-delivery',
      'evaluation-tooling',
    ]) {
      const completed = manifest.items.find((item) => item.id === completedId)
      expect(completed).toBeDefined()
      expect(completed?.completion?.commit).toBeDefined()
      const completedOwnerIds = new Set([completedId, ...(completed?.absorbs ?? [])])
      const completedOwners = manifest.items.filter((item) => completedOwnerIds.has(item.id))
      expect(completedOwners).toHaveLength(completedOwnerIds.size)
      const removedSources = completed?.disposition === 'move'
        ? [...(completed.sources ?? [])]
        : completedOwners.flatMap((item) => [
          ...(item.removed_sources ?? []),
          ...(item.supplemental_cleanup_sources ?? []),
        ])
      const deletedFiles = deletedProductionFiles(completed!.completion!.commit)
      const deletedPredecessors = deletedFiles.filter((path) =>
        removedSources.some((pattern) => manifestGlob(pattern).test(path)))
      expect(
        [...deletedPredecessors].sort(),
        `${completedId} removed_sources must account for every production TypeScript deletion`,
      ).toEqual([...deletedFiles].sort())

      for (const removed of removedSources) {
        const removedPattern = manifestGlob(removed)
        expect(
          deletedPredecessors.some((path) => removedPattern.test(path)),
          `${removed} must be evidenced as deleted by ${completedId}`,
        ).toBe(true)
        expect(
          productionFiles.filter((file) => removedPattern.test(file)),
          `${removed} must be deleted by ${completedId}`,
        ).toEqual([])
      }

      for (const removedFile of deletedPredecessors) {
        const futureOwners = manifest.items.filter((item) =>
          !completedOwnerIds.has(item.id) && (item.sources ?? []).some((pattern) => manifestGlob(pattern).test(removedFile)))
        expect(futureOwners.map((item) => item.id), `${removedFile} cannot remain assigned to a later phase`).toEqual([])
      }
    }
    expect(manifest.review).toMatchObject({
      status: 'complete',
      production_files_reviewed: 181,
      files_with_one_owner: 181,
      unowned_files: 0,
      overlapping_files: 0,
      disposition_changes: 11,
    })
    expect(manifest.review.amendment).toContain('Approved issues #596 and #599 combined')
    expect(manifest.review.amendment).toContain('serve.ts changed from rebuild to delete')
    expect(manifest.review.amendment).toContain('Owner-approved issue #602')
    expect(manifest.review.amendment).toContain('Owner-approved issue #606')
  })

  it('routes contributors through the reset contract', () => {
    const issueConfig = read('.github/ISSUE_TEMPLATE/config.yml')
    const workItem = parse(read('.github/ISSUE_TEMPLATE/core_reset_work_item.yml')) as {
      body: Array<{
        id?: string
        validations?: { required?: boolean }
        attributes?: { options?: Array<{ required?: boolean }> }
      }>
    }
    const pullRequestTemplate = read('.github/pull_request_template.md')

    expect(issueConfig).toContain('/blob/main/docs/roadmap.md')
    expect(issueConfig).not.toContain('/issues/155')

    const requiredFieldIds = [
      'parent',
      'problem',
      'manifest',
      'dependencies',
      'implementation',
      'deletion',
      'budget',
      'gates',
      'verification',
      'non_goals',
    ]
    for (const id of requiredFieldIds) {
      expect(workItem.body.find((field) => field.id === id)?.validations?.required).toBe(true)
    }
    const resetContract = workItem.body.find((field) => field.id === 'reset_contract')
    expect(resetContract?.attributes?.options?.length).toBeGreaterThan(0)
    expect(resetContract?.attributes?.options?.every((option) => option.required)).toBe(true)

    expect(pullRequestTemplate).toContain('## Core Reset contract')
    expect(pullRequestTemplate).toContain('Removal-manifest IDs')
    expect(pullRequestTemplate).toContain('Net production LOC')
  })

  it('does not retain stale completed-phase language', () => {
    const governance = [
      read('docs/roadmap.md'),
      read('docs/core-reset/scorecard.md'),
      read('docs/core-reset/removal-manifest.yml'),
      read('docs/designs/2026-07-19-core-reset.md'),
    ].join('\n')
    expect(governance).not.toContain('candidate evidence')
    expect(governance).not.toContain('pending PR review')
    expect(governance).not.toContain('Final CI matrix, CodeRabbit, and unresolved-thread evidence remains pending')
    expect(governance).not.toContain('single In progress phase through #588')
    expect(governance).not.toContain('Legacy and non-code deletion contract (in progress)')
    expect(governance).not.toContain('## Ready — generation and incremental index')
    expect(governance).toContain('## Passed — evidence-path query')
    expect(governance).toContain('## Passed — thin delivery')
    expect(governance).toContain('## Passed — evaluation tooling isolation')
    expect(governance).toContain('## Completed amendment — evaluation tooling isolation')
    expect(governance).toContain('## Stopped — capability validation')
    expect(governance).toContain('## Passed — retrieval regression #618')
    expect(governance).toContain('## Ready — `0.40.0-beta.2`')
    expect(governance).toContain('## Stopped amendment — capability validation v1')
    expect(governance).toContain('## Historical accepted amendment — capability validation v2')
    expect(governance).toContain('## Cancelled amendment — capability validation')
    expect(governance).toContain('## Completed amendment — retrieval regression #618')
    expect(governance).toContain('No technical implementation phase is active')
    expect(governance).toContain('At that #608 completion checkpoint no technical phase was active')
    expect(governance).not.toContain('\nNo technical phase is active; Capability Validation')
    expect(governance).not.toContain('## In progress — evaluation tooling isolation')
    expect(governance).not.toContain('`evaluation-tooling` is the sole active phase')
    expect(governance).not.toContain('Evaluation tooling is active under owner-approved #606')
    expect(governance).not.toContain('evaluation isolation is active under owner-approved #606')
    expect(governance).not.toContain('Evaluation-tooling isolation is active under owner-approved #606')
    expect(governance).not.toContain('This is not a completion claim')
    expect(governance).not.toContain('## Ready — evaluation tooling isolation')
    expect(governance).not.toContain('Evaluation tooling is Ready but not active')
    expect(governance).not.toContain('evaluation isolation is Ready but not active')
    expect(governance).not.toContain('Evaluation-tooling isolation is Ready but not active')
    expect(governance).not.toContain('## In progress — thin delivery')
    expect(governance).not.toContain('Thin Delivery is the sole technical phase In progress')
    expect(governance).not.toContain('Thin Delivery is active under owner-approved #602')
    expect(governance).not.toContain('thin delivery is now active under owner-approved #602')
    expect(governance).not.toContain('Thin Delivery is Ready but not activated')
    expect(governance).not.toContain('Thin Delivery is Ready but not active')
    expect(governance).not.toContain('Evidence-path query is the sole technical phase In progress')
    expect(governance).not.toContain('## In progress — evidence-path query')
    expect(governance).not.toContain('## In progress — generation and incremental index')
    expect(governance).not.toContain('single In progress phase through #592')
    expect(governance).not.toContain('phase completion awaits')
    expect(governance).not.toContain('completion evidence remains open')
    expect(governance).not.toContain('scope and baseline is the only authorized phase')
    expect(governance).not.toContain('Capability Validation is Ready')
    expect(governance).not.toContain('ready_phase: capability-validation')
    expect(governance).not.toContain('`capability-validation` is the sole active phase')
  })
})
