#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { cpus, platform, release, totalmem, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROTECTED_BASE = '8886a0299ee30765ce149ca7ad5d1779496b78b5'
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])
const DEFAULT_WARMUPS = 3
const DEFAULT_TRIALS = 20
const DEFAULT_FIXTURE_FILES = 500

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000
}

export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('percentile requires at least one sample')
  if (!(percentile > 0 && percentile <= 100)) throw new Error('percentile must be in (0, 100]')
  const sorted = values.map(Number).sort((left, right) => left - right)
  return rounded(sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)])
}

function numericSummary(values) {
  return {
    min: rounded(Math.min(...values)),
    max: rounded(Math.max(...values)),
    p50: nearestRank(values, 50),
    p95: nearestRank(values, 95),
  }
}

export function summarizeTrials(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('trial summary requires samples')
  const elapsed = samples.map((sample) => sample.elapsed_ms)
  const summary = {
    count: samples.length,
    elapsed_ms: numericSummary(elapsed),
  }
  for (const key of ['parsed_files', 'reused_files', 'invalidated_files', 'dependency_closure_size']) {
    if (samples.every((sample) => Number.isInteger(sample[key]))) {
      summary[key] = numericSummary(samples.map((sample) => sample[key]))
    }
  }
  return summary
}

function ratio(numerator, denominator) {
  return denominator > 0 ? rounded(numerator / denominator) : null
}

function gate(actual, maximum) {
  return { actual, maximum, pass: actual !== null && actual <= maximum }
}

function all(samples, predicate) {
  return samples.length > 0 && samples.every(predicate)
}

