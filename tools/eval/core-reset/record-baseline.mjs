import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import ts from 'typescript'

import { validateContractSemantics, validateReceiptSemantics } from './contract-validation.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptRoot, '..', '..', '..')
const contractPath = join(scriptRoot, 'contracts', 'evaluation-contract.json')
const contractSchemaPath = join(scriptRoot, 'schemas', 'evaluation-contract.schema.json')
const receiptSchemaPath = join(scriptRoot, 'schemas', 'baseline-receipt.schema.json')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const gitCommand = process.platform === 'win32' ? 'git.exe' : 'git'
const mcpProtocolVersion = '2025-11-25'
const forbiddenPackagePrefixes = ['tools/', 'docs/core-reset/', 'dist/tools/', 'dist/docs/']
const forbiddenPackageMetadataMarkers = ['tools/eval', 'docs/core-reset', 'core-reset:']
const canonicalGraphExcludedFields = ['generated_at', 'graph_build_freshness', 'root_path']
const defaultExtractionFixtureSymbols = {
  '.js': { source_file: 'src/route.js', expected_symbol: 'postOrder' },
  '.jsx': { source_file: 'src/badge.jsx', expected_symbol: 'OrderBadge' },
  '.ts': { source_file: 'src/repository.ts', expected_symbol: 'saveOrder' },
  '.tsx': { source_file: 'src/view.tsx', expected_symbol: 'OrderView' },
}

export function controlledEnvironment(overrides = {}) {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    const upperName = name.toUpperCase()
    if (
      upperName === 'NODE_OPTIONS'
      || upperName === 'NODE_PATH'
      || upperName.startsWith('GIT_')
      || upperName.startsWith('MADAR_')
      || upperName.startsWith('NPM_CONFIG_')
    ) {
      delete environment[name]
    }
  }
  Object.assign(environment, {
    CI: '1',
    LANG: 'C',
    LANGUAGE: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: process.platform === 'win32' ? 'NUL' : '/dev/null',
    ...overrides,
  })
  for (const name of Object.keys(overrides)) {
    if (name.toUpperCase().startsWith('GIT_')) {
      throw new Error(`controlledEnvironment does not accept Git override ${name}`)
    }
  }
  return environment
}

function parseArguments(argv) {
  const options = { output: null, retrievalRepository: null, allowDirty: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--output') {
      if (argv[index + 1] === undefined || argv[index + 1]?.startsWith('--')) {
        throw new Error('--output requires a path')
      }
      options.output = argv[index + 1]
      index += 1
      continue
    }
    if (argument?.startsWith('--output=')) {
      options.output = argument.slice('--output='.length)
      continue
    }
    if (argument === '--retrieval-repository') {
      if (argv[index + 1] === undefined || argv[index + 1]?.startsWith('--')) {
        throw new Error('--retrieval-repository requires a path')
      }
      options.retrievalRepository = argv[index + 1]
      index += 1
      continue
    }
    if (argument?.startsWith('--retrieval-repository=')) {
      options.retrievalRepository = argument.slice('--retrieval-repository='.length)
      continue
    }
    if (argument === '--allow-dirty') {
      options.allowDirty = true
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  if (options.output === '') throw new Error('--output requires a path')
  if (options.retrievalRepository === '') throw new Error('--retrieval-repository requires a path')
  return options
}

function command(...parts) {
  return parts
}

function run(commandName, args, options = {}) {
  const started = performance.now()
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? controlledEnvironment(),
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const elapsedMs = performance.now() - started
  if (result.error) throw result.error
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error([
      `Command failed (${result.status}): ${commandName} ${args.join(' ')}`,
      result.stdout?.trim(),
      result.stderr?.trim(),
    ].filter(Boolean).join('\n'))
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    elapsedMs,
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function validateJson(schemaPath, value, label) {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const validate = ajv.compile(readJson(schemaPath))
  if (!validate(value)) {
    throw new Error(`${label} schema validation failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`)
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

function roundMilliseconds(value) {
  return Number(value.toFixed(3))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    )
  }
  return value
}

function canonicalValueSha256(value) {
  return sha256(JSON.stringify(canonicalJson(value)))
}

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function regularFileInside(path, root, label) {
  const lexicalRoot = resolve(root)
  const resolvedRoot = realpathSync(lexicalRoot)
  const lexicalPath = resolve(path)
  const traversalRoot = lexicalPath.startsWith(`${lexicalRoot}${sep}`)
    ? lexicalRoot
    : lexicalPath.startsWith(`${resolvedRoot}${sep}`)
      ? resolvedRoot
      : null
  if (!traversalRoot) {
    throw new Error(`${label} escaped its allowed root: ${lexicalPath}`)
  }
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`${label} does not exist: ${path}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symbolic-link file: ${path}`)
  }
  let traversed = traversalRoot
  for (const segment of relative(traversalRoot, lexicalPath).split(sep).filter(Boolean)) {
    traversed = join(traversed, segment)
    if (lstatSync(traversed).isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link: ${path}`)
    }
  }
  const resolvedPath = realpathSync(path)
  if (!resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${label} escaped its allowed root: ${resolvedPath}`)
  }
  return resolvedPath
}

export function sourceInventory() {
  const paths = []
  const filesystemViolations = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = normalizePath(relative(repositoryRoot, absolute))
      if (entry.isSymbolicLink()) {
        filesystemViolations.push(`${path}: symbolic link under src`)
      } else if (entry.isDirectory()) {
        visit(absolute)
      } else if (entry.isFile() && path.endsWith('.ts')) {
        paths.push(path)
      }
    }
  }
  visit(join(repositoryRoot, 'src'))
  paths.sort()
  const loc = paths.reduce((total, path) => {
    const source = readFileSync(join(repositoryRoot, path), 'utf8')
    const lineFeeds = source.match(/\n/g)?.length ?? 0
    return total + lineFeeds + (source.length > 0 && !source.endsWith('\n') ? 1 : 0)
  }, 0)
  return { files: paths.length, loc, paths, filesystemViolations }
}

export function commandOutputLines(output) {
  return output.split(/\r\n|\n|\r/).filter(Boolean)
}

export function productionSourceDelta(baselineCommit) {
  const lines = commandOutputLines(
    run(gitCommand, ['diff', '--no-ext-diff', '--no-renames', '--numstat', baselineCommit, '--', 'src']).stdout,
  )
  let added = 0
  let removed = 0
  for (const line of lines) {
    const [rawAdded = '0', rawRemoved = '0'] = line.split('\t')
    added += rawAdded === '-' ? 0 : Number(rawAdded)
    removed += rawRemoved === '-' ? 0 : Number(rawRemoved)
  }
  const baselinePaths = new Set(commandOutputLines(run(gitCommand, [
    'ls-tree', '-r', '--full-tree', '--name-only', baselineCommit, '--', 'src',
  ]).stdout).filter((path) => path.endsWith('.ts')))
  const pathsVisibleToGitDiff = new Set(commandOutputLines(run(gitCommand, [
    'diff', '--no-ext-diff', '--no-renames', '--name-only', baselineCommit, '--', 'src',
  ]).stdout))
  const actualPaths = sourceInventory().paths
  for (const path of actualPaths.filter((candidate) =>
    !baselinePaths.has(candidate) && !pathsVisibleToGitDiff.has(candidate))) {
    const source = readFileSync(join(repositoryRoot, path), 'utf8')
    const lineFeeds = source.match(/\n/g)?.length ?? 0
    added += lineFeeds + (source.length > 0 && !source.endsWith('\n') ? 1 : 0)
  }
  return { added, removed, net: added - removed }
}

export function productionImportViolations(paths) {
  const violations = []
  for (const path of paths) {
    const source = readFileSync(join(repositoryRoot, path), 'utf8')
    for (const specifier of importedSpecifiers(source)) {
      if (specifier.includes('tools/eval') || specifier.includes('docs/core-reset/evidence')) {
        violations.push(`${path}: ${specifier}`)
      }
    }
  }
  return violations
}

