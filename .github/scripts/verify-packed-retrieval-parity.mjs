import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parse } from 'yaml'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..', '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function requiredNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    throw new Error(`${label} must be a finite number`)
  }
  return number
}

function parsePackRecord(output) {
  const trimmed = output.trim()
  const bracketed = trimmed.slice(trimmed.indexOf('['), trimmed.lastIndexOf(']') + 1)
  for (const candidate of [trimmed, bracketed]) {
    if (candidate.length === 0) continue
    try {
      const parsed = JSON.parse(candidate)
      const records = Array.isArray(parsed)
        ? parsed
        : parsed?.filename
          ? [parsed]
          : Object.values(parsed ?? {})
      if (records.length === 1 && records[0]?.filename) {
        return records[0]
      }
    } catch {
      // npm releases can include lifecycle output before the JSON record.
    }
  }
  throw new Error(`npm pack did not return one parseable JSON record:\n${output}`)
}

function assertPackageMeasurement(record, tarballPath) {
  const manifest = parse(readFileSync(
    join(repositoryRoot, 'docs', 'core-reset', 'removal-manifest.yml'),
    'utf8',
  ))
  const evaluationTooling = manifest.items?.find((item) => item.id === 'evaluation-tooling')
  const activePhase = manifest.items?.find((item) => item.id === manifest.current?.active_phase)
  const budget = activePhase?.npm_package_budget ?? evaluationTooling?.npm_package_budget
  const receipt = activePhase?.terminal_language_corrective?.package_candidate
    ?? activePhase?.corrective_release?.package_candidate
    ?? activePhase?.corrective?.package_candidate
    ?? manifest.current
  const actual = {
    npm_files: requiredNumber(record.entryCount, 'npm pack entryCount'),
    npm_packed_bytes: requiredNumber(record.size, 'npm pack size'),
    npm_unpacked_bytes: requiredNumber(record.unpackedSize, 'npm pack unpackedSize'),
  }
  for (const [field, value] of Object.entries(actual)) {
    if (requiredNumber(receipt?.[field], `active package receipt ${field}`) !== value) {
      throw new Error(
        `Active package receipt is stale: ${field}=${receipt?.[field]}, freshly packed artifact=${value}`,
      )
    }
  }
  if (
    receipt?.npm_shasum !== record.shasum
    || receipt?.npm_integrity !== record.integrity
  ) {
    throw new Error(
      'Active package artifact identity is stale for the freshly packed artifact',
    )
  }
  const artifactSha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex')
  if (receipt?.npm_artifact_sha256 !== artifactSha256) {
    throw new Error(
      'Active package SHA-256 is stale for the freshly packed artifact',
    )
  }
  if (
    actual.npm_files > requiredNumber(budget?.files_max, 'active files_max')
    || actual.npm_packed_bytes
      > requiredNumber(budget?.packed_bytes_max, 'active packed_bytes_max')
    || actual.npm_unpacked_bytes
      > requiredNumber(budget?.unpacked_bytes_max, 'active unpacked_bytes_max')
  ) {
    throw new Error(
      `Fresh npm package exceeds the active package budget: ${JSON.stringify(actual)}`,
    )
  }
  return actual
}

function registryLaunch(packageName, packageVersion) {
  const registryManifest = JSON.parse(readFileSync(
    join(repositoryRoot, 'docs', 'mcp-registry', 'server.json'),
    'utf8',
  ))
  const packages = registryManifest.packages
  if (!Array.isArray(packages) || packages.length !== 1) {
    throw new Error('MCP Registry manifest must contain exactly one package')
  }
  const [registryPackage] = packages
  if (
    registryManifest.version !== packageVersion
    || registryPackage.registryType !== 'npm'
    || registryPackage.registryBaseUrl !== 'https://registry.npmjs.org'
    || registryPackage.identifier !== packageName
    || registryPackage.version !== packageVersion
    || registryPackage.runtimeHint !== 'npx'
    || registryPackage.transport?.type !== 'stdio'
  ) {
    throw new Error('MCP Registry package does not match the freshly installed npm package')
  }
  const args = (registryPackage.packageArguments ?? []).map((argument) => {
    if (argument?.type !== 'positional' || typeof argument.value !== 'string') {
      throw new Error('Packed parity requires concrete positional MCP Registry arguments')
    }
    return argument.value
  })
  if (args.length === 0) {
    throw new Error('MCP Registry launch has no package arguments')
  }
  return args
}