export function buildCandidateReceipt(input) {
  const summaries = Object.fromEntries(
    Object.entries(input.samples).map(([name, samples]) => [name, summarizeTrials(samples)]),
  )
  const clean = summaries.clean_generation.elapsed_ms
  const cleanIndex = summaries.clean_index_stage.elapsed_ms
  const coldNoop = summaries.cold_noop.elapsed_ms
  const warmNoop = summaries.warm_noop.elapsed_ms
  const warmIndex = summaries.warm_leaf_index_stage.elapsed_ms
  const warmRefresh = summaries.warm_leaf_refresh.elapsed_ms
  const baselineP50 = input.baseline?.measurements?.clean_generation?.elapsed_ms?.p50 ?? null
  const baselineCompatible = Boolean(input.baseline)
    && input.baseline.schema_version === 2
    && input.baseline.receipt_kind === 'core-reset-clean-generation-baseline'
    && input.baseline.subject.head_commit === PROTECTED_BASE
    && input.baseline.subject.dirty === false
    && input.baseline.corpus.fingerprint === input.corpus.fingerprint
    && input.baseline.protocol.warmups >= DEFAULT_WARMUPS
    && input.baseline.protocol.trials >= DEFAULT_TRIALS
    && input.baseline.environment.fingerprint === input.environment.fingerprint
  const cleanRegression = baselineCompatible ? ratio(clean.p50, baselineP50) : null
  const sampleProtocolPass = input.protocol.warmups >= DEFAULT_WARMUPS
    && input.protocol.trials >= DEFAULT_TRIALS
    && Object.values(input.samples).every((samples) => samples.length >= DEFAULT_TRIALS)
  const corpusPass = input.corpus.kind === 'synthetic_fixture'
    ? input.corpus.supported_files >= DEFAULT_FIXTURE_FILES
    : input.corpus.kind === 'held_out_repository'
      && input.corpus.supported_files > 0
      && /^[a-f0-9]{40}$/.test(input.corpus.commit)
  const gates = {
    sample_protocol: {
      actual: { warmups: input.protocol.warmups, trials: input.protocol.trials },
      minimum: { warmups: DEFAULT_WARMUPS, trials: DEFAULT_TRIALS },
      pass: sampleProtocolPass,
    },
    corpus_eligibility: {
      kind: input.corpus.kind,
      supported_files: input.corpus.supported_files,
      requirement: input.corpus.kind === 'synthetic_fixture'
        ? `at least ${DEFAULT_FIXTURE_FILES} supported files`
        : 'non-empty supported corpus pinned to a 40-character Git commit',
      pass: corpusPass,
    },
    cold_noop_p50_ratio: gate(ratio(coldNoop.p50, clean.p50), 0.20),
    warm_noop_zero_parse: {
      pass: all(input.samples.warm_noop, (sample) => sample.parsed_files === 0
        && sample.invalidated_files === 0 && sample.publication_advanced === false),
    },
    warm_private_leaf_scope: {
      pass: all(input.samples.warm_leaf_refresh, (sample) => sample.parsed_files === 1
        && sample.invalidated_files === 1 && sample.dependency_closure_size === 0),
    },
    warm_index_p50_ratio: gate(ratio(warmIndex.p50, cleanIndex.p50), 0.50),
    warm_refresh_p50_ratio: gate(ratio(warmRefresh.p50, clean.p50), 0.75),
    warm_refresh_p95_ratio: gate(ratio(warmRefresh.p95, clean.p95), 0.80),
    clean_generation_regression: {
      baseline_compatible: baselineCompatible,
      ratio: cleanRegression,
      maximum_regression: 0.10,
      pass: cleanRegression !== null && cleanRegression <= 1.10,
    },
  }
  const passed = Object.values(gates).every((entry) => entry.pass)
  const stopReasons = [
    ...(!gates.warm_index_p50_ratio.pass ? ['warm_index_p50_ratio_exceeds_0.50'] : []),
    ...(!gates.warm_refresh_p50_ratio.pass ? ['warm_refresh_p50_ratio_exceeds_0.75'] : []),
    ...(!gates.warm_refresh_p95_ratio.pass ? ['warm_refresh_p95_ratio_exceeds_0.80'] : []),
  ]
  const stopTriggered = stopReasons.length > 0
  const body = {
    schema_version: 2,
    receipt_kind: 'core-reset-incremental-performance',
    issue: 592,
    eligible_for_acceptance: passed,
    subject: input.subject,
    baseline: input.baseline ? {
      head_commit: input.baseline.subject.head_commit,
      worktree_tree_oid: input.baseline.subject.worktree_tree_oid,
      dist_fingerprint: input.baseline.subject.dist_fingerprint,
      receipt_sha256: input.baseline.receipt_sha256,
      clean_generation_p50_ms: baselineP50,
      compatible: baselineCompatible,
    } : null,
    corpus: input.corpus,
    environment: input.environment,
    protocol: input.protocol,
    measurements: summaries,
    samples: input.samples,
    gates,
    stop_condition: {
      triggered: stopTriggered,
      policy: 'Issue #592 requires simplification when the fixed 500-file warm index-stage or end-to-end gate fails.',
      reasons: stopReasons,
      held_out: stopTriggered
        ? {
            status: 'intentionally_skipped',
            reason: 'The fixed 500-file gate already triggered the mandatory #592 stop condition; held-out timing cannot reverse it.',
          }
        : { status: 'required_before_acceptance', reason: null },
    },
  }
  return { ...body, receipt_sha256: sha256(canonicalJson(body)) }
}

export function buildBaselineReceipt(input) {
  const body = {
    schema_version: 2,
    receipt_kind: 'core-reset-clean-generation-baseline',
    subject: input.subject,
    corpus: input.corpus,
    environment: input.environment,
    protocol: input.protocol,
    measurements: { clean_generation: summarizeTrials(input.samples) },
    samples: input.samples,
  }
  return { ...body, receipt_sha256: sha256(canonicalJson(body)) }
}