export function importedSpecifiers(source) {
  const sourceFile = ts.createSourceFile(
    'production-source.ts',
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
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = staticText(node.moduleSpecifier)
      if (specifier !== null) specifiers.push(specifier)
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
    ) {
      const specifier = staticText(node.moduleReference.expression)
      if (specifier !== null) specifiers.push(specifier)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isRequireResolve =
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'require'
        && node.expression.name.text === 'resolve'
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

export function productionEvaluationLeaks(paths, contract) {
  const forbidden = new Set([
    ...forbiddenPackageMetadataMarkers,
    contract.contract_id,
    ...contract.repositories.flatMap((repository) => [repository.id, repository.url]),
    ...contract.questions.flatMap((question) => [
      question.id,
      question.prompt,
      ...question.required_phases.flatMap((phase) => [
        phase.id,
        phase.label,
        ...phase.expected_evidence_paths,
      ]),
    ]),
    ...contract.human_rubric.dimensions,
  ])
  const violations = []
  for (const path of paths) {
    const source = readFileSync(join(repositoryRoot, path), 'utf8')
    for (const marker of forbidden) {
      if (source.includes(marker)) violations.push(`${path}: ${marker}`)
    }
  }
  return violations
}

export function parseNpmPackJson(output) {
  const trimmed = output.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed[0]
    if (parsed && typeof parsed === 'object') {
      if ('files' in parsed) return parsed
      return Object.values(parsed)[0]
    }
  } catch {
    const start = trimmed.indexOf('[')
    const end = trimmed.lastIndexOf(']')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))[0]
  }
  throw new Error('npm pack did not return a recognized JSON record')
}

