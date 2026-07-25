import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
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

function assertPackageMeasurement(record) {
  const manifest = parse(readFileSync(
    join(repositoryRoot, 'docs', 'core-reset', 'removal-manifest.yml'),
    'utf8',
  ))
  const thinDelivery = manifest.items?.find((item) => item.id === 'thin-delivery')
  const precedingPhase = manifest.items?.find((item) => item.id === 'evidence-path-query')
  const implementation = thinDelivery?.implementation
  const budget = thinDelivery?.npm_package_budget
  const startup = JSON.parse(readFileSync(
    join(repositoryRoot, 'docs', 'core-reset', 'evidence', 'thin-delivery-startup.json'),
    'utf8',
  ))
  const actual = {
    npm_files: requiredNumber(record.entryCount, 'npm pack entryCount'),
    npm_packed_bytes: requiredNumber(record.size, 'npm pack size'),
    npm_unpacked_bytes: requiredNumber(record.unpackedSize, 'npm pack unpackedSize'),
  }
  const recordedMeasurements = [
    ['current package receipt', manifest.current],
    ['Thin Delivery implementation receipt', implementation],
  ]
  for (const [label, receipt] of recordedMeasurements) {
    for (const [field, value] of Object.entries(actual)) {
      if (requiredNumber(receipt?.[field], `${label} ${field}`) !== value) {
        throw new Error(
          `${label} is stale: ${field}=${receipt?.[field]}, freshly packed artifact=${value}`,
        )
      }
    }
  }
  if (
    startup.package?.files !== actual.npm_files
    || startup.package?.packed_bytes !== actual.npm_packed_bytes
    || startup.package?.unpacked_bytes !== actual.npm_unpacked_bytes
    || startup.package?.shasum !== record.shasum
    || startup.package?.integrity !== record.integrity
  ) {
    throw new Error('Thin Delivery startup package receipt is stale for the freshly packed artifact')
  }

  const precedingPackedBytes = requiredNumber(
    precedingPhase?.completion?.npm_packed_bytes,
    'evidence-path-query completion npm_packed_bytes',
  )
  const packedBytesDelta = actual.npm_packed_bytes - precedingPackedBytes
  if (
    requiredNumber(
      implementation?.npm_packed_bytes_delta,
      'Thin Delivery implementation npm_packed_bytes_delta',
    ) !== packedBytesDelta
  ) {
    throw new Error(
      `Thin Delivery packed-byte delta is stale: recorded=${implementation?.npm_packed_bytes_delta}, `
      + `freshly packed delta=${packedBytesDelta}`,
    )
  }
  if (
    actual.npm_files >= requiredNumber(budget?.files_less_than, 'Thin Delivery files_less_than')
    || actual.npm_unpacked_bytes
      >= requiredNumber(budget?.unpacked_bytes_less_than, 'Thin Delivery unpacked_bytes_less_than')
    || packedBytesDelta
      > requiredNumber(budget?.packed_bytes_delta_max, 'Thin Delivery packed_bytes_delta_max')
  ) {
    throw new Error(
      `Fresh npm package exceeds Thin Delivery budgets: ${JSON.stringify({
        ...actual,
        npm_packed_bytes_delta: packedBytesDelta,
      })}`,
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
  if (result?.schema !== 'madar.retrieve' || result?.outcome !== 'evidence') {
    throw new Error(`${label} did not complete successful evidence retrieval`)
  }
  const labels = new Set((result.matched_nodes ?? []).map((node) =>
    String(node.label ?? '').replaceAll(/[^a-z0-9]/gi, '').toLowerCase()))
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
      arguments: { question: 'What is value0?' },
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

  const packageMeasurement = assertPackageMeasurement(packRecord)
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