export function buildShippingReceipt(input) {
  const clean = summarizeTrials(input.samples.clean_generation)
  const coldNoop = summarizeTrials(input.samples.cold_noop)
  const baselineP50 = input.baseline?.measurements?.clean_generation?.elapsed_ms?.p50 ?? null
  const baselineCompatible = Boolean(input.baseline)
    && input.baseline.schema_version === 2
    && input.baseline.receipt_kind === 'core-reset-clean-generation-baseline'
    && input.baseline.subject.head_commit === PROTECTED_BASE
    && input.baseline.subject.dirty === false
    && input.baseline.corpus.fingerprint === input.corpus.fingerprint
    && input.baseline.protocol.warmups >= DEFAULT_WARMUPS
    && input.baseline.protocol.trials >= DEFAULT_TRIALS
    && input.baseline.environment.fingerprint === input.environment.fingerprint
  const cleanRatio = baselineCompatible ? ratio(clean.elapsed_ms.p50, baselineP50) : null
  const corpusPass = input.corpus.kind === 'synthetic_fixture'
    ? input.corpus.supported_files >= DEFAULT_FIXTURE_FILES
    : input.corpus.kind === 'held_out_repository'
      && input.corpus.supported_files > 0
      && /^[a-f0-9]{40}$/.test(input.corpus.commit)
  const subjectPass = input.subject.dirty === false
    && input.subject.head_tree_oid === input.subject.worktree_tree_oid
    && /^[a-f0-9]{40}$/.test(input.subject.head_commit)
  const gates = {
    subject_identity: {
      head_commit: input.subject.head_commit, clean: input.subject.dirty === false,
      tree_matches_head: input.subject.head_tree_oid === input.subject.worktree_tree_oid, pass: subjectPass,
    },
    sample_protocol: {
      actual: { warmups: input.protocol.warmups, trials: input.protocol.trials },
      minimum: { warmups: DEFAULT_WARMUPS, trials: DEFAULT_TRIALS },
      pass: input.protocol.warmups >= DEFAULT_WARMUPS && input.protocol.trials >= DEFAULT_TRIALS
        && input.samples.clean_generation.length >= DEFAULT_TRIALS
        && input.samples.cold_noop.length >= DEFAULT_TRIALS,
    },
    corpus_eligibility: {
      kind: input.corpus.kind,
      supported_files: input.corpus.supported_files,
      requirement: input.corpus.kind === 'synthetic_fixture'
        ? `at least ${DEFAULT_FIXTURE_FILES} supported files`
        : 'non-empty supported corpus pinned to a 40-character Git commit',
      pass: corpusPass,
    },
    cold_noop_p50_ratio: gate(ratio(coldNoop.elapsed_ms.p50, clean.elapsed_ms.p50), 0.20),
    cold_noop_zero_parse: {
      pass: all(input.samples.cold_noop, (sample) => sample.mode === 'cold_noop'
        && sample.parsed_files === 0 && sample.invalidated_files === 0
        && sample.publication_advanced === false),
    },
    clean_generation_regression: {
      baseline_compatible: baselineCompatible,
      ratio: cleanRatio,
      maximum_regression: 0.10,
      pass: cleanRatio !== null && cleanRatio <= 1.10,
    },
  }
  const body = {
    schema_version: 1,
    receipt_kind: 'core-reset-full-reconcile-performance',
    issue: 592,
    eligible_for_acceptance: Object.values(gates).every((entry) => entry.pass),
    subject: input.subject,
    baseline: input.baseline ? {
      head_commit: input.baseline.subject.head_commit,
      receipt_sha256: input.baseline.receipt_sha256,
      clean_generation_p50_ms: baselineP50,
      compatible: baselineCompatible,
    } : null,
    corpus: input.corpus,
    environment: input.environment,
    protocol: { ...input.protocol, shipping_path: 'cold_noop_or_full_canonical_reconcile' },
    measurements: { clean_generation: clean, cold_noop: coldNoop },
    samples: input.samples,
    gates,
  }
  return { ...body, receipt_sha256: sha256(canonicalJson(body)) }
}

function parseInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`)
  return parsed
}

function option(argv, flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return null
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${flag} requires a value`)
  return argv[index + 1]
}