function createPackedArtifact(packageTargets) {
  const root = mkdtempSync(join(tmpdir(), 'madar-core-reset-pack-'))
  try {
    const result = run(npmCommand, [
      'pack',
      '--json',
      '--silent',
      '--pack-destination',
      root,
    ])
    const record = parseNpmPackJson(result.stdout)
    if (!record || !Array.isArray(record.files)) throw new Error('npm pack record is missing files')
    const paths = record.files.map((entry) => normalizePath(String(entry.path ?? '')))
    const forbiddenPaths = paths.filter((path) => forbiddenPackagePrefixes.some((prefix) => path.startsWith(prefix)))
    const fileCount = Number(record.entryCount ?? paths.length)
    const packedBytes = Number(record.size)
    const unpackedBytes = Number(record.unpackedSize)
    if (![fileCount, packedBytes, unpackedBytes].every(Number.isFinite)) {
      throw new Error('npm pack returned non-numeric package measurements')
    }
    const filename = String(record.filename ?? '')
    const tarballPath = join(root, filename)
    if (!filename || !existsSync(tarballPath)) throw new Error('npm pack did not produce its reported tarball')
    const installRoot = join(root, 'install')
    mkdirSync(installRoot, { recursive: true })
    writeJson(join(installRoot, 'package.json'), { private: true })
    const installCommand = [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join('..', filename),
    ]
    const install = run(npmCommand, installCommand, { cwd: installRoot, maxBuffer: 64 * 1024 * 1024 })
    const dependencyLock = readJson(join(installRoot, 'package-lock.json'))
    const resolvedDependencyCount = Object.keys(dependencyLock.packages ?? {})
      .filter((path) => path.startsWith('node_modules/'))
      .length
    const packageRoot = join(installRoot, 'node_modules', '@lubab', 'madar')
    const packedCliPath = join(packageRoot, 'dist', 'src', 'cli', 'bin.js')
    if (!existsSync(packedCliPath)) throw new Error('Packed artifact is missing dist/src/cli/bin.js')
    const packedPackageMetadata = readFileSync(join(packageRoot, 'package.json'), 'utf8')
    const measurement = {
      status: 'measured',
      artifact_filename: filename,
      artifact_sha256: sha256(readFileSync(tarballPath)),
      install_command: command('npm', ...installCommand.map(normalizePath)),
      install_elapsed_ms: roundMilliseconds(install.elapsedMs),
      resolved_dependency_count: resolvedDependencyCount,
      resolved_dependency_lock_sha256: sha256(JSON.stringify(dependencyLock)),
      resolved_dependency_lock: dependencyLock,
      file_count: fileCount,
      packed_bytes: packedBytes,
      unpacked_bytes: unpackedBytes,
      targets: {
        file_count_max: packageTargets.file_count_max,
        unpacked_bytes_max: packageTargets.unpacked_bytes_max,
      },
      target_passed:
        fileCount < packageTargets.file_count_max
        && unpackedBytes < packageTargets.unpacked_bytes_max,
      forbidden_paths: forbiddenPaths,
      forbidden_metadata: forbiddenPackageMetadataMarkers.filter((marker) => packedPackageMetadata.includes(marker)),
    }
    return {
      measurement,
      cliPath: packedCliPath,
      packageRoot,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

export function inspectPackageContents() {
  const contract = readJson(contractPath)
  const targets = contract.measurements.baseline_targets.package
  const result = run(npmCommand, ['pack', '--json', '--dry-run', '--ignore-scripts', '--silent'])
  const record = parseNpmPackJson(result.stdout)
  if (!record || !Array.isArray(record.files)) throw new Error('npm pack dry-run record is missing files')
  const paths = record.files.map((entry) => normalizePath(String(entry.path ?? '')))
  const fileCount = Number(record.entryCount ?? paths.length)
  const unpackedBytes = Number(record.unpackedSize)
  if (![fileCount, unpackedBytes].every(Number.isFinite)) {
    throw new Error('npm pack dry-run returned non-numeric package measurements')
  }
  const packageMetadata = readFileSync(join(repositoryRoot, 'package.json'), 'utf8')
  return {
    file_count: fileCount,
    unpacked_bytes: unpackedBytes,
    target_passed: fileCount < targets.file_count_max && unpackedBytes < targets.unpacked_bytes_max,
    forbidden_paths: paths.filter((path) => forbiddenPackagePrefixes.some((prefix) => path.startsWith(prefix))),
    forbidden_metadata: forbiddenPackageMetadataMarkers.filter((marker) => packageMetadata.includes(marker)),
  }
}

function measureCliStartup(cliPath, cliTargets) {
  if (!existsSync(cliPath)) throw new Error('Build output is missing; run npm run build first')
  const root = mkdtempSync(join(tmpdir(), 'madar-core-reset-rss-'))
  const preloadPath = join(root, 'rss-probe.cjs')
  writeFileSync(preloadPath, [
    "'use strict'",
    "const fs = require('node:fs')",
    "process.once('exit', () => {",
    "  const output = process.env.MADAR_RSS_OUTPUT",
    "  if (output) fs.writeFileSync(output, JSON.stringify({ peak_rss_bytes: Math.round(process.resourceUsage().maxRSS * 1024) }))",
    "})",
    '',
  ].join('\n'), 'utf8')

  try {
    const samples = []
    for (let index = 0; index < cliTargets.sample_count; index += 1) {
      const outputPath = join(root, `rss-${index}.json`)
      const result = run(process.execPath, ['--require', preloadPath, cliPath, '--version'], {
        env: controlledEnvironment({
          MADAR_RSS_OUTPUT: outputPath,
          MADAR_TELEMETRY: 'off',
          NO_UPDATE_NOTIFIER: '1',
        }),
      })
      if (!/^0\.32\.0\s*$/.test(result.stdout)) {
        throw new Error(`Unexpected madar --version output: ${result.stdout.trim()}`)
      }
      const peakRssBytes = Number(readJson(outputPath).peak_rss_bytes)
      samples.push({
        elapsed_ms: roundMilliseconds(result.elapsedMs),
        peak_rss_bytes: peakRssBytes,
      })
    }
    const medianElapsedMs = roundMilliseconds(median(samples.map((sample) => sample.elapsed_ms)))
    const maxPeakRssBytes = Math.max(...samples.map((sample) => sample.peak_rss_bytes))
    return {
      status: 'measured',
      subject_command: cliTargets.subject_command,
      measurement_command: cliTargets.measurement_command,
      instrumentation_caveat: cliTargets.instrumentation_caveat,
      cold_process_samples: samples,
      median_elapsed_ms: medianElapsedMs,
      max_peak_rss_bytes: maxPeakRssBytes,
      targets: {
        elapsed_ms_max: cliTargets.elapsed_ms_max,
        peak_rss_bytes_max: cliTargets.peak_rss_bytes_max,
      },
      target_passed:
        medianElapsedMs < cliTargets.elapsed_ms_max
        && maxPeakRssBytes < cliTargets.peak_rss_bytes_max,
      cache_caveat: 'Every sample is a fresh process; filesystem and operating-system page caches are not flushed.',
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function minimalGraph(root) {
  const sourceFile = normalizePath(join(root, 'fixture.ts'))
  return {
    directed: true,
    root_path: normalizePath(root),
    nodes: [
      {
        id: 'fixture_entry',
        label: 'fixtureEntry()',
        source_file: sourceFile,
        source_location: 'L1',
        file_type: 'code',
        node_kind: 'function',
        community: 0,
      },
      {
        id: 'fixture_target',
        label: 'fixtureTarget()',
        source_file: sourceFile,
        source_location: 'L2',
        file_type: 'code',
        node_kind: 'function',
        community: 0,
      },
    ],
    edges: [
      {
        source: 'fixture_entry',
        target: 'fixture_target',
        relation: 'calls',
        confidence: 'EXTRACTED',
        source_file: sourceFile,
      },
    ],
    hyperedges: [],
  }
}

async function runMcpSession(cliPath, graphPath, action, options = {}) {
  const child = spawn(process.execPath, [cliPath, 'serve', graphPath, '--stdio'], {
    cwd: repositoryRoot,
    env: controlledEnvironment({
      MADAR_TOOL_PROFILE: 'core',
      MADAR_TELEMETRY: 'off',
      NO_UPDATE_NOTIFIER: '1',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const started = performance.now()
  let nextId = 1
  let stdoutBuffer = ''
  let stderr = ''
  const pending = new Map()
  const maximumStdoutBufferBytes = 32 * 1024 * 1024

  const failPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_000)
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    if (Buffer.byteLength(stdoutBuffer) > maximumStdoutBufferBytes) {
      const error = new Error(`MCP stdout exceeded ${maximumStdoutBufferBytes} bytes without a complete message`)
      failPending(error)
      child.kill()
      return
    }
    while (stdoutBuffer.includes('\n')) {
      const newline = stdoutBuffer.indexOf('\n')
      const line = stdoutBuffer.slice(0, newline).trim()
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`))
      else waiter.resolve(message)
    }
  })
  child.once('error', failPending)
  child.once('exit', (code, signal) => {
    if (pending.size > 0) {
      failPending(new Error(`MCP server exited before replying (code=${code}, signal=${signal}): ${stderr.trim()}`))
    }
  })

  const request = (method, params, timeoutMs = 30_000) => new Promise((resolveRequest, rejectRequest) => {
    const id = nextId
    nextId += 1
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectRequest(new Error(`Timed out waiting for MCP ${method}: ${stderr.trim()}`))
    }, timeoutMs)
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  try {
    const initialize = await request('initialize', {
      protocolVersion: mcpProtocolVersion,
      capabilities: {},
      clientInfo: { name: 'madar-core-reset-baseline', version: '1.0.0' },
    }, options.initializeTimeoutMs ?? 30_000)
    const initializeMs = performance.now() - started
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return await action({ child, request, initialize, initializeMs, started })
  } finally {
    child.stdin.end()
    child.kill()
    await new Promise((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit()
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
      }, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
  }
}

async function measureMcpStartup(cliPath, mcpTargets) {
  const root = mkdtempSync(join(tmpdir(), 'madar-core-reset-mcp-'))
  const graphPath = join(root, 'out', 'graph.json')
  writeJson(graphPath, minimalGraph(root))
  try {
    const samples = []
    let publicTools = []
    for (let index = 0; index < mcpTargets.sample_count; index += 1) {
      const sample = await runMcpSession(cliPath, graphPath, async ({ request, initializeMs, started }) => {
        const response = await request('tools/list', {})
        const tools = response.result?.tools
        if (!Array.isArray(tools) || tools.length === 0) throw new Error('MCP tools/list returned no tools')
        const sampleTools = tools.map((tool) => String(tool.name)).sort()
        if (index === 0) publicTools = sampleTools
        return {
          initialize_ms: roundMilliseconds(initializeMs),
          tools_list_ms: roundMilliseconds(performance.now() - started),
          tool_count: sampleTools.length,
          public_tools: sampleTools,
        }
      })
      samples.push(sample)
    }
    const medianInitializeMs = roundMilliseconds(median(samples.map((sample) => sample.initialize_ms)))
    const medianToolsListMs = roundMilliseconds(median(samples.map((sample) => sample.tools_list_ms)))
    return {
      status: 'measured',
      profile: 'core',
      command: command('node', '<packed-install>/dist/src/cli/bin.js', 'serve', '<graph.json>', '--stdio'),
      cold_process_samples: samples,
      median_initialize_ms: medianInitializeMs,
      median_tools_list_ms: medianToolsListMs,
      public_tool_count: publicTools.length,
      public_tools: publicTools,
      target_tools_list_ms: mcpTargets.tools_list_ms_max,
      target_tool_count_max: mcpTargets.tool_count_max,
      latency_target_passed: medianToolsListMs < mcpTargets.tools_list_ms_max,
      tool_count_target_passed: publicTools.length <= mcpTargets.tool_count_max,
      target_passed:
        medianToolsListMs < mcpTargets.tools_list_ms_max
        && publicTools.length <= mcpTargets.tool_count_max,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function characterizeGraphContract(packageRoot) {
  const graphModule = await import(`${pathToFileURL(join(packageRoot, 'dist', 'src', 'contracts', 'graph.js')).href}?baseline=${Date.now()}`)
  const exportModule = await import(`${pathToFileURL(join(packageRoot, 'dist', 'src', 'pipeline', 'export.js')).href}?baseline=${Date.now()}`)
  const serveModule = await import(`${pathToFileURL(join(packageRoot, 'dist', 'src', 'runtime', 'serve.js')).href}?baseline=${Date.now()}`)
  const graph = new graphModule.KnowledgeGraph({ directed: true })
  const provenance = [{ capability_id: 'baseline:fixture', stage: 'extract' }]
  graph.addNode('source', {
    label: 'source()',
    source_file: 'fixture/source.ts',
    source_location: 'L1',
    file_type: 'code',
    node_kind: 'function',
    provenance,
  })
  graph.addNode('target', {
    label: 'target()',
    source_file: 'fixture/target.ts',
    source_location: 'L1',
    file_type: 'code',
    node_kind: 'function',
    provenance,
  })
  graph.addEdge('source', 'target', {
    relation: 'calls',
    confidence: 'EXTRACTED',
    source_file: 'fixture/source.ts',
    provenance,
  })
  graph.addEdge('source', 'target', {
    relation: 'imports_from',
    confidence: 'EXTRACTED',
    source_file: 'fixture/source.ts',
    provenance,
  })
  graph.addEdge('target', 'source', {
    relation: 'returns_to',
    confidence: 'EXTRACTED',
    source_file: 'fixture/target.ts',
    provenance,
  })

  const root = mkdtempSync(join(tmpdir(), 'madar-core-reset-graph-contract-'))
  try {
    graph.graph.schema_version = 2
    graph.graph.root_path = 'fixture'
    const outputPath = join(root, 'out', 'graph.json')
    mkdirSync(dirname(outputPath), { recursive: true })
    exportModule.toJson(graph, { 0: ['source', 'target'] }, outputPath)
    const serialized = readJson(outputPath)
    const loaded = serveModule.loadGraph(outputPath)
    const links = Array.isArray(serialized.links) ? serialized.links : []
    const samePair = links.filter((edge) => edge.source === 'source' && edge.target === 'target')
    const serializedNodeIds = serialized.nodes.map((node) => String(node.id)).sort()
    const serializedNodeIdCount = serialized.nodes
      .filter((node) => typeof node.id === 'string' && node.id.length > 0).length
    const serializedEdgeIdCount = links
      .filter((edge) => typeof edge.id === 'string' && edge.id.length > 0).length
    const loadedNodeIds = loaded.nodeIds().sort()
    const edgeTuple = (source, target, relation) => `${source} -> ${target} [${relation}]`
    const serializedEdgeTuples = links
      .map((edge) => edgeTuple(String(edge.source), String(edge.target), String(edge.relation ?? '')))
      .sort()
    const loadedEdgeTuples = loaded.edgeEntries()
      .map(([source, target, attributes]) => edgeTuple(source, target, String(attributes.relation ?? '')))
      .sort()
    const sortedRecords = (records) => records
      .map(canonicalJson)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    const serializedContractProjection = {
      directed: serialized.directed === true,
      nodes: sortedRecords(serialized.nodes),
      edges: sortedRecords(links),
    }
    const loadedContractProjection = {
      directed: loaded.isDirected(),
      nodes: sortedRecords(loaded.nodeEntries().map(([id, attributes]) => ({ id, ...attributes }))),
      edges: sortedRecords(loaded.edgeEntries().map(([source, target, attributes]) => {
        const {
          _src: _internalSource,
          _tgt: _internalTarget,
          confidence_score: _derivedConfidenceScore,
          ...serializedAttributes
        } = attributes
        return { source, target, ...serializedAttributes }
      })),
    }
    const serializedProvenance = {
      nodes: sortedRecords(serialized.nodes
        .filter((node) => Array.isArray(node.provenance))
        .map((node) => ({ id: node.id, provenance: node.provenance }))),
      edges: sortedRecords(links
        .filter((edge) => Array.isArray(edge.provenance))
        .map((edge) => ({ source: edge.source, target: edge.target, relation: edge.relation, provenance: edge.provenance }))),
    }
    const loadedProvenance = {
      nodes: sortedRecords(loaded.nodeEntries()
        .filter(([, attributes]) => Array.isArray(attributes.provenance))
        .map(([id, attributes]) => ({ id, provenance: attributes.provenance }))),
      edges: sortedRecords(loaded.edgeEntries()
        .filter(([, , attributes]) => Array.isArray(attributes.provenance))
        .map(([source, target, attributes]) => ({
          source,
          target,
          relation: attributes.relation,
          provenance: attributes.provenance,
        }))),
    }
    const serializedContractSha256 = canonicalValueSha256(serializedContractProjection)
    const loadedContractSha256 = canonicalValueSha256(loadedContractProjection)
    const serializedProvenanceSha256 = canonicalValueSha256(serializedProvenance)
    const loadedProvenanceSha256 = canonicalValueSha256(loadedProvenance)
    return {
      status: 'measured',
      command: command('node', 'tools/eval/core-reset/record-baseline.mjs', '<graph-contract-probe>'),
      directed: graph.isDirected(),
      loaded_directed: loaded.isDirected(),
      node_ids_present: serializedNodeIdCount === serialized.nodes.length,
      edge_ids_present: serializedEdgeIdCount === links.length,
      parallel_edge_kinds_input: ['calls', 'imports_from'],
      parallel_edge_kinds_output: samePair.map((edge) => edge.relation).sort(),
      parallel_edges_preserved:
        JSON.stringify(samePair.map((edge) => edge.relation).sort())
        === JSON.stringify(['calls', 'imports_from'].sort()),
      opposite_directions_preserved:
        loaded.hasEdge('source', 'target')
        && loaded.hasEdge('target', 'source'),
      provenance_preserved_after_round_trip: serializedProvenanceSha256 === loadedProvenanceSha256,
      serialization_round_trip_preserved: serializedContractSha256 === loadedContractSha256,
      serialized_node_ids: serializedNodeIds,
      loaded_node_ids: loadedNodeIds,
      serialized_node_count: serialized.nodes.length,
      serialized_node_id_count: serializedNodeIdCount,
      serialized_edge_id_count: serializedEdgeIdCount,
      serialized_edge_tuples: serializedEdgeTuples,
      loaded_edge_tuples: loadedEdgeTuples,
      serialized_contract_sha256: serializedContractSha256,
      loaded_contract_sha256: loadedContractSha256,
      serialized_provenance_sha256: serializedProvenanceSha256,
      loaded_provenance_sha256: loadedProvenanceSha256,
      serialized_provenance_entry_count: serializedProvenance.nodes.length + serializedProvenance.edges.length,
      loaded_provenance_entry_count: loadedProvenance.nodes.length + loadedProvenance.edges.length,
      observed_edge_count: links.length,
      expected_multigraph_edge_count: 3,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeFixtureWorkspace(root) {
  writeJson(join(root, 'package.json'), { name: 'core-reset-fixture', private: true, type: 'module' })
  writeJson(join(root, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      allowJs: true,
      jsx: 'preserve',
    },
    include: ['src/**/*'],
  })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'repository.ts'), [
    'export function saveOrder(id: string) { return { id } }',
    'export function replaceOrder(id: string) { return { id, replaced: true } }',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'service.ts'), [
    "import { saveOrder } from './repository.js'",
    "import { mutableValue } from './mutable.js'",
    "import { obsoleteValue } from './obsolete.js'",
    "import { renamedValue } from './rename-me.js'",
    'export function submitOrder(id: string) {',
    '  return [saveOrder(id), mutableValue(id), obsoleteValue(), renamedValue()]',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'route.js'), 'export function postOrder(request) { return request.id }\n', 'utf8')
  writeFileSync(join(root, 'src', 'badge.jsx'), 'export function OrderBadge() { return <span>Order</span> }\n', 'utf8')
  writeFileSync(join(root, 'src', 'view.tsx'), 'export function OrderView() { return <main>Order</main> }\n', 'utf8')
  writeFileSync(join(root, 'src', 'mutable.ts'), 'export function mutableValue(id: string) { return id }\n', 'utf8')
  writeFileSync(join(root, 'src', 'obsolete.ts'), 'export function obsoleteValue() { return true }\n', 'utf8')
  writeFileSync(join(root, 'src', 'rename-me.ts'), 'export function renamedValue() { return true }\n', 'utf8')
}

function runGenerate(cliPath, workspace, update = false, allowedArtifactRoot = workspace) {
  const args = [cliPath, 'generate', workspace, ...(update ? ['--update'] : []), '--no-html']
  const result = run(process.execPath, args, {
    env: controlledEnvironment({
      MADAR_TELEMETRY: 'off',
      NO_UPDATE_NOTIFIER: '1',
    }),
    maxBuffer: 64 * 1024 * 1024,
  })
  const reportedGraphPath = result.stdout.match(/^- Outputs:\s+([^,\n]+graph\.json)(?:,|$)/m)?.[1]?.trim()
  const graphCandidate = reportedGraphPath ? resolve(reportedGraphPath) : join(workspace, 'out', 'graph.json')
  const graphPath = regularFileInside(graphCandidate, allowedArtifactRoot, 'Generated graph')
  const manifestPath = regularFileInside(
    join(dirname(graphPath), 'indexing-manifest.json'),
    allowedArtifactRoot,
    'Generated indexing manifest',
  )
  return { ...result, graphPath, manifestPath }
}

function normalizedGraphValue(value, workspace) {
  if (Array.isArray(value)) return value.map((entry) => normalizedGraphValue(entry, workspace))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !canonicalGraphExcludedFields.includes(key))
        .sort()
        .map((key) => [key, normalizedGraphValue(value[key], workspace)]),
    )
  }
  if (typeof value === 'string') {
    const normalizedRoot = normalizePath(resolve(workspace))
    return normalizePath(value).replaceAll(normalizedRoot, '<workspace>')
  }
  return value
}

function canonicalGraph(graphPath, workspace) {
  const graph = readJson(graphPath)
  const sortRecords = (records) => records
    .map((entry) => normalizedGraphValue(entry, workspace))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const normalized = normalizedGraphValue(graph, workspace)
  normalized.nodes = sortRecords(Array.isArray(graph.nodes) ? graph.nodes : [])
  if (Array.isArray(graph.edges)) normalized.edges = sortRecords(graph.edges)
  if (Array.isArray(graph.links)) normalized.links = sortRecords(graph.links)
  normalized.hyperedges = sortRecords(Array.isArray(graph.hyperedges) ? graph.hyperedges : [])
  return JSON.stringify(normalized)
}

function generatedEdges(graph) {
  if (Array.isArray(graph.edges)) return graph.edges
  if (Array.isArray(graph.links)) return graph.links
  return []
}

function semanticNodeIdentity(node, workspace) {
  const sourceFile = typeof node?.source_file === 'string'
    ? normalizedGraphValue(node.source_file, workspace)
    : null
  return JSON.stringify({
    source_file: sourceFile,
    label: typeof node?.label === 'string' ? node.label : null,
    kind: typeof node?.node_kind === 'string'
      ? node.node_kind
      : (typeof node?.kind === 'string' ? node.kind : (typeof node?.type === 'string' ? node.type : null)),
    line_number: Number.isInteger(node?.line_number) ? node.line_number : null,
    column_number: Number.isInteger(node?.column_number) ? node.column_number : null,
  })
}

function endpointId(endpoint) {
  if (typeof endpoint === 'string') return endpoint
  if (endpoint && typeof endpoint === 'object' && typeof endpoint.id === 'string') return endpoint.id
  return null
}

function semanticEdgeIdentity(edge, nodeIdentityById, workspace) {
  const sourceId = endpointId(edge?.source)
  const targetId = endpointId(edge?.target)
  const sourceFile = typeof edge?.source_file === 'string'
    ? normalizedGraphValue(edge.source_file, workspace)
    : null
  return JSON.stringify({
    source: (sourceId && nodeIdentityById.get(sourceId)) ?? sourceId,
    target: (targetId && nodeIdentityById.get(targetId)) ?? targetId,
    relation: typeof edge?.relation === 'string'
      ? edge.relation
      : (typeof edge?.kind === 'string' ? edge.kind : (typeof edge?.type === 'string' ? edge.type : null)),
    source_file: sourceFile,
    line_number: Number.isInteger(edge?.line_number) ? edge.line_number : null,
  })
}

export function characterizeGeneratedIds(graph, workspace) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = generatedEdges(graph)
  const nodeIds = nodes
    .map((node) => node?.id)
    .filter((id) => typeof id === 'string' && id.length > 0)
    .sort()
  const edgeIds = edges
    .map((edge) => edge?.id)
    .filter((id) => typeof id === 'string' && id.length > 0)
    .sort()
  const nodeIdentityById = new Map()
  const nodeBindings = nodes.map((node) => {
    const identity = semanticNodeIdentity(node, workspace)
    const id = typeof node?.id === 'string' && node.id.length > 0 ? node.id : null
    if (id) nodeIdentityById.set(id, identity)
    return JSON.stringify({ identity, id })
  }).sort()
  const edgeBindings = edges.map((edge) => JSON.stringify({
    identity: semanticEdgeIdentity(edge, nodeIdentityById, workspace),
    id: typeof edge?.id === 'string' && edge.id.length > 0 ? edge.id : null,
  })).sort()
  return {
    nodeCount: nodes.length,
    validNodeIdCount: nodeIds.length,
    uniqueNodeIdCount: new Set(nodeIds).size,
    nodeIdsSha256: sha256(JSON.stringify(nodeIds)),
    nodeIdentityIdBindingsSha256: sha256(JSON.stringify(nodeBindings)),
    edgeCount: edges.length,
    validEdgeIdCount: edgeIds.length,
    uniqueEdgeIdCount: new Set(edgeIds).size,
    edgeIdsSha256: sha256(JSON.stringify(edgeIds)),
    edgeIdentityIdBindingsSha256: sha256(JSON.stringify(edgeBindings)),
  }
}

async function characterizeDefaultExtraction(cliPath, extractionTargets, packageRoot) {
  const root = mkdtempSync(join(tmpdir(), 'madar-core-reset-extraction-'))
  try {
    writeFixtureWorkspace(root)
    const first = runGenerate(cliPath, root)
    const firstGraph = canonicalGraph(first.graphPath, root)
    const firstGraphJson = readJson(first.graphPath)
    const serveModule = await import(
      `${pathToFileURL(join(packageRoot, 'dist', 'src', 'runtime', 'serve.js')).href}?default-extraction=${Date.now()}`
    )
    const loadedFirstGraph = serveModule.loadGraph(first.graphPath)
    const firstIdStats = characterizeGeneratedIds(firstGraphJson, root)
    const indexing = readJson(first.manifestPath)
    const fixtureSymbolEvidence = extractionTargets.expected_extensions.map((extension) => {
      const fixture = defaultExtractionFixtureSymbols[extension]
      if (!fixture) throw new Error(`Missing frozen default-extraction fixture for ${extension}`)
      const indexed = indexing.outcomes.some((outcome) =>
        normalizePath(outcome.path).endsWith(fixture.source_file)
        && ['indexed', 'indexed_with_warnings'].includes(outcome.status))
      const matchedNodeIds = firstGraphJson.nodes
        .filter((node) =>
          normalizePath(String(node.source_file ?? '')).endsWith(fixture.source_file)
          && String(node.label ?? '').includes(fixture.expected_symbol))
        .map((node) => String(node.id))
        .filter(Boolean)
        .sort()
      return {
        extension,
        source_file: fixture.source_file,
        expected_symbol: fixture.expected_symbol,
        indexed,
        matched_node_ids: matchedNodeIds,
      }
    })
    const supportedFixtureExtensions = fixtureSymbolEvidence
      .filter((evidence) => evidence.indexed && evidence.matched_node_ids.length > 0)
      .map((evidence) => evidence.extension)
    rmSync(dirname(first.graphPath), { recursive: true, force: true })
    const second = runGenerate(cliPath, root)
    const secondGraph = canonicalGraph(second.graphPath, root)
    const secondIdStats = characterizeGeneratedIds(readJson(second.graphPath), root)
    const generatedNodeIdsPresentAndUnique =
      firstIdStats.nodeCount === firstIdStats.validNodeIdCount
      && firstIdStats.validNodeIdCount === firstIdStats.uniqueNodeIdCount
      && secondIdStats.nodeCount === secondIdStats.validNodeIdCount
      && secondIdStats.validNodeIdCount === secondIdStats.uniqueNodeIdCount
    const generatedEdgeIdsPresentAndUnique =
      firstIdStats.edgeCount === firstIdStats.validEdgeIdCount
      && firstIdStats.validEdgeIdCount === firstIdStats.uniqueEdgeIdCount
      && secondIdStats.edgeCount === secondIdStats.validEdgeIdCount
      && secondIdStats.validEdgeIdCount === secondIdStats.uniqueEdgeIdCount
    const autoSummary = first.stdout.match(/Auto extraction: ([^\n]+)/)?.[1] ?? null
    return {
      status: 'measured',
      command: command('node', '<packed-install>/dist/src/cli/bin.js', 'generate', '<fixture>', '--no-html'),
      requested_extraction_mode: indexing.requested_extraction_mode,
      extraction_strategy_buckets: indexing.summary?.extraction_strategy_buckets ?? {},
      capability_buckets: indexing.summary?.capability_buckets ?? {},
      auto_summary: autoSummary,
      supported_fixture_extensions: supportedFixtureExtensions,
      fixture_symbol_evidence: fixtureSymbolEvidence,
      generated_graph_directed: firstGraphJson.directed === true,
      loaded_graph_directed: loadedFirstGraph.isDirected(),
      generated_graph_direction_preserved:
        (firstGraphJson.directed === true) === loadedFirstGraph.isDirected(),
      canonicalization_excluded_fields: canonicalGraphExcludedFields,
      first_node_count: firstIdStats.nodeCount,
      first_valid_node_id_count: firstIdStats.validNodeIdCount,
      first_unique_node_id_count: firstIdStats.uniqueNodeIdCount,
      second_node_count: secondIdStats.nodeCount,
      second_valid_node_id_count: secondIdStats.validNodeIdCount,
      second_unique_node_id_count: secondIdStats.uniqueNodeIdCount,
      generated_node_ids_present_and_unique: generatedNodeIdsPresentAndUnique,
      first_node_ids_sha256: firstIdStats.nodeIdsSha256,
      second_node_ids_sha256: secondIdStats.nodeIdsSha256,
      first_node_identity_id_bindings_sha256: firstIdStats.nodeIdentityIdBindingsSha256,
      second_node_identity_id_bindings_sha256: secondIdStats.nodeIdentityIdBindingsSha256,
      first_edge_count: firstIdStats.edgeCount,
      first_valid_edge_id_count: firstIdStats.validEdgeIdCount,
      first_unique_edge_id_count: firstIdStats.uniqueEdgeIdCount,
      second_edge_count: secondIdStats.edgeCount,
      second_valid_edge_id_count: secondIdStats.validEdgeIdCount,
      second_unique_edge_id_count: secondIdStats.uniqueEdgeIdCount,
      generated_edge_ids_present_and_unique: generatedEdgeIdsPresentAndUnique,
      first_edge_ids_sha256: firstIdStats.edgeIdsSha256,
      second_edge_ids_sha256: secondIdStats.edgeIdsSha256,
      first_edge_identity_id_bindings_sha256: firstIdStats.edgeIdentityIdBindingsSha256,
      second_edge_identity_id_bindings_sha256: secondIdStats.edgeIdentityIdBindingsSha256,
      first_graph_sha256: sha256(firstGraph),
      second_graph_sha256: sha256(secondGraph),
      stable_node_ids_across_clean_rebuilds:
        generatedNodeIdsPresentAndUnique
        && firstIdStats.nodeIdsSha256 === secondIdStats.nodeIdsSha256
        && firstIdStats.nodeIdentityIdBindingsSha256 === secondIdStats.nodeIdentityIdBindingsSha256,
      stable_edge_ids_across_clean_rebuilds:
        generatedEdgeIdsPresentAndUnique
        && firstIdStats.edgeIdsSha256 === secondIdStats.edgeIdsSha256
        && firstIdStats.edgeIdentityIdBindingsSha256 === secondIdStats.edgeIdentityIdBindingsSha256,
      stable_serialized_graph_across_clean_rebuilds: firstGraph === secondGraph,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function copyFixtureSource(source, destination) {
  mkdirSync(destination, { recursive: true })
  cpSync(join(source, 'package.json'), join(destination, 'package.json'))
  cpSync(join(source, 'tsconfig.json'), join(destination, 'tsconfig.json'))
  cpSync(join(source, 'src'), join(destination, 'src'), { recursive: true })
}

function mutationFor(name, workspace) {
  const servicePath = join(workspace, 'src', 'service.ts')
  const service = readFileSync(servicePath, 'utf8')
  switch (name) {
    case 'add':
      writeFileSync(join(workspace, 'src', 'added.ts'), 'export function addedValue() { return true }\n', 'utf8')
      writeFileSync(
        servicePath,
        service
          .replace("import { saveOrder } from './repository.js'", "import { saveOrder } from './repository.js'\nimport { addedValue } from './added.js'")
          .replace('renamedValue()]', 'renamedValue(), addedValue()]'),
        'utf8',
      )
      return
    case 'change':
      writeFileSync(join(workspace, 'src', 'mutable.ts'), 'export function changedMutableValue(id: string) { return `${id}:changed` }\n', 'utf8')
      writeFileSync(
        servicePath,
        service
          .replace('mutableValue', 'changedMutableValue')
          .replace('mutableValue', 'changedMutableValue'),
        'utf8',
      )
      return
    case 'delete':
      unlinkSync(join(workspace, 'src', 'obsolete.ts'))
      writeFileSync(
        servicePath,
        service
          .replace("import { obsoleteValue } from './obsolete.js'\n", '')
          .replace(', obsoleteValue()', ''),
        'utf8',
      )
      return
    case 'rename':
      renameSync(join(workspace, 'src', 'rename-me.ts'), join(workspace, 'src', 'renamed.ts'))
      writeFileSync(servicePath, service.replace("'./rename-me.js'", "'./renamed.js'"), 'utf8')
      return
    default:
      throw new Error(`Unknown mutation: ${name}`)
  }
}

function compareIncrementalScenario(cliPath, name) {
  const parent = mkdtempSync(join(tmpdir(), `madar-core-reset-${name}-`))
  const incremental = join(parent, 'incremental')
  const clean = join(parent, 'clean')
  try {
    writeFixtureWorkspace(incremental)
    runGenerate(cliPath, incremental)
    mutationFor(name, incremental)
    const update = runGenerate(cliPath, incremental, true)
    copyFixtureSource(incremental, clean)
    const cleanBuild = runGenerate(cliPath, clean)
    const incrementalGraph = canonicalGraph(update.graphPath, incremental)
    const cleanGraph = canonicalGraph(cleanBuild.graphPath, clean)
    const incrementalJson = readJson(update.graphPath)
    const cleanJson = readJson(cleanBuild.graphPath)
    return {
      operation: name,
      equal_to_clean_generation: incrementalGraph === cleanGraph,
      incremental_nodes: incrementalJson.nodes?.length ?? 0,
      clean_nodes: cleanJson.nodes?.length ?? 0,
      incremental_edges: incrementalJson.edges?.length ?? incrementalJson.links?.length ?? 0,
      clean_edges: cleanJson.edges?.length ?? cleanJson.links?.length ?? 0,
      incremental_graph_sha256: sha256(incrementalGraph),
      clean_graph_sha256: sha256(cleanGraph),
      update_elapsed_ms: roundMilliseconds(update.elapsedMs),
      clean_elapsed_ms: roundMilliseconds(cleanBuild.elapsedMs),
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

function compareWorktreeScenario(cliPath) {
  const parent = mkdtempSync(join(tmpdir(), 'madar-core-reset-worktree-'))
  const primary = join(parent, 'primary')
  const linked = join(parent, 'linked')
  const clean = join(parent, 'clean')
  try {
    writeFixtureWorkspace(primary)
    run(gitCommand, ['init', '-b', 'main'], { cwd: primary })
    run(gitCommand, ['config', 'user.email', 'madar-core-reset@example.invalid'], { cwd: primary })
    run(gitCommand, ['config', 'user.name', 'Madar Core Reset'], { cwd: primary })
    run(gitCommand, ['add', '.'], { cwd: primary })
    run(gitCommand, ['commit', '-m', 'baseline fixture'], { cwd: primary })
    run(gitCommand, ['worktree', 'add', '-b', 'baseline-worktree', linked], { cwd: primary })
    runGenerate(cliPath, linked, false, parent)
    mutationFor('change', linked)
    const worktreeBuild = runGenerate(cliPath, linked, true, parent)
    copyFixtureSource(linked, clean)
    const cleanBuild = runGenerate(cliPath, clean)
    const worktreeGraph = canonicalGraph(worktreeBuild.graphPath, linked)
    const cleanGraph = canonicalGraph(cleanBuild.graphPath, clean)
    const worktreeJson = readJson(worktreeBuild.graphPath)
    const cleanJson = readJson(cleanBuild.graphPath)
    return {
      operation: 'linked_worktree',
      equal_to_clean_generation: worktreeGraph === cleanGraph,
      artifact_outside_worktree: !resolve(worktreeBuild.graphPath).startsWith(`${resolve(linked)}${sep}`),
      incremental_nodes: worktreeJson.nodes?.length ?? 0,
      clean_nodes: cleanJson.nodes?.length ?? 0,
      incremental_edges: worktreeJson.edges?.length ?? worktreeJson.links?.length ?? 0,
      clean_edges: cleanJson.edges?.length ?? cleanJson.links?.length ?? 0,
      incremental_graph_sha256: sha256(worktreeGraph),
      clean_graph_sha256: sha256(cleanGraph),
      worktree_elapsed_ms: roundMilliseconds(worktreeBuild.elapsedMs),
      clean_elapsed_ms: roundMilliseconds(cleanBuild.elapsedMs),
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

function characterizeIncrementalEquivalence(cliPath) {
  const scenarios = ['add', 'change', 'delete', 'rename'].map((name) => compareIncrementalScenario(cliPath, name))
  scenarios.push(compareWorktreeScenario(cliPath))
  return {
    status: 'measured',
    command: command('node', '<packed-install>/dist/src/cli/bin.js', 'generate', '<fixture>', '--update', '--no-html'),
    canonicalization_excluded_fields: canonicalGraphExcludedFields,
    scenarios,
    all_equal_to_clean_generation: scenarios.every((scenario) => scenario.equal_to_clean_generation),
  }
}

function pathMatches(expected, path) {
  return normalizePath(expected) === normalizePath(path)
}

export function normalizedEvidenceFile(path, graphRoot) {
  const lexicalRoot = resolve(graphRoot)
  const normalizedRoot = realpathSync(lexicalRoot)
  const normalizedInput = normalizePath(path)
  if (!isAbsolute(path) && normalizedInput.split('/').includes('..')) {
    throw new Error(`Retrieved evidence path is not a safe repository-relative file: ${path}`)
  }
  const candidate = isAbsolute(path)
    ? resolve(path)
    : resolve(lexicalRoot, normalizedInput)
  if (candidate === lexicalRoot) {
    throw new Error(`Retrieved evidence path is the graph root, not a file: ${path}`)
  }
  if (!candidate.startsWith(`${lexicalRoot}${sep}`)) {
    throw new Error(`Retrieved evidence path is outside graph_root: ${path}`)
  }
  let stat
  try {
    stat = lstatSync(candidate)
  } catch {
    throw new Error(`Retrieved evidence path does not exist: ${path}`)
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Retrieved evidence path is a symbolic link: ${path}`)
  }
  if (!stat.isFile()) {
    throw new Error(`Retrieved evidence path is not a regular file: ${path}`)
  }
  let traversed = lexicalRoot
  for (const segment of relative(lexicalRoot, candidate).split(sep).filter(Boolean)) {
    traversed = join(traversed, segment)
    if (lstatSync(traversed).isSymbolicLink()) {
      throw new Error(`Retrieved evidence path traverses a symbolic link: ${path}`)
    }
  }
  const realCandidate = realpathSync(candidate)
  if (!realCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Retrieved evidence path resolves outside graph_root: ${path}`)
  }
  const repositoryRelative = normalizePath(relative(normalizedRoot, realCandidate))
  if (
    repositoryRelative.length === 0
    || repositoryRelative === '.'
    || repositoryRelative.split('/').includes('..')
  ) {
    throw new Error(`Retrieved evidence path is not a safe repository-relative file: ${path}`)
  }
  return repositoryRelative
}

function parseMcpToolPayload(response) {
  const content = response.result?.content
  if (!Array.isArray(content)) throw new Error('MCP tool response has no content array')
  const text = content.find((entry) => entry?.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('MCP tool response has no text content')
  return JSON.parse(text)
}

async function measureOneCallRetrieval(cliPath, repositoryPath, contract, unknowns, packedArtifactSha256) {
  const question = contract.questions.find((entry) => entry.id === 'openstatus-574-strict-one-call')
  const repository = contract.repositories.find((entry) => entry.id === question.repository_id)
  const reproductionCommand = command(
    'node',
    'tools/eval/core-reset/record-baseline.mjs',
    '--retrieval-repository',
    '<openstatus-checkout>',
  )
  if (!repositoryPath) {
    unknowns.push({
      field: 'one_call_retrieval',
      reason: 'The optional local OpenStatus checkout was not supplied. The recorder does not clone external repositories from the network.',
      reproduction_command: reproductionCommand,
    })
    return {
      status: 'unknown',
      question_id: question.id,
      command: reproductionCommand,
      focused_verification_reads: 0,
      reason: 'Run with --retrieval-repository pointing at a local checkout that contains the pinned commit.',
    }
  }

  const sourceRepository = resolve(repositoryPath)
  run(gitCommand, ['cat-file', '-e', `${repository.commit}^{commit}`], { cwd: sourceRepository })
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'madar-core-reset-retrieval-'))
  const graphRoot = join(temporaryRoot, 'openstatus')
  try {
    run(gitCommand, [
      '-c', 'core.autocrlf=false',
      '-c', 'core.eol=lf',
      'clone', '--shared', '--no-checkout', sourceRepository, graphRoot,
    ])
    run(gitCommand, [
      '-c', 'core.autocrlf=false',
      '-c', 'core.eol=lf',
      'checkout', '--detach', repository.commit,
    ], { cwd: graphRoot })
    const sourceCommit = run(gitCommand, ['rev-parse', 'HEAD'], { cwd: graphRoot }).stdout.trim()
    const sourceStatus = run(gitCommand, ['status', '--porcelain'], { cwd: graphRoot }).stdout.trim()
    if (sourceCommit !== repository.commit || sourceStatus) {
      throw new Error('Could not prepare a clean checkout of the pinned retrieval repository')
    }
    const treePaths = run(gitCommand, [
      'ls-tree',
      '-r',
      '-t',
      '--full-tree',
      '--name-only',
      repository.commit,
    ], { cwd: graphRoot }).stdout
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .sort()
    const treePathsSha256 = sha256(`${treePaths.join('\n')}\n`)
    if (treePathsSha256 !== repository.tree_paths_sha256) {
      throw new Error(`Retrieval source tree path hash ${treePathsSha256} does not match frozen ${repository.tree_paths_sha256}`)
    }
    const graphBuild = runGenerate(cliPath, graphRoot, false, temporaryRoot)
    const resolvedGraphPath = graphBuild.graphPath
    const graph = readJson(resolvedGraphPath)
    const freshness = graph.graph_build_freshness?.git
    if (freshness?.head_sha !== repository.commit || !Array.isArray(freshness?.dirty_files)) {
      throw new Error('Retrieval graph is missing pinned git freshness evidence')
    }
    if (freshness.dirty_files.length > 0) {
      throw new Error(`Retrieval graph was generated from a dirty source tree: ${freshness.dirty_files.join(', ')}`)
    }
    const indexing = readJson(graphBuild.manifestPath)
    const callStarted = performance.now()
    let mcpInitializeMs = 0
    const response = await runMcpSession(cliPath, resolvedGraphPath, async ({ request, initializeMs }) => {
      mcpInitializeMs = initializeMs
      return request('tools/call', {
        name: 'retrieve',
        arguments: { question: question.prompt, budget: 20_000 },
      }, contract.trial_design.timeout_seconds * 1_000)
    }, { initializeTimeoutMs: contract.trial_design.timeout_seconds * 1_000 })
    const elapsedMs = performance.now() - callStarted
    const payload = parseMcpToolPayload(response)
    const matchedNodes = Array.isArray(payload.matched_nodes) ? payload.matched_nodes : []
    const files = [...new Set(matchedNodes
    .map((node) => node?.source_file)
    .filter((path) => typeof path === 'string')
    .map((path) => normalizedEvidenceFile(path, graphRoot)))]
    .sort()
    const verificationTargetFiles = [...new Set((payload.evidence?.answerability?.verification_targets ?? [])
      .flatMap((target) => Array.isArray(target?.focus_files) ? target.focus_files : [])
      .filter((path) => typeof path === 'string')
      .map((path) => normalizedEvidenceFile(path, graphRoot)))]
      .sort()
    const returnedFiles = [...new Set([...files, ...verificationTargetFiles])].sort()
    const snippets = matchedNodes
      .filter((node) => typeof node?.snippet === 'string' && node.snippet.trim().length > 0)
      .map((node) => ({
        label: String(node.label ?? ''),
        source_file: normalizedEvidenceFile(String(node.source_file ?? ''), graphRoot),
        line_number: typeof node.line_number === 'number' ? node.line_number : null,
        preview: node.snippet.slice(0, 240),
        sha256: sha256(node.snippet),
      }))
    const snippetFiles = [...new Set(snippets.map((snippet) => snippet.source_file))].sort()
    const frozenExpectedPaths = new Set(question.required_phases.flatMap((phase) => phase.expected_evidence_paths))
    const globallyReachableFocusedReads = new Set(
      verificationTargetFiles
        .filter((path) => frozenExpectedPaths.has(path))
        .slice(0, contract.measurements.machine_gates.focused_reads_max),
    )
    const phaseCoverage = question.required_phases.map((phase) => {
      const matchedPaths = phase.expected_evidence_paths.filter((pattern) => snippetFiles.some((path) => pathMatches(pattern, path)))
      const targetPaths = phase.expected_evidence_paths.filter((pattern) =>
        verificationTargetFiles.some((path) => pathMatches(pattern, path))
        && !snippetFiles.some((path) => pathMatches(pattern, path)))
      const reachableTargetPaths = targetPaths.filter((path) => globallyReachableFocusedReads.has(path))
      return {
        phase: phase.id,
        scope: phase.scope,
        matched_paths: matchedPaths,
        verification_target_paths: targetPaths,
        covered: matchedPaths.length >= phase.minimum_path_matches,
        reachable_after_focused_reads:
          new Set([...matchedPaths, ...reachableTargetPaths]).size >= phase.minimum_path_matches,
      }
    })
    unknowns.push({
      field: 'one_call_retrieval.provider_total_input_tokens',
      reason: 'A direct MCP probe measures the serialized Madar response but has no provider session from which to read total input usage.',
      reproduction_command: command('<agent>', '<frozen-comparator-protocol>', question.id),
    })
    const serializedResponse = JSON.stringify(payload)
    return {
      status: 'measured',
      question_id: question.id,
      command: reproductionCommand,
      repository: repository.url,
      repository_commit: sourceCommit,
      generator_artifact_sha256: packedArtifactSha256,
      graph_sha256: sha256(readFileSync(resolvedGraphPath)),
      graph_build_elapsed_ms: roundMilliseconds(graphBuild.elapsedMs),
      graph_artifact_bytes: readFileSync(resolvedGraphPath).byteLength,
      source_tree_paths_sha256: treePathsSha256,
      graph_freshness: {
        head_sha: freshness.head_sha,
        dirty_file_count: freshness.dirty_files.length,
      },
      graph_requested_extraction_mode: indexing?.requested_extraction_mode ?? 'unknown',
      graph_nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
      graph_edges: Array.isArray(graph.edges) ? graph.edges.length : Array.isArray(graph.links) ? graph.links.length : 0,
      mcp_initialize_ms: roundMilliseconds(mcpInitializeMs),
      elapsed_ms: roundMilliseconds(elapsedMs),
      reported_context_token_count: typeof payload.token_count === 'number' ? payload.token_count : null,
      serialized_response_bytes: Buffer.byteLength(serializedResponse),
      provider_total_input_tokens: null,
      matched_file_count: files.length,
      matched_files: files,
      snippet_file_count: snippetFiles.length,
      snippet_files: snippetFiles,
      verification_target_file_count: verificationTargetFiles.length,
      verification_target_files: verificationTargetFiles,
      returned_file_count: returnedFiles.length,
      returned_files: returnedFiles,
      snippet_count: snippets.length,
      snippets,
      phase_coverage: phaseCoverage,
      in_scope_phase_coverage:
        phaseCoverage.filter((phase) => phase.scope === 'required' && phase.covered).length
        / Math.max(1, phaseCoverage.filter((phase) => phase.scope === 'required').length),
      answerability: payload.evidence?.answerability?.state ?? null,
      coverage: payload.evidence?.coverage ?? null,
      pack_confidence: payload.evidence?.pack_confidence ?? null,
      focused_verification_reads: 0,
      focused_reads_note: 'Direct MCP characterization stops after exactly one retrieve call; reachability reserves the contract-bounded sorted frozen-path verification targets globally, while actual agent reads are measured only in comparator trials.',
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function writeReceipt(path, receipt) {
  if (!path) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    return
  }
  const resolved = resolve(path)
  mkdirSync(dirname(resolved), { recursive: true })
  const temporary = `${resolved}.tmp`
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  renameSync(temporary, resolved)
  process.stdout.write(`Core Reset baseline receipt written to ${relative(repositoryRoot, resolved) || resolved}\n`)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const contract = readJson(contractPath)
  validateJson(contractSchemaPath, contract, 'evaluation contract')
  validateContractSemantics(contract)
  const baseline = contract.baseline.madar
  const packageJson = readJson(join(repositoryRoot, 'package.json'))
  if (packageJson.name !== baseline.name || packageJson.version !== baseline.version) {
    throw new Error(`Expected ${baseline.name}@${baseline.version}; found ${packageJson.name}@${packageJson.version}`)
  }
  const checkoutCommit = run(gitCommand, ['rev-parse', 'HEAD']).stdout.trim()
  const worktreeDirty = run(gitCommand, ['status', '--porcelain']).stdout.trim().length > 0
  if (worktreeDirty && !options.allowDirty) {
    throw new Error('Accepted baseline receipts require a clean worktree. Commit or stash changes, or use --allow-dirty for a non-accepted diagnostic receipt.')
  }
  const inventory = sourceInventory()
  const sourceDelta = productionSourceDelta(baseline.commit)
  const sourceTreeMatchesBaseline =
    inventory.files === contract.measurements.baseline_targets.production_source.expected_files
    && inventory.loc === contract.measurements.baseline_targets.production_source.expected_loc
    && inventory.filesystemViolations.length === 0
    && sourceDelta.added === 0
    && sourceDelta.removed === 0
  const unknowns = []
  const npmVersion = run(npmCommand, ['--version']).stdout.trim()
  const gitVersion = run(gitCommand, ['--version']).stdout.trim()
  const baselineTargets = contract.measurements.baseline_targets
  const packedArtifact = createPackedArtifact(baselineTargets.package)
  try {
    const packageMeasurement = packedArtifact.measurement
    const cliStartup = measureCliStartup(packedArtifact.cliPath, baselineTargets.cli_startup)
    const mcpStartup = await measureMcpStartup(packedArtifact.cliPath, baselineTargets.mcp_startup)
    const graphContract = await characterizeGraphContract(packedArtifact.packageRoot)
    const defaultExtraction = await characterizeDefaultExtraction(
      packedArtifact.cliPath,
      baselineTargets.default_extraction,
      packedArtifact.packageRoot,
    )
    const incrementalEquivalence = characterizeIncrementalEquivalence(packedArtifact.cliPath)
    const oneCallRetrieval = await measureOneCallRetrieval(
      packedArtifact.cliPath,
      options.retrievalRepository,
      contract,
      unknowns,
      packedArtifact.measurement.artifact_sha256,
    )
    const importViolations = productionImportViolations(inventory.paths)
    const evaluationLeaks = productionEvaluationLeaks(inventory.paths, contract)

    const receipt = {
    schema_version: 1,
    receipt_id: 'madar-v0.32.0-core-reset-baseline',
    generated_at: new Date().toISOString(),
    share_safe: true,
    contract_id: contract.contract_id,
    contract_sha256: sha256(JSON.stringify(contract)),
    baseline_target: {
      package: baseline.name,
      version: baseline.version,
      commit: baseline.commit,
      checkout_commit: checkoutCommit,
      source_tree_matches_baseline: sourceTreeMatchesBaseline,
      worktree_dirty: worktreeDirty,
      commands: [
        command('npm', 'ci'),
        command('npm', 'run', 'build'),
        command(
          'node', 'tools/eval/core-reset/record-baseline.mjs', '--output', './baseline.local.json',
          ...(options.retrievalRepository ? ['--retrieval-repository', '<openstatus-checkout>'] : []),
        ),
        command('npx', 'vitest', 'run', 'tests/unit/core-reset-baseline.test.ts'),
      ],
    },
    environment: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.version,
      npm: npmVersion,
      git: gitVersion,
      cpu_count: Math.max(1, cpus().length),
      controlled_environment: {
        policy: 'core-reset-controlled-v1',
        locale: 'C',
        timezone: 'UTC',
        npm_registry: 'https://registry.npmjs.org/',
        node_options: 'cleared',
        node_path: 'cleared',
        madar_variables: 'cleared_except_explicit_probe_flags',
        git_configuration: 'system_and_global_disabled; checkout_core.autocrlf=false; checkout_core.eol=lf',
      },
    },
    production_source: {
      files: inventory.files,
      loc: inventory.loc,
      expected_files: baselineTargets.production_source.expected_files,
      expected_loc: baselineTargets.production_source.expected_loc,
      matches_expected:
        inventory.files === baselineTargets.production_source.expected_files
        && inventory.loc === baselineTargets.production_source.expected_loc
        && sourceDelta.added === 0
        && sourceDelta.removed === 0,
      filesystem_violations: inventory.filesystemViolations,
      production_loc_delta: sourceDelta,
    },
    package: packageMeasurement,
    cli_startup: cliStartup,
    mcp_startup: mcpStartup,
    graph_contract: graphContract,
    default_extraction: defaultExtraction,
    incremental_equivalence: incrementalEquivalence,
    one_call_retrieval: oneCallRetrieval,
    isolation: {
      build_root: 'src',
      build_output: 'dist/src',
      production_import_violations: importViolations,
      production_evaluation_leaks: evaluationLeaks,
      package_forbidden_paths: packageMeasurement.forbidden_paths,
      package_forbidden_metadata: packageMeasurement.forbidden_metadata,
    },
    unknowns,
    }
    validateJson(receiptSchemaPath, receipt, 'baseline receipt')
    validateReceiptSemantics(receipt, contract, {
      requireClean: !options.allowDirty,
      requireSourceMatch: !options.allowDirty,
      requireMeasuredRetrieval: !options.allowDirty,
    })
    writeReceipt(options.output, receipt)
  } finally {
    packedArtifact.cleanup()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