function retrieveThroughInstalledBin(installedBinPath, registryArgs, cwd, request) {
  const initializeId = request.id - 2
  const toolsListId = request.id - 1
  const input = [
    { jsonrpc: '2.0', id: initializeId, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: toolsListId, method: 'tools/list', params: {} },
    request,
  ].map((payload) => JSON.stringify(payload)).join('\n') + '\n'
  let output
  try {
    output = execFileSync(installedBinPath, registryArgs, {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 35_000,
      maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === 'win32',
    })
  } catch (error) {
    const stdout = error?.stdout?.toString?.('utf8') ?? ''
    const stderr = error?.stderr?.toString?.('utf8') ?? ''
    throw new Error(`Installed Registry launch failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  const responses = output.trim().split(/\r?\n/).map((line) => JSON.parse(line))
  const initialize = responses.find((response) => response.id === initializeId)
  if (typeof initialize?.result?.protocolVersion !== 'string') {
    throw new Error('Installed Registry launch did not complete initialize')
  }
  const toolsList = responses.find((response) => response.id === toolsListId)
  const tools = toolsList?.result?.tools?.map((tool) => tool.name)
  if (JSON.stringify(tools) !== JSON.stringify(['retrieve'])) {
    throw new Error(`Installed Registry launch advertised unexpected tools: ${JSON.stringify(tools)}`)
  }
  const response = responses.find((candidate) => candidate.id === request.id)
  if (!response) {
    throw new Error('Installed Registry launch did not complete tools/call')
  }
  return response
}

async function createParityGraph(root, updateIndexInWorker) {
  const sourceRoot = join(root, 'workspace')
  const files = {
    route: join(sourceRoot, 'route.ts'),
    analytics: join(sourceRoot, 'analytics.ts'),
    redirect: join(sourceRoot, 'redirect.ts'),
  }
  mkdirSync(sourceRoot, { recursive: true })
  writeFileSync(files.route, [
    "import { trackClick } from './analytics.js'",
    "import { redirectToDestination } from './redirect.js'",
    'export function handleClick() { trackClick(); redirectToDestination() }',
    '',
  ].join('\n'))
  writeFileSync(files.analytics, 'export function trackClick() {}\n')
  writeFileSync(files.redirect, 'export function redirectToDestination() {}\n')
  const result = await updateIndexInWorker(sourceRoot)
  if (result.updateReceipt?.mode !== 'cold_reconcile' || !existsSync(result.graphPath)) {
    throw new Error('Packed parity fixture did not publish a canonical graph')
  }
  return { graphPath: result.graphPath, sourceRoot }
}

async function retrieveThroughMcp(server, cwd, version, request) {
  const input = new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let responseText = ''
  output.on('data', (chunk) => { responseText += chunk.toString('utf8') })
  const serving = server.serveMcpServer({
    version,
    cwd,
    requestWaitMs: 25_000,
    input,
    output,
    errorOutput,
  })
  for (const payload of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    request,
  ]) input.write(`${JSON.stringify(payload)}\n`)
  input.end()
  await serving
  return responseText.trim().split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .find((response) => response.id === request.id)
}

function normalizedResponse(response) {
  return JSON.parse(JSON.stringify(response, (key, value) =>
    key === 'checked_at' || key === 'generated_at' ? undefined : value))
}

function successfulRetrieve(response, label, expectedLabels) {
  if (response?.error) {
    throw new Error(`${label} returned an MCP error: ${JSON.stringify(response.error)}`)
  }
  const text = response?.result?.content?.[0]?.text
  if (typeof text !== 'string') {
    throw new Error(`${label} did not return text evidence`)
  }
  let result
  try {
    result = JSON.parse(text)
  } catch {
    throw new Error(`${label} did not return canonical JSON evidence`)
  }
  if (
    result?.schema !== 'madar.retrieve'
    || result?.version !== 2
    || result?.state !== 'ready'
    || !result?.dossier?.evidence
  ) {
    throw new Error(`${label} did not complete a ready v2 dossier retrieval`)
  }
  const labels = new Set(result.dossier.evidence.entities
    .filter((entity) => entity.kind === 'symbol')
    .map((entity) => String(entity.label ?? '')
      .replaceAll(/[^a-z0-9]/gi, '').toLowerCase()))
  for (const expected of expectedLabels) {
    if (!labels.has(expected.toLowerCase())) {
      throw new Error(
        `${label} omitted expected declaration ${expected}; returned ${[...labels].join(', ')}`,
      )
    }
  }
  return result
}

const tempRoot = join(tmpdir(), `madar-packed-parity-${randomUUID()}`)
const packRoot = join(tempRoot, 'pack')
const consumerRoot = join(tempRoot, 'consumer')
try {
  mkdirSync(packRoot, { recursive: true })
  mkdirSync(consumerRoot, { recursive: true })
  const packOutput = execFileSync(npmCommand, [
    'pack',
    '--json',
    '--silent',
    '--pack-destination',
    packRoot,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const packRecord = parsePackRecord(packOutput)
  const tarballPath = join(packRoot, packRecord.filename)
  if (!existsSync(tarballPath)) throw new Error('npm pack did not produce a tarball')

  const checkoutManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'madar-packed-parity-consumer',
    private: true,
    version: '0.0.0',
  }, null, 2))
  execFileSync(npmCommand, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarballPath,
  ], {
    cwd: consumerRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const packedRoot = join(consumerRoot, 'node_modules', ...checkoutManifest.name.split('/'))
  if (!existsSync(packedRoot) || lstatSync(packedRoot).isSymbolicLink()) {
    throw new Error('npm did not create a real packed consumer installation')
  }
  if (existsSync(join(packedRoot, 'docs'))) {
    throw new Error('Packed artifact unexpectedly contains checkout-only docs')
  }
  const installedBinPath = join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'madar.cmd' : 'madar',
  )
  if (!existsSync(installedBinPath)) {
    throw new Error(`Packed consumer install did not link the madar bin: ${installedBinPath}`)
  }
  const packedCliModulePath = join(packedRoot, 'dist', 'src', 'adapters', 'cli', 'bin.js')
  const packedCliModule = readFileSync(packedCliModulePath, 'utf8')
  if (!packedCliModule.startsWith('#!/usr/bin/env node\n')) {
    throw new Error('Owner-approved comment removal must preserve the packed CLI shebang')
  }
  const commentSentinel = 'Publish one text artifact with same-filesystem rename semantics'
  if (!readFileSync(join(repositoryRoot, 'src', 'shared', 'atomic-file.ts'), 'utf8')
    .includes(commentSentinel)) {
    throw new Error('The #622 emitted-comment sentinel must remain in production source')
  }
  for (const extension of ['js', 'd.ts']) {
    const emitted = readFileSync(
      join(packedRoot, 'dist', 'src', 'shared', `atomic-file.${extension}`),
      'utf8',
    )
    if (emitted.includes(commentSentinel)) {
      throw new Error(`The packed atomic-file.${extension} retained the #622 comment sentinel`)
    }
  }

  const checkoutServerPath = join(repositoryRoot, 'dist', 'src', 'adapters', 'mcp', 'server.js')
  const packedServerPath = join(packedRoot, 'dist', 'src', 'adapters', 'mcp', 'server.js')
  const packedWatcherPath = join(packedRoot, 'dist', 'src', 'infrastructure', 'watch-index.js')
  const packedStorePath = join(packedRoot, 'dist', 'src', 'adapters', 'filesystem', 'index-store.js')
  const packedUpdatePath = join(packedRoot, 'dist', 'src', 'application', 'update-index.js')
  const packedArtifactPath = join(packedRoot, 'dist', 'src', 'adapters', 'filesystem', 'graph-artifact.js')
  const packedApplicationPath = join(packedRoot, 'dist', 'src', 'application', 'retrieve-context.js')
  const packedIndexPath = join(packedRoot, 'dist', 'src', 'domain', 'query', 'index-status.js')
  for (const path of [
    checkoutServerPath, packedServerPath, packedWatcherPath,
    packedStorePath, packedUpdatePath, packedArtifactPath,
    packedApplicationPath, packedIndexPath,
  ]) {
    if (!existsSync(path)) throw new Error(`Missing parity runtime module: ${path}`)
  }

  const [
    checkoutServer, packedServer, packedWatcher, packedStore,
    packedArtifact, packedApplication, packedIndex,
  ] = await Promise.all([
    import(`${pathToFileURL(checkoutServerPath).href}?parity=checkout`),
    import(`${pathToFileURL(packedServerPath).href}?parity=packed`),
    import(`${pathToFileURL(packedWatcherPath).href}?parity=packed`),
    import(`${pathToFileURL(packedStorePath).href}?parity=packed`),
    import(`${pathToFileURL(packedArtifactPath).href}?parity=packed`),
    import(`${pathToFileURL(packedApplicationPath).href}?parity=packed`),
    import(`${pathToFileURL(packedIndexPath).href}?parity=packed`),
  ])
  const checkoutVersion = checkoutManifest.version
  const packedVersion = JSON.parse(readFileSync(join(packedRoot, 'package.json'), 'utf8')).version
  if (checkoutVersion !== packedVersion) {
    throw new Error(`Package version mismatch: checkout=${checkoutVersion} packed=${packedVersion}`)
  }
  const registryArgs = registryLaunch(checkoutManifest.name, packedVersion)

  const { graphPath, sourceRoot } = await createParityGraph(
    tempRoot,
    packedWatcher.updateIndexInWorker,
  )
  const prompt = 'Where is handleClick defined?'
  const request = {
    jsonrpc: '2.0',
    id: 551,
    method: 'tools/call',
    params: {
      name: 'retrieve',
      arguments: {
        question: prompt,
        budget: 1200,
      },
    },
  }
  const checkoutResponse = await retrieveThroughMcp(
    checkoutServer, sourceRoot, checkoutVersion, request,
  )
  const packedResponse = retrieveThroughInstalledBin(
    installedBinPath, registryArgs, sourceRoot, request,
  )
  const directText = packedApplication.serializeRetrieveContextResult(
    packedApplication.retrieveContext(
      packedIndex.inspectQueryIndex(packedArtifact.loadGraphArtifact(graphPath)),
      request.params.arguments,
    ),
  )
  const cliText = execFileSync(
    installedBinPath,
    ['query', request.params.arguments.question, '--graph', graphPath,
      '--budget', String(request.params.arguments.budget)],
    {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    },
  )
  const expectedDeclarations = ['handleclick']
  successfulRetrieve(
    checkoutResponse,
    'Checkout runtime',
    expectedDeclarations,
  )
  const checkoutText = checkoutResponse?.result?.content?.[0]?.text
  const packedText = packedResponse?.result?.content?.[0]?.text
  if (checkoutText !== directText || packedText !== directText || cliText !== directText) {
    throw new Error('Checkout MCP, packed MCP, CLI query, and direct application bytes differ')
  }
  successfulRetrieve(
    packedResponse,
    'Packed runtime',
    expectedDeclarations,
  )
  const normalizedCheckout = normalizedResponse(checkoutResponse)
  const normalizedPacked = normalizedResponse(packedResponse)
  if (JSON.stringify(normalizedCheckout) !== JSON.stringify(normalizedPacked)) {
    writeFileSync(join(tempRoot, 'checkout-response.json'), JSON.stringify(normalizedCheckout, null, 2))
    writeFileSync(join(tempRoot, 'packed-response.json'), JSON.stringify(normalizedPacked, null, 2))
    throw new Error(`Packed retrieval differs from checkout retrieval; inspect ${tempRoot}`)
  }

  const flowRoot = join(tempRoot, 'report-flow-workspace')
  cpSync(
    join(
      repositoryRoot,
      'tests',
      'fixtures',
      'pack-quality',
      'runtime-generation-explain-report-flow',
      'workspace',
    ),
    flowRoot,
    { recursive: true },
  )
  const flowGraph = await packedWatcher.updateIndexInWorker(flowRoot)
  const flowRequest = {
    jsonrpc: '2.0',
    id: 561,
    method: 'tools/call',
    params: {
      name: 'retrieve',
      arguments: {
        question: 'How is an idea report generated? Explain the pipeline flow from request to final report.',
        budget: 4_000,
      },
    },
  }
  const checkoutFlow = await retrieveThroughMcp(
    checkoutServer, flowRoot, checkoutVersion, flowRequest,
  )
  const packedFlow = retrieveThroughInstalledBin(
    installedBinPath, registryArgs, flowRoot, flowRequest,
  )
  const directFlowText = packedApplication.serializeRetrieveContextResult(
    packedApplication.retrieveContext(
      packedIndex.inspectQueryIndex(packedArtifact.loadGraphArtifact(flowGraph.graphPath)),
      flowRequest.params.arguments,
    ),
  )
  const cliFlowText = execFileSync(
    installedBinPath,
    ['query', flowRequest.params.arguments.question, '--graph', flowGraph.graphPath,
      '--budget', String(flowRequest.params.arguments.budget)],
    {
      cwd: flowRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    },
  )
  const checkoutFlowText = checkoutFlow?.result?.content?.[0]?.text
  const packedFlowText = packedFlow?.result?.content?.[0]?.text
  if (
    checkoutFlowText !== directFlowText
    || packedFlowText !== directFlowText
    || cliFlowText !== directFlowText
  ) {
    throw new Error('Packed full-flow MCP, CLI, direct, and checkout bytes differ')
  }
  const flowResult = successfulRetrieve(packedFlow, 'Packed full-flow runtime', [
    'generatefromproblem',
    'startpipeline',
    'plan',
    'researchsection',
    'assemblereport',
    'savestructuredreport',
  ])
  const expectedFlowFiles = [
    'src/modules/ideas/interface/http/idea-generation.controller.ts',
    'src/modules/pipeline/api/pipeline-trigger.service.ts',
    'src/modules/pipeline/workers/orchestrator.worker.ts',
    'src/modules/planning/planner.service.ts',
    'src/modules/research/workers/section-research.worker.ts',
    'src/modules/research/research-agent.service.ts',
    'src/modules/pipeline/assembly/assembly.worker.ts',
    'src/modules/reports/assembly.service.ts',
    'src/modules/pipeline/workers/db-sync.worker.ts',
  ]
  const actualFlowFiles = flowResult.dossier.evidence.files.map(({ path }) => path).sort()
  const channelLinks = flowResult.dossier.flow.links.filter(({ kind }) => kind === 'channel')
  const flowProofs = new Map(flowResult.dossier.evidence.proofs.map((proof) => [proof.id, proof]))
  const obligationKinds = flowResult.dossier.obligations.map(({ kind }) => kind)
  const hasPersistenceProof = flowResult.dossier.evidence.entities.some((entity) =>
    entity.kind === 'operation' && entity.operation_kind === 'persistence')
  if (
    JSON.stringify(actualFlowFiles) !== JSON.stringify(expectedFlowFiles.sort())
    || JSON.stringify(obligationKinds) !== JSON.stringify([
      'subject', 'entry', 'stage', 'handoff', 'behavior', 'ordering', 'terminal',
    ])
    || flowResult.dossier.obligations.some(({ proofs }) => proofs.length === 0)
    || channelLinks.length !== 4
    || channelLinks.some(({ proofs }) => {
      const relations = proofs.map((proof) => flowProofs.get(proof)?.relation)
      const publishAt = relations.indexOf('publishes_to')
      return publishAt < 0
        || !relations.slice(0, publishAt).every((relation) => relation === 'calls')
        || ![
          JSON.stringify(['publishes_to', 'consumed_by']),
          JSON.stringify(['publishes_to', 'routes_through', 'consumed_by']),
        ].includes(JSON.stringify(relations.slice(publishAt)))
    })
    || flowResult.dossier.flow.terminals.length === 0
    || !hasPersistenceProof
    || flowResult.metrics?.selected_files > 12
    || flowResult.metrics?.authenticated_excerpts > 25
    || flowResult.metrics?.root_candidates > 3
    || flowResult.metrics?.initial_candidates > 32
    || flowResult.metrics?.explored_nodes > 512
    || flowResult.metrics?.causal_hops > 24
    || flowResult.metrics?.recovery_passes > 2
    || flowResult.metrics?.recovery_frontier_nodes > 64
    || flowResult.metrics?.alternate_seeds > 3
    || flowResult.metrics?.serialized_tokens > 4_000
  ) {
    throw new Error(`Packed full-flow dossier violated #630: ${JSON.stringify(flowResult)}`)
  }

  const workerRoot = join(tempRoot, 'worker-workspace')
  mkdirSync(workerRoot, { recursive: true })
  writeFileSync(join(workerRoot, 'main.ts'), 'export const workerValue = 1\n')
  const workerResult = await packedWatcher.updateIndexInWorker(workerRoot)
  if (workerResult.updateReceipt?.mode !== 'cold_reconcile' || !existsSync(workerResult.graphPath)) {
    throw new Error('Packed MCP index worker did not publish a canonical graph')
  }

  writeFileSync(join(workerRoot, 'main.ts'), 'export const workerValue = 2\n')
  const beforeContention = readFileSync(workerResult.graphPath, 'utf8')
  const releaseCompetingLease = packedStore.acquireIndexLease(join(workerRoot, 'out'))
  const childScript = `import { updateIndex } from ${JSON.stringify(pathToFileURL(packedUpdatePath).href)}; try { const result = updateIndex(${JSON.stringify(workerRoot)}); console.log(JSON.stringify({ mode: result.updateReceipt?.mode, buildId: result.buildId })) } catch (error) { console.log(JSON.stringify({ error: error?.name })) }`
  const runChild = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', childScript], { encoding: 'utf8' }).trim())
  const contended = runChild()
  if (contended.error !== 'IndexLeaseContentionError' || readFileSync(workerResult.graphPath, 'utf8') !== beforeContention) {
    throw new Error('Packed cross-process lease did not preserve the accepted graph under contention')
  }
  releaseCompetingLease()
  const reconciled = runChild()
  if (reconciled.mode !== 'cold_reconcile' || typeof reconciled.buildId !== 'string') {
    throw new Error('Packed cross-process lease did not permit one coherent successor')
  }

  const responsiveRoot = join(tempRoot, 'responsive-workspace')
  mkdirSync(responsiveRoot, { recursive: true })
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(join(responsiveRoot, `file-${index}.ts`), `export const value${index} = ${index}\n`)
  }
  const responsiveGraph = await packedWatcher.updateIndexInWorker(responsiveRoot)
  writeFileSync(join(responsiveRoot, 'file-0.ts'), 'export const value0 = 999\n')
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough()
  let responseText = ''
  output.on('data', (chunk) => { responseText += chunk.toString('utf8') })
  const serverPromise = packedServer.serveMcpServer({
    version: packedVersion,
    cwd: responsiveRoot,
    requestWaitMs: 25_000,
    input,
    output,
    errorOutput,
  })
  input.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 699, method: 'initialize', params: {},
  })}\n`)
  input.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 700, method: 'tools/list', params: {},
  })}\n`)
  input.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 701,
    method: 'tools/call',
    params: {
      name: 'retrieve',
      arguments: { question: 'Where is value0 defined?' },
    },
  })}\n`)
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 702, method: 'ping' })}\n`)
  const pingDeadline = Date.now() + 5_000
  while (!responseText.includes('"id":702') && Date.now() < pingDeadline) await new Promise((done) => setTimeout(done, 10))
  if (!responseText.includes('"id":702') || responseText.includes('"id":701')) {
    throw new Error('Packed MCP stdio did not remain responsive during a worker reconcile')
  }
  input.end()
  await serverPromise
  const responses = responseText.trim().split(/\r?\n/).map((line) => JSON.parse(line))
  const retrieveResponse = responses.find((response) => response.id === 701)
  if (!retrieveResponse) {
    throw new Error('Packed MCP stdio dropped the queued retrieve request')
  }
  successfulRetrieve(retrieveResponse, 'Queued packed runtime', ['value0'])

  const crashRoot = join(tempRoot, 'crash-workspace')
  mkdirSync(crashRoot, { recursive: true })
  writeFileSync(join(crashRoot, 'main.ts'), 'export const crashValue = 1\n')
  writeFileSync(packedUpdatePath, [
    "import { join } from 'node:path'",
    "import { acquireIndexLease } from '../adapters/filesystem/index-store.js'",
    'export function updateIndex(rootPath = \'.\', options = {}) {',
    '  acquireIndexLease(join(rootPath, \'out\'), {}, options.leaseOwnerToken)',
    '  process.exit(17)',
    '}',
  ].join('\n'))
  let workerExited = false
  try { await packedWatcher.updateIndexInWorker(crashRoot) } catch { workerExited = true }
  if (!workerExited) throw new Error('Injected packed worker exit unexpectedly succeeded')
  const releaseAfterCrash = packedStore.acquireIndexLease(join(crashRoot, 'out'))
  releaseAfterCrash()

  const packageMeasurement = assertPackageMeasurement(packRecord, tarballPath)
  console.log(`Packed retrieval parity passed for @lubab/madar ${checkoutVersion}.`)
  console.log(
    `Fresh package: ${packageMeasurement.npm_files} files / `
    + `${packageMeasurement.npm_packed_bytes} packed bytes / `
    + `${packageMeasurement.npm_unpacked_bytes} unpacked bytes.`,
  )
  console.log(`Artifact runtime: ${relative(tempRoot, packedServerPath)}`)
} finally {
  if (process.env.MADAR_KEEP_PACK_PARITY_ARTIFACTS !== '1') {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}