function parseArgs(argv) {
  const mode = option(argv, '--mode') ?? 'candidate'
  if (!['baseline', 'candidate', 'shipping'].includes(mode)) throw new Error('--mode must be baseline, candidate, or shipping')
  const warmups = parseInteger(option(argv, '--warmups') ?? String(DEFAULT_WARMUPS), '--warmups')
  const trials = parseInteger(option(argv, '--trials') ?? String(DEFAULT_TRIALS), '--trials')
  if (warmups < DEFAULT_WARMUPS) throw new Error(`--warmups must be at least ${DEFAULT_WARMUPS}`)
  if (trials < DEFAULT_TRIALS) throw new Error(`--trials must be at least ${DEFAULT_TRIALS}`)
  const fixtureFiles = parseInteger(option(argv, '--fixture-files') ?? String(DEFAULT_FIXTURE_FILES), '--fixture-files')
  if (fixtureFiles < DEFAULT_FIXTURE_FILES) throw new Error(`--fixture-files must be at least ${DEFAULT_FIXTURE_FILES}`)
  const here = dirname(fileURLToPath(import.meta.url))
  return {
    mode,
    warmups,
    trials,
    fixtureFiles,
    output: resolve(option(argv, '--output') ?? join(here, `${mode}-performance-receipt.json`)),
    distRoot: resolve(option(argv, '--dist-root') ?? join(here, '../../../dist/src')),
    subjectWorktree: resolve(option(argv, '--subject-worktree') ?? process.cwd()),
    baselineReceipt: option(argv, '--baseline-receipt'),
    repository: option(argv, '--repository'),
    repositoryCommit: option(argv, '--repository-commit'),
    graphRoot: option(argv, '--graph-root') ?? '.',
    mutationFile: option(argv, '--mutation-file'),
    command: normalizedCommand(argv),
  }
}

function normalizedCommand(argv) {
  const pathFlags = new Map([
    ['--dist-root', '<dist-root>'],
    ['--subject-worktree', '<subject-worktree>'],
    ['--baseline-receipt', '<baseline-receipt>'],
    ['--repository', '<repository>'],
    ['--output', '<output>'],
  ])
  const normalized = ['node', 'tools/eval/core-reset/incremental-performance.mjs']
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    normalized.push(flag)
    const replacement = pathFlags.get(flag)
    if (replacement && argv[index + 1]) {
      normalized.push(replacement)
      index += 1
    }
  }
  return normalized
}

function git(cwd, args, extraEnv = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extraEnv },
  }).trim()
}

function directoryFingerprint(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return sha256(files.sort().map((path) => (
    `${relative(root, path).replaceAll('\\', '/')}\0${sha256(readFileSync(path))}`
  )).join('\0'))
}

export function subjectIdentity(worktree, distRoot) {
  const headCommit = git(worktree, ['rev-parse', 'HEAD'])
  const headTreeOid = git(worktree, ['rev-parse', 'HEAD^{tree}'])
  const temporary = mkdtempSync(join(tmpdir(), 'madar-performance-index-'))
  const indexPath = join(temporary, 'index')
  let worktreeTreeOid
  try {
    const env = { GIT_INDEX_FILE: indexPath }
    git(worktree, ['read-tree', 'HEAD'], env)
    git(worktree, ['add', '-A', '--', '.'], env)
    worktreeTreeOid = git(worktree, ['write-tree'], env)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: worktree,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
  return {
    head_commit: headCommit,
    head_tree_oid: headTreeOid,
    worktree_tree_oid: worktreeTreeOid,
    dirty: worktreeTreeOid !== headTreeOid,
    status_sha256: sha256(status),
    dist_fingerprint: directoryFingerprint(distRoot),
  }
}

function writeSyntheticFixture(root, fileCount) {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'file-0000.ts'), [
    'export function value0000(): number {',
    '  const privateValue = 0',
    '  return privateValue',
    '}',
    '',
  ].join('\n'))
  for (let index = 1; index < fileCount; index += 1) {
    const id = String(index).padStart(4, '0')
    writeFileSync(join(root, 'src', `file-${id}.ts`), [
      "import { value0000 } from './file-0000.js'",
      `export function value${id}(): number { return value0000() + ${index} }`,
      '',
    ].join('\n'))
  }
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"module":"NodeNext"}}\n')
  return join(root, 'src', 'file-0000.ts')
}

function clonePinnedRepository(source, target, commit) {
  if (!commit) throw new Error('--repository-commit is required with --repository')
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', source, target], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  git(target, ['checkout', '--detach', commit])
  const actual = git(target, ['rev-parse', 'HEAD'])
  if (actual !== commit) throw new Error(`repository checkout mismatch: expected ${commit}, got ${actual}`)
  if (git(target, ['status', '--porcelain']) !== '') throw new Error('held-out repository checkout is not clean')
}

function supportedFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'out') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path)
    }
  }
  return files.sort()
}

function corpusRecord(root, kind, id, commit, graphRoot) {
  const files = supportedFiles(root)
  const frame = files.map((path) => `${relative(root, path).replaceAll('\\', '/')}\0${sha256(readFileSync(path))}`).join('\0')
  return {
    kind,
    id,
    commit,
    graph_root: graphRoot,
    supported_files: files.length,
    fingerprint: sha256(frame),
  }
}

function environmentRecord() {
  const processors = cpus()
  const record = {
    platform: platform(),
    release: release(),
    architecture: process.arch,
    node: process.version,
    cpu_model: processors[0]?.model ?? 'unknown',
    cpu_count: processors.length,
    total_memory_bytes: totalmem(),
  }
  const fingerprint = sha256(canonicalJson({
    platform: record.platform,
    release: record.release,
    architecture: record.architecture,
    node: record.node,
    cpu_model: record.cpu_model,
    cpu_count: record.cpu_count,
    total_memory_bytes: record.total_memory_bytes,
  }))
  return { ...record, fingerprint }
}

async function importIfPresent(path) {
  return existsSync(path) ? import(pathToFileURL(path).href) : null
}

async function loadSubject(distRoot, requireIncremental) {
  const currentGenerate = await importIfPresent(join(distRoot, 'application', 'generate-index.js'))
  if (currentGenerate?.generateIndex) {
    if (!requireIncremental) return { generate: currentGenerate.generateIndex }
    const update = await import(pathToFileURL(join(distRoot, 'application', 'update-index.js')).href)
    const adapter = await import(pathToFileURL(join(distRoot, 'adapters', 'typescript', 'index.js')).href)
    const catalog = await import(pathToFileURL(join(distRoot, 'adapters', 'filesystem', 'source-catalog.js')).href)
    return {
      generate: currentGenerate.generateIndex,
      update: update.updateIndex,
      createUpdateSession: update.createUpdateIndexSession,
      createIndexSession: adapter.createCanonicalTypeScriptIndexSession,
      buildSourceCatalog: catalog.buildSourceCatalog,
    }
  }
  const legacy = await importIfPresent(join(distRoot, 'infrastructure', 'generate.js'))
  if (legacy?.generateGraph && !requireIncremental) return { generate: legacy.generateGraph }
  throw new Error(`compatible ${requireIncremental ? 'incremental ' : ''}Madar build not found under ${distRoot}`)
}

async function loadShippingSubject(distRoot) {
  const currentGenerate = await importIfPresent(join(distRoot, 'application', 'generate-index.js'))
  const currentUpdate = await importIfPresent(join(distRoot, 'application', 'update-index.js'))
  if (currentGenerate?.generateIndex && currentUpdate?.updateIndex) {
    return { generate: currentGenerate.generateIndex, update: currentUpdate.updateIndex }
  }
  throw new Error(`compatible full-reconcile Madar build not found under ${distRoot}`)
}

function timed(run) {
  const started = performance.now()
  const value = run()
  return { value, elapsed_ms: rounded(performance.now() - started) }
}

function measuredIterations(protocol, run) {
  const samples = []
  for (let ordinal = 0; ordinal < protocol.warmups + protocol.trials; ordinal += 1) {
    const sample = run(ordinal)
    if (ordinal >= protocol.warmups) samples.push({ ordinal: ordinal - protocol.warmups + 1, ...sample })
  }
  return samples
}

function removeOutput(root) {
  rmSync(join(root, 'out'), { recursive: true, force: true })
}

function receiptMetrics(result, elapsedMs) {
  const receipt = result.updateReceipt
  if (!receipt) throw new Error('incremental measurement did not return an update receipt')
  return {
    elapsed_ms: elapsedMs,
    mode: receipt.mode,
    parsed_files: receipt.parsed_files,
    reused_files: receipt.reused_files,
    invalidated_files: receipt.invalidated_files,
    dependency_closure_size: receipt.dependency_closure_size,
    publication_advanced: receipt.publication_advanced,
  }
}

function privateLeaf(original, marker) {
  return `${original.replace(/\s*$/, '')}\n\nvoid ${JSON.stringify(`madar-performance-${marker}`)}\n`
}

function measureClean(subject, root, protocol) {
  return measuredIterations(protocol, () => {
    removeOutput(root)
    const measurement = timed(() => subject.generate(root, {}))
    return { elapsed_ms: measurement.elapsed_ms }
  })
}

function measureColdNoop(subject, root, protocol) {
  return measuredIterations(protocol, () => {
    const measurement = timed(() => subject.update(root, {}))
    return receiptMetrics(measurement.value, measurement.elapsed_ms)
  })
}

function measureCandidate(subject, root, mutationPath, protocol) {
  const original = readFileSync(mutationPath, 'utf8')
  const catalog = subject.buildSourceCatalog(root, {})
  const cleanIndex = measuredIterations(protocol, () => {
    const measurement = timed(() => {
      const session = subject.createIndexSession({ root, files: catalog.supportedFiles })
      session.result()
      return session
    })
    return { elapsed_ms: measurement.elapsed_ms }
  })

  writeFileSync(mutationPath, original)
  removeOutput(root)
  subject.generate(root, {})
  const coldNoop = measuredIterations(protocol, () => {
    const measurement = timed(() => subject.update(root, {}))
    return receiptMetrics(measurement.value, measurement.elapsed_ms)
  })

  writeFileSync(mutationPath, original)
  removeOutput(root)
  const warmSeed = subject.generate(root, {})
  const updateSession = subject.createUpdateSession(root, warmSeed)
  const warmNoop = measuredIterations(protocol, () => {
    const measurement = timed(() => updateSession.update({}))
    return receiptMetrics(measurement.value, measurement.elapsed_ms)
  })
  let mutationOrdinal = 0
  const warmLeafRefresh = measuredIterations(protocol, () => {
    mutationOrdinal += 1
    writeFileSync(mutationPath, privateLeaf(original, mutationOrdinal % 2 === 0 ? 'even' : 'odd'))
    const measurement = timed(() => updateSession.update({}))
    return receiptMetrics(measurement.value, measurement.elapsed_ms)
  })

  const finalCatalog = subject.buildSourceCatalog(root, {})
  const indexSession = subject.createIndexSession({ root, files: finalCatalog.supportedFiles })
  let indexOrdinal = mutationOrdinal
  const warmLeafIndex = measuredIterations(protocol, () => {
    indexOrdinal += 1
    writeFileSync(mutationPath, privateLeaf(original, indexOrdinal % 2 === 0 ? 'even' : 'odd'))
    const measurement = timed(() => indexSession.stageUpdate({
      files: finalCatalog.supportedFiles,
      changedFiles: [mutationPath],
      forceFull: false,
    }))
    measurement.value.commit()
    return {
      elapsed_ms: measurement.elapsed_ms,
      parsed_files: measurement.value.metrics.parsedFiles,
      reused_files: measurement.value.metrics.reusedFiles,
      invalidated_files: measurement.value.metrics.invalidatedFiles,
      dependency_closure_size: measurement.value.metrics.dependencyClosureSize,
      publication_advanced: false,
    }
  })
  writeFileSync(mutationPath, original)
  return {
    clean_index_stage: cleanIndex,
    cold_noop: coldNoop,
    warm_noop: warmNoop,
    warm_leaf_index_stage: warmLeafIndex,
    warm_leaf_refresh: warmLeafRefresh,
  }
}

function prepareCorpus(config, tempRoot) {
  if (config.repository) {
    const checkout = join(tempRoot, 'repository')
    clonePinnedRepository(resolve(config.repository), checkout, config.repositoryCommit)
    const root = resolve(checkout, config.graphRoot)
    if (!existsSync(root)) throw new Error(`graph root does not exist: ${config.graphRoot}`)
    if (!config.mutationFile) throw new Error('--mutation-file is required with --repository')
    const mutationPath = resolve(root, config.mutationFile)
    if (!existsSync(mutationPath) || !SUPPORTED_EXTENSIONS.has(extname(mutationPath).toLowerCase())) {
      throw new Error('--mutation-file must name a supported file beneath --graph-root')
    }
    const localMutation = relative(root, mutationPath)
    if (!localMutation || localMutation === '..' || localMutation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(localMutation)) throw new Error('--mutation-file escapes --graph-root')
    return {
      root,
      mutationPath,
      corpus: corpusRecord(
        root,
        'held_out_repository',
        `held-out:${config.repositoryCommit}:${config.graphRoot}`,
        config.repositoryCommit,
        config.graphRoot,
      ),
    }
  }
  const root = join(tempRoot, 'synthetic')
  const mutationPath = writeSyntheticFixture(root, config.fixtureFiles)
  return {
    root,
    mutationPath,
    corpus: corpusRecord(
      root,
      'synthetic_fixture',
      `synthetic-${config.fixtureFiles}-v1`,
      `synthetic-${config.fixtureFiles}-v1`,
      '.',
    ),
  }
}

function readReceipt(path) {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'))
  const { receipt_sha256: actual, ...body } = value
  if (actual !== sha256(canonicalJson(body))) throw new Error(`receipt checksum mismatch: ${path}`)
  return value
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(canonicalValue(receipt), null, 2)}\n`, 'utf8')
}

async function main() {
  const config = parseArgs(process.argv.slice(2))
  const distRelative = relative(config.subjectWorktree, config.distRoot).replaceAll('\\', '/')
  if (config.mode === 'shipping' && (distRelative === '..' || distRelative.startsWith('../') || isAbsolute(distRelative))) {
    throw new Error('--mode shipping requires --dist-root to belong to --subject-worktree')
  }
  const tempRoot = mkdtempSync(join(tmpdir(), 'madar-incremental-performance-'))
  try {
    const subject = subjectIdentity(config.subjectWorktree, config.distRoot)
    const prepared = prepareCorpus(config, tempRoot)
    const environment = environmentRecord()
    const protocol = {
      warmups: config.warmups,
      trials: config.trials,
      clock: 'performance.now',
      percentile: 'nearest-rank',
      mutation_application_in_timed_window: false,
      persistent_warm_session: config.mode !== 'shipping',
      command: config.command,
      configuration: {
        fixture_files: config.fixtureFiles,
        repository_commit: config.repositoryCommit,
        graph_root: config.graphRoot,
        mutation_file: config.mutationFile,
      },
    }
    const subjectModules = config.mode === 'shipping'
      ? await loadShippingSubject(config.distRoot)
      : await loadSubject(config.distRoot, config.mode === 'candidate')
    const clean = measureClean(subjectModules, prepared.root, protocol)
    if (config.mode === 'baseline') {
      const completedSubject = subjectIdentity(config.subjectWorktree, config.distRoot)
      if (canonicalJson(completedSubject) !== canonicalJson(subject)) {
        throw new Error('subject source tree or compiled distribution changed during baseline measurement')
      }
      const receipt = buildBaselineReceipt({
        subject,
        corpus: prepared.corpus,
        environment,
        protocol,
        samples: clean,
      })
      writeReceipt(config.output, receipt)
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
      return
    }
    if (config.mode === 'shipping') {
      const coldNoop = measureColdNoop(subjectModules, prepared.root, protocol)
      const completedSubject = subjectIdentity(config.subjectWorktree, config.distRoot)
      if (canonicalJson(completedSubject) !== canonicalJson(subject)) {
        throw new Error('subject source tree or compiled distribution changed during shipping measurement')
      }
      const baseline = config.baselineReceipt ? readReceipt(config.baselineReceipt) : null
      const receipt = buildShippingReceipt({
        subject,
        baseline,
        corpus: prepared.corpus,
        environment,
        protocol,
        samples: { clean_generation: clean, cold_noop: coldNoop },
      })
      writeReceipt(config.output, receipt)
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
      if (!Object.values(receipt.gates).every((entry) => entry.pass)) process.exitCode = 2
      return
    }
    const incremental = measureCandidate(subjectModules, prepared.root, prepared.mutationPath, protocol)
    const completedSubject = subjectIdentity(config.subjectWorktree, config.distRoot)
    if (canonicalJson(completedSubject) !== canonicalJson(subject)) {
      throw new Error('subject source tree or compiled distribution changed during candidate measurement')
    }
    const baseline = config.baselineReceipt ? readReceipt(config.baselineReceipt) : null
    const receipt = buildCandidateReceipt({
      subject,
      baseline,
      corpus: prepared.corpus,
      environment,
      protocol,
      samples: { clean_generation: clean, ...incremental },
    })
    writeReceipt(config.output, receipt)
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    if (!receipt.eligible_for_acceptance) process.exitCode = 2
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
